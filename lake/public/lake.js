/* global io */
/**
 * Lake Lurkers phone app at /lake (and /lake/s/:code when a station QR is scanned): sign in, lobby, play (the game's
 * countdown, "Rooms with chores": every phone sees each room's progress; my own chores there stay hidden until I scan
 * the room), the house map, the in-app QR scanner, station screen, phone games
 * (window.LakeGames from games.js; one try each: a lost or quit game moves to another room), activities (timed real-life
 * chores), the talk chore, photos, Campfires, game over,
 * gallery and the host's controls.
 * Every 'state' push re-renders, but each slot only rebuilds when the data it shows changed, so typing, holds and
 * puzzles aren't interrupted. A camper's and a lurker's screens look the same until the role card is held.
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------ helpers

  const $ = (sel) => document.querySelector(sel);

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props ?? {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style') el.style.cssText = v;
      else if (k in el && typeof el[k] !== 'function') el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) {
      if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
    }
    return el;
  }

  /** Text boxes for codes: no autocorrect, autofill or spellcheck getting in the way. */
  function plain(input) {
    for (const [k, v] of [['autocomplete', 'off'], ['autocorrect', 'off'], ['spellcheck', 'false']]) input.setAttribute(k, v);
    return input;
  }

  // localStorage, falling back to memory when it's blocked (private mode)
  const memory = new Map();
  const storage = {
    get: (k) => { try { return localStorage.getItem(k) ?? memory.get(k) ?? null; } catch { return memory.get(k) ?? null; } },
    set: (k, v) => { memory.set(k, v); try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del: (k) => { memory.delete(k); try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };

  // this tab only (a reload keeps it, other tabs of the game never see it); nothing when storage is blocked
  const session = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
    del: (k) => { try { sessionStorage.removeItem(k); } catch { /* private mode */ } },
  };

  function toast(msg, kind = 'info') {
    const el = h('div', { class: `toast ${kind}` }, msg);
    $('#toasts').append(el);
    setTimeout(() => el.classList.add('out'), 3200);
    setTimeout(() => el.remove(), 3700);
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const vibrate = (pattern) => { try { navigator.vibrate?.(pattern); } catch { /* not on iPhone */ } };
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const listNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
  const capital = (text) => (text ? text[0].toUpperCase() + text.slice(1) : '');

  function shuffle(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** "1:05" for a countdown in ms (rounded up, so it never shows 0:00 while time is left). */
  function fmtLeft(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  const fmtAt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec) % 60).padStart(2, '0')}`;
  function fmtSecs(s) {
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  }

  /** Rebuilds a slot only when `data` changed, so pushes don't interrupt taps, holds or typing. */
  function fill(el, data, build) {
    const key = JSON.stringify(data) ?? '';
    if (el._key === key) return el;
    el._key = key;
    el.replaceChildren(...[build(data)].flat(Infinity).filter((c) => c != null && c !== false && c !== ''));
    return el;
  }

  /** A live countdown to a server time; tick() keeps its text current. */
  const countdown = (until, { prefix = '', suffix = '', done = '', cls = '', low = 0 } = {}) =>
    h('span', { class: `cd ${cls}`, 'data-until': until ?? 0, 'data-prefix': prefix, 'data-suffix': suffix, 'data-done': done, 'data-low': low || null });

  const pdot = (color) => h('span', { class: 'pdot', style: `background:${color ?? 'var(--border)'}` });
  const tag = (text, cls = '') => h('span', { class: `tag ${cls}` }, text);
  const box = (...children) => h('section', { class: 'box' }, ...children);
  const slot = (cls = '') => h('div', { class: `slot ${cls}` });

  /**
   * Press-and-hold on `el` for `ms`. Letting go early cancels (and resets the progress).
   * Used by the role card, the hold puzzle and "Secure for the storm".
   */
  function pressHold(el, ms, { onStart, onProgress, onCancel, onDone } = {}) {
    let start = 0;
    let raf = 0;
    let pointer = null;
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      pointer = null;
      el.classList.remove('holding');
    };
    const frame = () => {
      const f = Math.min(1, (performance.now() - start) / ms);
      onProgress?.(f);
      if (f >= 1) {
        stop();
        onDone?.();
      } else raf = requestAnimationFrame(frame);
    };
    el.addEventListener('pointerdown', (e) => {
      if (pointer !== null || el.disabled || e.button > 0) return;
      e.preventDefault();
      pointer = e.pointerId;
      try { el.setPointerCapture(pointer); } catch { /* old browsers */ }
      start = performance.now();
      el.classList.add('holding');
      onStart?.();
      raf = requestAnimationFrame(frame);
    });
    const end = (e) => {
      if (pointer === null || e.pointerId !== pointer) return;
      stop();
      onProgress?.(0);
      onCancel?.();
    };
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(ev, end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    return el;
  }

  // ------------------------------------------------------------------ socket

  const socket = io('/lake');
  function call(event, payload = {}) {
    return new Promise((resolve) => {
      const send = () => socket.timeout(8000).emit(event, payload, (err, res) =>
        resolve(err ? { ok: false, timeout: true, error: 'The game didn’t answer. Try again.' } : res ?? { ok: false, error: 'No answer' }));
      if (socket.connected) return send();
      // The phone just woke up or the Wi-Fi blinked: give the connection a moment instead of failing the tap. The
      // 'connect' handler registered first sends `resume` before this, so the server knows who's asking.
      const onConnect = () => {
        clearTimeout(timer);
        send();
      };
      const timer = setTimeout(() => {
        socket.off('connect', onConnect);
        resolve({ ok: false, offline: true, error: 'Not connected. Check your Wi-Fi and try again.' });
      }, 5000);
      socket.once('connect', onConnect);
    });
  }

  const KEY_TOKEN = 'lake.token';
  const KEY_HOST = 'lake.hostToken';
  const KEY_WAKE = 'lake.wake';
  const KEY_SOUND = 'lake.sound';
  const KEY_LAST = 'lake.lastStation';
  const KEY_PLAYING = 'lake.playing'; // the phone game this tab is in the middle of (sessionStorage)
  // seconds the server wants between choreStart and choreDone
  const PUZZLE_MIN = { hold: 115, wordle: 20, make24: 40, snake: 40, blackjack: 25, tap50: 30, crack: 20, order: 5, simon: 6, match: 4 };

  const store = {
    state: null, // last personalized 'state'
    host: null, // last 'host' view (only on a host-logged-in device)
    isHost: false,
    offset: 0, // server clock minus local clock
    offsetFresh: true, // next state sets the offset outright (new connection)
    frozenAt: null, // server time the game paused at, so countdowns hold still
    ready: false, // the first sign-in attempt of this page load is done
    expectMe: false, // signed in, waiting for a state that knows who we are
    resuming: false, // (re)connected with a token, `resume` not answered yet
  };
  const ui = {
    view: null, // full-screen sheet: station | puzzle | act | talk | photo | gallery | map | scan
    pendingCode: null, // station code from /lake/s/:code, opened once signed in
    lastStation: null, // { game, id } of the station scanned last, ringed on the map
    mapTab: null, // the map tab picked last
    mapZoom: false,
    confirmOver: false, // a waiting photo/talk check opened on top of a phone game
    voteFor: null, // picked but not yet confirmed
    snoozed: new Set(), // photo requests put off with "Not now"
    answered: new Set(), // photo requests answered, hidden until the server drops them
    seenConfirms: new Set(),
    leftChecked: false, // looked for a phone game this tab left mid-way (leftGameCheck), once per page load
    partnerOf: {}, // choreId -> partner name, for "waiting for X"
    talkTo: {}, // talk choreId -> id of the player asked last
    talked: {}, // talk choreId -> ids of players who said yes (as far as this phone saw)
  };

  /** Server time; frozen while the game is paused. */
  const now = () => (store.state?.paused && store.frozenAt != null ? store.frozenAt : Date.now() + store.offset);

  const scanned = location.pathname.match(/^\/lake\/s\/([^/?#]+)/);
  if (scanned) ui.pendingCode = decodeURIComponent(scanned[1]);
  try { ui.lastStation = JSON.parse(storage.get(KEY_LAST) ?? 'null'); } catch { /* not ours */ }
  /** The station I scanned last in this game, or null. */
  const lastStationId = (s) => (ui.lastStation && ui.lastStation.game === s?.gameNo ? ui.lastStation.id : null);
  // /lake/admin (or /lake/host) asks for the host password straight away
  let askHost = /^\/lake\/(admin|host)\/?$/.test(location.pathname);

  // the "Reconnecting…" pill shows after a couple of seconds without the server (also if it never connected)
  let offlineTimer = setTimeout(() => { $('#offline').hidden = false; }, 4000);
  socket.on('connect', async () => {
    clearTimeout(offlineTimer);
    $('#conn').classList.add('on');
    $('#conn').title = 'Connected';
    $('#offline').hidden = true;
    store.offsetFresh = true;
    const token = storage.get(KEY_TOKEN);
    store.resuming = !!token;
    if (token) await resume(token);
    const hostToken = storage.get(KEY_HOST);
    if (hostToken) {
      const res = await call('host:login', { hostToken });
      if (!res.ok && !res.timeout && !res.offline) storage.del(KEY_HOST);
      store.isHost = !!res.ok;
    }
    store.ready = true;
    render();
    if (askHost && !store.isHost) openHostLogin();
    askHost = false;
  });
  socket.on('disconnect', () => {
    $('#conn').classList.remove('on');
    $('#conn').title = 'Disconnected';
    store.resuming = !!storage.get(KEY_TOKEN);
    offlineTimer = setTimeout(() => { $('#offline').hidden = false; }, 2000);
  });

  async function resume(token) {
    const res = await call('resume', { token });
    if (res.ok) {
      store.resuming = false;
      waitForMe();
      openPending();
    } else if (res.timeout) {
      waitForMe();
      setTimeout(() => socket.connected && resume(token), 1500);
    } else {
      store.resuming = false;
      if (!res.offline) storage.del(KEY_TOKEN);
      render();
    }
    return res.ok;
  }

  /** Show "Connecting…" (not the sign-in form) until the state that knows us arrives. */
  function waitForMe() {
    if (store.state?.me) return;
    store.expectMe = true;
    clearTimeout(waitForMe.timer);
    waitForMe.timer = setTimeout(() => {
      store.expectMe = false;
      render();
    }, 5000);
  }

  function openPending() {
    const code = ui.pendingCode;
    if (!code) return;
    ui.pendingCode = null;
    history.replaceState(null, '', '/lake');
    openStation(code);
  }

  socket.on('state', (s) => {
    // A push that sat in a buffer while the phone slept arrives late, which only ever makes this sample too small, so
    // keep the largest one per connection.
    const seen = s.now - Date.now();
    store.offset = store.offsetFresh ? seen : Math.max(store.offset, seen);
    store.offsetFresh = false;
    // Every new connection first gets the signed-out view, then ours once `resume` lands. Showing the signed-out one
    // would flash the sign-in screen and close the open station, puzzle or photo on every Wi-Fi blip or redeploy.
    if (store.resuming && !s.me) return;
    const prev = store.state;
    if (!s.paused) store.frozenAt = null;
    else if (!prev?.paused || store.frozenAt == null) store.frozenAt = s.pausedAt ?? s.now;
    store.state = s;
    if (s.me) store.expectMe = false;
    noticeChanges(prev, s);
    render();
    leftGameCheck(s);
  });
  socket.on('host', (view) => {
    store.host = view;
    render();
  });
  socket.on('signedOut', ({ reason } = {}) => {
    storage.del(KEY_TOKEN);
    store.resuming = false;
    closeViews();
    toast(reason || 'You were signed out.', 'error');
    render();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!socket.connected) socket.connect();
      if (sound.on && sound.ctx && sound.ctx.state !== 'running') sound.ctx.resume().catch(() => {});
      syncWake();
    } else {
      closeRole(); // never leave the role card open in a pocket
      if (ui.view?.kind === 'scan') showView(ui.view.back); // and never leave the camera on
    }
  });

  // ------------------------------------------------------------------ sound, vibration, screen

  const sound = { ctx: null, on: storage.get(KEY_SOUND) !== '0' };
  // iPhones mute web audio with the silent switch unless the page asks for "playback" (Safari 16.4+). Most players
  // keep their phone on silent, and iPhones can't vibrate from a web page, so without this the Campfire alarm is mute.
  const audioSession = 'audioSession' in navigator ? navigator.audioSession : null;
  function syncAudioSession() {
    try { if (audioSession) audioSession.type = sound.on ? 'playback' : 'auto'; } catch { /* older Safari */ }
  }
  syncAudioSession();

  /** Browsers only allow audio after a tap; this runs on every tap and re-wakes audio after the phone slept. */
  function unlockAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !sound.on) return;
      sound.ctx ??= new AC();
      if (sound.ctx.state === 'running') return;
      sound.ctx.resume().catch(() => {});
      // iPhones also want a sound started inside the tap itself
      const src = sound.ctx.createBufferSource();
      src.buffer = sound.ctx.createBuffer(1, 1, 22050);
      src.connect(sound.ctx.destination);
      src.start(0);
    } catch { /* no audio on this device */ }
  }
  for (const ev of ['pointerdown', 'touchend', 'keydown']) {
    document.addEventListener(ev, () => { unlockAudio(); syncWake(); }, { capture: true, passive: true });
  }

  function tone(freq, at, dur, { type = 'sine', vol = 0.25, to = null } = {}) {
    const ctx = sound.ctx;
    if (!sound.on || !ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /**
   * Plays a sound now. If audio was put to sleep (iPhone lock screen, a call), it first tries to wake it, but plays only
   * if that works right away: an alarm that turns up minutes later on the next tap would just confuse.
   */
  const playing = (fn) => (...args) => {
    const ctx = sound.ctx;
    if (!sound.on || !ctx) return;
    if (ctx.state === 'running') return fn(...args);
    const asked = Date.now();
    ctx.resume().then(() => { if (Date.now() - asked < 1500 && ctx.state === 'running') fn(...args); }).catch(() => {});
  };

  const SFX = Object.fromEntries(Object.entries({
    alarm: () => { for (let i = 0; i < 10; i++) tone(i % 2 ? 660 : 880, i * 0.22, 0.2, { type: 'square', vol: 0.3 }); },
    siren: () => { for (let i = 0; i < 3; i++) { tone(480, i, 0.5, { type: 'sawtooth', vol: 0.22, to: 1100 }); tone(1100, i + 0.5, 0.5, { type: 'sawtooth', vol: 0.22, to: 480 }); } },
    // soft and short on purpose: a loud wail would tell the whole room a kill just happened, next to the Lurker
    death: () => tone(330, 0, 0.5, { type: 'sine', vol: 0.08, to: 180 }),
    chime: () => { tone(880, 0, 0.4, { vol: 0.3 }); tone(1320, 0.16, 0.6, { vol: 0.3 }); },
    ding: () => { tone(1568, 0, 0.6, { vol: 0.3 }); tone(2093, 0.09, 0.7, { vol: 0.15 }); },
    blip: () => tone(988, 0, 0.12, { vol: 0.2 }),
    buzz: () => tone(140, 0, 0.28, { type: 'square', vol: 0.18 }),
    stage: () => { tone(660, 0, 0.16); tone(880, 0.18, 0.22); },
    fanfare: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.15, i === 3 ? 0.9 : 0.4, { type: 'triangle', vol: 0.3 })),
    pad: (f) => tone(f, 0, 0.38, { type: 'triangle', vol: 0.3 }),
  }).map(([name, fn]) => [name, playing(fn)]));

  // Keep the screen on during a game (Screen Wake Lock). The lock drops when the tab hides, so it's re-taken.
  const wake = { lock: null, busy: false };
  const wakeSupported = 'wakeLock' in navigator;
  const wakeOn = () => storage.get(KEY_WAKE) !== '0';
  async function syncWake() {
    if (!wakeSupported || wake.busy) return;
    const s = store.state;
    const want = wakeOn() && !!s?.you && (s.phase === 'play' || s.phase === 'meeting') && document.visibilityState === 'visible';
    if (want && !wake.lock) {
      wake.busy = true;
      try {
        const lock = await navigator.wakeLock.request('screen');
        wake.lock = lock;
        lock.addEventListener('release', () => { if (wake.lock === lock) wake.lock = null; });
      } catch { /* not allowed yet; the next tap tries again */ }
      wake.busy = false;
    } else if (!want && wake.lock) {
      const lock = wake.lock;
      wake.lock = null;
      lock.release().catch(() => {});
    }
  }

  /** A full-screen alert (Campfire, storm). Tap to close. */
  function flash(kind, title, ...lines) {
    const el = $('#flash');
    el.className = `flash ${kind}`;
    el.replaceChildren(
      h('div', { class: 'flash-title' }, title),
      ...lines.filter(Boolean).map((l) => h('div', { class: 'flash-line' }, l)),
      h('div', { class: 'flash-hint' }, 'Tap to close'));
    el.hidden = false;
    clearTimeout(flash.timer);
    flash.timer = setTimeout(() => { el.hidden = true; }, 6000);
  }
  $('#flash').addEventListener('click', () => { $('#flash').hidden = true; });

  /** Sounds, buzzes and flashes for what just changed. Nothing here depends on the player's role. */
  function noticeChanges(prev, s) {
    const you = s.you;
    const pyou = prev?.you;
    for (const c of you?.confirms ?? []) {
      if (ui.seenConfirms.has(c.requestId)) continue;
      ui.seenConfirms.add(c.requestId);
      if (prev) {
        SFX.chime();
        vibrate([120, 60, 120]);
      }
    }
    if (!prev) return;
    const newGame = s.gameNo !== prev.gameNo;
    // say so before the Campfire closes it: a game cut short by a Campfire is not a loss
    if (s.phase === 'meeting' && prev.phase === 'play' && !newGame) interruptGame('Campfire');
    if (s.phase !== prev.phase || newGame) closeViews();
    if (s.phase === 'play' && (newGame || prev.phase === 'lobby' || prev.phase === 'over')) {
      ui.partnerOf = {};
      ui.talkTo = {};
      ui.talked = {};
      ui.snoozed.clear();
      ui.answered.clear();
      ui.voteFor = null;
      closeRole();
      SFX.chime();
      if (you) toast('Game on! Press and hold your card to see your role.');
    }
    if (s.phase === 'meeting' && prev.phase !== 'meeting') {
      ui.voteFor = null;
      closeRole();
      // the photo gallery and an enlarged photo would otherwise sit on top of the Campfire screen
      if (ui.view?.kind === 'gallery') {
        ui.view = null;
        if ($('#modal .lightbox')) closeModal();
      }
      SFX.alarm();
      vibrate([500, 150, 500, 150, 900]);
      flash('campfire', 'Campfire!', `Go to the ${s.campfire?.name ?? 'Campfire'}: ${s.campfire?.where ?? ''}`, s.meeting ? reasonLine(s, s.meeting) : '');
    } else if (s.meeting && prev.meeting && s.meeting.stage !== prev.meeting.stage) {
      ui.voteFor = null;
      SFX.stage();
      if (s.meeting.stage === 'vote') vibrate(250);
    }
    if (s.storm && !prev.storm) {
      // the storm alert takes over the screen, so a phone game would run on (and be lost) unseen under it: stop it
      interruptGame('storm');
      SFX.siren();
      vibrate([300, 100, 300, 100, 300]);
      flash('storm', 'Storm!', `Secure ${listNames(s.storm.stations.map((x) => x.name))}`, 'Two different players, before time runs out.');
    } else if (!s.storm && prev.storm && s.phase === 'play') {
      toast('The storm is over. Phew!');
    }
    if (s.phase === 'over' && prev.phase !== 'over') SFX.fanfare();
    if (prev.paused && !s.paused && (s.phase === 'play' || s.phase === 'meeting')) toast('The game is back on.');
    if (you && pyou && !newGame) {
      if (pyou.status === 'alive' && you.status === 'dead') {
        closeRole();
        SFX.death();
        vibrate(200);
      }
      if (pyou.status === 'dead' && you.status === 'alive') toast('You’re back in the game.');
      for (const c of you.chores) {
        const pc = pyou.chores.find((x) => x.id === c.id);
        if (!pc) continue;
        const partner = ui.partnerOf[c.id] ?? (c.kind === 'talk' ? 'They' : 'Your partner');
        const saidYes = c.kind === 'talk' && c.progress > pc.progress;
        if (saidYes && ui.talkTo[c.id] && !(ui.talked[c.id] ?? []).includes(ui.talkTo[c.id])) {
          ui.talked[c.id] = [...(ui.talked[c.id] ?? []), ui.talkTo[c.id]];
        }
        if (!pc.done && c.done) {
          SFX.ding();
          vibrate(60);
          if (c.kind === 'photo' && pc.pending) toast(`${partner} said yes. Photo done ✓`);
          if (saidYes) toast(`${partner} said yes. ${c.title} done ✓`);
        } else if (saidYes) {
          SFX.blip();
          toast(`${partner} said yes ✓ ${c.progress} of ${c.need} done. Find someone new!`);
        } else if (pc.pending && !c.pending && you.status === 'alive') {
          toast(c.kind === 'talk' ? `${partner} said no (or couldn’t answer). Ask someone else.` : `${partner} said no (or couldn’t answer). Take it again.`, 'error');
        }
      }
    }
  }

  // ------------------------------------------------------------------ render

  let mounted = { name: null };
  function mount(name) {
    if (mounted.name !== name) {
      mounted = { name, ...SCREENS[name]() };
      $('#app').replaceChildren(mounted.root);
      window.scrollTo(0, 0);
    }
    mounted.update?.();
  }

  function whichScreen() {
    const s = store.state;
    if (!storage.get(KEY_TOKEN)) return 'signin';
    if (!s?.me) return store.ready && !store.expectMe ? 'signin' : 'loading';
    if (s.phase === 'lobby') return 'lobby';
    if (s.phase === 'over') return 'over';
    if (!s.you) return 'watch';
    if (s.you.status === 'dead') return 'dead';
    return s.phase === 'meeting' ? 'meeting' : 'play';
  }

  function render() {
    guardViews();
    mount(whichScreen());
    renderWho();
    renderFooter();
    renderHost();
    renderSheet();
    renderConfirm();
    renderPause();
    syncWake();
    tick();
  }

  /** Updates every live countdown and every button that unlocks at a set time. Runs 4× a second. */
  function tick() {
    const t = now();
    for (const el of document.querySelectorAll('[data-until]')) {
      const left = Number(el.dataset.until) - t;
      const text = left > 0 ? `${el.dataset.prefix ?? ''}${fmtLeft(left)}${el.dataset.suffix ?? ''}` : el.dataset.done ?? '';
      if (el.textContent !== text) el.textContent = text;
      if (el.dataset.low) el.classList.toggle('low', left < Number(el.dataset.low)); // red when time is short
    }
    for (const el of document.querySelectorAll('[data-ready-at]')) {
      const off = el.dataset.blocked === '1' || t < Number(el.dataset.readyAt);
      if (el.disabled !== off) el.disabled = off;
    }
    for (const el of document.querySelectorAll('[data-hide-at]')) {
      const gone = t >= Number(el.dataset.hideAt);
      if (el.hidden !== gone) el.hidden = gone;
    }
  }
  setInterval(tick, 250);

  function renderWho() {
    const me = storage.get(KEY_TOKEN) ? store.state?.me : null;
    fill($('#who'), me ? [me.name, me.color, store.isHost] : null, () =>
      me ? [pdot(me.color), h('b', {}, me.name), store.isHost ? tag('host', 'host') : ''] : '');
  }

  const pname = (s, id) => s.players.find((p) => p.id === id)?.name ?? '?';
  const pcolor = (s, id) => s.players.find((p) => p.id === id)?.color;

  // ------------------------------------------------------------------ shared pieces

  const footerEl = h('div', { class: 'footer' });
  function renderFooter() {
    const s = store.state;
    const inGame = !!s?.you && (s.phase === 'play' || s.phase === 'meeting');
    const data = { phase: s?.phase, games: s?.gameNo, me: !!s?.me, inGame, sound: sound.on, wake: wakeOn(), host: store.isHost };
    fill(footerEl, data, () => [
      h('div', { class: 'row' },
        h('a', { class: 'btn-link', href: '/lake/rules', target: '_blank', rel: 'noopener' }, '📖 Rules'),
        s?.gameNo && s.me ? h('button', { type: 'button', onclick: openGallery }, '🖼 Photos') : '',
        h('button', { type: 'button', onclick: toggleSound }, sound.on ? '🔊 Sound on' : '🔇 Sound off'),
        inGame && wakeSupported ? h('button', { type: 'button', onclick: toggleWake }, wakeOn() ? '☀️ Screen stays on' : '🌙 Screen can sleep') : ''),
      inGame && !wakeSupported ? h('p', { class: 'small muted' }, 'Tip: set Auto-Lock to Never while you play, so the alarms reach you.') : '',
      sound.on ? h('p', { class: 'small muted' }, audioSession ? 'Turn your volume up so you hear the Campfire alarm.' : 'Turn your ringer on and the volume up to hear the Campfire alarm.') : '',
      h('div', { class: 'row' },
        s?.me ? h('button', { type: 'button', class: 'ghost', onclick: signOut }, 'Sign out') : '',
        h('span', { class: 'grow' }),
        store.isHost
          ? h('button', { type: 'button', class: 'ghost', onclick: stopHosting }, 'Stop hosting here')
          : h('button', { type: 'button', class: 'ghost', onclick: openHostLogin }, 'Host')),
    ]);
  }

  function toggleSound() {
    sound.on = !sound.on;
    storage.set(KEY_SOUND, sound.on ? '1' : '0');
    syncAudioSession();
    if (sound.on) {
      unlockAudio();
      setTimeout(SFX.ding, 50);
    } else {
      sound.ctx?.suspend().catch(() => {}); // hand the speaker back to music apps
    }
    render();
  }

  function toggleWake() {
    storage.set(KEY_WAKE, wakeOn() ? '0' : '1');
    render();
  }

  async function signOut() {
    const s = store.state;
    if (s?.you && (s.phase === 'play' || s.phase === 'meeting') && !confirm('Sign out of this phone? You can sign back in with your name and PIN.')) return;
    await call('signOut');
    storage.del(KEY_TOKEN);
    closeViews();
    closeRole();
    render();
  }

  function sitOutToggle(me) {
    return h('label', { class: 'switch-row' },
      h('input', {
        type: 'checkbox',
        checked: !!me.sitOut,
        onchange: async (e) => {
          const input = e.currentTarget;
          const res = await call('sitOut', { value: input.checked });
          if (!res.ok) {
            input.checked = !input.checked;
            toast(res.error, 'error');
          }
        },
      }),
      h('span', { class: 'grow' },
        h('b', {}, 'Sit out the next game'),
        h('div', { class: 'small muted' }, 'You won’t be dealt in. You can still follow along here.')));
  }

  const LOW_MS = 5 * 60_000; // the countdown turns red under 5 minutes

  /** The Campers' countdown: ticking (frozen while paused), stopped during a Campfire, or nothing without a time limit. */
  function gameClock(s) {
    const c = s.clock;
    if (!c) return '';
    if (c.endsAt == null) {
      const left = c.left ?? 0;
      return h('span', { class: `game-clock stopped ${left < LOW_MS ? 'low' : ''}` }, `⏱ stopped · ${fmtLeft(left)} left`);
    }
    return countdown(c.endsAt, { prefix: '⏱ ', suffix: ' left', done: '⏱ 0:00 left', cls: 'game-clock', low: LOW_MS });
  }

  function gameHeader(s) {
    const bar = s.bar ?? { done: 0, total: 0 };
    const pct = bar.total ? Math.round((100 * bar.done) / bar.total) : 0;
    return [
      h('section', { class: 'box game-head' },
        h('div', { class: 'game-top' },
          h('b', { class: 'game-no' }, `Game ${s.gameNo}`),
          gameClock(s)),
        h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
          h('div', { class: 'bar-fill', style: `width:${pct}%` })),
        h('div', { class: 'row small muted' },
          `${bar.done} of ${bar.total} chores done`,
          s.settings?.barMode === 'meetings' ? ' (moves at Campfires)' : '',
          h('span', { class: 'grow' }), `${pct}%`)),
      s.storm ? stormBanner(s.storm) : '',
    ];
  }
  const headerData = (s) => [s.gameNo, s.bar, s.storm, s.settings?.barMode, s.clock];

  function stormBanner(storm) {
    return h('section', { class: 'storm-banner' },
      h('div', { class: 'row' },
        h('b', { class: 'storm-title' }, '⛈ Storm!'),
        h('span', { class: 'grow' }),
        countdown(storm.endsAt, { cls: 'storm-time', done: '0:00' })),
      h('p', {}, 'Two different players must secure both stations, or the Lurkers win.'),
      storm.stations.map((st) => h('div', { class: `storm-st ${st.secured ? 'ok' : ''}` },
        h('span', { class: 'tick' }, st.secured ? '✓' : '!'),
        h('div', { class: 'grow' }, h('b', {}, st.name, st.secured ? ' · secured' : ''), h('div', { class: 'small' }, st.where)))));
  }

  // ------------------------------------------------------------------ role card

  // Hidden by default and identical for everyone. Press and hold to reveal; it then stays open (so a Lurker can use
  // it) until "Hide", 15 s without a tap, or the phone being put away.
  const role = { open: false, killTarget: null, stormAsk: false, note: '', idle: null };
  const roleFill = h('div', { class: 'hold-fill' });
  const roleFace = h('div', { class: 'role-face', 'aria-label': 'Press and hold to see your role' },
    h('div', { class: 'role-face-icon' }, '🏕️'),
    h('div', { class: 'role-face-title' }, 'Your role'),
    h('div', { class: 'role-face-hint' }, 'Press and hold to see it. Keep it hidden!'),
    roleFill);
  const roleBack = h('div', { class: 'role-back' });
  const roleEl = h('section', { class: 'role-card', onpointerdown: () => role.open && bumpRoleIdle() }, roleFace);
  pressHold(roleFace, 600, {
    onProgress: (f) => { roleFill.style.transform = `scaleX(${f})`; },
    onDone: () => {
      roleFill.style.transform = 'scaleX(0)';
      openRole();
    },
  });

  function openRole() {
    role.open = true;
    role.note = '';
    bumpRoleIdle();
    renderRole();
  }
  function closeRole() {
    clearTimeout(role.idle);
    role.open = false;
    role.killTarget = null;
    role.stormAsk = false;
    role.note = '';
    renderRole();
  }
  function bumpRoleIdle() {
    clearTimeout(role.idle);
    role.idle = setTimeout(closeRole, 15000);
  }

  function renderRole() {
    const s = store.state;
    const you = s?.you;
    if (!role.open || !you) {
      if (roleEl.firstChild !== roleFace || roleEl.childNodes.length !== 1) roleEl.replaceChildren(roleFace);
      roleBack._key = null;
      return;
    }
    if (roleEl.firstChild !== roleBack) roleEl.replaceChildren(roleBack);
    const data = [you.role, you.lurkers, you.status, s.phase, you.targets, you.killReadyAt, you.stormReadyAt, !!s.storm, role.killTarget, role.stormAsk, role.note];
    fill(roleBack, data, () => roleContent(s, you));
  }

  function roleContent(s, you) {
    const lurker = you.role === 'lurker';
    const hide = h('button', { type: 'button', class: 'btn-big', onclick: closeRole }, 'Hide');
    const head = [h('div', { class: 'role-kicker' }, 'You’re a'), h('div', { class: 'role-name' }, lurker ? 'Lurker' : 'Camper')];
    if (!lurker) return [head, h('p', { class: 'role-line' }, 'Do chores, find the Lurkers.'), hide];
    const others = you.lurkers.length
      ? `Your fellow Lurker${you.lurkers.length > 1 ? 's' : ''}: ${listNames(you.lurkers)}`
      : 'You’re the only Lurker.';
    return [head,
      h('p', { class: 'role-line' }, others),
      killControls(s, you),
      stormControls(s, you),
      role.note ? h('p', { class: 'role-note' }, role.note) : '',
      hide];
  }

  function killControls(s, you) {
    const section = (...c) => h('div', { class: 'role-action' }, h('div', { class: 'role-action-title' }, 'Kill'), ...c);
    if (you.status !== 'alive') return section(h('p', { class: 'muted' }, 'Ghosts can’t kill, but you can still start storms.'));
    if (s.phase !== 'play') return section(h('p', { class: 'muted' }, 'No kills during a Campfire.'));
    const target = you.targets.find((t) => t.id === role.killTarget);
    if (target) {
      return section(
        h('p', {}, `Did you just tap ${target.name} on the shoulder?`),
        h('div', { class: 'row two' },
          h('button', { type: 'button', class: 'danger-fill btn-big', onclick: (e) => doKill(target, e.currentTarget) }, `Yes, kill ${target.name}`),
          h('button', { type: 'button', class: 'btn-big', onclick: () => { role.killTarget = null; renderRole(); } }, 'Cancel')));
    }
    if (!you.targets.length) return section(h('p', { class: 'muted' }, 'Nobody to tap right now.'));
    return section(
      h('p', { class: 'small muted' }, 'Tap a Camper on the shoulder, then pick them here. ',
        countdown(you.killReadyAt, { prefix: 'Ready in ', cls: 'ready-in' })),
      h('div', { class: 'pick-grid' }, you.targets.map((t) => h('button', {
        type: 'button',
        class: 'pick',
        'data-ready-at': you.killReadyAt ?? 0,
        onclick: () => { role.killTarget = t.id; renderRole(); },
      }, t.name))));
  }

  async function doKill(target, btn) {
    btn.disabled = true;
    const res = await call('kill', { targetId: target.id });
    role.killTarget = null;
    // Shown inside the (private) card, never as a toast someone could glance at.
    role.note = res.ok ? `Done. ${target.name} is down. Walk away calmly.` : res.error;
    renderRole();
    // then the card shuts by itself, so it isn't left showing "Lurker" next to a body
    if (res.ok) {
      clearTimeout(role.idle);
      role.idle = setTimeout(closeRole, 3000);
    }
  }

  function stormControls(s, you) {
    if (you.stormReadyAt == null) return '';
    const section = (...c) => h('div', { class: 'role-action' }, h('div', { class: 'role-action-title' }, 'Storm'), ...c);
    if (s.storm) return section(h('p', { class: 'muted' }, 'A storm is on right now.'));
    if (s.phase !== 'play') return section(h('p', { class: 'muted' }, 'No storms during a Campfire.'));
    if (role.stormAsk) {
      return section(
        h('p', {}, `Start a storm? Campers get ${fmtSecs(s.settings?.stormSeconds ?? 90)} to secure two stations, or you win.`),
        h('div', { class: 'row two' },
          h('button', { type: 'button', class: 'danger-fill btn-big', onclick: (e) => doStorm(e.currentTarget) }, 'Start it'),
          h('button', { type: 'button', class: 'btn-big', onclick: () => { role.stormAsk = false; renderRole(); } }, 'Cancel')));
    }
    return section(
      h('button', { type: 'button', class: 'btn-big', 'data-ready-at': you.stormReadyAt, onclick: () => { role.stormAsk = true; renderRole(); } }, '⛈ Start a storm'),
      countdown(you.stormReadyAt, { prefix: 'Ready in ', cls: 'small muted' }));
  }

  async function doStorm(btn) {
    btn.disabled = true;
    const res = await call('storm');
    // Started: shut the card at once. Every phone is about to flash, and everyone will look at their screen.
    if (res.ok) return closeRole();
    role.stormAsk = false;
    role.note = res.error;
    renderRole();
  }

  // ------------------------------------------------------------------ screens

  const SCREENS = {
    loading: () => ({
      root: h('div', { class: 'loading' }, h('div', { class: 'spinner' }), h('p', { class: 'muted' }, 'Connecting…')),
    }),
    signin: buildSignin,
    lobby: buildLobby,
    play: buildPlay,
    meeting: buildMeeting,
    dead: buildDead,
    watch: buildWatch,
    over: buildOver,
  };

  function buildSignin() {
    const name = h('input', { class: 'big-input', placeholder: 'Your name', autocomplete: 'nickname', maxLength: 20, autocapitalize: 'words', enterkeyhint: 'next' });
    const pin = plain(h('input', { class: 'big-input pin-input', placeholder: '4-digit PIN', inputmode: 'numeric', pattern: '[0-9]*', maxLength: 4, enterkeyhint: 'go' }));
    const error = h('p', { class: 'error' });
    const btn = h('button', { type: 'submit', class: 'primary btn-big' }, 'Join the game');
    const form = h('form', {
      class: 'box',
      onsubmit: async (e) => {
        e.preventDefault();
        const n = name.value.trim();
        const p = pin.value.trim();
        if (!n) return void (error.textContent = 'Type your name.');
        if (!/^\d{4}$/.test(p)) return void (error.textContent = 'Your PIN is 4 digits.');
        btn.disabled = true;
        const res = await call('login', { name: n, pin: p });
        btn.disabled = false;
        if (!res.ok) return void (error.textContent = res.error);
        error.textContent = '';
        storage.set(KEY_TOKEN, res.token);
        waitForMe();
        openPending();
        render();
      },
    },
    h('label', { class: 'field' }, 'Name', name),
    h('label', { class: 'field' }, 'PIN', pin),
    h('p', { class: 'small muted' }, 'Pick any 4 digits and remember them. Same name + PIN gets you back in on any device.'),
    btn,
    error);
    return {
      root: h('div', { class: 'stack' },
        h('section', { class: 'hero' },
          h('div', { class: 'hero-logo' }, '🏕️'),
          h('h1', {}, 'Lake Lurkers'),
          h('p', { class: 'muted' }, 'Lurkers are hiding among the Campers. Do your chores, watch your back, and vote them out at the Campfire.')),
        ui.pendingCode ? h('p', { class: 'notice' }, 'Sign in first. Then the station you scanned opens.') : '',
        form,
        h('p', { class: 'center' }, h('a', { class: 'btn-link', href: '/lake/rules', target: '_blank', rel: 'noopener' }, '📖 How to play')),
        hostUI.el, // a host-only device (like the TV laptop) can run games without joining as a player
        footerEl),
    };
  }

  function buildLobby() {
    const head = h('section', { class: 'box hero-box' });
    const mine = box();
    const players = box();
    const info = box();
    return {
      root: h('div', { class: 'stack' }, head, mine, hostUI.el, players, info, howToPlay(), footerEl),
      update() {
        const s = store.state;
        fill(head, [s.gameNo, s.me.name], () => [
          h('div', { class: 'kicker' }, s.gameNo ? `Up next: game ${s.gameNo + 1}` : 'Lake Lurkers'),
          h('h1', {}, `Hi, ${s.me.name}!`),
          h('p', {}, 'Waiting for the host to start the game.'),
          h('p', { class: 'small muted' }, 'Keep this page open. It updates by itself.'),
        ]);
        fill(mine, [s.me.sitOut], () => sitOutToggle(s.me));
        fill(players, [s.players, s.me.id], () => playerList(s));
        fill(info, [s.settings, s.players.map((p) => p.sitOut), s.stations.length], () => settingsSummary(s));
      },
    };
  }

  function playerList(s) {
    const playing = s.players.filter((p) => !p.sitOut).length;
    return [
      h('h2', {}, 'Players', h('span', {}, `${playing} playing`)),
      h('ul', { class: 'plist' }, s.players.map((p) => h('li', { class: p.id === s.me.id ? 'me' : '' },
        pdot(p.color),
        h('span', { class: 'grow' }, p.name),
        p.id === s.me.id ? tag('you') : '',
        p.sitOut ? tag('sitting out') : ''))),
    ];
  }

  function settingsSummary(s) {
    const st = s.settings ?? {};
    const n = s.players.filter((p) => !p.sitOut).length;
    const lurkers = st.lurkers || (n <= 6 ? 1 : 2);
    // the rooms are picked from the switched-on stations, so there can't be more than those
    const rooms = Math.min(st.rooms ?? 12, s.stations?.length ?? Infinity);
    const per = st.choresPerRoom ?? 3;
    const total = rooms * per;
    const campers = n - lurkers;
    const lo = campers > 0 ? Math.floor(total / campers) : 0;
    const hi = campers > 0 ? Math.ceil(total / campers) : 0;
    return [
      h('h2', {}, 'This game'),
      h('ul', { class: 'facts' },
        h('li', {}, `${plural(lurkers, 'Lurker')}${st.lurkers ? '' : ' (picked by player count)'}`),
        h('li', {}, `${plural(rooms, 'room')} with chores, picked at random: ${per} in each, ${total} in all`),
        campers > 0 ? h('li', {}, `Split among the Campers: ${lo === hi ? lo : `${lo}–${hi}`} each`) : '',
        h('li', {}, st.timeLimit ? `${st.timeLimit}-minute clock (it stops during Campfires). If it runs out, the Lurkers win` : 'No time limit'),
        h('li', {}, `Lurkers can kill every ${fmtSecs(st.killCooldown)}`),
        h('li', {}, `${plural(st.emergencies, 'bell ring')} each at the ${s.campfire?.name ?? 'Campfire'}`),
        h('li', {}, st.storm ? `Storms on: ${fmtSecs(st.stormSeconds)} to secure two stations` : 'Storms off'),
        h('li', {}, st.barMode === 'meetings' ? 'The chore bar only moves at Campfires' : 'The chore bar moves live')),
    ];
  }

  function howToPlay() {
    return h('details', { class: 'box how' },
      h('summary', {}, 'How to play, in 30 seconds'),
      h('ol', {},
        h('li', {}, 'Press and hold your role card to see if you’re a Camper or a Lurker. Keep it secret.'),
        h('li', {}, 'Rooms with chores lists this game’s rooms (new ones every game) and how many of each room’s chores are done. The amber “for you” badge marks where yours are, and 🗺 Map shows where the rooms are. What to do there stays hidden until you get there.'),
        h('li', {}, 'At the room, scan its QR code: tap 📷 Scan QR right here in the app (or use your phone’s camera, or type the code under it). Then do the chore: a phone game (about 2 minutes), an activity, a photo or carrying something. 💬 chores work anywhere.'),
        h('li', {}, 'Phone games are one try: lose one (or quit it) and it moves to another room, hidden again until you find it there.'),
        h('li', {}, 'Lurkers tap Campers on the shoulder to kill them. If you’re tapped, sit down and stay silent.'),
        h('li', {}, 'Found a body? Type the code on their phone. Everyone runs to the Campfire to talk and vote.'),
        h('li', {}, 'Campers win by finishing every chore or voting out every Lurker. Watch the ⏱ clock: if it runs out first, the Lurkers win. It stops during Campfires.')));
  }

  function buildPlay() {
    const top = slot('stack');
    const banners = slot('stack');
    const chores = box();
    const scan = buildScan();
    const report = buildReport();
    return {
      root: h('div', { class: 'stack' }, top, banners, roleEl, chores, scan, report.el, footerEl, hostUI.el),
      update() {
        const s = store.state;
        const you = s.you;
        fill(top, headerData(s), () => gameHeader(s));
        const waiting = you.confirms.filter((c) => ui.snoozed.has(c.requestId) && !ui.answered.has(c.requestId));
        fill(banners, [you.status, you.ejected, waiting.map((c) => c.kind)], () => [
          you.status === 'ghost' ? ghostBanner(you) : '',
          waiting.length && you.status === 'alive' ? h('button', {
            type: 'button',
            class: 'waiting-banner',
            onclick: () => { ui.snoozed.clear(); render(); },
          }, waitingLabel(waiting)) : '',
        ]);
        renderRole();
        fill(chores, [you.chores, you.status, ui.partnerOf, s.stations.map((st) => st.id), s.rooms], () => roomList(s, you));
        report.update(you);
      },
    };
  }

  function waitingLabel(list) {
    const talks = list.filter((c) => c.kind === 'talk').length;
    const photos = list.length - talks;
    if (!talks) return `📷 ${plural(photos, 'photo')} waiting for your answer`;
    if (!photos) return `💬 ${plural(talks, 'question')} waiting for your answer`;
    return `${plural(list.length, 'check')} waiting for your answer`;
  }

  const ghostBanner = (you) => h('div', { class: 'ghost-banner' },
    h('b', {}, '👻 You’re a ghost.'), ' Stay silent, keep doing chores.',
    you.ejected ? h('div', { class: 'small' }, 'You were voted out.') : '');

  const FLOOR_RANK = { Main: 0, Upstairs: 1, Basement: 2, Outside: 3, Games: 4 };

  /**
   * My chores grouped by room, for the room list and the map. A hidden chore only says which room it's in; a carry
   * counts at the room it's waiting on (pick-up, then drop-off). The talk chore has no room.
   */
  function myRooms(s, you) {
    const rooms = new Map();
    const talk = [];
    for (const c of you?.chores ?? []) {
      if (c.kind === 'talk' || !c.stationId) {
        talk.push(c);
        continue;
      }
      if (!rooms.has(c.stationId)) {
        const st = s.stations.find((x) => x.id === c.stationId);
        rooms.set(c.stationId, { id: c.stationId, name: c.stationName ?? st?.name ?? '?', where: c.where ?? st?.where ?? '', floor: st?.floor ?? '', chores: [] });
      }
      rooms.get(c.stationId).chores.push(c);
    }
    const list = [...rooms.values()].map((r) => ({ ...r, left: r.chores.filter((c) => !c.done).length }));
    // rooms with something left first, then by floor
    list.sort((a, b) => (!a.left - !b.left) || (FLOOR_RANK[a.floor] ?? 9) - (FLOOR_RANK[b.floor] ?? 9));
    return { rooms: list, talk };
  }

  /**
   * This game's rooms with chores (the same list on every phone, Camper or Lurker) merged with mine: each room's
   * progress over the Campers' chores, plus what I have there (hidden until I scan it). A room of mine that isn't on
   * the list (a carry's drop-off) is added without progress while I have something to do there. Grouped by floor; in a
   * floor, rooms with something for me first, then rooms with chores left, then finished ones.
   */
  function gameRooms(s, you) {
    const { rooms: mine, talk } = myRooms(s, you);
    const all = new Map();
    for (const r of s.rooms ?? []) all.set(r.id, { id: r.id, name: r.name, where: r.where, floor: r.floor, game: true, total: r.total, done: r.done, chores: [], left: 0 });
    for (const m of mine) {
      const r = all.get(m.id);
      if (r) Object.assign(r, { chores: m.chores, left: m.left });
      else all.set(m.id, { ...m, game: false, total: 0, done: 0 });
    }
    // a room off the list only shows while I have something to do there (a delivered carry counts at its pick-up room)
    const list = [...all.values()].filter((r) => r.game || r.left).map((r) => ({ ...r, complete: r.game && r.total > 0 && r.done >= r.total }));
    const rank = (r) => (r.left ? 0 : r.game && !r.complete ? 1 : 2);
    const floors = new Map();
    for (const r of list.sort((a, b) => (FLOOR_RANK[a.floor] ?? 9) - (FLOOR_RANK[b.floor] ?? 9) || rank(a) - rank(b) || a.name.localeCompare(b.name))) {
      if (!floors.has(r.floor)) floors.set(r.floor, []);
      floors.get(r.floor).push(r);
    }
    return { floors: [...floors.entries()].map(([floor, rooms]) => ({ floor, rooms })), list, talk };
  }

  function roomList(s, you) {
    const ghost = you.status === 'ghost';
    const { floors, list, talk } = gameRooms(s, you);
    const done = you.chores.filter((c) => c.done).length;
    const game = list.filter((r) => r.game);
    const finished = game.filter((r) => r.complete).length;
    const mineIn = list.filter((r) => r.left).length;
    const carrying = you.chores.filter((c) => c.kind === 'carry' && c.step >= 1 && !c.done);
    return [
      h('div', { class: 'rooms-head' },
        h('div', { class: 'grow' },
          h('h2', {}, 'Rooms with chores'),
          h('div', { class: 'small muted' }, `${plural(game.length, 'room')}${finished ? ` · ${finished} finished` : ''}`),
          h('div', { class: 'small rooms-mine' }, `Yours: ${done} of ${plural(you.chores.length, 'chore')} done${mineIn ? ` · in ${plural(mineIn, 'room')}` : ''}`)),
        h('button', { type: 'button', class: 'map-btn', onclick: () => openMap() }, '🗺 Map')),
      carrying.map((c) => h('button', { type: 'button', class: 'carrying', onclick: () => openMap(c.toId) },
        `📦 Carrying ${c.item} → drop at the ${c.toName}`)),
      talk.some((c) => !c.done) ? h('ul', { class: 'rooms' }, talk.filter((c) => !c.done).map((c) => talkItem(c, ghost))) : '',
      floors.map(({ floor, rooms }) => {
        const g = rooms.filter((r) => r.game);
        const left = g.reduce((n, r) => n + Math.max(0, r.total - r.done), 0);
        return h('div', { class: 'floor-group' },
          h('h3', { class: 'floor-head' },
            h('span', { class: 'grow' }, floorLabel(floor) || 'Elsewhere'),
            g.length ? h('span', { class: 'floor-n' }, left ? `${plural(left, 'chore')} left` : '✓ all done') : ''),
          h('ul', { class: 'rooms' }, rooms.map(roomItem)));
      }),
      talk.some((c) => c.done) ? h('ul', { class: 'rooms' }, talk.filter((c) => c.done).map((c) => talkItem(c, ghost))) : '',
      h('p', { class: 'small muted' }, 'Every player sees this list. The numbers count all the Campers’ chores in a room; the amber badge is yours. What to do stays hidden until you scan the room’s QR code there. Tap a room to see it on the map.'),
    ];
  }

  /** One room: its progress for everyone, and mine there. Tap it to see it on the map. */
  function roomItem(r) {
    const shown = r.chores.filter((c) => !c.hidden);
    const hidden = r.chores.filter((c) => c.hidden && !c.done).length;
    const mineDone = r.chores.length > 0 && !r.left;
    const quiet = !r.left && (r.complete || (!r.game && mineDone)); // nothing left here that I know of
    const label = [r.name, r.game ? `${r.done} of ${r.total} chores done` : '', r.left ? `${r.left} for you` : mineDone ? 'yours done' : ''].filter(Boolean).join(', ');
    return h('li', {},
      h('button', { type: 'button', class: `room ${r.left ? 'mine' : ''} ${quiet ? 'done' : ''}`, 'aria-label': label, onclick: () => openMap(r.id) },
        h('span', { class: 'room-head' },
          h('b', { class: 'room-name' }, r.name),
          r.left ? h('span', { class: 'room-badge' }, `${r.left} for you`) : '',
          r.game ? h('span', { class: `room-n ${r.complete ? 'ok' : ''}` }, r.complete ? `✓ ${r.done}/${r.total}` : `${r.done}/${r.total}`) : ''),
        quiet ? '' : h('span', { class: 'room-where' }, r.where),
        r.left ? shown.map(roomChore) : '',
        r.left && hidden ? h('span', { class: 'room-hidden' }, shown.length ? `🔒 ${plural(hidden, 'more chore')}: scan the room to see` : '🔒 Scan the room to see what to do') : '',
        mineDone ? h('span', { class: 'room-yours-ok' }, '✓ Yours here are done') : ''));
  }

  function choreText(c) {
    if (c.kind !== 'carry') return c.title;
    return c.done ? `Delivered ${c.item}` : c.step >= 1 ? `Drop off ${c.item} here` : `Pick up ${c.item} for the ${c.toName}`;
  }

  function roomChore(c) {
    const text = choreText(c);
    const wait = c.pending && !c.done ? `Waiting for ${ui.partnerOf[c.id] ?? 'your partner'} to say yes` : '';
    return h('span', { class: `room-chore ${c.done ? 'done' : ''}` },
      h('span', { class: 'room-ico', 'aria-hidden': 'true' }, c.done ? '✓' : choreIcon(c)),
      h('span', { class: 'grow' }, text, wait ? h('span', { class: 'chore-wait' }, wait) : ''));
  }

  function talkItem(c, ghost) {
    const need = c.need ?? 3;
    const got = Math.min(need, c.progress ?? 0);
    const head = h('div', { class: 'room-head' },
      h('b', { class: 'room-name' }, '💬 Anywhere'),
      c.done ? h('span', { class: 'room-ok' }, '✓ done') : h('span', { class: 'room-badge' }, `${got}/${need}`));
    if (c.done) return h('li', {}, h('div', { class: 'room talk done' }, head));
    return h('li', {}, h('div', { class: 'room talk' },
      head,
      h('span', { class: 'room-chore' }, h('span', { class: 'room-ico', 'aria-hidden': 'true' }, '💬'), h('span', { class: 'grow' }, c.title)),
      h('span', { class: 'room-where' }, ghost ? `Ghosts can’t talk: silently wave at ${need} players instead (${c.seconds ?? 30} s)` : `${got} of ${need} said yes`),
      c.pending && !ghost ? h('span', { class: 'chore-wait' }, `Waiting for ${ui.partnerOf[c.id] ?? 'them'} to say yes`) : '',
      h('button', { type: 'button', class: 'chore-btn', onclick: () => openTalk(c.id) },
        ghost ? '👋 Wave at players' : c.pending ? '💬 Back to the question' : '💬 Talk to someone')));
  }

  const ICONS = { task: '🎮', photo: '📷', carry: '📦', talk: '💬' };
  const GAME_ICONS = { hold: '✋', wordle: '🔤', make24: '🧮', snake: '🐍', blackjack: '🃏', tap50: '🔢', crack: '🔐', order: '🔢', simon: '🎵', match: '🧩' };
  // activities by station (the radio's two both get the mic; the Basement Office's compliment has its own, below)
  const ACT_ICONS = {
    radio: '🎤', campfire: '💃', pingpong: '🏓', curling: '🥌', golf: '⛳',
    sunroom: '🧘', kitchen: '🧽', dining: '🥤', 'east-living': '🎭', foyer: '🤸', office: '✍️', laundry: '🧺',
    'up-west': '🏋️', 'up-east': '💪', den: '✊', media: '🎬', gym: '💪', bar: '🍹', 'b-office': '🎨',
    'screened-patio': '🧱', 'covered-patio': '🦩', dock: '⛵', shore: '🪨',
  };
  /** Activities you keep trying until you pull it off: their button says "I did it!" instead of "Done". */
  const SKILL_STATIONS = new Set(['pingpong', 'curling', 'golf']);
  function choreIcon(c) {
    if (c.kind === 'act') return (c.title === 'Leave a compliment' ? '✍️' : ACT_ICONS[c.stationId]) ?? (c.voice ? '🎤' : '🎯');
    if (c.kind === 'task') return GAME_ICONS[c.puzzle] ?? ICONS.task;
    return ICONS[c.kind] ?? '•';
  }

  function buildScan() {
    const input = plain(h('input', { class: 'big-input code', placeholder: 'Code', autocapitalize: 'characters', maxLength: 8, enterkeyhint: 'go', 'aria-label': 'Station code' }));
    const btn = h('button', { type: 'submit', class: 'primary' }, 'Go');
    const scanBtn = h('button', { type: 'button', class: 'primary btn-big scan-btn', onclick: () => openScanner() }, '📷 Scan QR');
    return h('form', {
      class: 'box',
      onsubmit: async (e) => {
        e.preventDefault();
        const code = input.value.trim();
        if (!code) return input.focus();
        btn.disabled = true;
        const ok = await openStation(code);
        btn.disabled = false;
        if (ok) {
          input.value = '';
          input.blur();
        }
      },
    },
    h('h2', {}, 'At a station?'),
    scanBtn,
    h('p', { class: 'small muted' }, 'Scan the QR code on the station card right here in the app, or with your phone’s camera. Or type the code printed under it:'),
    h('div', { class: 'inline-form' }, input, btn));
  }

  function buildReport() {
    const input = plain(h('input', { class: 'big-input code', placeholder: '000', inputmode: 'numeric', pattern: '[0-9]*', maxLength: 3, enterkeyhint: 'go', 'aria-label': 'Body code' }));
    const btn = h('button', { type: 'submit', class: 'danger-fill' }, 'Report');
    const lock = countdown(0, { prefix: 'Too many wrong codes. Try again in ', cls: 'small warn' });
    const error = h('p', { class: 'error' });
    const el = h('form', {
      class: 'box',
      onsubmit: async (e) => {
        e.preventDefault();
        const code = input.value.trim();
        if (!/^\d{3}$/.test(code)) return void (error.textContent = 'Body codes are 3 digits.');
        btn.dataset.blocked = '1';
        btn.disabled = true;
        const res = await call('report', { bodyCode: code });
        delete btn.dataset.blocked;
        tick();
        if (!res.ok) {
          error.textContent = res.error;
          SFX.buzz();
          return;
        }
        error.textContent = '';
        input.value = '';
        input.blur();
      },
    },
    h('h2', {}, 'Found a body?'),
    h('p', { class: 'small muted' }, 'Type the 3-digit code on their phone to call a Campfire.'),
    h('div', { class: 'inline-form' }, input, btn),
    lock,
    error);
    return {
      el,
      update(you) {
        el.hidden = you.status !== 'alive';
        btn.dataset.readyAt = you.lockUntil ?? 0;
        lock.dataset.until = you.lockUntil ?? 0;
      },
    };
  }

  // ---- Campfire

  const STAGES = ['gather', 'discuss', 'vote', 'result'];
  const STAGE_NAME = { gather: 'Gather', discuss: 'Discuss', vote: 'Vote', result: 'Result' };

  function reasonLine(s, m) {
    const who = m.caller === s.me?.name ? 'You' : m.caller ?? 'Someone';
    if (m.reason !== 'body') return `${who} rang the bell.`;
    return `${who} found ${m.body === s.me?.name ? 'your' : `${m.body}’s`} body.`;
  }

  function stageBox(s, m) {
    return [
      h('div', { class: 'stage-kicker' }, '🔥 Campfire'),
      h('div', { class: 'stage-name' }, STAGE_NAME[m.stage] ?? m.stage),
      h('div', { class: 'stage-time' }, countdown(m.endsAt, { done: '0:00' })),
      h('div', { class: 'stage-steps' }, STAGES.map((st) => h('span', { class: st === m.stage ? 'on' : '' }, STAGE_NAME[st]))),
      h('p', { class: 'stage-why' }, reasonLine(s, m)),
    ];
  }
  const stageData = (m) => [m.stage, m.endsAt, m.reason, m.caller, m.body];

  function buildMeeting() {
    const stage = h('section', { class: 'box stage' });
    const ghost = slot();
    // The buttons and the who's-in list are separate slots, so other players checking in or voting doesn't rebuild
    // the "I'm here" or vote buttons under someone's finger (a tap across a rebuild is lost).
    const main = slot('stack');
    const who = slot();
    const act = h('section', { class: 'box' }, main, who);
    const top = slot('stack');
    return {
      root: h('div', { class: 'stack' }, stage, ghost, act, top, roleEl, footerEl, hostUI.el),
      update() {
        const s = store.state;
        const m = s.meeting;
        const you = s.you;
        if (!m) return;
        fill(stage, stageData(m), () => stageBox(s, m));
        fill(ghost, [you.status, you.ejected], () => (you.status === 'ghost' ? ghostBanner(you) : ''));
        fill(main, meetingMainData(s, m, you), () => meetingMain(s, m, you));
        fill(who, [m.stage, m.voters, m.here, m.voted, s.players], () => meetingWho(s, m));
        fill(top, headerData(s), () => gameHeader(s));
        renderRole();
      },
    };
  }

  /** What the main part of the Campfire box depends on, per stage. */
  function meetingMainData(s, m, you) {
    const alive = you?.status === 'alive';
    if (m.stage === 'gather') return [m.stage, s.campfire, alive, m.here.includes(s.me.id)];
    if (m.stage === 'discuss') return [m.stage, m.newlyOut];
    if (m.stage === 'vote') return [m.stage, m.voters, you?.status, you?.myVote, ui.voteFor, s.players];
    return [m.stage, m.result, m.endsAt];
  }

  function meetingMain(s, m, you) {
    const me = s.me.id;
    const alive = you?.status === 'alive';
    if (m.stage === 'gather') {
      return [
        h('p', { class: 'big' }, 'Go to the Campfire: ', h('b', {}, s.campfire?.where ?? 'the Great Room')),
        alive && !m.here.includes(me)
          ? h('button', { type: 'button', class: 'primary btn-big', onclick: (e) => act('here', {}, e.currentTarget) }, 'I’m here')
          : '',
        alive && m.here.includes(me) ? h('p', { class: 'ok-line' }, '✓ You’re checked in') : '',
      ];
    }
    if (m.stage === 'discuss') {
      return [
        m.newlyOut.length
          ? h('p', { class: 'out-line' }, `💀 ${listNames(m.newlyOut)} ${m.newlyOut.length === 1 ? 'was' : 'were'} killed.`)
          : h('p', { class: 'muted' }, 'Nobody new was killed.'),
        h('p', {}, 'Talk it out. Who’s lurking?'),
      ];
    }
    if (m.stage === 'vote') return voteUI(s, m, you);
    return resultUI(s, m);
  }

  function meetingWho(s, m) {
    if (m.stage === 'gather') return whoList(s, m.voters, m.here, `${m.here.length} of ${m.voters.length} here`);
    if (m.stage === 'discuss') return whoList(s, m.voters, [], `${m.voters.length} still in`);
    if (m.stage === 'vote') return whoList(s, m.voters, m.voted, `${m.voted.length} of ${m.voters.length} voted`);
    return '';
  }

  const whoList = (s, ids, marked, label) => h('div', { class: 'who-list' },
    label ? h('div', { class: 'small muted' }, label) : '',
    h('div', { class: 'chips' }, ids.map((id) => h('span', { class: `chip-p ${marked.includes(id) ? 'on' : ''}` },
      pdot(pcolor(s, id)), pname(s, id), marked.includes(id) ? ' ✓' : ''))));

  function voteUI(s, m, you) {
    const me = s.me.id;
    if (!m.voters.includes(me)) return [h('p', {}, you?.status === 'ghost' ? 'Ghosts don’t vote. Watch quietly.' : 'You’re not voting this time.')];
    if (you.myVote) {
      return [h('p', { class: 'ok-line' }, you.myVote === 'skip' ? '✓ You voted to skip.' : `✓ You voted for ${pname(s, you.myVote)}.`)];
    }
    if (ui.voteFor && (ui.voteFor === 'skip' || m.voters.includes(ui.voteFor))) {
      const label = ui.voteFor === 'skip' ? 'Skip this vote?' : `Vote for ${pname(s, ui.voteFor)}?`;
      const back = h('button', { type: 'button', class: 'btn-big', onclick: () => { ui.voteFor = null; render(); } }, 'Back');
      return [
        h('p', { class: 'big center' }, label),
        h('p', { class: 'small muted center' }, 'Votes are final.'),
        h('div', { class: 'row two' },
          h('button', {
            type: 'button',
            class: 'primary btn-big',
            onclick: async (e) => {
              // stays disabled once the vote is in: the state saying so lands a moment after the answer
              const btn = e.currentTarget;
              btn.disabled = true;
              back.disabled = true;
              const res = await call('vote', { target: ui.voteFor });
              if (res.ok) return;
              btn.disabled = false;
              back.disabled = false;
              toast(res.error, 'error');
            },
          }, 'Yes, vote'),
          back),
      ];
    }
    return [
      h('p', {}, 'Who’s a Lurker? Tap to vote.'),
      h('div', { class: 'vote-grid' },
        m.voters.map((id) => h('button', { type: 'button', class: 'vote-btn', onclick: () => { ui.voteFor = id; render(); } },
          pdot(pcolor(s, id)), pname(s, id), id === me ? ' (you)' : '')),
        h('button', { type: 'button', class: 'vote-btn skip', onclick: () => { ui.voteFor = 'skip'; render(); } }, 'Skip')),
    ];
  }

  function resultUI(s, m) {
    const r = m.result;
    if (!r) return h('p', { class: 'muted center' }, 'Counting the votes…');
    const why = { tie: 'It was a tie.', skip: 'Skip got the most votes.', novotes: 'Nobody voted.' }[r.reason] ?? '';
    const tally = [...r.tally].filter((t) => t.votes > 0 || t.id === 'skip').sort((a, b) => b.votes - a.votes);
    const max = Math.max(1, ...tally.map((t) => t.votes));
    return [
      h('p', { class: 'result-line' }, r.ejected ? `${r.ejected.name} was voted out.` : 'Nobody was voted out.'),
      why ? h('p', { class: 'muted center' }, why) : '',
      r.ejected && r.role ? h('p', { class: `result-role ${r.role}` }, `${r.ejected.name} was ${r.role === 'lurker' ? 'a Lurker!' : 'a Camper.'}`) : '',
      h('div', { class: 'tally' }, tally.map((t) => h('div', { class: 'tally-row' },
        h('span', { class: 'tally-name' }, t.id === 'skip' ? 'Skip' : t.name),
        h('span', { class: 'tally-bar' }, h('span', { style: `width:${(100 * t.votes) / max}%` })),
        h('b', {}, t.votes)))),
      r.votes
        ? h('details', { class: 'votes' }, h('summary', {}, 'Who voted for whom'),
          h('ul', {}, r.votes.map((v) => h('li', {}, `${v.voter} → ${v.target ?? 'Skip'}`))))
        : h('p', { class: 'small muted' }, 'Votes were anonymous.'),
      h('p', { class: 'small muted center' }, 'Back to the game in ', countdown(m.endsAt, { done: 'a moment' })),
    ];
  }

  async function act(event, payload, btn) {
    if (btn) btn.disabled = true;
    const res = await call(event, payload);
    if (btn) btn.disabled = false;
    if (!res.ok) toast(res.error, 'error');
    return res;
  }

  // ---- dead, watching, over

  function buildDead() {
    const main = h('section', { class: 'dead' });
    return {
      root: h('div', { class: 'stack' }, main, footerEl, hostUI.el),
      update() {
        const d = store.state.you.death;
        fill(main, d, () => [
          h('div', { class: 'dead-title' }, 'You’ve been got!'),
          h('p', { class: 'dead-by' }, `You were killed by ${d?.by ?? 'a Lurker'}.`),
          h('p', {}, 'Sit or lie down right here and stay silent until someone finds you.'),
          h('div', { class: 'body-label' }, 'Body code'),
          h('div', { class: 'body-code' }, d?.bodyCode ?? '???'),
          h('p', { class: 'small dead-hint' }, 'Whoever finds you types this code to call a Campfire.'),
          d?.undoUntil ? h('button', {
            type: 'button',
            class: 'btn-big undo',
            'data-hide-at': d.undoUntil,
            onclick: (e) => act('undoDeath', {}, e.currentTarget),
          }, 'I wasn’t tapped! ', countdown(d.undoUntil, { prefix: '(', cls: 'undo-left' }), ')') : '',
        ]);
      },
    };
  }

  function buildWatch() {
    const note = box();
    const top = slot('stack');
    const meet = slot('stack');
    return {
      root: h('div', { class: 'stack' }, note, top, meet, footerEl, hostUI.el),
      update() {
        const s = store.state;
        fill(note, [s.gameNo, s.me.sitOut], () => [
          h('h1', {}, `Game ${s.gameNo} is on`),
          h('p', {}, s.me.sitOut ? 'You’re not in this one, and you’re sitting out the next one too.' : 'You’re not in this one. You’ll be dealt into the next game.'),
          sitOutToggle(s.me),
        ]);
        fill(top, headerData(s), () => gameHeader(s));
        const m = s.meeting;
        fill(meet, m ? [stageData(m), m.result, m.here, m.voted] : null, () => (m ? [
          h('section', { class: 'box stage' }, stageBox(s, m)),
          m.stage === 'result' ? box(resultUI(s, m)) : '',
        ] : ''));
      },
    };
  }

  function buildOver() {
    const banner = h('section', { class: 'box over-banner' });
    const roles = box();
    const photos = box();
    const timeline = box();
    const mine = box();
    return {
      root: h('div', { class: 'stack' }, banner, hostUI.el, roles, photos, timeline, mine, footerEl),
      update() {
        const s = store.state;
        const o = s.over;
        if (!o) return;
        const myRole = o.roles.find((r) => r.id === s.me.id);
        const timeUp = /time ran out/i.test(o.reason ?? '');
        fill(banner, [s.gameNo, o.winner, o.reason, myRole, s.bar], () => [
          h('div', { class: 'kicker' }, `Game ${s.gameNo} is over`),
          h('h1', { class: `winner ${o.winner ?? 'none'}` }, o.winner === 'campers' ? 'Campers win!' : o.winner === 'lurkers' ? 'Lurkers win!' : 'Game ended'),
          timeUp ? h('div', { class: 'timeup' }, '⏱ Time’s up!') : '',
          h('p', {}, `${capital(o.reason ?? '')}.`),
          s.bar?.total ? h('p', { class: 'small muted' }, `Chores done: ${s.bar.done} of ${s.bar.total}`) : '',
          myRole ? h('p', { class: 'big' }, `You were a ${myRole.role === 'lurker' ? 'Lurker' : 'Camper'}.`,
            o.winner === `${myRole.role}s` ? ' You won! 🎉' : '') : '',
        ]);
        fill(roles, [o.roles, s.me.id], () => [
          h('h2', {}, 'Who was who'),
          h('ul', { class: 'plist' }, [...o.roles].sort((a, b) => (a.role === 'lurker' ? 0 : 1) - (b.role === 'lurker' ? 0 : 1)).map((r) =>
            h('li', { class: r.id === s.me.id ? 'me' : '' },
              pdot(r.color),
              h('span', { class: 'grow' }, h('b', {}, r.name), h('div', { class: 'small muted' }, capital(r.fate))),
              h('span', { class: `role-tag ${r.role}` }, r.role === 'lurker' ? 'Lurker' : 'Camper')))),
        ]);
        fill(photos, o.photos.map((p) => [p.id, p.partner]), () => [
          h('h2', {}, 'Photos from this game'),
          o.photos.length ? thumbs(o.photos) : h('p', { class: 'muted' }, 'No photos this game.'),
          h('button', { type: 'button', class: 'btn-big', onclick: openGallery }, '🖼 All photos'),
        ]);
        fill(timeline, o.timeline, () => h('details', { class: 'timeline-wrap', open: true },
          h('summary', {}, 'What happened'),
          h('ol', { class: 'timeline' }, o.timeline.map((e) => h('li', {}, h('span', { class: 't' }, fmtAt(e.t)), e.text)))));
        fill(mine, [s.me.sitOut], () => sitOutToggle(s.me));
      },
    };
  }

  // ------------------------------------------------------------------ full-screen sheets

  /** Opens a sheet (or closes it with null), cleaning up whatever was open before. */
  function showView(v) {
    if (ui.view && ui.view !== v) ui.view.cleanup?.();
    ui.view = v;
    render();
  }

  function closeViews() {
    if (ui.view && ui.view.kind !== 'gallery') {
      ui.view.cleanup?.();
      ui.view = null;
    }
  }

  /** A Campfire, a death or signing out closes stations and puzzles; puzzles and photos need the game in play. */
  function guardViews() {
    const v = ui.view;
    const s = store.state;
    if (!v || v.kind === 'gallery') return;
    const blocked = !s?.me || s.phase === 'meeting' || s.you?.status === 'dead';
    const inGame = ['puzzle', 'photo', 'act', 'talk', 'map', 'scan'].includes(v.kind);
    if (blocked || (inGame && (s.phase !== 'play' || !s.you))) closeViews();
    // the pause screen covers a phone game, which would run on (and be lost) under it: stop it, not as a loss
    else if (v.kind === 'puzzle' && s.paused) interruptGame('pause');
  }

  function renderSheet() {
    const sheet = $('#sheet');
    const v = ui.view;
    document.body.classList.toggle('sheet-open', !!v);
    if (!v) {
      if (!sheet.hidden) {
        sheet.hidden = true;
        sheet.replaceChildren();
        sheet._view = null;
      }
      return;
    }
    if (sheet._view !== v) {
      sheet._view = v;
      sheet.replaceChildren(v.root);
      sheet.hidden = false;
      sheet.scrollTop = 0;
    }
    v.update?.();
  }

  const sheetHead = (onBack, label = '← Back') =>
    h('div', { class: 'sheet-head' }, h('button', { type: 'button', class: 'back-btn', onclick: onBack }, label));

  const floorLabel = (floor) => (floor === 'Main' ? 'Main floor' : floor ?? '');

  // ---- station

  async function openStation(code) {
    code = String(code ?? '').trim();
    if (!code) return false;
    const res = await call('station', { code });
    if (!res.ok) {
      toast(res.error, 'error');
      return false;
    }
    const st = res.station;
    const v = { kind: 'station', code, station: st, bellAsk: false };
    if (store.state?.phase === 'play' || store.state?.phase === 'meeting') {
      ui.lastStation = { game: store.state.gameNo, id: st.id };
      storage.set(KEY_LAST, JSON.stringify(ui.lastStation));
    }
    const chores = slot('stack');
    const bell = slot();
    const storm = slot();
    const note = slot();
    const room = slot();
    v.root = h('div', { class: 'sheet-inner' },
      sheetHead(() => showView(null)),
      h('div', { class: 'station-head' },
        h('div', { class: 'kicker' }, floorLabel(st.floor)),
        h('h1', {}, st.name),
        h('p', { class: 'muted' }, st.where),
        room),
      storm, chores, bell, note);
    v.update = () => renderStation(v, { chores, bell, storm, note, room });
    showView(v);
    return true;
  }

  function renderStation(v, slots) {
    const s = store.state;
    const you = s?.you;
    const st = v.station;
    // everyone sees how far this room's chores are, like on the room list
    const gr = s?.phase === 'play' || s?.phase === 'meeting' ? s.rooms?.find((x) => x.id === st.id) : null;
    const listed = !!s?.rooms && (s.phase === 'play' || s.phase === 'meeting');
    // a room off the list can still hold something of mine (a carry's drop-off): don't call it empty then
    const mineHere = !!you?.chores.some((c) => !c.done && (c.kind === 'carry' ? c.toId === st.id : c.stationId === st.id));
    fill(slots.room, [listed, gr, mineHere], () => {
      if (!listed) return '';
      if (!gr) return mineHere ? '' : h('p', { class: 'room-line' }, 'No chores in this room this game.');
      const ok = gr.total > 0 && gr.done >= gr.total;
      return h('p', { class: `room-line ${ok ? 'ok' : ''}` }, ok ? `✓ All ${gr.total} chores here are done` : `This room: ${gr.done} of ${plural(gr.total, 'chore')} done`);
    });
    if (!s || s.phase !== 'play' || !you) {
      const msg = s?.phase === 'lobby' ? 'The game hasn’t started yet. Come back once it has!'
        : s?.phase === 'over' ? 'This game is over.'
          : 'You’re not in this game.';
      fill(slots.chores, ['off', msg], () => h('p', { class: 'note' }, msg));
      for (const k of ['bell', 'storm', 'note']) fill(slots[k], null, () => '');
      return;
    }
    const here = you.chores.filter((c) => (c.kind === 'carry' ? c.fromId === st.id || c.toId === st.id : c.stationId === st.id));
    fill(slots.chores, [here, here.map((c) => ui.partnerOf[c.id] ?? null)], () => here.map((c) => stationChore(c, v)));
    const atCampfire = st.id === s.campfire?.id && you.status === 'alive';
    fill(slots.bell, atCampfire ? [you.emergencies, you.bellReadyAt, !!s.storm, v.bellAsk] : null, () => (atCampfire ? bellBox(s, you, v) : ''));
    const ss = s.storm?.stations.find((x) => x.id === st.id);
    fill(slots.storm, ss ? [ss.secured, you.status, s.storm.endsAt] : null, () => (ss ? stormBox(s, ss, you, v) : ''));
    const nothing = !here.length && !atCampfire && !ss;
    const allDone = here.length > 0 && here.every((c) => c.done) && !atCampfire && !ss;
    fill(slots.note, [nothing, allDone], () => (nothing ? h('p', { class: 'note' }, 'Nothing for you here. Check Rooms with chores (or the 🗺 Map) for where to go.')
      : allDone ? h('p', { class: 'note' }, 'Your chores here are done ✓') : ''));
  }

  function stationChore(c, v) {
    const st = v.station;
    const line = (cls, ...kids) => h('div', { class: `chore-here ${cls}` }, ...kids);
    const go = (label, onclick, sub = '') => h('button', { type: 'button', class: 'primary btn-big go-btn', onclick },
      h('span', {}, label), sub ? h('span', { class: 'go-sub' }, sub) : '');
    if (c.done) return line('done', `✓ ${c.title}`);
    // scanning reveals it; the state saying what it is lands a moment after the station opens
    if (c.hidden) return line('wait', 'Unlocking your chore…');
    if (c.kind === 'task') {
      return [
        go(`${choreIcon(c)} Play: ${c.title}`, () => openPuzzle(c, v), `Phone game, about 2 minutes. ${gameDetail(c)}`),
        h('p', { class: 'small warn go-warn' }, 'One try: lose it (or quit) and it moves to another room.'),
      ];
    }
    if (c.kind === 'act') return go(`${choreIcon(c)} ${c.title}`, () => openAct(c, v), c.seconds ? `Activity, ${fmtSecs(c.seconds)}` : '');
    if (c.kind === 'photo') {
      if (c.pending) {
        return line('wait', h('b', {}, `📷 ${c.title}`), h('div', { class: 'small' }, `Waiting for ${ui.partnerOf[c.id] ?? 'your partner'} to say yes on their phone.`),
          h('button', { type: 'button', class: 'btn-big', onclick: () => openPhoto(c, v) }, 'Retake with someone else'));
      }
      return go(`📷 ${c.title}`, () => openPhoto(c, v));
    }
    if (c.step === 0 && c.fromId === st.id) return go(`📦 Pick up ${c.item}`, (e) => carry(c, v, e.currentTarget));
    if (c.step >= 1 && c.toId === st.id) return go(`📦 Drop off ${c.item}`, (e) => carry(c, v, e.currentTarget));
    if (c.step === 0) return line('wait', `📦 ${c.title}: pick up ${c.item} at the ${c.fromName} first.`);
    return line('wait', `📦 You’ve got ${c.item}. Take it to the ${c.toName}.`);
  }

  async function carry(c, v, btn) {
    btn.disabled = true;
    const res = await call('choreDone', { choreId: c.id, code: v.code });
    if (!res.ok) {
      btn.disabled = false;
      return toast(res.error, 'error');
    }
    // the button stays off: the state with the next step replaces it (a double tap would error otherwise)
    if (res.done) toast(`Dropped off ${c.item} ✓`);
    else {
      SFX.blip();
      toast(`Got ${c.item}! Now take it to the ${c.toName}.`);
    }
  }

  function bellBox(s, you, v) {
    const title = h('h2', {}, '🔔 Campfire bell');
    if (you.emergencies <= 0) return box(title, h('p', { class: 'muted' }, 'You’ve used your bell.'));
    if (s.storm) return box(title, h('p', { class: 'muted' }, 'No bell during a storm. Go secure the stations!'));
    if (v.bellAsk) {
      return box(title,
        h('p', { class: 'big' }, 'Call everyone to the Campfire now?'),
        h('div', { class: 'row two' },
          h('button', { type: 'button', class: 'danger-fill btn-big', onclick: (e) => ringBell(v, e.currentTarget) }, 'Ring it!'),
          h('button', { type: 'button', class: 'btn-big', onclick: () => { v.bellAsk = false; render(); } }, 'Cancel')));
    }
    return box(title,
      h('p', { class: 'small muted' }, `Calls a Campfire right away. You have ${plural(you.emergencies, 'ring')} left.`),
      h('button', { type: 'button', class: 'danger-fill btn-big', 'data-ready-at': you.bellReadyAt ?? 0, onclick: () => { v.bellAsk = true; render(); } }, 'Ring the bell'),
      countdown(you.bellReadyAt, { prefix: 'The bell is ready in ', cls: 'small muted' }));
  }

  async function ringBell(v, btn) {
    btn.disabled = true;
    const res = await call('bell', { code: v.code });
    v.bellAsk = false;
    if (!res.ok) {
      toast(res.error, 'error');
      render();
    }
  }

  function stormBox(s, ss, you, v) {
    const title = h('h2', {}, '⛈ Storm station');
    if (ss.secured) return box(title, h('p', { class: 'ok-line' }, '✓ Secured. Now the other one!'));
    if (you.status !== 'alive') return box(title, h('p', { class: 'muted' }, 'Ghosts can’t secure stations. Find a living player!'));
    const progress = h('div', { class: 'hold-fill' });
    const label = h('span', {}, 'Hold to secure (3 s)');
    const btn = h('button', { type: 'button', class: 'storm-fix' }, label, progress);
    pressHold(btn, 3000, {
      onStart: () => { label.textContent = 'Keep holding…'; },
      onProgress: (f) => { progress.style.transform = `scaleX(${f})`; },
      onCancel: () => { label.textContent = 'Hold to secure (3 s)'; },
      onDone: async () => {
        btn.disabled = true;
        label.textContent = 'Securing…';
        const res = await call('stormFix', { code: v.code });
        if (res.ok) return SFX.ding();
        toast(res.error, 'error');
        btn.disabled = false;
        label.textContent = 'Hold to secure (3 s)';
        progress.style.transform = 'scaleX(0)';
      },
    });
    return box(title,
      h('p', {}, 'Two different players must secure the two storm stations.'),
      btn,
      h('p', { class: 'small muted' }, 'Time left: ', countdown(s.storm.endsAt, { done: '0:00' })));
  }

  // ---- phone games

  /**
   * A phone game's one-line rule. The catalog's text predates "one try": hold said letting go pauses it, and blackjack
   * didn't say 3 losses end it. Both lose the game now, so say so (and leave any newer catalog text alone).
   */
  function gameDetail(c) {
    const d = c.detail ?? '';
    if (c.puzzle === 'hold') return d.replace('Let go and it pauses.', 'Let go for more than a second and you lose.');
    if (c.puzzle === 'blackjack' && d === 'Beat the dealer 3 times.') return 'Beat the dealer 3 times before the dealer beats you 3 times.';
    return d;
  }

  /** Games that run in real time: a photo or talk check popped over them would lose the game, so checks wait. */
  const REALTIME_GAMES = new Set(['hold', 'snake']);

  /**
   * A phone game: window.LakeGames[puzzle](el, { done, fail }) → cleanup, from games.js, or one of the old built-in
   * puzzles a saved game can still deal (order, simon, match). choreStart goes out as it opens, choreDone once the
   * game calls done(). Losing (fail()) or quitting a started game sends choreFail: no second try here, the server moves
   * the game to another room. A Campfire, a storm or a pause closes it without counting as a loss (interruptGame).
   */
  function openPuzzle(chore, back) {
    const p = { kind: 'puzzle', chore, back, closed: false, timers: new Set(), startedAt: 0, pausedAt: 0, finishing: false, losing: false, ended: false, stop: null };
    const game = typeof window.LakeGames?.[chore.puzzle] === 'function' ? window.LakeGames[chore.puzzle] : null;
    const builtin = game ? null : PUZZLES[chore.puzzle];
    const status = h('p', { class: 'pz-status' });
    const area = h('div', { class: game ? 'pz-game' : 'pz-area' });
    const peek = slot();
    p.say = (text) => { status.textContent = text; };
    p.later = (fn, ms) => {
      const t = setTimeout(() => {
        p.timers.delete(t);
        if (!p.closed) fn();
      }, ms);
      p.timers.add(t);
    };
    p.stopGame = () => {
      const stop = p.stop;
      p.stop = null;
      try { stop?.(); } catch (err) { console.warn('[lake] game cleanup', err); }
    };
    p.cleanup = () => {
      p.closed = true;
      session.del(KEY_PLAYING);
      ui.confirmOver = false;
      for (const t of p.timers) clearTimeout(t);
      p.timers.clear();
      p.stopGame();
    };
    p.finish = () => finishPuzzle(p, status);
    p.lose = (how) => losePuzzle(p, how);
    p.update = () => {
      // the server moves the start on by however long the game was paused; so does this, for the wait in finishPuzzle
      const paused = !!store.state?.paused;
      if (paused && !p.pausedAt) p.pausedAt = Date.now();
      else if (!paused && p.pausedAt) {
        if (p.startedAt) p.startedAt += Date.now() - p.pausedAt;
        p.pausedAt = 0;
      }
      // a photo or talk check waiting on me: offer it here instead of popping it over the game
      const s = store.state;
      const calm = !REALTIME_GAMES.has(chore.puzzle);
      const waiting = calm && s?.you?.status === 'alive' ? s.you.confirms.filter((c) => !ui.answered.has(c.requestId)) : [];
      fill(peek, [waiting.map((c) => c.kind), ui.confirmOver], () => (waiting.length && !ui.confirmOver ? h('button', {
        type: 'button',
        class: 'waiting-banner',
        onclick: () => {
          for (const c of waiting) ui.snoozed.delete(c.requestId);
          ui.confirmOver = true;
          render();
        },
      }, `${waitingLabel(waiting)}: answer`) : ''));
    };
    p.root = h('div', { class: 'pz' },
      peek,
      h('div', { class: 'pz-bar' },
        h('div', { class: 'pz-head' },
          h('div', { class: 'kicker' }, `${choreIcon(chore)} ${back.station.name}`),
          h('h1', {}, chore.title),
          gameDetail(chore) ? h('p', { class: 'pz-detail' }, gameDetail(chore)) : ''),
        h('button', { type: 'button', class: 'pz-quit', onclick: () => quitPuzzle(p) }, 'Quit')),
      status,
      area);
    // on screen first, so a game that measures its box sees its real size
    showView(p);
    if (!game && !builtin) {
      // games.js didn't load (or is older than this chore): nothing to play, so don't start the clock
      area.className = 'pz-area';
      area.replaceChildren(h('div', { class: 'note' }, 'This game didn’t load. Reload the page and try again.',
        h('div', {}, h('button', { type: 'button', class: 'primary btn-big', style: 'margin-top:12px', onclick: () => location.reload() }, 'Reload'))));
      return;
    }
    try {
      if (game) {
        const stop = game(area, {
          done: () => { if (!p.closed) p.finish(); },
          fail: () => { if (!p.closed) p.lose('lost'); },
        });
        p.stop = typeof stop === 'function' ? stop : null;
      } else {
        area.replaceChildren(...[builtin(p)].flat());
      }
    } catch (err) {
      console.error('[lake] game', chore.puzzle, err);
      toast('That game hit a snag. Try again.', 'error');
      showView(back);
      return;
    }
    call('choreStart', { choreId: chore.id, code: back.code }).then((res) => {
      if (p.closed) return;
      if (!res.ok) {
        toast(res.error, 'error');
        showView(back);
      } else {
        p.startedAt = Date.now();
        // until it's won, lost or closed: a reload in between counts as quitting (leftGameCheck)
        session.set(KEY_PLAYING, JSON.stringify({ game: store.state?.gameNo, choreId: chore.id, code: back.code, stationId: back.station.id, at: Date.now() }));
      }
    });
  }

  /** The Quit button. Quitting a game the server saw start counts as losing it. */
  function quitPuzzle(p) {
    if (p.closed || p.ended || p.losing) return;
    if (p.finishing) {
      if (confirm('Your win is still being saved. Leave anyway? You’d have to play it again.')) showView(p.back);
      return;
    }
    if (!p.startedAt) return showView(p.back); // not started yet, so nothing to lose
    if (!confirm('Quit? It counts as a loss and this game moves to another room.')) return;
    p.lose('quit');
  }

  /**
   * A Campfire, a storm or a pause takes over the screen: stop a running phone game, without choreFail (it's not a
   * loss). A game already won or lost is left to finish. Returns true if it stopped one.
   */
  function interruptGame(why) {
    const p = ui.view;
    if (p?.kind !== 'puzzle' || p.ended || p.finishing || p.losing) return false;
    p.cleanup();
    ui.view = p.back;
    toast(`Your game stopped for the ${why}. That’s not a loss: play it again when you’re ready.`);
    return true;
  }

  /**
   * A phone game this tab left in the middle by reloading (or the phone dropping the page) counts as quitting it, like
   * Quit: otherwise a reload would be a free restart. Runs once per page load, on the first state that knows us. Not a
   * loss if a Campfire or a pause is on now (those stop a game without it counting) or the game has moved on since.
   */
  async function leftGameCheck(s) {
    if (ui.leftChecked || !s?.me) return;
    ui.leftChecked = true;
    const raw = session.get(KEY_PLAYING);
    if (!raw) return;
    session.del(KEY_PLAYING);
    let rec = null;
    try { rec = JSON.parse(raw); } catch { return; }
    const c = s.you?.chores.find((x) => x.id === rec?.choreId);
    const fresh = Date.now() - Number(rec?.at ?? 0) < 15 * 60 * 1000;
    if (!c || c.done || c.kind !== 'task' || c.stationId !== rec.stationId || rec.game !== s.gameNo) return;
    if (s.phase !== 'play' || s.paused || s.you.status === 'dead' || !fresh || ui.view?.kind === 'puzzle') return;
    const res = await call('choreFail', { choreId: c.id, code: rec.code });
    if (!res.ok) return;
    SFX.buzz();
    const st = store.state?.stations.find((x) => x.name === res.movedTo);
    $('#modal').replaceChildren(h('div', { class: 'modal-box' },
      h('h1', {}, '🏳️ You left a game'),
      h('p', {}, `The page reloaded in the middle of ${c.title}. That counts as quitting, so it moved to `, h('b', {}, `the ${res.movedTo}`), '.'),
      h('p', { class: 'small muted' }, 'It’s hidden again until you scan that room. Next time, finish the game before leaving the page.'),
      h('div', { class: 'row two' },
        h('button', { type: 'button', class: 'primary btn-big', onclick: closeModal }, 'OK'),
        st ? h('button', { type: 'button', class: 'btn-big', onclick: () => { closeModal(); openMap(st.id); } }, '🗺 Map') : '')));
    $('#modal').hidden = false;
  }

  async function finishPuzzle(p, status) {
    if (p.finishing || p.losing || p.closed) return;
    p.finishing = true;
    session.del(KEY_PLAYING); // won: a reload while it saves just means playing it again, not a loss
    p.say('Nice! Saving…');
    for (;;) {
      if (p.closed) return;
      // the server wants a minimum time between start and done (paused time doesn't count): wait out the rest
      const wait = p.startedAt && !p.pausedAt ? p.startedAt + (PUZZLE_MIN[p.chore.puzzle] ?? 3) * 1000 + 400 - Date.now() : 150;
      if (p.startedAt && !p.pausedAt && wait <= 0) break;
      // a lucky crack or a fast Wordle can be won well before then: show it counting down, so nobody thinks it hung
      // and leaves (which would throw the win away)
      p.say(p.startedAt && wait > 1500 ? `Nice! Saving in ${Math.ceil(wait / 1000)} s… Don’t leave yet.` : 'Nice! Saving…');
      await sleep(Math.min(wait, 1000));
    }
    const res = await call('choreDone', { choreId: p.chore.id, code: p.back.code });
    if (p.closed) return;
    if (!res.ok) {
      p.finishing = false;
      p.say(res.error);
      toast(res.error, 'error');
      status.append(' ', h('button', { type: 'button', class: 'small', onclick: () => p.finish() }, 'Try again'));
      return;
    }
    p.ended = true;
    p.stopGame(); // the ding comes with the state that says it's done
    p.root.replaceChildren(h('div', { class: 'pz-done' }, h('div', { class: 'pz-check' }, '✓'), h('div', {}, 'Done!'), h('div', { class: 'small muted' }, p.chore.title)));
    p.later(() => showView(p.back), 1300);
  }

  /** Lost (the game called fail) or quit: choreFail, then say where the game went. No retry here. */
  async function losePuzzle(p, how) {
    if (p.closed || p.ended || p.finishing || p.losing) return;
    p.losing = true;
    p.stopGame();
    for (const t of p.timers) clearTimeout(t);
    p.timers.clear();
    ui.confirmOver = false;
    if (how !== 'quit') {
      SFX.buzz();
      vibrate([200, 80, 200]);
    }
    const body = h('div', { class: 'pz-lost', role: 'status' });
    p.root.replaceChildren(body);
    const send = async () => {
      fill(body, ['saving'], () => lostScreen(p, how, null, send));
      const res = await call('choreFail', { choreId: p.chore.id, code: p.back.code });
      if (res.ok) {
        p.ended = true;
        session.del(KEY_PLAYING);
      }
      if (p.closed) {
        // a Campfire closed the screen meanwhile: still say where the game went
        if (res.ok) toast(`${p.chore.title} moved to the ${res.movedTo}. Find it there.`, 'error');
        return;
      }
      fill(body, [res.ok, res.movedTo, res.error], () => lostScreen(p, how, res, send));
      render(); // a check held back during the game can show now
    };
    await send();
  }

  function lostScreen(p, how, res, retry) {
    const quit = how === 'quit';
    const head = [
      h('div', { class: 'pz-lost-icon', 'aria-hidden': 'true' }, quit ? '🏳️' : '💥'),
      h('h1', {}, quit ? 'You quit' : 'You lost'),
      h('div', { class: 'small muted' }, `${choreIcon(p.chore)} ${p.chore.title}`),
    ];
    if (!res) return [...head, h('p', { class: 'muted' }, 'Moving this game to another room…')];
    if (!res.ok) {
      return [...head,
        h('p', { class: 'error' }, res.error),
        h('div', { class: 'pz-lost-btns' },
          h('button', { type: 'button', class: 'primary btn-big', onclick: retry }, 'Try again'),
          h('button', { type: 'button', class: 'btn-big', onclick: () => showView(p.back) }, 'Back'))];
    }
    const st = store.state?.stations.find((x) => x.name === res.movedTo);
    return [...head,
      h('p', { class: 'pz-lost-line' }, quit ? 'That counts as a loss: this game moved to ' : 'This game moved to ', h('b', {}, `the ${res.movedTo}`), '. Find it there.'),
      st?.where ? h('p', { class: 'muted' }, st.where) : '',
      h('p', { class: 'small muted' }, 'It’s hidden again until you scan that room, and you play it from the start there.'),
      h('div', { class: 'pz-lost-btns' },
        h('button', { type: 'button', class: 'primary btn-big', onclick: () => showView(null) }, 'Back to the rooms'),
        st ? h('button', { type: 'button', class: 'btn-big', onclick: () => openMap(st.id) }, '🗺 Show it on the map') : '')];
  }

  const ORDER_N = 16;
  function orderPuzzle(p) {
    let next = 1;
    let locked = false; // a moment after a wrong tap, while the board reshuffles
    const grid = h('div', { class: 'pz-grid' });
    const deal = () => grid.replaceChildren(...shuffle(Array.from({ length: ORDER_N }, (_, i) => i + 1)).map((n) =>
      h('button', { type: 'button', class: 'pz-num', onclick: (e) => tap(n, e.currentTarget) }, n)));
    function tap(n, b) {
      if (locked || next > ORDER_N || n < next) return;
      if (n === next) {
        b.classList.add('ok');
        SFX.blip();
        next += 1;
        if (next > ORDER_N) p.finish();
        else p.say(`Next: ${next}`);
        return;
      }
      SFX.buzz();
      b.classList.add('bad');
      locked = true;
      next = 1;
      p.say(`Oops, that was ${n}. Shuffled! Start again from 1.`);
      p.later(() => {
        locked = false;
        deal();
      }, 450);
    }
    deal();
    p.say(`Tap 1 to ${ORDER_N} in order. A wrong tap shuffles the board.`);
    return grid;
  }

  const PADS = [{ color: '#3fb950', freq: 392 }, { color: '#f85149', freq: 330 }, { color: '#d29922', freq: 262 }, { color: '#58a6ff', freq: 523 }];
  const SIMON_STEPS = 7;
  function simonPuzzle(p) {
    const seq = Array.from({ length: SIMON_STEPS }, () => Math.floor(Math.random() * PADS.length));
    let pos = 0;
    let listening = false;
    const light = (i, ms) => {
      pads[i].classList.add('lit');
      SFX.pad(PADS[i].freq);
      p.later(() => pads[i].classList.remove('lit'), ms);
    };
    const pads = PADS.map((pad, i) => h('button', {
      type: 'button',
      class: 'pz-pad',
      style: `--c:${pad.color}`,
      'aria-label': `Pad ${i + 1}`,
      onpointerdown: () => press(i),
    }));
    function play() {
      listening = false;
      pos = 0;
      p.say('Watch the pattern…');
      seq.forEach((i, k) => p.later(() => light(i, 340), 700 + k * 540));
      p.later(() => {
        listening = true;
        p.say(`Your turn: repeat it (0 of ${SIMON_STEPS})`);
      }, 700 + seq.length * 540);
    }
    function press(i) {
      if (!listening) return;
      if (i === seq[pos]) {
        light(i, 200);
        pos += 1;
        if (pos === seq.length) {
          listening = false;
          p.finish();
        } else p.say(`Your turn: repeat it (${pos} of ${SIMON_STEPS})`);
        return;
      }
      listening = false;
      SFX.buzz();
      p.say('Oops! Watch again.');
      p.later(play, 900);
    }
    play();
    return h('div', { class: 'pz-simon' }, pads);
  }

  // Each game draws its 6 pairs from one family of look-alikes, on tiles of near-identical shades, so you have to
  // actually look. The two sides get their shades independently: only the picture counts.
  const MATCH_SETS = [
    ['🐦', '🐤', '🐥', '🐣', '🦆', '🐧', '🦅', '🦉'],
    ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'],
    ['🌲', '🌳', '🌴', '🎄', '🌵', '🌿', '🌱', '🍀'],
    ['🐟', '🐠', '🐡', '🦈', '🐬', '🐳', '🐋', '🐙'],
    ['😀', '😃', '😄', '😁', '😆', '😅', '🙂', '😊'],
  ];
  const MATCH_SHADES = [
    ['#2ea043', '#3fb950', '#56d364', '#238636', '#46954a', '#6fdd8b'],
    ['#388bfd', '#58a6ff', '#79c0ff', '#1f6feb', '#4493f8', '#a5d6ff'],
    ['#d29922', '#e3b341', '#f2cc60', '#bb8009', '#c69026', '#eac54f'],
  ];
  const MATCH_PAIRS = 6;
  function matchPuzzle(p) {
    const items = shuffle(MATCH_SETS[Math.floor(Math.random() * MATCH_SETS.length)]).slice(0, MATCH_PAIRS);
    const shades = MATCH_SHADES[Math.floor(Math.random() * MATCH_SHADES.length)];
    let right = shuffle(items);
    while (right.some((x, i) => x === items[i])) right = shuffle(items);
    const leftShades = shuffle(shades);
    const rightShades = shuffle(shades);
    let pick = null;
    let matched = 0;
    const tile = (it, color, onclick) => h('button', { type: 'button', class: 'pz-tile', style: `--c:${color}`, onclick }, it);
    const L = items.map((it, i) => tile(it, leftShades[i], () => {
      if (L[i].classList.contains('done')) return;
      for (const b of L) b.classList.remove('sel');
      pick = i;
      L[i].classList.add('sel');
      SFX.blip();
    }));
    const R = right.map((it, j) => tile(it, rightShades[j], () => {
      if (R[j].classList.contains('done')) return;
      if (pick == null) return p.say('Tap one on the left first.');
      if (right[j] === items[pick]) {
        L[pick].classList.replace('sel', 'done');
        R[j].classList.add('done');
        pick = null;
        matched += 1;
        SFX.blip();
        if (matched === items.length) p.finish();
        else p.say(`${matched} of ${items.length} matched`);
        return;
      }
      SFX.buzz();
      R[j].classList.add('bad');
      p.later(() => R[j].classList.remove('bad'), 350);
      L[pick].classList.remove('sel');
      pick = null;
      p.say('Not a match. Look closer!');
    }));
    p.say('Tap one on the left, then its exact twin on the right.');
    return h('div', { class: 'pz-match' }, h('div', { class: 'pz-col' }, L), h('div', { class: 'pz-col' }, R));
  }

  /** The old built-in puzzles, still dealt by a game saved before the phone games came in. */
  const PUZZLES = { order: orderPuzzle, simon: simonPuzzle, match: matchPuzzle };

  // ---- activities: do something for real while a timer runs

  /** The words on an activity's screen. A ghost's talk chore is a silent one on the same screen. */
  function actWords(c, ghost) {
    if (c.kind === 'talk') {
      return {
        detail: `👻 Ghosts can’t talk. Silently wave at ${c.need ?? 3} different players until the timer runs out.`,
        note: '',
        ready: 'Tap Start, then go wave. Not a sound!',
        running: 'Keep waving. Not a sound!',
        after: 'Time’s up. Tap Done.',
        doneLabel: 'Done',
      };
    }
    const skill = SKILL_STATIONS.has(c.stationId);
    const words = {
      detail: c.detail ?? '',
      note: '',
      ready: 'Tap Start, then keep going until the timer runs out.',
      running: 'Keep going!',
      after: 'Time’s up! Tap Done.',
      doneLabel: 'Done',
    };
    if (c.voice && ghost) {
      return {
        ...words,
        detail: c.stationId === 'radio'
          ? '👻 Ghosts make no sound: lip-sync it into the radio, silently, until the timer runs out.'
          : '👻 Ghosts make no sound: mime it, silently, until the timer runs out.',
        note: c.detail ? `The chore: ${c.detail}` : '',
        ready: c.stationId === 'radio' ? 'Tap Start, then lip-sync. Not a sound!' : 'Tap Start, then mime it. Not a sound!',
        running: c.stationId === 'radio' ? 'Keep lip-syncing. Not a sound!' : 'Keep miming. Not a sound!',
      };
    }
    if (skill) {
      return {
        ...words,
        ready: 'Tap Start, then play. Keep trying until you do it.',
        running: 'Keep playing until you do it!',
        after: 'Did it? Tap “I did it!”. Not yet? Keep playing, then tap it when you do.',
        doneLabel: 'I did it!',
      };
    }
    if (c.voice) return { ...words, running: 'Keep it going on the radio!' };
    if (c.stationId === 'campfire') return { ...words, running: 'Keep dancing! No stopping!' };
    return words;
  }

  /**
   * Start → a big countdown of chore.seconds → Done. The countdown stands still while the game is paused (the server
   * moves the start time on by the pause), and a Campfire closes the screen like a puzzle. `back` is the station
   * screen, or null for a ghost's silent talk chore, which has no station and no code.
   */
  function openAct(chore, back) {
    const ghost = store.state?.you?.status === 'ghost';
    const w = actWords(chore, ghost);
    const total = Math.max(1, chore.seconds ?? 30) * 1000;
    const v = { kind: 'act', chore, back, closed: false, phase: 'ready', left: total, last: 0, iv: 0, timers: new Set() };
    const withCode = (extra) => (back?.code ? { ...extra, code: back.code } : extra);
    const status = h('p', { class: 'pz-status' }, w.ready);
    const time = h('div', { class: 'act-time' }, fmtLeft(total));
    const sub = h('div', { class: 'act-sub' }, 'Ready');
    const ring = h('div', { class: 'act-ring', style: '--f:0', role: 'timer', 'aria-label': 'Time left' }, h('div', { class: 'act-face' }, time, sub));
    const start = h('button', { type: 'button', class: 'primary btn-big', onclick: begin }, '▶ Start');
    const done = h('button', { type: 'button', class: 'yes-btn btn-big', hidden: true, disabled: true, onclick: finish }, w.doneLabel);
    const later = (fn, ms) => {
      const t = setTimeout(() => {
        v.timers.delete(t);
        if (!v.closed) fn();
      }, ms);
      v.timers.add(t);
    };
    v.cleanup = () => {
      v.closed = true;
      clearInterval(v.iv);
      for (const t of v.timers) clearTimeout(t);
      v.timers.clear();
    };
    const leave = () => {
      if (v.phase === 'running' && !confirm('Stop now? The timer starts over next time.')) return;
      showView(back);
    };

    async function begin() {
      start.disabled = true;
      const res = await call('choreStart', withCode({ choreId: chore.id }));
      if (v.closed) return;
      if (!res.ok) {
        start.disabled = false;
        return toast(res.error, 'error');
      }
      v.phase = 'running';
      v.left = total;
      v.last = Date.now();
      start.hidden = true;
      done.hidden = false;
      status.textContent = w.running;
      sub.textContent = 'left';
      SFX.blip();
      v.iv = setInterval(step, 200);
      step();
    }

    function step() {
      if (v.closed || v.phase !== 'running') return;
      const t = Date.now();
      if (!store.state?.paused) v.left -= t - v.last;
      v.last = t;
      const left = Math.max(0, v.left);
      const text = fmtLeft(left);
      if (time.textContent !== text) time.textContent = text;
      ring.style.setProperty('--f', String(1 - left / total));
      if (left > 0) return;
      clearInterval(v.iv);
      v.phase = 'over';
      ring.classList.add('over');
      sub.textContent = 'Time’s up';
      status.textContent = w.after;
      done.disabled = false;
      SFX.stage();
      vibrate([80, 60, 80]);
    }

    async function finish() {
      done.disabled = true;
      const res = await call('choreDone', withCode({ choreId: chore.id }));
      if (v.closed) return;
      if (!res.ok) {
        done.disabled = false;
        status.textContent = res.error;
        return;
      }
      v.phase = 'saved';
      v.root.replaceChildren(h('div', { class: 'pz-done' }, h('div', { class: 'pz-check' }, '✓'), h('div', {}, 'Done!'), h('div', { class: 'small muted' }, chore.title)));
      later(() => showView(back), 1300);
    }

    const place = back ? back.station.name : chore.kind === 'talk' ? '💬 Anywhere' : chore.stationName ?? '';
    v.root = h('div', { class: 'pz act' },
      h('div', { class: 'pz-head' }, h('div', { class: 'kicker' }, place), h('h1', {}, `${chore.kind === 'talk' ? '👋' : choreIcon(chore)} ${chore.title}`)),
      status,
      h('div', { class: 'pz-area' },
        h('div', { class: 'act-detail' }, h('p', {}, w.detail), w.note ? h('p', { class: 'small muted' }, w.note) : ''),
        ring,
        h('div', { class: 'act-btns' }, start, done)),
      h('div', { class: 'pz-foot' }, h('button', { type: 'button', class: 'btn-big', onclick: leave }, 'Cancel')));
    showView(v);
  }

  // ---- the talk chore: no station, done from the chore list

  function openTalk(choreId) {
    const s = store.state;
    const c = s?.you?.chores.find((x) => x.id === choreId);
    if (!c || c.done || s.phase !== 'play') return;
    if (s.you.status === 'ghost') return openAct(c, null);
    const v = { kind: 'talk', choreId, closing: false };
    const progress = slot();
    const ask = slot();
    const pick = box();
    v.root = h('div', { class: 'sheet-inner' },
      sheetHead(() => showView(null)),
      h('div', { class: 'station-head' }, h('div', { class: 'kicker' }, '💬 Anywhere'), h('h1', {}, c.title), h('p', { class: 'muted' }, c.detail ?? '')),
      progress, ask, pick);
    v.update = () => {
      const st = store.state;
      const ch = st?.you?.chores.find((x) => x.id === choreId);
      if (!ch) return;
      const partner = ch.pending ? ui.partnerOf[ch.id] ?? null : null;
      fill(progress, [ch.progress, ch.need, ch.done], () => talkProgress(ch));
      fill(ask, [ch.done, ch.pending, ch.question, partner], () => talkAsk(ch, partner));
      const mates = st.players.filter((p) => p.inGame && !p.out && p.id !== st.me.id);
      fill(pick, [ch.done, ch.pending ? ui.talkTo[ch.id] ?? null : null, ui.talked[ch.id] ?? [], mates.map((m) => [m.id, m.name, m.color])],
        () => talkPicker(ch, mates));
      if (ch.done && !v.closing) {
        v.closing = true;
        setTimeout(() => { if (ui.view === v) showView(null); }, 1800);
      }
    };
    showView(v);
  }

  function talkProgress(ch) {
    const need = ch.need ?? 3;
    const got = Math.min(need, ch.progress ?? 0);
    return h('div', { class: 'talk-progress' },
      h('div', { class: 'talk-dots', 'aria-hidden': 'true' }, Array.from({ length: need }, (_, i) => h('span', { class: i < got ? 'on' : '' }, i < got ? '✓' : ''))),
      h('div', { class: 'talk-count' }, ch.done ? `✓ Done! ${need} of ${need} said yes` : `${got} of ${need} said yes`));
  }

  function talkAsk(ch, partner) {
    if (ch.done) return h('p', { class: 'ok-line center' }, 'All done ✓ Nice chatting!');
    if (!ch.pending) return h('p', { class: 'note' }, 'Find someone in person, pick them below, then ask them the question that shows up here.');
    const who = partner ?? 'them';
    return h('section', { class: 'talk-ask' },
      h('div', { class: 'kicker' }, `Ask ${who}`),
      h('p', { class: 'talk-q' }, `“${ch.question ?? '…'}”`),
      h('p', { class: 'talk-wait' }, `Waiting for ${who} to tap Yes on their phone…`));
  }

  function talkPicker(ch, mates) {
    if (ch.done) return '';
    const talked = ui.talked[ch.id] ?? [];
    const current = ch.pending ? ui.talkTo[ch.id] : null;
    return [
      h('h2', {}, ch.pending ? 'Or ask someone else' : 'Who are you talking to?'),
      mates.length
        ? h('div', { class: 'pick-grid' }, mates.map((m) => {
          const did = talked.includes(m.id);
          return h('button', {
            type: 'button',
            class: `pick ${m.id === current ? 'sel' : ''}`,
            disabled: did,
            onclick: (e) => askTalk(ch, m, e.currentTarget),
          }, pdot(m.color), m.name, did ? ' ✓' : '');
        }))
        : h('p', { class: 'muted' }, 'Nobody else is in the game right now.'),
      h('p', { class: 'small muted' }, 'Each person counts once. Picking someone new replaces the one you’re waiting on.'),
    ];
  }

  async function askTalk(ch, m, btn) {
    btn.disabled = true;
    // set before asking: the state with the new question can land before the answer does
    const before = [ui.partnerOf[ch.id], ui.talkTo[ch.id]];
    ui.partnerOf[ch.id] = m.name;
    ui.talkTo[ch.id] = m.id;
    const res = await call('talk', { choreId: ch.id, partnerId: m.id });
    if (!res.ok) {
      [ui.partnerOf[ch.id], ui.talkTo[ch.id]] = before;
      if (/already talked/i.test(res.error ?? '')) ui.talked[ch.id] = [...new Set([...(ui.talked[ch.id] ?? []), m.id])];
      toast(res.error, 'error');
      btn.disabled = false;
      return render();
    }
    SFX.blip();
    render();
  }

  // ---- the house map: this game's rooms with chores (public counts) and mine (only my own chores, never anyone else's)

  const MAP_TABS = [['main', 'Main'], ['upstairs', 'Upstairs'], ['basement', 'Basement'], ['other', 'Outside']];
  const tabOf = (st) => st?.map?.floor ?? 'other';

  /** Per enabled station: my chores there, the room's progress (game rooms), the Campfire, the storm and my last scan. */
  function mapMarks(s) {
    const { rooms } = myRooms(s, s.you);
    const last = lastStationId(s);
    const marks = {};
    for (const st of s.stations) {
      const r = rooms.find((x) => x.id === st.id);
      const gr = s.rooms?.find((x) => x.id === st.id);
      const storm = s.storm?.stations.find((x) => x.id === st.id);
      const open = r ? r.chores.filter((c) => !c.done) : [];
      marks[st.id] = {
        game: !!gr,
        rdone: gr?.done ?? 0,
        rtotal: gr?.total ?? 0,
        todo: open.length,
        total: r?.chores.length ?? 0,
        hidden: open.filter((c) => c.hidden).length,
        titles: open.filter((c) => !c.hidden).map((c) => `${choreIcon(c)} ${choreText(c)}`),
        fire: st.id === s.campfire?.id,
        storm: storm ? (storm.secured ? 'secured' : 'on') : null,
        last: st.id === last,
      };
    }
    return marks;
  }

  const tabTodo = (s, marks, tab) => s.stations.filter((st) => tabOf(st) === tab).reduce((n, st) => n + (marks[st.id]?.todo ?? 0), 0);

  function busiestTab(s, marks) {
    let best = 'main';
    let most = 0;
    for (const [id] of MAP_TABS) {
      const n = tabTodo(s, marks, id);
      if (n > most) [best, most] = [id, n];
    }
    return best;
  }

  /** The marker: amber count to do, green ✓ all done, gray dot nothing for me; 🔥 Campfire; red pulse storm; ring last scan. */
  function mapBadge(m, extra = '') {
    const cls = ['mk', m.todo ? 'todo' : m.total ? 'ok' : 'none', m.game ? 'game' : '', m.fire ? 'fire' : '', m.storm === 'on' ? 'storm' : '', m.last ? 'last' : '', extra]
      .filter(Boolean).join(' ');
    if (m.fire) {
      return h('span', { class: cls }, '🔥', m.todo ? h('span', { class: 'mk-n' }, m.todo) : m.total ? h('span', { class: 'mk-n ok' }, '✓') : '');
    }
    return h('span', { class: cls }, m.todo ? String(m.todo) : m.total ? '✓' : '');
  }

  const roomDone = (m) => m.game && m.rtotal > 0 && m.rdone >= m.rtotal;
  const pinStatus = (m) => [
    m.todo ? `${m.todo} for you` : m.total ? 'yours done' : '',
    m.game ? `room ${m.rdone}/${m.rtotal}` : m.total ? '' : 'no chores',
  ].filter(Boolean).join(' · ');
  /** The room's progress for everyone (game rooms only). */
  const roomChip = (m, extra = '') => (m.game ? h('span', { class: `pin-n ${roomDone(m) ? 'ok' : ''} ${extra}` }, `${roomDone(m) ? '✓' : ''}${m.rdone}/${m.rtotal}`) : '');
  // a room with no chores this game fades out, unless it matters to me (my drop-off, the Campfire, a storm)
  const offMap = (m) => !m.game && !m.total && !m.fire && !m.storm;

  function mapPin(st, m, v) {
    return h('button', {
      type: 'button',
      // a name near an edge hangs inward, so it never runs off the map
      class: `pin ${st.map.x > 72 ? 'lab-r' : st.map.x < 28 ? 'lab-l' : ''} ${v.sel === st.id ? 'sel' : ''} ${m.game ? 'game' : ''} ${offMap(m) ? 'off' : ''}`,
      style: `left:${st.map.x}%;top:${st.map.y}%`,
      'data-id': st.id,
      'aria-label': `${st.name}: ${pinStatus(m)}`,
      onclick: () => v.pick(st.id),
    }, mapBadge(m), roomChip(m), h('span', { class: 'pin-label' }, st.name));
  }

  function mapInfo(st, m) {
    const lines = [];
    if (m.storm === 'on') lines.push(h('p', { class: 'map-storm' }, '⛈ Storm station! Two different players must secure the two storm stations.'));
    if (m.storm === 'secured') lines.push(h('p', { class: 'small ok-text' }, '⛈ Secured for this storm'));
    if (m.fire) lines.push(h('p', {}, '🔥 The Campfire: everyone meets here, and the bell is here.'));
    if (m.game) {
      lines.push(h('p', { class: roomDone(m) ? 'ok-text' : '' }, roomDone(m) ? `✓ All ${m.rtotal} chores in this room are done` : `This room: ${m.rdone} of ${plural(m.rtotal, 'chore')} done`));
    } else if (!m.total) lines.push(h('p', { class: 'muted' }, 'No chores in this room this game.'));
    if (m.todo) {
      lines.push(h('p', { class: 'map-todo' }, `${m.todo} to do here`));
      if (m.titles.length) lines.push(h('ul', { class: 'map-titles' }, m.titles.map((t) => h('li', {}, t))));
      if (m.hidden) lines.push(h('p', { class: 'small muted' }, `🔒 ${m.titles.length ? `${plural(m.hidden, 'more chore')} hidden` : 'Hidden'} until you scan the room.`));
    } else if (m.total) lines.push(h('p', { class: 'ok-text' }, '✓ Your chores here are done'));
    else if (m.game) lines.push(h('p', { class: 'muted' }, 'Nothing for you here.'));
    if (m.last) lines.push(h('p', { class: 'small muted' }, '📍 You scanned this one last.'));
    return h('section', { class: 'box map-info' },
      h('div', { class: 'row' }, mapBadge({ ...m, last: false }, 'inline'), h('div', { class: 'grow' }, h('b', { class: 'map-info-name' }, st.name), h('div', { class: 'small muted' }, st.where))),
      lines);
  }

  const mapLegend = () => h('div', { class: 'map-legend small muted' },
    h('span', {}, mapBadge({ todo: 2, total: 2 }, 'inline mini'), 'for you'),
    h('span', {}, mapBadge({ todo: 0, total: 1 }, 'inline mini'), 'yours done'),
    h('span', {}, mapBadge({ todo: 0, total: 0, game: true }, 'inline mini'), roomChip({ game: true, rdone: 1, rtotal: 3 }, 'inline'), 'room with chores: how many are done'),
    h('span', {}, h('span', { class: 'mk none inline mini off' }), 'no chores this game'),
    h('span', {}, '🔥 Campfire'),
    h('span', {}, mapBadge({ todo: 0, total: 0, storm: 'on' }, 'inline mini'), 'storm'),
    h('span', {}, mapBadge({ todo: 0, total: 0, last: true }, 'inline mini'), 'scanned last'));

  /** The house map in a sheet. `focusId` opens it on that station (picked, and scrolled to when zoomed in). */
  function openMap(focusId = null) {
    const s = store.state;
    if (!s?.you) return;
    const back = ui.view?.kind === 'station' ? ui.view : null;
    const focus = focusId ? s.stations.find((x) => x.id === focusId) : null;
    const last = s.stations.find((x) => x.id === lastStationId(s));
    const v = { kind: 'map', back, sel: focus?.id ?? null, tab: focus ? tabOf(focus) : ui.mapTab ?? (last ? tabOf(last) : busiestTab(s, mapMarks(s))), center: !!focus };
    const tabs = h('div', { class: 'map-tabs', role: 'tablist' });
    const tools = slot();
    const img = h('img', { class: 'map-img', alt: '', draggable: false });
    const pins = h('div', { class: 'map-pins' });
    const canvas = h('div', { class: 'map-canvas' }, img, pins);
    const scroller = h('div', { class: 'map-scroll' }, canvas);
    const list = slot();
    const info = slot();
    v.root = h('div', { class: 'sheet-inner map-sheet' },
      sheetHead(() => showView(back)),
      h('h1', { class: 'sheet-title' }, '🗺 Map'),
      tabs, tools, scroller, list, info, mapLegend());
    v.pick = (id) => {
      v.sel = v.sel === id ? null : id;
      render();
    };
    v.update = () => {
      const st = store.state;
      if (!st?.you) return;
      const marks = mapMarks(st);
      const floor = v.tab !== 'other';
      const counts = MAP_TABS.map(([id]) => tabTodo(st, marks, id));
      fill(tabs, [v.tab, counts], () => MAP_TABS.map(([id, label], i) => h('button', {
        type: 'button',
        role: 'tab',
        'aria-selected': String(id === v.tab),
        class: `map-tab ${id === v.tab ? 'on' : ''}`,
        onclick: () => {
          v.tab = id;
          ui.mapTab = id;
          v.sel = null;
          render();
        },
      }, label, counts[i] ? h('span', { class: 'tab-n' }, counts[i]) : '')));
      scroller.hidden = !floor;
      if (floor && img.dataset.floor !== v.tab) {
        img.dataset.floor = v.tab;
        img.src = `/lake/maps/${v.tab}.jpg`;
        img.alt = `${MAP_TABS.find(([id]) => id === v.tab)[1]} floor plan`;
        scroller.scrollLeft = 0;
      }
      canvas.classList.toggle('zoomed', !!ui.mapZoom);
      const here = st.stations.filter((x) => tabOf(x) === v.tab);
      fill(tools, [floor, ui.mapZoom], () => (floor ? h('div', { class: 'map-tools' },
        h('span', { class: 'small muted grow' }, ui.mapZoom ? 'Swipe sideways to see the rest.' : 'Tap a marker to see what’s there.'),
        h('button', {
          type: 'button',
          class: 'map-zoom',
          onclick: () => {
            ui.mapZoom = !ui.mapZoom;
            v.center = true;
            render();
          },
        }, ui.mapZoom ? '↙ Fit' : '🔍 Zoom in')) : ''));
      const key = [v.tab, v.sel, here.map((x) => [x.id, marks[x.id]])];
      fill(pins, floor ? key : null, () => (floor ? here.filter((x) => x.map).map((x) => mapPin(x, marks[x.id], v)) : ''));
      fill(list, floor ? null : key, () => {
        if (floor) return '';
        if (!here.length) return h('p', { class: 'note' }, 'No outside stations are in this game.');
        return h('ul', { class: 'map-list' }, here.map((x) => h('li', {},
          h('button', { type: 'button', class: `map-row ${v.sel === x.id ? 'sel' : ''} ${offMap(marks[x.id]) ? 'off' : ''}`, onclick: () => v.pick(x.id) },
            mapBadge(marks[x.id], 'inline'),
            h('span', { class: 'grow' }, h('b', {}, x.name), h('span', { class: 'map-row-where' }, x.where)),
            h('span', { class: 'map-row-status' }, pinStatus(marks[x.id]))))));
      });
      const sel = here.find((x) => x.id === v.sel);
      fill(info, sel ? [sel.id, marks[sel.id]] : null, () => (sel ? mapInfo(sel, marks[sel.id]) : ''));
      if (v.center) {
        v.center = false;
        requestAnimationFrame(() => {
          const pin = v.sel && pins.querySelector(`[data-id="${v.sel}"]`);
          if (pin && ui.view === v) scroller.scrollLeft = pin.offsetLeft - scroller.clientWidth / 2;
        });
      }
    };
    showView(v);
  }

  // ---- the in-app QR scanner

  /** What a scanned QR says: { code } for a station card, { join: true } for the join poster, {} for anything else. */
  function parseScan(text) {
    const t = String(text ?? '').trim();
    if (/^[A-Za-z0-9]{4}$/.test(t)) return t.toUpperCase() === 'JOIN' ? { join: true } : { code: t.toUpperCase() };
    let u;
    try {
      u = new URL(t);
    } catch {
      return {};
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return {};
    const m = u.pathname.match(/^\/lake\/s\/([A-Za-z0-9]{4})\/?$/);
    if (m) return { code: m[1].toUpperCase() };
    if (/^\/lake\/?$/.test(u.pathname)) return { join: true };
    return {};
  }

  function cameraError(err) {
    const name = err?.name ?? '';
    if (['NotAllowedError', 'SecurityError', 'PermissionDeniedError'].includes(name)) {
      return 'The camera is blocked for this site. To allow it on an iPhone: tap aA in the address bar → Website Settings → Camera → Allow, then Try again. Or type the code printed under the QR.';
    }
    if (['NotFoundError', 'OverconstrainedError', 'DevicesNotFoundError'].includes(name)) return 'No camera found on this device. Type the code printed under the QR instead.';
    if (['NotReadableError', 'TrackStartError', 'AbortError'].includes(name)) return 'The camera is busy (another app may be using it). Close that and Try again, or type the code printed under the QR.';
    return 'Couldn’t open the camera. Type the code printed under the QR instead.';
  }

  /** Full-screen camera that reads station QR codes (window.jsQR) and opens the station, like typing its code. */
  function openScanner() {
    const back = ui.view?.kind === 'station' ? ui.view : null;
    const v = { kind: 'scan', back, stream: null, timer: 0, run: 0, closed: false, said: '', saidAt: 0 };
    const video = h('video', { class: 'scan-video', autoplay: true, muted: true, playsInline: true });
    for (const a of ['autoplay', 'muted', 'playsinline']) video.setAttribute(a, '');
    const canvas = document.createElement('canvas');
    const msg = h('p', { class: 'scan-msg', role: 'status' });
    const actions = h('div', { class: 'scan-actions' });
    const say = (text, bad = false) => {
      msg.textContent = text;
      msg.classList.toggle('bad', bad);
    };
    const stop = () => {
      v.run += 1; // a camera still starting is stopped as soon as it arrives
      clearTimeout(v.timer);
      v.timer = 0;
      for (const t of v.stream?.getTracks() ?? []) t.stop();
      v.stream = null;
      try { video.pause(); } catch { /* not playing */ }
      video.srcObject = null;
    };
    v.cleanup = () => {
      v.closed = true;
      stop();
      canvas.width = 0;
      canvas.height = 0;
    };
    const typeIt = () => {
      showView(back);
      // straight away, inside the tap, so the keyboard comes up
      document.querySelector('input[aria-label="Station code"]')?.focus();
    };
    const typeBtn = () => h('button', { type: 'button', class: 'btn-big', onclick: typeIt }, '⌨️ Type the code instead');
    const againBtn = (label = 'Try again') => h('button', { type: 'button', class: 'primary btn-big', onclick: start }, label);

    function fail(text) {
      stop();
      say(text, true);
      actions.replaceChildren(againBtn(), typeBtn());
    }

    async function start() {
      stop();
      const run = v.run;
      actions.replaceChildren(typeBtn());
      if (!navigator.mediaDevices?.getUserMedia) {
        return fail(window.isSecureContext === false
          ? 'The camera only works on the https:// link of the game. Type the code printed under the QR instead.'
          : 'This browser can’t use the camera here. Type the code printed under the QR instead.');
      }
      if (typeof window.jsQR !== 'function') return fail('The scanner didn’t load. Reload the page, or type the code printed under the QR.');
      say('Starting the camera…');
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      } catch (err) {
        if (run === v.run && !v.closed) fail(cameraError(err));
        return;
      }
      if (run !== v.run || v.closed) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      v.stream = stream;
      video.srcObject = stream;
      try { await video.play(); } catch { /* muted inline video plays by itself; frames still arrive */ }
      if (run !== v.run || v.closed) return;
      say('Point the camera at the QR code on the station card.');
      v.timer = setTimeout(scan, 150);
    }

    function scan() {
      v.timer = 0;
      if (v.closed || !v.stream) return;
      const w0 = video.videoWidth;
      const h0 = video.videoHeight;
      if (video.readyState >= 2 && w0 && h0) {
        // a smaller copy decodes faster and a QR card held up close still reads fine
        const k = Math.min(1, 640 / Math.max(w0, h0));
        const w = Math.max(1, Math.round(w0 * k));
        const ht = Math.max(1, Math.round(h0 * k));
        if (canvas.width !== w || canvas.height !== ht) [canvas.width, canvas.height] = [w, ht];
        const g = canvas.getContext('2d', { willReadFrequently: true });
        let hit = null;
        try {
          g.drawImage(video, 0, 0, w, ht);
          hit = window.jsQR(g.getImageData(0, 0, w, ht).data, w, ht, { inversionAttempts: 'dontInvert' });
        } catch { /* a frame that isn't ready */ }
        if (hit?.data && found(hit.data)) return;
      }
      v.timer = setTimeout(scan, 150);
    }

    /** Handles a decoded QR. True when scanning is over (a station code). */
    function found(text) {
      const r = parseScan(text);
      if (r.code) {
        stop();
        SFX.blip();
        vibrate(40);
        say(`Opening ${r.code}…`);
        actions.replaceChildren();
        openStation(r.code).then((ok) => {
          if (ok || v.closed) return;
          say('That code didn’t open a station. Scan another card, or type the code.', true);
          actions.replaceChildren(againBtn('Scan again'), typeBtn());
        });
        return true;
      }
      // the same wrong code stays in view for a while: say so once, not 7 times a second
      const t = Date.now();
      if (text !== v.said || t - v.saidAt > 3000) {
        v.said = text;
        v.saidAt = t;
        say(r.join ? 'That’s the join code. Scan a station card instead.' : 'That QR code isn’t a station card. Scan the one at the station.', true);
        SFX.buzz();
      }
      return false;
    }

    v.root = h('div', { class: 'scan' },
      video,
      h('div', { class: 'scan-frame', 'aria-hidden': 'true' }),
      h('div', { class: 'scan-top' },
        h('b', {}, '📷 Scan a station QR'),
        h('button', { type: 'button', class: 'scan-close', onclick: () => showView(back) }, '✕ Close')),
      h('div', { class: 'scan-bottom' }, msg, actions));
    showView(v);
    start();
  }

  // ---- photos

  /** Shrinks a camera photo to ≤ max px on the long side as a JPEG data URL. */
  async function shrinkPhoto(file, max = 1280, quality = 0.75) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/jpeg', quality);
      // iPhones cap the memory all canvases may hold and are slow to free it: let go of this one now
      canvas.width = 0;
      canvas.height = 0;
      img.src = '';
      if (!data.startsWith('data:image/jpeg')) throw new Error('could not encode');
      return data;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function uploadPhoto(body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000);
    try {
      const res = await fetch('/lake/api/photo', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${storage.get(KEY_TOKEN) ?? ''}` },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) return { ok: false, error: data.error || `Upload failed (${res.status}). Try again.` };
      return { ok: true, ...data };
    } catch {
      return { ok: false, error: 'Upload failed. Check your connection and try again.' };
    } finally {
      clearTimeout(timer);
    }
  }

  function openPhoto(chore, back) {
    const s = store.state;
    const needPartner = !!chore.partner && s.you.status === 'alive';
    const v = { kind: 'photo', chore, back, image: null, partner: null, sending: false, closed: false };
    v.cleanup = () => { v.closed = true; };
    const status = h('p', { class: 'muted center' });
    const preview = h('img', { class: 'photo-preview', alt: 'Your photo', hidden: true });
    const shootLabel = h('span', {}, '📷 Open the camera');
    const file = h('input', {
      type: 'file',
      accept: 'image/*',
      capture: chore.partner ? 'user' : 'environment', // the partner photos are selfies
      class: 'visually-hidden',
      onchange: async () => {
        const f = file.files?.[0];
        file.value = '';
        if (!f) return;
        status.textContent = 'Getting the photo ready…';
        try {
          v.image = await shrinkPhoto(f);
        } catch {
          status.textContent = 'Couldn’t read that photo. Try again.';
          return;
        }
        if (v.closed) return;
        preview.src = v.image;
        preview.hidden = false;
        shootLabel.textContent = '📷 Retake';
        status.textContent = needPartner && !v.partner ? 'Now pick who’s in it with you.' : '';
        update();
      },
    });
    const mates = needPartner ? s.players.filter((p) => p.inGame && !p.out && p.id !== s.me.id) : [];
    const pickButtons = mates.map((m) => h('button', {
      type: 'button',
      class: 'pick',
      onclick: (e) => {
        v.partner = m;
        for (const b of pickButtons) b.classList.toggle('sel', b === e.currentTarget);
        if (v.image) status.textContent = '';
        update();
      },
    }, pdot(m.color), m.name));
    const send = h('button', { type: 'button', class: 'primary btn-big', disabled: true, onclick: upload }, 'Send photo');
    function update() {
      send.disabled = !v.image || (needPartner && !v.partner) || v.sending;
    }
    async function upload() {
      v.sending = true;
      send.textContent = 'Sending…';
      update();
      const res = await uploadPhoto({ choreId: chore.id, code: back.code, image: v.image, partnerId: needPartner ? v.partner.id : null });
      v.sending = false;
      send.textContent = 'Send photo';
      update();
      if (v.closed) return;
      if (!res.ok) {
        status.textContent = res.error;
        return toast(res.error, 'error');
      }
      if (res.done) toast('Photo saved ✓');
      else if (v.partner) {
        ui.partnerOf[chore.id] = v.partner.name;
        toast(`Sent! Waiting for ${v.partner.name} to say yes.`);
      }
      showView(back);
    }
    v.root = h('div', { class: 'sheet-inner' },
      sheetHead(() => showView(back), 'Cancel'),
      h('div', { class: 'station-head' }, h('div', { class: 'kicker' }, `📷 ${back.station.name}`), h('h1', {}, chore.title), h('p', {}, chore.prompt ?? '')),
      h('label', { class: 'btn-big primary photo-shoot' }, shootLabel, file),
      preview,
      needPartner ? box(
        h('h2', {}, 'Who’s in it with you?'),
        mates.length ? h('div', { class: 'pick-grid' }, pickButtons) : h('p', { class: 'muted' }, 'Nobody is free to be in your photo right now.'),
        h('p', { class: 'small muted' }, 'They’ll get a message to confirm on their phone.')) : '',
      send,
      status);
    showView(v);
  }

  // ---- gallery

  const photoCaption = (p) => `${p.title} · ${p.by}${p.partner ? ` & ${p.partner}` : ''}`;
  const thumbs = (photos) => h('div', { class: 'thumbs' }, photos.map((p) => h('button', { type: 'button', class: 'thumb', onclick: () => lightbox(p) },
    h('img', { src: p.url, alt: p.title, loading: 'lazy' }),
    h('span', {}, photoCaption(p)))));

  async function openGallery() {
    const back = ui.view?.kind === 'station' ? ui.view : null;
    const body = slot('stack');
    const v = { kind: 'gallery', photos: null, error: '' };
    v.root = h('div', { class: 'sheet-inner' }, sheetHead(() => showView(back)), h('h1', { class: 'sheet-title' }, '🖼 Photos'), body);
    v.update = () => fill(body, [v.photos?.map((p) => [p.id, p.partner]), v.error], () => {
      if (v.error) return h('p', { class: 'error' }, v.error);
      if (!v.photos) return h('div', { class: 'loading' }, h('div', { class: 'spinner' }));
      if (!v.photos.length) return h('p', { class: 'note' }, 'No photos yet. Photo chores end up here.');
      const games = [...new Set(v.photos.map((p) => p.gameNo))].sort((a, b) => b - a);
      return games.map((g) => box(h('h2', {}, `Game ${g}`), thumbs(v.photos.filter((p) => p.gameNo === g))));
    });
    showView(v);
    const res = await call('gallery');
    v.photos = res.ok ? res.photos ?? [] : [];
    v.error = res.ok ? '' : res.error;
    if (ui.view === v) render();
  }

  function closeModal() {
    $('#modal').hidden = true;
    $('#modal').replaceChildren();
  }
  $('#modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });

  function lightbox(p) {
    $('#modal').replaceChildren(h('div', { class: 'lightbox', onclick: closeModal },
      h('img', { src: p.url, alt: p.title }),
      h('p', {}, photoCaption(p)),
      h('p', { class: 'small muted' }, 'Tap to close')));
    $('#modal').hidden = false;
  }

  // ------------------------------------------------------------------ overlays

  /**
   * "Were you in this photo with X?" or "Did X just ask you …?" for each request waiting on me (not while I'm mid-puzzle
   * or mid-photo).
   */
  function renderConfirm() {
    const el = $('#confirm');
    const s = store.state;
    const you = s?.you;
    // not over a phone game still being played (unless asked for there) or the camera; an activity's timer just keeps
    // running underneath
    const playing = ui.view?.kind === 'puzzle' && !ui.view.ended && !ui.view.losing;
    const busy = (playing && !ui.confirmOver) || ui.view?.kind === 'photo';
    const open = s?.phase === 'play' && !s.paused && you?.status === 'alive' && !busy;
    const c = open ? you.confirms.find((x) => !ui.snoozed.has(x.requestId) && !ui.answered.has(x.requestId)) : null;
    if (!c) {
      el.hidden = true;
      el._key = null;
      el.replaceChildren();
      return;
    }
    el.hidden = false;
    const answer = (yes) => (e) => answerPhoto(c, yes, e.currentTarget);
    const later = h('button', { type: 'button', class: 'link-btn', onclick: () => snooze(c) }, 'Not now');
    if (c.kind === 'talk') {
      return void fill(el, c, () => h('div', { class: 'modal-box confirm-box' },
        h('h1', {}, '💬 Quick check'),
        h('p', { class: 'big' }, `Did ${c.from} just ask you:`),
        h('p', { class: 'confirm-q' }, `“${c.prompt ?? '…'}”?`),
        h('div', { class: 'row two' },
          h('button', { type: 'button', class: 'yes-btn btn-big', onclick: answer(true) }, 'Yes'),
          h('button', { type: 'button', class: 'no-btn btn-big', onclick: answer(false) }, 'No')),
        later));
    }
    fill(el, c, () => h('div', { class: 'modal-box confirm-box' },
      h('h1', {}, '📷 Photo check'),
      c.url ? h('img', { class: 'confirm-img', src: c.url, alt: c.title }) : '',
      h('p', { class: 'big' }, `Were you in this photo with ${c.from}?`),
      h('p', { class: 'small muted' }, `${c.title}: ${c.prompt ?? ''}`),
      h('div', { class: 'row two' },
        h('button', { type: 'button', class: 'yes-btn btn-big', onclick: (e) => answerPhoto(c, true, e.currentTarget) }, 'Yes'),
        h('button', { type: 'button', class: 'no-btn btn-big', onclick: (e) => answerPhoto(c, false, e.currentTarget) }, 'No')),
      later));
  }

  function snooze(c) {
    ui.snoozed.add(c.requestId);
    ui.confirmOver = false;
    render();
  }

  async function answerPhoto(c, yes, btn) {
    btn.disabled = true;
    const res = await call('confirmPhoto', { requestId: c.requestId, yes });
    btn.disabled = false;
    if (!res.ok) return toast(res.error, 'error');
    ui.answered.add(c.requestId);
    if (!store.state?.you?.confirms.some((x) => !ui.answered.has(x.requestId) && !ui.snoozed.has(x.requestId))) ui.confirmOver = false;
    if (c.kind === 'talk') toast(yes ? `Thanks! That counts for ${c.from}.` : 'Okay, it won’t count.');
    else toast(yes ? `Thanks! ${c.from}’s photo is in.` : 'Okay, they’ll take another one.');
    render();
  }

  function renderPause() {
    const el = $('#pause');
    const s = store.state;
    const show = !!s?.paused && !!s.me && (s.phase === 'play' || s.phase === 'meeting');
    el.hidden = !show;
    if (!show) return;
    fill(el, [store.isHost], () => h('div', { class: 'pause-box' },
      h('div', { class: 'pause-icon' }, '⏸'),
      h('h1', {}, 'Paused'),
      h('p', {}, 'The game is paused and every timer is frozen. The host will resume it.'),
      store.isHost ? h('div', { class: 'row two' },
        h('button', { type: 'button', class: 'primary btn-big', onclick: (e) => hostCmd('resume', {}, null, e.currentTarget) }, '▶ Resume'),
        h('button', { type: 'button', class: 'btn-big danger', onclick: endGame }, 'End game')) : ''));
  }

  // ------------------------------------------------------------------ host

  function openHostLogin() {
    const pw = h('input', { type: 'password', class: 'big-input', placeholder: 'Host password', autocomplete: 'current-password' });
    const error = h('p', { class: 'error' });
    $('#modal').replaceChildren(h('form', {
      class: 'modal-box',
      onsubmit: async (e) => {
        e.preventDefault();
        const res = await call('host:login', { password: pw.value });
        if (!res.ok) return void (error.textContent = res.error);
        storage.set(KEY_HOST, res.hostToken);
        store.isHost = true;
        closeModal();
        toast('You’re the host on this phone.');
        render();
      },
    },
    h('h1', {}, 'Host login'),
    h('p', { class: 'muted' }, 'Use the site’s admin password. The host starts, pauses and ends games. You can host and play on the same phone.'),
    pw,
    error,
    h('div', { class: 'row two' },
      h('button', { type: 'button', onclick: closeModal }, 'Cancel'),
      h('button', { type: 'submit', class: 'primary' }, 'Log in'))));
    $('#modal').hidden = false;
    setTimeout(() => pw.focus(), 50);
  }

  function stopHosting() {
    storage.del(KEY_HOST);
    store.isHost = false;
    store.host = null;
    render();
  }

  async function hostCmd(cmd, args = {}, okMsg = null, btn = null) {
    if (btn) btn.disabled = true;
    const res = await call('host', { cmd, args });
    if (btn) btn.disabled = false;
    if (!res.ok) toast(res.error, 'error');
    else if (okMsg) toast(okMsg);
    return res;
  }

  async function endGame() {
    if (confirm('End this game for everyone and go back to the lobby?')) await hostCmd('end', {}, 'Game ended');
  }

  // The host panel is one element that moves between screens, so the settings form keeps what's being typed.
  const hostUI = {
    controls: h('div', { class: 'stack' }),
    formWrap: h('details', { class: 'settings-wrap' }, h('summary', {}, '⚙️ Game settings')),
    players: h('div', { class: 'stack' }),
    form: null,
    lastPhase: null,
  };
  hostUI.el = h('details', { class: 'box host-panel', hidden: true },
    h('summary', {}, 'Host controls'),
    h('div', { class: 'host-body' },
      hostUI.controls,
      h('div', { class: 'row' },
        h('a', { class: 'btn-link', href: '/lake/tv', target: '_blank', rel: 'noopener' }, '📺 TV screen'),
        h('a', { class: 'btn-link', href: '/lake/print', target: '_blank', rel: 'noopener' }, '🖨 QR cards'),
        h('a', { class: 'btn-link', href: '/lake/rules', target: '_blank', rel: 'noopener' }, '📖 Rules')),
      hostUI.formWrap,
      hostUI.players));

  function renderHost() {
    const host = store.host;
    const show = store.isHost && !!host;
    hostUI.el.hidden = !show;
    if (!show) return;
    if (hostUI.lastPhase !== host.phase) {
      // open between games, tucked away during one
      hostUI.lastPhase = host.phase;
      hostUI.el.open = host.phase === 'lobby' || host.phase === 'over';
      hostUI.formWrap.open = false;
    }
    fill(hostUI.controls, [host.phase, host.paused, host.canStart, host.startProblem], () => hostControls(host));
    const editable = host.phase === 'lobby' || host.phase === 'over';
    hostUI.formWrap.hidden = !editable;
    if (editable) {
      hostUI.form ??= buildSettingsForm();
      if (!hostUI.formWrap.contains(hostUI.form.el)) hostUI.formWrap.append(hostUI.form.el);
      hostUI.form.apply(host);
    }
    fill(hostUI.players, [host.players], () => hostPlayers(host));
  }

  function hostControls(host) {
    const problem = host.startProblem && (host.phase === 'lobby' || host.phase === 'over') ? h('p', { class: 'small warn' }, host.startProblem) : '';
    const start = (label) => h('button', { type: 'button', class: 'primary btn-big', disabled: !host.canStart, onclick: (e) => hostCmd('start', {}, null, e.currentTarget) }, label);
    if (host.phase === 'lobby') return [start('▶ Start the game'), problem];
    if (host.phase === 'over') {
      return [h('div', { class: 'row two' }, start('▶ Next game'), h('button', { type: 'button', class: 'btn-big', onclick: (e) => hostCmd('lobby', {}, null, e.currentTarget) }, 'Back to lobby')), problem];
    }
    return [
      h('div', { class: 'row two' },
        host.paused
          ? h('button', { type: 'button', class: 'primary btn-big', onclick: (e) => hostCmd('resume', {}, null, e.currentTarget) }, '▶ Resume')
          : h('button', { type: 'button', class: 'btn-big', onclick: (e) => hostCmd('pause', {}, null, e.currentTarget) }, '⏸ Pause'),
        host.phase === 'meeting' ? h('button', { type: 'button', class: 'btn-big', onclick: (e) => hostCmd('skip', {}, null, e.currentTarget) }, '⏭ Next stage') : ''),
      h('button', { type: 'button', class: 'btn-big danger', onclick: endGame }, 'End this game'),
    ];
  }

  function hostPlayers(host) {
    const online = host.players.filter((p) => p.online).length;
    return [
      h('h3', {}, `Players · ${online} of ${host.players.length} online`),
      h('ul', { class: 'plist host-plist' }, host.players.map((p) => h('li', {},
        h('span', { class: `dot ${p.online ? 'on' : ''}`, title: p.online ? 'Online' : 'Offline' }),
        pdot(p.color),
        h('span', { class: 'grow' }, p.name, p.inGame ? tag('in game') : '', p.sitOut ? tag('sits out') : ''),
        h('button', { type: 'button', class: 'small', onclick: () => hostCmd('sitOut', { playerId: p.id, value: !p.sitOut }) }, p.sitOut ? 'Deal in' : 'Sit out'),
        h('button', {
          type: 'button',
          class: 'small danger',
          onclick: () => {
            if (confirm(`Remove ${p.name}?${p.inGame ? ' They’ll be out of this game.' : ''}`)) hostCmd('kick', { playerId: p.id }, `${p.name} removed`);
          },
        }, 'Kick')))),
    ];
  }

  const num = (key, label) => ({ key, label, type: 'num' });
  const SETTINGS = [
    ['Players', [
      { key: 'lurkers', label: 'Lurkers (auto: 1 for up to 6 players, else 2)', type: 'select', options: [[0, 'Auto'], [1, '1'], [2, '2'], [3, '3']] },
    ]],
    // chores are dealt per room now: the old per-player counts (taskCount, actCount, photoCount, carryCount) are unused
    ['Chores', [
      { key: 'rooms', label: 'Rooms with chores (1–30)', type: 'num', min: 1, max: 30 },
      { key: 'choresPerRoom', label: 'Chores per room (1–5)', type: 'num', min: 1, max: 5 },
      { key: 'timeLimit', label: 'Time limit (min, 0 = none)', type: 'num', max: 180 },
      { key: 'barMode', label: 'Chore bar', type: 'select', options: [['live', 'Moves live'], ['meetings', 'Only moves at Campfires']] },
    ]],
    ['Kills (seconds)', [
      num('killCooldown', 'Time between kills'), num('startGrace', 'No kills at the start for'),
      num('killAfterMeeting', 'No kills after a Campfire for'), num('undoSeconds', '“I wasn’t tapped” window'),
    ]],
    ['Campfire', [
      num('gatherSeconds', 'Gather (s)'), num('discussSeconds', 'Discuss (s)'), num('voteSeconds', 'Vote (s)'), num('resultSeconds', 'Result (s)'),
      num('emergencies', 'Bell rings per player'),
      { key: 'anonymousVotes', label: 'Anonymous votes', type: 'check' },
      { key: 'revealRole', label: 'Reveal the role of whoever is voted out', type: 'check' },
    ]],
    ['Storm', [
      { key: 'storm', label: 'Storms on', type: 'check' },
      num('stormSeconds', 'Time to secure (s)'), num('stormFirst', 'First storm after (s)'), num('stormCooldown', 'Time between storms (s)'),
    ]],
  ];

  /** The host's settings form. Built once; refreshed from the host view unless there are unsaved edits. */
  function buildSettingsForm() {
    const f = { inputs: {}, boxes: {}, dirty: false, stationsKey: '' };
    const status = h('span', { class: 'small warn grow' });
    const stormA = h('select', { 'aria-label': 'Storm station 1' });
    const stormB = h('select', { 'aria-label': 'Storm station 2' });
    const stations = h('div', { class: 'set-stations' });
    const defs = SETTINGS.flatMap(([, list]) => list);

    const row = (label, input) => h('label', { class: 'set-row' }, h('span', {}, label), input);
    const control = (d) => {
      let input;
      if (d.type === 'num') input = h('input', { type: 'number', min: d.min ?? 0, max: d.max, step: 1, inputmode: 'numeric' });
      else if (d.type === 'check') input = h('input', { type: 'checkbox' });
      else input = h('select', {}, d.options.map(([value, label]) => h('option', { value: String(value) }, label)));
      f.inputs[d.key] = input;
      return row(d.label, input);
    };

    const choreHint = h('p', { class: 'small muted set-hint' });
    /** "12 rooms × 3 = 36 chores…", from what's in the boxes right now. */
    const updateHint = () => {
      const val = (k) => Number(f.inputs[k]?.value);
      const on = Object.values(f.boxes).filter((b) => b.checked).length;
      const rooms = Math.min(val('rooms') || 0, on || Infinity);
      const per = val('choresPerRoom') || 0;
      const t = val('timeLimit');
      choreHint.textContent = `Each game picks ${plural(rooms, 'room')} at random from the stations switched on below${rooms < (val('rooms') || 0) ? ' (that’s all of them)' : ''}: `
        + `${rooms * per} chores, split evenly among the Campers. ${t > 0 ? `The Lurkers win if they aren’t done in ${plural(t, 'minute')} (Campfires and pauses don’t count).` : 'No time limit.'}`;
    };
    const markDirty = () => {
      f.dirty = true;
      status.textContent = 'Unsaved changes';
      updateHint();
    };
    const save = async (e) => {
      e.preventDefault();
      let patch;
      try {
        patch = read();
      } catch (err) {
        return toast(err.message, 'error');
      }
      if (!Object.keys(patch).length) {
        f.dirty = false;
        status.textContent = '';
        return toast('Nothing changed');
      }
      const res = await hostCmd('settings', { patch }, 'Settings saved');
      if (res.ok) {
        f.dirty = false;
        status.textContent = '';
      }
    };

    function read() {
      const cur = store.host.settings;
      const patch = {};
      for (const d of defs) {
        const input = f.inputs[d.key];
        if (d.type === 'num') {
          const raw = input.value.trim();
          const v = Number(raw);
          if (raw === '' || !Number.isInteger(v) || v < 0) throw new Error(`“${d.label}” needs a whole number.`);
          if (v < (d.min ?? 0)) throw new Error(`“${d.label}” starts at ${d.min}.`);
          if (d.max != null && v > d.max) throw new Error(`“${d.label}” goes up to ${d.max}.`);
          if (v !== cur[d.key]) patch[d.key] = v;
        } else if (d.type === 'check') {
          if (input.checked !== !!cur[d.key]) patch[d.key] = input.checked;
        } else {
          const v = d.key === 'lurkers' ? Number(input.value) : input.value;
          if (v !== cur[d.key]) patch[d.key] = v;
        }
      }
      const pair = [stormA.value, stormB.value];
      if (pair[0] === pair[1]) throw new Error('Pick two different storm stations.');
      if (JSON.stringify(pair) !== JSON.stringify(cur.stormStations)) patch.stormStations = pair;
      const disabled = Object.keys(f.boxes).filter((id) => !f.boxes[id].checked);
      if (JSON.stringify([...disabled].sort()) !== JSON.stringify([...(cur.disabled ?? [])].sort())) patch.disabled = disabled;
      return patch;
    }

    function buildStations(host) {
      const campfire = store.state?.campfire?.id ?? 'campfire';
      f.boxes = {};
      const floors = [...new Set(host.stations.map((st) => st.floor))];
      stations.replaceChildren(...floors.map((floor) => h('div', {},
        h('div', { class: 'set-floor' }, floorLabel(floor)),
        host.stations.filter((st) => st.floor === floor).map((st) => {
          const input = h('input', { type: 'checkbox', disabled: st.id === campfire });
          f.boxes[st.id] = input;
          return h('label', { class: 'set-row' },
            h('span', {}, st.name, st.id === campfire ? h('span', { class: 'small muted' }, ' (always on)') : '', h('span', { class: 'set-code' }, st.code ?? '')),
            input);
        }))));
      const options = host.stations.filter((st) => st.id !== campfire).map((st) => [st.id, st.name]);
      for (const sel of [stormA, stormB]) sel.replaceChildren(...options.map(([id, label]) => h('option', { value: id }, label)));
    }

    f.apply = (host, force = false) => {
      const key = JSON.stringify(host.stations.map((st) => [st.id, st.name, st.code]));
      if (key !== f.stationsKey) {
        f.stationsKey = key;
        buildStations(host);
        force = true;
      }
      if (f.dirty && !force) return;
      const cur = host.settings;
      for (const d of defs) {
        const input = f.inputs[d.key];
        if (d.type === 'check') input.checked = !!cur[d.key];
        else input.value = String(cur[d.key] ?? '');
      }
      for (const st of host.stations) if (f.boxes[st.id]) f.boxes[st.id].checked = st.enabled;
      [stormA.value, stormB.value] = cur.stormStations ?? [];
      f.dirty = false;
      status.textContent = '';
      updateHint();
    };

    f.el = h('form', { class: 'settings', oninput: markDirty, onchange: markDirty, onsubmit: save },
      SETTINGS.map(([legend, list]) => h('fieldset', {},
        h('legend', {}, legend),
        list.map(control),
        legend === 'Chores' ? choreHint : '',
        legend === 'Storm' ? [row('Storm station 1', stormA), row('Storm station 2', stormB)] : '')),
      h('fieldset', {}, h('legend', {}, 'Stations in play'), stations),
      h('div', { class: 'save-bar row' },
        h('button', { type: 'submit', class: 'primary' }, 'Save settings'),
        h('button', { type: 'button', onclick: () => f.apply(store.host, true) }, 'Undo changes'),
        status));
    return f;
  }

  // ------------------------------------------------------------------ start

  render();
})();
