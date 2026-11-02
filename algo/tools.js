/**
 * Offline helpers for the algo competition (run with the server stopped, since it keeps its own copy of the state).
 *
 *   npm run algo:reset-data      delete the data days and generate 3 fresh ones (10,000 ticks each), then export
 *   npm run algo:export          zip every released day for players: prices/trades/observations CSVs (Prosperity names)
 *                                and datamodel.py → data/algo/export/round_<n>_<key>.zip
 */
import net from 'node:net';
import path from 'node:path';
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

async function exportData(service) {
  const file = await service.dataZip();
  console.log(`Exported ${service.state.days.length} days → ${file}`);
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
  await exportData(service);
} else if (command === 'export') {
  await exportData(service);
} else {
  console.log('Usage: node algo/tools.js reset-data [count] | export');
}
