import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Exchange, ExchangeError } from '../exchange/exchange.js';

function setup(config) {
  const ex = new Exchange(config);
  const alice = ex.join({ name: 'alice' });
  const bob = ex.join({ name: 'bob' });
  const m = ex.createMarket({ name: 'X' });
  return { ex, alice, bob, m };
}

test('names are unique and tokens rejoin', () => {
  const { ex, alice } = setup();
  assert.throws(() => ex.join({ name: 'ALICE' }), ExchangeError);
  assert.equal(ex.join({ token: alice.token }), alice);
});

test('trade moves positions and cash; P&L is zero-sum', () => {
  const { ex, alice, bob, m } = setup();
  ex.placeOrder(alice.id, { marketId: m.id, side: 'buy', price: 40, qty: 5 });
  ex.placeOrder(bob.id, { marketId: m.id, side: 'sell', price: 40, qty: 3, tif: 'IOC' });
  assert.equal(alice.positions[m.id], 3);
  assert.equal(bob.positions[m.id], -3);
  assert.equal(ex.pnl(alice) + ex.pnl(bob), 0);

  ex.settleMarket(m.id, 100);
  assert.equal(ex.pnl(alice), 3 * 60);
  assert.equal(ex.pnl(bob), -3 * 60);
  assert.equal(ex.orders.size, 0, 'settlement cancels resting orders');
  assert.throws(() => ex.placeOrder(alice.id, { marketId: m.id, side: 'buy', price: 1, qty: 1 }), /settled/);
});

test('rejects off-grid prices and bad quantities', () => {
  const { ex, alice, m } = setup();
  const bad = [
    { price: 101, qty: 1 },
    { price: -1, qty: 1 },
    { price: 50.5, qty: 1 },
    { price: 50, qty: 0 },
    { price: 50, qty: 1.5 },
  ];
  for (const o of bad) assert.throws(() => ex.placeOrder(alice.id, { marketId: m.id, side: 'buy', ...o }), ExchangeError);
});

test('position limit counts resting orders', () => {
  const { ex, alice, m } = setup({ maxPosition: 10 });
  ex.placeOrder(alice.id, { marketId: m.id, side: 'buy', price: 40, qty: 8 });
  assert.throws(() => ex.placeOrder(alice.id, { marketId: m.id, side: 'buy', price: 41, qty: 3 }), /Position limit/);
  ex.placeOrder(alice.id, { marketId: m.id, side: 'sell', price: 60, qty: 10 }); // the other side is independent
});

test('halted markets reject orders but allow cancels', () => {
  const { ex, alice, m } = setup();
  const { order } = ex.placeOrder(alice.id, { marketId: m.id, side: 'buy', price: 40, qty: 1 });
  ex.setStatus(m.id, 'halted');
  assert.throws(() => ex.placeOrder(alice.id, { marketId: m.id, side: 'buy', price: 41, qty: 1 }), /halted/);
  ex.cancelOrder(alice.id, order.id);
  assert.equal(m.book.bids.length, 0);
});

test('users cannot cancel each other', () => {
  const { ex, alice, bob, m } = setup();
  const { order } = ex.placeOrder(alice.id, { marketId: m.id, side: 'buy', price: 40, qty: 1 });
  assert.throws(() => ex.cancelOrder(bob.id, order.id), ExchangeError);
});

test('mark is last trade clamped to the current bid/ask', () => {
  const { ex, alice, bob, m } = setup();
  ex.placeOrder(alice.id, { marketId: m.id, side: 'buy', price: 30, qty: 1 });
  ex.placeOrder(bob.id, { marketId: m.id, side: 'sell', price: 30, qty: 1 });
  assert.equal(ex.mark(m), 30);
  ex.placeOrder(alice.id, { marketId: m.id, side: 'buy', price: 45, qty: 1 });
  assert.equal(ex.mark(m), 45);
});

test('round-trips through JSON with resting orders intact', () => {
  const { ex, alice, bob, m } = setup();
  ex.placeOrder(alice.id, { marketId: m.id, side: 'buy', price: 40, qty: 5 });
  ex.placeOrder(bob.id, { marketId: m.id, side: 'sell', price: 40, qty: 2 });
  const copy = Exchange.fromJSON(JSON.parse(JSON.stringify(ex)));
  assert.deepEqual(copy.publicState(), ex.publicState());
  assert.deepEqual(copy.userState(alice.id), ex.userState(alice.id));
  // and keeps trading
  copy.placeOrder(bob.id, { marketId: m.id, side: 'sell', price: 40, qty: 3 });
  assert.equal(copy.users.get(alice.id).positions[m.id], 5);
  assert.equal(copy.orders.size, 0);
});
