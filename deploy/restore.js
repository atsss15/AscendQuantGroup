import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

/**
 * Moving data between servers (e.g. laptop → cloud) with `npm run migrate -- <url>`.
 *
 * POST /admin/restore (Authorization: Bearer <ADMIN_PASSWORD>) with { files: { "relative/path": base64 } }
 * stages the files in <dataDir>/.restore and restarts the server. On the next boot, before anything
 * loads, applyPendingRestore() swaps them in, so the old in-memory state can't overwrite them.
 */
const ALLOWED = /^(ascend\.json|ranking\.json|algo\/state\.json|algo\/days\/[-\w]+\/[\w./-]+)$/;

export function applyPendingRestore(dataDir) {
  const staging = path.join(dataDir, '.restore');
  if (!fs.existsSync(path.join(staging, '.complete'))) {
    fs.rmSync(staging, { recursive: true, force: true }); // half-written upload: ignore it
    return false;
  }
  fs.rmSync(path.join(staging, '.complete'));
  if (fs.existsSync(path.join(staging, 'algo'))) fs.rmSync(path.join(dataDir, 'algo'), { recursive: true, force: true });
  for (const file of listFiles(staging)) {
    const rel = path.relative(staging, file);
    fs.mkdirSync(path.dirname(path.join(dataDir, rel)), { recursive: true });
    fs.renameSync(file, path.join(dataDir, rel));
  }
  fs.rmSync(staging, { recursive: true, force: true });
  console.log(`Restored data uploaded with npm run migrate into ${dataDir}`);
  return true;
}

export function attachRestore(app, { isAdminPassword, dataDir }) {
  app.post('/admin/restore', express.json({ limit: '200mb' }), (req, res) => {
    const password = req.get('authorization')?.replace(/^Bearer /, '');
    if (!password || !isAdminPassword(password)) return res.status(401).json({ error: 'Wrong admin password' });
    const files = req.body?.files;
    if (!files || typeof files !== 'object' || !Object.keys(files).length) return res.status(400).json({ error: 'No files' });
    for (const rel of Object.keys(files)) {
      if (!ALLOWED.test(rel) || rel.includes('..')) return res.status(400).json({ error: `Not allowed: ${rel}` });
    }
    const staging = path.join(dataDir, '.restore');
    fs.rmSync(staging, { recursive: true, force: true });
    for (const [rel, b64] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(staging, rel)), { recursive: true });
      fs.writeFileSync(path.join(staging, rel), Buffer.from(b64, 'base64'));
    }
    fs.writeFileSync(path.join(staging, '.complete'), '');
    res.json({ ok: true, files: Object.keys(files).length, restarting: true });
    // exit without saving the old state; the host restarts the server and the staged files are applied
    setTimeout(() => process.exit(75), 300);
  });
}

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
