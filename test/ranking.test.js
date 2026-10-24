import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { computeResults } from '../ranking/scoring.js';
import { RankingStore, DEFAULT_CRITERIA } from '../ranking/store.js';
import { createExchangeServer } from '../exchange/server.js';
import { attachRanking } from '../ranking/server.js';
import { platform } from '../server.js';

const close = (a, b) => Math.abs(a - b) < 1e-9;

/** 5 groups (A best ... E worst), 2 raters per group plus 2 audience raters, everyone honest. */
function honestSetup() {
  const groups = ['A', 'B', 'C', 'D', 'E'].map((id) => ({ id, name: `Group ${id}` }));
  const criteria = [{ id: 'c1', name: 'Content', weight: 60 }, { id: 'c2', name: 'Fun', weight: 40 }];
  const raters = [];
  for (const g of groups) for (const n of [1, 2]) raters.push({ id: `${g.id}${n}`, name: `${g.id}${n}`, groupId: g.id });
  raters.push({ id: 'X1', name: 'X1', groupId: null }, { id: 'X2', name: 'X2', groupId: null });
  const truth = ['A', 'B', 'C', 'D', 'E'];
  const rankings = {};
  for (const r of raters) {
    const order = truth.filter((g) => g !== r.groupId);
    rankings[r.id] = { c1: [...order], c2: [...order] };
  }
  return { evaluation: { groups, criteria, alpha: 0.9 }, raters, rankings };
}

test('honest consensus: agreement is 1 for everyone and presentation scores follow the order', () => {
  const { evaluation, raters, rankings } = honestSetup();
  const res = computeResults(evaluation, raters, rankings);
  assert.deepEqual(res.groups.map((g) => g.id), ['A', 'B', 'C', 'D', 'E']);
  assert.ok(res.raters.every((r) => close(r.A, 1)));
  const A = res.groups[0];
  assert.ok(close(A.P, 1), 'everyone who can rank A ranks it first');
  assert.ok(close(res.groups.at(-1).P, 0), 'E is last for everyone');
  assert.ok(close(A.grade, 100));
});

test('deviating from the shared ranking lowers only your own agreement, never your group’s presentation score', () => {
  const { evaluation, raters, rankings } = honestSetup();
  const honest = computeResults(evaluation, raters, rankings);
  // C1 tries to sink their strongest competitor, A, in both categories
  rankings.C1 = { c1: ['B', 'D', 'E', 'A'], c2: ['B', 'D', 'E', 'A'] };
  const dev = computeResults(evaluation, raters, rankings);
  const g = (res, id) => res.groups.find((x) => x.id === id);
  const r = (res, id) => res.raters.find((x) => x.id === id);
  assert.ok(close(g(dev, 'C').P, g(honest, 'C').P), 'own group P unchanged');
  assert.ok(r(dev, 'C1').A < 1, 'deviator loses agreement');
  assert.ok(r(dev, 'C1').grade < r(honest, 'C1').grade, 'deviator’s grade drops');
  assert.ok(g(dev, 'C').grade < g(honest, 'C').grade, 'and drags the group’s agreement average');
});

test('teammates are never compared with each other', () => {
  const { evaluation, raters, rankings } = honestSetup();
  // both members of C coordinate on the same dishonest order
  rankings.C1 = rankings.C2 = { c1: ['E', 'D', 'B', 'A'], c2: ['E', 'D', 'B', 'A'] };
  const res = computeResults(evaluation, raters, rankings);
  const c1 = res.raters.find((x) => x.id === 'C1');
  assert.ok(c1.A < 0.2, `coordination inside a team doesn't help (A = ${c1.A})`);
});

test('unranked categories count as zero agreement; non-raters get zero', () => {
  const { evaluation, raters, rankings } = honestSetup();
  delete rankings.B1.c2;
  delete rankings.D2;
  const res = computeResults(evaluation, raters, rankings);
  const b1 = res.raters.find((x) => x.id === 'B1');
  assert.ok(close(b1.A, 0.6), 'only the 60%-weight category agrees');
  assert.equal(res.raters.find((x) => x.id === 'D2').A, 0);
});

function storeWithEval(extra = {}) {
  const store = new RankingStore();
  const ev = store.createEvaluation({
    name: 'Finals',
    groups: 'Alpha\nBeta\nGamma\nDelta',
    criteria: DEFAULT_CRITERIA,
    ...extra,
  });
  return { store, ev };
}

test('roster: only listed names sign in, groups are fixed, a name stays on its first device', () => {
  const { store, ev } = storeWithEval({ roster: 'Ann, Alpha\nBen, Beta\nCat' });
  assert.throws(() => store.login({ name: 'Zed' }), /isn’t on the list/);
  const ann = store.login({ name: 'ann' });
  assert.equal(ann.name, 'Ann');
  assert.equal(ann.groupId, ev.groups[0].id);
  assert.equal(store.login({ name: 'Cat' }).groupId, null, 'audience');
  assert.throws(() => store.login({ name: 'Ann' }), /another device/);
  assert.equal(store.login({ token: ann.token }), ann);
  store.resetRater(ev.id, ann.id);
  assert.notEqual(store.login({ name: 'Ann' }).token, null);
  assert.throws(() => store.createEvaluation({ groups: 'A\nB\nC', roster: 'X, Nope' }), /isn't one of the groups/);
});

test('no roster: raters type a name and pick a group', () => {
  const { store, ev } = storeWithEval();
  assert.throws(() => store.login({ name: 'Dee' }), /Pick your group/);
  assert.equal(store.login({ name: 'Dee', groupId: ev.groups[3].id }).groupId, ev.groups[3].id);
  assert.equal(store.login({ name: 'Eve', groupId: 'none' }).groupId, null);
});

test('one submit for all categories, only while open; resubmitting replaces it', () => {
  const { store, ev } = storeWithEval();
  const [alpha, beta, gamma, delta] = ev.groups.map((g) => g.id);
  const dee = store.login({ name: 'Dee', groupId: alpha });
  const all = (order) => Object.fromEntries(ev.criteria.map((c) => [c.id, order]));
  assert.throws(() => store.submitAll(dee.id, all([beta, gamma, delta])), /hasn’t opened/);
  store.setStatus(ev.id, 'open');
  assert.throws(() => store.submitAll(dee.id, all([alpha, beta, gamma])), /Finish ranking/);
  const partial = all([beta, gamma, delta]);
  delete partial[ev.criteria[5].id];
  assert.throws(() => store.submitAll(dee.id, partial), /Fun Factor/);
  assert.equal(Object.keys(ev.rankings).length, 0, 'nothing saved until a complete submit');
  store.submitAll(dee.id, all([gamma, beta, delta]));
  assert.ok(dee.submittedAt);
  store.submitAll(dee.id, all([beta, gamma, delta]));
  assert.deepEqual(ev.rankings[dee.id][ev.criteria[0].id], [beta, gamma, delta]);
  store.setStatus(ev.id, 'closed');
  assert.throws(() => store.submitAll(dee.id, all([beta, gamma, delta])), /closed/);
  assert.throws(() => store.editEvaluation(ev.id, { groups: 'Alpha\nBeta' }), /can’t change/);
  store.editEvaluation(ev.id, { alpha: 80 });
  assert.equal(ev.alpha, 0.8);
  const copy = RankingStore.fromJSON(JSON.parse(JSON.stringify(store)));
  assert.deepEqual(copy.results(copy.current()), store.results(ev));
});

test('clear all rankings erases raters and submissions but keeps the setup', () => {
  const { store, ev } = storeWithEval();
  store.setStatus(ev.id, 'open');
  const ids = ev.groups.map((g) => g.id);
  const t = store.login({ name: 'Tester', groupId: 'none' });
  store.submitAll(t.id, Object.fromEntries(ev.criteria.map((c) => [c.id, ids])));
  const signedOut = [];
  store.on('signout', (id) => signedOut.push(id));
  store.clearRankings(ev.id);
  assert.deepEqual([ev.raters.length, Object.keys(ev.rankings).length, ev.groups.length, ev.status], [0, 0, 4, 'open']);
  assert.deepEqual(signedOut, [t.id]);
  assert.ok(store.login({ name: 'Tester', groupId: 'none' }), 'the name is free again');
});

test('end to end over the /rank namespace', { timeout: 10000 }, async (t) => {
  const server = createExchangeServer(platform, { dataFile: null, adminPassword: 'admin-pw', quiet: true, handleSignals: false });
  attachRanking(server, { isAdminPassword: server.isAdminPassword, dataFile: null });
  const port = await server.listen(0);
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.close());
    await server.close();
  });
  const client = () => {
    const c = connect(`http://localhost:${port}/rank`, { transports: ['websocket'] });
    c.latest = {};
    c.onAny((event, data) => (c.latest[event] = data));
    clients.push(c);
    return c;
  };
  const ask = (c, event, payload) => c.timeout(2000).emitWithAck(event, payload);
  const next = (c, event, pred) => new Promise((resolve) => {
    if (c.latest[event] && pred(c.latest[event])) return resolve(c.latest[event]);
    const fn = (d) => pred(d) && (c.off(event, fn), resolve(d));
    c.on(event, fn);
  });

  const page = await fetch(`http://localhost:${port}/rank`);
  assert.equal(page.status, 200);

  const admin = client();
  assert.equal((await ask(admin, 'admin', { cmd: 'create', args: {} })).ok, false, 'needs admin');
  assert.equal((await ask(admin, 'admin:login', { password: 'admin-pw' })).ok, true);
  await ask(admin, 'admin', { cmd: 'create', args: { name: 'Finals', groups: 'A\nB\nC\nD', roster: 'Ann, A\nBen, B\nCal, C\nDot, D', criteria: DEFAULT_CRITERIA } });
  const view = await next(admin, 'admin', (a) => a.current);
  await ask(admin, 'admin', { cmd: 'status', args: { evaluationId: view.current.id, status: 'open' } });

  const truth = view.current.groups.map((g) => g.id);
  for (const name of ['Ann', 'Ben', 'Cal', 'Dot']) {
    const c = client();
    const res = await ask(c, 'login', { name });
    assert.ok(res.token);
    const me = await next(c, 'me', (m) => m.name === name);
    const order = truth.filter((g) => me.eligible.includes(g));
    const r = await ask(c, 'submit', { rankings: Object.fromEntries(view.current.criteria.map((crit) => [crit.id, order])) });
    assert.equal(r.ok, true, r.error);
  }
  const done = await next(admin, 'admin', (a) => a.current.results.raters.every((r) => r.completed === 6));
  assert.deepEqual(done.current.results.groups.map((g) => g.name), ['A', 'B', 'C', 'D']);
  assert.ok(done.current.results.raters.every((r) => close(r.A, 1)));

  const viewer = client();
  await next(viewer, 'eval', (e) => e && !e.results);
  await ask(admin, 'admin', { cmd: 'publish', args: { evaluationId: view.current.id, published: true } });
  const pub = await next(viewer, 'eval', (e) => e?.results);
  assert.equal(pub.results[0].name, 'A');
  assert.equal(pub.results[0].grade, 100);
});
