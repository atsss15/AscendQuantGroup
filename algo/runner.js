import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOST = fileURLToPath(new URL('./py/host.py', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The project's .venv Python if it exists (has numpy/pandas), else ALGO_PYTHON, else python3. */
export function pythonPath() {
  if (process.env.ALGO_PYTHON) return process.env.ALGO_PYTHON;
  const venv = path.join(ROOT, '.venv', 'bin', 'python');
  return fs.existsSync(venv) ? venv : 'python3';
}

/**
 * Start a player's Trader in its own Python process (see py/host.py for the sandbox).
 *
 * run(state) resolves with { orders, traderData, logs, error }. A call slower than timeLimitMs counts as
 * no orders; a call that hangs past the hard limit, or a crash, stops the algorithm for the rest of the day.
 */
export async function startAgent({ name, code, timeLimitMs = 400, cpuSeconds = 300, startupMs = 20000 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-'));
  const child = spawn(pythonPath(), ['-I', '-B', HOST], {
    cwd: dir,
    env: { PATH: '/usr/bin:/bin', HOME: dir, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });

  let dead = null; // reason the algorithm stopped
  let deadReported = false;
  let waiting = null;
  let buffer = '';
  let stderr = '';
  child.stdio[3].setEncoding('utf8');
  child.stdio[3].on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        msg = { error: 'unreadable reply from your algorithm' };
      }
      const w = waiting;
      waiting = null;
      w?.resolve(msg);
    }
  });
  // prints outside Trader.run, and Python's own errors
  child.stdout.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  child.stdin.on('error', () => {});
  child.on('exit', (code, signal) => {
    if (!dead) dead = signal === 'SIGXCPU' || signal === 'SIGKILL' ? `stopped: used more than ${cpuSeconds}s of CPU time` : `stopped unexpectedly (exit ${code ?? signal})${stderr ? `: ${tail(stderr)}` : ''}`;
    waiting?.resolve(null);
    waiting = null;
  });

  const request = (line, ms) =>
    new Promise((resolve) => {
      const started = Date.now();
      const timer = setTimeout(() => {
        waiting = null;
        resolve({ timeout: true });
      }, ms);
      waiting = {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg && { ...msg, ms: Date.now() - started });
        },
      };
      child.stdin.write(line + '\n');
    });

  const close = () => {
    if (!child.killed) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  };

  // load the code
  const hello = await request(JSON.stringify({ code, cpuSeconds }), startupMs);
  let startupLogs = [];
  if (!hello || hello.timeout || hello.fatal) {
    dead = hello?.fatal ?? (hello?.timeout ? `took longer than ${startupMs / 1000}s to start` : dead ?? 'failed to start');
    startupLogs = hello?.logs ?? [];
    close();
  } else startupLogs = hello.logs ?? [];

  const hardLimit = Math.max(2000, timeLimitMs * 5);
  return {
    name,
    startupLogs,
    get dead() {
      return dead;
    },
    async run(state) {
      if (dead) {
        if (deadReported) return { orders: [] };
        deadReported = true;
        return { orders: [], error: dead, logs: startupLogs };
      }
      const reply = await request(JSON.stringify(state), hardLimit);
      if (!reply) return { orders: [], error: dead };
      if (reply.timeout) {
        dead = `stopped: Trader.run took longer than ${hardLimit}ms`;
        deadReported = true;
        close();
        return { orders: [], error: dead };
      }
      const logs = startupLogs.length ? [...startupLogs, ...(reply.logs ?? [])] : reply.logs;
      startupLogs = [];
      if (reply.ms > timeLimitMs) {
        return { orders: [], traderData: reply.traderData, logs, error: `Trader.run took ${reply.ms}ms (limit ${timeLimitMs}ms); orders ignored this tick` };
      }
      return { orders: reply.orders, traderData: reply.traderData, logs, error: reply.error };
    },
    close,
  };
}

function tail(text) {
  return text.trim().split('\n').slice(-6).join('\n');
}
