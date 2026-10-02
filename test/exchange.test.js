import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Exchange, ExchangeError } from '../exchange/exchange.js';

function setup(config) {
  const ex = new Exchange(config);
  const alice = ex.join({ name: 'alice', password: 'pw-alice' }).user;
  const bob = ex.join({ name: 'bob', password: 'pw-bob' }).user;
  const m = ex.createMarket({ name: 'X' });
  return { ex, alice, bob, m };
}

test('first sign-in sets the password; later sign-ins must match it', () => {
  const { ex, alice } = setup();
  assert.throws(() => ex.join({ name: 'ALICE', password: 'wrong' }), /Wrong password/);
  assert.equal(ex.join({ name: 'Alice', password: 'pw-alice' }).user, alice);
  assert.equal(ex.join({ token: alice.token }).user, alice);
  assert.throws(() => ex.join({ name: 'carol', password: 'abc' }), /at least 4/);
  assert.equal(ex.findUser('carol'), null, 'a rejected password does not create the account');
});

test('closed signup: only existing accounts, claimed on first sign-in', () => {
  const ex = new Exchange({ openSignup: false });
  ex.ensureAccount('Paul');
  assert.throws(() => ex.join({ name: 'Mallory', password: 'secret' }), /No account/);
  const { user, firstSignIn } = ex.join({ name: 'paul', password: 'hunter2' });
  assert.equal(user.name, 'Paul');
  assert.equal(firstSignIn, true);
  assert.throws(() => ex.join({ name: 'Paul', password: 'other' }), /Wrong password/);
});

test('password reset revokes the session and lets the account be claimed again', () => {
  const { ex, alice } = setup();
  const oldToken = alice.token;
  const signedOut = [];
  ex.on('signout', (id) => signedOut.push(id));
  ex.resetPassword(alice.id);
  assert.deepEqual(signedOut, [alice.id]);
  assert.throws(() => ex.join({ token: oldToken }), /sign in again/);
  assert.equal(ex.join({ name: 'alice', password: 'new-pass' }).firstSignIn, true);
});

test('bankroll: trades move cash, orders must be covered by the worst-case loss', () => {
  const ex = new Exchange({ startingBankroll: 100 });
  const a = ex.join({ name: 'a', password: 'pass' }).user;
  const b = ex.join({ name: 'b', password: 'pass' }).user;
  const m = ex.createMarket({ name: 'X' }); // 0-100

  ex.placeOrder(a.id, { marketId: m.id, side: 'buy', price: 40, qty: 2 }); // worst case -80
  assert.equal(ex.available(a), 20);
  assert.throws(() => ex.placeOrder(a.id, { marketId: m.id, side: 'buy', price: 30, qty: 1 }), /Not enough chips/);
  ex.placeOrder(a.id, { marketId: m.id, side: 'buy', price: 20, qty: 1 });

  // b sells 2 at 40: worst case is settling at 100, a loss of 60 each
  assert.throws(() => ex.placeOrder(b.id, { marketId: m.id, side: 'sell', price: 40, qty: 2 }), /Not enough chips/);
  ex.placeOrder(b.id, { marketId: m.id, side: 'sell', price: 40, qty: 1, tif: 'IOC' });
  assert.equal(a.cash, 60);
  assert.equal(b.cash, 140);

  ex.settleMarket(m.id, 100);
  assert.equal(a.cash, 160);
  assert.equal(b.cash, 40);
  assert.equal(ex.pnl(a), 60);
});

test('admin bankroll edits count as deposits, not P&L', () => {
  const ex = new Exchange({ startingBankroll: 1000 });
  const a = ex.join({ name: 'a', password: 'pass' }).user;
  ex.setBankroll(a.id, 1500);
  assert.equal(a.cash, 1500);
  assert.equal(ex.pnl(a), 0);
  assert.throws(() => ex.setBankroll(a.id, ''), /number/);
});

test('dollar wagers: per-account ledger, settled by marking paid', () => {
  const { ex, alice, bob } = setup();
  ex.addWager(alice.id, 5, 'beat bob G1');
  ex.addWager(bob.id, -5, 'lost to alice G1');
  const w = ex.addWager(alice.id, 2.5, 'typo');
  ex.deleteWager(w.id);
  assert.equal(ex.wagerBalance(alice), 5);
  assert.equal(ex.userState(bob.id).wagerBalance, -5);
  assert.throws(() => ex.addWager(alice.id, 'abc'), /dollar amount/);
  ex.markWagersPaid(alice.id);
  assert.equal(ex.wagerBalance(alice), 0);
  assert.equal(ex.userState(alice.id).wagers[0].paid, true);
  const copy = Exchange.fromJSON(JSON.parse(JSON.stringify(ex)));
  assert.equal(copy.wagerBalance(copy.getUser(bob.id)), -5);
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
