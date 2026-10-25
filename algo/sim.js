import { take, auction, makeRng } from './matching.js';

/**
 * Simulate one trading day.
 *
 * Each tick:
 *   1. The price model moves; maker bots post quotes (the resting book).
 *   2. Every algorithm gets the same snapshot (Prosperity-style TradingState) and answers at once.
 *      Orders that would break a product's position limit are all rejected for that product.
 *   3. Algorithm orders take liquidity from the bot quotes (price priority, pro-rata at each price).
 *   4. Algorithm orders that cross each other clear in a uniform-price batch auction.
 *   5. What's left rests in the book; taker bots trade against bot quotes and algorithm orders alike.
 *   6. Everything is cancelled. Algorithms see their fills and the market's trades next tick.
 * End of day: positions are marked at the products' fair value.
 *
 * @param {object} opts
 * @param {object} opts.config   competition config (products, ticks, model, bots) — see games/algo/config.js
 * @param {number} opts.day      day number (shows up in the data)
 * @param {number} opts.seed     seeds the price model, bots and tie-breaks; same seed + same orders = same day
 * @param {Array<{name: string, run: (state) => Promise<{orders?, traderData?, logs?, error?}>}>} opts.agents
 * @param {boolean} [opts.record] keep the full price/trade record (for data files)
 */
export async function simulateDay({ config, day, seed, agents = [], record = true, options = {}, onProgress }) {
  // separate random streams, so bots and prices replay identically whatever the algorithms do
  const botRng = makeRng(seed ^ 0x85ebca6b);
  const matchRng = makeRng(seed ^ 0xc2b2ae35);
  const symbols = config.products.map((p) => p.symbol);
  const limits = Object.fromEntries(config.products.map((p) => [p.symbol, p.limit]));
  const world = config.model.create({ rng: makeRng(seed ^ 0x9e3779b9), day, ticks: config.ticks, products: config.products, options });

  const accounts = new Map(); // owner -> { cash: {sym}, pos: {sym}, volume: {sym} }
  const account = (owner) => {
    if (!accounts.has(owner)) accounts.set(owner, { cash: zero(symbols), pos: zero(symbols), volume: zero(symbols) });
    return accounts.get(owner);
  };
  for (const a of agents) account(a.name);
  const agentNames = new Set(agents.map((a) => a.name));
  const agentState = new Map(agents.map((a) => [a.name, { traderData: '', ownTrades: emptyBySymbol(symbols), marketTrades: emptyBySymbol(symbols), logs: [], errors: new Map(), rejected: 0 }]));
  // repeated errors are grouped: first occurrence + count
  const addError = (st, timestamp, msg) => {
    const key = String(msg).trim().split('\n').at(-1).replace(/\(position -?\d+\)/, '');
    const e = st.errors.get(key);
    if (e) e.count++;
    else if (st.errors.size < 50) st.errors.set(key, { timestamp, msg: String(msg), count: 1 });
  };

  const priceRows = [];
  const tradeRows = [];
  let lastFair = {};

  for (let t = 0; t < config.ticks; t++) {
    const timestamp = t * (config.tickStep ?? 100);
    const fair = world.step(t);
    lastFair = fair;
    // world: the price model (bots may read its state); shared: scratch space bots can use to coordinate within a tick
    const ctx = { t, timestamp, fair, rng: botRng, symbols, products: config.products, world, shared: {} };

    // 1. maker bots quote
    const resting = Object.fromEntries(symbols.map((s) => [s, []]));
    for (const bot of config.bots) {
      for (const o of normalize(bot.quote?.({ ...ctx, position: account(bot.name).pos }) ?? [], bot.name, symbols)) resting[o.symbol].push(o);
    }

    // 2. snapshot + algorithms
    const depths = Object.fromEntries(symbols.map((s) => [s, depthOf(resting[s])]));
    if (record) for (const s of symbols) priceRows.push(priceRow(day, timestamp, s, depths[s]));

    const replies = await Promise.all(agents.map((a) => {
      const st = agentState.get(a.name);
      return a.run({
        timestamp,
        traderData: st.traderData,
        listings: Object.fromEntries(symbols.map((s) => [s, { symbol: s, product: s, denomination: config.currency ?? 'SEASHELLS' }])),
        order_depths: depths,
        own_trades: st.ownTrades,
        market_trades: st.marketTrades,
        position: Object.fromEntries(symbols.filter((s) => account(a.name).pos[s]).map((s) => [s, account(a.name).pos[s]])),
        observations: world.observations?.(t) ?? {},
      });
    }));

    const playerOrders = Object.fromEntries(symbols.map((s) => [s, []]));
    agents.forEach((a, i) => {
      const st = agentState.get(a.name);
      const reply = replies[i] ?? {};
      if (typeof reply.traderData === 'string') st.traderData = reply.traderData.slice(0, 50000);
      if (reply.logs) st.logs.push(...[].concat(reply.logs).map((l) => `[${timestamp}] ${l}`));
      if (reply.error) addError(st, timestamp, reply.error);
      const orders = normalize(reply.orders ?? [], a.name, symbols, (msg) => addError(st, timestamp, msg));
      for (const s of symbols) {
        const mine = orders.filter((o) => o.symbol === s);
        if (!mine.length) continue;
        const pos = account(a.name).pos[s];
        const buys = mine.filter((o) => o.qty > 0).reduce((n, o) => n + o.qty, 0);
        const sells = mine.filter((o) => o.qty < 0).reduce((n, o) => n - o.qty, 0);
        if (pos + buys > limits[s] || pos - sells < -limits[s]) {
          st.rejected++;
          addError(st, timestamp, `${s}: orders rejected, they could take your position past the ±${limits[s]} limit (position ${pos})`);
          continue;
        }
        playerOrders[s].push(...mine);
      }
    });

    // 3–5. matching
    const trades = [];
    for (const s of symbols) {
      take(resting[s], playerOrders[s], matchRng, trades);
      const d = depths[s];
      auction(playerOrders[s], d.mid ?? fair[s], matchRng, trades);
      for (const o of playerOrders[s]) if (o.remaining > 0) resting[s].push(o);
    }
    for (const bot of config.bots) {
      if (!bot.take) continue;
      const book = Object.fromEntries(symbols.map((s) => [s, depthOf(resting[s])]));
      for (const o of normalize(bot.take({ ...ctx, book, position: account(bot.name).pos }) ?? [], bot.name, symbols)) {
        // a bot order may carry match(restingOrder) → boolean to choose which resting orders it can trade with
        const pool = typeof o.match === 'function' ? resting[o.symbol].filter(o.match) : resting[o.symbol];
        take(pool, [o], matchRng, trades);
      }
    }

    // 6. settle trades, tell algorithms next tick
    for (const st of agentState.values()) {
      st.ownTrades = emptyBySymbol(symbols);
      st.marketTrades = emptyBySymbol(symbols);
    }
    for (const tr of trades) {
      const b = account(tr.buyer);
      const s = account(tr.seller);
      b.pos[tr.symbol] += tr.qty;
      s.pos[tr.symbol] -= tr.qty;
      b.cash[tr.symbol] -= tr.qty * tr.price;
      s.cash[tr.symbol] += tr.qty * tr.price;
      b.volume[tr.symbol] += tr.qty;
      s.volume[tr.symbol] += tr.qty;
      const reveal = config.revealCounterparties;
      for (const [name, st] of agentState) {
        const own = tr.buyer === name || tr.seller === name;
        const view = {
          symbol: tr.symbol,
          price: tr.price,
          quantity: tr.qty,
          buyer: tr.buyer === name ? 'SUBMISSION' : reveal ? tr.buyer : '',
          seller: tr.seller === name ? 'SUBMISSION' : reveal ? tr.seller : '',
          timestamp,
        };
        (own ? st.ownTrades : st.marketTrades)[tr.symbol].push(view);
      }
      if (record) tradeRows.push({ timestamp, buyer: tr.buyer, seller: tr.seller, symbol: tr.symbol, price: tr.price, quantity: tr.qty, botBuyer: !agentNames.has(tr.buyer), botSeller: !agentNames.has(tr.seller) });
    }
    if (onProgress && t % 100 === 0) onProgress(t / config.ticks);
  }

  // mark to fair value (the model may supply its own end-of-day marks)
  const mark = world.mark?.() ?? lastFair;
  const results = {};
  for (const a of agents) {
    const acc = account(a.name);
    const st = agentState.get(a.name);
    const byProduct = {};
    let total = 0;
    for (const s of symbols) {
      const pnl = acc.cash[s] + acc.pos[s] * (mark[s] ?? 0);
      byProduct[s] = { pnl: round2(pnl), position: acc.pos[s], volume: acc.volume[s] };
      total += pnl;
    }
    const errors = [...st.errors.values()].map((e) => `[${e.timestamp}] ${e.msg}${e.count > 1 ? `\n    (happened ${e.count} times; first shown)` : ''}`);
    results[a.name] = { pnl: round2(total), byProduct, errors, logs: st.logs.slice(-200), rejected: st.rejected };
  }
  return { day, seed, results, fair: lastFair, mark, priceRows, tradeRows };
}

/** Validate orders from a bot or algorithm: integer price, non-zero integer quantity, known symbol. */
function normalize(orders, owner, symbols, warn, bot = !warn) {
  const out = [];
  for (const o of Array.isArray(orders) ? orders : []) {
    const symbol = o?.symbol;
    const price = Number(o?.price);
    const qty = Number(o?.quantity ?? o?.qty);
    if (!symbols.includes(symbol)) {
      warn?.(`unknown product ${JSON.stringify(symbol)}`);
      continue;
    }
    if (!Number.isInteger(price) || !Number.isInteger(qty) || qty === 0) {
      warn?.(`${symbol}: order needs an integer price and a non-zero integer quantity (got ${o?.price}, ${o?.quantity ?? o?.qty})`);
      continue;
    }
    out.push({ owner, symbol, price, qty, remaining: Math.abs(qty), agent: !bot, ...(bot && typeof o.match === 'function' ? { match: o.match } : {}) });
  }
  return out;
}

/** Aggregate resting orders into a Prosperity OrderDepth: buy_orders {price: vol}, sell_orders {price: -vol}. */
function depthOf(orders) {
  const buy = {};
  const sell = {};
  for (const o of orders) {
    if (o.remaining <= 0) continue;
    if (o.qty > 0) buy[o.price] = (buy[o.price] ?? 0) + o.remaining;
    else sell[o.price] = (sell[o.price] ?? 0) - o.remaining;
  }
  const bids = Object.keys(buy).map(Number).sort((a, b) => b - a);
  const asks = Object.keys(sell).map(Number).sort((a, b) => a - b);
  const mid = bids.length && asks.length ? (bids[0] + asks[0]) / 2 : null;
  return {
    buy_orders: Object.fromEntries(bids.map((p) => [p, buy[p]])),
    sell_orders: Object.fromEntries(asks.map((p) => [p, sell[p]])),
    mid,
  };
}

function priceRow(day, timestamp, symbol, depth) {
  // (object keys that look like integers enumerate in ascending order, so sort explicitly)
  const bids = Object.entries(depth.buy_orders).sort((a, b) => b[0] - a[0]).slice(0, 3);
  const asks = Object.entries(depth.sell_orders).sort((a, b) => a[0] - b[0]).slice(0, 3);
  const row = { day, timestamp, product: symbol };
  for (let i = 0; i < 3; i++) {
    row[`bid_price_${i + 1}`] = bids[i]?.[0] ?? '';
    row[`bid_volume_${i + 1}`] = bids[i]?.[1] ?? '';
  }
  for (let i = 0; i < 3; i++) {
    row[`ask_price_${i + 1}`] = asks[i]?.[0] ?? '';
    row[`ask_volume_${i + 1}`] = asks[i] ? -asks[i][1] : '';
  }
  row.mid_price = depth.mid ?? '';
  row.profit_and_loss = 0;
  return row;
}

const zero = (symbols) => Object.fromEntries(symbols.map((s) => [s, 0]));
const emptyBySymbol = (symbols) => Object.fromEntries(symbols.map((s) => [s, []]));
const round2 = (n) => Math.round(n * 100) / 100;

export const PRICE_COLUMNS = ['day', 'timestamp', 'product', 'bid_price_1', 'bid_volume_1', 'bid_price_2', 'bid_volume_2', 'bid_price_3', 'bid_volume_3', 'ask_price_1', 'ask_volume_1', 'ask_price_2', 'ask_volume_2', 'ask_price_3', 'ask_volume_3', 'mid_price', 'profit_and_loss'];

/** Prosperity-style semicolon CSV. */
export function toCsv(rows, columns) {
  return [columns.join(';'), ...rows.map((r) => columns.map((c) => r[c] ?? '').join(';'))].join('\n') + '\n';
}
