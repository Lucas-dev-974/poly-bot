import {
  createPublicClient,
  encodeFunctionData,
  http,
  isAddress,
  type Address,
} from "viem";
import { polygon } from "viem/chains";
import type { BotConfig } from "./config.js";
import { log } from "./logger.js";
import {
  createRelayClient,
  PUSD,
} from "./relayer.js";
import { recordQuotaExceeded, recordQuotaOk } from "./relayer-quota.js";
import type { RedeemResult } from "./relayer.js";

/**
 * Withdraw pUSD from the Polymarket deposit wallet (V2) to an external
 * address (e.g. a MetaMask wallet), via the same gasless relayer used by
 * redeem — a single ERC-20.transfer call in a DepositWallet batch.
 */

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** USDC/pUSD has 6 decimals. */
export const PUSD_DECIMALS = 6;

/** Floor a USD amount to 6 decimals (never round up: never withdraw more). */
export function floorUsdToSixDecimals(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return Math.floor(amount * 1_000_000) / 1_000_000;
}

/**
 * ERC-20.transfer(to, amount) calldata for the pUSD token:
 * selector 0xa9059cbb + 32-byte padded address + 32-byte padded amount.
 */
export function buildTransferCalldata(to: Address, amountUsd: number): string {
  const units = BigInt(Math.round(floorUsdToSixDecimals(amountUsd) * 1_000_000));
  return encodeFunctionData({
    abi: [
      {
        name: "transfer",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
      },
    ],
    args: [to, units],
  });
}

export interface WithdrawValidationOk {
  ok: true;
  amount: number;
  to: Address;
}

export interface WithdrawValidationError {
  ok: false;
  error: string;
}

/**
 * Validate a withdraw request against the current on-chain balance.
 * Pure (no I/O): the balance is passed in by the caller.
 */
export function validateWithdrawRequest(input: {
  amountUsd: unknown;
  to: unknown;
  funder?: string;
  onChainPusd: number;
}): WithdrawValidationOk | WithdrawValidationError {
  const amountRaw = input.amountUsd;
  const toRaw = input.to;

  const amountNum = typeof amountRaw === "number" ? amountRaw : Number(amountRaw);
  if (!Number.isFinite(amountNum)) {
    return { ok: false, error: "amountUsd must be a number" };
  }
  if (amountNum <= 0) {
    return { ok: false, error: "amountUsd must be > 0" };
  }
  // Epsilon-tolerant 6-decimal check: float noise (0.1+0.2 = 0.3000…04) must
  // not reject a valid amount, but a true 7th decimal must be rejected.
  const units = amountNum * 1_000_000;
  const unitsRounded = Math.round(units);
  if (Math.abs(units - unitsRounded) > 1e-6) {
    return { ok: false, error: "amountUsd supports at most 6 decimals" };
  }
  const amount = unitsRounded / 1_000_000;
  if (amount > input.onChainPusd + 1e-9) {
    return {
      ok: false,
      error: `amountUsd (${amount}) exceeds on-chain pUSD balance (${input.onChainPusd})`,
    };
  }

  if (typeof toRaw !== "string" || !isAddress(toRaw)) {
    return { ok: false, error: "to must be a valid EVM address" };
  }
  const to = toRaw as Address;
  const zero = "0x0000000000000000000000000000000000000000";
  if (to.toLowerCase() === zero) {
    return { ok: false, error: "to must not be the zero address" };
  }
  if (input.funder && to.toLowerCase() === input.funder.toLowerCase()) {
    return { ok: false, error: "to must differ from the funder (deposit wallet)" };
  }

  return { ok: true, amount, to };
}

// ---------------------------------------------------------------------------
// On-chain balance
// ---------------------------------------------------------------------------

const BALANCE_OF_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const BALANCE_TIMEOUT_MS = 10_000;
const RPC_URL = "https://polygon-bor-rpc.publicnode.com";

/** pUSD balance of the deposit wallet, in USD (6-decimal units / 1e6). */
export async function getOnChainPusdBalance(
  config: BotConfig,
): Promise<number | null> {
  if (!config.funderAddress) return null;
  const publicClient = createPublicClient({
    chain: polygon,
    transport: http(RPC_URL),
  });
  try {
    const result = await withTimeout(
      "pusdBalanceOf",
      publicClient.call({
        to: PUSD,
        data: encodeFunctionData({
          abi: BALANCE_OF_ABI,
          args: [config.funderAddress],
        }),
      }),
      BALANCE_TIMEOUT_MS,
    );
    const raw = BigInt(result.data ?? "0x0");
    return Number(raw) / 1_000_000;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("pUSD balance fetch failed", { funder: config.funderAddress, error: message });
    return null;
  }
}

async function withTimeout<T>(
  label: string,
  op: Promise<T>,
  timeoutMs: number,
): Promise<T> {
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

// ---------------------------------------------------------------------------
// Relayer flow (mirrors redeemViaRelayer)
// ---------------------------------------------------------------------------

export interface WithdrawRequest {
  to: Address;
  amountUsd: number;
}

export interface WithdrawResult {
  txHash: string;
  transactionId: string;
}

/**
 * Submit a pUSD ERC-20 transfer from the deposit wallet through the relayer.
 * Same auth modes, deadline and quota handling as redeemViaRelayer.
 */
export async function withdrawViaRelayer(
  config: BotConfig,
  req: WithdrawRequest,
): Promise<WithdrawResult> {
  if (!config.privateKey) {
    throw new Error("PRIVATE_KEY is required for relayer actions");
  }
  if (!config.funderAddress) {
    throw new Error("FUNDER_ADDRESS (deposit wallet) is required for withdrawals");
  }

  const client = createRelayClient(config);
  const wallet = config.funderAddress as Address;
  const calls = [
    {
      target: PUSD as Address,
      value: "0",
      data: buildTransferCalldata(req.to, req.amountUsd),
    },
  ];

  // Same 4h deadline rationale as redeemViaRelayer (relayer rejects
  // deadlines too close to "now" with 400 "deadline too soon").
  const deadline = Math.floor(Date.now() / 1000 + 4 * 60 * 60).toString();

  let response;
  try {
    response = await client.executeDepositWalletBatch(
      calls,
      config.funderAddress,
      deadline,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/429|quota exceeded|too many requests|error code: 1015/i.test(message)) {
      recordQuotaExceeded(message);
    }
    throw error;
  }

  const result = await response.wait();

  if (!result || !result.transactionHash) {
    const txHash = response.transactionHash || "";
    if (!txHash) {
      throw new Error(
        "Relayer did not mine the transaction. Check relayer-v2.polymarket.com for details.",
      );
    }
    return { txHash, transactionId: response.transactionID };
  }

  recordQuotaOk();
  return {
    txHash: result.transactionHash,
    transactionId: response.transactionID,
  };
}

export type { RedeemResult };