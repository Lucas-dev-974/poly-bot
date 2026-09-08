import {
  ApiKeyCreds,
  AssetType,
  BalanceAllowanceParams,
  ClobClient,
  OrderType,
  Side,
} from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import type { BotConfig } from "./config.js";
import { redeemViaRelayer } from "./relayer.js";
import type { OrderResult, TradeOpportunity } from "./types.js";

export class Trader {
  private client: ClobClient | null = null;

  constructor(private readonly config: BotConfig) {}

  async init(): Promise<void> {
    if (this.config.dryRun) return;
    // Readonly without a key: skip the CLOB client. BalanceTracker falls
    // back to 0 collateral + the public data-api positions.
    if (this.config.readonlyLive && !this.config.privateKey) return;
    this.client = await createTradingClient(this.config);
  }

  async getAvailableCollateral(): Promise<number | null> {
    if (this.config.dryRun || !this.client) return null;
    const params: BalanceAllowanceParams = { asset_type: AssetType.COLLATERAL };
    const response = await this.client.getBalanceAllowance(params);
    return Number(response.balance) / 1_000_000;
  }

  async placeBuy(opportunity: TradeOpportunity): Promise<OrderResult> {
    if (!this.client) {
      throw new Error("Trading client not initialized");
    }

    const response = await this.client.createAndPostOrder(
      {
        tokenID: opportunity.token.tokenId,
        price: opportunity.price,
        side: Side.BUY,
        size: opportunity.size,
      },
      {
        tickSize: opportunity.tickSize as "0.1" | "0.01" | "0.001" | "0.0001",
        negRisk: opportunity.negRisk,
      },
      OrderType.GTC,
    );

    return {
      dryRun: false,
      tokenId: opportunity.token.tokenId,
      side: "BUY",
      price: opportunity.price,
      size: opportunity.size,
      // Un ordre live GTC est placé sur le carnet mais PAS encore rempli.
      // Le statut "resting" indique au dashboard qu'il est en attente
      // d'exécution ; il passera à "rempli" quand createLivePosition()
      // émettra l'événement openedPosition.
      filled: false,
      reason: "resting",
      orderType: "GTC",
      response,
    };
  }

  /**
   * Place a FOK (Fill-or-Kill) market order for the expensive hedge leg.
   *
   * Unlike GTC limit orders that rest on the book until matched or cancelled,
   * FOK either fills entirely at the current best ask or is killed instantly.
   * This guarantees the hedge is executed immediately when the favorite is
   * priced in the expensive buy range — no stale orders to cancel later.
   *
   * The `amount` parameter is in USDC (for BUY: the dollar budget to spend).
   * The CLOB calculates how many shares that buys at the given price.
   *
   * Returns the OrderResponse with `success` indicating whether the fill
   * occurred, and `takingAmount` / `makingAmount` for the matched quantities.
   */
  async placeBuyFOK(
    opportunity: TradeOpportunity,
  ): Promise<OrderResult> {
    if (!this.client) {
      throw new Error("Trading client not initialized");
    }

    // For a BUY FOK: use the current bestAsk as the price (not the ladder
    // price). A FOK at 0.85 can't fill when the ask is 0.97 — there are no
    // sellers at 0.85. Using bestAsk ensures the FOK fills at the actual
    // market price. The bot only generates this after a cheap fill exists.
    //
    // Clamp to expensiveBuyMax: EXPENSIVE_BUY_MAX is the absolute ceiling for
    // the hedge. Without the clamp, a favorite at 0.92-0.96 was bought at the
    // ask, silently exceeding the configured max (fills recorded at 0.92-0.95
    // with EXPENSIVE_BUY_MAX=0.90). When bestAsk > max, the clamped FOK is
    // non-marketable and gets killed — a clean skip, retried next tick.
    const fokPrice = Math.min(
      opportunity.token.bestAsk ?? opportunity.price,
      this.config.expensiveBuyMax,
    );
    const usdcAmount = fokPrice * opportunity.size;
    let response;
    try {
      response = await this.client.createAndPostMarketOrder(
        {
          tokenID: opportunity.token.tokenId,
          price: fokPrice,
          amount: usdcAmount,
          side: Side.BUY,
          orderType: OrderType.FOK,
        },
        {
          tickSize: opportunity.tickSize as "0.1" | "0.01" | "0.001" | "0.0001",
          negRisk: opportunity.negRisk,
        },
        OrderType.FOK,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/couldn't be fully filled/i.test(msg)) {
        return {
          dryRun: false,
          tokenId: opportunity.token.tokenId,
          side: "BUY",
          price: opportunity.price,
          size: opportunity.size,
          filled: false,
          filledSize: 0,
          reason: "killed-fok",
          orderType: "FOK",
          response: { errorMsg: msg, success: false } as never,
        };
      }
      // Genuine error (network, auth, etc.) — re-throw for the caller's
      // generic catch block to handle retries.
      throw err;
    }

    const success = response.success ?? false;
    // takingAmount = shares received (for BUY), makingAmount = USDC spent
    const filledSize = success ? Number(response.takingAmount) || 0 : 0;
    const fillPrice = success && filledSize > 0
      ? (Number(response.makingAmount) || usdcAmount) / filledSize
      : opportunity.price;

    return {
      dryRun: false,
      tokenId: opportunity.token.tokenId,
      side: "BUY",
      price: opportunity.price,
      fillPrice,
      size: opportunity.size,
      filledSize,
      filled: success && filledSize > 0,
      reason: success && filledSize > 0 ? "filled-fok" : "killed-fok",
      orderType: "FOK",
      response,
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (this.config.dryRun || !this.client) return;
    await this.client.cancelOrder({ orderID: orderId });
  }

  async getOrderStatus(
    orderId: string,
  ): Promise<{ filled: boolean; cancelled: boolean; sizeMatched: number }> {
    if (this.config.dryRun || !this.client) {
      return { filled: false, cancelled: false, sizeMatched: 0 };
    }
    const order = await this.client.getOrder(orderId);
    const sizeMatched = Number(order.size_matched);
    const originalSize = Number(order.original_size);
    const filled = sizeMatched >= originalSize && originalSize > 0;
    const cancelled =
      order.status === "canceled" || order.status === "cancelled";
    return { filled, cancelled, sizeMatched };
  }

  /**
   * Redeems a resolved Polymarket position through the deposit wallet (V2)
   * via the Polymarket relayer. The relayer dispatches a WALLET batch that
   * calls CtfCollateralAdapter.redeemPositions (standard) or
   * NegRiskCtfCollateralAdapter.redeemPositions (neg-risk) from the deposit
   * wallet, burning the wallet's outcome tokens and crediting pUSD.
   *
   * This requires Builder credentials (BUILDER_API_KEY / BUILDER_SECRET /
   * BUILDER_PASSPHRASE) configured in the environment.
   */
  async redeemPosition(
    conditionId: string,
    outcomeIndex: number,
    negRisk: boolean,
  ): Promise<{ txHash: string; transactionId: string }> {
    if (this.config.dryRun) {
      throw new Error("Cannot redeem in dry-run mode");
    }
    if (!this.config.funderAddress) {
      throw new Error("FUNDER_ADDRESS (deposit wallet) is required for redemption");
    }

    const result = await redeemViaRelayer(
      this.config,
      conditionId,
      outcomeIndex,
      negRisk,
      this.config.funderAddress,
    );

    return { txHash: result.txHash, transactionId: result.transactionId };
  }
}

async function createTradingClient(config: BotConfig): Promise<ClobClient> {
  if (!config.privateKey) {
    throw new Error("PRIVATE_KEY is required for live trading");
  }
  const account = privateKeyToAccount(config.privateKey);
  const signer = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });

  let creds: ApiKeyCreds | undefined;
  if (config.clobApiKey && config.clobSecret && config.clobPassphrase) {
    creds = {
      key: config.clobApiKey,
      secret: config.clobSecret,
      passphrase: config.clobPassphrase,
    };
  }

  const bootstrap = new ClobClient({
    host: config.clobHost,
    chain: config.chainId,
    signer,
  });

  const apiCreds = creds ?? (await bootstrap.createOrDeriveApiKey());

  const client = new ClobClient({
    host: config.clobHost,
    chain: config.chainId,
    signer,
    creds: apiCreds,
    signatureType: config.signatureType,
    funderAddress: config.funderAddress,
    throwOnError: true,
  });

  // Sync the CLOB server-side balance cache. Without this call, the exchange
  // may not know about collateral deposited via the Polymarket UI, and
  // getBalanceAllowance returns a stale or partial balance.
  try {
    await client.updateBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
  } catch {
    // Non-fatal: the balance may already be synced, or the endpoint
    // may not be required for this account type.
  }

  return client;
}
