import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Exchange, ExchangeError } from '../exchange/exchange.js';

function setup(config) {
  const ex = new Exchange(config);
  const alice = ex.join({ name: 'alice', password: 'pw-alice' }).user;
  const bob = ex.join({ name: 'bob', password: 'pw-bob' }).user;
  ex.startSession({ name: 'Night 1', gameId: 'test' });
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
  ex.startSession({ gameId: 'test' });
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

test('markets need a running session; empty sessions are not kept', () => {
  const ex = new Exchange();
  assert.throws(() => ex.createMarket({ name: 'X' }), /Start a session/);
  ex.startSession({ gameId: 'test' });
  ex.endSession();
  assert.equal(ex.sessions.size, 0);
});

test('deleting a market reverses its trades and settlement', () => {
  const { ex, alice, bob, m } = setup({ startingBankroll: 1000 });
  const other = ex.createMarket({ name: 'Y' });
  ex.placeOrder(alice.id, { marketId: m.id, side: 'buy', price: 40, qty: 5 });
  ex.placeOrder(bob.id, { marketId: m.id, side: 'sell', price: 40, qty: 5 });
  ex.placeOrder(alice.id, { marketId: other.id, side: 'buy', price: 30, qty: 1 });
  ex.placeOrder(bob.id, { marketId: other.id, side: 'sell', price: 30, qty: 1 });
  ex.settleMarket(m.id, 100);
  assert.equal(alice.cash, 1000 - 30 + 5 * 60);

  const { cancelledTrades } = ex.deleteMarket(m.id);
  assert.equal(cancelledTrades, 1);
  assert.equal(alice.cash, 1000 - 30, 'only the other market remains');
  assert.equal(bob.cash, 1000 + 30);
  assert.equal(ex.trades.length, 1);
  assert.equal(ex.userState(alice.id).positions.length, 1);
});

test('sessions: end, history, and per-session P&L', () => {
  const { ex, alice, bob, m } = setup({ startingBankroll: 1000 });
  const s1 = ex.activeSession();
  ex.placeOrder(alice.id, { marketId: m.id, side: 'buy', price: 40, qty: 2 });
  ex.placeOrder(bob.id, { marketId: m.id, side: 'sell', price: 40, qty: 2 });
  assert.throws(() => ex.endSession(), /still hold positions/);
  ex.settleMarket(m.id, 100);
  ex.createMarket({ name: 'never traded' });
  ex.endSession();
  assert.equal(ex.sessionMarkets(s1.id).length, 1, 'untraded markets are dropped');
  assert.equal(ex.publicState().markets.length, 0);

  ex.startSession({ name: 'Night 2', gameId: 'test' });
  const n2 = ex.createMarket({ name: 'Z' });
  ex.placeOrder(bob.id, { marketId: n2.id, side: 'buy', price: 10, qty: 1 });
  ex.placeOrder(alice.id, { marketId: n2.id, side: 'sell', price: 10, qty: 1 });

  const hist = ex.history(alice.id);
  assert.deepEqual(hist.sessions.map((s) => [s.name, s.status, s.pnl, s.trades.length]), [
    ['Night 2', 'active', 0, 1],
    ['Night 1', 'ended', 120, 1],
  ]);
  assert.equal(hist.sessions[1].leaderboard[0].name, 'alice');
  assert.equal(hist.cash, 1000 + 120 + 10);
  assert.equal(ex.userState(alice.id).sessionPnl, 0);
});

test('admin can set an open wager balance directly', () => {
  const { ex, alice } = setup();
  ex.addWager(alice.id, 5, 'G1');
  ex.setWagerBalance(alice.id, -2.5);
  assert.equal(ex.wagerBalance(alice), -2.5);
  assert.equal(ex.wagers.at(-1).amount, -7.5);
});

test('imports saves from before sessions existed', () => {
  const { ex, alice, bob, m } = setup();
  ex.placeOrder(alice.id, { marketId: m.id, side: 'buy', price: 40, qty: 1 });
  ex.placeOrder(bob.id, { marketId: m.id, side: 'sell', price: 40, qty: 1 });
  const old = JSON.parse(JSON.stringify(ex));
  delete old.sessions;
  delete old.activeSessionId;
  for (const mk of old.markets) delete mk.sessionId;
  for (const t of old.trades) delete t.sessionId;
  const copy = Exchange.fromJSON(old);
  assert.equal(copy.activeSession().name, 'Session 1');
  assert.equal(copy.publicState().markets.length, 1);
  assert.equal(copy.history(alice.id).sessions[0].trades.length, 1);
});

test('quiz points count toward total equity but not game-night chips or P&L', () => {
  const { ex, alice } = setup({ startingBankroll: 1000 });
  ex.setQuiz(alice.id, 1250);
  assert.equal(alice.cash, 1000);
  assert.equal(ex.gameEquity(alice), 1000);
  assert.equal(ex.equity(alice), 2250);
  assert.equal(ex.pnl(alice), 0);
  assert.equal(ex.available(alice), 1000, 'quiz points are not tradeable');
  assert.equal(ex.publicState().leaderboard[0].name, 'alice');
  assert.throws(() => ex.setQuiz(alice.id, 'x'), /number/);
});

test('past sessions with recorded results count as game P&L and show in history', () => {
  const ex = new Exchange({ startingBankroll: 1000 });
  const a = ex.join({ name: 'a', password: 'pass' }).user;
  const b = ex.join({ name: 'b', password: 'pass' }).user;
  ex.startSession({ name: 'Tonight', gameId: 'test' });
  const past = ex.createPastSession({ name: 'Game night Sep 25', date: '2026-09-25T19:00:00', gameTitle: 'Poker' });
  ex.recordResult(past.id, a.id, 157, "Texas Hold'em");
  ex.recordResult(past.id, a.id, -8, '09/25 game');
  ex.recordResult(past.id, b.id, -149, "Texas Hold'em");
  assert.equal(a.cash, 1149);
  assert.equal(ex.pnl(a), 149);
  const hist = ex.history(a.id);
  assert.deepEqual(hist.sessions.map((s) => s.name), ['Tonight', 'Game night Sep 25']);
  assert.equal(hist.sessions[1].pnl, 149);
  assert.equal(hist.sessions[1].results.length, 2);
  assert.deepEqual(hist.sessions[1].leaderboard.map((r) => [r.name, r.pnl]), [['a', 149], ['b', -149]]);
  const copy = Exchange.fromJSON(JSON.parse(JSON.stringify(ex)));
  assert.equal(copy.history(b.id).sessions[1].pnl, -149);
});
