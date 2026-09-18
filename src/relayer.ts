/**
 * Polymarket Relayer client for deposit-wallet (V2) on-chain actions.
 *
 * Deposit wallets (POLY_1271 / signatureType 3) are smart-contract wallets
 * deployed by Polymarket's DepositWalletFactory. The wallet owner (EOA)
 * signs an EIP-712 Batch and submits it to the relayer, which dispatches
 * the calls through the wallet contract gaslessly.
 *
 * This module wraps @polymarket/builder-relayer-client to:
 *   - build a RelayClient authenticated either with a dedicated Relayer
 *     API key (preferred — unlimited daily transactions) or with Builder
 *     HMAC credentials (fallback — subject to the Builder-tier daily quota)
 *   - ensure CTF setApprovalForAll is granted to the collateral adapter
 *   - submit a batch (approve + redeem via CtfCollateralAdapter / NegRiskCtfCollateralAdapter)
 *   - poll the relayer until the tx is mined (or fails / times out)
 */
import { RelayClient } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { createPublicClient, createWalletClient, encodeFunctionData, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import type { BotConfig } from "./config.js";
import { log } from "./logger.js";
import { recordQuotaExceeded, recordQuotaOk } from "./relayer-quota.js";

let loggedRelayerAuthMode = false;

// ---------------------------------------------------------------------------
// Contract addresses on Polygon (chainId 137)
// ---------------------------------------------------------------------------

/** CTF (Conditional Tokens Framework) — ERC-1155 position token contract. */
const CTF: Address = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

/** pUSD (V2 collateral proxy) — exported for the withdraw flow. */
export const PUSD: Address = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";

/** CtfCollateralAdapter — standard (non-neg-risk) split/merge/redeem. */
const CTF_COLLATERAL_ADAPTER: Address =
  "0xAdA100Db00Ca00073811820692005400218FcE1f";

/** NegRiskCtfCollateralAdapter — neg-risk split/merge/redeem. */
const NEGRISK_CTF_COLLATERAL_ADAPTER: Address =
  "0xadA2005600Dec949baf300f4C6120000bDB6eAab";

// ---------------------------------------------------------------------------
// ABIs (minimal)
// ---------------------------------------------------------------------------

const SET_APPROVAL_FOR_ALL_ABI = [
  {
    name: "setApprovalForAll",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
] as const;

const IS_APPROVED_FOR_ALL_ABI = [
  {
    name: "isApprovedForAll",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * Standard adapter:
 *   redeemPositions(address collateralToken, bytes32 parentCollectionId,
 *                   bytes32 conditionId, uint256[] indexSets)
 *
 * The V2 adapter ignores collateralToken / parentCollectionId / indexSets
 * (it reads the wallet's full YES+NO balances itself), but they must still
 * be supplied for ABI compatibility. We pass indexSets [1,2] so the adapter
 * redeems both outcomes in one call.
 */
const STANDARD_REDEEM_ABI = [
  {
    name: "redeemPositions",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "indexSets", type: "uint256[]" },
    ],
    outputs: [],
  },
] as const;

/**
 * NegRisk adapter:
 *   redeemPositions(bytes32 conditionId, uint256[] amounts)
 *
 * `amounts` is [yesAmount, noAmount]. Passing a very large amount (2^255)
 * tells the adapter to redeem the wallet's full balance.
 */
const NEGRISK_REDEEM_ABI = [
  {
    name: "redeemPositions",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "conditionId", type: "bytes32" },
      { name: "amounts", type: "uint256[]" },
    ],
    outputs: [],
  },
] as const;

// ---------------------------------------------------------------------------
// Relayer wrapper
// ---------------------------------------------------------------------------

export interface RedeemResult {
  txHash: string;
  transactionId: string;
}

/**
 * Build an authenticated RelayClient for deposit-wallet (WALLET) batches.
 * Exported for sibling flows that reuse the relayer (e.g. pUSD withdrawals).
 */
export function createRelayClient(config: BotConfig): RelayClient {
  if (!config.privateKey) {
    throw new Error("PRIVATE_KEY is required for relayer actions");
  }

  // Two auth modes for the relayer:
  //   1. Dedicated RELAYER_API_KEY (preferred): unlocks unlimited daily
  //      transactions for the owning wallet. Sent as HTTP headers on every
  //      request. See https://docs.polymarket.com/programs/builders/tiers
  //   2. Builder HMAC credentials (fallback): subject to the Builder-tier
  //      daily quota (100 → 10 000 tx/day depending on tier).
  // At least one of the two must be configured.
  const hasRelayerApiKey = !!config.relayerApiKey;
  const hasBuilderCreds =
    !!config.builderApiKey && !!config.builderSecret && !!config.builderPassphrase;

  if (!hasRelayerApiKey && !hasBuilderCreds) {
    throw new Error(
      "Relayer auth required: set RELAYER_API_KEY (+ RELAYER_API_KEY_ADDRESS) " +
        "for unlimited daily transactions, or BUILDER_API_KEY / BUILDER_SECRET / " +
        "BUILDER_PASSPHRASE for Builder-tier auth. " +
        "Get them from https://polymarket.com/settings?tab=builder",
    );
  }

  const account = privateKeyToAccount(config.privateKey);
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });

  // Prefer Relayer API key auth EXCLUSIVELY when configured.
  // The SDK always attaches POLY_BUILDER_* HMAC headers if BuilderConfig is
  // present. The relayer then bills the request against the Builder-tier
  // daily quota (100 tx/day Unverified) even if RELAYER_API_KEY is also
  // sent — that's why we still got 429 after wiring the dedicated key.
  // Builder HMAC is only used as fallback when no Relayer API key is set.
  const builderConfig =
    !hasRelayerApiKey && hasBuilderCreds
      ? new BuilderConfig({
          localBuilderCreds: {
            key: config.builderApiKey!,
            secret: config.builderSecret!,
            passphrase: config.builderPassphrase!,
          },
        })
      : undefined;

  // relayTxType is irrelevant for deposit-wallet batches (they use dedicated
  // methods), but the constructor requires it. Use SAFE as a harmless default.
  const client = new RelayClient(
    config.relayerHost,
    config.chainId,
    walletClient,
    builderConfig,
    // RelayerTxType.SAFE (default)
    undefined,
  );

  // When a dedicated Relayer API key is configured, inject it as HTTP headers
  // on every outbound request to the relayer. This bypasses the Builder-tier
  // daily quota and grants unlimited daily transactions for the owning wallet.
  // The SDK doesn't expose a native option for this, so we attach an axios
  // request interceptor on its internal HttpClient instance.
  if (hasRelayerApiKey) {
    // RELAYER_API_KEY_ADDRESS must be the signer EOA (the address that owns
    // the key), NOT the funder/deposit-wallet address. Per Polymarket docs:
    //   "Copy the Signer Address and API Key shown after creation."
    // Fall back to the derived signer address, never to funderAddress.
    const keyAddress = config.relayerApiKeyAddress ?? account.address;
    client.httpClient.instance.interceptors.request.use((req) => {
      if (!req.headers) {
        req.headers = {} as never;
      }
      const headers = req.headers as {
        set?: (name: string, value: string) => unknown;
        [key: string]: unknown;
      };
      if (typeof headers.set === "function") {
        headers.set("RELAYER_API_KEY", config.relayerApiKey!);
        headers.set("RELAYER_API_KEY_ADDRESS", keyAddress as string);
      } else {
        headers["RELAYER_API_KEY"] = config.relayerApiKey!;
        headers["RELAYER_API_KEY_ADDRESS"] = keyAddress as string;
      }
      return req;
    });
    if (!loggedRelayerAuthMode) {
      loggedRelayerAuthMode = true;
      log("Relayer auth: RELAYER_API_KEY (Builder HMAC disabled to bypass daily quota)", {
        signer: keyAddress,
      });
    }
  } else if (!loggedRelayerAuthMode) {
    loggedRelayerAuthMode = true;
    log("Relayer auth: Builder HMAC (subject to daily Builder-tier quota)");
  }

  return client;
}

/**
 * Check on-chain whether the deposit wallet has approved the adapter to
 * transfer its CTF (ERC-1155) position tokens.
 */
async function isCtfApproved(
  walletAddress: Address,
  adapter: Address,
): Promise<boolean> {
  const publicClient = createPublicClient({
    chain: polygon,
    transport: http("https://polygon-bor-rpc.publicnode.com"),
  });
  const data = encodeFunctionData({
    abi: IS_APPROVED_FOR_ALL_ABI,
    args: [walletAddress, adapter],
  });
  const result = await publicClient.call({ to: CTF, data });
  return BigInt(result.data ?? "0x0") === 1n;
}

/**
 * Redeem a resolved Polymarket position through the deposit wallet via the
 * Polymarket relayer. The relayer dispatches the call gaslessly.
 *
 * If the wallet has not yet approved the collateral adapter to transfer its
 * CTF tokens, a `setApprovalForAll` call is prepended to the batch so the
 * redeem succeeds in a single transaction.
 *
 * @param config      bot config (needs builder creds + private key)
 * @param conditionId  CTF condition id (bytes32 hex)
 * @param _outcomeIndex 0 = YES, 1 = NO (unused by the V2 adapter which redeems
 *                       both legs, kept for API compatibility with the dashboard)
 * @param negRisk      true for negative-risk markets
 * @param walletAddress the deposit wallet (funder) address holding the tokens
 * @returns transaction hash once the relayer has mined the batch
 */
export async function redeemViaRelayer(
  config: BotConfig,
  conditionId: string,
  _outcomeIndex: number,
  negRisk: boolean,
  walletAddress: string,
): Promise<RedeemResult> {
  const client = createRelayClient(config);
  const wallet = walletAddress as Address;
  const adapter = negRisk ? NEGRISK_CTF_COLLATERAL_ADAPTER : CTF_COLLATERAL_ADAPTER;

  // Build the redeem calldata (the inner call the wallet will execute).
  const redeemCalldata = negRisk
    ? encodeFunctionData({
        abi: NEGRISK_REDEEM_ABI,
        args: [
          conditionId as `0x${string}`,
          [BigInt(2) ** BigInt(255)], // redeem full balance
        ],
      })
    : encodeFunctionData({
        abi: STANDARD_REDEEM_ABI,
        args: [
          PUSD,
          "0x0000000000000000000000000000000000000000000000000000000000000000",
          conditionId as `0x${string}`,
          [1n, 2n], // redeem both YES (indexSet 1) and NO (indexSet 2)
        ],
      });

  // Check if the adapter is approved to transfer the wallet's CTF tokens.
  // If not, prepend a setApprovalForAll call to the batch.
  const calls: { target: Address; value: string; data: string }[] = [];

  let approved = false;
  try {
    approved = await isCtfApproved(wallet, adapter);
  } catch {
    // If the on-chain check fails (RPC issue), include the approval call
    // to be safe — setApprovalForAll is idempotent.
  }

  if (!approved) {
    const approveCalldata = encodeFunctionData({
      abi: SET_APPROVAL_FOR_ALL_ABI,
      args: [adapter, true],
    });
    calls.push({
      target: CTF,
      value: "0",
      data: approveCalldata,
    });
  }

  calls.push({
    target: adapter,
    value: "0",
    data: redeemCalldata,
  });

  // Deadline: 4 hours from now. The relayer rejects deadlines too close to
  // "now" with "deadline too soon" (400). 4 minutes (the SDK example value)
  // fails intermittently. poly-web3 had to raise to 4h for the same error;
  // MetaMask Predict uses 300s — 4h gives ample margin while staying well
  // under the max accepted window.
  const deadline = Math.floor(Date.now() / 1000 + 4 * 60 * 60).toString();

  let response;
  try {
    response = await client.executeDepositWalletBatch(
      calls,
      walletAddress,
      deadline,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Detect relayer quota exhaustion / rate-limiting so the dashboard can
    // show the remaining quota and a countdown to the reset, AND so the
    // auto-redeemer can skip subsequent attempts instead of spamming the
    // relayer. Covers both the Polymarket "quota exceeded: ... resets in N
    // seconds" body and Cloudflare "error code: 1015" rate-limit responses.
    if (/429|quota exceeded|too many requests|error code: 1015/i.test(message)) {
      recordQuotaExceeded(message);
    }
    throw error;
  }

  // Poll the relayer until the tx is mined (or fails / times out).
  // The relayer is async: it returns a transactionID immediately, then
  // submits the on-chain tx and updates the state. We wait for STATE_MINED.
  const result = await response.wait();

  if (!result || !result.transactionHash) {
    // If wait() timed out or the tx failed, fall back to returning the id
    // so the caller can still poll manually.
    const txHash = response.transactionHash || "";
    if (!txHash) {
      throw new Error(
        "Relayer did not mine the transaction. Check relayer-v2.polymarket.com for details.",
      );
    }
    return { txHash, transactionId: response.transactionID };
  }

  // A transaction was mined — the quota is clearly not exhausted.
  recordQuotaOk();

  return {
    txHash: result.transactionHash,
    transactionId: response.transactionID,
  };
}