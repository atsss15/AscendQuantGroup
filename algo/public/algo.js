/* global CodeMirror */
/** Ascend Algo client: code editor, backtests, submissions, results, market data, admin controls. */
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
    for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }

  /** replaceChildren that accepts nested arrays and skips empty values. */
  const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((c) => c != null && c !== false && c !== ''));

  const storage = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };
  // shared with the exchange, so signing in on either page signs you in on both
  const TOKEN_KEY = 'xchg:ascend:token';

  function toast(msg, kind = 'info') {
    const el = h('div', { class: `toast ${kind}` }, msg);
    $('#toasts').append(el);
    setTimeout(() => el.classList.add('out'), 3500);
    setTimeout(() => el.remove(), 4000);
  }

  async function api(method, url, body) {
    const res = await fetch(`/algo/api${url}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${storage.get(TOKEN_KEY) ?? ''}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      showLogin();
      throw new Error(data.error ?? 'Please sign in');
    }
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
    return data;
  }
  const fileUrl = (url) => `/algo/api${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(storage.get(TOKEN_KEY) ?? '')}`;

  const fmt = (n, d = 2) => (n == null ? '–' : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
  const signed = (n) => (n == null ? '–' : `${n > 0 ? '+' : ''}${fmt(n)}`);
  const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
  const time = (ts) => (ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  // data days: bots only, released for study; practice days: everyone trades but it doesn't count
  const dayLabel = (d) => (d.practice ? `Data day ${d.day}` : `Day ${d.day}${d.counts === false ? ' (practice)' : ''}`);

  function table(head, rows, empty, numCols = []) {
    if (!rows.length) return h('p', { class: 'muted small' }, empty);
    return h('div', { class: 'scroll-x' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, head.map((t, i) => h('th', { class: numCols.includes(i) ? 'num' : '' }, t)))),
      h('tbody', {}, rows)));
  }

  // ------------------------------------------------------------------ state

  const store = { me: null, admin: null, editor: null, dirty: false, saving: null, md: { day: null, product: null, data: new Map() } };

  // ------------------------------------------------------------------ sign in

  async function showLogin() {
    $('#login').hidden = false;
    try {
      const { names } = await fetch('/algo/api/accounts').then((r) => r.json());
      const sel = $('#login-name');
      if (!sel.options.length) fill(sel, h('option', { value: '' }, 'Who are you?'), names.map((n) => h('option', { value: n }, n)));
    } catch { /* offline */ }
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('/algo/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: $('#login-name').value, password: $('#login-password').value }),
      }).then((r) => r.json());
      if (res.error) throw new Error(res.error);
      storage.set(TOKEN_KEY, res.token);
      $('#login').hidden = true;
      $('#login-password').value = '';
      if (res.firstSignIn) toast('Password saved. Use it next time (on the exchange too).');
      await load(true);
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });

  $('#signout').addEventListener('click', () => {
    storage.del(TOKEN_KEY);
    location.reload();
  });

  // ------------------------------------------------------------------ editor

  function setupEditor(code) {
    const host = $('#editor-host');
    if (window.CodeMirror) {
      store.editor = CodeMirror(host, {
        value: code,
        mode: 'python',
        theme: 'material-darker',
        lineNumbers: true,
        indentUnit: 4,
        tabSize: 4,
        indentWithTabs: false,
        matchBrackets: true,
        extraKeys: {
          Tab: (cm) => (cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('    ', 'end')),
          'Shift-Tab': (cm) => cm.indentSelection('subtract'),
          'Cmd-S': () => saveDraft(),
          'Ctrl-S': () => saveDraft(),
        },
      });
      store.editor.on('change', onEdit);
    } else {
      // CDN unavailable: plain textarea
      const ta = h('textarea', { class: 'fallback', spellcheck: false, value: code });
      ta.addEventListener('input', onEdit);
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end');
          onEdit();
        }
      });
      host.append(ta);
      store.editor = { getValue: () => ta.value, setValue: (v) => (ta.value = v) };
    }
  }

  const code = () => store.editor.getValue();

  let saveTimer = null;
  function onEdit() {
    store.dirty = true;
    $('#save-state').textContent = 'unsaved changes';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 1500);
  }

  async function saveDraft() {
    clearTimeout(saveTimer);
    if (!store.dirty) return;
    store.dirty = false;
    try {
      const d = await api('PUT', '/draft', { code: code() });
      $('#save-state').textContent = `saved ${new Date(d.savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    } catch (err) {
      store.dirty = true;
      $('#save-state').textContent = `not saved: ${err.message}`;
    }
  }
  window.addEventListener('beforeunload', (e) => {
    if (store.dirty) e.preventDefault();
  });

  $('#reset-template').addEventListener('click', () => {
    if (!confirm('Replace your code with the starting template? (Your submitted code is not affected.)')) return;
    store.editor.setValue(store.me.template);
    onEdit();
  });

  $('#download-code').addEventListener('click', () => {
    const a = h('a', { href: URL.createObjectURL(new Blob([code()], { type: 'text/x-python' })), download: 'trader.py' });
    document.body.append(a);
    a.click();
    a.remove();
  });

  // ------------------------------------------------------------------ backtest + submit

  $('#bt-run').addEventListener('click', async () => {
    const day = $('#bt-day').value;
    if (day === '') return toast('No data to backtest on yet', 'error');
    const btn = $('#bt-run');
    btn.disabled = true;
    btn.textContent = 'Running…';
    fill($('#bt-output'), h('p', { class: 'muted' }, 'Running your algorithm through the day…'));
    saveDraft();
    try {
      renderBacktest(await api('POST', '/backtest', { code: code(), day: Number(day) }));
    } catch (err) {
      fill($('#bt-output'), h('pre', { class: 'log err' }, err.message));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Run backtest';
    }
  });

  function renderBacktest(r) {
    const products = Object.entries(r.byProduct ?? {}).map(([s, v]) =>
      h('tr', {}, h('td', {}, s), h('td', { class: `num ${cls(v.pnl)}` }, signed(v.pnl)), h('td', { class: 'num' }, v.position), h('td', { class: 'num' }, v.volume)));
    fill($('#bt-output'), 
      h('div', { class: 'toolbar' },
        h('span', { class: `pnl-big ${cls(r.pnl)}` }, signed(r.pnl)),
        h('span', { class: 'muted' }, `P&L on ${dayLabel(store.me.days.find((d) => d.day === r.day) ?? { day: r.day })} · ran in ${r.seconds.toFixed(1)}s`)),
      table(['product', 'P&L', 'end position', 'volume'], products, '', [1, 2, 3]),
      r.rejected ? h('p', { class: 'muted small' }, `${r.rejected} order batches were rejected for breaking position limits.`) : '',
      r.errors?.length ? [h('h3', {}, 'Errors'), h('pre', { class: 'log err' }, r.errors.join('\n'))] : '',
      r.logs?.length ? [h('h3', {}, 'Your prints (last 200)'), h('pre', { class: 'log' }, r.logs.join('\n'))] : '',
    );
  }

  $('#submit').addEventListener('click', async () => {
    const me = store.me;
    if (!confirm(`Submit this code for Day ${me.nextDay}? It replaces any earlier submission and runs when the admin simulates the day.`)) return;
    try {
      await saveDraft();
      const s = await api('POST', '/submit', { code: code() });
      toast(`Submitted for Day ${s.forDay}`);
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // ------------------------------------------------------------------ results

  function renderResults() {
    const me = store.me;
    const comp = me.days.filter((d) => !d.practice);
    let cum = 0;
    const mine = comp.map((d) => {
      if (d.counts) cum += d.mine?.pnl ?? 0;
      return h('tr', {},
        h('td', {}, dayLabel(d)),
        h('td', { class: `num ${cls(d.mine?.pnl)}` }, d.entered ? signed(d.mine?.pnl) : 'no entry'),
        h('td', { class: `num ${cls(cum)}` }, d.counts ? signed(cum) : h('span', { class: 'muted small' }, 'not counted')),
        h('td', { class: 'muted small' }, d.mine?.errors?.length ? `${d.mine.errors.length} errors` : ''),
        h('td', {}, d.entered ? [h('a', { href: fileUrl(`/days/${d.day}/own.csv`) }, 'trades'), ' ', h('a', { href: fileUrl(`/days/${d.day}/log.txt`) }, 'log')] : ''));
    });
    const latest = me.latestDay;
    const latestRows = (latest?.results ?? []).map((r, i) => h('tr', { class: r.name === me.name ? 'me' : '' },
      h('td', { class: 'num muted' }, i + 1), h('td', {}, r.name), h('td', { class: `num ${cls(r.pnl)}` }, signed(r.pnl))));
    const board = me.leaderboard.map((r, i) => h('tr', { class: r.name === me.name ? 'me' : '' },
      h('td', { class: 'num muted' }, i + 1), h('td', {}, r.name), h('td', { class: `num ${cls(r.total)}` }, signed(r.total))));
    fill($('#results'),
      me.practiceMode ? h('p', { class: 'small', style: 'color:var(--amber)' }, 'Practice week: days run as normal, but results don’t count toward the leaderboard yet.') : '',
      h('h3', {}, 'Your days'),
      table(['day', 'P&L', 'total', '', ''], mine, 'No competition days have run yet.', [1, 2]),
      latest ? [h('h3', {}, `${dayLabel({ day: latest.day, counts: latest.counts })} standings`), table(['#', 'player', 'P&L'], latestRows, '', [0, 2])] : '',
      h('h3', {}, 'Leaderboard'),
      table(['#', 'player', 'total P&L'], board, me.practiceMode ? 'Nothing counts yet: it’s the practice week.' : 'The leaderboard fills in after the first day that counts.', [0, 2]),
    );
  }

  // ------------------------------------------------------------------ market data

  async function loadDay(day) {
    if (store.md.data.has(day)) return store.md.data.get(day);
    const text = await fetch(fileUrl(`/days/${day}/prices.csv`)).then((r) => {
      if (!r.ok) throw new Error('Could not load prices');
      return r.text();
    });
    const [head, ...lines] = text.trim().split('\n');
    const cols = head.split(';');
    const byProduct = {};
    for (const line of lines) {
      const v = line.split(';');
      const row = Object.fromEntries(cols.map((c, i) => [c, v[i]]));
      (byProduct[row.product] ??= []).push(row);
    }
    store.md.data.set(day, byProduct);
    return byProduct;
  }

  async function renderMarket() {
    const day = store.md.day;
    const dl = $('#md-downloads');
    if (day == null) {
      fill(dl, h('span', { class: 'muted small' }, 'No data released yet.'));
      return;
    }
    const info = store.me.days.find((d) => d.day === day);
    fill(dl, 
      h('a', { href: fileUrl(`/days/${day}/prices.csv`) }, 'prices.csv'),
      h('a', { href: fileUrl(`/days/${day}/trades.csv`) }, 'trades.csv'),
      info?.entered ? h('a', { href: fileUrl(`/days/${day}/own.csv`) }, 'my trades.csv') : '',
    );
    let data;
    try {
      data = await loadDay(day);
    } catch (err) {
      return toast(err.message, 'error');
    }
    const products = Object.keys(data);
    if (!products.includes(store.md.product)) store.md.product = products[0];
    fill($('#md-products'), ...products.map((p) => h('button', {
      type: 'button',
      class: p === store.md.product ? 'active' : '',
      onclick: () => { store.md.product = p; renderMarket(); },
    }, p)));
    const rows = data[store.md.product] ?? [];
    const slider = $('#md-slider');
    slider.max = Math.max(rows.length - 1, 0);
    if (Number(slider.value) > rows.length - 1) slider.value = 0;
    drawChart(rows, Number(slider.value));
    renderBook(rows[Number(slider.value)]);
  }

  $('#md-slider').addEventListener('input', () => {
    const rows = store.md.data.get(store.md.day)?.[store.md.product] ?? [];
    drawChart(rows, Number($('#md-slider').value));
    renderBook(rows[Number($('#md-slider').value)]);
  });
  $('#md-day').addEventListener('change', () => {
    store.md.day = Number($('#md-day').value);
    renderMarket();
  });

  function drawChart(rows, cursor) {
    const canvas = $('#chart');
    const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
    const hgt = (canvas.height = 220 * devicePixelRatio);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, hgt);
    const series = (key) => rows.map((r) => (r[key] === '' ? null : Number(r[key])));
    const mid = series('mid_price');
    const bid = series('bid_price_1');
    const ask = series('ask_price_1');
    const all = [...bid, ...ask, ...mid].filter((v) => v != null);
    if (!all.length) return;
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const pad = 28 * devicePixelRatio;
    const x = (i) => pad + ((w - pad - 8) * i) / Math.max(rows.length - 1, 1);
    const y = (v) => hgt - 16 * devicePixelRatio - ((hgt - 30 * devicePixelRatio) * (v - lo)) / (hi - lo || 1);
    const line = (vals, color, width) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width * devicePixelRatio;
      ctx.beginPath();
      let started = false;
      vals.forEach((v, i) => {
        if (v == null) return (started = false);
        if (!started) ctx.moveTo(x(i), y(v));
        else ctx.lineTo(x(i), y(v));
        started = true;
      });
      ctx.stroke();
    };
    line(bid, 'rgba(63,185,80,0.35)', 1);
    line(ask, 'rgba(248,81,73,0.35)', 1);
    line(mid, '#58a6ff', 1.5);
    ctx.fillStyle = '#8b949e';
    ctx.font = `${10 * devicePixelRatio}px system-ui`;
    ctx.fillText(fmt(hi, 1), 2, 12 * devicePixelRatio);
    ctx.fillText(fmt(lo, 1), 2, hgt - 4 * devicePixelRatio);
    ctx.strokeStyle = 'rgba(210,153,34,0.8)';
    ctx.lineWidth = devicePixelRatio;
    ctx.beginPath();
    ctx.moveTo(x(cursor), 0);
    ctx.lineTo(x(cursor), hgt);
    ctx.stroke();
  }

  function renderBook(row) {
    $('#md-ts').textContent = row ? `t=${row.timestamp} · mid ${row.mid_price || '–'}` : '';
    if (!row) return fill($('#md-book'), );
    const side = (kind) => [1, 2, 3]
      .filter((i) => row[`${kind}_price_${i}`] !== '')
      .map((i) => h('tr', {}, h('td', { class: `num ${kind === 'bid' ? 'up' : 'down'}` }, row[`${kind}_price_${i}`]), h('td', { class: 'num' }, row[`${kind}_volume_${i}`])));
    fill($('#md-book'), h('div', { class: 'book' },
      table(['bid', 'size'], side('bid'), 'no bids', [0, 1]),
      table(['ask', 'size'], side('ask'), 'no asks', [0, 1])));
  }

  // ------------------------------------------------------------------ admin

  async function renderAdmin() {
    const box = $('#admin-area');
    if (!store.me?.isAdmin) return (box.hidden = true);
    box.hidden = false;
    let a;
    try {
      a = store.admin = await api('GET', '/admin');
    } catch (err) {
      return fill(box, h('p', { class: 'error' }, err.message));
    }
    const running = a.running;
    const deadline = h('input', { value: a.deadline ?? '', placeholder: 'e.g. Submit by 11:59 PM each day', style: 'width:280px' });
    const subs = a.submissions.map((s) => h('tr', {},
      h('td', {}, s.name),
      h('td', {}, time(s.submittedAt)),
      h('td', { class: 'num' }, s.lines),
      h('td', {}, h('a', { href: fileUrl(`/admin/submissions/${s.userId}`), target: '_blank' }, 'view code'))));
    const days = [...a.days].reverse().map((d) => h('details', {},
      h('summary', {}, `${dayLabel(d)} · ran ${time(d.ranAt)} · ${d.trades} trades`, d.results.length ? ` · ${d.results.length} players` : ''),
      d.results.length ? table(['player', 'P&L', 'errors', '', ''], d.results.map((r) => h('tr', {},
        h('td', {}, r.name),
        h('td', { class: `num ${cls(r.pnl)}` }, signed(r.pnl)),
        h('td', { class: 'small muted', title: r.firstError ?? '' }, r.errors ? `${r.errors}: ${(r.firstError ?? '').slice(0, 80)}` : ''),
        h('td', {}, h('a', { href: fileUrl(`/admin/days/${d.day}/code/${r.userId}`), target: '_blank' }, 'code')),
        h('td', {}, h('a', { href: fileUrl(`/admin/days/${d.day}/log/${r.userId}`), target: '_blank' }, 'log')))), '', [1]) : '',
      d.practice ? '' : h('button', { type: 'button', class: 'small', onclick: async () => {
        try {
          await api('POST', `/admin/days/${d.day}/counts`, { counts: !d.counts });
          toast(d.counts ? `Day ${d.day} no longer counts` : `Day ${d.day} now counts toward the leaderboard`);
          load();
        } catch (err) {
          toast(err.message, 'error');
        }
      } }, d.counts ? 'Make it practice (don’t count)' : 'Count this day'),
      ' ',
      h('button', { type: 'button', class: 'small danger', onclick: async () => {
        if (!confirm(`Delete ${dayLabel(d)} (its data and results)?${d.practice ? '' : ' You can then run it again.'}`)) return;
        try {
          await api('DELETE', `/admin/days/${d.day}`);
          toast(`${dayLabel(d)} deleted`);
          load();
        } catch (err) {
          toast(err.message, 'error');
        }
      } }, 'Delete this day')));

    const run = async (practice) => {
      const what = practice
        ? 'a data day (bots only, released for players to study and backtest on)'
        : `Day ${a.nextDay} with ${a.submissions.length} submitted algorithm${a.submissions.length === 1 ? '' : 's'}${a.practiceMode ? ' as a practice day (won’t count)' : ''}`;
      if (!confirm(`Simulate ${what} now? Its data and results are released to players right away.`)) return;
      try {
        await api('POST', '/admin/run', { practice });
        toast('Simulation started');
        pollAdmin();
      } catch (err) {
        toast(err.message, 'error');
      }
    };

    fill(box, 
      h('div', { class: 'toolbar' }, h('h2', {}, 'Admin'), h('span', { class: 'grow' }),
        h('span', { class: 'muted small' }, `${a.submissions.length} submissions for Day ${a.nextDay}`)),
      running
        ? h('div', {}, h('p', {}, `Simulating ${running.practice ? 'practice day' : 'Day'} ${running.day}… ${Math.round(running.progress * 100)}%`),
            h('div', { class: 'progress-bar' }, h('div', { style: `width:${Math.round(running.progress * 100)}%` })))
        : h('div', { class: 'toolbar' },
            h('button', { type: 'button', class: 'primary', onclick: () => run(false) }, `Run Day ${a.nextDay}${a.practiceMode ? ' (practice)' : ''}`),
            h('button', { type: 'button', onclick: () => run(true) }, 'Generate data day'),
            a.lastError ? h('span', { class: 'error small' }, `Last run failed: ${a.lastError}`) : ''),
      h('label', { class: 'toolbar small' },
        h('input', { type: 'checkbox', checked: a.practiceMode, onchange: async (e) => {
          await api('POST', '/admin/practice-mode', { on: e.target.checked });
          toast(e.target.checked ? 'Practice week on: new days won’t count' : 'Practice week off: new days count toward the leaderboard');
          load();
        } }),
        'Practice week: new days run normally but don’t count toward the leaderboard'),
      h('div', { class: 'toolbar' },
        h('span', { class: 'muted small' }, 'Deadline shown to players:'), deadline,
        h('button', { type: 'button', class: 'small', onclick: async () => {
          await api('POST', '/admin/deadline', { text: deadline.value });
          toast('Deadline updated');
          load();
        } }, 'Save')),
      h('details', {}, h('summary', {}, `Submissions (${a.submissions.length})`), table(['player', 'submitted', 'lines', ''], subs, 'Nobody has submitted yet.', [2])),
      h('details', {}, h('summary', {}, `Days (${a.days.length})`), days.length ? days : h('p', { class: 'muted small' }, 'No days yet. Generate data days so players have data to start with.')),
    );
  }

  let pollTimer = null;
  function pollAdmin() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      await load();
      if (store.admin?.running) pollAdmin();
    }, 1000);
  }

  // ------------------------------------------------------------------ load

  async function load(first = false) {
    let me;
    try {
      me = store.me = await api('GET', '/me');
    } catch {
      return;
    }
    $('#comp-name').textContent = `· ${me.competition}`;
    $('#who').textContent = me.isAdmin ? `${me.name} (admin)` : me.name;
    $('#signout').hidden = false;
    fill($('#day-status'), 
      me.running ? h('span', {}, `Simulating ${me.running.practice ? 'practice day' : `Day ${me.running.day}`}…`) : h('span', {}, 'Submissions open for ', h('b', {}, `Day ${me.nextDay}`)),
      me.deadline ? ` · ${me.deadline}` : '',
      me.practiceMode ? h('span', { style: 'color:var(--amber)' }, ' · practice week') : '');
    $('#submit').textContent = `Submit for Day ${me.nextDay}`;
    fill($('#submit-state'), me.submission
      ? h('span', { class: 'up' }, `Submitted ${time(me.submission.submittedAt)} ✓`)
      : h('span', { class: 'muted' }, 'Not submitted yet'));

    if (first) {
      setupEditor(me.draft.code);
      $('#save-state').textContent = me.draft.savedAt ? `saved ${time(me.draft.savedAt)}` : 'starting template';
      renderHowto(me);
    }
    // day pickers
    const released = [...me.days].reverse();
    for (const sel of [$('#bt-day'), $('#md-day')]) {
      const prev = sel.value;
      fill(sel, ...released.map((d) => h('option', { value: d.day }, dayLabel(d))));
      if (released.some((d) => String(d.day) === prev)) sel.value = prev;
    }
    if (!released.length) fill($('#bt-day'), h('option', { value: '' }, 'no data yet'));
    if (store.md.day == null || !released.some((d) => d.day === store.md.day)) store.md.day = released[0]?.day ?? null;
    $('#md-day').value = store.md.day ?? '';

    renderResults();
    renderMarket();
    renderAdmin();
  }

  function renderHowto(me) {
    const limits = me.products.map((p) => `${p.symbol} ±${p.limit}`).join(', ');
    fill($('#howto'), 
      h('p', {}, 'Write a ', h('code', {}, 'Trader'), ' class with a ', h('code', {}, 'run(self, state)'), ' method, the same interface as IMC Prosperity. It is called every tick with a ', h('code', {}, 'TradingState'),
        ' (order depths, your position, your fills and the market\'s trades since last tick) and returns ', h('code', {}, '(orders_by_product, conversions, traderData)'), '.'),
      h('p', {}, `A day has ${me.ticks} ticks. Position limits: ${limits}. If your orders for a product could take you past its limit, all of them are rejected for that tick. Each call must finish within ${me.timeLimitMs}ms.`),
      h('p', {}, 'Matching: every algorithm acts on the same snapshot at the same time. Your orders first trade against the bots\' quotes (best price first, then shared pro-rata with everyone at the same price), orders that cross other players clear in a batch auction, and what\'s left can be hit by taker bots. All orders are cancelled at the end of the tick.'),
      h('p', {}, 'Each day the admin simulates a new day with everyone\'s latest submission trading against the bots and each other. P&L marks your position at fair value at the end of the day. That day\'s prices and trades are then released for backtesting.'),
      h('p', {}, 'Available libraries: numpy, pandas, math, statistics, json, jsonpickle, collections and other standard helpers. Files, network and system access are disabled.'),
    );
  }

  // first load; signing in later calls load(true) from the login form
  if (storage.get(TOKEN_KEY)) load(true);
  else showLogin();
  // keep panels fresh so new results show up; the editor is never overwritten
  setInterval(() => store.me && !store.admin?.running && load(), 20000);
})();
