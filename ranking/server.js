import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { RankingStore, RankingError } from './store.js';

const PUBLIC = fileURLToPath(new URL('./public', import.meta.url));

/**
 * Mount the peer-ranking app on an existing server: pages at /rank (raters) and /rank/admin,
 * live updates on the Socket.IO namespace /rank, state saved to its own file.
 *
 * @param {{ app: import('express').Express, io: import('socket.io').Server }} server
 * @param {{ isAdminPassword: (pw: string) => boolean, dataFile?: string | null }} opts
 */
export function attachRanking({ app, io }, { isAdminPassword, dataFile = path.resolve('data', 'ranking.json') } = {}) {
  const store = dataFile && fs.existsSync(dataFile) ? RankingStore.fromJSON(JSON.parse(fs.readFileSync(dataFile, 'utf8'))) : new RankingStore();
  const adminTokens = new Set();

  const page = (req, res) => res.sendFile(path.join(PUBLIC, 'index.html'));
  app.get('/rank', page);
  app.get('/rank/admin', page);
  app.use('/rank', express.static(PUBLIC));

  const nsp = io.of('/rank');

  // ---- push updates, coalesced
  let flushTimer = null;
  store.on('change', () => {
    flushTimer ??= setTimeout(flush, 80);
  });
  store.on('signout', (raterId) => {
    for (const socket of nsp.sockets.values()) {
      if (socket.data.raterId !== raterId) continue;
      socket.data.raterId = null;
      socket.emit('signedOut', { reason: 'The organizer reset your sign-in. Please sign in again.' });
    }
  });

  function flush() {
    flushTimer = null;
    const pub = store.publicView();
    let admin = null;
    for (const socket of nsp.sockets.values()) {
      socket.emit('eval', pub);
      if (socket.data.raterId) socket.emit('me', store.raterView(socket.data.raterId));
      if (socket.data.isAdmin) socket.emit('admin', (admin ??= store.adminView()));
    }
    scheduleSave();
  }

  // ---- persistence
  let saveTimer = null;
  function scheduleSave() {
    if (dataFile) saveTimer ??= setTimeout(save, 1000);
  }
  function save() {
    saveTimer = null;
    if (!dataFile) return;
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(`${dataFile}.tmp`, JSON.stringify(store));
    fs.renameSync(`${dataFile}.tmp`, dataFile);
  }
  process.on('exit', () => saveTimer && save());

  // ---- protocol
  const adminCommands = {
    create: (a) => store.createEvaluation(a),
    edit: (a) => store.editEvaluation(a.evaluationId, a),
    status: (a) => store.setStatus(a.evaluationId, a.status),
    publish: (a) => store.setPublished(a.evaluationId, a.published),
    setCurrent: (a) => store.setCurrent(a.evaluationId),
    delete: (a) => store.deleteEvaluation(a.evaluationId),
    resetRater: (a) => store.resetRater(a.evaluationId, a.raterId),
    removeRater: (a) => store.removeRater(a.evaluationId, a.raterId),
  };

  nsp.on('connection', (socket) => {
    socket.emit('eval', store.publicView());

    handle(socket, 'login', (payload) => {
      const rater = store.login(payload);
      socket.data.raterId = rater.id;
      socket.emit('me', store.raterView(rater.id));
      return { token: rater.token, name: rater.name };
    });

    handle(socket, 'signOut', () => {
      socket.data.raterId = null;
    });

    handle(socket, 'rank', (payload) => {
      if (!socket.data.raterId) throw new RankingError('Sign in first');
      store.submitRanking(socket.data.raterId, payload);
    });

    handle(socket, 'admin:login', ({ password, adminToken } = {}) => {
      if (adminToken && adminTokens.has(adminToken)) {
        socket.data.isAdmin = true;
      } else {
        if (!password || !isAdminPassword(password)) throw new RankingError('Wrong admin password');
        adminToken = randomBytes(16).toString('hex');
        adminTokens.add(adminToken);
        socket.data.isAdmin = true;
      }
      socket.emit('admin', store.adminView());
      return { adminToken };
    });

    handle(socket, 'admin', ({ cmd, args } = {}) => {
      if (!socket.data.isAdmin) throw new RankingError('Admin only');
      const command = Object.hasOwn(adminCommands, cmd) ? adminCommands[cmd] : null;
      if (!command) throw new RankingError(`Unknown command: ${cmd}`);
      command(args ?? {});
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
      if (err instanceof RankingError) reply({ ok: false, error: err.message });
      else {
        console.error(`[rank:${event}]`, err);
        reply({ ok: false, error: 'Internal server error' });
      }
    }
  });
}
