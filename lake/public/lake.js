/* global io */
/**
 * Lake Lurkers phone app at /lake (and /lake/s/:code when a station QR is scanned): sign in, lobby, play, station
 * screen, puzzles, photos, Campfires, game over, gallery and the host's controls.
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
  const countdown = (until, { prefix = '', done = '', cls = '' } = {}) =>
    h('span', { class: `cd ${cls}`, 'data-until': until ?? 0, 'data-prefix': prefix, 'data-done': done });

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
  const PUZZLE_MIN = { hold: 7, order: 3, simon: 3, match: 3 }; // seconds the server wants between choreStart and choreDone

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
    view: null, // full-screen sheet: station | puzzle | photo | gallery
    pendingCode: null, // station code from /lake/s/:code, opened once signed in
    voteFor: null, // picked but not yet confirmed
    snoozed: new Set(), // photo requests put off with "Not now"
    answered: new Set(), // photo requests answered, hidden until the server drops them
    seenConfirms: new Set(),
    partnerOf: {}, // choreId -> partner name, for "waiting for X"
  };

  /** Server time; frozen while the game is paused. */
  const now = () => (store.state?.paused && store.frozenAt != null ? store.frozenAt : Date.now() + store.offset);

  const scanned = location.pathname.match(/^\/lake\/s\/([^/?#]+)/);
  if (scanned) ui.pendingCode = decodeURIComponent(scanned[1]);
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
    if (s.phase !== prev.phase || newGame) closeViews();
    if (s.phase === 'play' && (newGame || prev.phase === 'lobby' || prev.phase === 'over')) {
      ui.partnerOf = {};
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
        const partner = ui.partnerOf[c.id] ?? 'Your partner';
        if (!pc.done && c.done) {
          SFX.ding();
          vibrate(60);
          if (c.kind === 'photo' && pc.pending) toast(`${partner} said yes. Photo done ✓`);
        } else if (pc.pending && !c.pending) {
          toast(`${partner} said no (or couldn’t answer). Take it again.`, 'error');
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
      const text = left > 0 ? `${el.dataset.prefix ?? ''}${fmtLeft(left)}` : el.dataset.done ?? '';
      if (el.textContent !== text) el.textContent = text;
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

  function gameHeader(s) {
    const bar = s.bar ?? { done: 0, total: 0 };
    const pct = bar.total ? Math.round((100 * bar.done) / bar.total) : 0;
    return [
      h('section', { class: 'box game-head' },
        h('div', { class: 'row' },
          h('b', {}, `Game ${s.gameNo}`),
          h('span', { class: 'grow' }),
          h('span', { class: 'small muted' }, s.settings?.barMode === 'meetings' ? 'Chore bar moves at Campfires' : 'Camp chores')),
        h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
          h('div', { class: 'bar-fill', style: `width:${pct}%` })),
        h('div', { class: 'row small muted' }, `${bar.done} of ${bar.total} chores done`, h('span', { class: 'grow' }), `${pct}%`)),
      s.storm ? stormBanner(s.storm) : '',
    ];
  }
  const headerData = (s) => [s.gameNo, s.bar, s.storm, s.settings?.barMode];

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
    const pin = plain(h('input', { class: 'big-input pin', placeholder: '4-digit PIN', inputmode: 'numeric', pattern: '[0-9]*', maxLength: 4, enterkeyhint: 'go' }));
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
        fill(info, [s.settings, s.players.map((p) => p.sitOut)], () => settingsSummary(s));
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
    const chores = [plural(st.taskCount, 'task'), plural(st.photoCount, 'photo'), plural(st.carryCount, 'carry', 'carries')].join(', ');
    return [
      h('h2', {}, 'This game'),
      h('ul', { class: 'facts' },
        h('li', {}, `${plural(lurkers, 'Lurker')}${st.lurkers ? '' : ' (picked by player count)'}`),
        h('li', {}, `Everyone gets ${chores}`),
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
        h('li', {}, 'Do your chores: go to the place, scan its QR code with your camera, and finish the chore.'),
        h('li', {}, 'Lurkers tap Campers on the shoulder to kill them. If you’re tapped, sit down and stay silent.'),
        h('li', {}, 'Found a body? Type the code on their phone. Everyone runs to the Campfire to talk and vote.'),
        h('li', {}, 'Campers win by finishing every chore or voting out every Lurker.')));
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
        const waiting = you.confirms.filter((c) => ui.snoozed.has(c.requestId) && !ui.answered.has(c.requestId)).length;
        fill(banners, [you.status, you.ejected, waiting], () => [
          you.status === 'ghost' ? ghostBanner(you) : '',
          waiting && you.status === 'alive' ? h('button', {
            type: 'button',
            class: 'waiting-banner',
            onclick: () => { ui.snoozed.clear(); render(); },
          }, `📷 ${plural(waiting, 'photo')} waiting for your answer`) : '',
        ]);
        renderRole();
        fill(chores, [you.chores, ui.partnerOf], () => choreList(s, you));
        report.update(you);
      },
    };
  }

  const ghostBanner = (you) => h('div', { class: 'ghost-banner' },
    h('b', {}, '👻 You’re a ghost.'), ' Stay silent, keep doing chores.',
    you.ejected ? h('div', { class: 'small' }, 'You were voted out.') : '');

  function choreList(s, you) {
    const done = you.chores.filter((c) => c.done).length;
    const sorted = [...you.chores].sort((a, b) => a.done - b.done);
    return [
      h('h2', {}, 'My chores', h('span', {}, `${done} of ${you.chores.length} done`)),
      h('ul', { class: 'chores' }, sorted.map((c) => choreItem(s, c))),
      h('p', { class: 'small muted' }, 'Go there, scan the QR code, and do the chore on your phone.'),
    ];
  }

  const ICONS = { task: '🧹', photo: '📷', carry: '📦' };
  const whereOf = (s, id) => s.stations.find((st) => st.id === id)?.where ?? '';

  function choreItem(s, c) {
    let place = c.stationName;
    let where = c.where;
    if (c.kind === 'carry') {
      if (c.done) [place, where] = [`Delivered ${c.item}`, ''];
      else if (c.step >= 1) [place, where] = [`Drop ${c.item} at the ${c.toName}`, whereOf(s, c.toId)];
      else [place, where] = [`Pick up ${c.item} at the ${c.fromName}`, whereOf(s, c.fromId)];
    }
    return h('li', { class: `chore ${c.done ? 'done' : ''}` },
      h('span', { class: 'chore-icon', 'aria-hidden': 'true' }, c.done ? '✓' : ICONS[c.kind] ?? '•'),
      h('div', { class: 'grow' },
        h('div', { class: 'chore-title' }, c.title),
        h('div', { class: 'chore-place' }, place),
        where && !c.done ? h('div', { class: 'chore-where' }, where) : '',
        c.kind === 'photo' && !c.done && c.prompt ? h('div', { class: 'chore-where' }, `“${c.prompt}”`) : '',
        c.pending ? h('div', { class: 'chore-wait' }, `Waiting for ${ui.partnerOf[c.id] ?? 'your partner'} to say yes`) : ''));
  }

  function buildScan() {
    const input = plain(h('input', { class: 'big-input code', placeholder: 'Code', autocapitalize: 'characters', maxLength: 8, enterkeyhint: 'go', 'aria-label': 'Station code' }));
    const btn = h('button', { type: 'submit', class: 'primary' }, 'Go');
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
    h('p', { class: 'small muted' }, 'Scan its QR code with your phone’s camera, or type the code printed under it.'),
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
        fill(banner, [s.gameNo, o.winner, o.reason, myRole], () => [
          h('div', { class: 'kicker' }, `Game ${s.gameNo} is over`),
          h('h1', { class: `winner ${o.winner ?? 'none'}` }, o.winner === 'campers' ? 'Campers win!' : o.winner === 'lurkers' ? 'Lurkers win!' : 'Game ended'),
          h('p', {}, `${capital(o.reason ?? '')}.`),
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
    if (blocked || ((v.kind === 'puzzle' || v.kind === 'photo') && s.phase !== 'play')) closeViews();
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
    const chores = slot('stack');
    const bell = slot();
    const storm = slot();
    const note = slot();
    v.root = h('div', { class: 'sheet-inner' },
      sheetHead(() => showView(null)),
      h('div', { class: 'station-head' },
        h('div', { class: 'kicker' }, floorLabel(st.floor)),
        h('h1', {}, st.name),
        h('p', { class: 'muted' }, st.where)),
      storm, chores, bell, note);
    v.update = () => renderStation(v, { chores, bell, storm, note });
    showView(v);
    return true;
  }

  function renderStation(v, slots) {
    const s = store.state;
    const you = s?.you;
    const st = v.station;
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
    fill(slots.note, [nothing, allDone], () => (nothing ? h('p', { class: 'note' }, 'Nothing for you here. Check your chore list for where to go.')
      : allDone ? h('p', { class: 'note' }, 'All done here ✓') : ''));
  }

  function stationChore(c, v) {
    const st = v.station;
    const line = (cls, ...kids) => h('div', { class: `chore-here ${cls}` }, ...kids);
    const go = (label, onclick) => h('button', { type: 'button', class: 'primary btn-big', onclick }, label);
    if (c.done) return line('done', `✓ ${c.title}`);
    if (c.kind === 'task') return go(`Start: ${c.title}`, () => openPuzzle(c, v));
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

  // ---- puzzles

  function openPuzzle(chore, back) {
    const p = { kind: 'puzzle', chore, back, closed: false, timers: new Set(), startedAt: 0, finishing: false };
    const status = h('p', { class: 'pz-status' });
    const area = h('div', { class: 'pz-area' });
    p.say = (text) => { status.textContent = text; };
    p.later = (fn, ms) => {
      const t = setTimeout(() => {
        p.timers.delete(t);
        if (!p.closed) fn();
      }, ms);
      p.timers.add(t);
    };
    p.cleanup = () => {
      p.closed = true;
      for (const t of p.timers) clearTimeout(t);
      p.timers.clear();
    };
    p.finish = () => finishPuzzle(p, status);
    p.root = h('div', { class: 'pz' },
      h('div', { class: 'pz-head' }, h('div', { class: 'kicker' }, back.station.name), h('h1', {}, chore.title)),
      status,
      area,
      h('div', { class: 'pz-foot' }, h('button', { type: 'button', class: 'btn-big', onclick: () => showView(back) }, 'Cancel')));
    area.replaceChildren(...[(PUZZLES[chore.puzzle] ?? holdPuzzle)(p)].flat());
    showView(p);
    call('choreStart', { choreId: chore.id, code: back.code }).then((res) => {
      if (p.closed) return;
      if (!res.ok) {
        toast(res.error, 'error');
        showView(back);
      } else p.startedAt = Date.now();
    });
  }

  async function finishPuzzle(p, status) {
    if (p.finishing || p.closed) return;
    p.finishing = true;
    p.say('Nice! Saving…');
    while (!p.startedAt && !p.closed) await sleep(150);
    // The server wants a minimum time between start and done; wait out the rest if the player was quick.
    const wait = p.startedAt + (PUZZLE_MIN[p.chore.puzzle] ?? 3) * 1000 + 400 - Date.now();
    if (wait > 0) await sleep(wait);
    if (p.closed) return;
    const res = await call('choreDone', { choreId: p.chore.id, code: p.back.code });
    if (p.closed) return;
    if (!res.ok) {
      p.finishing = false;
      p.say(res.error);
      status.append(' ', h('button', { type: 'button', class: 'small', onclick: () => p.finish() }, 'Try again'));
      return;
    }
    p.root.replaceChildren(h('div', { class: 'pz-done' }, h('div', { class: 'pz-check' }, '✓'), h('div', {}, 'Done!'), h('div', { class: 'small muted' }, p.chore.title)));
    p.later(() => showView(p.back), 1300);
  }

  function holdPuzzle(p) {
    const bar = h('div', { class: 'pz-bar-fill' });
    const btn = h('button', { type: 'button', class: 'pz-hold' }, 'Hold');
    p.say('Press and hold for 8 seconds. Letting go starts over.');
    pressHold(btn, 8000, {
      onStart: () => { btn.textContent = 'Keep holding…'; p.say(''); },
      onProgress: (f) => { bar.style.transform = `scaleX(${f})`; },
      onCancel: () => {
        btn.textContent = 'Hold';
        p.say('Let go too soon. Hold again!');
        SFX.buzz();
      },
      onDone: () => {
        btn.textContent = '✓';
        btn.disabled = true;
        p.finish();
      },
    });
    return [h('div', { class: 'pz-bar' }, bar), btn];
  }

  function orderPuzzle(p) {
    let next = 1;
    p.say('Tap 1 to 10 in order.');
    const buttons = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).map((n) => h('button', {
      type: 'button',
      class: 'pz-num',
      onclick: (e) => {
        const b = e.currentTarget;
        if (next > 10 || n < next) return;
        if (n === next) {
          b.classList.add('ok');
          SFX.blip();
          next += 1;
          if (next > 10) p.finish();
          else p.say(`Next: ${next}`);
          return;
        }
        SFX.buzz();
        b.classList.add('bad');
        p.later(() => b.classList.remove('bad'), 350);
        next = 1;
        for (const x of buttons) x.classList.remove('ok');
        p.say(`Oops, that was ${n}. Start again from 1.`);
      },
    }, n));
    return h('div', { class: 'pz-grid' }, buttons);
  }

  const PADS = [{ color: '#3fb950', freq: 392 }, { color: '#f85149', freq: 330 }, { color: '#d29922', freq: 262 }, { color: '#58a6ff', freq: 523 }];
  function simonPuzzle(p) {
    const seq = Array.from({ length: 5 }, () => Math.floor(Math.random() * PADS.length));
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
      seq.forEach((i, k) => p.later(() => light(i, 420), 700 + k * 650));
      p.later(() => {
        listening = true;
        p.say('Your turn: repeat it (0 of 5)');
      }, 700 + seq.length * 650);
    }
    function press(i) {
      if (!listening) return;
      if (i === seq[pos]) {
        light(i, 220);
        pos += 1;
        if (pos === seq.length) {
          listening = false;
          p.finish();
        } else p.say(`Your turn: repeat it (${pos} of 5)`);
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

  const MATCH_ITEMS = ['🦆', '🐟', '🛶', '🌲', '🔥', '⛺', '🐸', '🦉', '🍄', '🌙'];
  const MATCH_COLORS = ['#3fb950', '#f85149', '#d29922', '#58a6ff'];
  function matchPuzzle(p) {
    const items = shuffle(MATCH_ITEMS).slice(0, 4);
    let right = shuffle(items);
    while (right.every((x, i) => x === items[i])) right = shuffle(items);
    let pick = null;
    let matched = 0;
    const tile = (it, onclick) => h('button', { type: 'button', class: 'pz-tile', style: `--c:${MATCH_COLORS[items.indexOf(it)]}`, onclick }, it);
    const L = items.map((it, i) => tile(it, () => {
      if (L[i].classList.contains('done')) return;
      for (const b of L) b.classList.remove('sel');
      pick = i;
      L[i].classList.add('sel');
      SFX.blip();
    }));
    const R = right.map((it, j) => tile(it, () => {
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
      p.say('Not a match. Try again.');
    }));
    p.say('Tap one on the left, then its twin on the right.');
    return h('div', { class: 'pz-match' }, h('div', { class: 'pz-col' }, L), h('div', { class: 'pz-col' }, R));
  }

  const PUZZLES = { hold: holdPuzzle, order: orderPuzzle, simon: simonPuzzle, match: matchPuzzle };

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

  /** "Were you in this photo with X?" for each request waiting on me (not while I'm mid-puzzle or mid-photo). */
  function renderConfirm() {
    const el = $('#confirm');
    const s = store.state;
    const you = s?.you;
    const open = s?.phase === 'play' && !s.paused && you?.status === 'alive' && ui.view?.kind !== 'puzzle' && ui.view?.kind !== 'photo';
    const c = open ? you.confirms.find((x) => !ui.snoozed.has(x.requestId) && !ui.answered.has(x.requestId)) : null;
    if (!c) {
      el.hidden = true;
      el._key = null;
      el.replaceChildren();
      return;
    }
    el.hidden = false;
    fill(el, c, () => h('div', { class: 'modal-box confirm-box' },
      h('h1', {}, '📷 Photo check'),
      c.url ? h('img', { class: 'confirm-img', src: c.url, alt: c.title }) : '',
      h('p', { class: 'big' }, `Were you in this photo with ${c.from}?`),
      h('p', { class: 'small muted' }, `${c.title}: ${c.prompt ?? ''}`),
      h('div', { class: 'row two' },
        h('button', { type: 'button', class: 'yes-btn btn-big', onclick: (e) => answerPhoto(c, true, e.currentTarget) }, 'Yes'),
        h('button', { type: 'button', class: 'no-btn btn-big', onclick: (e) => answerPhoto(c, false, e.currentTarget) }, 'No')),
      h('button', { type: 'button', class: 'link-btn', onclick: () => { ui.snoozed.add(c.requestId); render(); } }, 'Not now')));
  }

  async function answerPhoto(c, yes, btn) {
    btn.disabled = true;
    const res = await call('confirmPhoto', { requestId: c.requestId, yes });
    btn.disabled = false;
    if (!res.ok) return toast(res.error, 'error');
    ui.answered.add(c.requestId);
    toast(yes ? `Thanks! ${c.from}’s photo is in.` : 'Okay, they’ll take another one.');
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
    ['Chores per player', [
      num('taskCount', 'Tasks'), num('photoCount', 'Photos'), num('carryCount', 'Carries'),
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
      if (d.type === 'num') input = h('input', { type: 'number', min: 0, step: 1, inputmode: 'numeric' });
      else if (d.type === 'check') input = h('input', { type: 'checkbox' });
      else input = h('select', {}, d.options.map(([value, label]) => h('option', { value: String(value) }, label)));
      f.inputs[d.key] = input;
      return row(d.label, input);
    };

    const markDirty = () => {
      f.dirty = true;
      status.textContent = 'Unsaved changes';
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
    };

    f.el = h('form', { class: 'settings', oninput: markDirty, onchange: markDirty, onsubmit: save },
      SETTINGS.map(([legend, list]) => h('fieldset', {},
        h('legend', {}, legend),
        list.map(control),
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
