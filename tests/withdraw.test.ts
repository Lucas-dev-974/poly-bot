import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Database } from "../src/db/database.js";
import { createRepositories } from "../src/db/index.js";
import {
  PUSD_DECIMALS,
  buildTransferCalldata,
  floorUsdToSixDecimals,
  validateWithdrawRequest,
} from "../src/withdraw.js";

const FUNDER = "0x1111111111111111111111111111111111111111";
const DEST = "0x2222222222222222222222222222222222222222";

describe("withdraw: floorUsdToSixDecimals", () => {
  it("floors to 6 decimals (never rounds up)", () => {
    assert.equal(floorUsdToSixDecimals(1234.5678915), 1234.567891);
    assert.equal(floorUsdToSixDecimals(0.0000019), 0.000001);
    assert.equal(floorUsdToSixDecimals(500), 500);
    assert.equal(floorUsdToSixDecimals(0.1 + 0.2), 0.3);
  });

  it("returns 0 for non-finite input", () => {
    assert.equal(floorUsdToSixDecimals(Number.NaN), 0);
    assert.equal(floorUsdToSixDecimals(Number.POSITIVE_INFINITY), 0);
  });
});

describe("withdraw: buildTransferCalldata", () => {
  it("encodes ERC-20.transfer(to, amount) with 6-decimal units", () => {
    const calldata = buildTransferCalldata(DEST, 500);
    assert.ok(calldata.startsWith("0xa9059cbb"), "selector transfer");
    // 500 USDC = 500_000_000 units = 0x1DCD6500
    assert.ok(
      calldata.endsWith("000000000000000000000000000000000000000000000000000000001dcd6500"),
      "amount padded to 32 bytes",
    );
    // address padded in the first arg slot (0xa9059cbb + 24 zero bytes)
    assert.ok(
      calldata.includes("a9059cbb0000000000000000000000002222222222222222222222222222222222222222"),
      "destination address padded",
    );
  });

  it("encodes the minimal 6-decimal unit (0.000001)", () => {
    const calldata = buildTransferCalldata(DEST, 0.000001);
    assert.ok(calldata.endsWith("00000000000000000000000000000000000000000000000000000000000001"));
  });

  it("exports the pUSD decimals constant", () => {
    assert.equal(PUSD_DECIMALS, 6);
  });
});

describe("withdraw: validateWithdrawRequest", () => {
  // Valid amount in the base so address-focused tests reach the address checks.
  const base = { to: DEST, funder: FUNDER, onChainPusd: 1000, amountUsd: 10 };

  it("accepts a valid request and floors the amount", () => {
    const result = validateWithdrawRequest({
      ...base,
      amountUsd: 1234.5678915,
      onChainPusd: 2000,
    });
    // 1234.5678915 has a true 7th decimal (…15 µ-unit) → rejected, not rounded.
    assert.equal(result.ok, false);
    const result2 = validateWithdrawRequest({
      ...base,
      amountUsd: 1234.567891,
      onChainPusd: 2000,
    });
    assert.equal(result2.ok, true);
    if (result2.ok) {
      assert.equal(result2.amount, 1234.567891);
      assert.equal(result2.to, DEST);
    }
  });

  it("rejects non-positive amounts", () => {
    for (const amountUsd of [0, -5]) {
      const result = validateWithdrawRequest({ ...base, amountUsd });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /amountUsd/);
    }
  });

  it("rejects non-numeric amounts", () => {
    const result = validateWithdrawRequest({ ...base, amountUsd: "abc" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /must be a number/);
  });

  it("rejects more than 6 decimals", () => {
    const result = validateWithdrawRequest({ ...base, amountUsd: 1.0000001 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /6 decimals/);
  });

  it("rejects amounts above the on-chain pUSD balance", () => {
    const result = validateWithdrawRequest({ ...base, amountUsd: 1000.000001 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /exceeds on-chain/);
  });

  it("rejects an invalid destination address", () => {
    const result = validateWithdrawRequest({ ...base, to: "0xnotanaddress" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /valid EVM address/);
  });

  it("rejects the zero address", () => {
    const result = validateWithdrawRequest({
      ...base,
      to: "0x0000000000000000000000000000000000000000",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /zero address/);
  });

  it("rejects the funder address itself (no self-transfer)", () => {
    const result = validateWithdrawRequest({ ...base, to: FUNDER });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /funder/);
  });
});

describe("withdraw: WithdrawalRepository (DB roundtrip)", () => {
  it("inserts and reads back withdrawal rows (column 'to' is a reserved keyword)", () => {
    const dir = mkdtempSync(join(tmpdir(), "withdraw-"));
    try {
      const db = new Database(join(dir, "t.db"), true);
      db.init();
      const repos = createRepositories(db);
      repos.withdrawals.insert({
        to: DEST,
        amount: 500,
        txHash: "0xabc",
        source: "manual",
        success: 1,
      });
      repos.withdrawals.insert({
        to: FUNDER,
        amount: 12.5,
        txHash: null,
        source: "manual",
        success: 0,
        errorMessage: "quota exceeded",
      });
      const rows = repos.withdrawals.recent(10);
      assert.equal(rows.length, 2);
      // Newest first (same-ms inserts disambiguated by id DESC).
      assert.equal(rows[0].to, FUNDER);
      assert.equal(rows[0].amount, 12.5);
      assert.equal(rows[0].success, 0);
      assert.equal(rows[0].errorMessage, "quota exceeded");
      assert.equal(rows[1].to, DEST);
      assert.equal(rows[1].txHash, "0xabc");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});