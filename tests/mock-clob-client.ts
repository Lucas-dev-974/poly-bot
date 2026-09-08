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
  public shouldFail = false;
  private orderCounter = 0;

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
    // For FOK BUY: takingAmount = shares, makingAmount = USDC
    // For FOK SELL: makingAmount = shares, takingAmount = USDC
    const size = req.side === "BUY"
      ? Number((req.amount / req.price).toFixed(2))
      : Number((req.amount / req.price).toFixed(2));
    this.orders.set(orderID, {
      status: "matched",
      sizeMatched: size,
      originalSize: size,
      side: req.side,
      price: req.price,
      tokenID: req.tokenID,
    });
    if (req.side === "BUY") {
      return {
        success: true,
        takingAmount: String(size),
        makingAmount: String(req.amount),
        orderID,
      };
    } else {
      return {
        success: true,
        makingAmount: String(size),
        takingAmount: String(req.amount),
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