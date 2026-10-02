import { fileURLToPath } from 'node:url';
import { createExchangeServer } from './exchange/index.js';
import { smash } from './games/smash/game.js';

/**
 * Ascend Exchange: one platform, persistent accounts, one session per game night.
 * To add a game, write games/<name>/game.js (see games/smash) and add it to `games`.
 */
export const platform = {
  id: 'ascend',
  title: 'Ascend Exchange',
  config: {
    startingBankroll: 1000, // chips each account starts with
    openSignup: false, // only the accounts below can sign in; the admin can add more
    maxPosition: 50,
    maxOrderQty: 50,
  },
  admins: ['Attis'], // signs in with ADMIN_PASSWORD (set in .env) and gets the admin controls
  // Each person sets their own password the first time they sign in.
  accounts: ['Ashley', 'Paul', 'Frank', 'Jay', 'Thomas', 'Attis', 'Susie', 'Derrick', 'Arien', 'Buju', 'Jerry', 'Harry', 'Carl'],
  games: [smash],
  importFrom: ['data/smash.json'], // save file from before sessions existed
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createExchangeServer(platform)
    .listen()
    .catch((err) => {
      if (err.code !== 'EADDRINUSE') throw err;
      console.error(`\n  Port ${err.port} is already in use, probably by another copy of the server that is still running.`);
      console.error('  Stop it with Ctrl+C in its Terminal window (or quit that window), then try again.');
      console.error(`  To see what is using it: lsof -i :${err.port}\n`);
      process.exit(1);
    });
}
