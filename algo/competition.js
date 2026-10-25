import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The competition design the server runs.
 *
 * The real design (prices, bots) lives in algo/secret/competition.js, which is git-ignored so it never
 * reaches GitHub. Without it, the public placeholder in competition.example.js is used.
 */
const secret = fileURLToPath(new URL('./secret/competition.js', import.meta.url));
const source = fs.existsSync(secret) ? './secret/competition.js' : './competition.example.js';

export const competition = (await import(source)).competition;
export const competitionSource = source;
