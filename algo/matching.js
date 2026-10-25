/**
 * Batch matching for a tick-based simulation. Everything that arrives in the same step is simultaneous,
 * so there is no time priority: orders are ranked by price, and orders at the same price share
 * fills pro-rata to their size.
 *
 * Orders: { owner, symbol, price, qty }  qty > 0 buys, qty < 0 sells. `remaining` is tracked as a positive number.
 * Trades: { symbol, price, qty, buyer, seller }
 */

/**
 * Split `amount` (an integer) across `weights` in proportion, using largest remainders.
 * Ties on the remainder go to the order given by `tiebreak` (an array of indexes), so results are
 * deterministic for a given random seed.
 */
export function proRata(amount, weights, tiebreak) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || amount === 0) return weights.map(() => 0);
  if (amount >= total) return [...weights];
  const exact = weights.map((w) => (amount * w) / total);
  const alloc = exact.map(Math.floor);
  let left = amount - alloc.reduce((a, b) => a + b, 0);
  const order = (tiebreak ?? weights.map((_, i) => i))
    .slice()
    .sort((a, b) => exact[b] - alloc[b] - (exact[a] - alloc[a]));
  for (const i of order) {
    if (left === 0) break;
    if (alloc[i] < weights[i]) {
      alloc[i]++;
      left--;
    }
  }
  return alloc;
}

/** Group orders by price; best price first for the given side ('buy': high first, 'sell': low first). */
function levels(orders, side) {
  const map = new Map();
  for (const o of orders) {
    if (o.remaining <= 0) continue;
    if (!map.has(o.price)) map.set(o.price, []);
    map.get(o.price).push(o);
  }
  return [...map.entries()].sort(([a], [b]) => (side === 'buy' ? b - a : a - b));
}

/** Turn per-order fills on both sides of one price into trade records (pairs them up in order). */
function pairFills(symbol, price, buys, buyFills, sells, sellFills, trades) {
  let i = 0;
  let j = 0;
  let bLeft = buyFills[0] ?? 0;
  let sLeft = sellFills[0] ?? 0;
  while (i < buys.length && j < sells.length) {
    if (bLeft === 0) {
      bLeft = buyFills[++i] ?? 0;
      continue;
    }
    if (sLeft === 0) {
      sLeft = sellFills[++j] ?? 0;
      continue;
    }
    const q = Math.min(bLeft, sLeft);
    const buy = buys[i];
    const sell = sells[j];
    trades.push({ symbol, price, qty: q, buyer: buy.owner, seller: sell.owner });
    buy.remaining -= q;
    sell.remaining -= q;
    bLeft -= q;
    sLeft -= q;
  }
}

/**
 * Incoming orders take liquidity from resting orders. Trades happen at the resting price.
 * Resting levels are consumed best first; at each level, the incoming orders willing to trade there
 * are served by price (most aggressive first) and pro-rata within the same limit price; the resting
 * orders at that level are filled pro-rata to their size.
 */
export function take(resting, incoming, rng, trades) {
  const symbol = resting[0]?.symbol ?? incoming[0]?.symbol;
  for (const side of ['buy', 'sell']) {
    const aggressors = incoming.filter((o) => (side === 'buy' ? o.qty > 0 : o.qty < 0));
    if (!aggressors.length) continue;
    const passiveSide = side === 'buy' ? 'sell' : 'buy';
    const passive = resting.filter((o) => (passiveSide === 'buy' ? o.qty > 0 : o.qty < 0));
    for (const [price, makers] of levels(passive, passiveSide)) {
      const eligible = aggressors.filter((o) => o.remaining > 0 && (side === 'buy' ? o.price >= price : o.price <= price));
      if (!eligible.length) break;
      let supply = makers.reduce((s, o) => s + o.remaining, 0);
      // price priority among aggressors, pro-rata within a limit price
      const takerFills = new Map();
      for (const [, group] of levels(eligible, side)) {
        if (supply === 0) break;
        const want = group.reduce((s, o) => s + o.remaining, 0);
        const amount = Math.min(want, supply);
        const fills = proRata(amount, group.map((o) => o.remaining), shuffledIndexes(group.length, rng));
        group.forEach((o, k) => takerFills.set(o, fills[k]));
        supply -= amount;
      }
      const filledTakers = [...takerFills.keys()].filter((o) => takerFills.get(o) > 0);
      const total = filledTakers.reduce((s, o) => s + takerFills.get(o), 0);
      if (!total) continue;
      const makerFills = proRata(total, makers.map((o) => o.remaining), shuffledIndexes(makers.length, rng));
      const tf = filledTakers.map((o) => takerFills.get(o));
      if (side === 'buy') pairFills(symbol, price, filledTakers, tf, makers, makerFills, trades);
      else pairFills(symbol, price, makers, makerFills, filledTakers, tf, trades);
    }
  }
}

/**
 * Uniform-price call auction among simultaneous orders that cross each other.
 * Price: the one that maximizes volume; ties go to the smallest imbalance, then closest to `reference`.
 * Allocation: price priority, pro-rata among orders at the marginal price.
 */
export function auction(orders, reference, rng, trades) {
  const buys = orders.filter((o) => o.qty > 0 && o.remaining > 0);
  const sells = orders.filter((o) => o.qty < 0 && o.remaining > 0);
  if (!buys.length || !sells.length) return null;
  const bestBid = Math.max(...buys.map((o) => o.price));
  const bestAsk = Math.min(...sells.map((o) => o.price));
  if (bestBid < bestAsk) return null;

  const candidates = [...new Set([...buys, ...sells].map((o) => o.price))].filter((p) => p >= bestAsk && p <= bestBid);
  let best = null;
  for (const p of candidates) {
    const demand = buys.filter((o) => o.price >= p).reduce((s, o) => s + o.remaining, 0);
    const supply = sells.filter((o) => o.price <= p).reduce((s, o) => s + o.remaining, 0);
    const volume = Math.min(demand, supply);
    const key = [volume, -Math.abs(demand - supply), -Math.abs(p - (reference ?? p)), -p];
    if (!best || compare(key, best.key) > 0) best = { p, volume, key };
  }
  if (!best?.volume) return null;
  const { p, volume } = best;

  const allocate = (side, list) => {
    const fills = new Map();
    let left = volume;
    for (const [, group] of levels(list.filter((o) => (side === 'buy' ? o.price >= p : o.price <= p)), side)) {
      if (left === 0) break;
      const want = group.reduce((s, o) => s + o.remaining, 0);
      const amount = Math.min(want, left);
      const f = proRata(amount, group.map((o) => o.remaining), shuffledIndexes(group.length, rng));
      group.forEach((o, k) => f[k] && fills.set(o, f[k]));
      left -= amount;
    }
    return fills;
  };
  const bf = allocate('buy', buys);
  const sf = allocate('sell', sells);
  const symbol = buys[0].symbol;
  pairFills(symbol, p, [...bf.keys()], [...bf.values()], [...sf.keys()], [...sf.values()], trades);
  return p;
}

function compare(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function shuffledIndexes(n, rng) {
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

/** Deterministic PRNG (mulberry32). */
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
