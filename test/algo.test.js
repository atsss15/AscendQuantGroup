import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queue, take, auction, makeRng } from '../algo/matching.js';
import { simulateDay } from '../algo/sim.js';
import { startAgent } from '../algo/runner.js';
import { AlgoService, zoned, zonedToUtc } from '../algo/service.js';
import { competition } from '../algo/competition.example.js'; // the public placeholder; the real design stays out of the repo
import { createExchangeServer } from '../exchange/server.js';
import { attachAlgo } from '../algo/server.js';
import { platform } from '../server.js';

const order = (owner, price, qty) => ({ owner, symbol: 'X', price, qty, remaining: Math.abs(qty) });
const small = { ...competition, ticks: 300 };

test('queue: lower priority first, ties in a seeded random order', () => {
  const orders = [{ id: 'c', priority: 30 }, { id: 'a', priority: 0 }, { id: 'b', priority: 10 }];
  assert.deepEqual(queue(orders, makeRng(1)).map((o) => o.id), ['a', 'b', 'c']);
  const ties = [{ id: 'x', priority: 5 }, { id: 'y', priority: 5 }, { id: 'z', priority: 5 }];
  assert.deepEqual(queue(ties, makeRng(7)).map((o) => o.id), queue(ties, makeRng(7)).map((o) => o.id), 'same seed, same order');
});

test('same price: bot quotes fill first, then faster algorithms; better prices beat speed', () => {
  const rng = makeRng(1);
  const trades = [];
  const bot = { ...order('bot', 100, -10), priority: 0 };
  const fast = { ...order('F', 100, -10), priority: 50 };
  const slow = { ...order('S', 100, -10), priority: 900 };
  take([slow, fast, bot], [order('T', 100, 15)], rng, trades);
  assert.equal(bot.remaining, 0, 'the bot quoted first');
  assert.equal(fast.remaining, 5, 'then the faster algorithm');
  assert.equal(slow.remaining, 10, 'the slowest gets nothing');
  assert.ok(trades.every((t) => t.price === 100));

  const trades2 = [];
  const resting = [{ ...order('bot', 100, -10), priority: 0 }];
  const quick = { ...order('Q', 100, 10), priority: 5 };
  const lazy = { ...order('L', 100, 10), priority: 500 };
  const eager = { ...order('E', 105, 4), priority: 9000 };
  take(resting, [lazy, quick, eager], rng, trades2);
  assert.equal(eager.remaining, 0, 'a better limit price goes first, however slow');
  assert.equal(quick.remaining, 4, 'then the faster of the two at the same limit');
  assert.equal(lazy.remaining, 10);
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

  const trades2 = [];
  const fast = { ...order('F', 100, -3), priority: 10 };
  const slow = { ...order('S', 100, -3), priority: 99 };
  auction([{ ...order('B', 100, 4), priority: 1 }, slow, fast], 100, makeRng(3), trades2);
  assert.equal(fast.remaining, 0, 'at the same price the faster seller fills first');
  assert.equal(slow.remaining, 2);
});

test('a slow Trader.run loses the queue to a fast one at the same price', { timeout: 30000 }, async () => {
  const quote = (busy) => `
from datamodel import Order
class Trader:
    def run(self, state):
        ${busy ? 'x = sum(i * i for i in range(60000))' : 'pass'}
        d = state.order_depths["STABLE"]
        bid = max(d.buy_orders) + 1
        if state.position.get("STABLE", 0) > 30:
            return {}, 0, ""
        return {"STABLE": [Order("STABLE", bid, 8)]}, 0, ""
`;
  const fast = await startAgent({ name: 'fast', code: quote(false), timeLimitMs: 2000 });
  const slow = await startAgent({ name: 'slow', code: quote(true), timeLimitMs: 2000 });
  const res = await simulateDay({ config: { ...small, ticks: 150 }, day: 1, seed: 11, agents: [fast, slow] });
  fast.close();
  slow.close();
  const f = res.results.fast;
  const s = res.results.slow;
  assert.ok(f.speed.avgMs < s.speed.avgMs, 'speeds are measured');
  assert.ok(f.byProduct.STABLE.volume > 0, 'the fast one is filled');
  assert.ok(s.byProduct.STABLE.volume < f.byProduct.STABLE.volume / 3, 'the slow one only gets what the fast one could not take');
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
  const lines = svc.leaderboardLines((id) => id);
  assert.deepEqual(lines.days, [{ day: 1, points: Math.min(1000, small.ticks) }]);
  const u1 = lines.players.find((p) => p.userId === 'u1').pts;
  assert.equal(u1.length, lines.days[0].points);
  assert.equal(u1.at(-1), day1.results.u1.pnl, 'the line ends at the official P&L');
  assert.ok(u1.some((v) => v !== 0 && v !== u1.at(-1)), 'and moves through the day');
  assert.ok(lines.players.find((p) => p.userId === 'u2').pts.every((v) => v === 0));

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

test('days re-run without the chosen players: exact replay of the queue, P&L only, no files, paused by a day run', { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-without-'));
  const svc = new AlgoService({ config: { ...small, ticks: 400 }, dir });
  svc.setPracticeMode(false);
  const noop = 'class Trader:\n    def run(self, state):\n        return {}, 0, ""\n';
  svc.submit('u1', competition.template);
  svc.submit('u2', competition.template); // same code as u1: their places in the queue come down to CPU time
  svc.submit('u3', noop);
  svc.submit('u4', competition.template);
  await svc.runDay();
  const files = () => fs.readdirSync(svc.dayDir(1), { recursive: true }).sort();
  const before = files();
  assert.ok(before.includes('calls.json'), 'the real day records each call');
  assert.throws(() => svc.dataFile(1, 'calls'), /Unknown file/, 'and never serves it');

  assert.throws(() => svc.setWithoutPlayers(['nobody']), /up to 10 players/);
  svc.setWithoutPlayers(['u3']);
  await svc.fillWithout();
  const d1 = svc.getDay(1);
  const pnl = (results, ids) => Object.fromEntries(ids.map((id) => [id, { pnl: results[id].pnl }]));
  assert.deepEqual(d1.without, { players: ['u3'], ranAt: d1.without.ranAt, results: pnl(d1.results, ['u1', 'u2', 'u4']) },
    'leaving out a player who never trades changes nothing: the re-run replays the real queue');
  assert.deepEqual(files(), before, 're-runs write no data files, trades or logs');

  // all the chosen players are left out together; a day run pauses a re-run in progress, which resumes after it
  svc.setWithoutPlayers(['u3', 'u1']);
  while (!(svc.extra?.progress > 0)) await new Promise((r) => setTimeout(r, 5));
  delete svc.state.submissions.u3; // (u3 sits Day 2 out)
  let paused = false;
  const day2 = svc.runDay();
  while (svc.running) {
    if (!svc.extra) paused = true;
    await new Promise((r) => setTimeout(r, 5));
  }
  await day2;
  assert.ok(paused, 'the re-run stopped while the day ran');
  await svc.fillWithout();
  assert.deepEqual(svc.withoutQueue(), []);
  assert.equal(svc.withoutError, null);
  const d2 = svc.getDay(2);
  assert.deepEqual(d1.without.players, ['u1', 'u3']);
  assert.deepEqual(Object.keys(d1.without.results).sort(), ['u2', 'u4']);
  assert.deepEqual(Object.keys(d2.without.results).sort(), ['u2', 'u4'], 'Day 2 without u1 (u3 sat it out)');
  assert.ok(Object.values(d1.without.results).every((r) => Object.keys(r).join() === 'pnl'), 'only the P&L is kept');

  const boards = svc.withoutBoards((id) => id.toUpperCase());
  assert.equal(boards.length, 1, 'one board, without them all');
  assert.deepEqual(boards[0].players.map((p) => p.name), ['U1', 'U3']);
  assert.deepEqual(boards[0].days, [1, 2]);
  assert.deepEqual(boards[0].board.map((r) => r.userId).sort(), ['u2', 'u4']);
  const u2 = boards[0].board.find((r) => r.userId === 'u2');
  assert.equal(u2.actual, Math.round((d1.results.u2.pnl + d2.results.u2.pnl) * 100) / 100);
  assert.equal(u2.total, Math.round((d1.without.results.u2.pnl + d2.without.results.u2.pnl) * 100) / 100);
  assert.deepEqual(svc.playerView('u2', (id) => id.toUpperCase()).without, boards);

  // none of them played that day: the day as it was
  svc.setWithoutPlayers(['u3']);
  await svc.fillWithout();
  assert.deepEqual(d2.without.results, pnl(d2.results, ['u1', 'u2', 'u4']));

  // a day from before calls were recorded first gets a re-run with everyone, and is compared with that
  fs.rmSync(path.join(svc.dayDir(1), 'calls.json'));
  delete d1.without;
  assert.deepEqual(svc.withoutQueue().map((j) => [j.d.day, j.out]), [[1, null], [1, ['u3']]]);
  await svc.fillWithout();
  assert.ok(d1.baseline && fs.existsSync(path.join(svc.dayDir(1), 'calls.json')));
  assert.deepEqual(d1.without.results, pnl(d1.baseline.results, ['u1', 'u2', 'u4']), 'the replay of the re-run with everyone is exact too');
  const again = svc.withoutBoards((id) => id)[0].board.find((r) => r.userId === 'u2');
  assert.equal(again.actual, Math.round((d1.baseline.results.u2.pnl + d2.results.u2.pnl) * 100) / 100);

  svc.setWithoutPlayers([]);
  assert.deepEqual(svc.withoutBoards((id) => id), [], 'nobody chosen: no board');
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

  // Wednesdays to Fridays only (2026-11-06 is a Friday)
  svc.setSchedule({ weekdays: [3, 4, 5] });
  assert.equal(svc.nextRunAt(at('2026-11-06', '09:00')), at('2026-11-06', '12:00'), 'Friday still runs');
  assert.equal(svc.nextRunAt(at('2026-11-06', '12:05')), at('2026-11-11', '12:00'), 'then not until Wednesday');
  assert.equal(svc.checkSchedule(at('2026-11-07', '12:00')), null, 'no run on Saturday');
  assert.equal(svc.checkSchedule(at('2026-11-10', '12:00')), null, 'or Tuesday');
  await svc.checkSchedule(at('2026-11-11', '12:00'));
  assert.equal(svc.state.days.at(-1).day, 3, 'Wednesday runs the next day');
  assert.deepEqual(svc.scheduleView(at('2026-11-11', '13:00')).weekdays, [3, 4, 5]);
  assert.throws(() => svc.setSchedule({ weekdays: [] }), /day of the week/);
  svc.setSchedule({ weekdays: [0, 1, 2, 3, 4, 5, 6] });
  assert.equal(svc.scheduleView().weekdays, null, 'all seven: every day');
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
  assert.deepEqual(res.dataDays, [-1, 0], 'data days lead up to Day 0');
  assert.equal(svc.state.round, 1, 'the first new round after setup is round 1');
  assert.equal(svc.state.nextDay, 1, 'the first real day is Day 1');
  assert.equal(svc.state.practiceMode, false);
  assert.deepEqual(svc.state.submissions, {}, 'old submissions are retired');
  assert.equal(svc.leaderboard((id) => id).length, 0);
  assert.equal(svc.draft('u1').code, competition.template, 'submitting replaced the draft; the editor keeps it');
  assert.equal(svc.state.schedule.startDate, '2026-11-04', 'the schedule carries over');
  const archived = JSON.parse(fs.readFileSync(path.join(res.archived, 'state.json'), 'utf8'));
  assert.equal(archived.days[0].day, 1);
  assert.ok(fs.existsSync(path.join(res.archived, 'days', '1', 'prices.csv')));

  const redo = await svc.newRound({ dataDays: 3 });
  assert.equal(svc.state.round, 1, 'a round that never ran a day is redone under the same number');
  assert.deepEqual(redo.dataDays, [-2, -1, 0]);
  const file = await svc.dataZip();
  assert.match(path.basename(file), /^round_1_\w+\.zip$/);
  const raw = fs.readFileSync(file).toString('latin1');
  assert.ok(raw.includes('round_1/prices_round_1_day_-2.csv') && raw.includes('round_1/datamodel.py'), 'files are named by round and day');
  assert.equal(await svc.dataZip(), file, 'cached until the days change');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('days continue one another: each opens where the last closed, and backtests replay from that start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-carry-'));
  const svc = new AlgoService({ config: { ...small, ticks: 200 }, dir });
  await svc.newRound({ dataDays: 2 }); // Days -1 and 0
  const extra = await svc.runDay({ practice: true });
  assert.equal(extra.day, 1, 'an added data day continues the series from the latest day');
  assert.equal(svc.state.nextDay, 2, 'and the first real day moves after it');
  svc.submit('u1', competition.template);
  const first = await svc.runDay();
  assert.equal(first.day, 2);
  const mids = (day) => fs.readFileSync(svc.dataFile(day, 'prices'), 'utf8').trim().split('\n').slice(1)
    .map((l) => l.split(';')).filter((r) => r[2] === 'ASCEND').map((r) => Number(r[15]));
  for (const day of [0, 1, 2]) {
    assert.deepEqual(svc.worldState(day).in, svc.worldState(day - 1).out, `day ${day} starts where day ${day - 1} ended`);
    assert.ok(Math.abs(mids(day)[0] - mids(day - 1).at(-1)) < 40, `day ${day} opens near the previous close`);
  }
  assert.equal(svc.worldState(-1).in, null, "the round's first day starts fresh");
  await assert.rejects(svc.runDay({ practice: true }), /before the first real day/, 'no data days after real ones');
  const bt = await svc.backtest('u1', competition.template, 2);
  assert.equal(bt.pnl, first.results.u1.pnl, 'a backtest of a real day replays it exactly (same start, same seed)');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('admin can put the template back in every editor; the old code is archived first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-editors-'));
  const svc = new AlgoService({ config: small, dir });
  svc.saveDraft('u1', '# my old strategy');
  assert.deepEqual(svc.resetDrafts(), { reset: 1 });
  assert.equal(svc.draft('u1').code, small.template);
  const archived = fs.readdirSync(path.join(dir, 'archive')).filter((f) => f.startsWith('editors-'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'archive', archived[0]), 'utf8')).u1.code, '# my old strategy');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hosting cost: estimate from the machine size and list prices on Fly; nothing off Fly', async () => {
  const { hostingInfo, PRICES } = await import('../deploy/hosting.js');
  const saved = { app: process.env.FLY_APP_NAME, mem: process.env.FLY_VM_MEMORY_MB, token: process.env.FLY_API_TOKEN };
  delete process.env.FLY_APP_NAME;
  assert.equal((await hostingInfo()).onFly, false);
  Object.assign(process.env, { FLY_APP_NAME: 'test-app', FLY_VM_MEMORY_MB: '1024' });
  delete process.env.FLY_API_TOKEN;
  const mid = Date.UTC(2026, 10, 16); // halfway through November
  const x = await hostingInfo({ now: mid, dataDir: os.tmpdir() });
  const cpus = os.cpus().length;
  const machine = cpus * PRICES.sharedCpuMonth + Math.max(0, 1 - 0.25 * cpus) * PRICES.extraRamGbMonth;
  assert.equal(x.machines[0].perMonth, Math.round(machine * 100) / 100);
  assert.ok(Math.abs(x.estimate.monthToDate - x.estimate.perMonth / 2) < 0.02, 'half the month, half the cost');
  assert.equal(x.detailed, false);
  for (const [k, v] of [['FLY_APP_NAME', saved.app], ['FLY_VM_MEMORY_MB', saved.mem], ['FLY_API_TOKEN', saved.token]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
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
  assert.equal((await call('POST', '/admin/without', jay.token, { players: [] })).status, 403);
  assert.equal((await call('POST', '/admin/without', admin, { players: ['nobody'] })).status, 400);
  assert.deepEqual((await call('POST', '/admin/without', admin, { players: [] })).body, { players: [] });
  assert.deepEqual((await call('GET', '/me', jay.token)).body.without, []);
  const sched = await call('POST', '/admin/schedule', admin, { enabled: true, time: '12:00', startDate: '2030-01-02' });
  assert.equal(new Date(sched.body.nextRunAt).toISOString(), '2030-01-02T17:00:00.000Z');
  assert.equal((await call('GET', '/me', jay.token)).body.schedule.nextRunAt, sched.body.nextRunAt, 'players see when the next day runs');
});
