import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { AlgoService, AlgoError } from './service.js';
import { ExchangeError } from '../exchange/exchange.js';

const PUBLIC = fileURLToPath(new URL('./public', import.meta.url));

/**
 * Mount the algo competition on the exchange server: pages at /algo, JSON API at /algo/api.
 * Players sign in with their exchange account; exchange admin accounts are competition admins.
 *
 * @param {object} server   what createExchangeServer returns
 * @param {{ config: object, dir?: string }} opts
 */
export function attachAlgo(server, { config, dir = path.resolve('data', 'algo') }) {
  const { app, exchange, authenticate } = server;
  const service = new AlgoService({ config, dir });
  const names = (id) => exchange.users.get(id)?.name ?? '(removed)';

  const api = express.Router();
  api.use(express.json({ limit: '1mb' }));

  // sign in with an exchange account (same token works on the exchange)
  api.get('/accounts', (req, res) => res.json({ names: [...exchange.users.values()].map((u) => u.name).sort() }));
  api.post('/login', wrap((req) => {
    const { user, firstSignIn } = exchange.join({ name: req.body?.name, password: req.body?.password });
    return { token: user.token, name: user.name, firstSignIn: !!firstSignIn };
  }));

  // everything below needs a signed-in player
  api.use((req, res, next) => {
    const token = req.get('authorization')?.replace(/^Bearer /, '') || req.query.token;
    const auth = authenticate(token);
    if (!auth) return res.status(401).json({ error: 'Please sign in' });
    req.user = auth.user;
    req.isAdmin = auth.isAdmin;
    next();
  });

  api.get('/me', wrap((req) => ({ name: req.user.name, isAdmin: req.isAdmin, ...service.playerView(req.user.id, names) })));
  api.put('/draft', wrap((req) => service.saveDraft(req.user.id, req.body?.code)));
  api.post('/submit', wrap((req) => service.submit(req.user.id, req.body?.code)));
  api.post('/backtest', wrap((req) => service.backtest(req.user.id, req.body?.code, req.body?.day)));
  api.get('/days/:day/:kind.csv', (req, res) => {
    const kind = req.params.kind;
    if (!['prices', 'trades', 'own'].includes(kind)) return res.status(404).end();
    sendFile(res, () => service.dataFile(req.params.day, kind, req.user.id), `${kind === 'own' ? 'my_trades' : kind}_day_${req.params.day}.csv`);
  });
  api.get('/days/:day/log.txt', (req, res) => sendFile(res, () => service.dataFile(req.params.day, 'log', req.user.id), `my_log_day_${req.params.day}.txt`));

  // admin
  const admin = express.Router();
  admin.use((req, res, next) => (req.isAdmin ? next() : res.status(403).json({ error: 'Admin only' })));
  admin.get('/', wrap(() => ({ ...service.adminView(names), lastError: service.lastError ?? null })));
  admin.post('/run', wrap((req) => {
    // runs in the background; the page polls /algo/api/admin for progress
    if (service.running) throw new AlgoError(`Day ${service.running.day} is already running`);
    service.lastError = null;
    service.runDay({ practice: !!req.body?.practice }).catch((err) => {
      service.lastError = err.message;
      if (!(err instanceof AlgoError)) console.error('[algo run]', err);
    });
    return { started: true };
  }));
  admin.post('/deadline', wrap((req) => service.setDeadline(req.body?.text)));
  admin.post('/practice-mode', wrap((req) => service.setPracticeMode(req.body?.on)));
  admin.post('/days/:day/counts', wrap((req) => service.setDayCounts(req.params.day, req.body?.counts)));
  admin.delete('/days/:day', wrap((req) => service.deleteDay(req.params.day)));
  admin.get('/days/:day/code/:userId', (req, res) => sendFile(res, () => service.dataFile(req.params.day, 'code', req.params.userId), `day_${req.params.day}_${names(req.params.userId)}.py`));
  admin.get('/days/:day/log/:userId', (req, res) => sendFile(res, () => service.dataFile(req.params.day, 'log', req.params.userId), `day_${req.params.day}_${names(req.params.userId)}.log`));
  admin.get('/submissions/:userId', (req, res) => {
    const sub = service.state.submissions[req.params.userId];
    if (!sub) return res.status(404).json({ error: 'No submission' });
    res.type('text/plain').send(sub.code);
  });
  api.use('/admin', admin);

  app.use('/algo/api', api);
  app.get(['/algo', '/algo/'], (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
  app.use('/algo', express.static(PUBLIC));
  return service;
}

/** Run a handler; send its result as JSON, or a 400 with the message for expected errors. */
function wrap(fn) {
  return async (req, res) => {
    try {
      res.json((await fn(req)) ?? { ok: true });
    } catch (err) {
      if (err instanceof AlgoError || err instanceof ExchangeError) res.status(400).json({ error: err.message });
      else {
        console.error('[algo]', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  };
}

function sendFile(res, locate, downloadName) {
  try {
    res.download(locate(), downloadName);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
}
