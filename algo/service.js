import fs from 'node:fs';
import os from 'node:os';
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
    // backtests at once: about one per core (each runs a Python process); a short line waits for a free slot
    this.slots = Number(process.env.BACKTEST_SLOTS) || Math.max(2, os.availableParallelism());
    this.backtests = 0;
    this.waiting = [];
    this.curves = new Map(); // day → each player's P&L through the day (see dayCurves)
    this.extra = null; // { day, userId, progress } while a day re-runs without one player (see runWithout)
    this.filling = null; // the background loop working through the missing re-runs
    this.withoutFailed = new Set(); // re-runs that failed (`${day}:${ranAt}:${userId}`); retried when the admin saves again
    this.withoutError = null;
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
    const clean = checkCode(code);
    await this.backtestSlot();
    let agent;
    try {
      agent = await startAgent({ name: userId, code: clean, timeLimitMs: this.config.timeLimitMs });
      const started = Date.now();
      const res = await simulateDay({ config: this.config, day: d.day, seed: d.seed, agents: [agent], record: false, carry: this.worldState(d.day)?.in ?? null });
      // fills: [timestamp, product, signed quantity, price, counterparty]
      return { day: d.day, seconds: (Date.now() - started) / 1000, ...res.results[userId] };
    } finally {
      agent?.close();
      this.releaseSlot();
    }
  }

  /** Take a backtest slot, waiting in line if they're all busy (the line is short, so a wait is a backtest or two). */
  async backtestSlot() {
    if (this.backtests < this.slots) {
      this.backtests++;
      return;
    }
    if (this.waiting.length >= this.slots * 2) throw new AlgoError('The backtester is busy. Try again in a few seconds.');
    await new Promise((resolve) => this.waiting.push(resolve));
  }

  releaseSlot() {
    const next = this.waiting.shift();
    if (next) next(); // the slot passes straight to the next in line
    else this.backtests--;
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
    for (const a of this.extra?.agents ?? []) a.close(); // a re-run in progress gives way at once (it resumes after)
    const agents = [];
    const calls = { cpu: {}, slow: {} }; // what set each call's place in the queue, for re-runs (see runWithout)
    try {
      for (const e of entries) {
        const agent = { ...(await startAgent({ name: e.userId, code: e.code, timeLimitMs: this.config.timeLimitMs })), label: this.names(e.userId) };
        agents.push(recordCalls(agent, calls, this.config.tickStep ?? 100));
      }
      const res = await simulateDay({
        config: this.config,
        day,
        seed,
        agents,
        carry,
        onProgress: (p) => (this.running.progress = p),
      });
      this.writeDayFiles(day, res, entries);
      // private: never served or zipped (see dataFile, dataZip)
      if (!practice) fs.writeFileSync(path.join(this.dayDir(day), 'calls.json'), JSON.stringify(calls));
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
      // re-runs without chosen players wait for a day run (it pauses them); pick them up again now
      this.fillWithout();
    }
  }

  // ---------------------------------------------------------------- days without one player

  /**
   * Re-run a competition day with one player left out: same seed and start, everyone else's code from that day.
   * Each call keeps its place in the queue from the real day (its recorded CPU time, and whether it ran over the time
   * limit), so the only change is the missing player. Only each player's P&L is kept: no data files, trades or logs,
   * so it shows nothing but the standings.
   * userId null: a re-run with everyone, for a day that ran before calls were recorded. It records the calls the
   * re-runs then replay, and its P&L stands in for the real day's when they're compared.
   */
  async runWithout(d, userId) {
    const ranAt = d.ranAt;
    const file = path.join(this.dayDir(d.day), 'calls.json');
    let results;
    if (userId != null && !(userId in d.results)) {
      results = pnlOnly(d.baseline?.results ?? d.results); // sat that day out: nothing changes
    } else {
      const replay = userId != null;
      const calls = replay ? JSON.parse(fs.readFileSync(file, 'utf8')) : { cpu: {}, slow: {} };
      const step = this.config.tickStep ?? 100;
      const pause = () => {
        if (this.running || this.preparing) throw new AlgoError('Paused for a day run');
      };
      this.extra = { day: d.day, userId, progress: 0, agents: [] };
      try {
        for (const id of Object.keys(d.results).filter((x) => x !== userId)) {
          pause();
          const code = fs.readFileSync(path.join(this.dayDir(d.day), 'code', `${id}.py`), 'utf8');
          // a replayed call is never dropped for being slow here (the recording says which ones were)
          const timeLimitMs = replay ? Math.max(2000, this.config.timeLimitMs) : this.config.timeLimitMs;
          const agent = { ...(await startAgent({ name: id, code, timeLimitMs, background: replay })), label: this.names(id) };
          this.extra.agents.push(agent);
        }
        pause();
        const res = await simulateDay({
          config: this.config,
          day: d.day,
          seed: d.seed,
          agents: this.extra.agents.map((a) => (replay ? replayCalls : recordCalls)(a, calls, step)),
          carry: this.worldState(d.day)?.in ?? null,
          record: false,
          onProgress: (p) => {
            pause();
            this.extra.progress = p;
          },
        });
        results = pnlOnly(res.results);
        if (!replay && this.state.days.includes(d)) fs.writeFileSync(file, JSON.stringify(calls));
      } finally {
        for (const a of this.extra.agents) a.close();
        this.extra = null;
      }
    }
    if (!this.state.days.includes(d) || d.ranAt !== ranAt) return; // the day was deleted or re-run meanwhile
    if (userId == null) d.baseline = { ranAt: Date.now(), results };
    else d.without = { ...d.without, [userId]: { ranAt: Date.now(), results } };
    this.save();
  }

  /**
   * Counted days still missing a re-run without one of the chosen players, oldest first. A day that ran before calls
   * were recorded first gets a re-run with everyone (userId null).
   */
  withoutQueue() {
    const ids = this.state.withoutPlayers ?? [];
    if (!ids.length) return [];
    const failed = (d, id) => this.withoutFailed.has(`${d.day}:${d.ranAt}:${id}`);
    return this.state.days
      .filter((d) => !d.practice && d.counts !== false)
      .flatMap((d) => {
        const jobs = ids.filter((id) => !d.without?.[id] && !failed(d, id)).map((userId) => ({ d, userId }));
        const recorded = d.baseline || fs.existsSync(path.join(this.dayDir(d.day), 'calls.json'));
        if (!jobs.length || recorded) return jobs;
        return failed(d, null) ? [] : [{ d, userId: null }, ...jobs];
      });
  }

  /** Work through the missing re-runs one at a time in the background. A day run pauses them; they resume after it. */
  fillWithout() {
    if (!this.filling) this.filling = this.drainWithout().finally(() => (this.filling = null));
    return this.filling;
  }

  async drainWithout() {
    for (let next; !this.running && !this.preparing && (next = this.withoutQueue()[0]); ) {
      const { d, userId } = next;
      const ranAt = d.ranAt;
      try {
        await this.runWithout(d, userId);
      } catch (err) {
        if (this.running || this.preparing) break; // paused; the day run calls fillWithout when it ends
        if (!this.state.days.includes(d) || d.ranAt !== ranAt) continue; // the day went away meanwhile
        this.withoutFailed.add(`${d.day}:${d.ranAt}:${userId}`);
        this.withoutError = `Day ${d.day} ${userId == null ? 'with everyone' : `without ${this.names(userId)}`}: ${err.message}`;
        if (!(err instanceof AlgoError)) console.error('[algo without]', err);
      }
    }
  }

  /** Choose the players to leave out, one at a time, in re-runs of every counted day (and each new one). */
  setWithoutPlayers(players) {
    const known = new Set([...Object.keys(this.state.submissions), ...this.state.days.flatMap((d) => Object.keys(d.results))]);
    if (!Array.isArray(players) || players.length > 10 || !players.every((id) => known.has(id))) throw new AlgoError('Pick up to 10 players');
    this.state.withoutPlayers = [...new Set(players)];
    this.withoutFailed.clear();
    this.withoutError = null;
    this.save();
    this.fillWithout();
    return { players: this.state.withoutPlayers };
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
    this.fillWithout(); // a day that now counts gets its re-runs
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
      const { drafts, schedule, withoutPlayers = [], round = 0 } = this.state;
      this.withoutFailed.clear();
      this.withoutError = null;
      const started = this.state.days.some((d) => !d.practice);
      this.state = { ...freshState(), drafts, schedule: { ...schedule, lastRun: null }, withoutPlayers, round: started || round === 0 ? round + 1 : round, practiceMode: false, nextDay: firstDay };
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
  setSchedule({ enabled, time, startDate, timeZone, weekdays } = {}) {
    const s = { ...this.state.schedule };
    if (enabled !== undefined) s.enabled = !!enabled;
    if (weekdays !== undefined) {
      // 0 = Sunday … 6 = Saturday; null or all seven = every day
      if (weekdays !== null && (!Array.isArray(weekdays) || !weekdays.length || !weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))) {
        throw new AlgoError('Pick at least one day of the week');
      }
      s.weekdays = weekdays && new Set(weekdays).size < 7 ? [...new Set(weekdays)].sort() : null;
    }
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
    while (!runsOn(s, date)) date = addDays(date, 1);
    return zonedToUtc(date, s.time, s.timeZone);
  }

  /** Called every minute: runs the day if it's time (once per calendar day; a server that was down catches up the same day). */
  checkSchedule(now = Date.now()) {
    const s = this.state.schedule;
    if (!s.enabled || this.running || this.preparing) return null;
    const { date, time } = zoned(now, s.timeZone);
    if (time < s.time || s.lastRun === date || (s.startDate && date < s.startDate) || !runsOn(s, date)) return null;
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
    this.fillWithout(); // re-runs a restart interrupted
  }

  stopScheduler() {
    clearInterval(this.timer);
  }

  scheduleView(now = Date.now()) {
    const s = this.state.schedule;
    return { enabled: s.enabled, time: s.time, timeZone: s.timeZone, startDate: s.startDate, weekdays: s.weekdays ?? null, nextRunAt: this.nextRunAt(now) };
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

  /**
   * The leaderboard's lines: each player's cumulative P&L through the days that count, sampled every few ticks
   * (at most LINE_POINTS per player in all). A player who sat a day out stays flat through it.
   */
  leaderboardLines(names) {
    const comp = this.state.days.filter((d) => !d.practice && d.counts !== false);
    const ids = [...new Set(comp.flatMap((d) => Object.keys(d.results)))];
    const total = Object.fromEntries(ids.map((id) => [id, 0]));
    const pts = Object.fromEntries(ids.map((id) => [id, []]));
    const days = comp.map((d) => {
      const curves = this.dayCurves(d);
      const n = Math.min(Object.values(curves)[0]?.length ?? CURVE_POINTS, Math.max(20, Math.floor(LINE_POINTS / comp.length)));
      for (const id of ids) {
        const c = curves[id];
        for (let j = 0; j < n; j++) pts[id].push(round2(total[id] + (c ? c[Math.round(((j + 1) * c.length) / n) - 1] : 0)));
        total[id] += d.results[id]?.pnl ?? 0;
      }
      return { day: d.day, points: n };
    });
    return { days, players: ids.map((id) => ({ userId: id, name: names(id), pts: pts[id] })) };
  }

  /**
   * Each player's P&L through one competition day, CURVE_POINTS samples: their fills marked to the mid price
   * (public, unlike fair value), with the last sample the day's official P&L. Built from the day's files.
   */
  dayCurves(d) {
    const key = `${d.day}:${d.ranAt}`;
    if (this.curves.has(key)) return this.curves.get(key);
    const dir = this.dayDir(d.day);
    if (!fs.existsSync(path.join(dir, 'prices.csv'))) return {};
    const [head, ...rows] = fs.readFileSync(path.join(dir, 'prices.csv'), 'utf8').trim().split('\n');
    const col = Object.fromEntries(head.split(';').map((c, i) => [c, i]));
    // the mid price of every product at each sample's end (the last known mid if the book was one-sided)
    const ticks = this.config.ticks;
    const step = this.config.tickStep ?? 100;
    const every = Math.max(1, Math.round(ticks / CURVE_POINTS));
    const ends = Array.from({ length: Math.ceil(ticks / every) }, (_, j) => Math.min((j + 1) * every, ticks) * step - step);
    const mid = {};
    const marks = [];
    for (const line of rows) {
      const v = line.split(';');
      const t = Number(v[col.timestamp]);
      while (marks.length < ends.length && t > ends[marks.length]) marks.push({ ...mid });
      if (v[col.mid_price] !== '') mid[v[col.product]] = Number(v[col.mid_price]);
    }
    while (marks.length < ends.length) marks.push({ ...mid });

    const curves = {};
    for (const id of Object.keys(d.results)) {
      const file = path.join(dir, 'own', `${id}.csv`);
      const fills = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').slice(1).map((l) => l.split(';')) : [];
      const cash = {};
      const pos = {};
      let f = 0;
      curves[id] = ends.map((end, j) => {
        // own trades: timestamp;buyer;seller;symbol;currency;price;quantity
        for (; f < fills.length && Number(fills[f][0]) <= end; f++) {
          const [, buyer, , symbol, , price, qty] = fills[f];
          const q = buyer === 'SUBMISSION' ? Number(qty) : -Number(qty);
          pos[symbol] = (pos[symbol] ?? 0) + q;
          cash[symbol] = (cash[symbol] ?? 0) - q * Number(price);
        }
        let v = 0;
        for (const s of Object.keys(pos)) v += cash[s] + pos[s] * (marks[j][s] ?? 0);
        return Math.round(v);
      });
      curves[id][ends.length - 1] = d.results[id]?.pnl ?? 0;
    }
    this.curves.set(key, curves);
    return curves;
  }

  /**
   * For each player chosen to leave out: the leaderboard over the counted days re-run without them, beside what each
   * player made on those same days with them in (the real day, or for days before calls were recorded, its re-run
   * with everyone).
   */
  withoutBoards(names) {
    const comp = this.state.days.filter((d) => !d.practice && d.counts !== false);
    return (this.state.withoutPlayers ?? [])
      .map((out) => {
        const days = comp.filter((d) => d.without?.[out]);
        const ids = [...new Set(days.flatMap((d) => Object.keys(d.results)))].filter((id) => id !== out);
        const sum = (f) => round2(days.reduce((s, d) => s + (f(d) ?? 0), 0));
        const board = ids
          .map((id) => ({ userId: id, name: names(id), total: sum((d) => d.without[out].results[id]?.pnl), actual: sum((d) => (d.baseline ?? d).results[id]?.pnl) }))
          .sort((a, b) => b.total - a.total);
        return { userId: out, name: names(out), days: days.map((d) => d.day), board };
      })
      .filter((w) => w.days.length);
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
      without: this.withoutBoards(names),
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
      without: {
        players: [...new Set([...Object.keys(this.state.submissions), ...this.state.days.flatMap((d) => Object.keys(d.results))])]
          .map((id) => ({ userId: id, name: names(id), on: (this.state.withoutPlayers ?? []).includes(id) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        running: this.extra && { day: this.extra.day, name: this.extra.userId == null ? null : names(this.extra.userId), progress: this.extra.progress },
        waiting: this.withoutQueue().length,
        error: this.withoutError,
      },
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
    withoutPlayers: [], // each counted day is also re-run without each of these players (results only; see runWithout)
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

/** Whether the schedule runs on a calendar date (YYYY-MM-DD): its weekdays, or every day. */
function runsOn(schedule, date) {
  const [y, m, d] = date.split('-').map(Number);
  return !schedule.weekdays || schedule.weekdays.includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
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

/** Note each call's CPU time (it sets the call's place in the queue) and whether it went over the time limit. */
function recordCalls(agent, calls, step) {
  const cpu = (calls.cpu[agent.name] = []);
  const slow = (calls.slow[agent.name] = []);
  return {
    ...agent,
    run: async (state) => {
      const r = await agent.run(state);
      const t = Math.round(state.timestamp / step);
      cpu[t] = Number.isFinite(r.cpuUs) ? Math.round(r.cpuUs * 1000) : -1; // ns; -1: no CPU time (stopped)
      if (r.slow) slow.push(t);
      return r;
    },
  };
}

/** Give each call the recorded CPU time and time-limit outcome, so a re-run queues exactly as the real day did. */
function replayCalls(agent, calls, step) {
  const cpu = calls.cpu[agent.name] ?? [];
  const slow = new Set(calls.slow[agent.name] ?? []);
  return {
    ...agent,
    run: async (state) => {
      const r = await agent.run(state);
      const t = Math.round(state.timestamp / step);
      const ns = cpu[t];
      if (ns == null) return r;
      if (ns < 0 || slow.has(t)) return { ...r, orders: [], cpuUs: ns < 0 ? undefined : ns / 1000 };
      return { ...r, cpuUs: ns / 1000 };
    },
  };
}

const pnlOnly = (results) => Object.fromEntries(Object.entries(results).map(([id, r]) => [id, { pnl: r.pnl }]));
const CURVE_POINTS = 1000; // samples per day for the leaderboard's lines (every 10 ticks of 10,000)
const LINE_POINTS = 2000; // samples per player in all, however many days count
