/**
 * Run the shared server in the background, so closing the Terminal doesn't take the link down.
 *
 *   npm run share:bg   start it (with the public link), keep the Mac awake while it runs, print the link
 *   npm run link       print the current link
 *   npm run stop       stop it (it saves first)
 *
 * Output goes to data/server.log. The link still changes whenever the server restarts.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DATA = path.resolve(process.env.BG_DIR ?? 'data');
const LOG = path.join(DATA, 'server.log');
const PID = path.join(DATA, 'server.pid');
const PORT = Number(process.env.PORT ?? 3000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const runningPid = () => {
  const pid = Number(fs.existsSync(PID) ? fs.readFileSync(PID, 'utf8') : 0);
  return pid && alive(pid) ? pid : null;
};
const portInUse = () =>
  new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });

/** The newest link in the log, and whether the live check passed for it. */
function currentLink() {
  if (!fs.existsSync(LOG)) return null;
  const log = fs.readFileSync(LOG, 'utf8');
  const start = log.lastIndexOf('Share these links');
  if (start === -1) return null;
  const tail = log.slice(start);
  const url = tail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  const status = tail.includes('Link is live') ? 'live' : tail.includes("isn't reachable") ? 'dud' : 'checking';
  return url && { url, status };
}

function printLink(link) {
  console.log(`\n  Exchange:       ${link.url}`);
  console.log(`  Algo:           ${link.url}/algo`);
  console.log(`  Algo admin:     ${link.url}/algo (sign in as Attis)`);
  console.log(`  Ranking:        ${link.url}/rank`);
  console.log(`  Ranking admin:  ${link.url}/rank/admin`);
  console.log(
    link.status === 'live' ? '\n  ✓ The link is live.'
    : link.status === 'dud' ? '\n  ✗ Cloudflare gave a link that never went live. Run: npm run stop, then npm run share:bg'
    : '\n  … Still checking the link. Run `npm run link` again in a few seconds.',
  );
}

async function start() {
  if (runningPid()) {
    console.log('Already running in the background.');
    const link = currentLink();
    if (link) printLink(link);
    return;
  }
  if (await portInUse()) {
    console.log(`Port ${PORT} is busy, probably a server running in a Terminal window. Press Ctrl+C there first.`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(DATA, { recursive: true });
  fs.appendFileSync(LOG, `\n\n===== started ${new Date().toLocaleString()} =====\n`);
  const out = fs.openSync(LOG, 'a');
  const server = spawn(process.execPath, ['--env-file-if-exists=.env', 'server.js'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, SHARE: '1' },
  });
  server.unref();
  fs.writeFileSync(PID, String(server.pid));
  // keep the Mac from idle-sleeping for as long as the server runs
  spawn('caffeinate', ['-i', '-w', String(server.pid)], { detached: true, stdio: 'ignore' }).unref();

  console.log('Started in the background. You can close this Terminal. Waiting for the link…');
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (!alive(server.pid)) {
      console.log(`The server stopped right away. See ${LOG}`);
      process.exitCode = 1;
      return;
    }
    const link = currentLink();
    if (link && link.status !== 'checking') return printLink(link);
  }
  const link = currentLink();
  if (link) printLink(link);
  else console.log(`No link yet. Check ${LOG}, or run \`npm run link\` in a moment.`);
}

async function stop() {
  const pid = runningPid();
  if (!pid) {
    console.log('No background server is running.');
    return;
  }
  process.kill(pid, 'SIGTERM'); // the server saves, then exits (and its tunnel with it)
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
  fs.rmSync(PID, { force: true });
  console.log(alive(pid) ? 'Asked it to stop; it is still shutting down.' : 'Stopped. Everything was saved.');
}

function link() {
  if (!runningPid()) {
    console.log('No background server is running. Start it with: npm run share:bg');
    return;
  }
  const l = currentLink();
  if (l) printLink(l);
  else console.log(`Running, but no link yet. Check ${LOG}`);
}

const command = process.argv[2];
if (command === 'start') await start();
else if (command === 'stop') await stop();
else if (command === 'link') link();
else console.log('Usage: node tools/background.js start | stop | link');
