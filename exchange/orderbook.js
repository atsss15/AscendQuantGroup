/**
 * Central limit order book for a single market, price-time priority.
 *
 * Orders are plain objects: { id, userId, side: 'buy'|'sell', price, qty, remaining, tif: 'GTC'|'IOC', status }.
 * Prices are integers, so there is no floating point drift in matching.
 */
export class OrderBook {
  constructor() {
    this.bids = []; // best (highest) price first, FIFO within a price
    this.asks = []; // best (lowest) price first, FIFO within a price
  }

  bestBid() {
    return this.bids.length ? this.bids[0].price : null;
  }

  bestAsk() {
    return this.asks.length ? this.asks[0].price : null;
  }

  /**
   * Match an incoming order against the opposite side, then rest any remainder if it is GTC.
   * Self-trade prevention: a resting order from the same user that would be hit is cancelled instead.
   * Mutates the incoming order and any resting orders it touches.
   */
  submit(order) {
    const fills = [];
    const selfCancelled = [];
    const opposite = order.side === 'buy' ? this.asks : this.bids;
    const crosses = order.side === 'buy' ? (p) => p <= order.price : (p) => p >= order.price;

    while (order.remaining > 0 && opposite.length > 0 && crosses(opposite[0].price)) {
      const maker = opposite[0];
      if (maker.userId === order.userId) {
        opposite.shift();
        maker.status = 'cancelled';
        selfCancelled.push(maker);
        continue;
      }
      const qty = Math.min(order.remaining, maker.remaining);
      maker.remaining -= qty;
      order.remaining -= qty;
      fills.push({ maker, taker: order, price: maker.price, qty });
      if (maker.remaining === 0) {
        opposite.shift();
        maker.status = 'filled';
      }
    }

    if (order.remaining === 0) order.status = 'filled';
    else if (order.tif === 'GTC') {
      this.insert(order);
      order.status = 'open';
    } else order.status = 'cancelled';

    return { fills, selfCancelled };
  }

  insert(order) {
    const side = order.side === 'buy' ? this.bids : this.asks;
    const better = order.side === 'buy' ? (a, b) => a > b : (a, b) => a < b;
    // Goes behind every order at the same price (time priority).
    let i = side.findIndex((o) => better(order.price, o.price));
    if (i === -1) i = side.length;
    side.splice(i, 0, order);
  }

  remove(orderId) {
    for (const side of [this.bids, this.asks]) {
      const i = side.findIndex((o) => o.id === orderId);
      if (i !== -1) return side.splice(i, 1)[0];
    }
    return null;
  }

  /** Aggregated price levels, best first: [{ price, qty, orders }]. */
  levels(side, depth = Infinity) {
    const out = [];
    for (const o of side === 'buy' ? this.bids : this.asks) {
      const last = out[out.length - 1];
      if (last && last.price === o.price) {
        last.qty += o.remaining;
        last.orders += 1;
      } else {
        if (out.length >= depth) break;
        out.push({ price: o.price, qty: o.remaining, orders: 1 });
      }
    }
    return out;
  }

  allOrders() {
    return [...this.bids, ...this.asks];
  }
}
