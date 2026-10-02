# AscendQuantGroup
Trading games and tools for Emory Ascend Quant Group

## Exchange

A small real-time exchange: every market has a live central limit order book. Players sign in to their own account, post bids and asks, or hit the bid / lift the offer, using their chips.

### Starting it (host)

**One-time setup** on the computer that runs the game:

1. Install [Node.js](https://nodejs.org) 22.9 or newer, plus Cloudflare's tunnel tool: `brew install cloudflared`.
2. Get the code and install it:
   ```bash
   git clone https://github.com/atsss15/AscendQuantGroup.git
   cd AscendQuantGroup
   npm install
   ```
3. Create a file called `.env` in the project folder containing your admin password:
   ```
   ADMIN_PASSWORD=your-password-here
   ```
   This is also the password for the **Attis** account, which is the admin account. `.env` is git-ignored, so the password never goes to GitHub. `.env.example` shows the format.

**Each game night:**

```bash
cd AscendQuantGroup
npm run share
```

It prints:

```
  ================ Share these links ================
  Players:  https://some-random-words.trycloudflare.com
  Admin:    https://some-random-words.trycloudflare.com/admin
```

- Send the **Players** link to everyone.
- Open the link yourself and sign in as **Attis** with your admin password. The admin controls appear at the top: listing matches, settling them, accounts, chips and wagers.
- The link works while the terminal stays open, and you get a new link each time. Press `Ctrl+C` to stop. Everything is saved to `data/smash.json` (accounts, chips, wagers and open markets) and loaded again next time.
- If everyone is on the same Wi‑Fi, `npm start` is enough. It prints a `Same Wi-Fi` link and doesn't need the tunnel.

If you want a permanent link instead, host it on Render, Railway or Fly.io:

- Use start command `npm start`.
- Set `ADMIN_PASSWORD` in the host's environment settings, since `.env` isn't uploaded.
- Mount a disk and set `DATA_FILE` to a path on it, so chips survive redeploys.

### For players: setting up your account

1. Open the link you were sent.
2. Pick your name from the **Who are you?** list.
3. **First time only:** type any password you want (4 or more characters) and press **Sign in**. That becomes your password, so remember it.
4. Next time, sign in with the same password. The browser also remembers you, so refreshing keeps you signed in.
5. If you forget your password, ask Attis to reset it. Then sign in again and choose a new one.

Once you're in:

- Every contract shows a live order book.
- **Hit / Lift** trade immediately against the best bid / ask.
- **Bid / Ask** post a limit order at the price you type. Clicking a price in the book fills it in.
- The top bar shows your **chips**, your **equity** (chips plus open positions), your P&L, and how many chips are still **available** to risk.
- If you have money wagers, they show as **wagers** in the top bar and in the **Your wagers ($)** panel.

### Accounts, chips and wagers

- **Accounts:** they're listed in [games/smash/game.js](games/smash/game.js): Ashley, Paul, Frank, Jay, Thomas, Attis, Susie, Derrick, Arien, Buju and Jerry. Nobody else can sign in. You can add more accounts in the admin **Accounts** panel, or by adding names to the list.
- **Admin account:** Attis is listed in `admins`. Its password is always `ADMIN_PASSWORD` and can't be reset from the panel. To change it, edit `.env` and restart. The `/admin` link also has a plain admin-password login.
- **Chips:**
  - Everyone starts with 1000. Chips carry over between matches and restarts.
  - Buying costs price × qty, selling pays it, and a settled match pays out position × settlement price.
  - An order is accepted only if your chips cover the worst-case loss of all your positions and open orders.
- **Setting chips:** in the Accounts panel, type a number under **set chips** and press **Set**. The change counts as a deposit, not as trading P&L.
- **Wagers ($):** this tracks real money, separately from chips. In the **Wagers** panel, pick an account and enter an amount: positive if they won or are owed, negative if they lost or owe. Add a note to say what it was for.
  - **Settle up** lists everyone's open balance.
  - Press **mark paid** once the money has changed hands.
  - Use ✕ to delete a mistaken entry.
  - Each player sees only their own wagers.
- **Leaderboard:** players are ranked by equity.

### How it works

| | |
|---|---|
| Matching | Price-time priority. Trades happen at the resting order's price. Self-trades are prevented by cancelling your own resting order. |
| Orders | `GTC` limit orders rest on the book. Hit/Lift sends an `IOC` at the current best price, and any unfilled part is cancelled. |
| Accounting | With `startingBankroll` set, trades move chips directly: equity = cash + position × mark, and P&L = equity − deposits. The mark is the last trade, clamped to the current bid/ask. On settlement every position is paid out at the settlement price. With `startingBankroll: null`, it's P&L-only with no spending limit. |
| Risk | An order must be covered by the chips in its worst case: buys settle at the min, sells at the max, and all resting orders are assumed to fill. `maxPosition` per market counts resting orders as if they had filled. `maxOrderQty` caps the size of a single order. |
| Persistence | State is saved to `data/<game>.json` (or `DATA_FILE`) about a second after each change and reloaded on restart. Delete the file to reset the game. |
| Identity | Passwords are hashed with scrypt. Signing in stores a session token in the browser, so a refresh brings you back. A password reset signs that account out everywhere. With `openSignup: true`, any new name creates an account. |

### Smash Bros binary options (`games/smash`)

Log in through **Admin** and use **Smash matches** to list a match: give it an optional name and 2–8 players. Each player gets a contract that settles at **100 if they win, 0 otherwise**. Halt trading with **Halt all** on the match header. When the match is over, pick the winner and press **Settle**. **Rematch** lists the same players again.

Defaults are in [games/smash/game.js](games/smash/game.js): the 11 accounts, Attis as admin, 1000 starting chips, sign-up closed to anyone else, position limit ±50 per contract, max order size 50, and prices 0–100 in steps of 1. Adding a name to `accounts` creates that account the next time the server starts. Existing accounts keep their chips.

### Making a new game

A game is a plain object passed to `createExchangeServer`. See [games/smash](games/smash) for a complete example.

```js
import { createExchangeServer, ExchangeError } from '../../exchange/index.js';

createExchangeServer({
  id: 'mygame',                       // save file + browser storage key
  title: 'My Game',
  rules: 'Shown to players when they join.',
  config: { startingBankroll: 500, openSignup: false, maxOrderQty: 20, market: { min: 0, max: 100, tick: 1 } },
  accounts: ['Alice', 'Bob'],         // created on startup; each sets a password on first sign-in
  admins: ['Alice'],                  // these accounts sign in with ADMIN_PASSWORD and get the admin controls
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

Every game also gets these built-in admin tools: manage accounts (add an account, set chips, reset a password), record dollar wagers, list a market, halt or resume a market or group, settle at any price, delete an untraded market, and cancel orders.

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
