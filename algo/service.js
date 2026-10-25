import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { simulateDay, toCsv, PRICE_COLUMNS } from './sim.js';
import { startAgent } from './runner.js';

export class AlgoError extends Error {}

const TRADE_COLUMNS = ['timestamp', 'buyer', 'seller', 'symbol', 'currency', 'price', 'quantity'];

/**
 * The algo competition: players' code, daily simulations, released data, results.
 *
 * Files under `dir`:
 *   state.json                         drafts, latest submissions, day metadata and results
 *   days/<day>/prices.csv, trades.csv  released market data (Prosperity format)
 *   days/<day>/own/<userId>.csv         each player's fills that day
 *   days/<day>/code/<userId>.py         the code that ran that day
 */
export class AlgoService {
  constructor({ config, dir }) {
    this.config = config;
    this.dir = dir;
    this.running = null; // { day, practice, progress, startedAt }
    this.backtests = 0;
    // practiceMode: nightly days run normally but don't count toward the cumulative leaderboard
    this.state = { drafts: {}, submissions: {}, days: [], nextDay: 1, deadline: '', practiceMode: true };
    const file = path.join(dir, 'state.json');
    if (fs.existsSync(file)) Object.assign(this.state, JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, 'state.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(this.state));
    fs.renameSync(`${file}.tmp`, file);
  }

  dayDir(day) {
    return path.join(this.dir, 'days', String(day));
  }

  getDay(day) {
    const d = this.state.days.find((x) => x.day === Number(day));
    if (!d) throw new AlgoError(`No data for day ${day}`);
    return d;
  }

  // ---------------------------------------------------------------- players

  draft(userId) {
    return this.state.drafts[userId] ?? { code: this.config.template, savedAt: null };
  }

  saveDraft(userId, code) {
    this.state.drafts[userId] = { code: checkCode(code), savedAt: Date.now() };
    this.save();
    return this.state.drafts[userId];
  }

  submit(userId, code) {
    if (this.running && !this.running.practice) throw new AlgoError(`Day ${this.running.day} is being simulated right now; submit again in a minute`);
    const clean = checkCode(code);
    this.state.drafts[userId] = { code: clean, savedAt: Date.now() };
    this.state.submissions[userId] = { code: clean, submittedAt: Date.now(), forDay: this.state.nextDay };
    this.save();
    return this.state.submissions[userId];
  }

  /** Replay a released day with this code and the bots only. Returns this player's P&L, errors and logs. */
  async backtest(userId, code, day) {
    const d = this.getDay(day);
    if (this.backtests >= 3) throw new AlgoError('The backtester is busy. Try again in a few seconds.');
    this.backtests++;
    const agent = await startAgent({ name: userId, code: checkCode(code), timeLimitMs: this.config.timeLimitMs });
    try {
      const started = Date.now();
      const res = await simulateDay({ config: this.config, day: d.day, seed: d.seed, agents: [agent], record: false, options: { kind: d.practice ? 'data' : 'competition' } });
      return { day: d.day, seconds: (Date.now() - started) / 1000, ...res.results[userId] };
    } finally {
      agent.close();
      this.backtests--;
    }
  }

  // ---------------------------------------------------------------- admin

  /**
   * Simulate the next day. Practice days run the bots only (data for players to study);
   * competition days run every player's latest submission against the bots and each other.
   */
  async runDay({ practice = false } = {}) {
    if (this.running) throw new AlgoError(`Day ${this.running.day} is already running`);
    const day = practice ? Math.min(1, ...this.state.days.map((d) => d.day)) - 1 : this.state.nextDay;
    const seed = randomInt(1, 2 ** 31);
    const entries = practice ? [] : Object.entries(this.state.submissions).map(([userId, s]) => ({ userId, ...s }));
    this.running = { day, practice, progress: 0, startedAt: Date.now(), players: entries.length };
    const agents = [];
    try {
      for (const e of entries) agents.push(await startAgent({ name: e.userId, code: e.code, timeLimitMs: this.config.timeLimitMs }));
      const res = await simulateDay({
        config: this.config,
        day,
        seed,
        agents,
        options: { kind: practice ? 'data' : 'competition' },
        onProgress: (p) => (this.running.progress = p),
      });
      this.writeDayFiles(day, res, entries);
      const record = {
        day,
        practice, // a data day: bots only, released for players to study
        counts: !practice && !this.state.practiceMode, // counts toward the cumulative leaderboard
        seed,
        ranAt: Date.now(),
        entries: Object.fromEntries(entries.map((e) => [e.userId, { submittedAt: e.submittedAt }])),
        results: Object.fromEntries(Object.entries(res.results).map(([id, r]) => [id, { pnl: r.pnl, byProduct: r.byProduct, errors: r.errors, rejected: r.rejected }])),
        trades: res.tradeRows.length,
      };
      this.state.days = this.state.days.filter((d) => d.day !== day);
      this.state.days.push(record);
      this.state.days.sort((a, b) => a.day - b.day);
      if (!practice) this.state.nextDay = day + 1;
      this.save();
      return record;
    } finally {
      for (const a of agents) a.close();
      this.running = null;
    }
  }

  writeDayFiles(day, res, entries) {
    const dir = this.dayDir(day);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'own'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'code'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'prices.csv'), toCsv(res.priceRows, PRICE_COLUMNS));
    const reveal = this.config.revealCounterparties;
    const currency = this.config.currency ?? 'SEASHELLS';
    const publicTrades = res.tradeRows.map((t) => ({
      ...t,
      currency,
      buyer: reveal && t.botBuyer ? t.buyer : '',
      seller: reveal && t.botSeller ? t.seller : '',
    }));
    fs.writeFileSync(path.join(dir, 'trades.csv'), toCsv(publicTrades, TRADE_COLUMNS));
    for (const e of entries) {
      const mine = res.tradeRows
        .filter((t) => t.buyer === e.userId || t.seller === e.userId)
        .map((t) => ({ ...t, currency, buyer: t.buyer === e.userId ? 'SUBMISSION' : '', seller: t.seller === e.userId ? 'SUBMISSION' : '' }));
      fs.writeFileSync(path.join(dir, 'own', `${e.userId}.csv`), toCsv(mine, TRADE_COLUMNS));
      fs.writeFileSync(path.join(dir, 'code', `${e.userId}.py`), e.code);
      const r = res.results[e.userId];
      fs.writeFileSync(path.join(dir, 'own', `${e.userId}.log`), [...(r?.errors ?? []), ...(r?.logs ?? [])].join('\n'));
    }
  }

  deleteDay(day) {
    const d = this.getDay(day);
    this.state.days = this.state.days.filter((x) => x !== d);
    fs.rmSync(this.dayDir(d.day), { recursive: true, force: true });
    if (!d.practice && d.day === this.state.nextDay - 1) this.state.nextDay = d.day;
    this.save();
  }

  setPracticeMode(on) {
    this.state.practiceMode = !!on;
    this.save();
  }

  /** Decide afterwards whether a competition day counts toward the leaderboard. */
  setDayCounts(day, counts) {
    const d = this.getDay(day);
    if (d.practice) throw new AlgoError('Data days have no results to count');
    d.counts = !!counts;
    this.save();
  }

  setDeadline(text) {
    this.state.deadline = String(text ?? '').slice(0, 120);
    this.save();
  }

  dataFile(day, kind, userId) {
    const d = this.getDay(day);
    const file =
      kind === 'prices' ? 'prices.csv'
      : kind === 'trades' ? 'trades.csv'
      : kind === 'own' ? path.join('own', `${userId}.csv`)
      : kind === 'log' ? path.join('own', `${userId}.log`)
      : kind === 'code' ? path.join('code', `${userId}.py`)
      : null;
    if (!file) throw new AlgoError('Unknown file');
    const full = path.join(this.dayDir(d.day), file);
    if (!fs.existsSync(full)) throw new AlgoError('No such file for that day');
    return full;
  }

  // ---------------------------------------------------------------- views

  /** Cumulative P&L over the days that count (not data days, not practice-week days). */
  leaderboard(names) {
    const comp = this.state.days.filter((d) => !d.practice && d.counts !== false);
    const ids = new Set(comp.flatMap((d) => Object.keys(d.results)));
    return [...ids]
      .map((id) => {
        const byDay = Object.fromEntries(comp.map((d) => [d.day, d.results[id]?.pnl ?? null]));
        return { userId: id, name: names(id), total: round2(comp.reduce((s, d) => s + (d.results[id]?.pnl ?? 0), 0)), byDay };
      })
      .sort((a, b) => b.total - a.total);
  }

  /** Standings for the most recent competition day, counted or not. */
  latestDay(names) {
    const d = [...this.state.days].reverse().find((x) => !x.practice);
    if (!d) return null;
    return {
      day: d.day,
      counts: d.counts !== false,
      results: Object.entries(d.results).map(([id, r]) => ({ name: names(id), pnl: r.pnl })).sort((a, b) => b.pnl - a.pnl),
    };
  }

  publicInfo() {
    const c = this.config;
    return {
      competition: c.name,
      currency: c.currency,
      ticks: c.ticks,
      tickStep: c.tickStep,
      timeLimitMs: c.timeLimitMs,
      products: c.products,
      nextDay: this.state.nextDay,
      deadline: this.state.deadline,
      practiceMode: this.state.practiceMode !== false,
      running: this.running && { day: this.running.day, practice: this.running.practice, progress: this.running.progress },
    };
  }

  playerView(userId, names) {
    const sub = this.state.submissions[userId];
    return {
      ...this.publicInfo(),
      draft: this.draft(userId),
      template: this.config.template,
      submission: sub ? { submittedAt: sub.submittedAt, forDay: sub.forDay } : null,
      days: this.state.days.map((d) => ({
        day: d.day,
        practice: d.practice,
        counts: d.counts !== false,
        ranAt: d.ranAt,
        mine: d.results[userId] ?? null,
        entered: !!d.entries?.[userId],
      })),
      leaderboard: this.leaderboard(names),
      latestDay: this.latestDay(names),
    };
  }

  adminView(names) {
    return {
      ...this.publicInfo(),
      submissions: Object.entries(this.state.submissions)
        .map(([id, s]) => ({ userId: id, name: names(id), submittedAt: s.submittedAt, lines: s.code.split('\n').length }))
        .sort((a, b) => b.submittedAt - a.submittedAt),
      days: this.state.days.map((d) => ({
        day: d.day,
        practice: d.practice,
        counts: d.counts !== false,
        ranAt: d.ranAt,
        trades: d.trades,
        results: Object.entries(d.results)
          .map(([id, r]) => ({ userId: id, name: names(id), pnl: r.pnl, errors: r.errors?.length ?? 0, firstError: r.errors?.[0] ?? null }))
          .sort((a, b) => b.pnl - a.pnl),
      })),
      leaderboard: this.leaderboard(names),
    };
  }
}

function checkCode(code) {
  if (typeof code !== 'string' || !code.trim()) throw new AlgoError('Your file is empty');
  if (code.length > 200_000) throw new AlgoError('Your file is over 200 KB');
  return code;
}

const round2 = (n) => Math.round(n * 100) / 100;
