import { fileURLToPath } from 'node:url';
import { ExchangeError } from '../../exchange/index.js';

/**
 * Smash Bros binary options.
 * Each match has one contract per player that settles to 100 if that player wins, 0 otherwise.
 */
export const smash = {
  id: 'smash',
  title: 'Smash Exchange',
  rules:
    'Each match lists one contract per player. A contract settles to 100 if that player wins the match and 0 otherwise, ' +
    'so the price is the market\'s implied win probability. Post bids and offers, or hit/lift what is there. ' +
    'P&L = cash from trades + position × mark.',
  config: {
    maxPosition: 50,
    maxOrderQty: 50,
    market: { min: 0, max: 100, tick: 1 },
  },
  publicDir: fileURLToPath(new URL('./public', import.meta.url)),
  clientScripts: ['/game/admin.js'],

  adminCommands: {
    createMatch(ex, { name, players } = {}) {
      const list = (Array.isArray(players) ? players : String(players ?? '').split(','))
        .map((p) => String(p).trim().slice(0, 40))
        .filter(Boolean);
      if (list.length < 2) throw new ExchangeError('A match needs at least 2 players');
      if (list.length > 8) throw new ExchangeError('At most 8 players per match');
      if (new Set(list.map((p) => p.toLowerCase())).size !== list.length) throw new ExchangeError('Player names must be different');

      const matchCount = new Set([...ex.markets.values()].filter((m) => m.meta?.matchId).map((m) => m.meta.matchId)).size;
      const group = { id: ex.nextId('match'), name: String(name ?? '').trim().slice(0, 60) || `Match ${matchCount + 1}` };
      for (const player of list) {
        ex.createMarket({
          name: player,
          group,
          description: `Settles to 100 if ${player} wins ${group.name}, otherwise 0.`,
          min: 0,
          max: 100,
          tick: 1,
          meta: { matchId: group.id, player, players: list },
        });
      }
    },

    settleMatch(ex, { matchId, winner } = {}) {
      const markets = ex.marketsInGroup(matchId);
      if (!markets.length) throw new ExchangeError('Unknown match');
      const win = markets.find((m) => m.meta.player === winner);
      if (!win) throw new ExchangeError(`${winner} is not in this match`);
      for (const m of markets) {
        if (m.status !== 'settled') ex.settleMarket(m.id, m === win ? 100 : 0);
      }
    },
  },
};
