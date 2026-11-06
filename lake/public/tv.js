/* global io */
/**
 * Lake Lurkers big screen at /lake/tv: lobby join QR, chore bar, storms, Campfires and the end screen.
 * It never signs in as a player, so the server only sends it the public state (me/you are null).
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

  const storage = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };

  const socket = io('/lake');
  function call(event, payload) {
    return new Promise((resolve) => {
      socket.timeout(5000).emit(event, payload ?? {}, (err, res) => resolve(err ? { ok: false, error: 'Server did not respond' } : res));
    });
  }

  const KEY_HOST = 'lake.hostToken';
  const KEY_MUTED = 'lake.tvMuted';
  const mmss = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  const clock = (ms) => mmss(Math.ceil(ms / 1000));
  const possessive = (name) => (/s$/i.test(name) ? `${name}’` : `${name}’s`);

  // ------------------------------------------------------------------ server clock

  // offset = state.now - Date.now(), refreshed on every push. While paused, countdowns freeze at the
  // server time the pause arrived (the server keeps endsAt during a pause and shifts it on resume).
  let offset = 0;
  let frozenAt = null;
  const serverNow = () => frozenAt ?? Date.now() + offset;
  const remaining = (endsAt) => Math.max(0, endsAt - serverNow());

  // ------------------------------------------------------------------ sound

  // Web Audio only plays after a click, which is what the "Start screen" button is for.
  let actx = null;
  let master = null;
  let muted = storage.get(KEY_MUTED) === '1';

  function unlockAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!actx) {
      actx = new AC();
      const comp = actx.createDynamicsCompressor(); // lets the alarms be loud without clipping
      master = actx.createGain();
      master.gain.value = 1;
      master.connect(comp);
      comp.connect(actx.destination);
    }
    actx.resume?.();
    // a silent blip so Safari counts the context as started by this click
    const o = actx.createOscillator();
    const g = actx.createGain();
    g.gain.value = 0;
    o.connect(g);
    g.connect(master);
    o.start();
    o.stop(actx.currentTime + 0.05);
  }

  function tone(freq, at, dur, { type = 'square', vol = 0.5, to = null } = {}) {
    if (!actx || muted) return;
    const t0 = actx.currentTime + at;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (to) o.frequency.linearRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
    g.gain.setValueAtTime(vol, t0 + Math.max(0.02, dur - 0.04));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  const sounds = {
    // Campfire: a two-tone klaxon, about 4 s
    alarm() {
      for (let i = 0; i < 16; i++) {
        const f = i % 2 ? 660 : 880;
        tone(f, i * 0.25, 0.23, { type: 'square', vol: 0.7 });
        tone(f * 1.01, i * 0.25, 0.23, { type: 'sawtooth', vol: 0.35 });
      }
    },
    // storm: a rising and falling siren, about 4.5 s
    siren() {
      for (let i = 0; i < 4; i++) {
        tone(480, i * 1.1, 0.55, { type: 'sawtooth', vol: 0.6, to: 1180 });
        tone(1180, i * 1.1 + 0.55, 0.55, { type: 'sawtooth', vol: 0.6, to: 480 });
      }
    },
    chime() {
      tone(660, 0, 0.3, { type: 'sine', vol: 0.6 });
      tone(990, 0.22, 0.5, { type: 'sine', vol: 0.6 });
    },
    ding() { tone(1568, 0, 0.4, { type: 'triangle', vol: 0.6 }); },
    beep(high) { tone(high ? 1320 : 990, 0, 0.12, { type: 'square', vol: 0.45 }); },
    fanfare(winner) {
      const notes = winner === 'lurkers' ? [392, 370, 311, 196] : [523, 659, 784, 1047];
      const type = winner === 'lurkers' ? 'sawtooth' : 'triangle';
      notes.forEach((f, i) => tone(f, i * 0.22, i === notes.length - 1 ? 0.9 : 0.24, { type, vol: 0.55 }));
    },
  };

  function setMuted(value) {
    muted = value;
    storage.set(KEY_MUTED, muted ? '1' : '0');
    $('#muted').hidden = !muted;
  }

  // ------------------------------------------------------------------ screen helpers

  async function goFullscreen() {
    try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.(); } catch { /* not allowed */ }
  }

  // keep the laptop from sleeping mid-game (re-acquired when the tab comes back)
  async function keepAwake() {
    try { await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (store.started && document.visibilityState === 'visible') keepAwake();
  });

  // hide the mouse pointer when it hasn't moved for a few seconds
  let idleTimer = null;
  document.addEventListener('mousemove', () => {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'f' || e.key === 'F') {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else goFullscreen();
    } else if (e.key === 'm' || e.key === 'M') {
      setMuted(!muted);
    }
  });

  let flashTimer = null;
  function flash(kind, title, sub, ms = 4500) {
    const el = $('#flash');
    el.className = `flash fx-${kind}`; // not plain `storm`: that's the storm takeover's class, whose grid would skew the flash
    el.replaceChildren(h('div', { class: 'flash-title' }, title), sub ? h('div', { class: 'flash-sub' }, sub) : '');
    el.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ------------------------------------------------------------------ socket

  const store = { state: null, started: false, hostOk: false };

  socket.on('connect', async () => {
    $('#conn').classList.add('on');
    $('#offline').hidden = true;
    // The TV never sends `resume`: a player's token saved on this laptop would show their role on the big screen.
    const hostToken = storage.get(KEY_HOST);
    if (hostToken) {
      const res = await call('host:login', { hostToken });
      store.hostOk = !!res.ok;
      if (!res.ok) storage.del(KEY_HOST);
    }
    updateStart();
  });
  socket.on('disconnect', () => {
    $('#conn').classList.remove('on');
    $('#offline').hidden = false;
    store.hostOk = false;
    updateStart();
  });
  socket.on('state', onState);

  function onState(s) {
    const prev = store.state;
    offset = s.now - Date.now();
    if (s.paused) frozenAt = s.pausedAt ?? frozenAt ?? s.now;
    else frozenAt = null;
    store.state = s;
    if (prev) alerts(prev, s);
    render();
  }

  // Sounds and flashes on the moments everyone should notice.
  function alerts(prev, s) {
    if (s.phase === 'meeting' && prev.phase !== 'meeting') {
      sounds.alarm();
      flash('campfire', 'Campfire!', `Everyone to the Campfire: ${s.campfire?.where ?? 'the Great Room'}`);
    } else if (s.phase === 'meeting' && prev.meeting && s.meeting && prev.meeting.stage !== s.meeting.stage) {
      sounds.chime();
    }
    if (s.phase === 'play' && s.storm && !prev.storm) {
      sounds.siren();
      flash('storm', 'Storm!', `Secure ${s.storm.stations.map((x) => x.name).join(' and ')}`);
    } else if (s.phase === 'play' && s.storm && prev.storm) {
      const secured = (st) => st.stations.filter((x) => x.secured).length;
      if (secured(s.storm) > secured(prev.storm)) sounds.ding();
    } else if (s.phase === 'play' && prev.phase === 'play' && !s.storm && prev.storm) {
      sounds.chime();
      flash('clear', 'Storm over', 'The house is safe… for now', 3500);
    }
    if (s.phase === 'play' && (prev.phase === 'lobby' || prev.phase === 'over')) {
      sounds.chime();
      flash('begin', `Game ${s.gameNo}`, 'Hold the role card on your phone to see who you are', 5000);
    }
    if (s.phase === 'over' && prev.phase !== 'over') sounds.fanfare(s.over?.winner);
  }

  // ------------------------------------------------------------------ start screen

  function needsPassword() {
    return !store.hostOk && !storage.get(KEY_HOST);
  }

  function updateStart() {
    $('#start-pw').hidden = !needsPassword();
    $('#relogin').hidden = !store.started || store.hostOk || !socket.connected;
  }

  $('#start-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    unlockAudio();
    goFullscreen(); // has to happen inside the click, before any await
    const error = $('#start-error');
    error.textContent = '';
    if (!store.hostOk) {
      const token = storage.get(KEY_HOST);
      const pw = $('#start-pw');
      if (!token && !pw.value) {
        error.textContent = 'Type the host password.';
        return;
      }
      const res = await call('host:login', token ? { hostToken: token } : { password: pw.value });
      if (!res.ok) {
        if (token) storage.del(KEY_HOST);
        error.textContent = token ? 'Please type the host password again.' : res.error;
        updateStart();
        return;
      }
      if (res.hostToken) storage.set(KEY_HOST, res.hostToken);
      store.hostOk = true;
      pw.value = '';
    }
    store.started = true;
    keepAwake();
    $('#start').hidden = true;
    updateStart();
    render(true);
  });
  $('#start-test').addEventListener('click', () => {
    unlockAudio();
    sounds.alarm();
  });
  $('#relogin').addEventListener('click', () => {
    $('#start').hidden = false;
    updateStart();
    $('#start-pw').focus();
  });
  setMuted(muted);
  updateStart();

  // ------------------------------------------------------------------ render

  let lastKey = '';
  function render(force = false) {
    const s = store.state;
    // `now` changes on every push; countdowns are updated by tick(), so leave it out of the key.
    const key = JSON.stringify([s && { ...s, now: 0, me: null, you: null }, store.started, store.hostOk]);
    if (!force && key === lastKey) return;
    lastKey = key;
    updateStart();

    const live = s && (s.phase === 'play' || s.phase === 'meeting');
    $('#paused').hidden = !(live && s.paused);
    document.body.classList.toggle('is-paused', !!(live && s.paused));
    document.body.dataset.phase = s?.phase ?? '';
    document.body.classList.toggle('storming', !!(s?.phase === 'play' && s.storm));
    if (s?.phase !== 'over') stopSlides();

    if (!s) {
      $('#screen').replaceChildren(h('div', { class: 'tv-wait' }, 'Connecting…'));
      return;
    }
    const view = { lobby: lobbyView, play: playView, meeting: meetingView, over: overView }[s.phase] ?? lobbyView;
    $('#screen').replaceChildren(view(s));
    tick();
    requestAnimationFrame(afterRender);
  }

  function playerChip(p, extra = '') {
    return h('span', { class: `pchip ${extra}`, style: `--c:${p.color ?? 'var(--muted)'}` }, h('i', { class: 'pdot' }), p.name);
  }


  function countdown(endsAt, cls = 'huge') {
    return h('div', { class: `count ${cls}`, 'data-ends': endsAt }, clock(remaining(endsAt)));
  }

  // ---- lobby: join QR + who's in

  function lobbyView(s) {
    const players = s.players ?? [];
    const playing = players.filter((p) => !p.sitOut);
    return h('div', { class: 'lobby' },
      h('section', { class: 'join' },
        h('div', { class: 'qr' }, h('img', { src: '/lake/qr/join.svg', alt: 'QR code to join the game' })),
        h('div', { class: 'join-text' }, 'Scan to join'),
        h('div', { class: 'join-url' }, `${location.host}/lake`)),
      h('section', { class: 'lobby-side' },
        h('h1', { class: 'title' }, 'Lake Lurkers'),
        h('p', { class: 'lead' }, s.gameNo ? `Game ${s.gameNo + 1} starts soon.` : 'Campers do chores. Lurkers hide among them.'),
        h('h2', { class: 'section-h' }, `Players · ${playing.length}`),
        players.length
          ? h('div', { class: 'chips' }, players.map((p) => playerChip(p, p.sitOut ? 'dim' : '')))
          : h('p', { class: 'lead' }, 'Nobody yet. Be the first!'),
        players.some((p) => p.sitOut) ? h('p', { class: 'note' }, 'Faded names are sitting out this game.') : '',
        h('p', { class: 'note' }, 'Pick a name and a 4-digit PIN. Same name + PIN gets you back in on any device.'),
        h('p', { class: 'note' }, 'Rules: ', h('b', {}, `${location.host}/lake/rules`))));
  }

  // ---- play: chore bar + players (or the storm takeover)

  let lastPct = 0;
  function playView(s) {
    if (s.storm) return stormView(s);
    const inGame = (s.players ?? []).filter((p) => p.inGame);
    const bar = s.bar ?? { done: 0, total: 0 };
    const pct = bar.total ? Math.round((bar.done / bar.total) * 100) : 0;
    // start the fill at the old width so the change animates
    const fill = h('div', { class: 'bar-fill', style: `width:${lastPct}%` });
    requestAnimationFrame(() => { fill.style.width = `${pct}%`; });
    lastPct = pct;
    return h('div', { class: 'play' },
      h('header', { class: 'tv-head' },
        h('b', {}, `Game ${s.gameNo}`),
        h('span', { class: 'grow' }),
        h('span', {}, `${inGame.length} players`)),
      h('section', { class: 'chores' },
        h('div', { class: 'chores-label' }, h('span', {}, 'Chores done'), h('b', {}, `${pct}%`)),
        h('div', { class: 'bar' }, fill),
        h('div', { class: 'chores-sub' },
          `${bar.done} of ${bar.total} · Campers win when the bar is full`,
          s.settings?.barMode === 'meetings' ? ' · it updates at each Campfire' : '')),
      h('section', { class: 'roster' },
        h('div', { class: 'chips big' }, inGame.map((p) => playerChip(p, p.out ? 'out' : '')))),
      h('footer', { class: 'hints' },
        h('span', {}, 'Found a body? Type its code on your phone.'),
        h('span', {}, `Ring the bell at the Campfire: ${s.campfire?.where ?? ''}`)));
  }

  function stormView(s) {
    const st = s.storm;
    return h('div', { class: 'storm' },
      h('div', { class: 'storm-title' }, '⛈ Storm!'),
      countdown(st.endsAt),
      h('p', { class: 'storm-lead' }, 'Secure both stations before time runs out, or the Lurkers win.'),
      h('div', { class: 'storm-stations' }, st.stations.map((x) =>
        h('div', { class: `storm-st ${x.secured ? 'ok' : ''}` },
          h('div', { class: 'st-name' }, x.name),
          h('div', { class: 'st-where' }, x.where),
          h('div', { class: 'st-state' }, x.secured ? '✓ Secured' : 'Not secured yet')))),
      h('p', { class: 'storm-foot' }, 'Scan the station and hold. It takes two different players. Ghosts can’t help.'));
  }

  // ---- meeting: stage, countdown, who's here / who voted, result

  const STAGES = [['gather', 'Gather'], ['discuss', 'Discuss'], ['vote', 'Vote'], ['result', 'Result']];
  const STAGE_TITLE = { gather: 'Gather at the Campfire', discuss: 'Discuss', vote: 'Vote now', result: 'The vote' };

  function meetingView(s) {
    const m = s.meeting;
    if (!m) return h('div', { class: 'tv-wait' }, 'Campfire!');
    const players = s.players ?? [];
    const byId = new Map(players.map((p) => [p.id, p]));
    const voters = (m.voters ?? players.filter((p) => p.inGame && !p.out).map((p) => p.id)).map((id) => byId.get(id)).filter(Boolean);
    const ghosts = players.filter((p) => p.inGame && p.out);
    const why = m.reason === 'body' ? `${m.caller} found ${possessive(m.body)} body` : `${m.caller} rang the bell`;
    const newlyOut = m.newlyOut?.length ? h('p', { class: 'newly-out' }, 'Out since the last Campfire: ', h('b', {}, m.newlyOut.join(', '))) : '';

    let body;
    if (m.stage === 'gather') {
      const here = new Set(m.here ?? []);
      body = [
        h('p', { class: 'lead' }, `Everyone to the Campfire: ${s.campfire?.where ?? ''}. Press “I’m here” on your phone.`),
        h('div', { class: 'progress-line' }, 'Here: ', h('b', {}, `${voters.filter((p) => here.has(p.id)).length} / ${voters.length}`)),
        h('div', { class: 'chips big' }, voters.map((p) => playerChip(p, here.has(p.id) ? 'on' : ''))),
      ];
    } else if (m.stage === 'discuss') {
      body = [
        h('p', { class: 'lead' }, 'Who’s acting fishy? Talk it out. Ghosts stay silent.'),
        h('div', { class: 'chips big' }, voters.map((p) => playerChip(p))),
        ghosts.length ? h('p', { class: 'note' }, 'Ghosts: ', ghosts.map((p) => p.name).join(', ')) : '',
      ];
    } else if (m.stage === 'vote') {
      const voted = new Set(m.voted ?? []);
      body = [
        h('p', { class: 'lead' }, 'Vote on your phone. Not sure? Skip.'),
        h('div', { class: 'progress-line' }, 'Voted: ', h('b', {}, `${voters.filter((p) => voted.has(p.id)).length} / ${voters.length}`)),
        h('div', { class: 'chips big' }, voters.map((p) => playerChip(p, voted.has(p.id) ? 'on' : ''))),
      ];
    } else {
      body = resultView(m.result);
    }

    return h('div', { class: `meeting stage-${m.stage}` },
      h('div', { class: 'meeting-top' },
        h('div', { class: 'meeting-left' },
          h('div', { class: 'stage-steps' }, STAGES.map(([id, label]) => h('span', { class: id === m.stage ? 'active' : '' }, label))),
          h('h1', { class: 'stage-title' }, STAGE_TITLE[m.stage] ?? 'Campfire'),
          h('p', { class: 'why' }, '🔥 ', why),
          m.stage !== 'result' ? newlyOut : ''),
        h('div', { class: 'meeting-clock' },
          m.stage === 'result' ? h('div', { class: 'clock-label' }, 'Back to chores in') : '',
          countdown(m.endsAt, m.stage === 'result' ? 'mid' : 'huge'))),
      h('div', { class: 'meeting-body' }, body));
  }

  const NOBODY = { tie: 'It was a tie.', skip: 'Skip got the most votes.', novotes: 'Nobody voted.' };

  function resultView(r) {
    if (!r) return h('p', { class: 'lead' }, 'Counting the votes…');
    let sub;
    if (!r.ejected) sub = h('p', { class: 'result-sub' }, NOBODY[r.reason] ?? '');
    else if (r.role === 'lurker') sub = h('p', { class: 'result-sub lurker' }, `${r.ejected.name} was a Lurker.`);
    else if (r.role === 'camper') sub = h('p', { class: 'result-sub camper' }, `${r.ejected.name} was a Camper.`);
    else sub = h('p', { class: 'result-sub' }, 'Their role stays secret.');

    const tally = [...(r.tally ?? [])].sort((a, b) => b.votes - a.votes || (a.id === 'skip') - (b.id === 'skip'));
    const max = Math.max(1, ...tally.map((t) => t.votes));
    return h('div', { class: 'result' },
      h('div', { class: 'result-main' },
        h('h2', { class: 'result-head' }, r.ejected ? `${r.ejected.name} was voted out` : 'Nobody was voted out'),
        sub,
        h('div', { class: 'tally' }, tally.map((t) =>
          h('div', { class: `tally-row ${t.id === 'skip' ? 'skip' : ''} ${r.ejected?.id === t.id ? 'top' : ''}` },
            h('span', { class: 'tally-name' }, t.id === 'skip' ? 'Skip' : t.name),
            h('span', { class: 'tally-track' }, h('span', { class: 'tally-bar', style: `width:${(t.votes / max) * 100}%` })),
            h('b', { class: 'tally-n' }, t.votes))))),
      r.votes ? h('div', { class: 'votes' },
        h('h3', {}, 'Who voted for whom'),
        h('div', { class: 'votes-list' }, r.votes.map((v) =>
          h('div', {}, v.voter, h('span', { class: 'muted' }, ' → '), String(v.target).toLowerCase() === 'skip' ? 'Skip' : v.target)))) : '');
  }

  // ---- over: winner, who was who, timeline, photos

  // the server's reason is a phrase like "every chore got done"; show it as a sentence
  const sentence = (t) => `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}`;

  function overView(s) {
    const o = s.over;
    if (!o) return h('div', { class: 'tv-wait' }, 'Game over');
    const title = o.winner === 'campers' ? 'Campers win!' : o.winner === 'lurkers' ? 'Lurkers win!' : 'Game ended';
    const roles = o.roles ?? [];
    const lurkers = roles.filter((r) => r.role === 'lurker');
    const campers = roles.filter((r) => r.role !== 'lurker');
    const photos = o.photos ?? [];
    const roleRow = (r) => h('div', { class: `role-row ${r.role}` },
      h('i', { class: 'pdot', style: `--c:${r.color ?? 'var(--muted)'}` }),
      h('span', { class: 'role-name' }, r.name),
      h('span', { class: 'fate' }, r.fate === 'alive' ? 'survived' : r.fate));

    return h('div', { class: 'over' },
      h('header', { class: `winner ${o.winner ?? 'none'}` },
        h('h1', {}, title),
        o.reason ? h('p', {}, sentence(String(o.reason))) : ''),
      h('div', { class: `over-body ${photos.length ? '' : 'no-photos'}` },
        h('section', { class: 'panel-tv' },
          h('h2', {}, 'Who was who'),
          h('div', { class: 'autoscroll' }, h('div', { class: 'roles' },
            h('div', { class: 'role-group lurkers' }, h('h3', {}, lurkers.length === 1 ? 'The Lurker' : 'The Lurkers'), lurkers.map(roleRow)),
            h('div', { class: 'role-group campers' }, h('h3', {}, 'Campers'), campers.map(roleRow))))),
        h('section', { class: 'panel-tv' },
          h('h2', {}, 'What happened'),
          h('div', { class: 'autoscroll' }, h('div', { class: 'timeline' }, (o.timeline ?? []).map((e) =>
            h('div', { class: 'tl' }, h('span', { class: 't' }, mmss(Math.max(0, Math.round(e.t)))), h('span', {}, e.text)))))),
        photos.length ? h('section', { class: 'panel-tv photos' }, h('h2', {}, `Photos · ${photos.length}`), slideshow(photos)) : ''));
  }

  // The slideshow element survives re-renders so the current photo doesn't restart on every push.
  const slides = { key: '', el: null, timer: null, i: 0 };

  function photoSrc(url) {
    // photo URLs carry ?t=; if this one has no token, use the host token so the image loads on the TV
    try {
      const u = new URL(url, location.origin);
      const token = storage.get(KEY_HOST);
      if (!u.searchParams.get('t') && token) u.searchParams.set('t', token);
      return u.pathname + u.search;
    } catch {
      return url;
    }
  }

  function slideshow(photos) {
    const key = photos.map((p) => p.id).join(',');
    if (slides.key === key && slides.el) return slides.el;
    stopSlides();
    const img = h('img', { alt: '' });
    const cap = h('div', { class: 'cap' });
    const show = (i) => {
      const p = photos[i % photos.length];
      img.classList.add('fade');
      setTimeout(() => {
        img.onload = () => img.classList.remove('fade');
        img.onerror = () => img.classList.remove('fade');
        img.src = photoSrc(p.url);
        cap.replaceChildren(h('b', {}, p.title ?? 'Photo'), ' · ', p.by ?? '', p.partner ? ` with ${p.partner}` : '',
          photos.length > 1 ? h('span', { class: 'muted' }, `  ${(i % photos.length) + 1}/${photos.length}`) : '');
      }, slides.el ? 450 : 0);
      // warm the next one so the swap is instant
      if (photos.length > 1) new Image().src = photoSrc(photos[(i + 1) % photos.length].url);
    };
    slides.key = key;
    slides.i = 0;
    slides.el = null;
    show(0);
    slides.el = h('div', { class: 'slides' }, img, cap);
    if (photos.length > 1) slides.timer = setInterval(() => show(++slides.i), 6000);
    return slides.el;
  }

  function stopSlides() {
    clearInterval(slides.timer);
    slides.timer = null;
    slides.key = '';
    slides.el = null;
  }

  // Long timelines scroll slowly up and down, since nobody can scroll a TV.
  function afterRender() {
    for (const box of document.querySelectorAll('.autoscroll')) {
      const inner = box.firstElementChild;
      const dist = inner.scrollHeight - box.clientHeight;
      inner.classList.toggle('scrolling', dist > 4);
      if (dist > 4) {
        inner.style.setProperty('--dist', `${dist}px`);
        inner.style.setProperty('--dur', `${Math.max(12, dist / 25)}s`);
      }
    }
  }
  window.addEventListener('resize', () => requestAnimationFrame(afterRender));

  // ------------------------------------------------------------------ countdowns

  let beepSec = null;
  function tick() {
    for (const el of document.querySelectorAll('[data-ends]')) {
      const ms = remaining(Number(el.dataset.ends));
      el.textContent = clock(ms);
      el.classList.toggle('urgent', ms <= 10_000);
    }
    // beep through the last ten seconds of a storm
    const s = store.state;
    if (s?.phase === 'play' && s.storm && !s.paused) {
      const sec = Math.ceil(remaining(s.storm.endsAt) / 1000);
      if (sec !== beepSec && sec > 0 && sec <= 10) sounds.beep(sec <= 3);
      beepSec = sec;
    } else {
      beepSec = null;
    }
  }
  setInterval(tick, 200);

  render(true);
})();
