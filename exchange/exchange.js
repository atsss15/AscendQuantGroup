import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { OrderBook } from './orderbook.js';

/** An error whose message is safe to show to the player (bad input, rule violation). */
export class ExchangeError extends Error {}

const DEFAULT_CONFIG = {
  maxPosition: null, // per user per market, counting resting orders as if filled; null = unlimited
  maxOrderQty: 1000,
  anonymousTrades: true, // hide buyer/seller names on the public tape
  tradeHistory: 2000,
  market: { min: 0, max: 100, tick: 1 }, // defaults for new markets
};

/**
 * Game-agnostic exchange: users, markets, order matching, positions, settlement.
 *
 * Accounting is P&L only: nobody has a cash balance to run out of. For each user and market we track
 * `flows[marketId]` (cash paid/received) and `positions[marketId]` (contracts held), so
 * P&L = flows + position * mark. Settlement converts the position into cash at the settlement price.
 *
 * Emits 'change' after every state mutation.
 */
export class Exchange extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config, market: { ...DEFAULT_CONFIG.market, ...config.market } };
    this.users = new Map();
    this.markets = new Map();
    this.orders = new Map(); // resting orders only
    this.trades = [];
    this.seq = 0;
  }

  nextId(prefix) {
    return `${prefix}${++this.seq}`;
  }

  changed() {
    this.emit('change');
  }

  // ---------------------------------------------------------------- users

  /** Rejoin with a token, or join as a new user with a unique name. */
  join({ name, token } = {}) {
    if (token) {
      for (const u of this.users.values()) if (u.token === token) return u;
    }
    const clean = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
    if (!clean) throw new ExchangeError('Pick a name to join');
    for (const u of this.users.values()) {
      if (u.name.toLowerCase() === clean.toLowerCase()) throw new ExchangeError(`"${clean}" is taken, pick another name`);
    }
    const user = { id: this.nextId('u'), name: clean, token: randomUUID(), positions: {}, flows: {}, createdAt: Date.now() };
    this.users.set(user.id, user);
    this.changed();
    return user;
  }

  getUser(id) {
    const user = this.users.get(id);
    if (!user) throw new ExchangeError('Unknown user');
    return user;
  }

  // ---------------------------------------------------------------- markets

  /**
   * @param {object} spec
   * @param {string} spec.name
   * @param {{id: string, name: string} | string} [spec.group]  markets sharing a group are shown together
   * @param {number} [spec.min] [spec.max] [spec.tick]          integer price grid; defaults from config.market
   * @param {object} [spec.meta]                                free-form data for the game
   */
  createMarket({ name, group = null, description = '', min, max, tick, meta = {} } = {}) {
    const clean = String(name ?? '').trim().slice(0, 60);
    if (!clean) throw new ExchangeError('Market needs a name');
    const spec = { ...this.config.market };
    for (const [k, v] of Object.entries({ min, max, tick })) {
      if (v !== undefined && v !== null && v !== '') spec[k] = Number(v);
    }
    if (
      ![spec.min, spec.max, spec.tick].every(Number.isInteger) ||
      spec.tick <= 0 ||
      spec.min >= spec.max ||
      (spec.max - spec.min) % spec.tick !== 0
    ) {
      throw new ExchangeError('min/max/tick must be integers, min < max, and (max - min) divisible by tick');
    }
    if (typeof group === 'string') group = group.trim() ? { id: `g:${group.trim()}`, name: group.trim() } : null;
    const market = {
      id: this.nextId('m'),
      name: clean,
      group: group ? { id: String(group.id), name: String(group.name).slice(0, 60) } : null,
      description: String(description ?? '').slice(0, 300),
      min: spec.min,
      max: spec.max,
      tick: spec.tick,
      meta,
      status: 'open', // open | halted | settled
      settlement: null,
      lastPrice: null,
      volume: 0,
      createdAt: Date.now(),
      book: new OrderBook(),
    };
    this.markets.set(market.id, market);
    this.changed();
    return market;
  }

  getMarket(id) {
    const market = this.markets.get(id);
    if (!market) throw new ExchangeError('Unknown market');
    return market;
  }

  marketsInGroup(groupId) {
    return [...this.markets.values()].filter((m) => m.group?.id === groupId);
  }

  /** Halt (no new orders, cancels still allowed) or reopen a market. */
  setStatus(marketId, status) {
    const market = this.getMarket(marketId);
    if (status !== 'open' && status !== 'halted') throw new ExchangeError('Status must be open or halted');
    if (market.status === 'settled') throw new ExchangeError(`${market.name} is already settled`);
    market.status = status;
    this.changed();
  }

  /** Cancel all orders, pay out every position at `price`, and close the market for good. */
  settleMarket(marketId, price) {
    const market = this.getMarket(marketId);
    if (market.status === 'settled') throw new ExchangeError(`${market.name} is already settled`);
    price = Number(price);
    if (!Number.isFinite(price) || price < market.min || price > market.max) {
      throw new ExchangeError(`Settlement price must be between ${market.min} and ${market.max}`);
    }
    this.clearBook(market);
    for (const user of this.users.values()) {
      const pos = user.positions[market.id];
      if (pos) {
        user.flows[market.id] = (user.flows[market.id] ?? 0) + pos * price;
        delete user.positions[market.id];
      }
    }
    market.status = 'settled';
    market.settlement = price;
    market.settledAt = Date.now();
    this.changed();
  }

  /** Remove a market that never traded (e.g. created by mistake). */
  deleteMarket(marketId) {
    const market = this.getMarket(marketId);
    if (market.volume > 0) throw new ExchangeError(`${market.name} has traded; settle it instead`);
    this.clearBook(market);
    this.markets.delete(market.id);
    this.changed();
  }

  clearBook(market) {
    for (const o of market.book.allOrders()) {
      o.status = 'cancelled';
      this.orders.delete(o.id);
    }
    market.book = new OrderBook();
  }

  // ---------------------------------------------------------------- orders

  /**
   * Place a limit order. tif 'GTC' rests any unfilled remainder; 'IOC' cancels it
   * (use IOC at the best bid/ask to "hit the bid" / "lift the offer").
   */
  placeOrder(userId, { marketId, side, price, qty, tif = 'GTC' } = {}) {
    const user = this.getUser(userId);
    const market = this.getMarket(marketId);
    if (market.status !== 'open') throw new ExchangeError(`${market.name} is ${market.status}`);
    if (side !== 'buy' && side !== 'sell') throw new ExchangeError('Side must be buy or sell');
    if (tif !== 'GTC' && tif !== 'IOC') throw new ExchangeError('tif must be GTC or IOC');
    price = Number(price);
    qty = Number(qty);
    if (!Number.isInteger(qty) || qty <= 0) throw new ExchangeError('Quantity must be a positive whole number');
    if (qty > this.config.maxOrderQty) throw new ExchangeError(`Max order size is ${this.config.maxOrderQty}`);
    if (!Number.isInteger(price) || price < market.min || price > market.max || (price - market.min) % market.tick !== 0) {
      throw new ExchangeError(`Price must be ${market.min}-${market.max} in steps of ${market.tick}`);
    }
    this.checkPositionLimit(user, market, side, qty);

    const order = {
      id: this.nextId('o'),
      userId: user.id,
      marketId: market.id,
      side,
      price,
      qty,
      remaining: qty,
      tif,
      status: 'new',
      createdAt: Date.now(),
    };
    const { fills, selfCancelled } = market.book.submit(order);
    for (const o of selfCancelled) this.orders.delete(o.id);
    const trades = fills.map((f) => this.recordFill(market, f));
    if (order.status === 'open') this.orders.set(order.id, order);
    this.changed();
    return { order, trades, selfCancelled };
  }

  /** Worst case: every resting order on the same side fills along with this one. */
  checkPositionLimit(user, market, side, qty) {
    const limit = this.config.maxPosition;
    if (limit == null) return;
    const pos = user.positions[market.id] ?? 0;
    let openBuy = 0;
    let openSell = 0;
    for (const o of market.book.allOrders()) {
      if (o.userId !== user.id) continue;
      if (o.side === 'buy') openBuy += o.remaining;
      else openSell += o.remaining;
    }
    if (side === 'buy' && pos + openBuy + qty > limit) {
      throw new ExchangeError(`Position limit is ±${limit}: you hold ${pos} with ${openBuy} more bid`);
    }
    if (side === 'sell' && pos - openSell - qty < -limit) {
      throw new ExchangeError(`Position limit is ±${limit}: you hold ${pos} with ${openSell} more offered`);
    }
  }

  recordFill(market, { maker, taker, price, qty }) {
    const buy = maker.side === 'buy' ? maker : taker;
    const sell = maker.side === 'buy' ? taker : maker;
    this.adjust(buy.userId, market.id, qty, -price * qty);
    this.adjust(sell.userId, market.id, -qty, price * qty);
    if (maker.status === 'filled') this.orders.delete(maker.id);
    market.lastPrice = price;
    market.volume += qty;
    const trade = {
      id: this.nextId('t'),
      marketId: market.id,
      price,
      qty,
      aggressor: taker.side,
      buyerId: buy.userId,
      sellerId: sell.userId,
      ts: Date.now(),
    };
    this.trades.push(trade);
    if (this.trades.length > this.config.tradeHistory) this.trades.splice(0, this.trades.length - this.config.tradeHistory);
    return trade;
  }

  adjust(userId, marketId, dPos, dCash) {
    const user = this.getUser(userId);
    const pos = (user.positions[marketId] ?? 0) + dPos;
    if (pos === 0) delete user.positions[marketId];
    else user.positions[marketId] = pos;
    user.flows[marketId] = (user.flows[marketId] ?? 0) + dCash;
  }

  /** Cancel one order. Pass userId = null to cancel as admin. */
  cancelOrder(userId, orderId) {
    const order = this.orders.get(orderId);
    if (!order || (userId !== null && order.userId !== userId)) throw new ExchangeError('Order not found (already filled or cancelled?)');
    this.getMarket(order.marketId).book.remove(order.id);
    this.orders.delete(order.id);
    order.status = 'cancelled';
    this.changed();
    return order;
  }

  /** Cancel all of a user's orders (userId = null: everyone's), optionally in one market. */
  cancelAll(userId, marketId = null) {
    const targets = [...this.orders.values()].filter(
      (o) => (userId === null || o.userId === userId) && (marketId === null || o.marketId === marketId),
    );
    for (const o of targets) {
      this.getMarket(o.marketId).book.remove(o.id);
      this.orders.delete(o.id);
      o.status = 'cancelled';
    }
    if (targets.length) this.changed();
    return targets.length;
  }

  // ---------------------------------------------------------------- views

  /** Mark price for P&L: settlement if settled, else last trade clamped to the current bid/ask. */
  mark(market) {
    if (market.status === 'settled') return market.settlement;
    const bid = market.book.bestBid();
    const ask = market.book.bestAsk();
    let mark = market.lastPrice;
    if (mark === null) return bid !== null && ask !== null ? (bid + ask) / 2 : null;
    if (bid !== null && mark < bid) mark = bid;
    if (ask !== null && mark > ask) mark = ask;
    return mark;
  }

  pnl(user) {
    let total = 0;
    for (const [marketId, flow] of Object.entries(user.flows)) {
      const market = this.markets.get(marketId);
      if (!market) continue;
      total += flow + (user.positions[marketId] ?? 0) * (this.mark(market) ?? 0);
    }
    return total;
  }

  marketView(m) {
    return {
      id: m.id,
      name: m.name,
      group: m.group,
      description: m.description,
      min: m.min,
      max: m.max,
      tick: m.tick,
      meta: m.meta,
      status: m.status,
      settlement: m.settlement,
      lastPrice: m.lastPrice,
      mark: this.mark(m),
      volume: m.volume,
      createdAt: m.createdAt,
      bids: m.book.levels('buy'),
      asks: m.book.levels('sell'),
    };
  }

  tradeView(t) {
    const view = { id: t.id, marketId: t.marketId, price: t.price, qty: t.qty, aggressor: t.aggressor, ts: t.ts };
    if (!this.config.anonymousTrades) {
      view.buyer = this.users.get(t.buyerId)?.name;
      view.seller = this.users.get(t.sellerId)?.name;
    }
    return view;
  }

  orderView(o) {
    return { id: o.id, marketId: o.marketId, side: o.side, price: o.price, qty: o.qty, remaining: o.remaining, tif: o.tif, status: o.status, createdAt: o.createdAt };
  }

  /** Everything every player sees. */
  publicState() {
    return {
      markets: [...this.markets.values()].map((m) => this.marketView(m)),
      trades: this.trades.slice(-100).map((t) => this.tradeView(t)),
      leaderboard: [...this.users.values()]
        .map((u) => ({ name: u.name, pnl: this.pnl(u) }))
        .sort((a, b) => b.pnl - a.pnl),
      config: { maxPosition: this.config.maxPosition, maxOrderQty: this.config.maxOrderQty },
    };
  }

  /** One player's private view: positions, open orders, fills. */
  userState(userId) {
    const user = this.getUser(userId);
    const marketIds = new Set([...Object.keys(user.flows), ...Object.keys(user.positions)]);
    const positions = [];
    for (const marketId of marketIds) {
      const market = this.markets.get(marketId);
      if (!market) continue;
      const position = user.positions[marketId] ?? 0;
      const mark = this.mark(market);
      const cashFlow = user.flows[marketId] ?? 0;
      positions.push({ marketId, position, cashFlow, mark, pnl: cashFlow + position * (mark ?? 0) });
    }
    return {
      id: user.id,
      name: user.name,
      pnl: this.pnl(user),
      positions,
      orders: [...this.orders.values()].filter((o) => o.userId === user.id).map((o) => this.orderView(o)),
      trades: this.trades
        .filter((t) => t.buyerId === user.id || t.sellerId === user.id)
        .slice(-100)
        .map((t) => ({ ...this.tradeView(t), side: t.buyerId === user.id ? 'buy' : 'sell' })),
    };
  }

  // ---------------------------------------------------------------- persistence

  toJSON() {
    return {
      version: 1,
      seq: this.seq,
      users: [...this.users.values()],
      markets: [...this.markets.values()].map(({ book, ...m }) => ({ ...m, bids: book.bids, asks: book.asks })),
      trades: this.trades,
    };
  }

  static fromJSON(data, config) {
    const ex = new Exchange(config);
    ex.seq = data.seq;
    for (const u of data.users) ex.users.set(u.id, u);
    for (const { bids, asks, ...m } of data.markets) {
      const book = new OrderBook();
      book.bids = bids;
      book.asks = asks;
      ex.markets.set(m.id, { ...m, book });
      for (const o of [...bids, ...asks]) ex.orders.set(o.id, o);
    }
    ex.trades = data.trades;
    return ex;
  }
}
