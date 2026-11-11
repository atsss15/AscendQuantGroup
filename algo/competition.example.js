/**
 * Algo competition definition: products, how prices move, and what the bots do.
 *
 * Everything here is a PLACEHOLDER to be replaced with the real design. The simulator only relies on
 * the shape:
 *
 *   products: [{ symbol, limit, underlying?, kind?, strike?, expiryDay? }]
 *     limit = max absolute position; a contract's terms (optional) reach players in state.listings and on the page,
 *     and no other product field is ever sent to players
 *   ticks, tickStep                              ticks per day; timestamps go 0, tickStep, 2·tickStep, …
 *   model.create({ rng, day, ticks, products, carry })  → { step(t) → { [symbol]: fairValue }, mark?(), observations?(t, { playerOpen }), carry?() }
 *     mark(): end-of-day marks for every symbol (default: the last step's fair values; a missing symbol counts as 0)
 *     observations(t, { playerOpen }): features published each tick; observations.csv takes its columns from tick 0's keys.
 *       playerOpen: { [symbol]: the algorithms' open positions by size (long or short), as of the tick's start }
 *     carry: what the previous day's carry() returned (null on a round's first day), so days join up into one series
 *   bots: [{ name, quote?(ctx), take?(ctx) }]  (a take order may add match(restingOrder) → boolean; resting orders have .agent)
 *     quote(ctx) → orders resting in the book before algorithms act (market makers)
 *     take(ctx)  → orders sent after algorithms act; they trade against everything resting (takers)
 *     ctx: { t, timestamp, fair, rng, symbols, position, book? }   book = { [symbol]: { buy_orders, sell_orders, mid } }
 *       (read-only; each symbol's depth is built when the bot first reads it)
 *     orders: [{ symbol, price, quantity }]       quantity > 0 buys, < 0 sells, integer prices
 *   notes (optional): HTML for players, shown under "How it works"
 *
 * End-of-day P&L marks every position at the fair value from the model.
 * `rng()` is seeded per day, so a day can be replayed exactly for backtests.
 */

const STRIKE = 10000;
const EXPIRY_DAY = 7; // the option expires at the end of this day

export const competition = {
  name: 'Ascend Algo Challenge',
  currency: 'SEASHELLS',
  ticks: 2000,
  tickStep: 100,
  timeLimitMs: 400, // per call to Trader.run; slower calls are treated as no orders
  revealCounterparties: false, // true: algorithms see bot names on market trades

  products: [
    { symbol: 'STABLE', limit: 50 },
    { symbol: 'ASCEND', limit: 50 },
    { symbol: `ASCEND_C${STRIKE}`, limit: 100, underlying: 'ASCEND', kind: 'call', strike: STRIKE, expiryDay: EXPIRY_DAY },
  ],

  model: {
    create({ rng, day, ticks, carry }) {
      const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
      let stable = carry?.stable ?? 1000;
      let under = carry?.under ?? 10000 * Math.exp(0.02 * gauss());
      const vol = 0.0008; // per tick
      return {
        step(t) {
          stable += 0.15 * (1000 - stable) + 0.8 * gauss(); // mean-reverting around 1000
          under *= Math.exp(vol * gauss()); // random walk
          const yearsLeft = Math.max(EXPIRY_DAY - day + (ticks - t) / ticks, 1e-6) / 365;
          return {
            STABLE: stable,
            ASCEND: under,
            [`ASCEND_C${STRIKE}`]: blackScholesCall(under, STRIKE, yearsLeft, vol * Math.sqrt(ticks * 365)),
          };
        },
        observations: () => ({}),
        carry: () => ({ stable, under }), // where this day ended; the next day starts here
      };
    },
  },

  bots: [
    {
      name: 'MM',
      // two-level market maker around fair value
      quote({ fair, rng }) {
        const orders = [];
        for (const [symbol, half, size] of [['STABLE', 2, 25], ['ASCEND', 3, 20], [`ASCEND_C${STRIKE}`, 2, 30]]) {
          const f = fair[symbol];
          const bid = Math.floor(f - half);
          const ask = Math.ceil(f + half);
          const q = () => size + Math.floor(rng() * size);
          orders.push({ symbol, price: bid, quantity: q() }, { symbol, price: ask, quantity: -q() });
          orders.push({ symbol, price: bid - 2, quantity: q() }, { symbol, price: ask + 2, quantity: -q() });
        }
        return orders;
      },
    },
    {
      name: 'Noise',
      // occasionally hits the best bid or lifts the best offer
      take({ book, rng, symbols }) {
        const orders = [];
        for (const symbol of symbols) {
          if (rng() > 0.08) continue;
          const d = book[symbol];
          const qty = 1 + Math.floor(rng() * 6);
          if (rng() < 0.5) {
            const ask = Math.min(...Object.keys(d.sell_orders).map(Number));
            if (Number.isFinite(ask)) orders.push({ symbol, price: ask, quantity: qty });
          } else {
            const bid = Math.max(...Object.keys(d.buy_orders).map(Number));
            if (Number.isFinite(bid)) orders.push({ symbol, price: bid, quantity: -qty });
          }
        }
        return orders;
      },
    },
  ],

  /** Starting file every player gets. */
  template: `from datamodel import OrderDepth, TradingState, Order
from typing import Dict, List


class Trader:
    def run(self, state: TradingState):
        """Called every tick. Return (orders by product, conversions, traderData)."""
        result: Dict[str, List[Order]] = {}

        for product, depth in state.order_depths.items():
            orders: List[Order] = []
            position = state.position.get(product, 0)

            if depth.buy_orders and depth.sell_orders:
                best_bid = max(depth.buy_orders)
                best_ask = min(depth.sell_orders)
                mid = (best_bid + best_ask) / 2
                # example: quote one tick inside the spread
                if best_ask - best_bid > 2:
                    orders.append(Order(product, best_bid + 1, 5))    # buy 5
                    orders.append(Order(product, best_ask - 1, -5))   # sell 5

            result[product] = orders

        return result, 0, state.traderData
`,
};

function blackScholesCall(S, K, T, sigma) {
  if (T <= 0 || sigma <= 0) return Math.max(S - K, 0);
  const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return S * normCdf(d1) - K * normCdf(d2);
}

function normCdf(x) {
  // Abramowitz–Stegun approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
