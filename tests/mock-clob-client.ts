/**
 * Mock ClobClient for testing the live order lifecycle without a real CLOB
 * connection. Simulates createAndPostOrder, cancelOrder, getOrder, and
 * createAndPostMarketOrder with controllable state.
 */

interface MockOrder {
  status: "live" | "matched" | "canceled";
  sizeMatched: number;
  originalSize: number;
  side: "BUY" | "SELL";
  price: number;
  tokenID: string;
}

export class MockClobClient {
  public orders = new Map<string, MockOrder>();
  public postedOrders: Array<{ tokenID: string; price: number; size: number; side: string; orderID: string }> = [];
  public marketOrders: Array<{ tokenID: string; price: number; amount: number; side: string }> = [];
  public shouldFail = false;
  /** Conditional-token balances per tokenID, in SHARES (mirrors the funder wallet). */
  public balances = new Map<string, number>();
  /** Raw balance unit returned by getBalanceAllowance: 6-decimal (default) or plain shares. */
  public rawBalanceScale: 1 | 1_000_000 = 1_000_000;
  /** When true, balance reads throw (simulates a CLOB outage). */
  public balanceShouldFail = false;
  /**
   * Reproduces the production ghost: the SELL really matches (balance drops)
   * but the CLOB answers success=false / empty makingAmount.
   */
  public sellReportsKilledButFills = false;
  /**
   * Simulates the 250 ms taker delay (+ balance-cache lag): the SELL settles on
   * the exchange but the balance drop is only visible on the SECOND balance
   * read after the POST (the first read still shows the pre-sell balance).
   * Lets tests cover the delayed re-check in Trader.placeSell.
   */
  public sellSettlesOnSecondRead = false;
  /**
   * CLOB reports success with the full makingAmount but the balance cache
   * only drops a fraction of the sold size on the first re-read (partially
   * stale cache). Covers the "trust the CLOB over a stale cache" override.
   */
  public sellDropsPartially = false;
  private pendingSellDrop:
    | { tokenId: string; amount: number; readsAfterPost: number }
    | null = null;
  private orderCounter = 0;

  async updateBalanceAllowance(_params: { asset_type: string; token_id?: string }): Promise<void> {
    if (this.balanceShouldFail) throw new Error("balance refresh failed");
  }

  async getBalanceAllowance(params: { asset_type: string; token_id?: string }): Promise<{ balance: string }> {
    if (this.balanceShouldFail) throw new Error("balance read failed");
    if (this.pendingSellDrop && this.pendingSellDrop.tokenId === params.token_id) {
      this.pendingSellDrop.readsAfterPost -= 1;
      if (this.pendingSellDrop.readsAfterPost <= 0) {
        const cur = this.balances.get(params.token_id ?? "") ?? 0;
        this.balances.set(
          params.token_id ?? "",
          Number(Math.max(0, cur - this.pendingSellDrop.amount).toFixed(2)),
        );
        this.pendingSellDrop = null;
      }
    }
    const shares = this.balances.get(params.token_id ?? "") ?? 0;
    return { balance: String(Math.round(shares * this.rawBalanceScale)) };
  }

  async createAndPostOrder(req: {
    tokenID: string;
    price: number;
    side: "BUY" | "SELL";
    size: number;
  }): Promise<{ orderID: string; success: boolean }> {
    if (this.shouldFail) throw new Error("network error");
    const orderID = `mock-${++this.orderCounter}`;
    this.postedOrders.push({ ...req, orderID });
    this.orders.set(orderID, {
      status: "live",
      sizeMatched: 0,
      originalSize: req.size,
      side: req.side,
      price: req.price,
      tokenID: req.tokenID,
    });
    return { orderID, success: true };
  }

  async createAndPostMarketOrder(req: {
    tokenID: string;
    price: number;
    amount: number;
    side: "BUY" | "SELL";
    orderType: string;
  }): Promise<{
    success: boolean;
    takingAmount?: string;
    makingAmount?: string;
    orderID?: string;
    errorMsg?: string;
  }> {
    if (this.shouldFail) throw new Error("network error");
    const orderID = `mock-${++this.orderCounter}`;
    this.marketOrders.push({ tokenID: req.tokenID, price: req.price, amount: req.amount, side: req.side });
    // CLOB market order semantics:
    //   BUY:  amount = USDC to spend → takingAmount = shares, makingAmount = USDC
    //   SELL: amount = SHARES to sell → makingAmount = shares, takingAmount = USDC
    // (UserMarketOrderV2: "BUY orders: $$$ Amount to buy, SELL orders: Shares to sell")
    const size = req.side === "BUY"
      ? Number((req.amount / req.price).toFixed(2))
      : Number(req.amount.toFixed(2));
    this.orders.set(orderID, {
      status: "matched",
      sizeMatched: size,
      originalSize: size,
      side: req.side,
      price: req.price,
      tokenID: req.tokenID,
    });
    const held = this.balances.get(req.tokenID) ?? 0;
    if (req.side === "SELL" && this.sellDropsPartially) {
      // CLOB confirms the full match but the balance cache only reflects a
      // fraction of the drop on the re-read (partially stale cache).
      const sold = Math.min(size, held);
      this.balances.set(req.tokenID, Number(Math.max(0, held - sold / 10).toFixed(2)));
      return {
        success: true,
        makingAmount: String(size),
        takingAmount: String(Number((req.amount * req.price).toFixed(2))),
        orderID,
      };
    }
    if (req.side === "SELL" && this.sellSettlesOnSecondRead) {
      // Real-world: match settles after the first balance re-read. Postpone
      // the balance drop until the 2nd read after this POST, and report the
      // order as killed in the meantime.
      this.pendingSellDrop = {
        tokenId: req.tokenID,
        amount: Math.min(size, held),
        // placeSell reads the balance twice after the POST (heldAfter, then
        // the delayed heldLater); the settlement must be visible only on the
        // 2nd read to exercise the delayed re-check.
        readsAfterPost: 2,
      };
      this.orders.set(orderID, { status: "canceled", sizeMatched: 0, originalSize: size, side: req.side, price: req.price, tokenID: req.tokenID });
      return { success: false, makingAmount: "", takingAmount: "", orderID };
    }
    this.balances.set(
      req.tokenID,
      Number((req.side === "BUY" ? held + size : Math.max(0, held - size)).toFixed(2)),
    );
    if (req.side === "BUY") {
      return {
        success: true,
        takingAmount: String(size),
        makingAmount: String(req.amount),
        orderID,
      };
    } else if (this.sellReportsKilledButFills) {
      return { success: false, makingAmount: "", takingAmount: "", orderID };
    } else {
      return {
        success: true,
        makingAmount: String(size),
        takingAmount: String(Number((req.amount * req.price).toFixed(2))),
        orderID,
      };
    }
  }

  async cancelOrder(req: { orderID: string }): Promise<void> {
    const o = this.orders.get(req.orderID);
    if (o) o.status = "canceled";
  }

  async getOrder(orderId: string): Promise<{
    status: string;
    size_matched: string;
    original_size: string;
  }> {
    const o = this.orders.get(orderId);
    if (!o) throw new Error("404 not found");
    return {
      status: o.status,
      size_matched: String(o.sizeMatched),
      original_size: String(o.originalSize),
    };
  }

  /** Test helper: simulate a fill (partial or full) on an order. */
  simulateFill(orderId: string, size: number): void {
    const o = this.orders.get(orderId);
    if (o) {
      o.sizeMatched = size;
      o.status = size >= o.originalSize ? "matched" : "live";
    }
  }

  /** Test helper: simulate a cancel by the exchange. */
  simulateCancel(orderId: string): void {
    const o = this.orders.get(orderId);
    if (o) o.status = "canceled";
  }
}