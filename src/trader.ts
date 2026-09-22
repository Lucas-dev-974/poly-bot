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
import {
  confirmedSoldSize,
  parseOrderStatus,
  sharesFromConditionalBalance,
  type ParsedOrderStatus,
} from "./utils/order-status.js";

export class Trader {
  private client: ClobClient | null = null;
  private static readonly TRADING_TIMEOUT_MS = 8_000;
  private static readonly BALANCE_TIMEOUT_MS = 10_000;
  /**
   * Crypto up/down markets apply a 250 ms taker delay to marketable orders and
   * the conditional-balance cache can lag further. A SELL that the CLOB reports
   * as killed can still settle afterwards: before booking a kill we re-read the
   * balance once after this delay.
   */
  private static readonly SELL_CONFIRM_RETRY_MS = 750;

  constructor(private readonly config: BotConfig) {}

  /**
   * Wraps a trading operation with an applicative timeout. A CLOB POST that
   * hangs would otherwise block the entire tick loop (the `ticking` guard
   * suppresses subsequent ticks). This ensures the bot recovers after 8 s
   * even if the exchange is unresponsive.
   */
  private async withTimeout<T>(label: string, op: Promise<T>, timeoutMs: number = Trader.TRADING_TIMEOUT_MS): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([op, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async init(): Promise<void> {
    // Readonly without a key: skip the CLOB client. BalanceTracker falls
    // back to 0 collateral + the public data-api positions.
    if (this.config.readonlyLive && !this.config.privateKey) return;
    this.client = await createTradingClient(this.config);
  }

  async getAvailableCollateral(): Promise<number | null> {
    if (!this.client) return null;
    const params: BalanceAllowanceParams = { asset_type: AssetType.COLLATERAL };
    const response = await this.withTimeout(
      "getAvailableCollateral",
      this.client.getBalanceAllowance(params),
      Trader.BALANCE_TIMEOUT_MS,
    );
    return Number(response.balance) / 1_000_000;
  }

  async placeBuy(opportunity: TradeOpportunity): Promise<OrderResult> {
    if (!this.client) {
      throw new Error("Trading client not initialized");
    }

    const response = await this.withTimeout(
      "placeBuy",
      this.client.createAndPostOrder(
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
      ),
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
    // Clamp to expensiveBuyMax for classic expensive FOK hedges only.
    // Cheap FOK (ask-lock) must lift the cheap ask as-is. Ask-lock expensive
    // also uses the live ask (bands bypassed); clamping to expensiveBuyMax
    // would make the FOK non-marketable and leave a one-legged cheap.
    const rawAsk = opportunity.token.bestAsk ?? opportunity.price;
    const fokPrice =
      opportunity.kind === "cheap" || this.config.arbAskLockOnly
        ? rawAsk
        : Math.min(rawAsk, this.config.expensiveBuyMax);
    const usdcAmount = fokPrice * opportunity.size;
    let response;
    try {
      response = await this.withTimeout(
        "placeBuyFOK",
        this.client.createAndPostMarketOrder(
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
        ),
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
    // 4-decimal round: 8.700000000000001 / 10 must store as 0.87, not float noise.
    const fillPrice = success && filledSize > 0
      ? round4((Number(response.makingAmount) || usdcAmount) / filledSize)
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
    if (!this.client) return;
    await this.withTimeout(
      "cancelOrder",
      this.client.cancelOrder({ orderID: orderId }),
    );
  }

  /**
   * Manual BUY (dashboard "Marchés actifs") — FOK market order funded by a
   * pUSD budget. For a BUY FOK the CLOB `amount` is the dollar budget; it
   * computes the shares. `price` is a worst-price limit: we pass the live
   * bestAsk so the FOK is marketable and fills at (at most) that price.
   *
   * Tick size and neg-risk are fetched from the CLOB for the token.
   *
   * Returns a compact summary: `success` = filled, `spentUsd` = USDC spent
   * (makingAmount), `filledShares` = shares received (takingAmount).
   */
  async placeManualBuy(
    tokenId: string,
    amountUsd: number,
    worstPrice: number,
  ): Promise<{
    success: boolean;
    filledShares: number;
    spentUsd: number;
    fillPrice: number;
    orderId?: string;
    errorMsg?: string;
  }> {
    if (!this.client) {
      throw new Error("Trading client not initialized");
    }
    const [tickSize, negRisk] = await Promise.all([
      this.client.getTickSize(tokenId),
      this.client.getNegRisk(tokenId).catch(() => false),
    ]);
    const amount = Math.round(amountUsd * 10_000) / 10_000;
    try {
      const response = await this.withTimeout(
        "placeManualBuy",
        this.client.createAndPostMarketOrder(
          {
            tokenID: tokenId,
            price: worstPrice,
            amount,
            side: Side.BUY,
            orderType: OrderType.FOK,
          },
          { tickSize, negRisk },
          OrderType.FOK,
        ),
      );
      const success = response.success ?? false;
      // For BUY: makingAmount = USDC spent, takingAmount = shares received.
      const spentUsd = success ? Number(response.makingAmount) || 0 : 0;
      const filledShares = success ? Number(response.takingAmount) || 0 : 0;
      return {
        success,
        filledShares,
        spentUsd,
        fillPrice: filledShares > 0 ? spentUsd / filledShares : worstPrice,
        orderId: response.orderID,
        errorMsg: response.errorMsg,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // FOK killed by the venue (couldn't fully fill) — a business outcome,
      // not a transport error: report it instead of bubbling.
      if (/couldn't be fully filled/i.test(msg)) {
        return { success: false, filledShares: 0, spentUsd: 0, fillPrice: worstPrice, errorMsg: msg };
      }
      throw err;
    }
  }

  /**
   * Place a FOK (Fill-or-Kill) SELL market order for the cheap leg — a
   * cut-loss / pair-defense mechanism (S2.4). When the favorite ask is
   * above expensiveBuyMax, the filled cheap is sold at the current best
   * bid instead of holding it naked to resolution.
   *
   * The CLOB FOK response is not trusted alone when it reports a kill: a
   * real match can come back as killed / empty makingAmount (ghost fill),
   * so a kill is confirmed against the conditional-token balance drop.
   * Conversely a CLOB-confirmed match (success=true, makingAmount>0) IS
   * trusted — the balance cache can lag the settlement by hundreds of ms.
   *
   * The callers are responsible for refreshing the book and passing the
   * 3-level bid depth (bestBidSize/bid2/bid3) — placeSell does not fetch
   * the book itself.
   */
  async placeSell(opportunity: TradeOpportunity): Promise<OrderResult> {
    if (!this.client) {
      throw new Error("Trading client not initialized");
    }
    // CLOB market-order semantics: `price` is a WORST-PRICE LIMIT, not a
    // target. A SELL FOK matches every bid level with price >= limit. Pricing
    // exactly at bestBid therefore only matches the top-of-book level: if
    // bestBidSize < order size the CLOB kills the order
    // (FOK_ORDER_NOT_FILLED_ERROR -> killed-fok-sell), which is exactly what
    // happens on thin 15m up/down books when closing a manual position.
    // Walk down one tick per visible bid level needed to cover the order,
    // bounded to 3 ticks of slippage so we never dump deep into the book.
    const tick = tickSizeToNumber(opportunity.tickSize);
    const bidDepth = [
      opportunity.token.bestBidSize,
      opportunity.token.bid2Size,
      opportunity.token.bid3Size,
    ];
    let ticksDown = 0;
    let covered = 0;
    for (const levelSize of bidDepth) {
      if (levelSize == null || levelSize <= 0) break;
      covered += levelSize;
      if (covered >= opportunity.size) break;
      ticksDown += 1;
    }
    ticksDown = Math.min(ticksDown, 3);
    const fokPrice = round4(
      Math.max((opportunity.token.bestBid ?? 0) - tick * ticksDown, 0.01),
    );

    // CLOB market SELL semantics: `amount` is the number of SHARES to sell
    // (UserMarketOrderV2: "SELL orders: Shares to sell"), NOT USDC. Passing
    // a USDC amount here would sell price × size shares — a 0.12 bid would
    // sell only 12% of the position instead of all of it.
    const sellShares = opportunity.size;
    const heldBefore = await this.getConditionalTokenBalance(opportunity.token.tokenId);
    let response: {
      success?: boolean;
      makingAmount?: string | number;
      takingAmount?: string | number;
      errorMsg?: string;
    } | null = null;
    let clobFilledSize = 0;
    let clobFillPrice = fokPrice;
    try {
      response = await this.withTimeout(
        "placeSell",
        this.client.createAndPostMarketOrder(
          {
            tokenID: opportunity.token.tokenId,
            price: fokPrice,
            amount: sellShares,
            side: Side.SELL,
            orderType: OrderType.FOK,
          },
          {
            tickSize: opportunity.tickSize as "0.1" | "0.01" | "0.001" | "0.0001",
            negRisk: opportunity.negRisk,
          },
          OrderType.FOK,
        ),
      );
      const success = response.success ?? false;
      // For SELL: makingAmount = shares sold, takingAmount = USDC received
      clobFilledSize = success ? Number(response.makingAmount) || 0 : 0;
      clobFillPrice = success && clobFilledSize > 0
        ? round4((Number(response.takingAmount) || fokPrice * clobFilledSize) / clobFilledSize)
        : fokPrice;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/couldn't be fully filled/i.test(msg)) {
        const heldAfterError = await this.getConditionalTokenBalance(
          opportunity.token.tokenId,
        );
        const recovered = confirmedSoldSize(
          sellShares,
          0,
          heldBefore,
          heldAfterError,
        );
        if (recovered.soldSize > 0) {
          return {
            dryRun: false,
            tokenId: opportunity.token.tokenId,
            side: "SELL",
            price: fokPrice,
            fillPrice: fokPrice,
            size: opportunity.size,
            filledSize: recovered.soldSize,
            filled: true,
            reason: "filled-fok-sell-balance",
            orderType: "FOK",
            response: { errorMsg: msg, success: false } as never,
          };
        }
        throw err;
      }
      response = { errorMsg: msg, success: false };
    }

    const heldAfter = await this.getConditionalTokenBalance(opportunity.token.tokenId);
    let confirmed = confirmedSoldSize(
      sellShares,
      clobFilledSize,
      heldBefore,
      heldAfter,
    );
    // The CLOB's 250 ms taker delay (crypto up/down) plus balance-cache lag
    // means a real fill can still be invisible immediately after the POST.
    // When the CLOB itself confirmed the match (success=true, makingAmount>0)
    // but the balance cache hasn't fully caught up (unchanged or partially
    // updated), trust the CLOB: it is the settlement source of truth and a
    // stale cache under-reports the drop, never over-reports it. Booking a
    // real fill as killed leaves a phantom position that can never be closed.
    if (confirmed.soldSize < clobFilledSize) {
      confirmed = { soldSize: Math.min(clobFilledSize, sellShares), balanceUnknown: false };
    }
    // When the CLOB reported a kill, re-read once after the taker delay:
    // a real match can settle after the "killed" response on these markets.
    if (confirmed.soldSize === 0 && !confirmed.balanceUnknown && clobFilledSize === 0) {
      await new Promise((resolve) => setTimeout(resolve, Trader.SELL_CONFIRM_RETRY_MS));
      const heldLater = await this.getConditionalTokenBalance(opportunity.token.tokenId);
      confirmed = confirmedSoldSize(sellShares, 0, heldBefore, heldLater);
    }
    const soldSize = confirmed.soldSize;
    const filled = soldSize > 0;
    return {
      dryRun: false,
      tokenId: opportunity.token.tokenId,
      side: "SELL",
      price: fokPrice,
      fillPrice: filled ? clobFillPrice : fokPrice,
      size: opportunity.size,
      filledSize: soldSize,
      filled,
      reason: filled
        ? clobFilledSize > 0
          ? "filled-fok-sell"
          : "filled-fok-sell-balance"
        : confirmed.balanceUnknown
          ? "sell-unconfirmed"
          : "killed-fok-sell",
      orderType: "FOK",
      response: response ?? undefined,
    };
  }

  async getOrderStatus(orderId: string): Promise<ParsedOrderStatus> {
    if (!this.client) {
      return { filled: false, cancelled: false, sizeMatched: 0, status: "unknown" };
    }
    const order = await this.withTimeout(
      "getOrderStatus",
      this.client.getOrder(orderId),
    );
    return parseOrderStatus(order);
  }

  /**
   * Shares of a conditional (outcome) token actually held by the funder.
   * Returns 0 if the wallet has none, null if the CLOB balance call failed
   * (caller must fail-closed — do not invent a fill).
   */
  async getConditionalTokenBalance(tokenId: string): Promise<number | null> {
    if (!this.client) return null;
    const params: BalanceAllowanceParams = {
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    };
    try {
      try {
        await this.withTimeout(
          "updateConditionalBalance",
          this.client.updateBalanceAllowance(params),
        );
      } catch {
        // Cache refresh is best-effort; still try the read.
      }
      const response = await this.withTimeout(
        "getConditionalBalance",
        this.client.getBalanceAllowance(params),
      );
      const raw = Number(response.balance);
      if (!Number.isFinite(raw)) return null;
      return sharesFromConditionalBalance(raw);
    } catch {
      return null;
    }
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

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Numeric tick increment for the string tick sizes used across the codebase. */
function tickSizeToNumber(tickSize: string): number {
  const n = Number(tickSize);
  return Number.isFinite(n) && n > 0 ? n : 0.01;
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
