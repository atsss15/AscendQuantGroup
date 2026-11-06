import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as connect } from 'socket.io-client';
import { LakeStore, LakeError } from '../lake/store.js';
import { attachLake } from '../lake/server.js';
import { CHORES, STATIONS, STORM_DEFAULT } from '../lake/stations.js';
import { createExchangeServer } from '../exchange/server.js';
import { platform } from '../server.js';

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

// ---- found in review: leaks, stuck states, robustness

/** Gives `who` a partner photo chore as c1 and returns its station code. */
function partnerPhoto(store, ...who) {
  const photo = CHORES.find((c) => c.kind === 'photo' && c.partner);
  for (const id of who) store.game.players[id].chores[0].ref = photo.id;
  return store.codes[photo.station];
}

test('a kill leaves photo requests alone, so neither side learns of it; the Campfire drops requests to the revealed', () => {
  const { store, clock, lurkers, campers } = setup(9);
  const code = partnerPhoto(store, campers[0], campers[1]);
  // campers[0] waits on campers[1]; campers[1] waits on campers[2]
  store.addPhoto(campers[0], { choreId: 'c1', code, partnerId: campers[1] }, { id: 'a', mime: 'image/jpeg' });
  store.addPhoto(campers[1], { choreId: 'c1', code, partnerId: campers[2] }, { id: 'b', mime: 'image/jpeg' });
  clock.t += 60_000;
  store.kill(lurkers[0], { targetId: campers[1] });
  assert.equal(store.view(campers[0]).you.chores[0].pending, true, "the requester can't tell their partner was killed");
  assert.equal(store.view(campers[2]).you.confirms.length, 1, "the partner can't tell the requester was killed");
  const toDead = store.view(campers[1]).you.confirms[0].requestId;
  throws(() => store.confirmPhoto(campers[1], { requestId: toDead, yes: true }), /dead/);
  // a yes to the (secretly dead) requester's photo counts like any chore of theirs
  store.confirmPhoto(campers[2], { requestId: store.view(campers[2]).you.confirms[0].requestId, yes: true });
  assert.equal(store.view(campers[1]).you.chores[0].done, true);
  // the Campfire makes campers[1] a ghost, so the request waiting on them goes and campers[0] can retake
  store.report(campers[3], { bodyCode: store.game.players[campers[1]].death.bodyCode });
  assert.equal(store.view(campers[0]).you.chores[0].pending, false);
  assert.equal(store.game.requests.length, 0);
});

test('an undone kill keeps the photo request; an ejected partner drops it', () => {
  const { store, clock, lurkers, campers } = setup(9);
  const code = partnerPhoto(store, campers[0]);
  const { requestId } = store.addPhoto(campers[0], { choreId: 'c1', code, partnerId: campers[1] }, { id: 'a', mime: 'image/jpeg' });
  clock.t += 60_000;
  store.kill(lurkers[0], { targetId: campers[1] });
  store.undoDeath(campers[1]);
  store.confirmPhoto(campers[1], { requestId, yes: false });
  const again = store.addPhoto(campers[0], { choreId: 'c1', code, partnerId: campers[1] }, { id: 'b', mime: 'image/jpeg' });
  assert.ok(again.requestId);
  store.bell(campers[2], { code: store.codes.campfire });
  store.skip();
  store.skip();
  for (const id of store.game.meeting.voters) store.vote(id, { target: campers[1] });
  assert.equal(store.view(null).meeting.result.ejected.id, campers[1]);
  assert.equal(store.view(campers[0]).you.chores[0].pending, false);
  assert.deepEqual(store.view(campers[1]).you.confirms, []);
});

test('kick mid-Campfire: votes for them are handed back, and a stage only waiting on them ends', () => {
  const { store, clock, lurkers, campers } = setup(9);
  clock.t += 30_000;
  store.bell(campers[0], { code: store.codes.campfire });
  const m = () => store.game.meeting;
  for (const id of m().voters) if (id !== campers[6]) store.here(id);
  assert.equal(m().stage, 'gather');
  store.kick(campers[6]);
  assert.equal(m().stage, 'discuss', 'everyone left is here');
  store.skip();
  const [a, b] = m().voters.filter((id) => id !== campers[5] && id !== campers[4]);
  store.vote(a, { target: campers[5] });
  store.vote(b, { target: campers[5] });
  store.kick(campers[5]);
  assert.equal(store.view(a).you.myVote, null, 'their vote came back');
  assert.ok(!m().voters.includes(campers[5]));
  throws(() => store.vote(a, { target: campers[5] }), /living player/);
  for (const id of m().voters) if (id !== campers[4]) store.vote(id, { target: lurkers[0] });
  assert.equal(m().stage, 'vote');
  store.kick(campers[4]);
  assert.equal(m().stage, 'result', 'the last missing voter left');
  assert.equal(store.view(null).meeting.result.ejected.id, lurkers[0]);
});

test('kicked while paused: the Campfire moves on after resume', () => {
  const { store, clock, campers } = setup(9);
  clock.t += 30_000;
  store.bell(campers[0], { code: store.codes.campfire });
  for (const id of store.game.meeting.voters) if (id !== campers[6]) store.here(id);
  store.pause();
  store.kick(campers[6]);
  assert.equal(store.game.meeting.stage, 'gather');
  store.resume();
  store.tick();
  assert.equal(store.game.meeting.stage, 'discuss');
});

test('undo after a second quick kill keeps the cooldown from the second kill', () => {
  const { store, clock, lurkers, campers } = setup(9, { killCooldown: 10, undoSeconds: 30 });
  const [k] = lurkers;
  clock.t += 60_000;
  store.kill(k, { targetId: campers[0] });
  clock.t += 10_000;
  store.kill(k, { targetId: campers[1] });
  clock.t += 5_000;
  store.undoDeath(campers[0]);
  throws(() => store.kill(k, { targetId: campers[2] }), /Wait 5 s/);
  store.undoDeath(campers[1]);
  store.kill(k, { targetId: campers[2] }); // both undone: as before the first kill
});

test('settings: locked during a game; junk patches are refused with a LakeError', () => {
  const { store } = setup(9);
  throws(() => store.setSettings({ disabled: ['dock'] }), /between games/);
  throws(() => store.setSettings({ discussSeconds: 30 }), /between games/);
  store.end();
  for (const patch of [null, 'x', 5, [1], { constructor: 1 }, { toString: 5 }, { hasOwnProperty: 1 }, JSON.parse('{"__proto__": 5}')]) {
    throws(() => store.setSettings(patch), /./);
  }
  assert.equal(Object.getPrototypeOf(store.settings), Object.prototype);
  store.setSettings({ discussSeconds: 30 });
  assert.equal(store.settings.discussSeconds, 30);
});

test('client ids can be anything: prototype names, objects, numbers', () => {
  const { store, clock, lurkers, campers } = setup(9);
  clock.t += 60_000;
  const bads = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', {}, 7, null, ['p1']];
  for (const bad of bads) {
    throws(() => store.kill(lurkers[0], { targetId: bad }), /living Camper/);
    throws(() => store.choreDone(campers[0], { choreId: bad, code: bad }), /No such chore/);
    throws(() => store.report(campers[0], { bodyCode: bad }), /No body|Too many/);
    throws(() => store.stormFix(campers[0], { code: bad }), /storm/i);
    throws(() => store.confirmPhoto(campers[0], { requestId: bad, yes: true }), /gone/);
  }
  const code = partnerPhoto(store, campers[1]);
  for (const bad of bads) throws(() => store.checkPhoto(campers[1], { choreId: 'c1', code, partnerId: bad }), /another player/);
  store.bell(campers[2], { code: store.codes.campfire });
  store.skip();
  store.skip();
  for (const bad of bads) throws(() => store.vote(campers[2], { target: bad }), /living player/);
  assert.equal(store.view(campers[2]).you.myVote, null);
});

test('login: PIN guessing locks that name for a minute (even the right PIN); other names are fine', () => {
  const clock = { t: 1_000_000 };
  const store = new LakeStore({ now: () => clock.t });
  store.login({ name: 'Ann', pin: '1111' });
  for (let i = 0; i < 5; i++) throws(() => store.login({ name: 'ann', pin: String(2000 + i) }), /Wrong PIN/);
  throws(() => store.login({ name: 'Ann', pin: '1111' }), /Too many/);
  store.login({ name: 'Bo', pin: '1111' });
  clock.t += 60_000;
  store.login({ name: 'Ann', pin: '1111' });
});

test('login: at most 40 players; existing players still get back in', () => {
  const store = new LakeStore();
  for (let i = 0; i < 40; i++) store.login({ name: `N${i}`, pin: '1234' });
  throws(() => store.login({ name: 'Late', pin: '1234' }), /full/);
  store.login({ name: 'N3', pin: '1234' });
});

test('photos: one player can take at most 20 a game', () => {
  const { store, campers } = setup(9);
  const code = partnerPhoto(store, campers[0]);
  const args = { choreId: 'c1', code, partnerId: campers[1] };
  for (let i = 0; i < 20; i++) store.addPhoto(campers[0], args, { id: `x${i}`, mime: 'image/jpeg', bytes: 10 });
  throws(() => store.checkPhoto(campers[0], args), /20 photos from you/);
});

test("can't start when no chore can be dealt", () => {
  const store = new LakeStore();
  for (let i = 0; i < 5; i++) store.login({ name: `P${i}`, pin: '1234' });
  store.setSettings({ storm: false, disabled: STATIONS.map((s) => s.id).filter((id) => id !== 'campfire') });
  assert.match(store.startProblem(), /No chores/);
});

test('saves and loads mid-storm, mid-Campfire and paused, and the game carries on', () => {
  const copyOf = (store, clock) => LakeStore.fromJSON(JSON.parse(JSON.stringify(store)), { now: () => clock.t });
  {
    const { store, clock, lurkers, campers, code } = setup(9);
    clock.t += 180_000;
    store.storm(lurkers[0]);
    const [a, b] = store.game.storm.stations;
    store.stormFix(campers[0], { code: code(a) });
    const copy = copyOf(store, clock);
    throws(() => copy.stormFix(campers[0], { code: code(b) }), /Someone else/);
    copy.stormFix(campers[1], { code: code(b) });
    assert.equal(copy.game.storm, null);
  }
  {
    const { store, clock, lurkers, campers } = setup(9);
    clock.t += 30_000;
    store.bell(campers[0], { code: store.codes.campfire });
    store.skip();
    store.skip();
    const { voters } = store.game.meeting;
    for (const id of voters.slice(1)) store.vote(id, { target: lurkers[0] });
    const endsAt = store.game.meeting.endsAt;
    store.pause();
    clock.t += 50_000;
    const copy = copyOf(store, clock);
    assert.equal(copy.paused, true);
    throws(() => copy.vote(voters[0], { target: lurkers[0] }), /paused/);
    copy.resume();
    assert.equal(copy.game.meeting.endsAt, endsAt + 50_000);
    copy.vote(voters[0], { target: lurkers[0] });
    assert.equal(copy.view(null).meeting.result.ejected.id, lurkers[0]);
  }
});

test('a restart mid-game pauses it as of the last save, so the downtime runs out no timer', () => {
  const { store, clock, lurkers } = setup(9);
  clock.t += 180_000;
  store.storm(lurkers[0]);
  const endsAt = store.game.storm.endsAt;
  const saved = JSON.parse(JSON.stringify(store));
  clock.t += 600_000; // down for 10 minutes
  const copy = LakeStore.fromJSON(saved, { now: () => clock.t });
  assert.equal(copy.pauseAfterRestart(), true);
  copy.tick();
  assert.equal(copy.phase, 'play', "the storm didn't run out while the server was down");
  copy.resume();
  assert.equal(copy.game.storm.endsAt, endsAt + 600_000);
  assert.equal(LakeStore.fromJSON(JSON.parse(JSON.stringify(new LakeStore()))).pauseAfterRestart(), false);
});

test('a saved game naming chores or stations no longer in the catalog still loads and renders', () => {
  const { store, clock, campers, lurkers } = setup(9);
  clock.t += 180_000;
  store.storm(lurkers[0]);
  const data = JSON.parse(JSON.stringify(store));
  data.game.players[campers[0]].chores[0].ref = 'gone-chore';
  data.game.storm.stations = ['gone-station', 'dock'];
  data.settings.disabled = ['gone-station', 'dock'];
  data.settings.stormStations = ['gone-station', 'dock'];
  data.settings.killCooldown = 'abc';
  const copy = LakeStore.fromJSON(data);
  assert.equal(copy.view(campers[0]).you.chores.length, store.view(campers[0]).you.chores.length - 1);
  assert.equal(copy.view(null).storm.stations[0].name, '?');
  assert.deepEqual(copy.settings.disabled, ['dock']);
  assert.deepEqual(copy.settings.stormStations, STORM_DEFAULT);
  assert.equal(copy.settings.killCooldown, 150);
});

test('over /lake: a kill pushes nothing to the other phones; gallery needs a sign-in; photo errors are JSON', { timeout: 15000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-test-'));
  const server = createExchangeServer(platform, { dataFile: null, adminPassword: 'admin-pw', quiet: true, handleSignals: false });
  const lake = attachLake(server, { isAdminPassword: server.isAdminPassword, dir });
  const port = await server.listen(0);
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.close());
    lake.close();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const client = () => {
    const c = connect(`http://localhost:${port}/lake`, { transports: ['websocket'], forceNew: true });
    c.states = 0;
    c.on('state', (s) => {
      c.states += 1;
      c.state = s;
    });
    clients.push(c);
    return c;
  };
  const ask = (c, event, payload) => c.timeout(2000).emitWithAck(event, payload);
  const settle = () => new Promise((r) => setTimeout(r, 250));

  const tv = client();
  const host = client();
  const phones = Array.from({ length: 5 }, () => client());
  await settle();
  assert.equal((await ask(tv, 'gallery', {})).ok, false, 'no gallery for a page nobody signed in on');
  const ids = [];
  for (const [i, c] of phones.entries()) ids.push((await ask(c, 'login', { name: `P${i}`, pin: '1234' })).playerId);
  assert.equal((await ask(phones[0], 'gallery', {})).ok, true);
  assert.equal((await ask(host, 'host:login', { password: 'admin-pw' })).ok, true);
  assert.equal((await ask(host, 'host', { cmd: 'settings', args: { patch: { startGrace: 0 } } })).ok, true);
  assert.equal((await ask(host, 'host', { cmd: 'start' })).ok, true);
  await settle();
  const g = lake.store.game;
  const killer = phones[ids.findIndex((id) => g.players[id].role === 'lurker')];
  const [victim, bystander] = phones.filter((c, i) => g.players[ids[i]].role === 'camper');
  const before = { tv: tv.states, host: host.states, bystander: bystander.states, victim: victim.states };
  assert.equal((await ask(killer, 'kill', { targetId: victim.state.me.id })).ok, true);
  await settle();
  assert.equal(victim.states, before.victim + 1);
  assert.equal(victim.state.you.status, 'dead');
  assert.deepEqual({ tv: tv.states, host: host.states, bystander: bystander.states }, { tv: before.tv, host: before.host, bystander: before.bystander });
  // a resume always answers with a state, even when nothing changed
  const n = bystander.states;
  await ask(bystander, 'resume', { token: lake.store.players.get(bystander.state.me.id).tokens.at(-1) });
  await settle();
  assert.equal(bystander.states, n + 1);

  // a throwing tick is logged, not fatal
  const tick = lake.store.tick;
  const log = console.error;
  console.error = () => {};
  lake.store.tick = () => { throw new Error('boom'); };
  await new Promise((r) => setTimeout(r, 700));
  lake.store.tick = tick;
  console.error = log;

  const token = lake.store.players.get(ids[0]).tokens.at(-1);
  const post = (body, type = 'application/json') => fetch(`http://localhost:${port}/lake/api/photo`, { method: 'POST', headers: { 'content-type': type, authorization: `Bearer ${token}` }, body });
  let res = await post('{not json');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /didn't come through/);
  res = await post(JSON.stringify({ image: `data:image/jpeg;base64,${'A'.repeat(9 * 1024 * 1024)}` }));
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /too big/);

  // the host password can't be guessed at full speed
  for (let i = 0; i < 5; i++) assert.match((await ask(tv, 'host:login', { password: `guess${i}` })).error, /Wrong/);
  assert.match((await ask(tv, 'host:login', { password: 'admin-pw' })).error, /Too many/);
});
