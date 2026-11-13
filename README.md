# FAILTECH - Radial Command

A browser-based colony management game with a server-authoritative simulation. You are the Territory Commander of a central **Core**. Build outward through five concentric rings, keep a power grid running, turn scrap and bad water into food and parts, climb a production chain, found satellite **districts** and link them with shipments and routes, weather hazards, trade with the convoy and on an order-book exchange, and build a **Beacon** that can reach what is left of the world. After the Beacon an endgame harbour opens, with trade goods, missions and factions. Earn enough standing and the game goes to **orbit**, where every player's station shares the same anomalous territories, orbital market and global projects.

The game ships with a story and a full theme: **Recontinuation** (Earth after the Lapse, run by the surviving Continuity Office) is the default. The rules are separate from the wording and narrative, so the same game can be re-themed by dropping in another folder (see [Themes and story](#themes-and-story)).

## How to play

1. **Register** a Commander ID. You start with a Core (level 1), 20 colonists and a stockpile.
2. **Click an empty slot** on the radar to see what you can build. The menu shows costs, inputs and outputs, the adjacency bonus *for that exact slot*, whether the **plot is big enough**, and what building it would do to your power and rates. Each place builds **one thing at a time** until its hub buys more build slots: anything more joins its **work queue** and is built in order (see Systems).
3. **Click a structure** to inspect it: efficiency, what is limiting it, neighbours, plot fit. You can pause it (saves power), switch on an optional input, expand it, **replace** it with another building on the same plot, or demolish it (50% refund; a configured workshop also leaves its slot clearing for a while, as long as a recipe change takes).
4. Your people drink and eat every tick. If clean water or rations run out, morale falls and people leave. If hope runs out the colony **shuts down** instead of collapsing: non-essential buildings are parked and you decide whether to rebuild or start over (see Systems).
5. **Goal:** build the Beacon Array and keep it running until the transmission completes (25 signal). Everything else exists to make that possible. Once it has sent, the Beacon stops burning power cells and only needs power. Then the harbour opens, and the game turns open-ended.
6. **Orbit:** with 500 standing across the factions, a second chapter opens (it stays hidden until then). Launch a station, then send dropships to the anomalies (see [Orbit](#orbit)).

The **Brief** tab is your guide. It shows a **collapse clock** (ticks until collapse at current rates, also in the top bar), any **incoming hazard** with how prepared you are, and a roadmap of **directives** that hint at what is missing without telling you what to build. Directives stay ticked once earned; the finished ones fold into a single line, and only the current one shows its hint. The survival ones tell you whether you are on track, tight, behind schedule or blocked, by comparing how long your stock lasts with the earliest you could finish the fix. Hazards also mark the structures they touch on the map (red **!** = being hurt, amber ring = paying a maintenance cost, dashed ring = in the forecast's path).

Messages from the story arrive as **calls** (a card at the bottom right of the map that you answer when convenient) and as **mail** in the Messages window (the envelope in the top right). See [Story delivery](#story-delivery).

The screen keeps each kind of information in one fixed place:

- **Always on screen (the top bar and the stock bar).** The colony's vitals (credits, people and homes, cohesion, collapse clock, hazard countdown with how prepared you are) and a second group for the place you are looking at: power and next convoy on the surface; station power, storage slots, the express slot and the project timer on the station; ship power, hold, time left and hull in a territory. Numbers turn amber or red when something needs you, so there is no separate alert row. Under it, the **stock bar** shows the stock you pinned (or the place's own stock in orbit), and it stays there while you build, inspect or work in any screen. The bell (incoming calls and what just happened, with a link to the full history), the envelope (Messages: Mail, Calls, History) and your name (command menu) sit at the right.
- **Every screen, one click away (the list on the left).** Map, then Colony (Brief, People, Hub, Districts), Economy (Stockpile, Logistics, Convoy, Exchange, Missions) and, once they exist, Orbit (Storage, Market, Expeditions, Project) and the Data archive. The list never rearranges itself: a screen that has not opened yet keeps its place with a lock, and a dot or a count marks the ones that want a look. Each has a key (`B` Brief, `P` People, `H` Hub, `D` Districts, `S` Stockpile, `L` Logistics, `C` Convoy, `X` Exchange, `N` Missions, `M` or `Esc` back to the map; the command menu lists them). A screen opens over the map and the right pane; surface screens open on the surface and orbital ones in orbit, wherever you were.
- **Follows what you select (the right pane).** With nothing selected it is an overview: the next step from the Brief, what needs attention, and the place at a glance (free plots, power). Select a free plot for the build menu (filter it by Power, Extraction, Production, Housing or Support), or a building to pause or demolish it at once and see why it runs at the number it does. In orbit it shows the station or territory overview.
- **The map.** Tabs along its top switch place: the Core and your districts (plus Found). Once there is a station, a **Surface | Orbit** switch in front of them flips between the ground and orbit, and the tabs then show that side's places (the station, any territory you are in, and Deploy); a dot on the other side of the switch means something there wants a look. When the tabs do not fit, they scroll sideways and an arrow appears on the side where some are hidden. A district is marked NEW until you first open it. Scroll to zoom, drag to pan, and use the buttons in its corner (or `+`, `-`, `0`) to zoom or fit.
- **The bottom bar.** The next step from the Brief, and the work queue.

Mail, calls and the log live in the Messages window and the bell, not in the right pane. Screens keep their explanations short: the longer how-it-works text sits under a **How this works** fold (Districts, Logistics, Settlements, Requisitions, Missions) that stays open or closed as you left it. Names depend on the theme.

#### On a phone

A phone gets its own layout over the same game (`public/mobile.html`), with every screen and action of the desk layout:

- **Top:** a place button (tap it to go to another district, the station or a territory), the bell and the envelope. Under it the vitals as icons and numbers; tap one to open its screen or to be told what it is.
- **Middle:** the map (pinch to zoom, drag to pan) with a panel under it: the overview (next step, what needs attention, the work queue, pinned stock), or the build menu or building you tapped. The map glides in on the plot you pick, and the handle on the panel grows it to the full height.
- **Bottom:** five fixed tabs: Map, Brief, Stock, Trade and **More**, which lists every other screen, the messages and the account. In orbit, Stock opens the station's storage. Inside a screen, a strip along the top jumps between its neighbours.
- Calls, mail and the dialogue scenes are laid out for a narrow screen, upright or on its side.

The server picks the layout from what the browser says it is, and the game corrects a wrong guess from the real screen size. To choose for yourself, use **Use the phone layout** in the command menu or **Use the desktop layout** under More (the choice is kept in a cookie), or open `/game?ui=mobile` or `/game?ui=desktop`.

### Systems

| System | What it does |
| --- | --- |
| **Rings, slots and plots** | Rings 1-5 have 6/8/10/12/14 slots, unlocked by Hub level. **Plots get bigger outward** (Small, Medium, Large, Heavy, Colossal). |
| **Minimum plot size** | Big buildings (Foundry, Cell Forge, Beacon, ...) want big plots. You may build them on smaller ones, but their output is multiplied by 0.6 for each missing size step. This ties advanced buildings to the outer rings, and so to Hub level, without locking them. |
| **Adjacency** | A building's output is multiplied for each neighbour that pairs well (or badly). Neighbours = the two beside it in its ring plus touching slots in the rings above and below. Rings 2 and 4 of the Core are turned 15 degrees (`ringRotation` in the config) so slots straddle the seams of the rings beside them. |
| **Power** | A grid, not a stockpile. Shortfalls throttle everything proportionally (a brownout). Scrap Burners are big generators that burn scrap. Every district has its own grid. |
| **Housing and crew** | The hub only houses a few colonists. **Dormitories and Habitat Blocks** raise the population cap, and most buildings need **workers**: with fewer hands than posts, the essential buildings (water, food, power, salvage) are crewed first and every other staffed building slows in proportion. Growth stops at the housing cap. |
| **Morale and comfort** | Morale heads for a target set by **where homes are** (industry next door lowers comfort; greenery and guards raise it) and by **Prepared Meals** from a Kitchen (a second food tier). Low morale slows production; high morale gives a small bonus. |
| **Production tiers** | Raw (scrap, water, synthetics) → clean water, rations, parts → building materials → alloys, circuits → power cells. Buildings run at fractional efficiency limited by power and by their scarcest input. |
| **Alternative recipes** | Most production buildings can be set to another recipe from their pane. Alternatives stand in for research: a higher-yield way of making the same thing that needs something from further along the chain (ingots in the Core's foundry, reagents in the water plant, scrap as filler in the polymer plant), or a different split or product. They open with the **level of the place the building stands in** (the hub for the Core, the district's own level elsewhere) and, for the last ones, at colony **milestones** (the Beacon built, the Free Port founded, a station in orbit). The base recipe is always there. Switching costs nothing, but the line stands idle for 10 ticks while it is retooled. |
| **District tiers** | A district's first line (its extractor and first processor) runs on what the Core and the district itself make, so any district works as the only one you have, and leaves a little scrap for the district to build with. Its second-stage buildings need at most one kind of goods from another district. |
| **The scrap sink** | The **Reclamation Plant** (hub level 4, Large plot) eats scrap by the hundred and turns it into ingots, building stock or raw synthetics; after the Free Port and the station, into frames and fittings, so late-game goods are made from the base resources that used to pile up. |
| **Standby power** | A **Cell Bank** covers a shortfall on its place's grid (up to 90 power) by burning power cells from that place's stockpile, in proportion to what it supplies and only while the grid is short. The Cell Forge's alternative recipes make two and then three and a half cells where it made one. |
| **Hub upkeep** | From level 3 the Hub consumes power and supplies every tick (later alloys and circuits too). If it can't be maintained, its own power output drops. |
| **Storage** | The Hub caps every resource; Warehouses raise the cap. Excess production is lost (the UI warns you). |
| **Hazards** | Forecast ahead of time, strike on a fixed tick and then linger. The colony spends reserves automatically; unprepared means a prorated penalty, prepared still means a running cost. See below. |
| **Convoy** | Every 40 ticks (plus on-demand express trips). Standing export/import orders execute at that convoy's prices, which drift from convoy to convoy and are shown in advance with their change. The per-resource trade limit grows with Hub level (×1 at level 1 up to ×4 at level 5). |
| **Exchange** | From hub level 4 an order book separate from the convoy: post buy and sell orders at your own price against a book of NPC traders (and later other players). Sells are held, buys escrow credits, a 4% fee on proceeds. Prices drift on a seeded walk with shortage and glut events, and the book gets thin when you eat it. Goods are delivered to, and sold from, any district. |
| **Requisitions** | From hub level 2 the **Missions** screen carries requisitions: two requests at a time for ordinary goods the colony can make (parts, water, rations, building stock, later alloys and district goods), a set amount by a set time, delivered in full from the Core. Filling one pays 1.8 times the convoy's selling price and lends a **boon** for a while: loaned work crews (work under way moves an extra tick every third tick) or a priority convoy slot (the convoy carries a quarter more). One that lapses is simply replaced. They give the stretch between the first upgrades and the Beacon something to aim at. |
| **The Free Port** | After the Beacon, a harbour district (the Sanctuary Port in the default theme) that can build anything except other districts' raw extractors. Its **Trade Workshops** each lock in one recipe (changing costs credits and idle time) and turn colony goods into **trade goods**; a bigger plot runs a bigger batch. Sell them on the exchange, deploy them as **shields** that make a hazard harmless, or fill **missions** for the three factions to build standing and rank. Standing also unlocks what each faction has to tell you. |
| **Settlements** | Once the Beacon has transmitted, camps answer it, and the **Settlements** screen lets the colony sponsor them: one for the Beacon, one more with the Free Port, one more with the station. Three camps are on offer at a time, each of a kind (a foundry town, a valley settlement, a rail depot), with a trait and a lifetime, all rolled; when one moves on another takes its place. A sponsored settlement **draws its basket from the Core every tick** at the commitment you set (off, half, full), never below the reserve you set, and gives its benefit in proportion to what it has been getting: a **discount on upgrades, expansions and links**, **commuters** (extra hands that are not extra mouths), or **room on links and the convoy**. **Drives** take goods in bulk, in any amounts at any time; finishing one moves the settlement up a stage (a bigger basket, a bigger benefit) and doubles its benefit for a while. The last drive sets it on its own feet: it frees the slot and stays a trade partner for good, still giving a fifth of its benefit without being asked (each further partner counts for a little less). Now and then a settlement **appeals** for one thing quickly, for a short boon. Link room lent by a depot comes and goes with how well it is supplied: when it falls away, routes on an over-full link are slowed (food and water last) and say so, and nothing is cancelled. A settlement's card names any goods of its basket the reserve is holding back. Nothing sent earns credits: this is where a finished colony's goods go. |
| **The work queue** | Every place (the Core, each district, the station, each territory) has **one build slot** and a queue behind it, up to 8 orders. Building, replacing, expanding, upgrading and founding a district all wait in the same line and are carried out **strictly in order**: nothing behind the front starts early, even if it could be paid for, so a later order never spends what an earlier one is waiting for. An order is **paid for when it starts**, so it can be queued before the materials exist; the front order waits until its place can pay. Waiting orders can be moved up, down or to the front, or cancelled (an order under way is refunded in full). Queued plots show their place in line on the map. Places do not hold each other up. The Core and each district can buy a **second build slot** from hub level 3 and a **third** from level 5 in their hub pane (goods from that place's own stockpile, plus credits): that many orders from the front of the queue then run side by side, in the same strict order. |
| **Replace in place** | Swap a building for another on the same plot from its pane. The order goes through the work queue and the old building keeps working until its turn; then it is scrapped for the usual 50%, and the plot stands empty while the new one goes up, which takes 1.5 times its usual build time. Expansion levels are not carried over. |
| **Shutdown** | Critical shortages drain morale and people leave rather than starve. When morale reaches zero the colony does not collapse: it **shuts down**. Every building that is not essential is **parked** (housing and the Core's essential buildings stay on; everything in other districts is parked), the colony cannot collapse again, and it recovers on its own once nobody is starving and morale is back. Parked buildings stay parked until you restart them, all at once or one by one. You can keep rebuilding, or choose **Abandon colony** from the menu (two confirmations; progress resets, and the story starts over). |
| **Districts** | From hub level 4 the **Districts** tab lets you found satellite bases (**The Pits**: ore, ingots, alloys; **The Stacks**: crude, fuel, reagents, polymers, circuits, power cells; **The Greenbelt**: biomass, fertiliser, medicine (names are the neutral theme's)). Each has its own stockpile, power grid and 3-5-7-9-11 rings; people, crew and morale stay colony-wide. Founding is paid from the Core, upgrades from the district itself, so goods are moved by **shipments** (take ticks by distance; stock leaves at dispatch) and by standing **routes** (units per tick moved straight between stockpiles, with a reserve the source keeps and, if you set one, a target at which the destination stops taking more) over each district's **link**, whose capacity you can widen. Route flows show in every district's per-tick rates. District level 2 opens at hub 4, levels 3-4 at hub 5, level 5 once the Beacon is built. Switch between districts with the tabs over the map (the place button on a phone). |
| **Optional inputs** | Some buildings can take an extra input that is **off by default**. Switch it on from the building's pane and, while it is in stock, the building spends a fixed amount per tick for a bonus: fertiliser makes Hydroponics Bays grow x1.35, medicine makes homes happier. |
| **Expansions** | Any production, housing or infrastructure building can be built "upward" in its plot, to level 5: the whole line scales (x1.4 up to x2.6, with a little less extra crew), paid with trade goods made at the Free Port. It is size, not efficiency. Levels 6 to 10 (up to x4.6) appear once the first rare resource has come home to the station, and also cost goods made in orbit, at an escalating rate. Links between districts can be widened up to 440 per tick the same way. |
| **People** | The People tab shows what the population eats, what the colony can still feed, and where it is heading. When food or water runs short people leave instead of the colony collapsing (down to 5). Growth is judged on the Core's own production **plus what standing routes bring in or take out**, and a colony with a full stockpile can lean on it for a small shortfall, but it will not grow itself into a real shortage. Everyone eats from the Core stockpile; homes in other districts only add capacity and comfort. |
| **Spending credits** | There is no cap on credits, so the game gives them things to do. **Rush** (a button on the work order under way, two clicks) finishes it on the next tick for credits per remaining tick, and each rush in the last day costs 20% more than the one before. Orbital storage and link upgrades and the dropships cost credits as well as goods. Buying has a **daily allowance** (100,000 credits per hub level) across the exchange, the orbital market and express convoys; beyond it purchases carry a brokerage surcharge of +10%, +25% or +50% as spending climbs, which is burned. Normal play never reaches it. All the numbers are in `credits` in `game_config.json`. |
| **Going offline** | If your connection drops, clicks to build, demolish, pause, switch optional inputs, upgrade or change convoy orders are **held on screen** (a banner, a dashed marker on the map and a chip in the bottom bar) and sent in order when you reconnect. You can discard any of them first. Express trips, founding, shipments and resets need a live connection. |
| **Staying away** | A colony is simulated only while its commander is around: for **96 hours** after your last real interaction (signing in, opening the game, any click or key; an idle open tab does not count). After that it stops and waits exactly as it was; come back within **30 days** and it carries on, with a notice that the colony was held for you (nothing is taken). After 30 days it is **parked**: when you return you can **retake command**, **start a new colony** or log out. Starting over does not delete the old colony: it moves, still parked, to a generated account with its station renamed, where it waits to be claimed (`absence.claim`). Once that has happened, or once you have started over, it cannot be retaken. Both limits are `global.absence` in `game_config.json`. |
| **Synthetics Reclaimer** | Turns surplus raw synthetics into polymers, two to one (Stacks). Raw synthetics are priced to follow polymers on the exchange, so buying synthetics to convert never beats selling polymers. |
| **Offline progress** | The server owns the clock. Production, consumption, convoys and already-forecast hazards continue while you are logged out (capped at 1,200 ticks of catch-up after downtime). |

### Orbit

The multiplayer endgame, hidden until the colony's standing with all factions adds up to 500 (the Missions screen only hints at it). Until then the orbital buildings are not in the build menu, and the Orbit screens and the Surface | Orbit switch appear only once the first launch has founded the station. Full design in [`docs/orbital.md`](docs/orbital.md), numbers in section 16 of [`prod_guide.md`](prod_guide.md).

- **Launch:** build the Orbital Staging Platform and the Orbital Catapult side by side on Colossal plots in the Core, and the Orbital Command Center on a Heavy plot in the Free Port. Load a launch cycle (it draws frames, fittings and modules every tick), then name your station and launch. Later cycles open the station's second and third rings.
- **Orbital Command:** the Orbit side of the switch over the map (or the station in the phone's place list) goes to the orbit view, and the Orbit screens in the list have their own panes:
  - **Station:** Klein Reactors for power; Orbital Foundries that run trade recipes and six orbital-only recipes without crew.
  - **Storage:** slot-limited, one resource per slot, with jettison, rebuild and upgrades. It also manages the orbital links to the Core (both ways), the fuel-hungry express launch up and the cheap express drop down.
  - **Expeditions:** dropships and anomalous territories.
  - **Market:** the orbital market.
  - **Project:** the current global project.
- **Anomalous territories** are shared by every player:
  - Deploy a dropship, build field versions of ground buildings (the dropship supplies all the power and nothing needs a crew) and an anomaly tap, and draw a rare resource. Which ground goods a rare resource needs, and whether a territory can give them, is something to find out. Rare resources come home only by dropship. Now and then a territory also has a **data site**: build Data Recovery there (it needs only power) and, slowly, it recovers data fragments, which unlock lore packets on the Data screen.
  - Each anomaly sets how long the territory lasts and how dangerous it is.
  - Leaving early shortens it for the next visitor. Staying too long damages the ship, and a ship can be lost.
- **Back down:** the orbital goods (made from two rare resources each) pay for expansion levels 6 to 10 on the ground, so links and express drops bring them down to the Core.
- **Orbital market:** trade goods only, traded from orbital storage. Every order shows the station that posted it, and thin market makers set the band.
- **Global projects:** one at a time for the whole server, sized by the number of active stations. Players contribute by dropship. A completed project gives everyone standing and a temporary bonus (faster production lines, or a trickle of a rare resource).

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
src/orbital.js     Orbit: unlock, launch chain, station, slot storage, links, express launch
src/territories.js Shared anomalous territories and dropships   src/orbitalMarket.js  Orbital order book   src/projects.js  Global projects
src/objectives.js  Onboarding directives and the collapse clock
src/shutdown.js    Shutdown: parking and restarting buildings
src/story.js       Story beats, triggers, delivery pacing and validation
src/theme.js       Loads content/<theme>/theme.json onto the config
src/backup.js      Scheduled SQLite backups
src/security.js    Headers, same-origin check, rate limits, login throttle      src/validate.js  Input validation helpers
src/db.js          Schema (v18) and migrations, session store, colony helpers
game_config.json   All balance data (no wording that a theme replaces matters here; ids are stable)
content/           One folder per theme: theme.json (wording), story.json (narrative), assets/ (portraits, backgrounds)
scripts/           check-content.js (validate a theme), gen-prod-guide.js (regenerates prod_guide.md), playtest.js and playtest-orbit.js (scripted players for tuning, see below), botplay.js (the bots in-process)
bots/              the bot runner: runner.js (claims and schedules), client.js, assess.js (takeover check), profiles.js, brain/ (ground, endgame, orbit, trade, reorg)
public/            index.html (login), game.html (desk layout), mobile.html (phone layout), css/ (style.css, mobile.css), js/ (game.js, orbit.js for the Orbital Command view)
docs/              districts.md (district system, exchange, Free Port, roadmap), orbital.md (orbit endgame), story.md (theme and story format), security.md, content-needs.md
test/              node:test suites: simulation, balance guard, hazards, express convoy, districts and migration, exchange, Free Port, orbit, expansion and growth, shutdown, backups, story and themes, security, HTTP API
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
| `TRUST_PROXY` | `loopback` | Reverse proxies in front: a count (`1`), an address/range, or `false` when exposed directly |
| `ALLOWED_ORIGINS` | none | Extra origins allowed to make writes (comma separated) |
| `BCRYPT_ROUNDS` | `12` | Password hashing cost |
| `API_RATE_LIMIT` | `120` | API requests per player per 10 seconds |
| `MAX_STREAMS` | `1000` | Open live connections in total (4 per player) |
| `THEME` | `recontinuation` | Which `content/<folder>` supplies names and story (`basic` is the neutral original wording) |
| `BACKUP_INTERVAL_HOURS` | `6` | Automatic database backups; `0` turns them off |
| `BACKUP_KEEP` | `28` | How many backups to keep |
| `BACKUP_DIR` | `backups/` beside the database | Where backups go (owner-only) |
| `BOT_API_KEY` | none (bot API off) | Shared key for the bot runner (at least 16 characters). Unset, `/api/bot` answers 404. |
| `BOT_API_RATE_LIMIT` | `1500` | Bot API requests per 10 seconds, all bots together |

**Backups.** The server copies the database every few hours (a consistent snapshot taken while the game runs) into `backups/`, keeping the newest 28. To restore: stop the server, copy a backup over the database file, delete its `-wal` and `-shm` files, start the server. Backups contain password hashes, so the folder is owner-only like the database.

**Upgrading:** schema v4 changed ring sizes and the economy, so existing colonies are dropped on first start (accounts are kept and colonies are re-founded at next login).

### Bots for small worlds

A world with few players can run **bots** on parked colonies, so there are still neighbours trading on the exchange and the orbital market. The bot runner is a separate process that talks to the game server only through a key-protected bot API, so it can run on the same machine or another.

```bash
BOT_API_KEY=some-long-random-key npm start                                 # the game server, with the bot API on
BOT_API_KEY=some-long-random-key BOT_SERVER=http://127.0.0.1:3000 npm run bots   # the runner
```

Every hour the runner asks for colonies parked in the last 7 days (`BOT_POLL_SECONDS`, `BOT_PARKED_DAYS`); older ones are not considered, so a long list of long-abandoned colonies costs nothing. While it runs fewer than `BOT_LIMIT` (default 5) it looks at each candidate and **leaves alone any colony already on its way to collapse** (shut down, starving, a collapse clock it has neither the stock, the plots nor the time to stop, power or crews far short). It claims the stable ones, colonies whose commander chose to start over first. Each claim makes a bot account with a random callsign nobody can sign in to. If the colony belonged to a real player who simply went away, they are told it was claimed, as for any claim. Each bot takes a turn every few ticks through the same actions a player has. It keeps the colony fed, watered, powered and housed before anything else, grows it from whatever stage it was left at (the plans count what is already standing), wires the districts together, builds the Beacon, then the Free Port, earns standing with missions, builds the launch chain and goes to orbit. It **reorganises** a colony someone else laid out, replacing surplus or idle buildings in place when something it needs has no plot (two side-by-side Colossal plots for the launch pads included). In orbit it runs the station's reactor and foundry, sends dropships to the anomalous territories for rare resources, and **jettisons** orbital storage slots holding what it no longer needs. A colony that fails or stays shut down for long is given back: it parks again for someone else. After `BOT_RECHECK_HOURS` the runner looks at it once more; if it still isn't fit to take over, it goes on a **pickup blacklist** and is never looked at again (the game server leaves it out of the runner's listing). The exception is a colony someone else takes up and that parks again later: it counts as a new candidate. The blacklist is kept in the state file (`blocked`); delete an entry to undo it.

Bots let go of any settlements they inherit (those are for players) and never sponsor new ones. Some profiles give to the **global projects** (below); stations run by bots are not counted when a project's size is set, so projects stay sized for the people playing and anything bots deliver is help on top. Bots also prepare for forecast hazards: they bring in the stock the Brief asks for and raise the Free Port's shield when they hold its goods.

Every profile's main objective is to **sell on the orbital market**. They differ in temper:

| Profile | Plays |
| --- | --- |
| `broker` (Foundry Broker) | Pushes for orbit and the foundry, and sells orbital goods (lattice cores, null alloy...) in small lots at a price drawn fresh for each order between **20% under and 20% over** the market maker's reference. Buys small lots of foundry inputs. |
| `porter` (Port Trader) | A busy Free Port; keeps the **ground exchange** moving with sells and small buys of trade goods and surplus. In orbit, sells trade goods just under the best ask, and sends some to the global project. |
| `steward` (Steward) | Deep food and water reserves, slow and safe growth; gives everything its foundry makes to the global project, and sells spare trade goods at the reference price. |
| `industrialist` (Industrialist) | Builds big, takes every alternative recipe, fills requisitions; gives half its orbital goods to the global project and sells whatever it makes most of. |
| `scavenger` (Scavenger) | Lean; picks up cheap asks in small lots and sells orbital and trade goods near the reference. |

| Runner variable | Default | Purpose |
| --- | --- | --- |
| `BOT_SERVER` | `http://127.0.0.1:3000` | The game server |
| `BOT_API_KEY` | required | The same key the server was started with |
| `BOT_LIMIT` | `5` | Most colonies run by bots at once (lowering it gives the newest back) |
| `BOT_PROFILES` | all five | Which profiles to hand out (the least used goes to each new claim) |
| `BOT_CLAIM` | `all` | `given_up` claims only colonies whose commander chose to start over |
| `BOT_TURN_TICKS` | `4` | Ticks between a bot's turns |
| `BOT_POLL_SECONDS` | `3600` | How often it looks for parked colonies (bots take their turns in between regardless) |
| `BOT_PARKED_DAYS` | `7` | Only colonies parked within this many days are candidates (`0`: any; a colony a bot gives back parks afresh) |
| `BOT_RECHECK_HOURS` | `24` | How long a colony judged unsafe (or given back) is left alone; a given-back colony still unfit after that is blacklisted |
| `BOT_STATE_FILE` | `./bots-state.json` | The bots' memory across restarts (they play on without it) |
| `BOT_STATUS_PORT` | off | `GET /status` on 127.0.0.1 shows every bot's colony, last turn and trading |
| `BOT_LOG` | normal | `quiet` or `verbose` |

`npm run botplay -- --profiles broker,porter --ticks 6000` plays the same bot brain in-process on a throwaway world, several bots sharing it, and prints their milestones and trading.

### Tests

```bash
npm test                 # runs with THEME=basic; the tests assert the neutral wording
npm run check-content    # validate the active theme and story
npm run guide            # regenerate prod_guide.md from game_config.json
```

About 280 tests cover adjacency geometry, the power grid, plot penalties, hub upkeep, fuel generators, storage/defence, the beacon, market prices, convoy trading, the whole hazard lifecycle (only-when-active, strike while away, auto-averted, prorated penalty, away report), the exchange, districts and routes, expansions, shutdown and recovery, backups, themes and the story engine (including the full Recontinuation script), the security rules, time away and parked colonies, the full HTTP API, and a **balance guard**: a scripted player has to finish the beacon in a sane number of ticks without collapsing. If you retune the economy, that test tells you whether the game is still finishable.

## Security

The server is the only authority: the client sends intents and every rule is enforced server-side in a transaction. Input is validated strictly, writes must be same-origin JSON, sessions are regenerated on sign-in, logins and the API are rate limited, the database is owner-only, and a lock file stops two servers sharing one database. Details, deployment notes and what is deliberately not done are in [`docs/security.md`](docs/security.md). Run it behind HTTPS and set `TRUST_PROXY`.

## Where it is going

Built so far: the Core and three founding districts (each with its own rings, stockpile and grid), shipments and standing routes over upgradable links, the exchange, the endgame Free Port (trade goods, shields, missions, factions, rank), building expansions, optional inputs, the People tab, shutdown instead of collapse, backups, themes, the story with calls, mail, branching scenes, moods and portraits, and the orbit endgame (launch chain, station, slot storage and links, dropships on shared anomalous territories, the orbital market and global projects, with a second chapter of directives and story), the work queue and build slots, requisitions, alternative recipes, settlements, and time away (colonies stop being simulated when their commander is gone, and park after 30 days). The design history and decisions are in [`docs/districts.md`](docs/districts.md).

Not built yet (noted for later):

- **Per-district hazards:** hazards currently hit the colony as a whole. The plan is in `docs/districts.md`.
- **Inline images in mail:** the reading window can show them, the mail format has no field yet (`docs/story.md`).
- **Alerts while away:** a notification when a hazard is forecast or the colony shuts down (web push or mail).
- **Playtest telemetry** (which buildings, recipes and routes get used, where players stall).
- Balance numbers (orbit launch cycles, dropship damage, project sizes, expansion costs, exodus rates, link levels, recipes, missions, shutdown thresholds) are placeholders for playtesting.

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

### Story delivery

- **Calls.** A dialogue arrives as an incoming call in a card at the bottom right of the map (it also rings on login if a trigger was met while you were away). Answer when convenient; the card can be collapsed to a pill, and it is a pill to begin with on a phone or while a screen is open. Answering opens a full-screen scene that can be **minimized** into an "on call" bar and resumed. Played scenes stay in the Calls list of the Messages window and can be replayed.
- **Mail.** Mail goes to the Messages window (envelope, top right) with an unread badge and a toast. Clicking it opens a reading window with the sender's avatar.
- **Pacing.** Beats are delivered one at a time. When several are due at once (an existing colony catching up with a new script), the next arrives only once the previous ones were answered, skipped or read. A call never arrives while another call is unanswered.
- The script is not sent ahead of time: the client only receives text that has already been delivered to that colony.

Authoring guide and file formats: [`docs/story.md`](docs/story.md). The checklist for writing another theme: [`docs/content-needs.md`](docs/content-needs.md).

## License

ISC
