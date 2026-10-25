/**
 * Offline helpers for the algo competition (run with the server stopped, since it keeps its own copy of the state).
 *
 *   npm run algo:reset-data      delete the data days and generate 3 fresh ones (10,000 ticks each), then export
 *   npm run algo:export          zip the data days for players: prices/trades CSVs (Prosperity names),
 *                                datamodel.py and the starter trader.py → data/algo/export/AscendAlgo_data.zip
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AlgoService } from './service.js';
import { competition, competitionSource } from './competition.js';

const dir = process.env.ALGO_DATA_DIR ?? path.resolve('data', 'algo');
const [command, arg] = process.argv.slice(2);

async function serverRunning(port = Number(process.env.PORT ?? 3000)) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });
}

function exportData(service) {
  const days = service.state.days.filter((d) => d.practice).sort((a, b) => a.day - b.day);
  if (!days.length) throw new Error('No data days yet. Run: npm run algo:reset-data');
  const out = path.join(dir, 'export', 'AscendAlgo_data');
  fs.rmSync(path.join(dir, 'export'), { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const d of days) {
    fs.copyFileSync(service.dataFile(d.day, 'prices'), path.join(out, `prices_round_0_day_${d.day}.csv`));
    fs.copyFileSync(service.dataFile(d.day, 'trades'), path.join(out, `trades_round_0_day_${d.day}.csv`));
  }
  fs.copyFileSync(fileURLToPath(new URL('./py/datamodel.py', import.meta.url)), path.join(out, 'datamodel.py'));
  fs.writeFileSync(path.join(out, 'trader.py'), competition.template);
  execFileSync('zip', ['-qr', 'AscendAlgo_data.zip', 'AscendAlgo_data'], { cwd: path.join(dir, 'export') });
  const zip = path.join(dir, 'export', 'AscendAlgo_data.zip');
  console.log(`Exported ${days.length} data days (${days.map((d) => d.day).join(', ')}) → ${zip}`);
}

if (await serverRunning()) {
  console.error('The server is running. Stop it first (Ctrl+C in its window), otherwise it would overwrite these changes.');
  process.exit(1);
}
const service = new AlgoService({ config: competition, dir });

if (command === 'reset-data') {
  const count = Number(arg ?? 3);
  console.log(`Design: ${competitionSource} · ${competition.ticks} ticks per day`);
  for (const d of service.state.days.filter((x) => x.practice)) service.deleteDay(d.day);
  for (let i = 0; i < count; i++) {
    const rec = await service.runDay({ practice: true });
    console.log(`  data day ${rec.day}: ${rec.trades} trades`);
  }
  exportData(service);
} else if (command === 'export') {
  exportData(service);
} else {
  console.log('Usage: node algo/tools.js reset-data [count] | export');
}
