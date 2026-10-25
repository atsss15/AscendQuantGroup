import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { proRata, take, auction, makeRng } from '../algo/matching.js';
import { simulateDay } from '../algo/sim.js';
import { startAgent } from '../algo/runner.js';
import { AlgoService } from '../algo/service.js';
import { competition } from '../algo/competition.example.js'; // the public placeholder; the real design stays out of the repo
import { createExchangeServer } from '../exchange/server.js';
import { attachAlgo } from '../algo/server.js';
import { platform } from '../server.js';

const order = (owner, price, qty) => ({ owner, symbol: 'X', price, qty, remaining: Math.abs(qty) });
const small = { ...competition, ticks: 300 };

test('pro-rata splits by size and always adds up', () => {
  assert.deepEqual(proRata(10, [6, 4, 10]), [3, 2, 5]);
  assert.deepEqual(proRata(25, [6, 4, 10]), [6, 4, 10], 'never more than asked');
  const odd = proRata(7, [5, 5, 5]);
  assert.equal(odd.reduce((a, b) => a + b, 0), 7);
  assert.ok(odd.every((x) => x === 2 || x === 3));
});

test('takers share a resting level pro-rata; better-priced takers fill first', () => {
  const rng = makeRng(1);
  const trades = [];
  const resting = [order('bot', 100, -10), order('bot', 101, -10)];
  const a = order('A', 100, 10);
  const b = order('B', 100, 30);
  take(resting, [a, b], rng, trades);
  assert.equal(a.qty - a.remaining, 3, 'A gets 10 × 10/40, rounded');
  assert.equal(b.qty - b.remaining, 7);
  assert.ok(trades.every((t) => t.price === 100));

  const trades2 = [];
  const resting2 = [order('bot', 100, -10)];
  const eager = order('E', 105, 10);
  const meek = order('M', 100, 10);
  take(resting2, [meek, eager], rng, trades2);
  assert.equal(eager.remaining, 0, 'price priority among takers');
  assert.equal(meek.remaining, 10);
  assert.equal(trades2[0].price, 100, 'trades at the resting price');
});

test('players crossing each other clear in one batch auction', () => {
  const trades = [];
  const buy = order('A', 102, 5);
  const sell1 = order('B', 99, -3);
  const sell2 = order('C', 101, -4);
  const price = auction([buy, sell1, sell2], 100, makeRng(2), trades);
  assert.equal(trades.reduce((s, t) => s + t.qty, 0), 5);
  assert.ok(trades.every((t) => t.price === price));
  assert.ok(price >= 99 && price <= 102);
  assert.equal(sell1.remaining, 0, 'cheaper seller fills first');
});

test('a backtest replays the same prices and bot quotes as the real day', async () => {
  const a = await simulateDay({ config: small, day: 1, seed: 99, agents: [] });
  const agent = await startAgent({ name: 'p', code: competition.template, timeLimitMs: 1000 });
  const b = await simulateDay({ config: small, day: 1, seed: 99, agents: [agent] });
  agent.close();
  assert.deepEqual(b.priceRows, a.priceRows, 'books the algorithms see are identical');
  assert.deepEqual(b.fair, a.fair);
  assert.ok(b.results.p.byProduct.STABLE.volume > 0, 'the template traded');
});

test('orders that could breach a position limit are rejected for that product', async () => {
  const greedy = `
from datamodel import Order
class Trader:
    def run(self, state):
        return {"STABLE": [Order("STABLE", 2000, 60)], "ASCEND": [Order("ASCEND", 20000, 1)]}, 0, ""
`;
  const agent = await startAgent({ name: 'g', code: greedy, timeLimitMs: 1000 });
  const res = await simulateDay({ config: { ...small, ticks: 50 }, day: 1, seed: 5, agents: [agent] });
  agent.close();
  const r = res.results.g;
  assert.equal(r.byProduct.STABLE.position, 0, 'buying 60 with a limit of 50 is rejected');
  assert.ok(r.byProduct.ASCEND.position > 0, 'other products still trade');
  assert.match(r.errors[0], /limit/);
});

test('service: practice data, submissions, a competition day, leaderboard, backtest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-test-'));
  const svc = new AlgoService({ config: small, dir });
  svc.setPracticeMode(false);
  const practice = await svc.runDay({ practice: true });
  assert.equal(practice.day, 0);
  assert.ok(fs.readFileSync(svc.dataFile(0, 'prices'), 'utf8').startsWith('day;timestamp;product;bid_price_1'));

  svc.submit('u1', competition.template);
  svc.submit('u2', 'class Trader:\n    def run(self, state):\n        return {}, 0, ""\n');
  const day1 = await svc.runDay();
  assert.equal(day1.day, 1);
  assert.equal(svc.state.nextDay, 2);
  assert.deepEqual(Object.keys(day1.results).sort(), ['u1', 'u2']);
  assert.equal(day1.results.u2.pnl, 0, 'no orders, no P&L');
  assert.ok(fs.readFileSync(svc.dataFile(1, 'own', 'u1'), 'utf8').includes('SUBMISSION'));
  assert.ok(!fs.readFileSync(svc.dataFile(1, 'trades'), 'utf8').includes('u1'), 'public trades are anonymous');

  const board = svc.leaderboard((id) => id.toUpperCase());
  assert.deepEqual(board.map((r) => r.name).sort(), ['U1', 'U2']);

  const bt = await svc.backtest('u1', competition.template, 1);
  assert.equal(bt.day, 1);
  assert.equal(typeof bt.pnl, 'number');

  svc.deleteDay(1);
  assert.equal(svc.state.nextDay, 1, 'deleting the latest day lets it run again');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('practice week: days run and show standings but stay out of the leaderboard', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-practice-'));
  const svc = new AlgoService({ config: { ...small, ticks: 100 }, dir });
  assert.equal(svc.state.practiceMode, true, 'practice week is on by default');
  svc.submit('u1', competition.template);
  const d1 = await svc.runDay();
  assert.equal(d1.counts, false);
  assert.deepEqual(svc.leaderboard((id) => id), []);
  assert.equal(svc.latestDay((id) => id).results[0].name, 'u1');
  svc.setPracticeMode(false);
  const d2 = await svc.runDay();
  assert.equal(d2.counts, true);
  assert.equal(svc.leaderboard((id) => id)[0].total, d2.results.u1.pnl, 'only the counted day adds up');
  svc.setDayCounts(1, true);
  assert.equal(svc.leaderboard((id) => id)[0].total, Math.round((d1.results.u1.pnl + d2.results.u1.pnl) * 100) / 100);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('end to end over HTTP', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-http-'));
  const server = createExchangeServer(platform, { dataFile: null, adminPassword: 'admin-pw', quiet: true, handleSignals: false });
  attachAlgo(server, { config: small, dir });
  const port = await server.listen(0);
  t.after(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://localhost:${port}/algo/api`;
  const call = async (method, url, token, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token ?? ''}` }, body: body && JSON.stringify(body) });
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  };

  assert.equal((await fetch(`http://localhost:${port}/algo`)).status, 200);
  assert.equal((await call('GET', '/me')).status, 401);
  const jay = (await call('POST', '/login', null, { name: 'Jay', password: 'jay-pass' })).body;
  assert.ok(jay.token);
  const admin = (await call('POST', '/login', null, { name: 'Attis', password: 'admin-pw' })).body.token;
  assert.equal((await call('GET', '/admin', jay.token)).status, 403);

  const me = (await call('GET', '/me', jay.token)).body;
  assert.equal(me.nextDay, 1);
  assert.match(me.draft.code, /class Trader/);
  assert.equal((await call('PUT', '/draft', jay.token, { code: '# wip' })).status, 200);
  assert.equal((await call('GET', '/me', jay.token)).body.draft.code, '# wip');
  assert.equal((await call('POST', '/submit', jay.token, { code: competition.template })).status, 200);

  assert.equal((await call('POST', '/admin/run', admin, { practice: false })).status, 200);
  let view;
  for (let i = 0; i < 100; i++) {
    view = (await call('GET', '/admin', admin)).body;
    if (!view.running && view.days.length) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(view.days[0].day, 1);
  assert.equal(view.days[0].results[0].name, 'Jay');

  const after = (await call('GET', '/me', jay.token)).body;
  assert.equal(after.practiceMode, true);
  assert.equal(after.leaderboard.length, 0, 'practice week: nothing counts');
  assert.equal(after.latestDay.results[0].name, 'Jay');
  assert.equal((await call('POST', '/admin/practice-mode', admin, { on: false })).status, 200);
  assert.equal((await call('POST', '/admin/days/1/counts', admin, { counts: true })).status, 200);
  assert.equal((await call('GET', '/me', jay.token)).body.leaderboard[0].name, 'Jay');
  const csv = await call('GET', `/days/1/own.csv`, jay.token);
  assert.equal(csv.status, 200);
  assert.match(csv.body, /^timestamp;buyer;seller;symbol;currency;price;quantity/);
  const bt = await call('POST', '/backtest', jay.token, { code: competition.template, day: 1 });
  assert.equal(bt.status, 200);
  assert.equal(typeof bt.body.pnl, 'number');
  assert.equal((await call('POST', '/backtest', jay.token, { code: 'class Trader: pass', day: 7 })).status, 400);
});
