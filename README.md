# AscendQuantGroup
Trading games and tools for Emory Ascend Quant Group

## Exchange

A small real-time exchange: every market has a live central limit order book. Players post bids and asks, or hit the bid / lift the offer. Anyone with the link can join with a name, and there is no account setup.

```bash
npm install
ADMIN_PASSWORD=pick-something npm start      # Smash game on http://localhost:3000
npm test
```

The startup banner prints the local URL, your LAN URL (people on the same Wi‑Fi can use it directly), and the admin password. If `ADMIN_PASSWORD` is not set, a random password is generated and printed.

### Sharing a link with people elsewhere

The server is a single Node process with WebSockets, so any of these work:

- **Quick tunnel (no deploy):** run `cloudflared tunnel --url http://localhost:3000` (`brew install cloudflared`) and send people the `https://….trycloudflare.com` URL it prints. Your laptop has to stay on.
- **Host it:** Render, Railway and Fly.io all run it as is. Use start command `npm start`, set `ADMIN_PASSWORD`, and they provide `PORT`. Mount a disk and point `DATA_FILE` at it if you want state to survive redeploys.

### How it works

| | |
|---|---|
| Matching | Price-time priority. Trades happen at the resting order's price. Self-trades are prevented by cancelling your own resting order. |
| Orders | `GTC` limit orders rest on the book. Hit/Lift sends an `IOC` at the current best price, and any unfilled part is cancelled. |
| Accounting | P&L only, no cash balances. P&L = cash from trades + position × mark. The mark is the last trade, clamped to the current bid/ask. On settlement every position is paid out at the settlement price. |
| Risk | `maxPosition` per market counts resting orders as if they had filled. `maxOrderQty` caps the size of a single order. |
| Persistence | State is saved to `data/<game>.json` (or `DATA_FILE`) about a second after each change and reloaded on restart. Delete the file to reset the game. |
| Identity | Joining stores a token in the browser, so a refresh or reconnect brings you back as the same player. |

### Smash Bros binary options (`games/smash`)

Log in through **Admin** and use **Smash matches** to list a match: give it an optional name and 2–8 players. Each player gets a contract that settles at **100 if they win, 0 otherwise**. Halt trading with **Halt all** on the match header. When the match is over, pick the winner and press **Settle**. **Rematch** lists the same players again.

Defaults are in [games/smash/game.js](games/smash/game.js): position limit ±50 per contract, max order size 50, prices 0–100 in steps of 1.

### Making a new game

A game is a plain object passed to `createExchangeServer`. See [games/smash](games/smash) for a complete example.

```js
import { createExchangeServer, ExchangeError } from '../../exchange/index.js';

createExchangeServer({
  id: 'mygame',                       // save file + browser storage key
  title: 'My Game',
  rules: 'Shown to players when they join.',
  config: { maxPosition: 20, maxOrderQty: 20, market: { min: 0, max: 100, tick: 1 } },
  setup(exchange) {                   // optional: runs once on a fresh start
    exchange.createMarket({ name: 'Total dice sum', min: 0, max: 60 });
  },
  adminCommands: {                    // callable from the admin UI: Exchange.admin('rollDice', {...})
    rollDice(exchange, args) { /* exchange.settleMarket(id, price), createMarket(...), etc. */ },
  },
  publicDir: new URL('./public', import.meta.url).pathname,  // served at /game/
  clientScripts: ['/game/admin.js'],  // e.g. a custom admin panel
}).listen();
```

Every game also gets these built-in admin tools: list a market, halt or resume a market or group, settle at any price, delete an untraded market, and cancel orders.

In the browser, game scripts use `window.Exchange`:

- `registerAdminPanel({ title, mount(el), update(state) })`
- `admin(cmd, args)`
- `h(tag, props, ...children)` (a small DOM helper)
- `toast(msg)`
- `state` and `me`

```
exchange/            game-agnostic core
  orderbook.js       matching engine (one book per market)
  exchange.js        users, markets, positions, P&L, settlement, save/load
  server.js          HTTP + Socket.IO, admin auth, broadcasting, persistence
  public/            trading UI (books, order entry, positions, leaderboard, tape)
games/smash/         Smash Bros binary options
test/                engine, accounting, and end-to-end socket tests
```
