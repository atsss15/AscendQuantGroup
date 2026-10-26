/**
 * Copy this computer's data (accounts, chips, wagers, sessions, ranking, algo days) to another server,
 * e.g. the cloud host:   npm run migrate -- https://your-app.fly.dev
 *
 * It replaces the target's data, then waits for it to restart and checks the result.
 * Needs ADMIN_PASSWORD (from .env) to match the target's admin password.
 */
import fs from 'node:fs';
import path from 'node:path';

const target = process.argv[2]?.replace(/\/+$/, '');
const password = process.env.ADMIN_PASSWORD;
const dataDir = path.resolve(process.env.DATA_DIR ?? 'data');
if (!target || !/^https?:\/\//.test(target)) {
  console.log('Usage: npm run migrate -- https://your-app.fly.dev');
  process.exit(1);
}
if (!password) {
  console.log('ADMIN_PASSWORD is not set (put it in .env).');
  process.exit(1);
}

const files = {};
const add = (rel) => {
  const full = path.join(dataDir, rel);
  if (fs.existsSync(full)) files[rel] = fs.readFileSync(full).toString('base64');
};
add('ascend.json');
add('ranking.json');
add('algo/state.json');
const days = path.join(dataDir, 'algo', 'days');
if (fs.existsSync(days)) {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else add(path.relative(dataDir, full));
  });
  walk(days);
}
const mb = (Object.values(files).reduce((s, b) => s + b.length, 0) * 0.75) / 1048576;
console.log(`Sending ${Object.keys(files).length} files (${mb.toFixed(1)} MB) from ${dataDir} to ${target} …`);

const res = await fetch(`${target}/admin/restore`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${password}` },
  body: JSON.stringify({ files }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.log(`Failed: ${body.error ?? res.status}`);
  process.exit(1);
}
console.log('Uploaded. Waiting for the server to restart with the new data …');

await new Promise((r) => setTimeout(r, 3000));
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${target}/algo/api/accounts`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const { names } = await r.json();
      console.log(`Done. The server is back with ${names.length} accounts: ${names.join(', ')}`);
      process.exit(0);
    }
  } catch {
    // still restarting
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log('The server has not come back yet; check it in a minute.');
process.exit(1);
