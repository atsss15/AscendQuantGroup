/* global io */
/** Peer-ranking client: raters at /rank, organizer dashboard at /rank/admin. */
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
      else if (k === 'list') el.setAttribute(k, v); // read-only property on inputs
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

  const socket = io('/rank');
  function call(event, payload) {
    return new Promise((resolve) => {
      socket.timeout(5000).emit(event, payload, (err, res) => resolve(err ? { ok: false, error: 'Server did not respond' } : res));
    });
  }

  const score = (x) => (x == null ? '–' : (x * 100).toFixed(1));
  const grade = (x) => (x == null ? '–' : x.toFixed(1)); // grades are already 0–100
  const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
  const isAdminPage = location.pathname.replace(/\/+$/, '') === '/rank/admin';
  const KEY_TOKEN = 'rank:token';
  const KEY_ADMIN = 'rank:admin';

  const store = { ev: null, me: null, admin: null, isAdmin: false, step: 0, drafts: {} };
  const groupName = (id) => store.ev?.groups.find((g) => g.id === id)?.name ?? (id ? '?' : 'no group');

  // ------------------------------------------------------------------ socket

  socket.on('connect', async () => {
    $('#conn').classList.add('on');
    if (isAdminPage) {
      const adminToken = storage.get(KEY_ADMIN);
      if (adminToken) {
        const res = await call('admin:login', { adminToken });
        if (!res.ok) storage.del(KEY_ADMIN);
        store.isAdmin = res.ok;
      }
    } else {
      const token = storage.get(KEY_TOKEN);
      if (token) {
        const res = await call('login', { token });
        if (!res.ok) storage.del(KEY_TOKEN);
      }
    }
    render(true);
  });
  socket.on('disconnect', () => $('#conn').classList.remove('on'));

  // Only re-render when something this page shows actually changed, so typing isn't interrupted.
  let lastKey = '';
  socket.on('eval', (ev) => {
    if (store.ev?.id !== ev?.id) {
      store.step = 0;
      store.drafts = {};
    }
    store.ev = ev;
    render();
  });
  socket.on('me', (me) => {
    store.me = me;
    render();
  });
  socket.on('admin', (admin) => {
    store.admin = admin;
    render();
  });
  socket.on('signedOut', ({ reason }) => {
    storage.del(KEY_TOKEN);
    store.me = null;
    toast(reason, 'error');
    render(true);
  });

  function render(force = false) {
    const key = JSON.stringify([store.ev, store.me, store.admin, store.isAdmin, store.step, store.drafts]);
    if (!force && key === lastKey) return;
    lastKey = key;
    $('#eval-name').textContent = store.ev ? `· ${store.ev.name}` : '';
    if (isAdminPage) renderAdmin();
    else renderRater();
  }

  // ------------------------------------------------------------------ rater page

  // Rankings are drafts on this device (kept across refreshes) until the rater presses Submit.
  const draftKey = () => `rank:draft:${store.ev.id}:${store.me.id}`;
  function loadDrafts() {
    if (store.draftsFor === draftKey()) return;
    store.draftsFor = draftKey();
    try {
      store.drafts = JSON.parse(storage.get(draftKey()) ?? 'null') ?? {};
    } catch {
      store.drafts = {};
    }
  }
  const draftFor = (c) => store.drafts[c.id] ?? store.me.rankings[c.id] ?? [];
  const isComplete = (c) => draftFor(c).length === store.me.eligible.length;
  const sameOrder = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

  function renderRater() {
    const app = $('#app');
    const ev = store.ev;
    const me = store.me;
    $('#who').replaceChildren(
      me ? h('span', {}, h('b', {}, me.name), h('span', { class: 'muted' }, ` · ${groupName(me.groupId)}`)) : '',
      me ? h('button', { type: 'button', class: 'ghost small', onclick: signOut }, 'Sign out') : '',
    );
    if (!ev) return app.replaceChildren(h('div', { class: 'empty' }, 'No ranking is set up right now. This page updates automatically.'));
    if (!me) return app.replaceChildren(loginCard(ev));
    loadDrafts();

    const criteria = ev.criteria;
    store.step = Math.min(store.step, criteria.length - 1);
    const open = ev.status === 'open';
    const done = criteria.filter(isComplete).length;
    app.replaceChildren(
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { class: 'grow' }, ev.name), statusPill(ev)),
        h('p', { class: 'muted' }, me.groupId
          ? `You're in ${groupName(me.groupId)}, so you rank the other ${me.eligible.length} groups.`
          : `You're not in a group, so you rank all ${me.eligible.length} groups.`),
        h('p', {}, 'Rank each category, moving back and forth as much as you like. Nothing is sent until you press ', h('b', {}, 'Submit'), '.'),
        howScored(ev)),
      ev.status === 'draft' ? h('div', { class: 'card' }, h('p', {}, 'Ranking hasn’t opened yet. You can start ranking now; Submit unlocks when it opens.')) : '',
      h('div', { class: 'steps' }, criteria.map((c, i) =>
        h('button', { type: 'button', class: `step ${i === store.step ? 'active' : ''} ${isComplete(c) ? 'done' : ''}`, onclick: () => { store.step = i; render(); } }, c.name))),
      editor(ev, me, criteria[store.step]),
      submitPanel(ev, me, done),
      ev.published ? resultsForRater(ev, me) : '',
    );
  }

  function submitPanel(ev, me, done) {
    const criteria = ev.criteria;
    const all = done === criteria.length;
    const submitted = !!me.submittedAt;
    const changed = criteria.some((c) => !sameOrder(draftFor(c), me.rankings[c.id]));
    const at = submitted ? new Date(me.submittedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    if (ev.status === 'closed') {
      return h('div', { class: 'card' }, h('p', {}, submitted ? `Ranking is closed. Your rankings submitted at ${at} are final.` : 'Ranking is closed. You didn’t submit in time.'));
    }
    let message;
    if (!all) message = h('span', { class: 'hint' }, `${done} of ${criteria.length} categories ranked. Rank them all, then submit.`);
    else if (submitted && !changed) message = h('span', { class: 'saved' }, `Submitted ✓ at ${at}. You can still change rankings and submit again until ranking closes.`);
    else if (submitted) message = h('span', { class: 'unsaved' }, 'You changed your rankings. Submit again to update them.');
    else message = h('span', { class: 'hint' }, 'All categories ranked. Submit when you’re happy with them.');
    return h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('span', { class: 'grow' }, message),
        h('button', {
          type: 'button',
          class: 'primary',
          disabled: !all || ev.status !== 'open' || (submitted && !changed),
          onclick: submit,
        }, submitted ? 'Submit changes' : 'Submit rankings')));
  }

  async function submit() {
    const rankings = Object.fromEntries(store.ev.criteria.map((c) => [c.id, draftFor(c)]));
    const res = await call('submit', { rankings });
    if (!res.ok) return toast(res.error, 'error');
    storage.del(draftKey());
    store.drafts = {};
    store.me.rankings = rankings;
    store.me.submittedAt = Date.now();
    toast('Submitted ✓ Your rankings are in.');
    render(true);
  }

  function loginCard(ev) {
    const name = h('input', { class: 'big-input', placeholder: 'Your name', autocomplete: 'name', maxLength: 40, list: ev.roster.length ? 'roster-names' : null });
    const group = ev.roster.length
      ? null
      : h('select', { class: 'big-input' }, h('option', { value: '' }, 'Which group are you in?'), ev.groups.map((g) => h('option', { value: g.id }, g.name)), h('option', { value: 'none' }, 'None (not in a group)'));
    const error = h('p', { class: 'error' });
    const form = h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      const res = await call('login', { name: name.value, groupId: group?.value });
      if (!res.ok) {
        error.textContent = res.error;
        return;
      }
      storage.set(KEY_TOKEN, res.token);
      toast(`Welcome, ${res.name}`);
    } },
    h('h2', {}, ev.name),
    h('p', { class: 'muted' }, 'Rank each group’s presentation in every rubric category. Enter your name to start.'),
    name,
    ev.roster.length ? h('datalist', { id: 'roster-names' }, ev.roster.map((n) => h('option', { value: n }))) : '',
    group,
    h('button', { type: 'submit', class: 'primary' }, 'Start'),
    error);
    setTimeout(() => name.focus());
    return form;
  }

  function howScored(ev) {
    const a = Math.round(ev.alpha * 100);
    return h('details', { class: 'how' }, h('summary', {}, 'How grades work'),
      h('ul', {},
        h('li', {}, `${a}% of a group’s grade comes from how the other raters rank its presentation. You never rank your own group, so your rankings can’t change your own group’s score.`),
        h('li', {}, `${100 - a}% comes from evaluation accuracy: for every pair of groups you ordered, we check how often raters from other groups ordered that pair the same way. Your teammates aren’t counted.`),
        h('li', {}, 'So the best strategy is to rank what you honestly think everyone saw. Unranked categories count as 0 agreement.')));
  }

  function statusPill(ev) {
    const label = { draft: 'not open yet', open: 'open', closed: 'closed' }[ev.status];
    return h('span', { class: `pill ${ev.status}` }, label);
  }

  function editor(ev, me, c) {
    const editable = ev.status !== 'closed';
    const draft = editable ? draftFor(c) : me.rankings[c.id] ?? [];
    const complete = draft.length === me.eligible.length;
    const prev = store.step > 0 ? ev.criteria[store.step - 1] : null;
    const prevRanking = prev && isComplete(prev) ? draftFor(prev) : null;

    const set = (next) => {
      store.drafts[c.id] = next;
      storage.set(draftKey(), JSON.stringify(store.drafts));
      render();
    };
    const move = (i, d) => {
      const next = [...draft];
      [next[i], next[i + d]] = [next[i + d], next[i]];
      set(next);
    };

    const status = !editable
      ? h('span', { class: 'hint' }, draft.length ? 'Your submitted ranking' : 'Not submitted')
      : complete
        ? h('span', { class: 'saved' }, 'Ranked ✓')
        : h('span', { class: 'hint' }, draft.length ? `Tap the remaining ${me.eligible.length - draft.length}.` : 'Tap the groups from best to worst.');

    return h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, c.name), h('span', { class: 'muted' }, `${c.weight}%`)),
      c.description ? h('p', { class: 'muted' }, c.description) : '',
      h('div', { class: 'ranked' }, draft.map((g, i) =>
        h('div', { class: 'ranked-item' },
          h('span', { class: 'num' }, i + 1),
          h('span', { class: 'name' }, groupName(g)),
          editable ? [
            h('button', { type: 'button', class: 'small', disabled: i === 0, onclick: () => move(i, -1), 'aria-label': 'Move up' }, '↑'),
            h('button', { type: 'button', class: 'small', disabled: i === draft.length - 1, onclick: () => move(i, 1), 'aria-label': 'Move down' }, '↓'),
            h('button', { type: 'button', class: 'small', onclick: () => set(draft.filter((x) => x !== g)), 'aria-label': 'Remove' }, '✕'),
          ] : ''))),
      editable && !complete ? h('p', { class: 'hint' }, draft.length ? `Tap your #${draft.length + 1}:` : 'Tap your #1 (best):') : '',
      editable && !complete ? h('div', { class: 'pool' }, me.eligible.filter((g) => !draft.includes(g)).map((g) =>
        h('button', { type: 'button', onclick: () => set([...draft, g]) }, groupName(g)))) : '',
      h('div', { class: 'row' },
        status,
        h('span', { class: 'grow' }),
        editable && !draft.length && prevRanking ? h('button', { type: 'button', class: 'small', onclick: () => set([...prevRanking]) }, `Copy order from ${prev.name}`) : '',
        editable && draft.length ? h('button', { type: 'button', class: 'small', onclick: () => set([]) }, 'Clear') : '',
        store.step > 0 ? h('button', { type: 'button', onclick: () => { store.step--; render(); } }, '← Back') : '',
        store.step < ev.criteria.length - 1 ? h('button', { type: 'button', class: complete ? 'primary' : '', onclick: () => { store.step++; render(); } }, 'Next →') : ''));
  }

  function resultsForRater(ev, me) {
    const rows = ev.results.map((g) => h('tr', { class: g.id === me.groupId ? 'me' : '' },
      h('td', { class: 'num' }, g.rank), h('td', {}, g.name), h('td', { class: 'num' }, score(g.P)), h('td', { class: 'num' }, grade(g.grade))));
    return h('div', { class: 'card' },
      h('h2', {}, 'Results'),
      h('p', {}, 'Your evaluation agreement: ', h('b', {}, pct(me.agreement)), me.grade != null ? [' · your grade: ', h('b', {}, grade(me.grade))] : ''),
      h('div', { class: 'scroll-x' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', { class: 'num' }, '#'), h('th', {}, 'group'), h('th', { class: 'num' }, 'presentation'), h('th', { class: 'num' }, 'grade'))),
        h('tbody', {}, rows))));
  }

  async function signOut() {
    await call('signOut');
    storage.del(KEY_TOKEN);
    store.me = null;
    render(true);
  }

  // ------------------------------------------------------------------ admin page

  // The setup form lives outside the live-updating sections so typing in it is never interrupted.
  const adminEls = { setup: h('div', {}), live: h('div', { class: 'stack' }) };
  let setupMode = null; // null | 'create' | 'edit'

  function renderAdmin() {
    $('#app').classList.add('wide');
    if (!store.isAdmin) {
      const pw = h('input', { type: 'password', class: 'big-input', placeholder: 'Admin password', autocomplete: 'current-password' });
      $('#app').replaceChildren(h('form', { class: 'card', onsubmit: async (e) => {
        e.preventDefault();
        const res = await call('admin:login', { password: pw.value });
        if (!res.ok) return toast(res.error, 'error');
        storage.set(KEY_ADMIN, res.adminToken);
        store.isAdmin = true;
        render(true);
      } }, h('h2', {}, 'Ranking admin'), pw, h('button', { type: 'submit', class: 'primary' }, 'Log in')));
      setTimeout(() => pw.focus());
      return;
    }
    $('#who').replaceChildren(h('span', { class: 'pill open' }, 'admin'));
    if (!$('#app').contains(adminEls.live)) $('#app').replaceChildren(adminEls.setup, adminEls.live);
    const admin = store.admin;
    if (!admin) return;
    if (!admin.current && !setupMode) openSetup('create');
    adminEls.live.replaceChildren(...liveSections(admin));
  }

  async function adminCmd(cmd, args, success) {
    const res = await call('admin', { cmd, args });
    if (!res.ok) toast(res.error, 'error');
    else if (success) toast(success);
    return res;
  }

  function openSetup(mode) {
    setupMode = mode;
    const cur = mode === 'edit' ? store.admin.current : null;
    const defaults = store.admin.defaults;
    const name = h('input', { value: cur?.name ?? '', placeholder: 'e.g. Final presentations, Oct 23' });
    const groups = h('textarea', { rows: 6, placeholder: 'One group per line' });
    groups.value = cur ? cur.groups.map((g) => g.name).join('\n') : '';
    const roster = h('textarea', { rows: 8, placeholder: 'Optional. One rater per line: Name, Group\nLeave the group out for raters who aren’t presenting.' });
    roster.value = cur ? cur.roster.map((r) => (r.groupId ? `${r.name}, ${cur.groups.find((g) => g.id === r.groupId)?.name}` : r.name)).join('\n') : '';
    const criteria = h('textarea', { rows: 7 });
    criteria.value = (cur ? cur.criteria : defaults).map((c) => `${c.name} | ${c.weight} | ${c.description}`).join('\n');
    const alpha = h('input', { type: 'number', min: 0, max: 100, step: 1, value: Math.round((cur?.alpha ?? 0.9) * 100), style: 'width:90px' });

    const submit = async (e) => {
      e.preventDefault();
      const args = { name: name.value, groups: groups.value, roster: roster.value, criteria: criteria.value, alpha: Number(alpha.value) / 100 };
      const res = mode === 'edit'
        ? await adminCmd('edit', { evaluationId: cur.id, ...args }, 'Saved')
        : await adminCmd('create', args, 'Evaluation created. Open ranking when you’re ready.');
      if (res.ok) closeSetup();
    };
    adminEls.setup.replaceChildren(h('form', { class: 'card', onsubmit: submit },
      h('h2', {}, mode === 'edit' ? 'Edit evaluation' : 'New evaluation'),
      h('label', { class: 'field' }, 'Name', name),
      h('div', { class: 'row', style: 'align-items:start' },
        h('label', { class: 'field grow' }, 'Groups (one per line)', groups),
        h('label', { class: 'field grow' }, 'Rater roster (optional): "Name, Group" per line. With a roster, only these names can sign in and their group is fixed. Without one, raters type any name and pick their group.', roster)),
      h('label', { class: 'field' }, 'Rubric: "Category | weight | description" per line', criteria),
      h('label', { class: 'field' }, 'Share of the grade from the presentation score (%). The rest is evaluation agreement.', alpha),
      h('div', { class: 'row' },
        h('button', { type: 'submit', class: 'primary' }, mode === 'edit' ? 'Save' : 'Create'),
        store.admin.current ? h('button', { type: 'button', onclick: closeSetup }, 'Cancel') : '')));
  }

  function closeSetup() {
    setupMode = null;
    adminEls.setup.replaceChildren();
    render(true);
  }

  function liveSections(admin) {
    const cur = admin.current;
    const sections = [];
    if (admin.evaluations.length > 1 || cur) {
      sections.push(h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('h3', { class: 'grow' }, 'Evaluations'),
          !setupMode ? h('button', { type: 'button', onclick: () => { openSetup('create'); render(true); } }, '+ New evaluation') : ''),
        h('div', { class: 'row' }, admin.evaluations.map((e) => h('button', {
          type: 'button',
          class: e.id === cur?.id ? 'primary small' : 'small',
          title: 'Raters see the highlighted one',
          onclick: () => e.id !== cur?.id && adminCmd('setCurrent', { evaluationId: e.id }),
        }, `${e.name} (${e.status})`)))));
    }
    if (!cur) return sections;

    const results = cur.results;
    const raterLink = `${location.origin}/rank`;
    const next = { draft: ['open', 'Open ranking'], open: ['closed', 'Close ranking'], closed: ['open', 'Reopen ranking'] }[cur.status];
    sections.push(h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, cur.name), statusPill(cur), cur.published ? h('span', { class: 'pill open' }, 'results published') : ''),
      h('p', {}, 'Rater link: ', h('b', {}, raterLink)),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'primary', onclick: () => adminCmd('status', { evaluationId: cur.id, status: next[0] }) }, next[1]),
        h('button', { type: 'button', onclick: () => adminCmd('publish', { evaluationId: cur.id, published: !cur.published }, cur.published ? 'Results hidden' : 'Results published to raters') },
          cur.published ? 'Unpublish results' : 'Publish results'),
        !setupMode ? h('button', { type: 'button', onclick: () => { openSetup('edit'); render(true); } }, 'Edit setup') : '',
        h('button', { type: 'button', onclick: () => downloadCsv(cur) }, 'Download CSV'),
        h('span', { class: 'grow' }),
        h('button', { type: 'button', class: 'danger small', onclick: () => {
          if (confirm(`Delete "${cur.name}" and all its rankings? This can’t be undone.`)) adminCmd('delete', { evaluationId: cur.id }, 'Deleted');
        } }, 'Delete evaluation'))));

    // results
    const critCols = cur.criteria.map((c) => h('th', { class: 'num', title: c.name }, `${c.name.split(' ')[0]} ${c.weight}%`));
    const groupRows = results.groups.map((g) => h('tr', {},
      h('td', { class: 'num' }, g.rank),
      h('td', {}, h('b', {}, g.name)),
      cur.criteria.map((c) => h('td', { class: 'num' }, score(g.byCriterion[c.id]))),
      h('td', { class: 'num' }, h('b', {}, score(g.P))),
      h('td', { class: 'num' }, pct(g.A)),
      h('td', { class: 'num' }, h('b', {}, grade(g.grade))),
      h('td', { class: 'num muted' }, g.ratedBy)));
    sections.push(h('div', { class: 'card' },
      h('h3', {}, 'Group results'),
      h('p', { class: 'muted small' }, `Presentation scores are 0–100 (100 = everyone ranked them first). Grade = ${Math.round(cur.alpha * 100)}% presentation + ${100 - Math.round(cur.alpha * 100)}% the group’s average evaluation agreement.`),
      h('div', { class: 'scroll-x' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', { class: 'num' }, '#'), h('th', {}, 'group'), critCols, h('th', { class: 'num' }, 'presentation'), h('th', { class: 'num' }, 'agreement'), h('th', { class: 'num' }, 'grade'), h('th', { class: 'num' }, 'raters'))),
        h('tbody', {}, groupRows)))));

    // raters
    const byId = new Map(results.raters.map((r) => [r.id, r]));
    const submitted = cur.raters.filter((r) => r.submittedAt).length;
    const notJoined = cur.roster.filter((r) => !cur.raters.some((x) => x.name.toLowerCase() === r.name.toLowerCase()));
    const raterRows = [...cur.raters]
      .sort((a, b) => groupName(a.groupId).localeCompare(groupName(b.groupId)) || a.name.localeCompare(b.name))
      .map((r) => {
        const res = byId.get(r.id);
        return h('tr', {},
          h('td', {}, h('span', { class: `dot ${r.signedIn ? 'on' : ''}`, title: r.signedIn ? 'Signed in on a device' : 'Not signed in' }), r.name),
          h('td', {}, groupName(r.groupId)),
          h('td', { class: `progress ${r.submittedAt ? 'full' : ''}` }, r.submittedAt ? `✓ ${new Date(r.submittedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'not yet'),
          h('td', { class: 'num' }, pct(res?.A)),
          h('td', { class: 'num' }, grade(res?.grade)),
          h('td', {},
            h('button', { type: 'button', class: 'link', title: 'Let them sign in on a new device (keeps their rankings)', onclick: () => adminCmd('resetRater', { evaluationId: cur.id, raterId: r.id }, `${r.name} can sign in again`) }, 'reset sign-in'),
            h('button', { type: 'button', class: 'link danger', onclick: () => {
              if (confirm(`Remove ${r.name} and their rankings?`)) adminCmd('removeRater', { evaluationId: cur.id, raterId: r.id }, `${r.name} removed`);
            } }, 'remove')));
      });
    sections.push(h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('h3', { class: 'grow' }, `Raters: ${submitted} of ${cur.raters.length} submitted`),
        cur.raters.length ? h('button', { type: 'button', class: 'small danger', onclick: () => {
          if (confirm(`Erase all ${cur.raters.length} raters and their rankings from "${cur.name}"? Use this to clear test submissions. The groups and rubric are kept.`)) {
            adminCmd('clear', { evaluationId: cur.id }, 'All rankings cleared');
          }
        } }, 'Clear all rankings') : ''),
      notJoined.length ? h('p', { class: 'muted small' }, `Not signed in yet: ${notJoined.map((r) => r.name).join(', ')}`) : '',
      h('div', { class: 'scroll-x' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', {}, 'rater'), h('th', {}, 'group'), h('th', {}, 'submitted'), h('th', { class: 'num' }, 'agreement'), h('th', { class: 'num' }, 'grade'), h('th', {}, ''))),
        h('tbody', {}, raterRows.length ? raterRows : h('tr', {}, h('td', { colSpan: 6, class: 'muted' }, 'Nobody has signed in yet.')))))));
    return sections;
  }

  function downloadCsv(cur) {
    const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const fmt = (x) => (x == null ? '' : (x * 100).toFixed(2));
    const rows = [['Groups'], ['rank', 'group', ...cur.criteria.map((c) => `${c.name} (${c.weight}%)`), 'presentation', 'agreement', 'grade']];
    const fmtGrade = (x) => (x == null ? '' : x.toFixed(2));
    for (const g of cur.results.groups) rows.push([g.rank, g.name, ...cur.criteria.map((c) => fmt(g.byCriterion[c.id])), fmt(g.P), fmt(g.A), fmtGrade(g.grade)]);
    rows.push([], ['Raters'], ['rater', 'group', 'categories ranked', 'agreement', 'grade']);
    for (const r of cur.results.raters) rows.push([r.name, groupName(r.groupId), r.completed, fmt(r.A), fmtGrade(r.grade)]);
    const blob = new Blob([rows.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${cur.name.replace(/[^\w-]+/g, '_')}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
  }
})();
