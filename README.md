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

### Algo trading competition (`/algo`)

This is an IMC Prosperity-style competition on the same server and link. Players sign in with their exchange accounts and write a Python `Trader`. Every night you simulate a new day in which all submitted algorithms trade against the bots and each other.

**One-time setup:** run `npm run algo:setup`. It creates a project-local Python (`.venv/`, git-ignored) with numpy, pandas and jsonpickle for player code.

**Links:** `npm run share` prints `<link>/algo`. Players and you use the same page, and your admin controls appear when you're signed in as Attis.

**Running it:**

1. Press **Generate data day** a few times before the start (or, with the server stopped, run `npm run algo:reset-data` to replace them with 3 fresh ones; `npm run algo:export` zips them for sending). Data days run the bots only, and players get their prices and trades to study and backtest on. Three data days of 10,000 ticks gives 30,000 ticks.
2. Each night, press **Run Day N** after the deadline. It runs every player's latest submission for one simulated day, then releases the results and that day's data right away. **Delete this day** removes a bad run so you can run it again.
3. **Practice week:** while the admin checkbox is on (it starts on), days run and show standings but don't count toward the cumulative leaderboard. Turn it off when the real competition starts. Each day also has a **Count this day** / **Make it practice** toggle.
4. Set the deadline text shown to players in the admin panel. The day only runs when you press the button.

**What players get:**

- **Editor:** a Python editor with autosave, starting from a Prosperity-compatible template (`from datamodel import Order, TradingState, ...`).
- **Run backtest:** replays a released day's prices and bots with only their algorithm and reports P&L by product, errors and their prints. Building a full backtester on the downloaded data is up to them.
- **Submit:** their latest submission is what runs in the next day.
- **Results:** P&L per day, a cumulative leaderboard, and their own trades and log for each day.
- **Market data:** a price chart, an order book they can scrub tick by tick, and downloads of `prices.csv` / `trades.csv` in Prosperity's format.

**Each tick** ([algo/sim.js](algo/sim.js)):

1. Bots post quotes.
2. Every algorithm gets the same `TradingState` and replies at the same time. Orders that could break a product's position limit are all rejected for that product.
3. Algorithm orders take liquidity from bot quotes: best price first, then shared **pro-rata** at each price, since everything in a tick arrives at once.
4. Algorithm orders that cross each other clear in a uniform-price batch auction.
5. Taker bots trade against whatever rests.
6. Everything is cancelled.

At the end of the day, positions are marked at fair value. Each day has its own seed, so backtests replay exactly the same prices and bot quotes.

**Designing the game (kept secret):** the real design goes in `algo/secret/competition.js`. That folder is git-ignored, so the design never reaches GitHub. The server uses it whenever it exists, and otherwise falls back to the public placeholder in [algo/competition.example.js](algo/competition.example.js). Keep a private backup of the secret file, because it isn't in the repo. A design file defines:

- **products:** each with a position limit.
- **price model:** produces fair values each tick.
- **bots:** `quote()` for makers and `take()` for takers.
- **settings:** ticks per day, the per-call time limit, and the player template.

**Player code safety:** each algorithm runs in its own Python process ([algo/py/host.py](algo/py/host.py)) with a clean environment, a CPU-time cap, an import allowlist, and a hook that blocks file access, network, subprocesses and similar operations. That's solid for a club competition, but it isn't a hardened sandbox. For strangers, run the server inside a container.

### Peer ranking for presentations (`/rank`)

This is a separate app that runs on the same server and link. Raters rank every group's presentation in each rubric category, and the grades are designed so that ranking honestly is the best strategy. It has its own data file, `data/ranking.json`, and doesn't touch accounts or chips.

**Links** (printed by `npm run share` along with the exchange links):

- Raters: `<link>/rank`
- Organizer: `<link>/rank/admin` (log in with `ADMIN_PASSWORD`)

**Running a presentation day:**

1. Open `/rank/admin` and create an evaluation. It needs:
   - a name
   - the groups, one per line
   - optionally, a roster of `Name, Group` lines
   - the rubric, which is pre-filled with the 6 categories and weights
   - the presentation share of the grade (default 90%)
2. Choose how raters sign in:
   - **With a roster:** only listed names can sign in, and their group is fixed. Leave the group off for raters who aren't presenting.
   - **Without a roster:** raters type any name and pick their group.
3. Press **Open ranking** and share the rater link. The **Raters** table shows who has submitted, and who on the roster hasn't signed in yet.
4. When everyone is done, press **Close ranking**. **Publish results** shows each rater the group standings, their own agreement score and their own grade. **Download CSV** exports everything.

**For raters:**

- Sign in with your name.
- For each category, tap the groups from best to worst. You never rank your own group.
- Move between categories freely. **Copy order from…** reuses the previous category's order, and **↑ ↓ ✕** adjust it. Drafts stay on your phone, even after a refresh.
- Nothing is sent until you press **Submit rankings**, which unlocks once every category is ranked. You can change things and submit again until the organizer closes ranking.
- A name stays tied to the first device that uses it. If someone switches phones, use **reset sign-in** in the admin page. Their submitted rankings are kept.

**Erasing test submissions:** in `/rank/admin`, **remove** deletes one rater and their rankings. **Clear all rankings** erases every rater and submission but keeps the groups and rubric.

**How grades are computed** (see [ranking/scoring.js](ranking/scoring.js)):

| | |
|---|---|
| Presentation score P | In a ranking of m groups, position r (1 = best) is worth (m − r)/(m − 1), so first = 1 and last = 0. P is averaged over raters, then weighted by the rubric. Raters never rank their own group, so nothing they submit can change their own group's P. |
| Agreement score A | For each pair of groups a rater ordered, their order is compared with every other rater who ordered the same pair, excluding teammates. A is the share of those comparisons that agree, weighted by the rubric. Categories a rater didn't rank count as 0. |
| Group grade | 100 × (0.9 P + 0.1 × the average A of the group's members who ranked). |
| Individual grade | 100 × (0.9 × their group's P + 0.1 × their own A). Raters who aren't presenting just get A. |

If everyone shares the same view of which presentation was better, honest ranking is a strict best response: changing your ranking can't raise your group's P and can only lower your A. This mechanism has limits:

- **Collusion:** a whole class coordinating on some other order (e.g. alphabetical) would also be "agreed on".
- **Taste:** on subjective categories, the agreement score rewards predicting what others think, not just your own taste.

The 90/10 split keeps that part small. You can change it under **Edit setup**.

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
server.js            Ascend Exchange platform: settings, accounts, admins, games (+ mounts /rank)
exchange/            game-agnostic core
  orderbook.js       matching engine (one book per market)
  exchange.js        accounts, sessions, markets, chips, P&L, wagers, history, save/load
  server.js          HTTP + Socket.IO, admin auth, broadcasting, persistence
  public/            trading UI (books, order entry, history, admin panels)
games/smash/         Smash Bros binary options
ranking/             peer ranking for presentations: scoring.js (the math), store.js, server.js, public/
algo/                algo competition: competition.js (products, prices, bots), matching.js, sim.js, runner.js + py/ (sandboxed Python), service.js, server.js, public/
test/                engine, accounting, sessions, and end-to-end socket tests
```
