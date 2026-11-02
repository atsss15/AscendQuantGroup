import fs from 'node:fs';
import path from 'node:path';
import { randomInt, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { simulateDay, toCsv, PRICE_COLUMNS } from './sim.js';
import { startAgent } from './runner.js';
import { zip } from './zip.js';

const DATAMODEL = fileURLToPath(new URL('./py/datamodel.py', import.meta.url));

export class AlgoError extends Error {}

const TRADE_COLUMNS = ['timestamp', 'buyer', 'seller', 'symbol', 'currency', 'price', 'quantity'];

/**
 * The algo competition: players' code, daily simulations, released data, results.
 *
 * Files under `dir`:
 *   state.json                         drafts, latest submissions, day metadata and results, schedule
 *   days/<day>/prices.csv, trades.csv  released market data (Prosperity format)
 *   days/<day>/observations.csv         the features published each tick (weather and the like), if the design has any
 *   days/<day>/world.json               the market's state at the start and end of the day: each day continues the last
 *   days/<day>/own/<userId>.csv         each player's fills that day, with the counterparty named
 *   days/<day>/code/<userId>.py         the code that ran that day
 *   archive/<time>/                     everything from before the last "Start new round"
 *   export/round_<n>_<key>.zip          every released day's public files in one download (rebuilt when days change)
 */
export class AlgoService {
  constructor({ config, dir, names = (id) => id }) {
    this.config = config;
    this.dir = dir;
    this.names = names; // userId → display name (players see each other's names as counterparties)
    this.running = null; // { day, practice, progress, startedAt }
    this.preparing = null; // { startedAt } while a new round's data days are generated
    this.backtests = 0;
    this.state = freshState();
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
      const res = await simulateDay({ config: this.config, day: d.day, seed: d.seed, agents: [agent], record: false, carry: this.worldState(d.day)?.in ?? null });
      // fills: [timestamp, product, signed quantity, price, counterparty]
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
  async runDay({ practice = false, day: requested } = {}) {
    if (this.running) throw new AlgoError(`Day ${this.running.day} is already running`);
    // data days lead up to the first competition day; an extra one continues the series from the latest day
    // (so only before the first competition day), and the first competition day moves after it
    if (practice && requested == null && this.state.days.some((d) => !d.practice)) {
      throw new AlgoError('Data days can only be added before the first real day runs');
    }
    const day = practice ? requested ?? (this.state.days.length ? Math.max(...this.state.days.map((d) => d.day)) + 1 : this.state.nextDay - 1) : this.state.nextDay;
    // continue from where the previous day ended (a round's first day starts fresh)
    const carry = this.worldState(day - 1)?.out ?? null;
    const seed = randomInt(1, 2 ** 31);
    const entries = practice ? [] : Object.entries(this.state.submissions).map(([userId, s]) => ({ userId, ...s }));
    this.running = { day, practice, progress: 0, startedAt: Date.now(), players: entries.length };
    const agents = [];
    try {
      for (const e of entries) agents.push({ ...(await startAgent({ name: e.userId, code: e.code, timeLimitMs: this.config.timeLimitMs })), label: this.names(e.userId) });
      const res = await simulateDay({
        config: this.config,
        day,
        seed,
        agents,
        carry,
        onProgress: (p) => (this.running.progress = p),
      });
      this.writeDayFiles(day, res, entries);
      if (res.carry) fs.writeFileSync(path.join(this.dayDir(day), 'world.json'), JSON.stringify({ in: carry, out: res.carry }));
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
      if (!practice || day >= this.state.nextDay) this.state.nextDay = day + 1;
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
    if (res.observationRows?.length) {
      const columns = Object.keys(res.observationRows[0]);
      fs.writeFileSync(path.join(dir, 'observations.csv'), toCsv(res.observationRows, columns));
    }
    // a player's own fills name the other side: another player's name, or a bot's id
    const label = (owner) => (entries.some((x) => x.userId === owner) ? this.names(owner) : owner);
    for (const e of entries) {
      const mine = res.tradeRows
        .filter((t) => t.buyer === e.userId || t.seller === e.userId)
        .map((t) => ({ ...t, currency, buyer: t.buyer === e.userId ? 'SUBMISSION' : label(t.buyer), seller: t.seller === e.userId ? 'SUBMISSION' : label(t.seller) }));
      fs.writeFileSync(path.join(dir, 'own', `${e.userId}.csv`), toCsv(mine, TRADE_COLUMNS));
      fs.writeFileSync(path.join(dir, 'code', `${e.userId}.py`), e.code);
      const r = res.results[e.userId];
      fs.writeFileSync(path.join(dir, 'own', `${e.userId}.log`), [...(r?.errors ?? []), ...(r?.logs ?? [])].join('\n'));
    }
  }

  /** The market's state at the start (`in`) and end (`out`) of a day, if that day exists. */
  worldState(day) {
    const file = path.join(this.dayDir(day), 'world.json');
    return this.state.days.some((d) => d.day === day) && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
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

  /** Put the starting template in everyone's editor; their current code is saved to archive/editors-<time>.json first. */
  resetDrafts() {
    const count = Object.keys(this.state.drafts).length;
    if (count) {
      const dir = path.join(this.dir, 'archive');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `editors-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);
      fs.writeFileSync(file, JSON.stringify(this.state.drafts, null, 1));
    }
    this.state.drafts = {};
    this.save();
    return { reset: count };
  }

  // ---------------------------------------------------------------- rounds

  /**
   * Retire everything from the current round and start fresh: the state and day files move to
   * archive/<time>/, then `dataDays` bots-only days (firstDay - dataDays … firstDay - 1, e.g. -14 … 0) are generated with the
   * current design for players to study, and the first competition day is `firstDay`.
   * Players keep the code in their editor; submissions, days, results and the leaderboard start over.
   * A round that never had a competition day is redone under the same number.
   */
  async newRound({ dataDays = 3, firstDay = 1 } = {}) {
    if (this.running || this.preparing) throw new AlgoError('A simulation is running; try again when it finishes');
    this.preparing = { startedAt: Date.now(), dataDays, done: 0 };
    try {
      const stamp = path.join(this.dir, 'archive', new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'));
      let archive = stamp;
      for (let n = 2; fs.existsSync(archive); n++) archive = `${stamp}-${n}`;
      fs.mkdirSync(archive, { recursive: true });
      this.save();
      fs.copyFileSync(path.join(this.dir, 'state.json'), path.join(archive, 'state.json'));
      if (fs.existsSync(path.join(this.dir, 'days'))) fs.renameSync(path.join(this.dir, 'days'), path.join(archive, 'days'));
      const { drafts, schedule, round = 0 } = this.state;
      const started = this.state.days.some((d) => !d.practice);
      this.state = { ...freshState(), drafts, schedule: { ...schedule, lastRun: null }, round: started || round === 0 ? round + 1 : round, practiceMode: false, nextDay: firstDay };
      this.save();
      // oldest first, so each data day continues the one before and Day 0 continues the last of them
      for (let i = 0; i < dataDays; i++) {
        await this.runDay({ practice: true, day: firstDay - dataDays + i });
        this.preparing.done = i + 1;
      }
      return { round: this.state.round, archived: archive, dataDays: this.state.days.map((d) => d.day) };
    } finally {
      this.preparing = null;
    }
  }

  /** Every released day's public files (prices, trades, observations) in one zip; cached until the days change. */
  async dataZip() {
    const days = [...this.state.days].sort((a, b) => a.day - b.day);
    if (!days.length) throw new AlgoError('No data released yet');
    const round = this.state.round ?? 0;
    const key = createHash('sha1').update(JSON.stringify(days.map((d) => [d.day, d.ranAt]))).digest('hex').slice(0, 10);
    const exportDir = path.join(this.dir, 'export');
    const file = path.join(exportDir, `round_${round}_${key}.zip`);
    if (fs.existsSync(file)) return file;
    this.zipping ??= (async () => {
      const files = [];
      for (const d of days) {
        for (const kind of ['prices', 'trades', 'observations']) {
          const full = path.join(this.dayDir(d.day), `${kind}.csv`);
          if (fs.existsSync(full)) files.push({ name: `round_${round}/${kind}_round_${round}_day_${d.day}.csv`, data: fs.readFileSync(full) });
        }
      }
      files.push({ name: `round_${round}/datamodel.py`, data: fs.readFileSync(DATAMODEL) });
      const buf = await zip(files);
      fs.rmSync(exportDir, { recursive: true, force: true }); // older zips
      fs.mkdirSync(exportDir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, buf);
      fs.renameSync(`${file}.tmp`, file);
      return file;
    })().finally(() => (this.zipping = null));
    return this.zipping;
  }

  // ---------------------------------------------------------------- schedule

  /** Run the next day automatically every day at `time` (in `timeZone`), from `startDate` on. */
  setSchedule({ enabled, time, startDate, timeZone } = {}) {
    const s = { ...this.state.schedule };
    if (enabled !== undefined) s.enabled = !!enabled;
    if (time !== undefined) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new AlgoError('Time must look like 12:00');
      s.time = time;
    }
    if (startDate !== undefined) {
      if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new AlgoError('Start date must look like 2026-11-04');
      s.startDate = startDate || null;
    }
    if (timeZone !== undefined) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone });
      } catch {
        throw new AlgoError(`Unknown time zone ${timeZone}`);
      }
      s.timeZone = timeZone;
    }
    this.state.schedule = s;
    this.save();
    return this.scheduleView();
  }

  /** When the next automatic run happens (ms since epoch), or null if the schedule is off. */
  nextRunAt(now = Date.now()) {
    const s = this.state.schedule;
    if (!s.enabled) return null;
    const { date: today, time } = zoned(now, s.timeZone);
    let date = s.startDate && s.startDate > today ? s.startDate : today;
    if (date === today && (time >= s.time || s.lastRun === today)) date = addDays(today, 1);
    return zonedToUtc(date, s.time, s.timeZone);
  }

  /** Called every minute: runs the day if it's time (once per calendar day; a server that was down catches up the same day). */
  checkSchedule(now = Date.now()) {
    const s = this.state.schedule;
    if (!s.enabled || this.running || this.preparing) return null;
    const { date, time } = zoned(now, s.timeZone);
    if (time < s.time || s.lastRun === date || (s.startDate && date < s.startDate)) return null;
    s.lastRun = date;
    this.save();
    this.lastError = null;
    return this.runDay().catch((err) => {
      this.lastError = `Scheduled run on ${date}: ${err.message}`;
      if (!(err instanceof AlgoError)) console.error('[algo schedule]', err);
    });
  }

  startScheduler() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.checkSchedule(), 30_000);
    this.timer.unref();
  }

  stopScheduler() {
    clearInterval(this.timer);
  }

  scheduleView(now = Date.now()) {
    const s = this.state.schedule;
    return { enabled: s.enabled, time: s.time, timeZone: s.timeZone, startDate: s.startDate, nextRunAt: this.nextRunAt(now) };
  }

  dataFile(day, kind, userId) {
    const d = this.getDay(day);
    const file =
      kind === 'prices' ? 'prices.csv'
      : kind === 'trades' ? 'trades.csv'
      : kind === 'observations' ? 'observations.csv'
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
      round: this.state.round ?? 0,
      schedule: this.scheduleView(),
      running: this.running && { day: this.running.day, practice: this.running.practice, progress: this.running.progress },
      preparing: this.preparing && { dataDays: this.preparing.dataDays, done: this.preparing.done },
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

function freshState() {
  return {
    drafts: {},
    submissions: {},
    days: [],
    nextDay: 1,
    deadline: '',
    practiceMode: true, // practice week: days run normally but don't count toward the cumulative leaderboard
    round: 0, // the setup/practice round; each "Start new round" adds one
    schedule: { enabled: false, time: '12:00', timeZone: 'America/New_York', startDate: null, lastRun: null },
  };
}

/** Calendar date (YYYY-MM-DD) and wall-clock time (HH:MM) of an instant in a time zone. */
export function zoned(ms, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** The instant (ms) when the wall clock in `timeZone` shows `date` `time`. */
export function zonedToUtc(date, time, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const shown = zoned(guess, timeZone);
    const [sy, sm, sd] = shown.date.split('-').map(Number);
    const [sh, smin] = shown.time.split(':').map(Number);
    guess += wanted - Date.UTC(sy, sm - 1, sd, sh, smin);
  }
  return guess;
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function checkCode(code) {
  if (typeof code !== 'string' || !code.trim()) throw new AlgoError('Your file is empty');
  if (code.length > 200_000) throw new AlgoError('Your file is over 200 KB');
  return code;
}

const round2 = (n) => Math.round(n * 100) / 100;
