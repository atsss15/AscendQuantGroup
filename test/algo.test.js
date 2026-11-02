import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { proRata, take, auction, makeRng } from '../algo/matching.js';
import { simulateDay } from '../algo/sim.js';
import { startAgent } from '../algo/runner.js';
import { AlgoService, zoned, zonedToUtc } from '../algo/service.js';
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

test('own fills name the counterparty (player name or bot id); market trades stay anonymous', async () => {
  // both quote at 1000, inside the bots' spread around ~1000: they meet in the auction; bots trade with what's left
  const buyer = `
from datamodel import Order
class Trader:
    def run(self, state):
        if state.own_trades.get("STABLE"):
            t = state.own_trades["STABLE"][0]
            print("cp", t.buyer, t.seller)
        if state.market_trades.get("STABLE"):
            t = state.market_trades["STABLE"][0]
            print("mkt", repr(t.buyer), repr(t.seller))
        return {"STABLE": [Order("STABLE", 1000, 3)]} if state.position.get("STABLE", 0) < 40 else {}, 0, ""
`;
  const seller = buyer.replace('Order("STABLE", 1000, 3)', 'Order("STABLE", 1000, -1)').replace('< 40', '> -40');
  const a = await startAgent({ name: 'id-a', code: buyer, timeLimitMs: 1000 });
  const b = await startAgent({ name: 'id-b', code: seller, timeLimitMs: 1000 });
  const res = await simulateDay({ config: { ...small, ticks: 100 }, day: 1, seed: 3, agents: [{ ...a, label: 'Alice' }, { ...b, label: 'Bob' }] });
  a.close();
  b.close();
  const fillsA = res.results['id-a'].fills;
  assert.ok(fillsA.some(([, , q, , cp]) => q > 0 && cp === 'Bob'), 'Alice sees Bob by name');
  assert.ok(fillsA.some(([, , , , cp]) => cp === 'MM' || cp === 'Noise'), 'and bots by their id');
  assert.ok(res.results['id-b'].fills.every(([, , , , cp]) => ['Alice', 'MM', 'Noise'].includes(cp)));
  assert.ok(res.results['id-a'].logs.some((l) => /cp SUBMISSION (Bob|MM)/.test(l)), 'TradingState.own_trades names the other side');
  const market = [...res.results['id-a'].logs, ...res.results['id-b'].logs].filter((l) => l.includes(' mkt '));
  assert.ok(market.length > 0 && market.every((l) => l.endsWith("mkt '' ''")), 'market trades are anonymous');
  assert.ok(res.bots.MM.volume > 0, 'bot books are reported for design checks');
});

test('features reach the algorithm every tick and are saved as observations.csv', async () => {
  const withWeather = {
    ...small,
    ticks: 20,
    model: {
      create(args) {
        const w = small.model.create(args);
        return { ...w, observations: (t) => ({ rainfall: t / 10, weather: t % 2 ? 'rain' : 'sunny' }) };
      },
    },
  };
  const code = `
class Trader:
    def run(self, state):
        o = state.observations.plainValueObservations
        print(o["rainfall"], o["weather"])
        return {}, 0, ""
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-obs-'));
  const svc = new AlgoService({ config: withWeather, dir });
  await svc.runDay({ practice: true });
  const csv = fs.readFileSync(svc.dataFile(0, 'observations'), 'utf8').trim().split('\n');
  assert.equal(csv[0], 'day;timestamp;rainfall;weather');
  assert.equal(csv[4], '0;300;0.3;rain');
  const bt = await svc.backtest('u1', code, 0);
  assert.equal(bt.logs[3], '[300] 0.3 rain');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('schedule: runs once a day at the set time (New York), from the start date', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-sched-'));
  const svc = new AlgoService({ config: { ...small, ticks: 20 }, dir });
  const at = (date, time) => zonedToUtc(date, time, 'America/New_York');
  assert.equal(new Date(at('2026-11-04', '12:00')).toISOString(), '2026-11-04T17:00:00.000Z', 'EST after the clocks change');
  assert.equal(new Date(at('2026-07-01', '12:00')).toISOString(), '2026-07-01T16:00:00.000Z', 'EDT in summer');
  assert.deepEqual(zoned(at('2026-11-04', '12:00'), 'America/New_York'), { date: '2026-11-04', time: '12:00' });

  assert.equal(svc.nextRunAt(), null, 'off by default');
  assert.equal(svc.checkSchedule(at('2026-11-04', '12:01')), null);
  svc.setSchedule({ enabled: true, time: '12:00', startDate: '2026-11-04' });
  assert.equal(svc.nextRunAt(at('2026-11-02', '09:00')), at('2026-11-04', '12:00'), 'waits for the start date');
  assert.equal(svc.checkSchedule(at('2026-11-03', '13:00')), null, 'not before the start date');
  assert.equal(svc.checkSchedule(at('2026-11-04', '11:59')), null, 'not before noon');

  svc.submit('u1', competition.template);
  await svc.checkSchedule(at('2026-11-04', '12:00'));
  assert.equal(svc.state.days.at(-1).day, 1, 'Day 1 ran at noon');
  assert.equal(svc.checkSchedule(at('2026-11-04', '18:00')), null, 'only once that day');
  assert.equal(svc.nextRunAt(at('2026-11-04', '12:05')), at('2026-11-05', '12:00'));
  await svc.checkSchedule(at('2026-11-05', '14:30'));
  assert.equal(svc.state.days.at(-1).day, 2, 'a server that was down at noon catches up the same day');
  assert.throws(() => svc.setSchedule({ time: '25:00' }), /12:00/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('new round: archives everything, keeps editors, generates fresh data days', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-round-'));
  const svc = new AlgoService({ config: { ...small, ticks: 20 }, dir });
  svc.saveDraft('u1', '# my work in progress');
  svc.submit('u1', competition.template);
  await svc.runDay();
  svc.setSchedule({ enabled: true, startDate: '2026-11-04' });
  const res = await svc.newRound({ dataDays: 2 });
  assert.deepEqual(res.dataDays, [-1, 0]);
  assert.equal(svc.state.round, 1, 'the first new round after setup is round 1');
  assert.equal(svc.state.nextDay, 1);
  assert.equal(svc.state.practiceMode, false);
  assert.deepEqual(svc.state.submissions, {}, 'old submissions are retired');
  assert.equal(svc.leaderboard((id) => id).length, 0);
  assert.equal(svc.draft('u1').code, competition.template, 'submitting replaced the draft; the editor keeps it');
  assert.equal(svc.state.schedule.startDate, '2026-11-04', 'the schedule carries over');
  const archived = JSON.parse(fs.readFileSync(path.join(res.archived, 'state.json'), 'utf8'));
  assert.equal(archived.days[0].day, 1);
  assert.ok(fs.existsSync(path.join(res.archived, 'days', '1', 'prices.csv')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('end to end over HTTP', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-http-'));
  const server = createExchangeServer(platform, { dataFile: null, adminPassword: 'admin-pw', quiet: true, handleSignals: false });
  attachAlgo(server, { config: small, dir, scheduler: false });
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
  assert.equal((await call('GET', '/days/1/observations.csv', jay.token)).status, 404, 'this design publishes no features');
  assert.equal((await call('POST', '/admin/schedule', jay.token, { enabled: true })).status, 403);
  const sched = await call('POST', '/admin/schedule', admin, { enabled: true, time: '12:00', startDate: '2030-01-02' });
  assert.equal(new Date(sched.body.nextRunAt).toISOString(), '2030-01-02T17:00:00.000Z');
  assert.equal((await call('GET', '/me', jay.token)).body.schedule.nextRunAt, sched.body.nextRunAt, 'players see when the next day runs');
});
