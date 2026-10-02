import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { Exchange, ExchangeError } from './exchange.js';

const CORE_PUBLIC = fileURLToPath(new URL('./public', import.meta.url));

/** Admin commands every game gets. Games add their own via `game.adminCommands`. */
const CORE_ADMIN_COMMANDS = {
  createMarket: (ex, args) => {
    ex.createMarket(args);
  },
  halt: (ex, args) => forTargets(ex, args, (m) => m.status === 'open' && ex.setStatus(m.id, 'halted')),
  resume: (ex, args) => forTargets(ex, args, (m) => m.status === 'halted' && ex.setStatus(m.id, 'open')),
  settle: (ex, { marketId, price }) => ex.settleMarket(marketId, price),
  deleteMarket: (ex, { marketId }) => ex.deleteMarket(marketId),
  cancelOrders: (ex, { marketId = null } = {}) => ex.cancelAll(null, marketId),
};

/** Apply fn to one market ({ marketId }) or a whole group ({ groupId }). */
function forTargets(ex, { marketId, groupId } = {}, fn) {
  const markets = groupId ? ex.marketsInGroup(groupId) : [ex.getMarket(marketId)];
  if (!markets.length) throw new ExchangeError('No markets in that group');
  markets.forEach(fn);
}

/**
 * Start an exchange for a game.
 *
 * A game is a plain object:
 *   id            short slug, used for the save file and browser storage keys
 *   title         shown in the header
 *   rules         optional text shown to players
 *   config        Exchange config (maxPosition, maxOrderQty, market: { min, max, tick }, ...)
 *   adminCommands { name: (exchange, args) => void }, callable from the admin UI
 *   publicDir     optional folder served at /game/
 *   clientScripts optional scripts (under /game/) loaded into the page, e.g. a custom admin panel
 *   setup(exchange) optional, runs once when no save file exists
 */
export function createExchangeServer(game, opts = {}) {
  const adminPassword = opts.adminPassword ?? process.env.ADMIN_PASSWORD ?? randomBytes(4).toString('hex');
  const dataFile = opts.dataFile === undefined ? (process.env.DATA_FILE ?? path.resolve('data', `${game.id}.json`)) : opts.dataFile;

  const exchange = loadExchange(game, dataFile);
  const adminCommands = { ...CORE_ADMIN_COMMANDS, ...game.adminCommands };
  const adminTokens = new Set();

  const app = express();
  app.use(express.static(CORE_PUBLIC));
  if (game.publicDir) app.use('/game', express.static(game.publicDir));
  app.get('/game.json', (req, res) => {
    res.json({ id: game.id, title: game.title, rules: game.rules ?? '', scripts: game.clientScripts ?? [] });
  });

  const httpServer = http.createServer(app);
  const io = new Server(httpServer);

  // ---- broadcasting: coalesce bursts of changes into one push every ~50ms
  let flushTimer = null;
  exchange.on('change', () => {
    flushTimer ??= setTimeout(flush, 50);
  });

  function flush() {
    flushTimer = null;
    io.emit('state', exchange.publicState());
    const cache = new Map();
    for (const socket of io.of('/').sockets.values()) {
      const id = socket.data.userId;
      if (!id) continue;
      if (!cache.has(id)) cache.set(id, exchange.userState(id));
      socket.emit('me', cache.get(id));
    }
    scheduleSave();
  }

  // ---- persistence: debounced write so a restart doesn't wipe the game
  let saveTimer = null;
  function scheduleSave() {
    if (!dataFile) return;
    saveTimer ??= setTimeout(save, 1000);
  }
  function save() {
    saveTimer = null;
    if (!dataFile) return;
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    const tmp = `${dataFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(exchange));
    fs.renameSync(tmp, dataFile);
  }

  // ---- socket protocol
  io.on('connection', (socket) => {
    socket.emit('state', exchange.publicState());

    const requireUser = () => {
      if (!socket.data.userId) throw new ExchangeError('Join first');
      return socket.data.userId;
    };

    handle(socket, 'join', (payload) => {
      const user = exchange.join(payload);
      socket.data.userId = user.id;
      socket.emit('me', exchange.userState(user.id));
      return { user: { id: user.id, name: user.name, token: user.token } };
    });

    handle(socket, 'order', (payload) => {
      const { order, trades } = exchange.placeOrder(requireUser(), payload);
      return { order: exchange.orderView(order), filled: trades.reduce((n, t) => n + t.qty, 0) };
    });

    handle(socket, 'cancel', ({ orderId } = {}) => {
      exchange.cancelOrder(requireUser(), orderId);
    });

    handle(socket, 'cancelAll', ({ marketId = null } = {}) => ({ cancelled: exchange.cancelAll(requireUser(), marketId) }));

    handle(socket, 'admin:login', ({ password, adminToken } = {}) => {
      if (adminToken && adminTokens.has(adminToken)) {
        socket.data.isAdmin = true;
        return { adminToken };
      }
      if (!password || !safeEqual(password, adminPassword)) throw new ExchangeError('Wrong admin password');
      const token = randomBytes(16).toString('hex');
      adminTokens.add(token);
      socket.data.isAdmin = true;
      return { adminToken: token };
    });

    handle(socket, 'admin', ({ cmd, args } = {}) => {
      if (!socket.data.isAdmin) throw new ExchangeError('Admin only');
      const command = Object.hasOwn(adminCommands, cmd) ? adminCommands[cmd] : null;
      if (!command) throw new ExchangeError(`Unknown admin command: ${cmd}`);
      command(exchange, args ?? {});
    });
  });

  function listen(port = opts.port ?? process.env.PORT ?? 3000) {
    return new Promise((resolve) => {
      httpServer.listen(port, () => {
        const actual = httpServer.address().port;
        if (!opts.quiet) printBanner(game, actual, adminPassword, dataFile);
        resolve(actual);
      });
    });
  }

  async function close() {
    clearTimeout(flushTimer);
    if (saveTimer) {
      clearTimeout(saveTimer);
      save();
    }
    io.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }

  if (opts.handleSignals !== false) {
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.once(sig, () => {
        if (dataFile) save();
        process.exit(0);
      });
    }
  }

  return { app, io, httpServer, exchange, listen, close, save };
}

/** Register a socket event whose handler result (or error) goes back through the ack callback. */
function handle(socket, event, fn) {
  socket.on(event, (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      reply({ ok: true, ...(fn(payload ?? {}) ?? {}) });
    } catch (err) {
      if (err instanceof ExchangeError) reply({ ok: false, error: err.message });
      else {
        console.error(`[${event}]`, err);
        reply({ ok: false, error: 'Internal server error' });
      }
    }
  });
}

function loadExchange(game, dataFile) {
  if (dataFile && fs.existsSync(dataFile)) {
    const exchange = Exchange.fromJSON(JSON.parse(fs.readFileSync(dataFile, 'utf8')), game.config);
    console.log(`Loaded saved state from ${dataFile}`);
    return exchange;
  }
  const exchange = new Exchange(game.config);
  game.setup?.(exchange);
  return exchange;
}

function safeEqual(a, b) {
  const h = (s) => createHash('sha256').update(String(s)).digest();
  return timingSafeEqual(h(a), h(b));
}

function printBanner(game, port, adminPassword, dataFile) {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${port}`);
  console.log(`\n  ${game.title}`);
  console.log(`  Local:    http://localhost:${port}`);
  for (const url of lan) console.log(`  Network:  ${url}`);
  console.log(`  Admin password: ${adminPassword}${process.env.ADMIN_PASSWORD ? ' (from ADMIN_PASSWORD)' : ' (set ADMIN_PASSWORD to choose one)'}`);
  console.log(`  Saving to: ${dataFile || '(not persisted)'}\n`);
}
