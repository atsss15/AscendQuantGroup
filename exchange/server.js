import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
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
  createAccount: (ex, { name }) => {
    ex.createAccount(name);
  },
  setBankroll: (ex, { userId, amount }) => ex.setBankroll(userId, amount),
  resetPassword: (ex, { userId }) => ex.resetPassword(userId),
  addWager: (ex, { userId, amount, note }) => {
    ex.addWager(userId, amount, note);
  },
  deleteWager: (ex, { wagerId }) => ex.deleteWager(wagerId),
  markWagersPaid: (ex, { userId }) => ex.markWagersPaid(userId),
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
 *   config        Exchange config (startingBankroll, openSignup, maxPosition, maxOrderQty, market: { min, max, tick }, ...)
 *   accounts      optional list of account names to create (players set their password on first sign-in)
 *   admins        optional account names that are admins; their password is always the admin password
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

  // Admin accounts sign in with the admin password and get admin rights with it.
  const adminNames = new Set((game.admins ?? []).map((n) => n.toLowerCase()));
  const isAdminAccount = (user) => adminNames.has(user.name.toLowerCase());
  if (adminNames.size && adminPassword.length < 4) throw new Error('ADMIN_PASSWORD must be at least 4 characters');
  for (const name of game.admins ?? []) {
    exchange.setPassword(exchange.ensureAccount(name).id, adminPassword);
  }
  const resetPassword = adminCommands.resetPassword;
  adminCommands.resetPassword = (ex, args) => {
    if (isAdminAccount(ex.getUser(args.userId))) throw new ExchangeError('Admin accounts use ADMIN_PASSWORD; change it there');
    resetPassword(ex, args);
  };

  const app = express();
  app.use(express.static(CORE_PUBLIC));
  app.get('/admin', (req, res) => res.sendFile(path.join(CORE_PUBLIC, 'index.html')));
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

  // password reset: kick that account's open sessions
  exchange.on('signout', (userId) => {
    for (const socket of io.of('/').sockets.values()) {
      if (socket.data.userId !== userId) continue;
      socket.data.userId = null;
      socket.data.isAdmin = !!socket.data.adminByPassword;
      socket.emit('signedOut', { reason: 'Your password was reset by the admin. Sign in again.' });
    }
  });

  function flush() {
    flushTimer = null;
    io.emit('state', exchange.publicState());
    const sockets = [...io.of('/').sockets.values()];
    const cache = new Map();
    for (const socket of sockets) {
      const id = socket.data.userId;
      if (!id) continue;
      if (!cache.has(id)) cache.set(id, exchange.userState(id));
      socket.emit('me', cache.get(id));
    }
    const admins = sockets.filter((s) => s.data.isAdmin);
    if (admins.length) {
      const online = new Set(sockets.map((s) => s.data.userId).filter(Boolean));
      const state = exchange.adminState();
      for (const a of state.accounts) {
        a.online = online.has(a.id);
        a.admin = adminNames.has(a.name.toLowerCase());
      }
      for (const socket of admins) socket.emit('admin', state);
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
      const { user, firstSignIn } = exchange.join(payload);
      socket.data.userId = user.id;
      socket.data.isAdmin = socket.data.adminByPassword || isAdminAccount(user);
      socket.emit('me', exchange.userState(user.id));
      flushTimer ??= setTimeout(flush, 50); // update admins' online list and send the admin view
      return { user: { id: user.id, name: user.name, token: user.token }, firstSignIn: !!firstSignIn, isAdmin: socket.data.isAdmin };
    });

    handle(socket, 'signOut', () => {
      socket.data.userId = null;
      socket.data.isAdmin = !!socket.data.adminByPassword;
      flushTimer ??= setTimeout(flush, 50);
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
        socket.data.isAdmin = socket.data.adminByPassword = true;
        return { adminToken };
      }
      if (!password || !safeEqual(password, adminPassword)) throw new ExchangeError('Wrong admin password');
      const token = randomBytes(16).toString('hex');
      adminTokens.add(token);
      socket.data.isAdmin = socket.data.adminByPassword = true;
      flushTimer ??= setTimeout(flush, 50); // send the admin view
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
        if (opts.share ?? process.env.SHARE) startTunnel(actual);
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
  let exchange;
  if (dataFile && fs.existsSync(dataFile)) {
    exchange = Exchange.fromJSON(JSON.parse(fs.readFileSync(dataFile, 'utf8')), game.config);
    console.log(`Loaded saved state from ${dataFile}`);
  } else {
    exchange = new Exchange(game.config);
    game.setup?.(exchange);
  }
  // also runs on saved games, so names added to the list later get accounts
  for (const name of game.accounts ?? []) exchange.ensureAccount(name);
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
  console.log(`  On this computer:  http://localhost:${port}          admin: http://localhost:${port}/admin`);
  for (const url of lan) console.log(`  Same Wi-Fi:         ${url}     admin: ${url}/admin`);
  const admins = game.admins?.length ? `, also the password for ${game.admins.join(', ')}` : '';
  console.log(`  Admin password: ${process.env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD in .env)' : `${adminPassword} (random; put ADMIN_PASSWORD in .env to choose one)`}${admins}`);
  console.log(`  Saving to: ${dataFile || '(not persisted)'}\n`);
}

/** Expose the server publicly through a Cloudflare quick tunnel and print the links to share. */
function startTunnel(port) {
  console.log('  Starting public tunnel…');
  const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`]);
  let shown = false;
  const scan = (chunk) => {
    const url = !shown && String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
    if (!url) return;
    shown = true;
    console.log('\n  ================ Share these links ================');
    console.log(`  Players:  ${url}`);
    console.log(`  Admin:    ${url}/admin`);
    console.log('  (valid while this terminal stays open)\n');
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
  child.on('error', (err) => {
    if (err.code === 'ENOENT') console.log('  Could not start the tunnel: install it with `brew install cloudflared`, then run `npm run share` again.');
    else console.log(`  Tunnel error: ${err.message}`);
  });
  process.on('exit', () => child.kill());
}
