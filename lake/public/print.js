/* global io */
/**
 * Printable QR cards at /lake/print (host only): a Join card plus one card per enabled station,
 * four to a US Letter page. Station codes come from the host view, so this page needs the host password.
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

  function toast(msg, kind = 'info') {
    const el = h('div', { class: `toast ${kind}` }, msg);
    $('#toasts').append(el);
    setTimeout(() => el.classList.add('out'), 3000);
    setTimeout(() => el.remove(), 3500);
  }

  const socket = io('/lake');
  function call(event, payload) {
    return new Promise((resolve) => {
      socket.timeout(5000).emit(event, payload ?? {}, (err, res) => resolve(err ? { ok: false, error: 'Server did not respond' } : res));
    });
  }

  const KEY_HOST = 'lake.hostToken';
  const PER_PAGE = 4;
  const FLOOR = { Main: 'Main floor', Upstairs: 'Upstairs', Basement: 'Basement', Outside: 'Outside' };
  const chunk = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const store = { connected: false, isHost: false, host: null, state: null, joinCards: 1 };
  const campfireId = () => store.state?.campfire?.id ?? 'campfire';

  // ------------------------------------------------------------------ socket

  socket.on('connect', async () => {
    $('#conn').classList.add('on');
    const hostToken = storage.get(KEY_HOST);
    if (hostToken) {
      const res = await call('host:login', { hostToken });
      if (res.ok) signedIn(res);
      else storage.del(KEY_HOST);
    }
    store.connected = true;
    render(true);
  });
  socket.on('disconnect', () => $('#conn').classList.remove('on'));
  socket.on('host', (view) => {
    store.host = view;
    render();
  });
  socket.on('state', (s) => {
    store.state = s;
    render();
  });

  function signedIn(res) {
    store.isHost = true;
    if (res.hostToken) storage.set(KEY_HOST, res.hostToken);
  }

  // ------------------------------------------------------------------ render

  // Only re-render when the cards would change, so player check-ins don't reload every QR image.
  let lastKey = '';
  function render(force = false) {
    const host = store.host;
    const key = JSON.stringify([store.connected, store.isHost, host?.stations, host?.settings?.storm, host?.settings?.stormStations, campfireId(), store.joinCards]);
    if (!force && key === lastKey) return;
    lastKey = key;
    const app = $('#app');
    $('#print').disabled = !(store.isHost && host);
    if (!store.connected) return app.replaceChildren(h('div', { class: 'empty no-print' }, 'Connecting…'));
    if (!store.isHost) return app.replaceChildren(loginCard());
    if (!host) return app.replaceChildren(h('div', { class: 'empty no-print' }, 'Loading the stations…'));

    const cards = buildCards(host);
    app.replaceChildren(
      howTo(host, cards.length),
      ...chunk(cards, PER_PAGE).map((page) => h('section', { class: 'sheet' }, page)));
  }

  function loginCard() {
    const pw = h('input', { type: 'password', class: 'big-input', placeholder: 'Host password', autocomplete: 'current-password' });
    const error = h('p', { class: 'error' });
    const form = h('form', { class: 'card login no-print', onsubmit: async (e) => {
      e.preventDefault();
      const res = await call('host:login', { password: pw.value });
      if (!res.ok) {
        error.textContent = res.error;
        return;
      }
      signedIn(res);
      render(true);
    } },
    h('h2', {}, 'QR cards for the stations'),
    h('p', { class: 'muted' }, 'Host only. The cards show the station codes, so sign in with the host password.'),
    pw,
    h('button', { type: 'submit', class: 'primary' }, 'Sign in'),
    error);
    setTimeout(() => pw.focus());
    return form;
  }

  function howTo(host, total) {
    const stations = host.stations ?? [];
    const off = stations.filter((st) => st.enabled === false);
    const on = stations.length - off.length;
    const joins = h('select', { onchange: (e) => { store.joinCards = Number(e.target.value); render(); } },
      [0, 1, 2, 3, 4].map((n) => h('option', { value: n, selected: n === store.joinCards }, n)));
    return h('section', { class: 'card howto no-print' },
      h('h2', {}, 'Print the station cards'),
      h('p', {}, `${plural(on, 'station card')} + ${plural(store.joinCards, 'Join card')} = ${plural(total, 'card')} on ${plural(Math.ceil(total / PER_PAGE), 'page')}.`),
      h('ol', {},
        h('li', {}, 'Print on US Letter, portrait. Keep the scale at 100% (“Default”, not “Fit to page”) so each QR code is about 3 inches.'),
        h('li', {}, 'Cut along the dashed lines.'),
        h('li', {}, h('b', {}, 'Tape each card at its station at eye level'), ', in the spot written on the card. Put the Join card by the TV.'),
        h('li', {}, 'Test one: point a phone camera at a card. It should open the game.')),
      addressWarning(),
      off.length ? h('p', { class: 'muted' }, `Switched off, so not printed: ${off.map((st) => st.name).join(', ')}.`) : '',
      host.settings?.storm === false ? h('p', { class: 'muted' }, 'Storms are off, so no card is marked as a storm station.') : '',
      h('div', { class: 'row' },
        h('label', { class: 'row' }, 'Join cards', joins),
        h('span', { class: 'grow' }),
        h('button', { type: 'button', class: 'primary', onclick: printNow }, 'Print')));
  }

  /** The QR codes encode the address this page was opened on, so printing from this laptop's own address won't work. */
  function addressWarning() {
    const host = location.hostname;
    if (host === 'localhost' || /^127\./.test(host) || host === '[::1]') {
      return h('p', { class: 'warn-box' }, `These QR codes open ${location.host}, which no phone can reach. Open this page on the game’s public address and print from there.`);
    }
    if (host.endsWith('.local') || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
      return h('p', { class: 'warn-box' }, `These QR codes open ${location.host}: they only work on the same Wi-Fi, while this computer runs the game.`);
    }
    return '';
  }

  // ------------------------------------------------------------------ cards

  function buildCards(host) {
    const cf = campfireId();
    const storm = new Set(host.settings?.storm === false ? [] : host.settings?.stormStations ?? []);
    const stations = (host.stations ?? []).filter((st) => st.enabled !== false);
    // the Campfire card first: it's the one that matters most
    stations.sort((a, b) => (b.id === cf) - (a.id === cf));
    const cards = Array.from({ length: store.joinCards }, joinCard);
    for (const st of stations) {
      const tags = [];
      if (st.id === cf) tags.push(['campfire', '🔥 Campfire — meetings & the bell']);
      if (storm.has(st.id)) tags.push(['storm', '⛈ Storm station']);
      cards.push(stationCard(st, tags));
    }
    return cards;
  }

  function qrImage(src, alt) {
    const img = h('img', { class: 'qc-qr', src, alt });
    img.addEventListener('error', () => img.classList.add('broken'));
    return img;
  }

  function stationCard(st, tags) {
    return h('div', { class: `qcard ${tags.map(([kind]) => kind).join(' ')}` },
      h('div', { class: 'qc-top' }, h('span', {}, FLOOR[st.floor] ?? st.floor ?? ''), h('span', {}, 'Lake Lurkers')),
      h('div', { class: 'qc-name' }, st.name),
      h('div', { class: 'qc-where' }, st.where),
      qrImage(`/lake/qr/${encodeURIComponent(st.code)}.svg`, `QR code for ${st.name}`),
      h('div', { class: 'qc-or' }, 'Scan with your phone camera, or type this code:'),
      h('div', { class: 'qc-code' }, st.code),
      tags.length ? h('div', { class: 'qc-tags' }, tags.map(([kind, text]) => h('span', { class: `qc-tag ${kind}` }, text))) : '');
  }

  function joinCard() {
    return h('div', { class: 'qcard join' },
      h('div', { class: 'qc-top' }, h('span', {}, 'Start here'), h('span', {}, 'Lake Lurkers')),
      h('div', { class: 'qc-name' }, 'Join the game'),
      h('div', { class: 'qc-where' }, 'Scan with your phone camera, then pick a name and a 4-digit PIN.'),
      qrImage('/lake/qr/join.svg', 'QR code to join the game'),
      h('div', { class: 'qc-or' }, 'or open'),
      h('div', { class: 'qc-code url' }, `${location.host}/lake`),
      h('div', { class: 'qc-foot' }, `Rules: ${location.host}/lake/rules`));
  }

  // ------------------------------------------------------------------ print

  async function printNow() {
    const imgs = [...document.querySelectorAll('.sheet img')];
    await Promise.all(imgs.map((img) => (img.complete ? null : new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    }))));
    if (document.querySelector('.qc-qr.broken')) {
      toast('Some QR codes didn’t load. Refresh the page and try again.', 'error');
      return;
    }
    window.print();
  }
  $('#print').addEventListener('click', printNow);

  render(true);
})();
