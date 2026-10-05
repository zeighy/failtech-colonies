# FAILTECH - Radial Command (MVP)

A browser-based colony management game set in a gritty, post-2200 survival-industrial world. You are the Territory Commander of a central Hub. Build outward through concentric rings, keep a power grid running, turn scrap and bad water into parts, clean water and food, and trade with the convoy, all while a population that never stops eating counts on you.

## How to play

1. **Register** a callsign. You start with a Hub (level 1), 20 colonists and a stockpile.
2. **Click an empty slot** on the radar to see what you can build. The menu shows costs, inputs/outputs, and a live preview of the adjacency bonus *for that exact slot*.
3. **Click a structure** to inspect it: efficiency, what is limiting it, neighbours. You can pause it (saves power) or demolish it (50% refund).
4. Your people drink and eat every tick. If clean water or rations run out, morale falls; at 0 morale the colony is abandoned.
5. **Goal:** upgrade the Hub to level 3 and hold a self-sustaining loop (power covers demand, water and rations in surplus) for 10 ticks.

### The Brief tab: directives and the collapse clock

New commanders start on the **Brief** tab. It has two parts:

- **Collapse clock** (also in the top bar): ticks until the colony collapses *if nothing changes*: time until the first critical stock runs dry, plus the morale runway after that. Change your production and the clock moves.
- **Directives:** a 12-step roadmap from "keep the lights on" to "hold a self-sustaining loop". Each one hints at what is *missing* without naming what to build. Milestones stay ticked once earned. The survival directives (water, food) compare how long your stock lasts against the earliest you could realistically finish the structure that fixes it, and tell you whether you are **on track**, **tight**, **behind schedule** or **blocked** (waiting on a resource with no income yet). Upgrade directives show how many ticks until you can afford them at current income, and the market directive shows the convoy countdown.

### The opening

Power is a *grid*, not a stockpile: every consumer needs its share of the supply every tick, and a shortfall throttles everything proportionally (a brownout). The Hub gives a little free power; Solar Arrays give the rest. A solid first few minutes:

1. Scrap Extractor + Parts Assembler (put them next to each other for +10%) + Groundwater Pump + Solar Array.
2. Filtration Plant as soon as you have 10 parts (next to the pump for +15%).
3. Hydroponics Bay once you have 25 parts and scrap (next to the Filtration Plant for +15%, away from the Scrap Extractor, which pollutes it).
4. Pause the Parts Assembler when you need to bank scrap. Then save for the Hub upgrade, which unlocks ring 2 and the Fabrication Works.

### Systems

| System | What it does |
| --- | --- |
| **Rings & slots** | Ring 1/2/3 have 6/12/18 slots, unlocked by Hub level. |
| **Adjacency** | A building's output is multiplied for each neighbour that pairs well (or badly). Neighbours = the two beside it in its ring plus touching slots in the rings above and below. Rules live in `game_config.json`. |
| **Production chains** | Buildings run at a fractional *efficiency* limited by power and by whichever input is scarcest. The UI tells you which. Chains flow within a single tick. |
| **Storage** | The Hub caps every resource. Excess production is lost (the UI warns you). |
| **Work orders** | Construction and upgrades take ticks. Costs are charged up front; cancelling refunds in full. |
| **Convoy** | Every 60 ticks a convoy arrives. Set standing export/import contracts in the Convoy tab: sell surplus for credits, buy what you lack. |
| **Failure** | Critical shortages drain morale; at zero the colony collapses. You keep half your credits for the next attempt. "Abandon colony" does a full reset. |
| **Offline progress** | The server owns the clock. Production, consumption and convoys continue while you are logged out (capped at 1,200 ticks of catch-up after downtime). |

## Tech stack

- **Server:** Node.js 18+, Express 5, `better-sqlite3` (SQLite, WAL), `bcrypt`, `express-session` with a SQLite session store (sessions survive restarts).
- **Client:** dependency-free HTML/CSS/JS served from `public/`. The radar is SVG built once and patched in place; there is no build step and no CDN dependency. Live updates arrive over **Server-Sent Events**; numbers and progress bars are interpolated between ticks.

## Architecture

```
server.js          Express app: auth, JSON API, SSE stream, static pages
src/sim.js         Pure simulation (no DB, no clock): step(), runConvoy(), adjacency
src/engine.js      Tick loop + offline catch-up; applies sim.step to the database
src/actions.js     Validated player actions (build, demolish, pause, upgrade, contracts, reset)
src/state.js       Builds the view the client renders (runs a dry-run tick for live rates)
src/db.js          Schema, migrations, session store, colony helpers
game_config.json   All balance data: costs, rates, ring sizes, adjacency, convoy prices
public/            index.html (login), game.html, css/, js/
test/              node:test suites for the simulation and the HTTP API
```

The client is purely presentational. It sends intents (`POST /api/build`, ...) and the server validates ownership, slots, hub level and resources before accepting them.

## Running it

```bash
npm install
npm start                 # http://localhost:3000
```

Useful environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `TICK_MS` | `3000` (from config) | Milliseconds per game tick. `npm run dev` uses 1000 for fast testing. |
| `SESSION_SECRET` | generated, stored in the DB | Session signing key |
| `DB_PATH` | `./failtech.db` | SQLite file |
| `AUTH_RATE_LIMIT` | `20` | Login/register attempts per IP per minute |

### Tests

```bash
npm test
```

Covers adjacency geometry, the energy grid, stalls, storage caps, convoy trading, win/lose conditions, a balance check (a do-nothing colony dies, a sensible opening survives), and the full HTTP API including auth, ownership, upgrades, convoys, collapse/restart and offline catch-up.

## Tuning the game

Everything numeric is in `game_config.json`: building costs/rates/build time, hub levels, resource prices, starting state, convoy interval, morale rules. No engine changes needed. The balance test in `test/sim.test.js` will tell you if you make the opening unwinnable.

## License

ISC
