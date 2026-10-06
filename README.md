# FAILTECH - Radial Command (MVP)

A browser-based colony management game set in a gritty, post-2200 survival-industrial world. You are the Territory Commander of a central Hub. Build outward through five concentric rings, keep a power grid running, turn scrap and bad water into food and parts, climb a four-tier production chain, weather hazards, trade with the convoy, and build a **Beacon** that can reach what is left of the world.

## How to play

1. **Register** a callsign. You start with a Hub (level 1), 20 colonists and a stockpile.
2. **Click an empty slot** on the radar to see what you can build. The menu shows costs, inputs/outputs, the adjacency bonus *for that exact slot*, and whether the **plot is big enough**.
3. **Click a structure** to inspect it: efficiency, what is limiting it, neighbours, plot fit. You can pause it (saves power) or demolish it (50% refund).
4. Your people drink and eat every tick. If clean water or rations run out, morale falls; at 0 morale the colony is abandoned.
5. **Goal:** build the Beacon Array and keep it running until the transmission completes (25 signal). Everything else in the game exists to make that possible.

The **Brief** tab is your guide. Hazards mark the structures they touch on the map (red **!** = being hurt, amber ring = paying a maintenance cost, dashed ring = in the forecast's path). It shows a **collapse clock** (ticks until collapse at current rates, also in the top bar), any **incoming hazard** with how prepared you are, and a roadmap of **directives** that hint at what is missing without telling you what to build. Directives stay ticked once earned. The survival ones tell you whether you are on track, tight, behind schedule or blocked, by comparing how long your stock lasts with the earliest you could finish the fix.

### Systems

| System | What it does |
| --- | --- |
| **Rings, slots and plots** | Rings 1-5 have 6/8/10/12/14 slots, unlocked by Hub level. **Plots get bigger outward** (Small, Medium, Large, Heavy, Colossal). |
| **Minimum plot size** | Big buildings (Foundry, Cell Forge, Beacon, ...) want big plots. You may build them on smaller ones, but their output is multiplied by 0.6 for each missing size step. This ties advanced buildings to the outer rings, and so to Hub level, without locking them. |
| **Adjacency** | A building's output is multiplied for each neighbour that pairs well (or badly). Neighbours = the two beside it in its ring plus touching slots in the rings above and below. |
| **Power** | A grid, not a stockpile. Shortfalls throttle everything proportionally (a brownout). Scrap Burners are big generators that burn scrap. |
| **Housing and crew** | The hub only houses a few colonists. **Dormitories and Habitat Blocks** raise the population cap, and most buildings need **workers**: with fewer hands than posts, every staffed building slows in proportion. Growth stops at the housing cap. |
| **Morale and comfort** | Morale heads for a target set by **where homes are** (industry next door lowers comfort; greenery and guards raise it) and by **Prepared Meals** from a Kitchen (a second food tier). Low morale slows production; high morale gives a small bonus. |
| **Production tiers** | Raw (scrap, water, synthetics) → clean water, rations, parts → building materials → alloys, circuits → power cells. Buildings run at fractional efficiency limited by power and by their scarcest input. |
| **Hub upkeep** | From level 3 the Hub consumes power and supplies every tick (later alloys and circuits too). If it can't be maintained, its own power output drops. |
| **Storage** | The Hub caps every resource; Warehouses raise the cap. Excess production is lost (the UI warns you). |
| **Hazards** | Forecast ahead of time, strike on a fixed tick and then linger. The colony spends reserves automatically; unprepared means a prorated penalty, prepared still means a running cost. See below. |
| **Convoy** | Every 40 ticks (plus on-demand express trips). Standing export/import orders execute at that convoy's prices, which drift from convoy to convoy and are shown in advance with their change. The per-resource trade limit grows with Hub level (×1 at level 1 up to ×4 at level 5). |
| **Work orders** | Construction and upgrades take ticks. Costs are charged up front; cancelling refunds in full. |
| **Failure** | Critical shortages drain morale; at zero the colony collapses. You keep half your credits for the next attempt. "Abandon colony" does a full reset. |
| **Going offline** | If your connection drops, clicks to build, demolish, pause, upgrade or change convoy orders are **queued on screen** (a banner, a dashed marker on the map and a chip in the bottom bar) and sent in order when you reconnect. You can discard any of them first. Express trips and resets need a live connection. |
| **Offline progress** | The server owns the clock. Production, consumption, convoys and already-forecast hazards continue while you are logged out (capped at 1,200 ticks of catch-up after downtime). |

### Hazards

- A new hazard only starts while you are **active** (recently connected). Come back later and you won't find a surprise already waiting.
- Once forecast, the strike tick is fixed. It lands whether or not you are logged in.
- At the strike the colony **spends the reserves it has**, in proportion, and the hazard then **lasts several ticks whatever happens**. Unprepared: output cuts, degraded buildings, looting or higher consumption at a severity matching the shortfall. Prepared: no penalty, but a **running maintenance cost** for the duration (extra parts for repairs, panel cleaning, ammunition...). Weathering a hazard is never free.
- Requirements and frequency scale with Hub level, and tougher hazards unlock later: dust storms and equipment faults early, then crop blight and raids, toxic spills, cold snaps, and a signal storm that targets the beacon.
- If you were away, a **While you were away** report tells you what happened and what was spent.
- If you see a hazard coming and you're short, the threat card has an **Order express resupply** button (below).

### Express convoy

When you can't wait for the scheduled convoy, dispatch an **express trip** from the Convoy tab: a fee, a 3-tick journey, worse rates (×1.5 to buy, ×0.6 to sell) and a smaller cap, with a 10-tick cooldown. Goods and credits are held on dispatch.

The full numbers (costs, rates, plots, hazards, prices) are in [`prod_guide.md`](prod_guide.md). Everything numeric lives in `game_config.json`.

## Tech stack

- **Server:** Node.js 18+, Express 5, `better-sqlite3` (SQLite, WAL), `bcrypt`, `express-session` with a SQLite session store (sessions survive restarts).
- **Client:** dependency-free HTML/CSS/JS served from `public/`. The radar is SVG built once and patched in place (and auto-zooms as rings unlock); there is no build step and no CDN dependency. Live updates arrive over **Server-Sent Events**; numbers and progress bars are interpolated between ticks.

## Architecture

```
server.js          Express app: auth, JSON API, SSE stream, activity tracking, static pages
src/sim.js         Pure simulation (no DB, no clock): step(), runConvoy(), adjacency, plots, market
src/hazards.js     Hazard forecast / strike / preparedness / away report
src/engine.js      Tick loop + offline catch-up; applies sim and hazards to the database
src/actions.js     Validated player actions (build, demolish, pause, upgrade, contracts, reset, ack)
src/state.js       Builds the view the client renders (dry-run tick for live rates, market forecast)
src/objectives.js  Onboarding directives and the collapse clock
src/db.js          Schema, migrations, session store, colony helpers
game_config.json   All balance data
public/            index.html (login), game.html, css/, js/
test/              node:test suites: simulation, balance, hazards, HTTP API
```

The client is purely presentational. It sends intents (`POST /api/build`, ...) and the server validates ownership, slots, plot, limits and resources before accepting them.

## Running it

```bash
npm install
npm start                 # http://localhost:3000
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `TICK_MS` | `15000` (from config) | Milliseconds per game tick. `npm run dev` uses 1000 for fast testing. |
| `HAZARDS` | on | Set `off` to disable hazards (used by most tests). |
| `SESSION_SECRET` | generated, stored in the DB | Session signing key |
| `DB_PATH` | `./failtech.db` | SQLite file |
| `AUTH_RATE_LIMIT` | `20` | Login/register attempts per IP per minute |

**Upgrading:** schema v4 changed ring sizes and the economy, so existing colonies are dropped on first start (accounts are kept and colonies are re-founded at next login).

### Tests

```bash
npm test
```

Covers adjacency geometry, the power grid, plot penalties, hub upkeep, fuel generators, storage/defence, the beacon, market prices, convoy trading, the whole hazard lifecycle (only-when-active, strike while away, auto-averted, prorated penalty, away report), the full HTTP API, and a **balance guard**: a scripted player has to finish the beacon in a sane number of ticks without collapsing. If you retune the economy, that test tells you whether the game is still finishable.

## Tuning the game

Everything numeric is in `game_config.json`: building costs/rates/build time/plot size, hub levels and upkeep, ring sizes, resource prices, hazards, market drift, starting state, convoy interval, morale rules. No engine changes needed.

## License

ISC
