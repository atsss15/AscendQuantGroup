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
  const fmtUsd = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`;
  const fmtMoney = (n) => (n == null ? '–' : round1(n).toLocaleString());
  const fmtPos = (n) => (n > 0 ? '+' : '') + n;
  const fmtPx = (n) => (n == null ? '–' : String(round1(n)));
  const sign = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // ------------------------------------------------------------------ state + socket

  const store = { platform: null, state: null, me: null, isAdmin: false, adminState: null, view: 'trade', history: null };
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

  // ------------------------------------------------------------------ signing in

  const isAdminPage = location.pathname.replace(/\/+$/, '') === '/admin';

  // The name picker is a dropdown of accounts when sign-up is closed, a text box otherwise.
  let joinNamesKey = '';
  function renderJoinName() {
    const cfg = store.state?.config;
    const names = (store.state?.leaderboard ?? []).map((u) => u.name).sort((a, b) => a.localeCompare(b));
    const key = `${cfg?.openSignup}|${names.join(',')}`;
    if (key === joinNamesKey) return;
    joinNamesKey = key;
    const prev = $('#join-name')?.value || storage.get(keys.lastName) || '';
    const field = cfg && !cfg.openSignup
      ? h('select', { id: 'join-name', required: true }, h('option', { value: '' }, 'Who are you?'), names.map((n) => h('option', { value: n }, n)))
      : h('input', { id: 'join-name', maxLength: 24, placeholder: 'Your name', autocomplete: 'username', required: true });
    field.value = prev;
    $('#join-name-field').replaceChildren(field);
  }

  function showJoin() {
    renderJoinName();
    $('#join').hidden = false;
    ($('#join-name').value ? $('#join-password') : $('#join-name')).focus();
  }

  function signedIn({ user, isAdmin }) {
    storage.set(keys.token, user.token);
    storage.set(keys.lastName, user.name);
    $('#join').hidden = true;
    $('#join-error').textContent = '';
    if (isAdmin) setAdmin(true);
  }

  function signedOut() {
    storage.del(keys.token);
    store.me = null;
    seenTrades = null;
    if (!storage.get(keys.admin)) setAdmin(false); // admin rights came from the account
    render();
  }

  $('#join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await call('join', { name: $('#join-name').value, password: $('#join-password').value });
    if (!res.ok) {
      $('#join-error').textContent = res.error;
      return;
    }
    $('#join-password').value = '';
    signedIn(res);
    if (res.firstSignIn) toast(`Welcome ${res.user.name}! Your password is saved, use it next time.`);
  });
  $('#join-close').addEventListener('click', () => {
    $('#join').hidden = true;
  });
  $('#signin-btn').addEventListener('click', showJoin);
  $('#signout-btn').addEventListener('click', async () => {
    await call('signOut');
    signedOut();
  });

  socket.on('connect', async () => {
    setConnected(true);
    const token = storage.get(keys.token);
    if (token) {
      const res = await call('join', { token });
      if (res.ok) signedIn(res);
      else {
        storage.del(keys.token); // password was reset, or the server was reset
        if (!isAdminPage) showJoin();
      }
    } else if (!isAdminPage) showJoin();

    const adminToken = storage.get(keys.admin);
    if (adminToken) {
      const res = await call('admin:login', { adminToken });
      if (!res.ok) storage.del(keys.admin);
      else setAdmin(true);
    }
  });

  socket.on('signedOut', ({ reason }) => {
    signedOut();
    toast(reason, 'error');
    showJoin();
  });
  socket.on('disconnect', () => setConnected(false));
  socket.on('state', (state) => {
    store.state = state;
    if (!$('#join').hidden) renderJoinName();
    render();
  });
  socket.on('me', (me) => {
    announceFills(me);
    store.me = me;
    render();
  });
  socket.on('admin', (adminState) => {
    store.adminState = adminState;
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
      renderWagers();
      renderTape();
      renderSession();
      for (const p of adminPanels) {
        if (!p.el) continue;
        p.el.hidden = !!p.gameId && p.gameId !== store.state.session?.gameId; // game panels only during their session
        if (!p.el.hidden) p.update?.(store.state, store.me);
      }
      if (store.view === 'history') historyTimer ??= setTimeout(() => {
        historyTimer = null;
        loadHistory();
      }, 1000);
    });
  }
  let historyTimer = null;

  const currentGame = () => store.platform?.games.find((g) => g.id === store.state?.session?.gameId);

  function renderSession() {
    const session = store.state.session;
    const game = currentGame();
    $('#session-badge').hidden = !session;
    if (session) $('#session-badge').textContent = `● ${session.name} · ${game?.title ?? session.gameId}`;
    $('#rules').textContent = game?.rules ?? '';
    $('#rules-btn').hidden = !game?.rules;
    if (!game?.rules) $('#rules').hidden = true;
    $('#markets-empty').textContent = session
      ? 'No markets yet. Waiting for the admin to list some.'
      : 'No session is running right now. Your chips, trades and P&L from past sessions are under History.';
  }

  const bankrollMode = () => store.state?.config.startingBankroll != null;

  function renderHeader() {
    const me = store.me;
    $('#signin-btn').hidden = !!me;
    $('#signout-btn').hidden = !me;
    if (!me) return $('#me-summary').replaceChildren();
    const stat = (label, value, cls = '', title = '') => h('span', { class: 'stat', title }, label, ' ', h('b', { class: cls }, value));
    $('#me-summary').replaceChildren(
      h('b', {}, me.name),
      ...(bankrollMode()
        ? [
            stat('chips', fmtMoney(me.cash), '', 'Game-night chips: what you trade with'),
            me.quiz ? stat('quiz', fmtMoney(me.quiz), '', 'Quiz points (count toward equity, not tradeable)') : '',
            stat('equity', fmtMoney(me.equity), '', 'Game-night equity (chips plus open positions) plus quiz points'),
            me.sessionPnl !== null ? stat('session P&L', fmtPnl(me.sessionPnl), sign(me.sessionPnl), 'Your P&L in tonight\'s session') : '',
            stat('all-time', fmtPnl(me.pnl), sign(me.pnl), 'All-time P&L: equity minus starting chips and admin adjustments'),
            stat('available', fmtMoney(me.available), '', 'What you can still risk: chips minus the worst-case loss of your positions and orders'),
          ]
        : [stat('P&L', fmtPnl(me.pnl), sign(me.pnl))]),
      me.wagers.length ? stat('wagers', fmtUsd(me.wagerBalance), sign(me.wagerBalance), 'Real-money wagers still to settle') : '',
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
    sec.del = h('button', { type: 'button', class: 'small danger', onclick: (e) => {
      e.preventDefault();
      const traded = g.markets.reduce((n, m) => n + m.volume, 0);
      const warn = traded ? ` All its trades will be cancelled and everyone's chips restored.` : '';
      if (confirm(`Delete ${g.name}?${warn}`)) admin('deleteMarket', { groupId: g.id });
    } }, 'Delete');
    sec.adminBar = h('span', { class: 'group-admin' }, sec.halt, sec.resume, sec.del);
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
    sec.adminBar.hidden = !store.isAdmin || !g.isGroup;
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
      const mk = market();
      const warn = mk?.volume ? ` Its trades (${mk.volume} contracts) will be cancelled and everyone's chips restored.` : '';
      if (confirm(`Delete ${marketLabel(mk)}?${warn}`)) admin('deleteMarket', { marketId: m.id });
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

    c.admin.hidden = !store.isAdmin;
    c.adminHalt.textContent = m.status === 'halted' ? 'Resume' : 'Halt';
    c.adminHalt.hidden = settled;
    c.adminPx.hidden = settled;
    c.adminSettle.hidden = settled;
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
    const withEquity = bankrollMode();
    const withSession = !!store.state.session;
    const rows = store.state.leaderboard.map((u, i) =>
      h(
        'tr',
        { class: u.name === store.me?.name ? 'me' : '' },
        h('td', { class: 'num muted' }, i + 1),
        h('td', {}, u.name),
        withEquity ? h('td', { class: 'num', title: `game night ${fmtMoney(u.gameEquity)} + quiz ${fmtMoney(u.quiz)}` }, fmtMoney(u.equity)) : '',
        withSession ? h('td', { class: `num ${sign(u.sessionPnl)}` }, fmtPnl(u.sessionPnl)) : '',
        h('td', { class: `num ${sign(u.pnl)}` }, fmtPnl(u.pnl)),
      ),
    );
    const head = ['#', 'trader', ...(withEquity ? ['equity'] : []), ...(withSession ? ['session'] : []), 'all-time'];
    $('#leaderboard').replaceChildren(table(head, rows, 'Nobody has joined yet.'));
  }

  function renderWagers() {
    const wagers = store.me?.wagers ?? [];
    $('#wagers-panel').hidden = !wagers.length;
    if (!wagers.length) return;
    const rows = [...wagers].reverse().map((w) =>
      h(
        'tr',
        { class: w.paid ? 'paid' : '' },
        h('td', { class: 'muted' }, new Date(w.ts).toLocaleDateString([], { month: 'short', day: 'numeric' })),
        h('td', {}, w.note || '–'),
        h('td', { class: `num ${sign(w.amount)}` }, fmtUsd(w.amount)),
        h('td', { class: 'muted' }, w.paid ? 'paid' : 'open'),
      ),
    );
    $('#wagers').replaceChildren(
      h('p', { class: 'small' }, 'To settle: ', h('b', { class: sign(store.me.wagerBalance) }, fmtUsd(store.me.wagerBalance)),
        h('span', { class: 'muted' }, store.me.wagerBalance > 0 ? ' (you are owed)' : store.me.wagerBalance < 0 ? ' (you owe)' : '')),
      table(['date', 'for', '$', ''], rows, ''),
    );
  }

  // ---- History tab: chips, plus every session's results and trades (fetched on demand)

  let historyPending = false;
  let historyAgain = false;
  async function loadHistory() {
    if (!store.me) {
      $('#history').replaceChildren(h('div', { class: 'empty' }, 'Sign in to see your chips, trades and P&L from every session.'));
      return;
    }
    if (historyPending) {
      historyAgain = true;
      return;
    }
    historyPending = true;
    const res = await call('history');
    historyPending = false;
    if (res.ok) renderHistory(res);
    if (historyAgain) {
      historyAgain = false;
      setTimeout(loadHistory, 500);
    }
  }

  function renderHistory(hist) {
    const open = new Set([...document.querySelectorAll('#history details[open]')].map((d) => d.dataset.id));
    const first = !$('#history').childElementCount || !$('#history details');
    const gameTitle = (id) => store.platform.games.find((g) => g.id === id)?.title ?? id;
    const stat = (label, value, cls = '') => h('span', { class: 'stat' }, label, h('b', { class: cls }, value));
    const sessions = hist.sessions.map((s, i) => {
      const tradeCount = s.trades.length;
      const trades = [...s.trades].reverse().map((t) =>
        h('tr', {},
          h('td', { class: 'muted' }, fmtTime(t.ts)),
          h('td', {}, t.market),
          h('td', { class: t.side === 'buy' ? 'up' : 'down' }, t.side === 'buy' ? 'bought' : 'sold'),
          h('td', { class: 'num' }, t.qty),
          h('td', { class: 'num' }, t.price)));
      const results = s.results.map((r) =>
        h('tr', {},
          h('td', {}, r.market),
          h('td', { class: 'muted' }, r.status === 'settled' ? `settled ${r.settlement}` : r.status === 'recorded' ? 'points' : r.status),
          h('td', { class: `num ${sign(r.position)}` }, r.status === 'recorded' ? '' : r.position ? fmtPos(r.position) : '0'),
          h('td', { class: `num ${sign(r.pnl)}` }, fmtPnl(r.pnl))));
      const board = s.leaderboard.map((u, j) =>
        h('tr', { class: u.name === hist.name ? 'me' : '' },
          h('td', { class: 'num muted' }, j + 1), h('td', {}, u.name), h('td', { class: `num ${sign(u.pnl)}` }, fmtPnl(u.pnl))));
      const live = s.status === 'active';
      return h('details', { class: 'session', 'data-id': s.id, open: open.has(s.id) || (first && i === 0) },
        h('summary', {},
          h('span', { class: 'name' }, s.name),
          h('span', { class: `badge ${live ? 'live' : 'ended'}` }, live ? 'live' : 'ended'),
          h('span', { class: 'muted' }, `${s.gameTitle || gameTitle(s.gameId)} · ${new Date(s.startedAt).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`),
          h('span', {}, 'your P&L ', h('b', { class: sign(s.pnl) }, fmtPnl(s.pnl))),
          tradeCount ? h('span', { class: 'muted' }, `${tradeCount} trade${tradeCount === 1 ? '' : 's'}`) : ''),
        h('div', { class: 'cols' },
          h('div', {}, h('h4', {}, 'Your results'), table(['market', 'result', 'pos', 'P&L'], results, 'You did not trade in this session.')),
          h('div', {}, h('h4', {}, 'Session leaderboard'), table(['#', 'trader', 'P&L'], board, 'No trades in this session.'))),
        s.gameId === 'external' ? '' : h('div', { class: 'scroll-x' }, h('h4', {}, 'Your trades'), table(['time', 'market', 'side', 'qty', 'px'], trades, 'No trades.')));
    });
    $('#history').replaceChildren(
      h('div', { class: 'panel history-summary' },
        h('b', {}, hist.name),
        stat('game-night chips', fmtMoney(hist.cash)),
        stat('game-night equity', fmtMoney(hist.gameEquity)),
        stat('quiz', fmtMoney(hist.quiz)),
        stat('total equity', fmtMoney(hist.equity)),
        stat('all-time P&L', fmtPnl(hist.pnl), sign(hist.pnl))),
      ...(sessions.length ? sessions : [h('div', { class: 'empty' }, 'No sessions yet.')]),
    );
  }

  function setView(view) {
    store.view = view;
    for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.view === view);
    $('#view-trade').hidden = view !== 'trade';
    $('#view-history').hidden = view !== 'history';
    if (view === 'history') loadHistory();
  }
  for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => setView(tab.dataset.view));

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
          storage.del(keys.token);
          location.reload();
        } }, 'log out')),
      );
      return;
    }
    const pw = h('input', { id: 'admin-password', type: 'password', placeholder: 'Admin password', autocomplete: 'current-password' });
    const hint = h('span', { class: 'muted small' }, 'or sign in with an admin account');
    const form = h('form', { class: 'inline', onsubmit: async (e) => {
      e.preventDefault();
      const res = await call('admin:login', { password: pw.value });
      if (!res.ok) return toast(res.error, 'error');
      storage.set(keys.admin, res.adminToken);
      setAdmin(true);
    } }, pw, h('button', { type: 'submit', class: 'primary' }, 'Log in'), hint);
    $('#admin-login').replaceChildren(form);
  }

  function setAdmin(on) {
    store.isAdmin = on;
    $('#admin-btn').classList.toggle('active', on);
    document.body.classList.toggle('is-admin', on);
    renderAdminLogin();
    if (on) adminPanels.forEach(mountPanel);
    else {
      for (const p of adminPanels) {
        p.el?.remove();
        p.el = null;
      }
      store.adminState = null;
    }
    render();
  }

  // Core admin panel: start and end game-night sessions.
  registerAdminPanel({
    title: 'Session',
    order: -1, // first
    mount(el) {
      const today = new Date().toLocaleDateString([], { month: 'short', day: 'numeric' });
      const name = h('input', { placeholder: `Game night ${today}` });
      const game = h('select', { required: true }, store.platform.games.map((g) => h('option', { value: g.id }, g.title)));
      this.start = h('form', { class: 'inline', onsubmit: async (e) => {
        e.preventDefault();
        const res = await admin('startSession', { name: name.value || `Game night ${today}`, gameId: game.value });
        if (res.ok) {
          toast('Session started');
          name.value = '';
        }
      } }, name, game, h('button', { type: 'submit', class: 'primary' }, 'Start session'));
      this.liveText = h('span', {});
      this.live = h('div', { class: 'session-live' }, this.liveText, h('button', { type: 'button', class: 'small', onclick: async () => {
        if (!confirm('End this session? Open orders are cancelled and it moves to History. Settle or delete any match people still hold positions in first.')) return;
        const res = await admin('endSession');
        if (res.ok) toast('Session ended and saved to History');
      } }, 'End session'));
      el.append(this.start, this.live);
    },
    update(state) {
      const session = state.session;
      this.start.hidden = !!session;
      this.live.hidden = !session;
      if (session) {
        const game = currentGame();
        this.liveText.replaceChildren(h('b', {}, session.name), ` · ${game?.title ?? session.gameId} · started ${fmtTime(session.startedAt)}`);
      }
    },
  });

  // Core admin panel: accounts, chips and password resets.
  registerAdminPanel({
    title: 'Accounts',
    order: 1, // after game panels
    mount(el) {
      this.rows = new Map();
      this.body = h('tbody', {});
      const name = h('input', { placeholder: 'New account name' });
      el.append(
        h('div', { class: 'scroll-x' }, h(
          'table',
          { class: 'list accounts' },
          h('thead', {}, h('tr', {}, ['', 'name', 'password', 'game chips ✎', 'game equity', 'quiz ✎', 'total equity', 'game P&L', 'wagers $ ✎', ''].map((t) => h('th', {}, t)))),
          this.body,
        )),
        h('form', { class: 'inline', onsubmit: async (e) => {
          e.preventDefault();
          const res = await admin('createAccount', { name: name.value });
          if (res.ok) {
            toast(`Added account ${name.value}`);
            name.value = '';
          }
        } }, name, h('button', { type: 'submit', class: 'small' }, 'Add account')),
      );
    },
    update() {
      const accounts = store.adminState?.accounts ?? [];
      for (const [id, row] of this.rows) {
        if (!accounts.some((a) => a.id === id)) {
          row.root.remove();
          this.rows.delete(id);
        }
      }
      accounts.forEach((a, i) => {
        if (!this.rows.has(a.id)) this.rows.set(a.id, accountRow(a));
        const row = this.rows.get(a.id);
        if (this.body.children[i] !== row.root) this.body.insertBefore(row.root, this.body.children[i] ?? null);
        row.dot.className = `dot ${a.online ? 'on' : ''}`;
        row.dot.title = a.online ? 'Online' : 'Offline';
        row.pw.textContent = a.hasPassword ? 'set' : 'not yet';
        if (!row.cash.editing) row.cash.textContent = fmtMoney(a.cash);
        row.gameEquity.textContent = fmtMoney(a.gameEquity);
        if (!row.quiz.editing) row.quiz.textContent = fmtMoney(a.quiz);
        row.equity.textContent = fmtMoney(a.equity);
        row.pnl.textContent = fmtPnl(a.pnl);
        row.pnl.className = `num ${sign(a.pnl)}`;
        if (!row.wager.editing) {
          row.wager.textContent = a.wagerBalance ? fmtUsd(a.wagerBalance) : '–';
          row.wager.className = `num editable ${sign(a.wagerBalance)}`;
        }
        row.account = a;
        row.reset.disabled = !a.hasPassword || a.admin;
        row.reset.title = a.admin ? 'Admin account: its password is ADMIN_PASSWORD' : '';
      });
    },
  });

  function accountRow(a) {
    const r = { account: a };
    r.dot = h('span', { class: 'dot' });
    r.pw = h('td', { class: 'muted' });
    r.cash = editableCell('Click to set game-night chips', () => r.account.cash, async (value) => {
      const res = await admin('setBankroll', { userId: a.id, amount: value });
      if (res.ok) toast(`${a.name} now has ${value} game-night chips`);
    });
    r.gameEquity = h('td', { class: 'num' });
    r.quiz = editableCell('Click to set quiz points', () => r.account.quiz, async (value) => {
      const res = await admin('setQuiz', { userId: a.id, amount: value });
      if (res.ok) toast(`${a.name} now has ${value} quiz points`);
    });
    r.equity = h('td', { class: 'num total' });
    r.pnl = h('td', { class: 'num' });
    r.wager = editableCell('Click to set the open wager balance ($)', () => r.account.wagerBalance, async (value) => {
      const res = await admin('setWagerBalance', { userId: a.id, amount: value });
      if (res.ok) toast(`${a.name}'s open wagers are now ${fmtUsd(value)}`);
    });
    r.reset = h('button', { type: 'button', class: 'small', onclick: async () => {
      if (!confirm(`Reset ${a.name}'s password? They will be signed out and choose a new one at their next sign-in.`)) return;
      const res = await admin('resetPassword', { userId: a.id });
      if (res.ok) toast(`${a.name}'s password was reset`);
    } }, 'Reset password');
    r.root = h('tr', {}, h('td', {}, r.dot), h('td', {}, a.name), r.pw, r.cash, r.gameEquity, r.quiz, r.equity, r.pnl, r.wager, h('td', {}, r.reset));
    return r;
  }

  /** A table cell that turns into a number input when clicked. Enter saves, Escape or clicking away cancels. */
  function editableCell(title, current, save) {
    const td = h('td', { class: 'num editable', title });
    td.addEventListener('click', () => {
      if (td.editing) return;
      td.editing = true;
      const input = h('input', { type: 'number', step: 'any', value: current() });
      const done = () => {
        td.editing = false;
        render();
      };
      input.addEventListener('keydown', async (e) => {
        if (e.key === 'Escape') return done();
        if (e.key !== 'Enter') return;
        if (input.value === '') return toast('Enter a number', 'error');
        const value = Number(input.value);
        td.editing = false; // let the update show the saved value
        await save(value);
        render();
      });
      input.addEventListener('blur', () => td.editing && done());
      td.replaceChildren(input);
      input.focus();
      input.select();
    });
    return td;
  }

  // Core admin panel: real-money wagers, tracked per account and settled up at the end.
  registerAdminPanel({
    title: 'Wagers ($)',
    order: 2,
    mount(el) {
      this.who = h('select', { required: true });
      this.whoKey = '';
      const amount = h('input', { type: 'number', step: '0.01', class: 'price', placeholder: '$ amount', style: 'width:110px', required: true });
      const note = h('input', { placeholder: 'What for, e.g. Game 3 vs Paul' });
      this.owed = h('div', {});
      this.recent = h('div', { class: 'scroll-x' });
      el.append(
        h('form', { class: 'inline', onsubmit: async (e) => {
          e.preventDefault();
          const res = await admin('addWager', { userId: this.who.value, amount: Number(amount.value), note: note.value });
          if (res.ok) {
            toast('Wager recorded');
            amount.value = '';
            note.value = '';
          }
        } }, this.who, amount, note, h('button', { type: 'submit', class: 'primary' }, 'Record')),
        h('p', { class: 'muted small' }, 'Positive = they won / are owed, negative = they lost / owe. Mark paid once the money changes hands.'),
        this.owed,
        this.recent,
      );
    },
    update() {
      const accounts = store.adminState?.accounts ?? [];
      const wagers = store.adminState?.wagers ?? [];
      const key = accounts.map((a) => a.id + a.name).join();
      if (key !== this.whoKey) {
        this.whoKey = key;
        const prev = this.who.value;
        this.who.replaceChildren(h('option', { value: '' }, 'Account…'), accounts.map((a) => h('option', { value: a.id }, a.name)));
        this.who.value = prev;
      }
      const open = accounts.filter((a) => wagers.some((w) => w.userId === a.id && !w.paid));
      this.owed.replaceChildren(
        open.length
          ? h('div', { class: 'settle-up' }, h('b', {}, 'Settle up: '), open.map((a) =>
              h('span', { class: 'chip' }, a.name, ' ', h('b', { class: sign(a.wagerBalance) }, fmtUsd(a.wagerBalance)), ' ',
                h('button', { type: 'button', class: 'link', onclick: async () => {
                  if (confirm(`Mark all of ${a.name}'s open wagers (${fmtUsd(a.wagerBalance)}) as paid?`)) admin('markWagersPaid', { userId: a.id });
                } }, 'mark paid'))))
          : h('p', { class: 'muted small' }, 'Nothing to settle.'),
      );
      const rows = wagers.slice(-15).reverse().map((w) =>
        h(
          'tr',
          { class: w.paid ? 'paid' : '' },
          h('td', { class: 'muted' }, fmtTime(w.ts)),
          h('td', {}, w.name),
          h('td', {}, w.note || '–'),
          h('td', { class: `num ${sign(w.amount)}` }, fmtUsd(w.amount)),
          h('td', { class: 'muted' }, w.paid ? 'paid' : 'open'),
          h('td', {}, h('button', { type: 'button', class: 'link', title: 'Delete entry', onclick: () => {
            if (confirm(`Delete ${w.name}'s ${fmtUsd(w.amount)} entry?`)) admin('deleteWager', { wagerId: w.id });
          } }, '✕')),
        ),
      );
      this.recent.replaceChildren(rows.length ? table(['time', 'account', 'for', '$', '', ''], rows, '') : '');
    },
  });

  // Core admin panel: list a standalone market. Games usually add a friendlier panel of their own.
  registerAdminPanel({
    title: 'New market',
    order: 3,
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
    get adminState() { return store.adminState; },
    get platform() { return store.platform; },
  };
  window.Exchange = api;

  async function boot() {
    store.platform = await fetch('/platform.json').then((r) => r.json());
    const ns = `xchg:${store.platform.id}`;
    keys = { token: `${ns}:token`, admin: `${ns}:admin`, lastName: `${ns}:name` };
    // keep people signed in from before the platform was renamed
    for (const k of ['token', 'name']) {
      const old = storage.get(`xchg:smash:${k}`);
      if (old && !storage.get(`${ns}:${k}`)) storage.set(`${ns}:${k}`, old);
    }
    document.title = store.platform.title;
    $('#title').textContent = store.platform.title;
    $('#join-title').textContent = store.platform.title;
    $('#join-rules').textContent = 'Sign in to trade, and to see your chips, trades and P&L from every session.';
    $('#rules-btn').hidden = true;
    renderAdminLogin();
    if (isAdminPage) $('#admin').hidden = false;
    for (const src of store.platform.scripts) document.body.append(h('script', { src }));
    socket.connect();
  }

  boot();
})();
