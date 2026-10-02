/* global io */
/**
 * Generic exchange client. Renders every market's live order book, order entry, positions,
 * orders, leaderboard and trade tape. Games extend it through window.Exchange (see bottom).
 */
(() => {
  'use strict';

  const DEPTH = 5; // price levels shown per side

  // ------------------------------------------------------------------ helpers

  const $ = (sel) => document.querySelector(sel);

  /** h('div', { class, onclick, ... }, ...children): build DOM without innerHTML (names are user input). */
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

  const round1 = (n) => Math.round(n * 10) / 10;
  const fmtPnl = (n) => (n > 0 ? '+' : '') + round1(n).toLocaleString();
  const fmtPos = (n) => (n > 0 ? '+' : '') + n;
  const fmtPx = (n) => (n == null ? '–' : String(round1(n)));
  const sign = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // ------------------------------------------------------------------ state + socket

  const store = { game: null, state: null, me: null, isAdmin: false };
  const socket = io({ autoConnect: false });
  let keys = null;

  function call(event, payload) {
    return new Promise((resolve) => {
      socket.timeout(5000).emit(event, payload, (err, res) => resolve(err ? { ok: false, error: 'Server did not respond' } : res));
    });
  }

  const marketById = (id) => store.state?.markets.find((m) => m.id === id);
  const marketLabel = (m) => (!m ? '(removed)' : m.group ? `${m.group.name} · ${m.name}` : m.name);

  function toast(msg, kind = 'info') {
    const el = h('div', { class: `toast ${kind}` }, msg);
    $('#toasts').append(el);
    setTimeout(() => el.classList.add('out'), 3500);
    setTimeout(() => el.remove(), 4000);
  }

  // ------------------------------------------------------------------ joining

  function showJoin() {
    $('#join').hidden = false;
    $('#join-name').focus();
  }

  async function join(payload) {
    const res = await call('join', payload);
    if (res.ok) {
      storage.set(keys.token, res.user.token);
      $('#join').hidden = true;
    }
    return res;
  }

  $('#join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await join({ name: $('#join-name').value });
    $('#join-error').textContent = res.ok ? '' : res.error;
  });

  socket.on('connect', async () => {
    setConnected(true);
    const token = storage.get(keys.token);
    if (token) {
      const res = await join({ token });
      if (!res.ok) {
        storage.del(keys.token); // server was reset
        showJoin();
      }
    } else showJoin();

    const adminToken = storage.get(keys.admin);
    if (adminToken) {
      const res = await call('admin:login', { adminToken });
      if (!res.ok) storage.del(keys.admin);
      setAdmin(res.ok);
    }
  });

  socket.on('disconnect', () => setConnected(false));
  socket.on('state', (state) => {
    store.state = state;
    render();
  });
  socket.on('me', (me) => {
    announceFills(me);
    store.me = me;
    render();
  });

  function setConnected(on) {
    $('#conn').classList.toggle('on', on);
    $('#conn').title = on ? 'Connected' : 'Disconnected, reconnecting…';
  }

  let seenTrades = null;
  function announceFills(me) {
    if (seenTrades) {
      for (const t of me.trades) {
        if (seenTrades.has(t.id)) continue;
        const verb = t.side === 'buy' ? 'Bought' : 'Sold';
        toast(`${verb} ${t.qty} ${marketLabel(marketById(t.marketId))} @ ${t.price}`, t.side);
      }
    }
    seenTrades = new Set(me.trades.map((t) => t.id));
  }

  // ------------------------------------------------------------------ orders

  async function submitOrder(marketId, side, price, qty, tif) {
    if (!store.me) return showJoin();
    if (price === '' || price == null) return toast('Enter a price first', 'error');
    const res = await call('order', { marketId, side, price: Number(price), qty: Number(qty), tif });
    if (!res.ok) return toast(res.error, 'error');
    const { order, filled } = res;
    if (order.status === 'open') {
      const what = side === 'buy' ? 'Bid' : 'Ask';
      toast(`${what} ${order.remaining} @ ${order.price} posted${filled ? ` (${filled} filled)` : ''}`);
    } else if (!filled) toast('Nothing filled, the price moved', 'error');
  }

  async function cancelOrder(orderId) {
    const res = await call('cancel', { orderId });
    if (!res.ok) toast(res.error, 'error');
  }

  async function cancelAll(marketId = null) {
    const res = await call('cancelAll', { marketId });
    if (!res.ok) toast(res.error, 'error');
    else if (res.cancelled) toast(`Cancelled ${res.cancelled} order${res.cancelled === 1 ? '' : 's'}`);
  }

  $('#cancel-all').addEventListener('click', () => cancelAll());

  async function admin(cmd, args) {
    const res = await call('admin', { cmd, args });
    if (!res.ok) toast(res.error, 'error');
    return res;
  }

  // ------------------------------------------------------------------ rendering

  let renderQueued = false;
  function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!store.state) return;
      renderHeader();
      renderMarkets();
      renderPositions();
      renderOrders();
      renderLeaderboard();
      renderTape();
      for (const p of adminPanels) if (p.el) p.update?.(store.state, store.me);
    });
  }

  function renderHeader() {
    const me = store.me;
    $('#me-summary').replaceChildren(
      me ? h('span', {}, h('b', {}, me.name), ' P&L ', h('b', { class: sign(me.pnl) }, fmtPnl(me.pnl))) : '',
    );
  }

  // Sections (one per group) and cards (one per market) are created once and updated in place,
  // so typing into a price box isn't interrupted by live updates.
  const sections = new Map();
  const cards = new Map();

  function renderMarkets() {
    const { markets } = store.state;
    $('#markets-empty').hidden = markets.length > 0;

    const groups = new Map();
    for (const m of markets) {
      const id = m.group?.id ?? '_';
      if (!groups.has(id)) groups.set(id, { id, name: m.group?.name ?? 'Markets', isGroup: !!m.group, markets: [] });
      groups.get(id).markets.push(m);
    }
    const done = (g) => g.markets.every((m) => m.status === 'settled');
    const newest = (g) => Math.max(...g.markets.map((m) => m.createdAt));
    const ordered = [...groups.values()].sort((a, b) => done(a) - done(b) || newest(b) - newest(a));

    for (const [id, sec] of sections) {
      if (!groups.has(id)) {
        sec.root.remove();
        sections.delete(id);
      }
    }
    const live = new Set(markets.map((m) => m.id));
    for (const [id, card] of cards) {
      if (!live.has(id)) {
        card.root.remove();
        cards.delete(id);
      }
    }

    const container = $('#groups');
    ordered.forEach((g, i) => {
      if (!sections.has(g.id)) sections.set(g.id, makeSection(g));
      const sec = sections.get(g.id);
      if (container.children[i] !== sec.root) container.insertBefore(sec.root, container.children[i] ?? null);
      updateSection(sec, g, done(g));
      g.markets.forEach((m, j) => {
        if (!cards.has(m.id)) cards.set(m.id, makeCard(m));
        const card = cards.get(m.id);
        if (sec.grid.children[j] !== card.root) sec.grid.insertBefore(card.root, sec.grid.children[j] ?? null);
        updateCard(card, m);
      });
    });
  }

  function makeSection(g) {
    const sec = {};
    sec.title = h('span', { class: 'group-title' });
    sec.summary = h('span', { class: 'group-summary muted' });
    sec.halt = h('button', { type: 'button', class: 'small', onclick: (e) => { e.preventDefault(); admin('halt', { groupId: g.id }); } }, 'Halt all');
    sec.resume = h('button', { type: 'button', class: 'small', onclick: (e) => { e.preventDefault(); admin('resume', { groupId: g.id }); } }, 'Resume all');
    sec.adminBar = h('span', { class: 'group-admin' }, sec.halt, sec.resume);
    sec.grid = h('div', { class: 'grid' });
    sec.root = h('details', { class: 'group', open: true }, h('summary', {}, sec.title, sec.summary, sec.adminBar), sec.grid);
    sec.wasDone = false;
    return sec;
  }

  function updateSection(sec, g, isDone) {
    sec.title.textContent = g.name;
    const winner = g.markets.find((m) => m.status === 'settled' && m.settlement === m.max);
    const halted = g.markets.some((m) => m.status === 'halted');
    sec.summary.textContent = isDone
      ? winner ? `settled: ${winner.name} won` : 'settled'
      : halted ? 'halted' : `${g.markets.reduce((n, m) => n + m.volume, 0)} traded`;
    sec.root.classList.toggle('done', isDone);
    if (isDone && !sec.wasDone) sec.root.open = false; // collapse finished groups once
    sec.wasDone = isDone;
    sec.adminBar.hidden = !store.isAdmin || !g.isGroup || isDone;
    sec.halt.hidden = !g.markets.some((m) => m.status === 'open');
    sec.resume.hidden = !halted;
  }

  function makeCard(m) {
    const c = { id: m.id };
    const market = () => marketById(m.id);
    c.title = h('h3', {});
    c.badge = h('span', { class: 'badge' });
    c.stats = h('div', { class: 'stats' });
    c.body = h('tbody', {});
    c.ladder = h(
      'table',
      { class: 'ladder' },
      h('thead', {}, h('tr', {}, h('th', {}, 'you'), h('th', {}, 'bid'), h('th', {}, 'price'), h('th', {}, 'ask'), h('th', {}, 'you'))),
      c.body,
    );
    c.settled = h('div', { class: 'settled-banner' });

    c.qty = h('input', { type: 'number', min: 1, step: 1, value: 1, class: 'qty', 'aria-label': 'Quantity' });
    c.price = h('input', { type: 'number', min: m.min, max: m.max, step: m.tick, class: 'price', placeholder: 'price', 'aria-label': 'Price' });
    c.hit = h('button', { type: 'button', class: 'sell', onclick: () => {
      const best = market()?.bids[0];
      if (best) submitOrder(m.id, 'sell', best.price, c.qty.value, 'IOC');
    } });
    c.lift = h('button', { type: 'button', class: 'buy', onclick: () => {
      const best = market()?.asks[0];
      if (best) submitOrder(m.id, 'buy', best.price, c.qty.value, 'IOC');
    } });
    c.bid = h('button', { type: 'button', class: 'buy outline', onclick: () => submitOrder(m.id, 'buy', c.price.value, c.qty.value, 'GTC') }, 'Bid');
    c.ask = h('button', { type: 'button', class: 'sell outline', onclick: () => submitOrder(m.id, 'sell', c.price.value, c.qty.value, 'GTC') }, 'Ask');
    c.cancel = h('button', { type: 'button', class: 'link', onclick: () => cancelAll(m.id) }, 'cancel mine');
    c.trade = h(
      'div',
      { class: 'trade' },
      h('div', { class: 'row' }, h('label', {}, 'qty', c.qty), c.hit, c.lift),
      h('div', { class: 'row' }, h('label', {}, 'px', c.price), c.bid, c.ask),
    );

    c.adminHalt = h('button', { type: 'button', class: 'small', onclick: () => admin(market()?.status === 'halted' ? 'resume' : 'halt', { marketId: m.id }) });
    c.adminPx = h('input', { type: 'number', min: m.min, max: m.max, class: 'price', placeholder: 'settle px' });
    c.adminSettle = h('button', { type: 'button', class: 'small', onclick: () => {
      if (c.adminPx.value === '') return toast('Enter a settlement price', 'error');
      if (confirm(`Settle ${marketLabel(market())} at ${c.adminPx.value}? This cannot be undone.`)) admin('settle', { marketId: m.id, price: Number(c.adminPx.value) });
    } }, 'Settle');
    c.adminDelete = h('button', { type: 'button', class: 'small danger', onclick: () => {
      if (confirm(`Delete ${marketLabel(market())}?`)) admin('deleteMarket', { marketId: m.id });
    } }, 'Delete');
    c.admin = h('div', { class: 'card-admin' }, c.adminHalt, c.adminPx, c.adminSettle, c.adminDelete);

    c.root = h('article', { class: 'card' }, h('header', {}, c.title, c.badge), c.stats, c.ladder, c.settled, c.trade, c.admin);
    return c;
  }

  function updateCard(c, m) {
    const pos = store.me?.positions.find((p) => p.marketId === m.id);
    const myOrders = store.me?.orders.filter((o) => o.marketId === m.id) ?? [];
    const open = m.status === 'open';
    const settled = m.status === 'settled';

    c.title.textContent = m.name;
    c.root.title = m.description;
    c.badge.textContent = m.status;
    c.badge.className = `badge ${m.status}`;
    c.root.classList.toggle('settled', settled);
    c.root.classList.toggle('halted', m.status === 'halted');

    c.stats.replaceChildren(
      h('span', {}, 'last ', h('b', {}, fmtPx(m.lastPrice))),
      h('span', {}, 'vol ', h('b', {}, m.volume)),
      pos ? h('span', {}, 'pos ', h('b', { class: sign(pos.position) }, fmtPos(pos.position))) : '',
      pos ? h('span', {}, 'P&L ', h('b', { class: sign(pos.pnl) }, fmtPnl(pos.pnl))) : '',
      myOrders.length && !settled ? c.cancel : '',
    );

    c.ladder.hidden = settled;
    c.trade.hidden = settled;
    c.settled.hidden = !settled;
    if (settled) c.settled.textContent = `Settled at ${m.settlement}`;
    else renderLadder(c, m, myOrders);

    const bestBid = m.bids[0];
    const bestAsk = m.asks[0];
    c.hit.textContent = bestBid ? `Hit ${bestBid.price}` : 'Hit bid';
    c.lift.textContent = bestAsk ? `Lift ${bestAsk.price}` : 'Lift ask';
    c.hit.disabled = !open || !bestBid;
    c.lift.disabled = !open || !bestAsk;
    c.bid.disabled = !open;
    c.ask.disabled = !open;

    c.admin.hidden = !store.isAdmin || settled;
    c.adminHalt.textContent = m.status === 'halted' ? 'Resume' : 'Halt';
    c.adminDelete.hidden = m.volume > 0;
  }

  function renderLadder(c, m, myOrders) {
    const mine = { buy: new Map(), sell: new Map() };
    for (const o of myOrders) mine[o.side].set(o.price, (mine[o.side].get(o.price) ?? 0) + o.remaining);

    const asks = m.asks.slice(0, DEPTH).reverse(); // best ask sits next to the spread
    const bids = m.bids.slice(0, DEPTH);
    const maxQty = Math.max(1, ...asks.map((l) => l.qty), ...bids.map((l) => l.qty));
    const pick = (price) => {
      c.price.value = price;
      c.price.focus();
    };
    const level = (l, side) => {
      const bar = `--w:${Math.round((l.qty / maxQty) * 100)}%`;
      const isBid = side === 'buy';
      return h(
        'tr',
        { class: `lvl ${side}`, title: 'Click to fill in this price', onclick: () => pick(l.price) },
        h('td', { class: 'mine' }, isBid ? mine.buy.get(l.price) ?? '' : ''),
        h('td', { class: 'size', style: isBid ? bar : null }, isBid ? l.qty : ''),
        h('td', { class: 'px' }, l.price),
        h('td', { class: 'size', style: isBid ? null : bar }, isBid ? '' : l.qty),
        h('td', { class: 'mine' }, isBid ? '' : mine.sell.get(l.price) ?? ''),
      );
    };
    const blank = () => h('tr', { class: 'blank' }, h('td', { colSpan: 5 }, ' '));

    const spread = m.bids[0] && m.asks[0] ? m.asks[0].price - m.bids[0].price : null;
    const rows = [];
    for (let i = asks.length; i < DEPTH; i++) rows.push(blank());
    for (const l of asks) rows.push(level(l, 'sell'));
    rows.push(h('tr', { class: 'mid' }, h('td', { colSpan: 5 }, spread === null ? 'no market' : `spread ${spread}`)));
    for (const l of bids) rows.push(level(l, 'buy'));
    for (let i = bids.length; i < DEPTH; i++) rows.push(blank());
    c.body.replaceChildren(...rows);
  }

  function table(head, rows, empty) {
    if (!rows.length) return h('p', { class: 'muted small' }, empty);
    return h('table', { class: 'list' }, h('thead', {}, h('tr', {}, head.map((t) => h('th', {}, t)))), h('tbody', {}, rows));
  }

  function renderPositions() {
    const me = store.me;
    if (!me) return $('#positions').replaceChildren();
    const rows = [...me.positions]
      .sort((a, b) => Math.abs(b.position) - Math.abs(a.position))
      .map((p) =>
        h(
          'tr',
          {},
          h('td', {}, marketLabel(marketById(p.marketId))),
          h('td', { class: `num ${sign(p.position)}` }, p.position ? fmtPos(p.position) : '0'),
          h('td', { class: 'num' }, fmtPx(p.mark)),
          h('td', { class: `num ${sign(p.pnl)}` }, fmtPnl(p.pnl)),
        ),
      );
    $('#positions').replaceChildren(table(['market', 'pos', 'mark', 'P&L'], rows, 'No positions yet.'));
  }

  function renderOrders() {
    const me = store.me;
    $('#cancel-all').hidden = !me?.orders.length;
    if (!me) return $('#orders').replaceChildren();
    const rows = me.orders.map((o) =>
      h(
        'tr',
        {},
        h('td', {}, marketLabel(marketById(o.marketId))),
        h('td', { class: o.side === 'buy' ? 'up' : 'down' }, o.side === 'buy' ? 'bid' : 'ask'),
        h('td', { class: 'num' }, o.price),
        h('td', { class: 'num' }, o.remaining === o.qty ? o.qty : `${o.remaining}/${o.qty}`),
        h('td', {}, h('button', { type: 'button', class: 'link', title: 'Cancel', onclick: () => cancelOrder(o.id) }, '✕')),
      ),
    );
    $('#orders').replaceChildren(table(['market', 'side', 'px', 'qty', ''], rows, 'No open orders.'));
  }

  function renderLeaderboard() {
    const rows = store.state.leaderboard.map((u, i) =>
      h(
        'tr',
        { class: u.name === store.me?.name ? 'me' : '' },
        h('td', { class: 'num muted' }, i + 1),
        h('td', {}, u.name),
        h('td', { class: `num ${sign(u.pnl)}` }, fmtPnl(u.pnl)),
      ),
    );
    $('#leaderboard').replaceChildren(table(['#', 'trader', 'P&L'], rows, 'Nobody has joined yet.'));
  }

  function renderTape() {
    const mineIds = new Set(store.me?.trades.map((t) => t.id));
    const rows = store.state.trades
      .slice(-40)
      .reverse()
      .map((t) =>
        h(
          'tr',
          { class: mineIds.has(t.id) ? 'me' : '', title: mineIds.has(t.id) ? 'Your trade' : '' },
          h('td', { class: 'muted' }, fmtTime(t.ts)),
          h('td', {}, marketLabel(marketById(t.marketId))),
          h('td', { class: `num ${t.aggressor === 'buy' ? 'up' : 'down'}` }, `${t.aggressor === 'buy' ? '▲' : '▼'} ${t.price}`),
          h('td', { class: 'num' }, t.qty),
        ),
      );
    $('#tape').replaceChildren(table(['time', 'market', 'px', 'qty'], rows, 'No trades yet.'));
  }

  // ------------------------------------------------------------------ rules + admin

  $('#rules-btn').addEventListener('click', () => {
    $('#rules').hidden = !$('#rules').hidden;
  });
  $('#admin-btn').addEventListener('click', () => {
    $('#admin').hidden = !$('#admin').hidden;
    if (!$('#admin').hidden && !store.isAdmin) $('#admin-password')?.focus();
  });

  const adminPanels = [];

  /**
   * Add a panel to the admin area. panel = { title, order?, mount(el, api), update(state, me) }.
   * mount runs once after admin login; update runs on every state change.
   */
  function registerAdminPanel(panel) {
    adminPanels.push(panel);
    if (store.isAdmin) mountPanel(panel);
  }

  function mountPanel(panel) {
    if (panel.el) return;
    const body = h('div', { class: 'panel-body' });
    panel.el = h('section', { class: 'admin-panel', style: `order:${panel.order ?? 0}` }, h('h3', {}, panel.title), body);
    $('#admin-panels').append(panel.el);
    panel.mount(body, api);
    if (store.state) panel.update?.(store.state, store.me);
  }

  function renderAdminLogin() {
    if (store.isAdmin) {
      $('#admin-login').replaceChildren(
        h('div', { class: 'admin-head' }, h('b', {}, 'Admin mode'), h('button', { type: 'button', class: 'link', onclick: () => {
          storage.del(keys.admin);
          location.reload();
        } }, 'log out')),
      );
      return;
    }
    const pw = h('input', { id: 'admin-password', type: 'password', placeholder: 'Admin password', autocomplete: 'current-password' });
    const form = h('form', { class: 'inline', onsubmit: async (e) => {
      e.preventDefault();
      const res = await call('admin:login', { password: pw.value });
      if (!res.ok) return toast(res.error, 'error');
      storage.set(keys.admin, res.adminToken);
      setAdmin(true);
    } }, pw, h('button', { type: 'submit', class: 'primary' }, 'Log in'));
    $('#admin-login').replaceChildren(form);
  }

  function setAdmin(on) {
    store.isAdmin = on;
    $('#admin-btn').classList.toggle('active', on);
    document.body.classList.toggle('is-admin', on);
    renderAdminLogin();
    if (on) adminPanels.forEach(mountPanel);
    render();
  }

  // Core admin panel: list a standalone market. Games usually add a friendlier panel of their own.
  registerAdminPanel({
    title: 'New market',
    order: 1, // after game panels
    mount(el) {
      const name = h('input', { placeholder: 'Name', required: true });
      const group = h('input', { placeholder: 'Group (optional)' });
      const min = h('input', { type: 'number', placeholder: 'min (0)', class: 'price' });
      const max = h('input', { type: 'number', placeholder: 'max (100)', class: 'price' });
      const tick = h('input', { type: 'number', placeholder: 'tick (1)', class: 'price' });
      el.append(
        h('form', { class: 'inline', onsubmit: async (e) => {
          e.preventDefault();
          const res = await admin('createMarket', { name: name.value, group: group.value, min: min.value, max: max.value, tick: tick.value });
          if (res.ok) {
            toast(`Listed ${name.value}`);
            name.value = '';
          }
        } }, name, group, min, max, tick, h('button', { type: 'submit', class: 'primary' }, 'List')),
      );
    },
  });

  // ------------------------------------------------------------------ boot

  /** API available to game scripts. */
  const api = {
    h,
    call,
    admin,
    toast,
    registerAdminPanel,
    get state() { return store.state; },
    get me() { return store.me; },
    get game() { return store.game; },
  };
  window.Exchange = api;

  async function boot() {
    store.game = await fetch('/game.json').then((r) => r.json());
    keys = { token: `xchg:${store.game.id}:token`, admin: `xchg:${store.game.id}:admin` };
    document.title = store.game.title;
    $('#title').textContent = store.game.title;
    $('#join-title').textContent = store.game.title;
    $('#join-rules').textContent = store.game.rules;
    $('#rules').textContent = store.game.rules;
    $('#rules-btn').hidden = !store.game.rules;
    renderAdminLogin();
    for (const src of store.game.scripts) document.body.append(h('script', { src }));
    socket.connect();
  }

  boot();
})();
