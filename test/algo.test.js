import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { queue, take, auction, makeRng } from '../algo/matching.js';
import { simulateDay, toCsv, PRICE_COLUMNS } from '../algo/sim.js';
import { startAgent } from '../algo/runner.js';
import { AlgoService, AlgoError, zoned, zonedToUtc } from '../algo/service.js';
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
  const lines = await svc.leaderboardLines((id) => id);
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

test('a design can publish the algorithms\' open positions (playerOpen), from the tick after their fills', async () => {
  const withOpen = {
    ...small,
    ticks: 8,
    model: {
      create(args) {
        const w = small.model.create(args);
        return { ...w, observations: (t, { playerOpen }) => ({ open: playerOpen.STABLE }) };
      },
    },
  };
  // one buys at tick 2, the other sells at tick 4, both against the bots' quotes
  const trader = (name, at, quantity) => ({ name, run: async (s) => ({ orders: s.timestamp === at ? [{ symbol: 'STABLE', price: quantity > 0 ? 1000000 : 1, quantity }] : [] }) });
  const res = await simulateDay({ config: withOpen, day: 1, seed: 7, agents: [trader('b', 200, 4), trader('s', 400, -3)] });
  const open = res.observationRows.map((r) => r.open);
  const bought = res.results.b.byProduct.STABLE.position;
  const sold = res.results.s.byProduct.STABLE.position;
  assert.ok(bought > 0 && sold < 0, 'both traded');
  assert.deepEqual(open, [0, 0, 0, bought, bought, bought - sold, bought - sold, bought - sold], 'long and short both count, by size');
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
  const entries = unzip(file);
  assert.deepEqual(Object.keys(entries), [-2, -1, 0].flatMap((d) => ['prices', 'trades'].map((k) => `round_1/${k}_round_1_day_${d}.csv`)).concat('round_1/datamodel.py'),
    'files are named by round and day');
  for (const d of [-2, -1, 0]) {
    assert.equal(entries[`round_1/prices_round_1_day_${d}.csv`], fs.readFileSync(svc.dataFile(d, 'prices'), 'utf8'), 'and unzip to the same bytes');
  }
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

  // one product's prices at a time
  const part = await call('GET', '/days/1/prices.csv?product=ASCEND', jay.token);
  assert.equal(part.status, 200);
  const lines = part.body.trim().split('\n');
  assert.match(lines[0], /^day;timestamp;product;bid_price_1/);
  assert.ok(lines.length === small.ticks + 1 && lines.slice(1).every((l) => l.split(';')[2] === 'ASCEND'));
  assert.ok((await call('GET', '/days/1/prices.csv', jay.token)).body.includes(';STABLE;'), 'without ?product: the whole file');
  assert.equal((await call('GET', '/days/8/prices.csv?product=ASCEND', jay.token)).status, 404);

  // new round: settings are checked before anything is archived
  for (const bad of [{ dataDays: 0 }, { dataDays: 40 }, { firstDay: 'soon' }, { continueMarket: 1 }, { dataDays: 2, seeds: [5] }, { dataDays: 2, seeds: [5, '6'] }, { dataDays: 1, seeds: 5 }]) {
    assert.equal((await call('POST', '/admin/new-round', admin, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('POST', '/admin/new-round', jay.token, { dataDays: 2 })).status, 403);
  const started = await call('POST', '/admin/new-round', admin, { dataDays: 2, firstDay: 4, continueMarket: true });
  assert.deepEqual(started.body, { started: true, dataDays: [2, 3], firstDay: 4, continuedFrom: { round: 0, day: 1 } });
  for (let i = 0; i < 100 && (await call('GET', '/admin', admin)).body.preparing; i++) await new Promise((r) => setTimeout(r, 100));
  const next = (await call('GET', '/admin', admin)).body;
  assert.deepEqual(next.days.map((d) => d.day), [2, 3]);
  assert.equal(next.nextDay, 4);
  assert.deepEqual(next.continuedFrom, { round: 0, day: 1 });
  assert.equal(next.lastError, null);
});

/** Read a .zip (stored or deflated entries) into { name: text }, checking every CRC: enough to check writeZip. */
function unzip(file) {
  const buf = fs.readFileSync(file);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'has an end of central directory');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const [crc, packed, size] = [buf.readUInt32LE(at + 16), buf.readUInt32LE(at + 20), buf.readUInt32LE(at + 24)];
    const nameLen = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString();
    const local = buf.readUInt32LE(at + 42);
    assert.equal(buf.readUInt32LE(local), 0x04034b50);
    assert.equal(buf.readUInt32LE(local + 14), crc, `${name}: the local header has the CRC`);
    assert.equal(buf.readUInt32LE(local + 18), packed);
    assert.equal(buf.readUInt32LE(local + 22), size);
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = zlib.inflateRawSync(buf.subarray(dataAt, dataAt + packed));
    assert.equal(data.length, size);
    assert.equal(zlib.crc32(data), crc, `${name}: CRC matches`);
    out[name] = data.toString();
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return out;
}

test('new round: continue the market from the last day, number the days before the first real day, skip today on the schedule', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-continue-'));
  const svc = new AlgoService({ config: { ...small, ticks: 30 }, dir });
  assert.throws(() => svc.planRound({ continueMarket: true }), /no closing market/, 'nothing to continue from yet');
  for (const bad of [{ dataDays: 0 }, { dataDays: 31 }, { dataDays: 2.5 }, { firstDay: 1.5 }, { firstDay: '5' }, { continueMarket: 'yes' }]) {
    assert.throws(() => svc.planRound(bad), AlgoError, JSON.stringify(bad));
  }
  await svc.newRound({ dataDays: 2 }); // round 1: Days -1, 0 from a fresh market
  svc.submit('u1', competition.template);
  await svc.runDay(); // Day 1
  const closed = svc.worldState(1).out;

  // the schedule is on and today's run time has passed: without the guard the scheduler would run at once
  svc.setSchedule({ enabled: true, time: '00:00', startDate: '2020-01-01', weekdays: null });
  const res = await svc.newRound({ dataDays: 3, firstDay: 6, continueMarket: true });
  assert.deepEqual(res.dataDays, [3, 4, 5], 'data days run up to the day before the first real day');
  assert.deepEqual(res.continuedFrom, { round: 1, day: 1 });
  assert.equal(svc.state.round, 2);
  assert.equal(svc.state.nextDay, 6);
  assert.deepEqual(svc.worldState(3).in, closed, 'the first data day opens where the last round closed');
  assert.deepEqual(svc.worldState(4).in, svc.worldState(3).out, 'and the rest continue one another');
  const archived = fs.readdirSync(path.join(dir, 'archive')).sort().at(-1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'archive', archived, 'days', '1', 'world.json'), 'utf8')).out, closed, 'read before it was archived');
  const now = Date.now();
  const today = zoned(now, 'America/New_York').date;
  assert.equal(svc.state.schedule.lastRun, today);
  assert.equal(svc.checkSchedule(now), null, 'no scheduled run on the day a round starts');
  assert.ok(svc.nextRunAt(now) > now && zoned(svc.nextRunAt(now), 'America/New_York').date > today, 'the next one is a later day');
  assert.equal(svc.state.schedule.enabled, true, 'the schedule stays on');

  const d3 = svc.getDay(3);
  svc.submit('u1', competition.template);
  const bt = await svc.backtest('u1', competition.template, 3);
  assert.equal(bt.day, 3, 'a continued data day backtests from its own start');

  // a round that never ran a real day is redone, and continuing starts again from the same place
  const redo = await svc.newRound({ dataDays: 2, firstDay: 6, continueMarket: true });
  assert.deepEqual(redo.dataDays, [4, 5]);
  assert.deepEqual(redo.continuedFrom, { round: 1, day: 1 });
  assert.equal(svc.state.round, 2, 'same round number');
  assert.deepEqual(svc.worldState(4).in, closed, 'not from the round being redone');
  assert.notEqual(svc.state.days[0].ranAt, d3.ranAt);

  const fresh = await svc.newRound({ dataDays: 1, firstDay: 1 });
  assert.deepEqual(fresh.dataDays, [0]);
  assert.equal(fresh.continuedFrom, null);
  assert.equal(svc.worldState(0).in, null, 'not continuing: a fresh market');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('new round with chosen seeds: each data day runs on its seed, so the same days can be made again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-seeds-'));
  const svc = new AlgoService({ config: { ...small, ticks: 30 }, dir });
  for (const seeds of [[1], [1, 2, 3, 4], [1, 2.5, 3], [0, 1, 2], [1, 2, 2 ** 31], ['1', 2, 3], 7]) {
    assert.throws(() => svc.planRound({ dataDays: 3, seeds }), AlgoError, JSON.stringify(seeds));
  }
  assert.equal(svc.planRound({ dataDays: 3 }).seeds, null, 'no seeds: random ones');
  const seeds = [11, 2 ** 31 - 1, 12345];
  await svc.newRound({ dataDays: 3, firstDay: 1, seeds });
  assert.deepEqual(svc.state.days.map((d) => [d.day, d.seed]), [[-2, 11], [-1, 2 ** 31 - 1], [0, 12345]], 'oldest first');
  const files = (day) => ['prices', 'trades'].map((k) => fs.readFileSync(path.join(svc.dayDir(day), `${k}.csv`), 'utf8')).join('');
  const first = [-2, -1, 0].map(files);
  // the same seeds from the same (fresh) start make the same days again
  await svc.newRound({ dataDays: 3, firstDay: 1, seeds });
  assert.deepEqual([-2, -1, 0].map(files), first);
  // without seeds the days differ
  await svc.newRound({ dataDays: 3, firstDay: 1 });
  assert.notDeepEqual([-2, -1, 0].map(files), first);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('new round keeping the leaderboard: earlier counted days stay on it and the new days add to them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-keep-'));
  const svc = new AlgoService({ config: { ...small, ticks: 30 }, dir });
  const names = (id) => id;
  assert.throws(() => svc.planRound({ keepLeaderboard: 'yes' }), /keepLeaderboard/);
  await svc.newRound({ dataDays: 1 }); // round 1: Day 0
  svc.submit('u1', competition.template);
  svc.submit('u2', competition.template);
  await svc.runDay(); // Day 1
  await svc.runDay(); // Day 2
  svc.state.withoutPlayers = ['u2'];
  svc.getDay(1).without = { players: ['u2'], ranAt: 1, results: { u1: { pnl: 5 } } };
  const board = svc.leaderboard(names);
  const lines = await svc.leaderboardLines(names);
  assert.equal(board.length, 2);

  const res = await svc.newRound({ dataDays: 2, firstDay: 5, continueMarket: true, keepLeaderboard: true });
  assert.deepEqual(res.keptDays, [1, 2]);
  assert.deepEqual(svc.leaderboard(names), board, 'same totals and days');
  assert.deepEqual(await svc.leaderboardLines(names), lines, 'the lines are read from the archive');
  assert.deepEqual(svc.withoutBoards(names)[0].days, [1], 'the unofficial board keeps its days too');
  assert.equal(svc.latestDay(names).day, 2, 'until the new round has a day');
  const mine = svc.playerView('u1', names).days;
  const u1Before = board.find((r) => r.userId === 'u1');
  assert.deepEqual(mine.filter((d) => d.archived).map((d) => [d.day, d.mine?.pnl]), [[1, u1Before.byDay[1]], [2, u1Before.byDay[2]]], 'your days include the kept ones');
  assert.ok(mine.filter((d) => !d.archived).every((d) => d.practice), 'this round: data days only');

  // a redo of a round with no real day keeps the same earlier days once
  await svc.newRound({ dataDays: 2, firstDay: 5, continueMarket: true, keepLeaderboard: true });
  assert.deepEqual(svc.state.earlierDays.map((d) => d.day), [1, 2]);
  assert.deepEqual(svc.leaderboard(names), board);

  svc.submit('u1', competition.template);
  await svc.runDay(); // Day 5
  const u1 = svc.leaderboard(names).find((r) => r.userId === 'u1');
  assert.deepEqual(Object.keys(u1.byDay).map(Number), [1, 2, 5]);
  assert.equal(u1.total, Math.round((u1Before.total + svc.getDay(5).results.u1.pnl) * 100) / 100, 'the new day adds to the total');
  assert.equal(svc.latestDay(names).day, 5);

  await svc.newRound({ dataDays: 1, firstDay: 7, continueMarket: true });
  assert.deepEqual(svc.leaderboard(names), [], 'without keepLeaderboard it starts over');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the design secret can be plain or gzip-compressed base64', async () => {
  const { execFileSync } = await import('node:child_process');
  const src = "export const competition = { name: 'from the secret', products: [] };\n";
  const loader = new URL('../algo/competition.js', import.meta.url).href;
  const run = (b64) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(loader)}); console.log(JSON.stringify([m.competition.name, m.competitionSource]))`], { env: { ...process.env, ALGO_DESIGN_B64: b64 }, encoding: 'utf8' }));
  const plain = Buffer.from(src).toString('base64');
  const gz = zlib.gzipSync(Buffer.from(src), { level: 9 }).toString('base64');
  assert.deepEqual(run(plain), ['from the secret', 'ALGO_DESIGN_B64 secret']);
  assert.deepEqual(run(gz), ['from the secret', 'ALGO_DESIGN_B64 secret']);
  assert.deepEqual(run(gz.replace(/(.{76})/g, '$1\n')), ['from the secret', 'ALGO_DESIGN_B64 secret'], 'line-wrapped base64 works too');
});

test("players see the design's notes and only the public terms of each product", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-notes-'));
  const products = [
    { symbol: 'STABLE', limit: 50, privateParam: 0.3 },
    { symbol: 'ASCEND', limit: 50, seed: 7 },
    { symbol: 'ASCEND_C10000', limit: 100, underlying: 'ASCEND', kind: 'call', strike: 10000, expiryDay: 7, model: { hidden: 1 } },
  ];
  const svc = new AlgoService({ config: { ...small, products, notes: '<p>Contract <b>terms</b></p>' }, dir });
  const info = svc.playerView('u1', (id) => id);
  assert.equal(info.notes, '<p>Contract <b>terms</b></p>');
  assert.deepEqual(info.products, [
    { symbol: 'STABLE', limit: 50 },
    { symbol: 'ASCEND', limit: 50 },
    { symbol: 'ASCEND_C10000', limit: 100, underlying: 'ASCEND', kind: 'call', strike: 10000, expiryDay: 7 },
  ]);
  assert.equal(new AlgoService({ config: small, dir }).publicInfo().notes, null, 'no notes: nothing shown');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a taker bot reading the book lazily sees exactly what a full snapshot would have shown', async () => {
  // reference: every taker bot gets the whole book built up front, as plain objects (the old way)
  const eager = (config) => ({
    ...config,
    bots: config.bots.map((b) => (b.take ? { ...b, take: (ctx) => b.take({ ...ctx, book: Object.fromEntries(ctx.symbols.map((s) => [s, ctx.book[s]])) }) } : b)),
  });
  // a second taker that reads one product's book only after the first has traded, and trades only with players
  const config = {
    ...small,
    ticks: 1500,
    bots: [...small.bots, {
      name: 'Picky',
      take({ book, rng, t }) {
        const d = book[t % 2 ? 'ASCEND' : 'STABLE'];
        const ask = Math.min(...Object.keys(d.sell_orders).map(Number));
        return rng() < 0.3 && Number.isFinite(ask) ? [{ symbol: t % 2 ? 'ASCEND' : 'STABLE', price: ask, quantity: 3, match: (o) => o.agent }] : [];
      },
    }],
  };
  // players that rest orders inside the spread, so the takers trade with them too (fixed CPU time: a fixed queue)
  const player = (name, size) => ({
    name,
    run: async (state) => {
      const orders = [];
      for (const [symbol, d] of Object.entries(state.order_depths)) {
        const bid = Math.max(...Object.keys(d.buy_orders).map(Number));
        const ask = Math.min(...Object.keys(d.sell_orders).map(Number));
        if (ask - bid > 2 && Math.abs(state.position[symbol] ?? 0) < 40) orders.push({ symbol, price: bid + 1, quantity: size }, { symbol, price: ask - 1, quantity: -size });
      }
      return { orders, cpuUs: 7 };
    },
  });
  const day = (c) => simulateDay({ config: c, day: 3, seed: 4242, agents: [player('a', 2), player('b', 3)] });
  const [lazy, full] = [await day(config), await day(eager(config))];
  assert.ok(lazy.tradeRows.some((t) => t.buyer === 'Picky'), 'the second taker traded');
  assert.equal(toCsv(lazy.priceRows, PRICE_COLUMNS), toCsv(full.priceRows, PRICE_COLUMNS));
  assert.deepEqual(lazy.tradeRows, full.tradeRows);
  assert.deepEqual(lazy.results, full.results);
  assert.deepEqual(lazy.bots, full.bots);

  // a later taker sees what earlier ones took this tick
  const views = [];
  const sweep = { name: 'Sweep', take: ({ book }) => {
    const [ask, size] = Object.entries(book.STABLE.sell_orders).sort((x, y) => x[0] - y[0])[0];
    views.push(Number(ask));
    return [{ symbol: 'STABLE', price: Number(ask), quantity: -size }];
  } };
  const after = { name: 'After', take: ({ book }) => void views.push(Math.min(...Object.keys(book.STABLE.sell_orders).map(Number))) };
  await simulateDay({ config: { ...small, ticks: 5, bots: [small.bots[0], sweep, after] }, day: 1, seed: 2 });
  for (let i = 0; i < views.length; i += 2) assert.ok(views[i + 1] > views[i], 'the best ask was taken, so the next bot sees the level behind it');

  // it behaves like a plain object: keys in product order, `in`, JSON; and it can't be changed
  let seen;
  await simulateDay({ config: { ...small, ticks: 2, bots: [...small.bots, { name: 'Look', take: ({ book }) => void (seen ??= book) }] }, day: 1, seed: 1 });
  assert.deepEqual(Object.keys(seen), ['STABLE', 'ASCEND', 'ASCEND_C10000']);
  assert.ok('ASCEND' in seen && !('NOPE' in seen) && seen.NOPE === undefined);
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(seen)).STABLE), ['buy_orders', 'sell_orders', 'mid']);
  assert.throws(() => {
    seen.STABLE = {};
  }, /read-only/);
});

test('products with contract terms reach the algorithm in state.listings', async () => {
  const products = [
    { symbol: 'STABLE', limit: 50 },
    { symbol: 'ASCEND', limit: 50 },
    { symbol: 'ASCEND_C10000', limit: 100, underlying: 'ASCEND', kind: 'call', strike: 10000, expiryDay: 7, secret: 1 },
  ];
  const code = `
class Trader:
    def run(self, state):
        for s in ("STABLE", "ASCEND_C10000"):
            l = state.listings[s]
            print(s, l.symbol, l.product, l.denomination, l.underlying, l.kind, l.strike, l.expiryDay, hasattr(l, "secret"))
        return {}, 0, ""
`;
  const agent = await startAgent({ name: 'p', code, timeLimitMs: 1000 });
  const res = await simulateDay({ config: { ...small, products, ticks: 2 }, day: 1, seed: 8, agents: [agent] });
  agent.close();
  assert.deepEqual(res.results.p.logs.slice(0, 2), [
    '[0] STABLE STABLE STABLE SEASHELLS None None None None False',
    '[0] ASCEND_C10000 ASCEND_C10000 ASCEND_C10000 SEASHELLS ASCEND call 10000 7 False',
  ]);
});

test('market data one product at a time; leaderboard lines skip a product until it has a two-sided price', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-oneside-'));
  // a product only ever bid for: it never has a mid price
  const config = {
    ...small,
    ticks: 200,
    products: [...small.products, { symbol: 'BIDONLY', limit: 10 }],
    model: {
      create(args) {
        const w = small.model.create(args);
        return { ...w, step: (t) => ({ ...w.step(t), BIDONLY: 100 }) };
      },
    },
    bots: [...small.bots, { name: 'Bidder', quote: () => [{ symbol: 'BIDONLY', price: 99, quantity: 5 }] }],
  };
  const svc = new AlgoService({ config, dir });
  svc.setPracticeMode(false);
  svc.submit('u1', `
from datamodel import Order
class Trader:
    def run(self, state):
        if state.position.get("BIDONLY", 0) > -10:
            return {"BIDONLY": [Order("BIDONLY", 99, -1)]}, 0, ""
        return {}, 0, ""
`);
  const day1 = await svc.runDay();
  assert.equal(day1.results.u1.byProduct.BIDONLY.position, -10);
  const pts = (await svc.leaderboardLines((id) => id)).players[0].pts;
  assert.ok(pts.slice(0, -1).every((v) => v === 0), 'never priced two-sided: left out, not marked at 0 (which would show the sales as profit)');
  assert.equal(pts.at(-1), day1.results.u1.pnl, 'the day still ends at the official P&L');
  assert.equal(day1.results.u1.pnl, -10);

  const full = fs.readFileSync(svc.dataFile(1, 'prices'), 'utf8').trim().split('\n');
  for (const product of ['STABLE', 'BIDONLY']) {
    const part = (await svc.productPrices(1, product)).trim().split('\n');
    assert.equal(part[0], full[0], 'with the header');
    assert.deepEqual(part.slice(1), full.slice(1).filter((l) => l.split(';')[2] === product), `${product}: exactly its rows, in order`);
    assert.equal(part.length - 1, config.ticks);
  }
  assert.equal((await svc.productPrices(1, 'NOPE')).trim(), full[0], 'an unknown product: just the header');
  await assert.rejects(svc.productPrices(9, 'STABLE'), /No data for day 9/);
  fs.rmSync(dir, { recursive: true, force: true });
});
