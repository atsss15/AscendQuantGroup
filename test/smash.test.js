import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { Exchange } from '../exchange/exchange.js';
import { createExchangeServer } from '../exchange/server.js';
import { smash } from '../games/smash/game.js';

const { createMatch, settleMatch } = smash.adminCommands;

test('createMatch lists one 0-100 contract per player', () => {
  const ex = new Exchange(smash.config);
  createMatch(ex, { name: 'Final', players: ['Mario', 'Link', 'Kirby'] });
  const markets = [...ex.markets.values()];
  assert.deepEqual(markets.map((m) => m.name), ['Mario', 'Link', 'Kirby']);
  assert.ok(markets.every((m) => m.group.name === 'Final' && m.min === 0 && m.max === 100));
  assert.equal(new Set(markets.map((m) => m.group.id)).size, 1);

  assert.throws(() => createMatch(ex, { players: ['Solo'] }), /at least 2/);
  assert.throws(() => createMatch(ex, { players: ['Fox', 'fox'] }), /different/);
});

test('settleMatch pays the winner 100 and everyone else 0', () => {
  const ex = new Exchange(smash.config);
  const a = ex.join({ name: 'a' });
  const b = ex.join({ name: 'b' });
  createMatch(ex, { players: 'Mario, Link' });
  const [mario, link] = ex.markets.values();
  ex.placeOrder(a.id, { marketId: mario.id, side: 'buy', price: 60, qty: 2 });
  ex.placeOrder(b.id, { marketId: mario.id, side: 'sell', price: 60, qty: 2 });
  ex.placeOrder(a.id, { marketId: link.id, side: 'sell', price: 45, qty: 1 });
  ex.placeOrder(b.id, { marketId: link.id, side: 'buy', price: 45, qty: 1 });

  settleMatch(ex, { matchId: mario.group.id, winner: 'Link' });
  assert.equal(mario.settlement, 0);
  assert.equal(link.settlement, 100);
  assert.equal(ex.pnl(a), -120 - 55); // bought Mario at 60 -> 0, sold Link at 45 -> 100
  assert.equal(ex.pnl(b), 120 + 55);
});

test('end to end over sockets', async (t) => {
  const server = createExchangeServer(smash, { dataFile: null, adminPassword: 'pw', quiet: true, handleSignals: false });
  const port = await server.listen(0);
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.close());
    await server.close();
  });

  const client = () => {
    const c = connect(`http://localhost:${port}`, { transports: ['websocket'] });
    clients.push(c);
    return c;
  };
  const ask = (c, event, payload) => c.timeout(2000).emitWithAck(event, payload);
  const next = (c, event, pred = () => true) =>
    new Promise((resolve) => {
      const fn = (data) => {
        if (pred(data)) {
          c.off(event, fn);
          resolve(data);
        }
      };
      c.on(event, fn);
    });

  const adminC = client();
  const alice = client();
  const bob = client();

  assert.equal((await ask(adminC, 'admin', { cmd: 'createMatch', args: { players: ['Mario', 'Link'] } })).ok, false);
  assert.equal((await ask(adminC, 'admin:login', { password: 'nope' })).ok, false);
  assert.equal((await ask(adminC, 'admin:login', { password: 'pw' })).ok, true);
  assert.equal((await ask(adminC, 'admin', { cmd: 'createMatch', args: { name: 'G1', players: ['Mario', 'Link'] } })).ok, true);

  const joined = await ask(alice, 'join', { name: 'alice' });
  assert.ok(joined.user.token);
  await ask(bob, 'join', { name: 'bob' });
  assert.equal((await ask(bob, 'join', { name: 'alice' })).ok, false);

  const state = await next(alice, 'state', (s) => s.markets.length === 2);
  const mario = state.markets[0];
  assert.equal((await ask(alice, 'order', { marketId: mario.id, side: 'buy', price: 55, qty: 4 })).order.status, 'open');
  const hit = await ask(bob, 'order', { marketId: mario.id, side: 'sell', price: 55, qty: 3, tif: 'IOC' });
  assert.equal(hit.filled, 3);

  const me = await next(alice, 'me', (m) => m.positions.some((p) => p.position === 3));
  assert.equal(me.orders[0].remaining, 1);
  const pub = await next(bob, 'state', (s) => s.trades.length === 1);
  assert.deepEqual(pub.markets[0].bids, [{ price: 55, qty: 1, orders: 1 }]);
  assert.equal(pub.trades[0].buyer, undefined, 'tape is anonymous');

  assert.equal((await ask(alice, 'admin', { cmd: 'settle', args: { marketId: mario.id, price: 0 } })).ok, false, 'players are not admins');
  await ask(adminC, 'admin', { cmd: 'settleMatch', args: { matchId: mario.group.id, winner: 'Mario' } });
  const final = await next(alice, 'state', (s) => s.markets.every((m) => m.status === 'settled'));
  assert.deepEqual(final.leaderboard, [
    { name: 'alice', pnl: 3 * 45 },
    { name: 'bob', pnl: -3 * 45 },
  ]);
});
