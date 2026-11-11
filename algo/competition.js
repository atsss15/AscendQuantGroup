import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * The competition design the server runs. The real design is kept out of the repo:
 *   1. ALGO_DESIGN_B64: the design file, base64-encoded, in an environment secret (used on the cloud host).
 *      It may be gzip-compressed before encoding (`gzip -9c design.js | base64`), to stay well under size limits.
 *   2. algo/secret/competition.js: git-ignored file (used on the laptop)
 *   3. competition.example.js: public placeholder, if neither exists
 */
async function load() {
  if (process.env.ALGO_DESIGN_B64) {
    const mod = await import(`data:text/javascript;base64,${designSource(process.env.ALGO_DESIGN_B64)}`);
    return { competition: mod.competition, source: 'ALGO_DESIGN_B64 secret' };
  }
  if (fs.existsSync(fileURLToPath(new URL('./secret/competition.js', import.meta.url)))) {
    return { competition: (await import('./secret/competition.js')).competition, source: './secret/competition.js' };
  }
  return { competition: (await import('./competition.example.js')).competition, source: './competition.example.js' };
}

/** The design's source as base64 from the secret's value: decompressed first if it was gzipped (magic bytes 1f 8b). */
export function designSource(b64) {
  const bytes = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  return bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString('base64') : bytes.toString('base64');
}

const loaded = await load();
export const competition = loaded.competition;
export const competitionSource = loaded.source;
