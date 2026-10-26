import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The competition design the server runs. The real design is kept out of the repo:
 *   1. ALGO_DESIGN_B64: the design file, base64-encoded, in an environment secret (used on the cloud host)
 *   2. algo/secret/competition.js: git-ignored file (used on the laptop)
 *   3. competition.example.js: public placeholder, if neither exists
 */
async function load() {
  if (process.env.ALGO_DESIGN_B64) {
    const mod = await import(`data:text/javascript;base64,${process.env.ALGO_DESIGN_B64}`);
    return { competition: mod.competition, source: 'ALGO_DESIGN_B64 secret' };
  }
  if (fs.existsSync(fileURLToPath(new URL('./secret/competition.js', import.meta.url)))) {
    return { competition: (await import('./secret/competition.js')).competition, source: './secret/competition.js' };
  }
  return { competition: (await import('./competition.example.js')).competition, source: './competition.example.js' };
}

const loaded = await load();
export const competition = loaded.competition;
export const competitionSource = loaded.source;
