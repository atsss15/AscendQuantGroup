# AscendQuantGroup

Trading games and tools for Emory Ascend Quant Group. One server runs three apps:

| App | Link | What it is |
|---|---|---|
| **Algo trading competition** | `/algo` | IMC Prosperity-style: players write Python trading bots that trade a simulated market every day |
| **Ascend Exchange** | `/` and `/admin` | A live order-book exchange for in-person game nights (e.g. trading Smash Bros outcomes) |
| **Peer ranking** | `/rank` | Strategy-proof peer grading for presentations |

It runs 24/7 at **https://ascend-exchange.fly.dev**. Everyone uses that one link, and it's the only copy of the data.

---

## Algo trading competition (`/algo`)

Players sign in with their exchange account and write a Python `Trader` with the same interface as IMC Prosperity. They backtest it in the browser and submit it. Every day at a set time a new day is simulated: every player's latest submission trades against market-making and taker bots, and against the other players. Results, a cumulative leaderboard and that day's market data are then released.

### For players

1. **Sign in** at `/algo` (see [Accounts](#accounts)).
2. **Write your trader** in the editor. It autosaves and starts from a commented sample `trader.py` that shows every input: order book levels, position limits, published features, your fills with counterparties, the market's trades, and saving memory between ticks with `traderData`.
3. **Study the data.** Under **Market data**:
   - A price chart, and an order book you can scrub tick by tick.
   - A **Weather & features** tab.
   - Per-day downloads of `prices.csv`, `trades.csv` and `observations.csv` (Prosperity's format), or **all days (zip)** for everything at once.
4. **Backtest.** **Run backtest** replays a released day's prices and bots with only your algorithm trading, and shows:
   - P&L by product, errors and your prints.
   - Your `Trader.run` CPU time per call.
   - **Who you traded with**, with a CSV download of your fills.
5. **Submit.** Your latest submission runs at the next scheduled day (shown at the top of the page) and every day after until you submit again.
6. **Results** shows your P&L per day, your trades and log for each day, the latest day's standings, and the leaderboard with a chart of everyone's cumulative P&L.

What your code gets each tick, and the rules:

- **`state.order_depths`:** the bots' quotes, several levels deep.
- **`state.position`:** your positions. **Position limits:** if your orders for a product could take you past its limit, *all* of them are rejected for that tick.
- **`state.own_trades`:** your fills since last tick. The other side is named (another player's name, or a bot id); you are `SUBMISSION`.
- **`state.market_trades`:** everyone else's trades. Anonymous.
- **`state.observations.plainValueObservations`:** features published this tick (numbers, and a few categories as text), if the round has any.
- **`state.traderData`:** whatever string you returned last tick (up to 50,000 characters).
- **Time limit:** each call must finish within 400 ms, or its orders are ignored. A call that hangs stops your algorithm for the day.
- **Libraries:** numpy, pandas, math, statistics, json, jsonpickle, collections and similar standard helpers. Files, network and system access are disabled.

### Running a round (admin)

Sign in as Attis. The admin panel appears at the top of `/algo`.

1. **Start new round…**
   - **Archives the old round:** days, results, the leaderboard and submissions move to `data/algo/archive/<time>/` on the server.
   - **Generates data days:** it asks how many (default 15, i.e. about two weeks), numbered −14 to 0. These are bots-only days for players to study and backtest on, generated oldest first with the current design, each continuing the one before.
   - **Day 1:** the first real day.
   - **Round numbering:** a round that never ran a day is redone under the same number.
2. **Schedule.** Tick **Run automatically every day at 12:00** (New York time) and pick a start date.
   - A gap of a couple of days after a new round gives players time to research.
   - After that, each day runs by itself and releases its results and data right away.
   - A server that was down at the scheduled time catches up later that day.
3. **Reset everyone's editor to the template…** puts the round's sample `trader.py` in every editor. Everyone's previous code is saved to `data/algo/archive/editors-<time>.json` first.
4. **Other controls:**
   - **Run Day N now** runs a day immediately.
   - **Add a data day** adds another bots-only day at the end of the series, continuing from the latest day. The first real day moves after it. It's only possible before the first real day runs.
   - **Delete this day** removes a bad run so it can run again.
   - The **practice week** checkbox (off after a new round) and each day's **Count this day** toggle decide what counts toward the leaderboard.
   - The panel also shows every submission and each day's results, code and logs, plus the [hosting cost](#hosting-247-on-flyio).

### How a day is simulated

Each day is 10,000 ticks. Each tick ([algo/sim.js](algo/sim.js)):

1. The price model moves and maker bots post quotes.
2. Every algorithm gets the same `TradingState` and replies at the same time, in its own Python process.
3. Algorithm orders take liquidity from the bot quotes, best price first.
4. Algorithm orders that cross each other clear in a uniform-price batch auction.
5. Taker bots trade against whatever rests, bots and players alike.
6. Everything is cancelled. Next tick, algorithms see their own fills (with counterparties) and the market's anonymous trades.

**Queue at the same price** ([algo/matching.js](algo/matching.js)) works like this:

- **Order:** bot quotes come first, since they're posted at the start of the tick. Algorithms follow in order of the CPU time their `Trader.run` used that tick, fastest first.
- **Fairness:** CPU time is measured with the thread CPU clock inside the player's own process, so it isn't affected by how busy the server is.
- **Ties:** broken at random with the day's seed.

So both price and code efficiency matter.

**One continuous market:** each day picks up exactly where the previous one ended, including prices, weather and everything else the design tracks. So the data days and the competition days form one continuous series: Day −13 opens where Day −14 closed, and Day 1 opens where Day 0 closed. The server keeps each day's start and end state in `days/<day>/world.json`.

At the end of the day, positions are marked at fair value. Prices, bots and matching each use their own seeded random stream, and a backtest starts from the same state as the real day, so it replays that day's prices and bot behaviour exactly.

### Designing a round (kept secret)

The real design lives in `algo/secret/competition.js`. That folder is git-ignored, and the server gets the design only as an encrypted Fly secret, because players can read this repo. Without it, the server falls back to the public placeholder [algo/competition.example.js](algo/competition.example.js). Keep a private backup of the secret folder.

A design file defines:

- **products:** each with a position limit.
- **model:** fair values each tick, and optionally `observations(t)` for the features published to players, and `carry()` for the state the next day continues from (it gets it back as `carry`).
- **bots:** `quote()` for makers and `take()` for takers. A bot's `name` is the id players see when they trade with it.
- **settings:** ticks per day, the per-call time limit, and the sample `template`.

Designs are validated privately before a round goes live. Naive analysis of the data players get has to find little out of sample, while each intended signal has to add significant P&L when traded on unseen days.

**Player code safety:** each algorithm runs in its own Python process ([algo/py/host.py](algo/py/host.py)) with:
- a clean environment and a temp folder
- CPU-time and file-size limits
- an import allowlist
- a hook that blocks file access, network, subprocesses and similar operations

That's solid for a club competition, but it isn't a hardened sandbox.

**Offline tools** (local copy only, with the server stopped):
- `npm run algo:setup` creates `.venv/` with numpy, pandas and jsonpickle.
- `npm run algo:reset-data` regenerates data days.
- `npm run algo:export` zips every released day.

---

## Hosting 24/7 on Fly.io

[Fly.io](https://fly.io) runs the server permanently at a fixed link, with the data on a 1 GB volume. It's one shared-CPU machine with 1 GB of memory, about $6 a month. A 13-player algo day runs in seconds.

**One-time setup** (already done for `ascend-exchange`):

```bash
brew install flyctl
fly auth login                                              # opens the browser
fly apps create ascend-exchange                             # pick another name if taken (and update fly.toml)
fly volumes create ascend_data --size 1 --region iad --yes
fly secrets set ADMIN_PASSWORD='your-password' ALGO_DESIGN_B64="$(base64 -i algo/secret/competition.js | tr -d '\n')"
fly deploy --ha=false                                       # one machine (the volume belongs to it)
npm run migrate -- https://ascend-exchange.fly.dev         # copy a laptop's data/ to the server
```

The design isn't in the repo or the Docker image (`.dockerignore` excludes `algo/secret/`). It reaches the server only as the encrypted `ALGO_DESIGN_B64` secret.

**Day to day:**

- **Code changes:** `fly deploy --ha=false`. If Fly's builder answers 401, run it again or add `--depot=false`.
- **New round or design change:**
  1. Run `fly secrets set ALGO_DESIGN_B64="$(base64 -i algo/secret/competition.js | tr -d '\n')"`.
  2. Deploy.
  3. Press **Start new round…** and **Reset everyone's editor…** on `/algo`, then set the schedule.
- **Cost:** the algo admin panel shows this month's Fly cost so far and per month. It's estimated from the machine size, the volume and Fly's list prices, and links to the exact bill.
  - For billing status and data transfer too, give the server a read-only token: `fly secrets set FLY_API_TOKEN="$(fly tokens create readonly personal --expiry 8760h)"`.
- **Logs and status:** `fly logs`, `fly status`. **More memory:** `fly scale memory 2048`.
- **Backups:** Fly snapshots the volume daily. `npm run migrate -- <url>` copies a local `data/` folder to a running server, replacing its data.

### Running on your own computer

Use this for development, or for a game night without the cloud. It keeps its own separate `data/`, so don't run it alongside the Fly server for real use.

1. Install [Node.js](https://nodejs.org) 22.9 or newer, plus `brew install cloudflared` for public links.
2. Run `git clone https://github.com/atsss15/AscendQuantGroup.git && cd AscendQuantGroup && npm install && npm run algo:setup`.
3. Create `.env` containing `ADMIN_PASSWORD=your-password-here`. It's git-ignored, and `.env.example` shows the format.
4. Start it:
   - `npm start` gives local and same-Wi-Fi links.
   - `npm run share` adds a temporary public trycloudflare link.
   - `npm run share:bg` / `npm run link` / `npm run stop` run it in the background, so closing the Terminal doesn't stop it. The log is in `data/server.log`.

---

## Accounts

All three apps share the exchange's accounts, except ranking, which uses names.

- **Who can sign in:** the list is in [server.js](server.js). It currently holds Ashley, Paul, Frank, Jay, Thomas, Attis, Susie, Derrick, Arien, Buju, Jerry, Harry, Carl and Felix. Nobody else can sign in. Add accounts in the exchange admin panel or in `server.js`.
- **First sign-in:** pick your name and type any password (4+ characters). That becomes your password. The browser remembers you, and signing in on `/algo` or `/` signs you in on both.
- **Forgot your password:** ask Attis to **Reset password**, then sign in again with a new one.
- **Admin:** Attis is the admin account. Its password is always `ADMIN_PASSWORD`. `/admin` also has a plain admin-password login.

---

## Ascend Exchange: in-person game nights (`/` and `/admin`)

A real-time trading platform for game nights. Every market has a live central limit order book: players post bids and asks, or hit the bid / lift the offer, using their chips.

- **Accounts** keep a chip balance and a dollar-wager balance from one game night to the next.
- **Sessions:** each game night is a session that runs one trading game (Smash Bros for now). Its markets, trades and P&L are kept for good.
- **History tab:** anyone can sign in at any time to see their chips, every past session, and their trades and P&L in each.

**Running a game night:**

1. Open `/admin` on the live link and sign in as Attis.
2. Under **Session**, name the night, pick the game, and press **Start session**.
3. Run the game. For Smash: list matches, and settle each one when it's over.
4. At the end, settle (or delete) any market people still hold, then press **End session**. It moves to everyone's History.

**For players:**

- **Trade tab** (while a session runs):
  - Every contract shows a live order book.
  - **Hit / Lift** trade immediately against the best bid or ask.
  - **Bid / Ask** post a limit order at your price. Clicking a price in the book fills it in.
- **Top bar:**
  - **chips** and **equity** (chips plus your open positions).
  - **session P&L** and **all-time** P&L.
  - **available:** chips you can still risk.
  - **wagers:** your money wagers, if any.
- **History tab:** your chips and all-time P&L. For every session: your P&L, how each contract settled, your trades, and that night's leaderboard.

**Admin guide:**

- **Sessions:** the **Session** panel starts and ends game nights. Game panels like **Smash matches** only appear during that game's sessions.
- **Deleting markets:** **Delete** on a contract or match removes it at any time, even after trades or settlement. Every trade in it is reversed and everyone's chips go back to what they were, and it disappears from History.
- **Chips and wagers:** in **Accounts**, click a player's **chips** or **wagers $** to edit (`Enter` saves, `Esc` cancels).
  - A chip change counts as a deposit, not trading P&L.
  - A wager change is recorded as "Adjusted by admin".
- **Wagers ($)** track real money, separately from chips. Record entries in the **Wagers** panel: positive if they won or are owed, negative if they lost or owe.
  - **Settle up** lists open balances.
  - **mark paid** records that the money changed hands.
  - ✕ deletes a mistaken entry.
  - Each player sees only their own wagers.
- **Quiz equity** is tracked separately from game-night equity, and total equity is the sum of both.

### How the exchange works

| | |
|---|---|
| Matching | Price-time priority. Trades happen at the resting order's price. Self-trades are prevented by cancelling your own resting order. |
| Orders | `GTC` limit orders rest on the book. Hit/Lift sends an `IOC` at the current best price; any unfilled part is cancelled. |
| Accounting | Trades move chips directly: equity = chips + position × mark, and P&L = equity − deposits (starting chips plus admin changes). The mark is the last trade, clamped to the current bid/ask. On settlement every position is paid out at the settlement price. |
| Risk | An order must be covered by your chips in its worst case: buys settle at the min, sells at the max, and all resting orders are assumed to fill. `maxPosition` counts resting orders as filled; `maxOrderQty` caps a single order. |
| Sessions | One session at a time. Ending a session cancels resting orders. Markets that never traded are dropped, and a session where nothing happened isn't kept. |
| Persistence | Saved to `data/ascend.json` (or `DATA_FILE`) about a second after each change, with the full trade history. |
| Identity | Passwords are hashed with scrypt. Signing in stores a session token in the browser. A password reset signs that account out everywhere. |

### Smash Bros (`games/smash`)

During a Smash session, use **Smash matches** to list a match with an optional name and 2–8 players. Each player gets a contract that settles at **100 if they win, 0 otherwise**.
- **Halt all** pauses trading.
- When the match is over, pick the winner and press **Settle**.
- **Rematch** lists the same players again.

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

Every session also gets these built-in admin tools:
- start or end a session
- manage accounts: add an account, edit chips or wagers, reset a password
- list a market
- halt or resume a market or match
- settle at any price
- delete a market or match
- cancel orders

In the browser, game scripts use `window.Exchange`:
- `registerAdminPanel({ title, gameId, mount(el), update(state) })`
- `admin(cmd, args)`
- `h(tag, props, ...children)`
- `toast(msg)`
- `state` and `me`

---

## Peer ranking for presentations (`/rank`)

Raters rank every group's presentation in each rubric category, and the grades are designed so that ranking honestly is the best strategy. It has its own data file, `data/ranking.json`, and doesn't touch accounts or chips.

**Links:** raters use `/rank`. The organizer uses `/rank/admin` (log in with `ADMIN_PASSWORD`).

**Running a presentation day:**

1. In `/rank/admin`, create an evaluation. It needs:
   - a name
   - the groups, one per line
   - optionally, a roster of `Name, Group` lines
   - the rubric, pre-filled with 6 categories and weights
   - the presentation share of the grade (default 90%)
2. Choose how raters sign in:
   - **With a roster:** only listed names can sign in, and their group is fixed. Leave the group off for raters who aren't presenting.
   - **Without a roster:** raters type a name and pick their group, or None.
3. Press **Open ranking** and share the rater link. The **Raters** table shows who has submitted.
4. When everyone is done, press **Close ranking**.
   - **Publish results** shows each rater the standings, their agreement score and their grade.
   - **Download CSV** exports everything.

**For raters:**

- **Ranking:** for each category, tap the groups from best to worst. You never rank your own group.
- **Moving around:** switch between categories freely. **Copy order from…** reuses another category's order, and **↑ ↓ ✕** adjust it. Drafts stay on your phone.
- **Submitting:** nothing is sent until you press **Submit rankings**, which unlocks once every category is ranked. You can resubmit until the organizer closes ranking.
- **Devices:** a name stays tied to the first device that uses it. The organizer can **reset sign-in** for someone who switches phones.

**Erasing test submissions:** **remove** deletes one rater and their rankings. **Clear all rankings** erases every rater and submission but keeps the setup.

**How grades are computed** ([ranking/scoring.js](ranking/scoring.js)):

| | |
|---|---|
| Presentation score P | In a ranking of m groups, position r (1 = best) is worth (m − r)/(m − 1). P is averaged over raters, then weighted by the rubric. Raters never rank their own group, so nothing they submit changes their own group's P. |
| Agreement score A | For each pair of groups a rater ordered, their order is compared with every other rater who ordered the same pair (excluding teammates). A is the share that agree, weighted by the rubric. |
| Group grade | 100 × (0.9 P + 0.1 × the average A of the group's members who ranked). |
| Individual grade | 100 × (0.9 × their group's P + 0.1 × their own A). Raters who aren't presenting just get A. |

If everyone shares the same view of which presentation was better, honest ranking is a strict best response: changing your ranking can't raise your group's P and can only lower your A. This mechanism has two limits:
- **Collusion:** a whole class coordinating on some other order would also count as "agreed on".
- **Taste:** on subjective categories, the agreement score rewards predicting what others think.

The 90/10 split keeps that part small.

---

## Project layout

```
server.js            platform settings (accounts, admins, games); mounts /algo and /rank
algo/                algo competition
  sim.js             one simulated day: ticks, bots, players, settlement
  matching.js        batch matching: price priority, speed queue, call auction
  runner.js, py/     sandboxed Python players (host.py) and the Prosperity datamodel
  service.js         rounds, data days, submissions, backtests, schedule, leaderboard
  server.js          /algo/api routes; public/ is the page
  competition.js     loads the secret design (or competition.example.js)
  zip.js, tools.js   all-days zip; offline data tools
exchange/            game-night exchange core: orderbook.js, exchange.js, server.js, public/
games/smash/         Smash Bros binary options
ranking/             peer ranking: scoring.js (the math), store.js, server.js, public/
deploy/              restore (for npm run migrate) and hosting-cost estimate
tools/               background mode (share:bg / link / stop) and migrate
Dockerfile, fly.toml Fly.io deployment
test/                matching, simulation, schedule, rounds, exchange, ranking and end-to-end tests
```
