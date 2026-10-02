# AscendQuantGroup
Trading games and tools for Emory Ascend Quant Group

## Ascend Exchange

A real-time trading platform for game nights. Every market has a live central limit order book: players post bids and asks, or hit the bid / lift the offer, using their chips.

- **Accounts** are permanent. Each person has a password, a chip balance and a dollar-wager balance that carry over from one game night to the next.
- **Sessions:** each game night is a session that runs one trading game (Smash Bros for now). Its markets, trades and P&L are kept for good.
- **History tab:** anyone can sign in at any time to see their chips, every past session, and their trades and P&L in each one.

### Starting it (host)

**One-time setup** on the computer that runs it:

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

1. Start the server:
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
2. Send the **Players** link to everyone. Open it yourself, sign in as **Attis**, and press **Admin**.
3. Under **Session**, give the night a name, pick the game, and press **Start session**.
4. Run the game. For Smash: list matches, and settle each one when it's over.
5. At the end of the night, press **End session**. It moves to everyone's History tab. Settle (or delete) any match people still hold positions in first.
6. Press `Ctrl+C` in the terminal to stop the server. Everything is saved in `data/ascend.json` and loaded again next time.

Each time you run `npm run share` you get a new link. If everyone is on the same Wi‑Fi, `npm start` is enough: it prints a `Same Wi-Fi` link and doesn't use the tunnel.

If you'd like a permanent link that people can open any time to check History, host it on Render, Railway or Fly.io:

- Use start command `npm start`.
- Set `ADMIN_PASSWORD` in the host's environment settings, since `.env` isn't uploaded.
- Mount a disk and set `DATA_FILE` to a path on it, so data survives redeploys.

### For players: setting up your account

1. Open the link you were sent.
2. Pick your name from the **Who are you?** list.
3. **First time only:** type any password you want (4 or more characters) and press **Sign in**. That becomes your password, so remember it.
4. Next time, sign in with the same password. The browser also remembers you, so refreshing keeps you signed in.
5. If you forget your password, ask Attis to reset it. Then sign in again and choose a new one.

Once you're in:

- **Trade tab** (while a session is running):
  - Every contract shows a live order book.
  - **Hit / Lift** trade immediately against the best bid / ask.
  - **Bid / Ask** post a limit order at the price you type. Clicking a price in the book fills it in.
- **Top bar:**
  - **chips:** your balance.
  - **equity:** chips plus your open positions.
  - **session P&L** and **all-time** P&L.
  - **available:** how many chips you can still risk.
  - **wagers:** your money wagers, if you have any.
- **History tab:** your chips and all-time P&L. For every session: your P&L, how each contract settled, your trades, and that night's leaderboard.

### Admin guide

- **Sessions:** the **Session** panel starts and ends game nights. Game-specific panels, like **Smash matches**, only appear while a session of that game is running.
- **Deleting markets:**
  - **Delete** on a contract, or on a match (in its header or in the Smash panel), removes it at any time, even after trades or settlement.
  - Every trade in it is cancelled and everyone's chips go back to what they were before it existed. It also disappears from History.
- **Editing chips and wagers:**
  - In **Accounts**, click a player's **chips** or **wagers $** number to edit it. `Enter` saves and `Esc` cancels.
  - A chip change counts as a deposit, not trading P&L.
  - A wager change is recorded as an "Adjusted by admin" entry.
- **Recording wagers ($):** this tracks real money, separately from chips. In the **Wagers** panel, record an entry with a note: positive if they won or are owed, negative if they lost or owe.
  - **Settle up** lists open balances.
  - Press **mark paid** once the money changes hands.
  - Use ✕ to delete a mistaken entry.
  - Each player sees only their own wagers.
- **Accounts:**
  - The list is in [server.js](server.js): Ashley, Paul, Frank, Jay, Thomas, Attis, Susie, Derrick, Arien, Buju, Jerry, Harry and Carl. Nobody else can sign in.
  - Add accounts in the panel, or add names to the list in `server.js`.
  - **Reset password** lets someone choose a new password.
- **Admin account:**
  - Attis is listed in `admins`. Its password is always `ADMIN_PASSWORD`. To change it, edit `.env` and restart.
  - The `/admin` link also has a plain admin-password login.

### How it works

| | |
|---|---|
| Matching | Price-time priority. Trades happen at the resting order's price. Self-trades are prevented by cancelling your own resting order. |
| Orders | `GTC` limit orders rest on the book. Hit/Lift sends an `IOC` at the current best price, and any unfilled part is cancelled. |
| Accounting | Trades move chips directly: equity = chips + position × mark, and P&L = equity − deposits (starting chips plus admin changes). The mark is the last trade, clamped to the current bid/ask. On settlement every position is paid out at the settlement price. Session P&L adds up the cash flows and open positions in that session's markets. |
| Risk | An order must be covered by your chips in its worst case: buys settle at the min, sells at the max, and all resting orders are assumed to fill. `maxPosition` per market counts resting orders as if they had filled. `maxOrderQty` caps the size of a single order. |
| Sessions | Only one session runs at a time. Ending a session cancels resting orders. Markets that never traded are dropped, unsettled markets with no positions are marked closed, and a session where nothing happened isn't kept. |
| Persistence | Everything is saved to `data/ascend.json` (or `DATA_FILE`) about a second after each change, and the full trade history is kept. Older `data/smash.json` saves are imported automatically, with their markets put in "Session 1". |
| Identity | Passwords are hashed with scrypt. Signing in stores a session token in the browser, so a refresh brings you back. A password reset signs that account out everywhere. |

### Smash Bros (`games/smash`)

During a Smash session, use **Smash matches** to list a match: give it an optional name and 2–8 players. Each player gets a contract that settles at **100 if they win, 0 otherwise**. **Halt all** on the match header pauses trading. When the match is over, pick the winner and press **Settle**. **Rematch** lists the same players again.

### Adding a game

Platform settings live in [server.js](server.js): title, starting chips, limits, accounts, admins and the list of games. A game is a plain object. See [games/smash/game.js](games/smash/game.js) for a complete example.

```js
// games/dice/game.js
import { ExchangeError } from '../../exchange/index.js';

export const dice = {
  id: 'dice',
  title: 'Dice',
  rules: 'Shown to players while a Dice session runs.',
  adminCommands: {                    // run only during a Dice session; call from the UI with Exchange.admin('newRound', {...})
    newRound(exchange, args) {
      exchange.createMarket({ name: 'Sum of 10 dice', group: 'Round 1', min: 10, max: 60 });
    },
  },
  publicDir: new URL('./public', import.meta.url).pathname,  // served at /games/dice/
  clientScripts: ['admin.js'],        // e.g. a custom admin panel
};
```

Then add it to `games: [smash, dice]` in `server.js`, and it appears in the **Start session** picker.

Every session also gets these built-in admin tools: start or end a session, manage accounts (add an account, edit chips or wagers, reset a password), list a market, halt or resume a market or match, settle at any price, delete a market or match, and cancel orders.

In the browser, game scripts use `window.Exchange`:

- `registerAdminPanel({ title, gameId, mount(el), update(state) })`, where `gameId` shows the panel only during that game's sessions
- `admin(cmd, args)`
- `h(tag, props, ...children)` (a small DOM helper)
- `toast(msg)`
- `state` and `me`

```
server.js            Ascend Exchange platform: settings, accounts, admins, games
exchange/            game-agnostic core
  orderbook.js       matching engine (one book per market)
  exchange.js        accounts, sessions, markets, chips, P&L, wagers, history, save/load
  server.js          HTTP + Socket.IO, admin auth, broadcasting, persistence
  public/            trading UI (books, order entry, history, admin panels)
games/smash/         Smash Bros binary options
test/                engine, accounting, sessions, and end-to-end socket tests
```
