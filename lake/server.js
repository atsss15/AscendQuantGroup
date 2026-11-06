import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import QRCode from 'qrcode';
import { LakeStore, LakeError } from './store.js';

const PUBLIC = fileURLToPath(new URL('./public', import.meta.url));
const PAGES = { '/lake': 'index.html', '/lake/s/:code': 'index.html', '/lake/tv': 'tv.html', '/lake/print': 'print.html', '/lake/rules': 'rules.html' };
const IMAGE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const MAX_PHOTOS = 2000;

/**
 * Mount Lake Lurkers (the retreat's real-life social-deduction game) on an existing server: phone app at /lake,
 * big screen at /lake/tv, QR cards at /lake/print, rules at /lake/rules, live updates on the Socket.IO namespace /lake.
 * State is saved to <dir>/state.json and photos to <dir>/photos/.
 *
 * @param {{ app: import('express').Express, io: import('socket.io').Server }} server
 * @param {{ isAdminPassword: (pw: string) => boolean, dir?: string }} opts
 */
export function attachLake({ app, io }, { isAdminPassword, dir = path.resolve('data', 'lake') }) {
  const file = path.join(dir, 'state.json');
  const photoDir = path.join(dir, 'photos');
  const store = fs.existsSync(file) ? LakeStore.fromJSON(JSON.parse(fs.readFileSync(file, 'utf8'))) : new LakeStore();

  for (const [route, page] of Object.entries(PAGES)) app.get(route, (req, res) => res.sendFile(path.join(PUBLIC, page)));
  app.use('/lake', express.static(PUBLIC));

  app.get('/lake/qr/:file', async (req, res) => {
    const code = req.params.file.replace(/\.svg$/, '').toUpperCase();
    if (code !== 'JOIN' && !Object.values(store.codes).includes(code)) return res.status(404).end();
    const origin = `${req.get('x-forwarded-proto') ?? req.protocol}://${req.get('host')}`;
    const svg = await QRCode.toString(code === 'JOIN' ? `${origin}/lake` : `${origin}/lake/s/${code}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').send(svg);
  });

  app.get('/lake/photo/:file', (req, res) => {
    const t = String(req.query.t ?? '');
    if (!store.playerByToken(t) && !store.isHostToken(t)) return res.status(403).end();
    const meta = store.photoMeta(req.params.file.replace(/\.\w+$/, ''));
    if (!meta) return res.status(404).end();
    res.type(meta.mime).set('cache-control', 'private, max-age=86400').sendFile(path.join(photoDir, meta.id));
  });

  app.post('/lake/api/photo', express.json({ limit: '8mb' }), (req, res) => {
    const player = store.playerByToken(req.get('authorization')?.replace(/^Bearer /, ''));
    if (!player) return res.status(401).json({ error: 'Please sign in again' });
    const body = req.body ?? {};
    const args = { choreId: body.choreId, code: body.code, partnerId: body.partnerId ?? null };
    let saved = null;
    try {
      const m = IMAGE.exec(String(body.image ?? ''));
      if (!m) throw new LakeError('That photo didn\'t come through. Try again.');
      const bytes = Buffer.from(m[2], 'base64');
      if (bytes.length > MAX_PHOTO_BYTES) throw new LakeError('That photo is too big');
      if (store.photos.length >= MAX_PHOTOS) throw new LakeError('The photo album is full');
      store.checkPhoto(player.id, args);
      const id = randomBytes(12).toString('hex');
      fs.mkdirSync(photoDir, { recursive: true });
      saved = path.join(photoDir, id);
      fs.writeFileSync(saved, bytes);
      res.json({ ok: true, ...store.addPhoto(player.id, args, { id, mime: m[1] }) });
    } catch (err) {
      if (saved) fs.rmSync(saved, { force: true });
      if (err instanceof LakeError) return res.status(400).json({ error: err.message });
      console.error('[lake:photo]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  const nsp = io.of('/lake');

  // ---- push updates, coalesced
  let flushTimer = null;
  store.on('change', () => {
    flushTimer ??= setTimeout(flush, 60);
  });
  store.on('signout', (playerId) => {
    for (const socket of nsp.sockets.values()) {
      if (socket.data.playerId !== playerId) continue;
      socket.data.playerId = null;
      socket.data.token = null;
      socket.emit('signedOut', { reason: 'The host removed you from the game.' });
    }
  });

  function flush() {
    flushTimer = null;
    const online = new Set([...nsp.sockets.values()].map((s) => s.data.playerId).filter(Boolean));
    let host = null;
    for (const socket of nsp.sockets.values()) push(socket);
    for (const socket of nsp.sockets.values()) if (socket.data.isHost) socket.emit('host', (host ??= store.hostView(online)));
    scheduleSave();
  }

  function push(socket) {
    socket.emit('state', store.view(socket.data.playerId, socket.data.token ?? socket.data.hostToken));
  }

  const ticker = setInterval(() => store.tick(), 500);
  ticker.unref();

  // ---- persistence
  let saveTimer = null;
  function scheduleSave() {
    saveTimer ??= setTimeout(save, 1000);
  }
  function save() {
    saveTimer = null;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(store));
    fs.renameSync(`${file}.tmp`, file);
  }
  process.on('exit', () => saveTimer && save());

  // ---- protocol
  const hostCommands = {
    settings: (a) => store.setSettings(a.patch),
    start: () => store.start(),
    pause: () => store.pause(),
    resume: () => store.resume(),
    skip: () => store.skip(),
    end: () => store.end(),
    lobby: () => store.toLobby(),
    kick: (a) => store.kick(a.playerId),
    sitOut: (a) => store.setSitOut(a.playerId, a.value),
  };

  // player actions: event -> store method taking (playerId, payload)
  const actions = {
    choreStart: (id, a) => store.choreStart(id, a),
    choreDone: (id, a) => store.choreDone(id, a),
    report: (id, a) => store.report(id, a),
    bell: (id, a) => store.bell(id, a),
    here: (id) => store.here(id),
    vote: (id, a) => store.vote(id, a),
    kill: (id, a) => store.kill(id, a),
    undoDeath: (id) => store.undoDeath(id),
    storm: (id) => store.storm(id),
    stormFix: (id, a) => store.stormFix(id, a),
    confirmPhoto: (id, a) => store.confirmPhoto(id, a),
    sitOut: (id, a) => store.setSitOut(id, a.value),
  };

  nsp.on('connection', (socket) => {
    socket.data.playerId = null;
    push(socket);

    const signIn = (player, t) => {
      socket.data.playerId = player.id;
      socket.data.token = t;
      push(socket);
      flush(); // the host's list shows who's online
    };

    handle(socket, 'login', (payload) => {
      const { token, player } = store.login(payload);
      signIn(player, token);
      return { token, playerId: player.id };
    });

    handle(socket, 'resume', ({ token } = {}) => {
      const player = store.playerByToken(token);
      if (!player) throw new LakeError('Please sign in again');
      signIn(player, token);
      return { playerId: player.id, name: player.name };
    });

    handle(socket, 'signOut', () => {
      socket.data.playerId = null;
      socket.data.token = null;
      push(socket);
    });

    handle(socket, 'station', ({ code } = {}) => ({ station: store.station(code) }));
    handle(socket, 'gallery', () => store.gallery(socket.data.token ?? socket.data.hostToken));

    for (const [event, fn] of Object.entries(actions)) {
      handle(socket, event, (payload) => {
        if (!socket.data.playerId) throw new LakeError('Please sign in');
        return fn(socket.data.playerId, payload);
      });
    }

    handle(socket, 'host:login', ({ password, hostToken } = {}) => {
      if (!(hostToken && store.isHostToken(hostToken))) {
        if (!password || !isAdminPassword(password)) throw new LakeError('Wrong host password');
        hostToken = store.addHostToken();
      }
      socket.data.isHost = true;
      socket.data.hostToken = hostToken;
      push(socket);
      socket.emit('host', store.hostView(new Set([...nsp.sockets.values()].map((s) => s.data.playerId).filter(Boolean))));
      return { hostToken };
    });

    handle(socket, 'host', ({ cmd, args } = {}) => {
      if (!socket.data.isHost) throw new LakeError('Host only');
      const command = Object.hasOwn(hostCommands, cmd) ? hostCommands[cmd] : null;
      if (!command) throw new LakeError(`Unknown command: ${cmd}`);
      command(args ?? {});
    });

    socket.on('disconnect', () => {
      flushTimer ??= setTimeout(flush, 60);
    });
  });

  return { store, save };
}

function handle(socket, event, fn) {
  socket.on(event, (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      reply({ ok: true, ...(fn(payload ?? {}) ?? {}) });
    } catch (err) {
      if (err instanceof LakeError) reply({ ok: false, error: err.message });
      else {
        console.error(`[lake:${event}]`, err);
        reply({ ok: false, error: 'Internal server error' });
      }
    }
  });
}
