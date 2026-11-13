# Developing FAILTECH

How the code is laid out, how to test and tune it, and how themes and stories are built. For running a server, see [`deployment.md`](deployment.md).

## Tech stack

- **Server:** Node.js 22, Express 5, `better-sqlite3` (SQLite, WAL), `bcrypt`, `express-session` with a SQLite session store (sessions survive restarts).
- **Client:** dependency-free HTML/CSS/JS served from `public/` (`game.js` the game, `story.js` calls and mail, `terms.js` the vocabulary layer, `icons.js`, `login.js`). Two pages share that code: `game.html` (the desk layout) and `mobile.html` with `css/mobile.css` (the phone layout); `game.js` reads `data-shell` on the page to know which frame it is drawing into, and everything inside a screen is the same markup in both. The radar is SVG built once and patched in place (it auto-zooms as rings unlock, and can be zoomed and panned by wheel, drag or pinch); there is no build step and no CDN dependency. Live updates arrive over **Server-Sent Events**; numbers and progress bars are interpolated between ticks.

## Architecture

```
server.js          Express app: auth, JSON API, SSE stream, security, graceful shutdown, static pages (desk or phone layout), /theme-assets
src/sim.js         Pure simulation (no DB, no clock): stepDistrict(), stepColony(), step(), runConvoy(), routes, adjacency, plots
src/engine.js      Tick loop + offline catch-up; applies sim and hazards to the database
src/absence.js     Commanders who stop playing: when a colony stops being simulated, parking, retake, start over, claim
src/botApi.js      The bot API (/api/bot, key-protected): parked colonies, claim, a bot's state and actions, release        src/routes.js  every game action route
src/actions.js     Validated, transactional player actions (build, replace, upgrade, expand, found, ship, route, trade, shields, missions, ...)
src/queue.js       The work queue: one build slot per place, strict order, paid for when an order starts; replace in place
src/state.js       Builds the view the client renders (dry-run tick for live rates, market forecast, story state)
src/hazards.js     Hazard forecast / strike / preparedness / shields / away report
src/market.js      Order-book exchange (lazy NPC rungs, matching, escrow, fees)    src/marketsim.js  Seeded price walk, events, price links
src/missions.js    Free Port missions, factions and standing      src/requisitions.js  Requisitions and the boons they lend
src/settlements.js Settlements after the Beacon: camps on offer, steady support, drives, appeals and what they give back
src/orbital.js     Orbit: unlock, launch chain, station, slot storage (high-capacity slots too), links, express launch
src/hq.js          Headquarters: rebuild, charter, unlock bills and timers, start/switch/abandon, discovered districts
src/perks.js       What a colony has unlocked at Headquarters, read by the code each unlock changes
src/territories.js Shared anomalous territories and dropships   src/orbitalMarket.js  Orbital order book   src/projects.js  Global projects
src/objectives.js  Onboarding directives and the collapse clock
src/shutdown.js    Shutdown: parking and restarting buildings
src/story.js       Story beats, triggers, delivery pacing and validation
src/theme.js       Loads content/<theme>/theme.json onto the config
src/backup.js      Scheduled SQLite backups
src/security.js    Headers, same-origin check, rate limits, login throttle      src/validate.js  Input validation helpers
src/db.js          Schema (v23) and migrations, session store, colony helpers
game_config.json   All balance data (no wording that a theme replaces matters here; ids are stable)
content/           One folder per theme: theme.json (wording), story.json (narrative), assets/ (portraits, backgrounds)
scripts/           check-content.js (validate a theme), gen-prod-guide.js (regenerates prod_guide.md), playtest.js and playtest-orbit.js (scripted players for tuning, see below), botplay.js (the bots in-process), bots-report.js (sums up the bot runner's telemetry log)
bots/              the bot runner: runner.js (claims and schedules), client.js, assess.js (takeover check), profiles.js, brain/ (ground, endgame, orbit, trade, reorg)
public/            index.html (login), game.html (desk layout), mobile.html (phone layout), css/ (style.css, mobile.css), js/ (game.js, orbit.js for the Orbital Command view)
docs/              gameplay.md (player manual), deployment.md (running a server), development.md (this file), districts.md (district system, exchange, Free Port, roadmap), orbital.md (orbit endgame), headquarters.md (post-game Headquarters), story.md (theme and story format), security.md, content-needs.md
test/              node:test suites: simulation, balance guard, hazards, express convoy, districts and migration, exchange, Free Port, orbit, expansion and growth, shutdown, backups, story and themes, security, Headquarters, HTTP API
```

The client is purely presentational. It sends intents (`POST /api/build`, ...) and the server validates ownership, slots, plot, limits and resources before accepting them.

## Tests

```bash
npm test                 # runs with THEME=basic; the tests assert the neutral wording
npm run check-content    # validate the active theme and story
npm run guide            # regenerate prod_guide.md from game_config.json
```

About 330 tests cover adjacency geometry, the power grid, plot penalties, hub upkeep, fuel generators, storage/defence, the beacon, market prices, convoy trading, the whole hazard lifecycle (only-when-active, strike while away, auto-averted, prorated penalty, away report), the exchange, districts and routes, expansions, shutdown and recovery, backups, themes and the story engine (including the full Recontinuation script), the security rules, time away and parked colonies, the full HTTP API, and a **balance guard**: a scripted player has to finish the beacon in a sane number of ticks without collapsing. If you retune the economy, that test tells you whether the game is still finishable.

## Tuning the game

Everything numeric is in `game_config.json`: building costs/rates/build time/plot size, hub levels and upkeep, ring sizes, resource prices, hazards, market drift, starting state, convoy interval, morale rules. No engine changes needed.

**Checking a change.** `npm run playtest` runs a scripted player against the real actions and engine on a throwaway database and prints how the game paced: when each milestone landed, how much of the time each place's build slot was building, waiting for materials (and which) or idle, crew and morale by phase, what piled up against the storage cap and where the credits came from.

```bash
npm run playtest -- --persona builder            # base recipes, no trade: the player the balance test plays
npm run playtest -- --persona engineer           # alternative recipes, requisitions, exports what overflows
npm run playtest -- --persona trader             # no districts: sells Core goods and buys the rest
npm run playtest -- --cadence 20 --hazards on    # only looks in every 20 ticks, with hazards
npm run playtest -- --until station --max 9000   # carry on past the Beacon: Free Port, missions, the launch
npm run playtest -- --until station --path settle --max 4000   # after the Beacon, settlements only (orbit: no settlements; both: the default)
npm run playtest -- --until station --probe 1100,1200          # print the food picture at those ticks (why did it starve?)
```

`npm run playtest:orbit` does the same for the orbital stage. It starts from a station freshly launched over a colony that is assumed to have plenty of every ground good, and runs expeditions, the foundry, storage slots and links for a set number of ticks (`--ticks 8000 --upgrades none|storage|all`). It reports how fast rare resources and orbital goods come in, what the ground had to send up for them, and what was lost for want of a storage slot.

It reports, it does not assert (`test/balance.test.js` is the guard), and its numbers are a floor: the player never sleeps and never misreads anything, but it also places buildings without regard for adjacency and never expands one. A convoy price change has to keep two things true, which `test/recipes.test.js` checks: no recipe turns goods bought from the convoy into goods that sell for more, and no step of a chain is worth less than what went into it. Trade goods' prices are derived from their ingredients (`tradeWorks.priceRatio` × the inputs at the middle of their buy and sell prices), so they have to be recalculated when an ingredient's price moves.

## Themes and story

All wording and the whole narrative live in `content/<theme>/`, separate from the rules. Ids never change; only what is shown. Pick a theme with `THEME=<folder>` (default `recontinuation`; `basic` is the original, neutral wording). Validate edits with `npm run check-content`.

- **`theme.json`:** names and descriptions for resources, buildings, districts, hazards, factions and recipes; mission titles; the Brief directives' titles and hints; faction ranks; the login, tab and top-bar labels; the win, shutdown and failure text; and `ui.terms`, a list of word replacements that renames the game's own vocabulary (hub, convoy, credits, tick...) everywhere the interface prints it, including server messages. Story text is left alone.
- **`story.json`:** characters, scenes (nodes with passages, optional branching choices, speaker moods) and beats. A beat is triggered by colony progress (a directive, Core level, a district, faction standing, missions, hazards, the Beacon, the Brief being complete, or N ticks after another beat, requisitions filled, a second build crew, a new machine, alternative recipes, settlements sponsored, grown, answered or set on their own feet) and delivered as a call (dialogue) or as mail. Campaign beats arrive strictly in order; open-phase beats are independent. Nothing in the story affects the simulation, not even a branching choice.
- **`assets/`:** portraits (800 x 1200 transparent), square avatars (256 x 256) and 7 mood variants per portrait (`name_mood.webp`), and 1920 x 1080 backgrounds. Anything not drawn yet is simply replaced by a silhouette or plain backdrop, and `check-content` lists what is missing.

Story delivery in play is described in [`gameplay.md`](gameplay.md#story-delivery). Authoring guide and file formats: [`story.md`](story.md). The checklist for writing another theme: [`content-needs.md`](content-needs.md).

## Where it is going

Built so far: the Core and three founding districts (each with its own rings, stockpile and grid), shipments and standing routes over upgradable links, the exchange, the endgame Free Port (trade goods, shields, missions, factions, rank), building expansions, optional inputs, the People tab, shutdown instead of collapse, backups, themes, the story with calls, mail, branching scenes, moods and portraits, and the orbit endgame (launch chain, station, slot storage and links, dropships on shared anomalous territories, the orbital market and global projects, with a second chapter of directives and story), the work queue and build slots, requisitions, alternative recipes, settlements, Headquarters (the post-game rebuild, charter and permanent unlocks), and time away (colonies stop being simulated when their commander is gone, and park after 30 days). The design history and decisions are in [[`districts.md`](districts.md)](districts.md).

Not built yet (noted for later):

- **Per-district hazards:** hazards currently hit the colony as a whole. The plan is in [`districts.md`](districts.md).
- **Inline images in mail:** the reading window can show them, the mail format has no field yet ([`story.md`](story.md)).
- **Alerts while away:** a notification when a hazard is forecast or the colony shuts down (web push or mail).
- **Playtest telemetry** (which buildings, recipes and routes get used, where players stall).
- Balance numbers (orbit launch cycles, dropship damage, project sizes, expansion costs, exodus rates, link levels, recipes, missions, shutdown thresholds) are placeholders for playtesting.
