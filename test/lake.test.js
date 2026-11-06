import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LakeStore, LakeError } from '../lake/store.js';
import { CHORES } from '../lake/stations.js';

/** A started game with `n` players on a hand-driven clock. */
function setup(n = 9, settings = {}) {
  const clock = { t: 1_000_000 };
  const store = new LakeStore({ now: () => clock.t });
  const ids = Array.from({ length: n }, (_, i) => store.login({ name: `P${i}`, pin: '1234' }).player.id);
  store.setSettings(settings);
  store.start();
  const g = store.game;
  const lurkers = ids.filter((id) => g.players[id].role === 'lurker');
  const campers = ids.filter((id) => g.players[id].role === 'camper');
  return { store, clock, ids, lurkers, campers, code: (station) => store.codes[station] };
}

const throws = (fn, re) => assert.throws(fn, (err) => err instanceof LakeError && re.test(err.message));

test('roles: 2 Lurkers for 7+ players, 1 for 6 or fewer; lurkers see each other, campers see nobody', () => {
  assert.equal(setup(9).lurkers.length, 2);
  assert.equal(setup(6).lurkers.length, 1);
  const { store, lurkers, campers } = setup(9);
  assert.deepEqual(store.view(lurkers[0]).you.lurkers, [store.name(lurkers[1])]);
  assert.deepEqual(store.view(campers[0]).you.lurkers, []);
  assert.deepEqual(store.view(campers[0]).you.targets, []);
  assert.equal(store.view(null).you, null);
});

test('login: same name and PIN gets the same player back; wrong PIN is refused', () => {
  const store = new LakeStore();
  const a = store.login({ name: 'Ann', pin: '1111' });
  const b = store.login({ name: 'ann', pin: '1111' });
  assert.equal(a.player.id, b.player.id);
  assert.equal(store.playerByToken(a.token).id, a.player.id);
  throws(() => store.login({ name: 'Ann', pin: '2222' }), /taken/);
  throws(() => store.login({ name: 'Bo', pin: '12' }), /4 digits/);
});

test('kills: grace period, cooldown, body code, undo restores the cooldown', () => {
  const { store, clock, lurkers, campers } = setup(9);
  const [k] = lurkers;
  throws(() => store.kill(k, { targetId: campers[0] }), /Wait/);
  clock.t += 60_000;
  throws(() => store.kill(k, { targetId: lurkers[1] }), /living Camper/);
  store.kill(k, { targetId: campers[0] });
  const you = store.view(campers[0]).you;
  assert.equal(you.status, 'dead');
  assert.match(you.death.bodyCode, /^\d{3}$/);
  assert.equal(store.view(null).players.find((p) => p.id === campers[0]).out, false, 'a body is secret until a Campfire');
  throws(() => store.kill(k, { targetId: campers[1] }), /Wait/);
  store.undoDeath(campers[0]);
  assert.equal(store.view(campers[0]).you.status, 'alive');
  store.kill(k, { targetId: campers[1] }); // cooldown went back to what it was
  clock.t += 21_000;
  throws(() => store.undoDeath(campers[1]), /Too late/);
});

test('report: wrong codes lock you out; the right code starts a Campfire that reveals every body', () => {
  const { store, clock, lurkers, campers } = setup(9);
  clock.t += 60_000;
  store.kill(lurkers[0], { targetId: campers[0] });
  store.kill(lurkers[1], { targetId: campers[1] });
  const code = store.view(campers[0]).you.death.bodyCode;
  for (let i = 0; i < 5; i++) throws(() => store.report(campers[2], { bodyCode: '000' }), /No body/);
  throws(() => store.report(campers[2], { bodyCode: code }), /Too many/);
  store.report(campers[3], { bodyCode: code });
  const v = store.view(null);
  assert.equal(v.phase, 'meeting');
  assert.deepEqual(new Set(v.meeting.newlyOut), new Set([store.name(campers[0]), store.name(campers[1])]));
  assert.equal(v.meeting.voters.length, 7);
  assert.equal(store.view(campers[0]).you.status, 'ghost');
});

test('Campfire: everyone here skips ahead, votes eject the top player, tie or skip ejects nobody', () => {
  const { store, clock, lurkers, campers } = setup(9);
  throws(() => store.bell(campers[0], { code: store.codes.campfire }), /ready in/);
  clock.t += 30_000;
  throws(() => store.bell(campers[0], { code: store.codes.kitchen }), /at the Campfire/);
  store.bell(campers[0], { code: store.codes.campfire });
  const m = store.game.meeting;
  for (const id of m.voters) store.here(id);
  assert.equal(store.game.meeting.stage, 'discuss');
  store.skip();
  for (const id of m.voters) store.vote(id, { target: lurkers[0] });
  assert.equal(store.view(null).meeting.result.ejected.id, lurkers[0]);
  clock.t += 12_000;
  store.tick();
  assert.equal(store.phase, 'play');
  assert.equal(store.view(lurkers[0]).you.status, 'ghost');
  throws(() => store.bell(campers[0], { code: store.codes.campfire }), /used your bell/);

  clock.t += 30_000;
  store.bell(campers[1], { code: store.codes.campfire });
  store.skip();
  store.skip();
  const voters = store.game.meeting.voters;
  voters.forEach((id, i) => store.vote(id, { target: i % 2 ? 'skip' : campers[2] }));
  const r = store.view(null).meeting.result;
  assert.equal(r.ejected, null);
  assert.equal(r.reason, 'skip');
});

test('chores: puzzles need the right station and some time; carries go from A to B; lurker chores never count', () => {
  const { store, clock, lurkers, campers } = setup(9);
  const you = store.view(campers[0]).you;
  const task = you.chores.find((c) => c.kind === 'task');
  throws(() => store.choreStart(campers[0], { choreId: task.id, code: 'ZZZZ' }), /at the/);
  store.choreStart(campers[0], { choreId: task.id, code: store.codes[task.stationId] });
  throws(() => store.choreDone(campers[0], { choreId: task.id, code: store.codes[task.stationId] }), /Too quick/);
  clock.t += 8000;
  store.choreDone(campers[0], { choreId: task.id, code: store.codes[task.stationId] });
  assert.equal(store.view(null).bar.done, 1);

  const carry = you.chores.find((c) => c.kind === 'carry');
  throws(() => store.choreDone(campers[0], { choreId: carry.id, code: store.codes[carry.toId] }), /Pick up/);
  assert.deepEqual(store.choreDone(campers[0], { choreId: carry.id, code: store.codes[carry.fromId] }), { step: 1, done: false });
  assert.deepEqual(store.choreDone(campers[0], { choreId: carry.id, code: store.codes[carry.toId] }), { step: 1, done: true });

  const lt = store.view(lurkers[0]).you.chores.find((c) => c.kind === 'task');
  store.choreStart(lurkers[0], { choreId: lt.id, code: store.codes[lt.stationId] });
  clock.t += 8000;
  store.choreDone(lurkers[0], { choreId: lt.id, code: store.codes[lt.stationId] });
  assert.equal(store.view(null).bar.done, 2, 'the bar only counts campers');
});

test('chore bar full: campers win', () => {
  const { store, campers } = setup(7, { taskCount: 0, photoCount: 0, carryCount: 1 });
  for (const id of campers) {
    const c = store.view(id).you.chores[0];
    store.choreDone(id, { choreId: c.id, code: store.codes[c.fromId] });
    store.choreDone(id, { choreId: c.id, code: store.codes[c.toId] });
  }
  assert.equal(store.phase, 'over');
  assert.equal(store.view(null).over.winner, 'campers');
});

test('photos: partner chores wait for a living partner to confirm', () => {
  const { store, campers } = setup(9, { photoCount: 1 });
  const photo = CHORES.find((c) => c.kind === 'photo' && c.partner);
  const p = store.game.players[campers[0]];
  p.chores[0].ref = photo.id;
  const code = store.codes[photo.station];
  throws(() => store.checkPhoto(campers[0], { choreId: 'c1', code, partnerId: campers[0] }), /another player/);
  // a retake replaces the waiting request
  store.addPhoto(campers[0], { choreId: 'c1', code, partnerId: campers[2] }, { id: 'x0', mime: 'image/jpeg' });
  const { requestId, done } = store.addPhoto(campers[0], { choreId: 'c1', code, partnerId: campers[1] }, { id: 'x1', mime: 'image/jpeg' });
  assert.equal(done, false);
  assert.equal(store.view(campers[1]).you.confirms.length, 1);
  store.confirmPhoto(campers[1], { requestId, yes: true });
  assert.equal(store.view(campers[0]).you.chores[0].done, true);
  assert.equal(store.photos[1].partner, store.name(campers[1]));
  assert.equal(store.game.requests.length, 0);
});

test('lurkers win when they catch up; a storm that runs out also wins it for them', () => {
  const { store, clock, lurkers, campers } = setup(5, { killCooldown: 10 });
  clock.t += 60_000;
  store.kill(lurkers[0], { targetId: campers[0] });
  clock.t += 10_000;
  store.kill(lurkers[0], { targetId: campers[1] });
  clock.t += 10_000;
  store.kill(lurkers[0], { targetId: campers[2] });
  assert.equal(store.view(null).over.winner, 'lurkers');

  const s2 = setup(9);
  s2.clock.t += 180_000;
  s2.store.storm(s2.lurkers[0]);
  throws(() => s2.store.bell(s2.campers[0], { code: s2.store.codes.campfire }), /storm/);
  const [a, b] = s2.store.game.storm.stations;
  s2.store.stormFix(s2.campers[0], { code: s2.code(a) });
  throws(() => s2.store.stormFix(s2.campers[0], { code: s2.code(b) }), /Someone else/);
  s2.clock.t += 90_000;
  s2.store.tick();
  assert.equal(s2.store.view(null).over.winner, 'lurkers');
});

test('pause freezes the clock: timers move by the paused time', () => {
  const { store, clock, lurkers } = setup(9);
  const before = store.game.players[lurkers[0]].killReadyAt;
  store.pause();
  throws(() => store.kill(lurkers[0], { targetId: 'x' }), /paused/);
  clock.t += 100_000;
  store.resume();
  assert.equal(store.game.players[lurkers[0]].killReadyAt, before + 100_000);
});

test('saves and loads', () => {
  const { store } = setup(9);
  const copy = LakeStore.fromJSON(JSON.parse(JSON.stringify(store)));
  assert.equal(copy.players.size, 9);
  assert.equal(copy.phase, 'play');
  assert.deepEqual(copy.codes, store.codes);
});
