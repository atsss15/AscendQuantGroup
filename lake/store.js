import { EventEmitter } from 'node:events';
import { randomBytes, randomInt } from 'node:crypto';
import { STATIONS, CHORES, CAMPFIRE, STORM_DEFAULT } from './stations.js';

/** An error whose message is safe to show to the player or host. */
export class LakeError extends Error {}

export const DEFAULTS = {
  lurkers: 0, // 0 = auto: 1 for up to 6 players, else 2
  taskCount: 3,
  photoCount: 1,
  carryCount: 1,
  killCooldown: 150,
  startGrace: 60,
  killAfterMeeting: 90,
  undoSeconds: 20,
  gatherSeconds: 60,
  discussSeconds: 180,
  voteSeconds: 60,
  resultSeconds: 12,
  emergencies: 1,
  anonymousVotes: false,
  revealRole: false,
  barMode: 'live',
  storm: true,
  stormSeconds: 90,
  stormFirst: 180,
  stormCooldown: 240,
  stormStations: STORM_DEFAULT,
  disabled: [],
};

const RANGES = {
  lurkers: [0, 3], taskCount: [0, 8], photoCount: [0, 3], carryCount: [0, 3],
  killCooldown: [10, 900], startGrace: [0, 600], killAfterMeeting: [0, 600], undoSeconds: [0, 120],
  gatherSeconds: [10, 600], discussSeconds: [10, 1200], voteSeconds: [10, 600], resultSeconds: [3, 120],
  emergencies: [0, 5], stormSeconds: [20, 600], stormFirst: [0, 1800], stormCooldown: [30, 1800],
};
const FLAGS = ['anonymousVotes', 'revealRole', 'storm'];
const LABELS = {
  lurkers: 'Lurkers', taskCount: 'Puzzle chores', photoCount: 'Photo chores', carryCount: 'Carry chores',
  killCooldown: 'Kill cooldown', startGrace: 'No-kill time at the start', killAfterMeeting: 'No-kill time after a Campfire',
  undoSeconds: 'Undo window', gatherSeconds: 'Gather time', discussSeconds: 'Discussion time', voteSeconds: 'Voting time',
  resultSeconds: 'Result time', emergencies: 'Bell rings', stormSeconds: 'Storm length', stormFirst: 'First storm after',
  stormCooldown: 'Storm cooldown',
};

/** Shortest believable time for each puzzle, so a chore can't be ticked off without doing it. */
const MIN_SECONDS = { hold: 7, order: 3, simon: 3, match: 3 };
const BELL_AFTER_MEETING = 30;
const STORM_AFTER_MEETING = 60;
const WRONG_CODES = 5;
const LOCK_SECONDS = 30;
const WRONG_PINS = 5; // then that name is locked for PIN_LOCK_SECONDS, so nobody can guess their way into someone's role
const PIN_LOCK_SECONDS = 60;
const MAX_PLAYERS = 40;
const MAX_PHOTOS_PER_GAME = 20; // per player; keeps a runaway phone from filling the disk

const COLORS = ['#f85149', '#58a6ff', '#3fb950', '#d29922', '#bc8cff', '#ff7b72', '#39c5cf', '#f778ba', '#e3b341', '#7ee787', '#a5d6ff', '#ffa657'];
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const STATION = new Map(STATIONS.map((s) => [s.id, s]));
const CHORE = new Map(CHORES.map((c) => [c.id, c]));

const clean = (s, max = 20) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const token = () => randomBytes(16).toString('hex');
const shuffle = (xs) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** Settings loaded from disk, with anything out of range (or naming a station that no longer exists) put back to its default. */
function cleanSettings(s) {
  for (const [key, [lo, hi]] of Object.entries(RANGES)) if (!(Number.isInteger(s[key]) && s[key] >= lo && s[key] <= hi)) s[key] = DEFAULTS[key];
  for (const key of FLAGS) s[key] = !!s[key];
  if (s.barMode !== 'live' && s.barMode !== 'meetings') s.barMode = DEFAULTS.barMode;
  const ids = Array.isArray(s.stormStations) ? s.stormStations : [];
  if (ids.length !== 2 || ids[0] === ids[1] || !ids.every((id) => STATION.has(id) && id !== CAMPFIRE)) s.stormStations = [...STORM_DEFAULT];
  s.disabled = (Array.isArray(s.disabled) ? s.disabled : []).filter((id) => STATION.has(id) && id !== CAMPFIRE);
  return s;
}

/**
 * Lake Lurkers: players, settings and the game in progress. Every rule is enforced here; the server only relays.
 * Emits 'change' after every mutation and 'signout' (playerId) when the host kicks someone.
 */
export class LakeStore extends EventEmitter {
  constructor({ now = Date.now } = {}) {
    super();
    this.now = now;
    this.players = new Map(); // id -> { id, name, pin, tokens, color, sitOut, joinedAt }
    this.seq = 0;
    this.hostTokens = [];
    this.settings = structuredClone(DEFAULTS);
    this.codes = {}; // station id -> code printed under its QR
    this.phase = 'lobby';
    this.gameNo = 0;
    this.paused = false;
    this.pausedAt = null;
    this.game = null;
    this.photos = []; // { id, mime, gameNo, by, byId, partner, title, at, bytes }
    this.savedAt = null; // when the loaded state was saved (see pauseAfterRestart)
    this.loginFails = new Map(); // lowercased name -> { n, until }; not saved
    this.ensureCodes();
  }

  static fromJSON(data, opts) {
    const store = new LakeStore(opts);
    Object.assign(store, { ...data, players: new Map(data.players.map((p) => [p.id, p])), loginFails: new Map() });
    store.settings = cleanSettings({ ...structuredClone(DEFAULTS), ...data.settings });
    store.ensureCodes();
    return store;
  }

  toJSON() {
    const { players, seq, hostTokens, settings, codes, phase, gameNo, paused, pausedAt, game, photos } = this;
    return { players: [...players.values()], seq, hostTokens, settings, codes, phase, gameNo, paused, pausedAt, game, photos, savedAt: this.now() };
  }

  /**
   * After a server restart in the middle of a game: freeze it as of the last save, so the downtime can't run out a
   * storm, a Campfire stage or an undo window. The host presses Resume. Returns true if it paused the game.
   */
  pauseAfterRestart() {
    if ((this.phase !== 'play' && this.phase !== 'meeting') || this.paused) return false;
    this.paused = true;
    this.pausedAt = Math.min(this.savedAt ?? this.now(), this.now());
    return true;
  }

  changed() {
    this.emit('change');
  }

  ensureCodes() {
    const used = new Set(Object.values(this.codes));
    for (const s of STATIONS) {
      if (this.codes[s.id]) continue;
      let code;
      do code = Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
      while (used.has(code) || code === 'JOIN');
      used.add(code);
      this.codes[s.id] = code;
    }
  }

  // ---- accounts

  login({ name, pin } = {}) {
    name = clean(name);
    pin = String(pin ?? '').trim();
    if (!name) throw new LakeError('Enter your name');
    if (!/^\d{4}$/.test(pin)) throw new LakeError('Your PIN is 4 digits');
    let player = [...this.players.values()].find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (player) {
      // signing in as someone shows their role, so PIN guessing is slowed down to a handful a minute per name
      const key = player.name.toLowerCase();
      const now = this.now();
      const fails = this.loginFails.get(key);
      if (fails?.until > now) throw new LakeError(`Too many wrong PINs for that name. Try again in ${Math.ceil((fails.until - now) / 1000)} s`);
      if (player.pin !== pin) {
        const n = (fails?.n ?? 0) + 1;
        this.loginFails.set(key, n >= WRONG_PINS ? { n: 0, until: now + PIN_LOCK_SECONDS * 1000 } : { n, until: 0 });
        throw new LakeError('That name is taken. Wrong PIN?');
      }
      this.loginFails.delete(key);
    }
    if (!player && this.players.size >= MAX_PLAYERS) throw new LakeError('The game is full. Ask the host to remove old players.');
    if (!player) {
      const taken = new Set([...this.players.values()].map((p) => p.color));
      player = {
        id: `p${++this.seq}`,
        name,
        pin,
        tokens: [],
        color: COLORS.find((c) => !taken.has(c)) ?? COLORS[this.seq % COLORS.length],
        sitOut: false,
        joinedAt: this.now(),
      };
      this.players.set(player.id, player);
    }
    const t = token();
    player.tokens = [...player.tokens.slice(-4), t];
    this.changed();
    return { token: t, player };
  }

  playerByToken(t) {
    if (!t) return null;
    for (const p of this.players.values()) if (p.tokens.includes(t)) return p;
    return null;
  }

  setSitOut(playerId, value) {
    const p = this.players.get(playerId);
    if (!p) throw new LakeError('No such player');
    p.sitOut = !!value;
    this.changed();
  }

  addHostToken() {
    const t = token();
    this.hostTokens = [...this.hostTokens.slice(-19), t];
    this.changed();
    return t;
  }

  isHostToken(t) {
    return !!t && this.hostTokens.includes(t);
  }

  kick(playerId) {
    const p = this.players.get(playerId);
    if (!p) throw new LakeError('No such player');
    const g = this.game;
    const gp = this.gp(playerId);
    if (gp && (this.phase === 'play' || this.phase === 'meeting')) {
      gp.kicked = true;
      gp.status = 'ghost';
      this.cancelRequests(playerId);
      const m = g.meeting;
      if (m && !m.result) {
        // they leave the vote: their own vote goes, and votes for them are handed back so those players can vote again
        m.voters = m.voters.filter((id) => id !== playerId);
        m.here = m.here.filter((id) => id !== playerId);
        delete m.votes[playerId];
        for (const [voter, target] of Object.entries(m.votes)) if (target === playerId) delete m.votes[voter];
      }
      this.log(`${p.name} left the game`);
      if (!this.checkWin() && m && !this.paused && this.allIn(m)) this.advance();
    }
    this.players.delete(playerId);
    this.emit('signout', playerId);
    this.changed();
  }

  // ---- settings

  setSettings(patch = {}) {
    // mid-game changes could strand chores at a station switched off, or move a storm station; the host form is lobby-only too
    if (this.phase === 'play' || this.phase === 'meeting') throw new LakeError('Change the settings between games');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new LakeError('Send the settings to change');
    const next = { ...this.settings };
    for (const [key, value] of Object.entries(patch)) {
      if (Object.hasOwn(RANGES, key)) {
        const n = Number(value);
        const [lo, hi] = RANGES[key];
        if (!Number.isInteger(n) || n < lo || n > hi) throw new LakeError(`${LABELS[key]} must be a whole number from ${lo} to ${hi}`);
        next[key] = n;
      } else if (FLAGS.includes(key)) {
        next[key] = !!value;
      } else if (key === 'barMode') {
        if (value !== 'live' && value !== 'meetings') throw new LakeError('barMode is live or meetings');
        next[key] = value;
      } else if (key === 'stormStations') {
        const ids = Array.isArray(value) ? value : [];
        if (ids.length !== 2 || ids[0] === ids[1] || !ids.every((id) => STATION.has(id) && id !== CAMPFIRE)) {
          throw new LakeError('Pick two different storm stations (not the Campfire)');
        }
        next[key] = [...ids];
      } else if (key === 'disabled') {
        const ids = Array.isArray(value) ? value : [];
        if (!ids.every((id) => STATION.has(id))) throw new LakeError('Unknown station');
        if (ids.includes(CAMPFIRE)) throw new LakeError("The Campfire can't be switched off");
        next[key] = [...new Set(ids)];
      } else {
        throw new LakeError(`Unknown setting: ${key}`);
      }
    }
    this.settings = next;
    this.changed();
  }

  enabled(stationId) {
    return STATION.has(stationId) && !this.settings.disabled.includes(stationId);
  }

  // ---- starting and ending

  participants() {
    return [...this.players.values()].filter((p) => !p.sitOut);
  }

  lurkerCount(n) {
    return this.settings.lurkers || (n <= 6 ? 1 : 2);
  }

  startProblem() {
    if (this.phase === 'play' || this.phase === 'meeting') return 'A game is already on';
    const n = this.participants().length;
    if (n < 3) return 'Need at least 3 players';
    const l = this.lurkerCount(n);
    if (n - l <= l) return 'Need more Campers than Lurkers';
    const s = this.settings;
    if (s.taskCount + s.photoCount + s.carryCount === 0) return 'Give everyone at least one chore';
    if (s.storm && !s.stormStations.every((id) => this.enabled(id))) return 'Switch the storm stations on (or turn storms off)';
    if (!this.deal().length) return 'No chores at the stations that are switched on';
    return null;
  }

  start() {
    const problem = this.startProblem();
    if (problem) throw new LakeError(problem);
    const now = this.now();
    const s = this.settings;
    const people = shuffle(this.participants());
    const l = this.lurkerCount(people.length);
    const players = {};
    people.forEach((p, i) => {
      players[p.id] = {
        role: i < l ? 'lurker' : 'camper',
        status: 'alive',
        ejected: false,
        kicked: false,
        death: null,
        chores: this.deal(),
        emergencies: s.emergencies,
        killReadyAt: now + s.startGrace * 1000,
        wrong: 0,
        lockUntil: 0,
      };
    });
    const order = [...this.players.values()].filter((p) => players[p.id]).map((p) => p.id);
    this.gameNo += 1;
    this.game = {
      no: this.gameNo,
      startedAt: now,
      players,
      order,
      names: Object.fromEntries(order.map((id) => [id, this.players.get(id).name])),
      colors: Object.fromEntries(order.map((id) => [id, this.players.get(id).color])),
      stormReadyAt: now + s.stormFirst * 1000,
      bellReadyAt: now + BELL_AFTER_MEETING * 1000,
      storm: null,
      meeting: null,
      meetings: 0,
      requests: [],
      timeline: [],
      over: null,
      barSnapshot: null,
    };
    this.game.barSnapshot = this.liveBar();
    this.phase = 'play';
    this.paused = false;
    this.pausedAt = null;
    this.log(`Game ${this.gameNo} started with ${order.length} players (${l} Lurker${l === 1 ? '' : 's'})`);
    this.changed();
  }

  /** A fresh chore list: tasks spread over floors, then photos and carries, all at switched-on stations. */
  deal() {
    const s = this.settings;
    const tasks = [];
    const pool = shuffle(CHORES.filter((c) => c.kind === 'task' && this.enabled(c.station)));
    let floors = new Set();
    while (tasks.length < s.taskCount && pool.length) {
      const i = pool.findIndex((c) => !floors.has(STATION.get(c.station).floor));
      if (i < 0) {
        floors = new Set();
        continue;
      }
      const [c] = pool.splice(i, 1);
      floors.add(STATION.get(c.station).floor);
      tasks.push(c);
    }
    const photos = shuffle(CHORES.filter((c) => c.kind === 'photo' && this.enabled(c.station))).slice(0, s.photoCount);
    const carries = shuffle(CHORES.filter((c) => c.kind === 'carry' && this.enabled(c.from) && this.enabled(c.to))).slice(0, s.carryCount);
    return [...tasks, ...photos, ...carries].map((c, i) => ({ id: `c${i + 1}`, ref: c.id, step: 0, done: false, doneAt: null, startedAt: null, pending: null }));
  }

  end() {
    if (!this.game || this.phase === 'lobby') throw new LakeError('No game to end');
    if (this.phase !== 'over') this.log('The host ended the game');
    this.phase = 'lobby';
    this.paused = false;
    this.pausedAt = null;
    if (this.game) {
      this.game.meeting = null;
      this.game.storm = null;
    }
    this.changed();
  }

  toLobby() {
    if (this.phase !== 'over') throw new LakeError('The game is still on');
    this.phase = 'lobby';
    this.changed();
  }

  finish(winner, reason) {
    const g = this.game;
    g.over = { winner, reason, at: this.now() };
    g.meeting = null;
    g.storm = null;
    this.phase = 'over';
    this.paused = false;
    this.log(`${winner === 'campers' ? 'Campers' : 'Lurkers'} win: ${reason}`);
  }

  /** Ends the game if a side has won. Returns true if it ended. */
  checkWin() {
    if (this.phase !== 'play' && this.phase !== 'meeting') return false;
    const ps = Object.values(this.game.players).filter((p) => p.status === 'alive');
    const lurkers = ps.filter((p) => p.role === 'lurker').length;
    const campers = ps.length - lurkers;
    if (lurkers === 0) this.finish('campers', 'every Lurker is out');
    else if (lurkers >= campers) this.finish('lurkers', 'the Lurkers caught up with the Campers');
    else {
      const bar = this.liveBar();
      if (bar.total > 0 && bar.done >= bar.total) this.finish('campers', 'every chore got done');
      else return false;
    }
    return true;
  }

  // ---- helpers for game actions

  log(text) {
    this.game?.timeline.push({ at: this.now(), text });
  }

  name(id) {
    return (this.game && typeof id === 'string' && Object.hasOwn(this.game.names, id) ? this.game.names[id] : null) ?? this.players.get(id)?.name ?? '(gone)';
  }

  /** A player of the current game by id; null for anything else (ids come from clients, so never "__proto__" & co). */
  gp(id) {
    const ps = this.game?.players;
    return ps && typeof id === 'string' && Object.hasOwn(ps, id) ? ps[id] : null;
  }

  me(playerId, { alive = true, ghost = false } = {}) {
    if (this.phase !== 'play' && this.phase !== 'meeting') throw new LakeError('No game is on');
    if (this.paused) throw new LakeError('The game is paused');
    const p = this.gp(playerId);
    if (!p || p.kicked) throw new LakeError("You're not in this game");
    const ok = (alive && p.status === 'alive') || (ghost && p.status === 'ghost');
    if (!ok) throw new LakeError(p.status === 'dead' ? "You're dead. Stay put and stay silent." : "Ghosts can't do that");
    return p;
  }

  inPlay(playerId, opts) {
    const p = this.me(playerId, opts);
    if (this.phase !== 'play') throw new LakeError('Not during a Campfire');
    return p;
  }

  stationOfCode(code) {
    const c = String(code ?? '').trim().toUpperCase();
    const id = Object.keys(this.codes).find((k) => this.codes[k] === c);
    return id && this.enabled(id) ? id : null;
  }

  station(code) {
    const id = this.stationOfCode(code);
    if (!id) throw new LakeError("That code doesn't match any station");
    const { name, floor, where } = STATION.get(id);
    return { id, name, floor, where };
  }

  chore(p, choreId) {
    const c = p.chores.find((x) => x.id === choreId);
    if (!c) throw new LakeError('No such chore');
    if (c.done) throw new LakeError('Already done');
    return c;
  }

  liveBar() {
    let done = 0;
    let total = 0;
    for (const p of Object.values(this.game.players)) {
      if (p.role !== 'camper' || p.kicked) continue;
      total += p.chores.length;
      done += p.chores.filter((c) => c.done).length;
    }
    return { done, total };
  }

  complete(p, c) {
    c.done = true;
    c.doneAt = this.now();
    c.pending = null;
    if (p.role === 'camper') this.checkWin();
  }

  /**
   * Drops photo requests to (and unless `toOnly`, from) a player. Only call it once their being out is public (kick,
   * Campfire reveal, ejection): the requester's phone sees its photo stop waiting, so doing it at a kill would give the
   * kill away. A request to a secretly dead partner just goes unanswered.
   */
  cancelRequests(playerId, { toOnly = false } = {}) {
    const g = this.game;
    const hit = (r) => r.to === playerId || (!toOnly && r.from === playerId);
    for (const r of g.requests.filter(hit)) {
      const c = this.gp(r.from)?.chores.find((x) => x.id === r.choreId);
      if (c && c.pending === r.id) c.pending = null;
    }
    g.requests = g.requests.filter((r) => !hit(r));
  }

  // ---- chores

  choreStart(playerId, { choreId, code } = {}) {
    const p = this.inPlay(playerId, { ghost: true });
    const c = this.chore(p, choreId);
    const def = CHORE.get(c.ref);
    if (def.kind !== 'task') throw new LakeError('Not a puzzle chore');
    if (this.stationOfCode(code) !== def.station) throw new LakeError(`This chore is at the ${STATION.get(def.station).name}`);
    c.startedAt = this.now();
    this.changed();
    return {};
  }

  choreDone(playerId, { choreId, code } = {}) {
    const p = this.inPlay(playerId, { ghost: true });
    const c = this.chore(p, choreId);
    const def = CHORE.get(c.ref);
    const at = this.stationOfCode(code);
    if (def.kind === 'task') {
      if (at !== def.station) throw new LakeError(`This chore is at the ${STATION.get(def.station).name}`);
      if (!c.startedAt || this.now() - c.startedAt < MIN_SECONDS[def.puzzle] * 1000) throw new LakeError('Too quick! Do the whole thing.');
      this.complete(p, c);
    } else if (def.kind === 'carry') {
      const want = c.step === 0 ? def.from : def.to;
      if (at !== want) throw new LakeError(`${c.step === 0 ? 'Pick up' : 'Drop off'} ${def.item} at the ${STATION.get(want).name}`);
      if (c.step === 0) c.step = 1;
      else this.complete(p, c);
    } else {
      throw new LakeError('Photo chores need a photo');
    }
    this.changed();
    return { step: c.step, done: c.done };
  }

  /** Checks a photo upload before the server saves the file. Returns whether a partner has to confirm. */
  checkPhoto(playerId, { choreId, code, partnerId } = {}) {
    const p = this.inPlay(playerId, { ghost: true });
    const c = this.chore(p, choreId);
    const def = CHORE.get(c.ref);
    if (def.kind !== 'photo') throw new LakeError('Not a photo chore');
    if (this.stationOfCode(code) !== def.station) throw new LakeError(`Take this photo at the ${STATION.get(def.station).name}`);
    const needsPartner = def.partner && p.status === 'alive';
    if (needsPartner) {
      const q = this.gp(partnerId);
      // a secretly dead partner is accepted (the request just never gets an answer), so the error can't reveal a death
      if (!q || partnerId === playerId || q.status === 'ghost' || q.kicked) throw new LakeError('Pick another player who was in the photo');
    }
    const mine = this.photos.filter((ph) => ph.gameNo === this.gameNo && ph.byId === playerId).length;
    if (mine >= MAX_PHOTOS_PER_GAME) throw new LakeError(`That's ${MAX_PHOTOS_PER_GAME} photos from you this game, the most there can be`);
    return { needsPartner };
  }

  addPhoto(playerId, args, { id, mime, bytes = null }) {
    const { needsPartner } = this.checkPhoto(playerId, args);
    const p = this.gp(playerId);
    const c = this.chore(p, args.choreId);
    const def = CHORE.get(c.ref);
    this.photos.push({ id, mime, gameNo: this.gameNo, by: this.name(playerId), byId: playerId, partner: null, title: def.title, at: this.now(), bytes });
    let requestId = null;
    if (c.pending) this.game.requests = this.game.requests.filter((r) => r.id !== c.pending); // a retake replaces the old request
    if (needsPartner) {
      requestId = token().slice(0, 12);
      c.pending = requestId;
      this.game.requests.push({ id: requestId, from: playerId, to: args.partnerId, choreId: c.id, photoId: id, at: this.now() });
    } else {
      this.complete(p, c);
    }
    this.changed();
    return { done: c.done, requestId };
  }

  confirmPhoto(playerId, { requestId, yes } = {}) {
    const g = this.game;
    const r = g?.requests.find((x) => x.id === requestId && x.to === playerId);
    if (!r) throw new LakeError('That request is gone');
    this.inPlay(playerId);
    g.requests = g.requests.filter((x) => x !== r);
    const from = this.gp(r.from);
    const c = from?.chores.find((x) => x.id === r.choreId);
    if (c && c.pending === r.id) c.pending = null;
    if (yes) {
      const photo = this.photos.find((x) => x.id === r.photoId);
      if (photo) photo.partner = this.name(playerId);
      if (c && !c.done) this.complete(from, c);
    }
    this.changed();
    return {};
  }

  // ---- kills

  kill(playerId, { targetId } = {}) {
    const p = this.inPlay(playerId);
    if (p.role !== 'lurker') throw new LakeError("Campers can't do that");
    const now = this.now();
    if (now < p.killReadyAt) throw new LakeError(`Wait ${Math.ceil((p.killReadyAt - now) / 1000)} s`);
    const t = this.gp(targetId);
    if (!t || t.kicked || t.role !== 'camper' || t.status !== 'alive') throw new LakeError('Pick a living Camper');
    const used = new Set(Object.values(this.game.players).map((x) => x.death?.bodyCode));
    let bodyCode;
    do bodyCode = String(randomInt(100, 1000));
    while (used.has(bodyCode));
    t.status = 'dead';
    t.death = { by: playerId, at: now, bodyCode, undoUntil: now + this.settings.undoSeconds * 1000, prevKillReadyAt: p.killReadyAt };
    p.killReadyAt = now + this.settings.killCooldown * 1000;
    // photo requests to/from the victim stay put: dropping them now would tell the other player about the kill
    this.log(`${this.name(playerId)} killed ${this.name(targetId)}`);
    this.checkWin();
    this.changed();
    return {};
  }

  undoDeath(playerId) {
    if (this.phase !== 'play') throw new LakeError('Too late to undo');
    if (this.paused) throw new LakeError('The game is paused');
    const p = this.gp(playerId);
    if (!p || p.kicked || p.status !== 'dead' || this.now() > p.death.undoUntil) throw new LakeError('Too late to undo');
    const killer = this.gp(p.death.by);
    // if the killer has killed again since (short cooldown), their cooldown is from that kill: leave it, and let that
    // kill's undo restore what it was before this one
    const next = Object.values(this.game.players)
      .filter((x) => x !== p && x.status === 'dead' && x.death?.by === p.death.by && x.death.at >= p.death.at)
      .sort((a, b) => a.death.at - b.death.at)[0];
    if (next) next.death.prevKillReadyAt = p.death.prevKillReadyAt;
    else if (killer) killer.killReadyAt = p.death.prevKillReadyAt;
    this.log(`${this.name(playerId)} said they weren't tapped, so the kill was undone`);
    p.status = 'alive';
    p.death = null;
    this.changed();
    return {};
  }

  // ---- meetings

  report(playerId, { bodyCode } = {}) {
    const p = this.inPlay(playerId);
    const now = this.now();
    if (now < p.lockUntil) throw new LakeError(`Too many wrong codes. Try again in ${Math.ceil((p.lockUntil - now) / 1000)} s`);
    const code = String(bodyCode ?? '').trim();
    const bodyId = Object.keys(this.game.players).find((id) => {
      const b = this.game.players[id];
      return b.status === 'dead' && b.death?.bodyCode === code;
    });
    if (!bodyId) {
      p.wrong += 1;
      if (p.wrong >= WRONG_CODES) {
        p.wrong = 0;
        p.lockUntil = now + LOCK_SECONDS * 1000;
      }
      this.changed();
      throw new LakeError('No body has that code');
    }
    p.wrong = 0;
    this.log(`${this.name(playerId)} found ${this.name(bodyId)}'s body`);
    this.startMeeting('body', playerId, bodyId);
    return {};
  }

  bell(playerId, { code } = {}) {
    const p = this.inPlay(playerId);
    const g = this.game;
    if (this.stationOfCode(code) !== CAMPFIRE) throw new LakeError('Ring the bell at the Campfire');
    if (p.emergencies <= 0) throw new LakeError("You've used your bell");
    if (g.storm) throw new LakeError('Not during a storm');
    if (this.now() < g.bellReadyAt) throw new LakeError(`The bell is ready in ${Math.ceil((g.bellReadyAt - this.now()) / 1000)} s`);
    p.emergencies -= 1;
    this.log(`${this.name(playerId)} rang the bell`);
    this.startMeeting('bell', playerId, null);
    return {};
  }

  startMeeting(reason, callerId, bodyId) {
    const g = this.game;
    const now = this.now();
    const newlyOut = [];
    for (const id of g.order) {
      const p = g.players[id];
      if (p.status === 'dead') {
        p.status = 'ghost';
        newlyOut.push(this.name(id));
        this.cancelRequests(id, { toOnly: true }); // ghosts can't be photo partners; the requester can retake now
      }
    }
    if (g.storm) {
      g.storm = null;
      g.stormReadyAt = now + this.settings.stormCooldown * 1000;
      this.log('The Campfire called off the storm');
    }
    g.meetings += 1;
    g.barSnapshot = this.liveBar();
    g.meeting = {
      stage: 'gather',
      endsAt: now + this.settings.gatherSeconds * 1000,
      reason,
      caller: callerId,
      body: bodyId,
      newlyOut,
      here: [],
      voters: g.order.filter((id) => g.players[id].status === 'alive'),
      votes: {},
      result: null,
    };
    this.phase = 'meeting';
    this.changed();
  }

  here(playerId) {
    this.me(playerId);
    const m = this.game.meeting;
    if (this.phase !== 'meeting' || m.stage !== 'gather') throw new LakeError('Not gathering now');
    if (!m.here.includes(playerId)) m.here.push(playerId);
    if (this.allIn(m)) this.advance();
    this.changed();
    return {};
  }

  /** Everyone who can is here (gather) or has voted (vote), so the stage can end early. */
  allIn(m) {
    if (m.stage === 'gather') return m.voters.every((id) => m.here.includes(id));
    if (m.stage === 'vote') return m.voters.every((id) => m.votes[id]);
    return false;
  }

  vote(playerId, { target } = {}) {
    this.me(playerId);
    const m = this.game.meeting;
    if (this.phase !== 'meeting' || m.stage !== 'vote') throw new LakeError('Voting isn\'t open');
    if (!m.voters.includes(playerId)) throw new LakeError("You can't vote in this Campfire");
    if (m.votes[playerId]) throw new LakeError('You already voted');
    if (target !== 'skip' && !m.voters.includes(target)) throw new LakeError('Vote for a living player or skip');
    m.votes[playerId] = target;
    if (this.allIn(m)) this.advance();
    this.changed();
    return {};
  }

  /** Moves the Campfire to its next stage (timer ran out, everyone's in, or the host skipped). */
  advance() {
    const g = this.game;
    const m = g.meeting;
    const now = this.now();
    const s = this.settings;
    if (m.stage === 'gather') {
      m.stage = 'discuss';
      m.endsAt = now + s.discussSeconds * 1000;
    } else if (m.stage === 'discuss') {
      m.stage = 'vote';
      m.endsAt = now + s.voteSeconds * 1000;
    } else if (m.stage === 'vote') {
      m.stage = 'result';
      m.endsAt = now + s.resultSeconds * 1000;
      m.result = this.count(m);
      const out = m.result.ejected;
      if (out) {
        const p = g.players[out];
        p.status = 'ghost';
        p.ejected = true;
        this.cancelRequests(out, { toOnly: true });
        this.log(`${this.name(out)} was voted out (${p.role === 'lurker' ? 'a Lurker' : 'a Camper'})`);
      } else {
        this.log('Nobody was voted out');
      }
    } else {
      g.meeting = null;
      this.phase = 'play';
      for (const p of Object.values(g.players)) if (p.role === 'lurker') p.killReadyAt = now + s.killAfterMeeting * 1000;
      g.bellReadyAt = now + BELL_AFTER_MEETING * 1000;
      g.stormReadyAt = Math.max(g.stormReadyAt, now + STORM_AFTER_MEETING * 1000);
      this.checkWin();
    }
    this.changed();
  }

  count(m) {
    const tally = new Map();
    let skip = 0;
    for (const id of m.voters) {
      const v = m.votes[id];
      if (v === 'skip') skip += 1;
      else if (v) tally.set(v, (tally.get(v) ?? 0) + 1);
    }
    const max = Math.max(0, ...tally.values());
    const top = [...tally].filter(([, n]) => n === max).map(([id]) => id);
    let ejected = null;
    let reason;
    if (max === 0 && skip === 0) reason = 'novotes';
    else if (skip >= max) reason = 'skip';
    else if (top.length > 1) reason = 'tie';
    else {
      reason = 'votes';
      ejected = top[0];
    }
    return { ejected, reason, tally: [...tally].sort((a, b) => b[1] - a[1]), skip };
  }

  // ---- storms

  storm(playerId) {
    const p = this.inPlay(playerId, { ghost: true });
    const g = this.game;
    if (p.role !== 'lurker') throw new LakeError("Campers can't do that");
    if (!this.settings.storm) throw new LakeError('Storms are off');
    if (g.storm) throw new LakeError("There's already a storm");
    const now = this.now();
    if (now < g.stormReadyAt) throw new LakeError(`Storm ready in ${Math.ceil((g.stormReadyAt - now) / 1000)} s`);
    g.storm = { startedAt: now, endsAt: now + this.settings.stormSeconds * 1000, stations: [...this.settings.stormStations], securedBy: {} };
    this.log(`${this.name(playerId)} started a storm`);
    this.changed();
    return {};
  }

  stormFix(playerId, { code } = {}) {
    this.inPlay(playerId);
    const g = this.game;
    const st = g.storm;
    if (!st) throw new LakeError('No storm right now');
    const at = this.stationOfCode(code);
    if (!st.stations.includes(at)) throw new LakeError('This station is safe. Go to a storm station.');
    if (st.securedBy[at]) throw new LakeError('Already secured');
    if (Object.values(st.securedBy).includes(playerId)) throw new LakeError('Someone else has to secure this one');
    st.securedBy[at] = playerId;
    if (st.stations.every((id) => st.securedBy[id])) {
      g.storm = null;
      g.stormReadyAt = this.now() + this.settings.stormCooldown * 1000;
      this.log(`${st.stations.map((id) => this.name(st.securedBy[id])).join(' and ')} secured the storm`);
    }
    this.changed();
    return {};
  }

  // ---- host controls

  pause() {
    if (this.phase !== 'play' && this.phase !== 'meeting') throw new LakeError('No game is on');
    if (this.paused) return;
    this.paused = true;
    this.pausedAt = this.now();
    this.changed();
  }

  resume() {
    if (!this.paused) return;
    const dt = Number.isFinite(this.pausedAt) ? Math.max(0, this.now() - this.pausedAt) : 0;
    const g = this.game;
    if (g.meeting) g.meeting.endsAt += dt;
    if (g.storm) g.storm.endsAt += dt;
    g.stormReadyAt += dt;
    g.bellReadyAt += dt;
    for (const p of Object.values(g.players)) {
      p.killReadyAt += dt;
      if (p.lockUntil) p.lockUntil += dt;
      if (p.death) p.death.undoUntil += dt;
      for (const c of p.chores) if (c.startedAt) c.startedAt += dt;
    }
    this.paused = false;
    this.pausedAt = null;
    this.changed();
  }

  skip() {
    if (this.phase !== 'meeting' || this.paused) throw new LakeError('No Campfire to skip ahead');
    this.advance();
  }

  /** Runs out timers. The server calls it twice a second. */
  tick() {
    if (this.paused || !this.game) return;
    const now = this.now();
    const g = this.game;
    // allIn too: a stage whose last missing player was kicked while paused still ends early
    if (this.phase === 'meeting' && g.meeting && (now >= g.meeting.endsAt || this.allIn(g.meeting))) this.advance();
    else if (this.phase === 'play' && g.storm && now >= g.storm.endsAt) {
      this.finish('lurkers', "the storm wasn't secured in time");
      this.changed();
    }
  }

  // ---- views

  photoView(ph, viewerToken) {
    return { id: ph.id, url: `/lake/photo/${ph.id}.jpg?t=${encodeURIComponent(viewerToken ?? '')}`, by: ph.by, partner: ph.partner, title: ph.title, gameNo: ph.gameNo, at: ph.at };
  }

  gallery(viewerToken) {
    return { photos: this.photos.map((ph) => this.photoView(ph, viewerToken)) };
  }

  photoMeta(id) {
    return this.photos.find((p) => p.id === id) ?? null;
  }

  /** What one screen sees. `playerId` null for the TV or a signed-out phone. Never includes anyone else's role. */
  view(playerId, viewerToken) {
    const g = this.game;
    const live = g && this.phase !== 'lobby';
    const me = this.players.get(playerId);
    // a saved game can name a station or chore that was since renamed in stations.js: show a stand-in, never throw
    const station = (id) => STATION.get(id) ?? { id, name: '?', floor: '', where: '' };
    const state = {
      now: this.now(),
      me: me ? { id: me.id, name: me.name, color: me.color, sitOut: me.sitOut } : null,
      players: [...this.players.values()].map((p) => {
        const gp = live ? g.players[p.id] : null;
        return { id: p.id, name: p.name, color: p.color, inGame: !!gp, out: !!gp && (gp.status === 'ghost' || gp.kicked), sitOut: p.sitOut };
      }),
      stations: STATIONS.filter((s) => this.enabled(s.id)).map(({ id, name, floor, where }) => ({ id, name, floor, where })),
      campfire: { id: CAMPFIRE, name: station(CAMPFIRE).name, where: station(CAMPFIRE).where },
      phase: this.phase,
      gameNo: this.gameNo,
      paused: this.paused,
      pausedAt: this.paused ? this.pausedAt : null,
      settings: this.settings,
      bar: live ? (this.settings.barMode === 'meetings' && this.phase !== 'over' ? g.barSnapshot : this.liveBar()) : null,
      storm: null,
      meeting: null,
      over: null,
      you: null,
    };
    if (!live) return state;
    if (g.storm) {
      state.storm = {
        endsAt: g.storm.endsAt,
        stations: g.storm.stations.map((id) => ({ id, name: station(id).name, where: station(id).where, secured: !!g.storm.securedBy[id] })),
      };
    }
    if (g.meeting) {
      const m = g.meeting;
      let result = null;
      if (m.result) {
        const r = m.result;
        const ej = r.ejected;
        result = {
          ejected: ej ? { id: ej, name: this.name(ej) } : null,
          reason: r.reason,
          tally: [...r.tally.map(([id, votes]) => ({ id, name: this.name(id), votes })), { id: 'skip', name: 'Skip', votes: r.skip }],
          votes: this.settings.anonymousVotes ? null : m.voters.filter((id) => m.votes[id]).map((id) => ({ voter: this.name(id), target: m.votes[id] === 'skip' ? 'Skip' : this.name(m.votes[id]) })),
          role: ej && this.settings.revealRole ? g.players[ej].role : null,
        };
      }
      state.meeting = {
        stage: m.stage,
        endsAt: m.endsAt,
        reason: m.reason,
        caller: this.name(m.caller),
        body: m.body ? this.name(m.body) : null,
        newlyOut: m.newlyOut,
        here: m.here,
        voters: m.voters,
        voted: m.voters.filter((id) => m.votes[id]),
        result,
      };
    }
    if (this.phase === 'over') {
      state.over = {
        winner: g.over?.winner ?? null,
        reason: g.over?.reason ?? 'the host ended the game',
        roles: g.order.map((id) => {
          const p = g.players[id];
          let fate = 'alive';
          if (p.kicked) fate = 'kicked';
          else if (p.ejected) fate = 'ejected';
          else if (p.death) fate = `killed by ${this.name(p.death.by)}`;
          return { id, name: this.name(id), color: g.colors[id], role: p.role, fate };
        }),
        timeline: g.timeline.map((e) => ({ t: Math.round((e.at - g.startedAt) / 1000), text: e.text })),
        photos: this.photos.filter((ph) => ph.gameNo === g.no).map((ph) => this.photoView(ph, viewerToken)),
      };
    }
    const p = this.gp(playerId);
    if (p && !p.kicked) {
      const lurker = p.role === 'lurker';
      state.you = {
        role: p.role,
        lurkers: lurker ? g.order.filter((id) => id !== playerId && g.players[id].role === 'lurker').map((id) => this.name(id)) : [],
        status: p.status,
        death: p.death ? { by: this.name(p.death.by), at: p.death.at, bodyCode: p.death.bodyCode, undoUntil: p.death.undoUntil } : null,
        ejected: p.ejected,
        chores: p.chores.filter((c) => CHORE.has(c.ref)).map((c) => {
          const d = CHORE.get(c.ref);
          const at = d.kind === 'carry' ? (c.step === 0 ? d.from : d.to) : d.station;
          return {
            id: c.id,
            kind: d.kind,
            title: d.title,
            puzzle: d.puzzle ?? null,
            prompt: d.prompt ?? null,
            partner: !!d.partner,
            item: d.item ?? null,
            stationId: at,
            stationName: station(at).name,
            where: station(at).where,
            fromId: d.from ?? null,
            fromName: d.from ? station(d.from).name : null,
            toId: d.to ?? null,
            toName: d.to ? station(d.to).name : null,
            step: c.step,
            done: c.done,
            pending: !!c.pending,
          };
        }),
        emergencies: p.emergencies,
        bellReadyAt: g.bellReadyAt,
        killReadyAt: lurker ? p.killReadyAt : null,
        targets: lurker && p.status === 'alive' ? g.order.filter((id) => g.players[id].role === 'camper' && g.players[id].status === 'alive').map((id) => ({ id, name: this.name(id) })) : [],
        stormReadyAt: lurker && this.settings.storm ? g.stormReadyAt : null,
        myVote: g.meeting?.votes[playerId] ?? null,
        confirms: g.requests.filter((r) => r.to === playerId).map((r) => {
          const d = CHORE.get(this.gp(r.from)?.chores.find((c) => c.id === r.choreId)?.ref);
          const ph = this.photoMeta(r.photoId);
          return { requestId: r.id, from: this.name(r.from), title: d?.title ?? 'Photo', prompt: d?.prompt ?? null, url: ph ? this.photoView(ph, viewerToken).url : null };
        }),
        lockUntil: p.lockUntil,
      };
    }
    return state;
  }

  hostView(online = new Set()) {
    const live = this.game && this.phase !== 'lobby';
    return {
      settings: this.settings,
      phase: this.phase,
      gameNo: this.gameNo,
      paused: this.paused,
      stations: STATIONS.map(({ id, name, floor, where }) => ({ id, name, floor, where, code: this.codes[id], enabled: this.enabled(id) })),
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, online: online.has(p.id), sitOut: p.sitOut, inGame: !!(live && this.game.players[p.id]) })),
      canStart: !this.startProblem(),
      startProblem: this.startProblem(),
    };
  }
}
