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

/** Admin commands that are always available. Games add their own via `game.adminCommands`. */
const CORE_ADMIN_COMMANDS = {
  createMarket: (ex, args) => {
    ex.createMarket(args);
  },
  halt: (ex, args) => forTargets(ex, args, (m) => m.status === 'open' && ex.setStatus(m.id, 'halted')),
  resume: (ex, args) => forTargets(ex, args, (m) => m.status === 'halted' && ex.setStatus(m.id, 'open')),
  settle: (ex, { marketId, price }) => ex.settleMarket(marketId, price),
  deleteMarket: (ex, args) => forTargets(ex, args, (m) => ex.deleteMarket(m.id)),
  cancelOrders: (ex, { marketId = null } = {}) => ex.cancelAll(null, marketId),
  endSession: (ex) => {
    ex.endSession();
  },
  createAccount: (ex, { name }) => {
    ex.createAccount(name);
  },
  setBankroll: (ex, { userId, amount }) => ex.setBankroll(userId, amount),
  setQuiz: (ex, { userId, amount }) => ex.setQuiz(userId, amount),
  resetPassword: (ex, { userId }) => ex.resetPassword(userId),
  addWager: (ex, { userId, amount, note }) => {
    ex.addWager(userId, amount, note);
  },
  setWagerBalance: (ex, { userId, amount }) => ex.setWagerBalance(userId, amount),
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
 * Start the exchange platform.
 *
 * platform:
 *   id            short slug, used for the save file and browser storage keys
 *   title         shown in the header
 *   config        Exchange config (startingBankroll, openSignup, maxPosition, maxOrderQty, ...)
 *   accounts      optional list of account names to create (players set their password on first sign-in)
 *   admins        optional account names that are admins; their password is always the admin password
 *   games         the games a session can run (see below)
 *   importFrom    optional older save files to import if this platform has no save file yet
 *
 * game:
 *   id, title     identify the game in the session picker
 *   rules         shown to players while a session of this game runs
 *   adminCommands { name: (exchange, args) => void }, callable from the admin UI while its session runs
 *   publicDir     optional folder served at /games/<id>/
 *   clientScripts optional files in publicDir loaded into the page, e.g. a custom admin panel
 */
export function createExchangeServer(platform, opts = {}) {
  const adminPassword = opts.adminPassword ?? process.env.ADMIN_PASSWORD ?? randomBytes(4).toString('hex');
  const dataFile = opts.dataFile === undefined ? (process.env.DATA_FILE ?? path.resolve('data', `${platform.id}.json`)) : opts.dataFile;
  const games = platform.games ?? [];

  const exchange = loadExchange(platform, dataFile);
  const adminTokens = new Set();
  const adminCommands = {
    ...CORE_ADMIN_COMMANDS,
    startSession: (ex, { name, gameId } = {}) => {
      if (!games.some((g) => g.id === gameId)) throw new ExchangeError('Pick a game for the session');
      ex.startSession({ name, gameId });
    },
  };
  // Game commands only run during a session of that game.
  for (const game of games) {
    for (const [cmd, fn] of Object.entries(game.adminCommands ?? {})) {
      adminCommands[cmd] = (ex, args) => {
        if (ex.activeSession()?.gameId !== game.id) throw new ExchangeError(`Start a ${game.title} session first`);
        return fn(ex, args);
      };
    }
  }

  // Admin accounts sign in with the admin password and get admin rights with it.
  const adminNames = new Set((platform.admins ?? []).map((n) => n.toLowerCase()));
  const isAdminAccount = (user) => adminNames.has(user.name.toLowerCase());
  if (adminNames.size && adminPassword.length < 4) throw new Error('ADMIN_PASSWORD must be at least 4 characters');
  for (const name of platform.admins ?? []) {
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
  for (const game of games) {
    if (game.publicDir) app.use(`/games/${game.id}`, express.static(game.publicDir));
  }
  app.get('/platform.json', (req, res) => {
    res.json({
      id: platform.id,
      title: platform.title,
      games: games.map((g) => ({ id: g.id, title: g.title, rules: g.rules ?? '' })),
      scripts: games.flatMap((g) => (g.clientScripts ?? []).map((file) => `/games/${g.id}/${file}`)),
    });
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

    handle(socket, 'history', () => exchange.history(requireUser()));

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
    return new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, () => {
        const actual = httpServer.address().port;
        if (!opts.quiet) printBanner(platform, actual, adminPassword, dataFile);
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

function loadExchange(platform, dataFile) {
  let exchange;
  const source = dataFile && [dataFile, ...(platform.importFrom ?? [])].find((f) => fs.existsSync(f));
  if (source) {
    exchange = Exchange.fromJSON(JSON.parse(fs.readFileSync(source, 'utf8')), platform.config);
    console.log(source === dataFile ? `Loaded saved state from ${dataFile}` : `Imported ${source} (saving to ${dataFile} from now on)`);
  } else {
    exchange = new Exchange(platform.config);
  }
  // also runs on saved state, so names added to the list later get accounts
  for (const name of platform.accounts ?? []) exchange.ensureAccount(name);
  return exchange;
}

function safeEqual(a, b) {
  const h = (s) => createHash('sha256').update(String(s)).digest();
  return timingSafeEqual(h(a), h(b));
}

function printBanner(platform, port, adminPassword, dataFile) {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${port}`);
  console.log(`\n  ${platform.title}`);
  console.log(`  On this computer:  http://localhost:${port}          admin: http://localhost:${port}/admin`);
  for (const url of lan) console.log(`  Same Wi-Fi:         ${url}     admin: ${url}/admin`);
  const admins = platform.admins?.length ? `, also the password for ${platform.admins.join(', ')}` : '';
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
