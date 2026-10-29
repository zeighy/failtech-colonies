# Districts: design

Status: **agreed direction, under construction.** Steps 1 (refactor), 2 (map, founding, rings, upgrades, manual shipments, The Pits), 3 (routes, link capacity, logistics tab) and 4 (the Stacks, the Greenbelt, the chain restructure, a multi-district scripted player) are built; everything after them is
a plan and the numbers are placeholders to be tuned by playtesting and by the scripted-player simulation.

## Vision

Today's colony is the *Core*: a stable base that grows from a hub through five rings and finishes with the Beacon.
The next stage widens the game. Once the Core is established the player founds **districts**: satellite bases, each
built like a small copy of the Core (a district core plus rings to expand into), each producing distinct resources
that the other districts and the Core need. That creates multi-district production chains, a real logistics problem,
and a larger market to trade in.

## Agreed decisions

| Topic | Decision |
| --- | --- |
| Stockpiles | **One per district.** Resources move between districts by shipments and routes. |
| Population | **One colony-wide pool.** Homes in any district add to the cap; crew and morale are colony-wide. Population eats from the Core stockpile. |
| Power | **One grid per district.** A remote district powers itself. |
| Unlock | The district map appears at **Core hub level 4**, where a district can reach **level 2**: just enough to route its signature resource back to the Core. **Levels 3-4 unlock when the Core reaches level 5.** **Level 5 unlocks when the Beacon is built** (with the Core at level 5), as a reward for beating the game. Encoded in `config.districtProgression`; enforced when a district is upgraded. |
| Core space | Some buildings currently in the Core become district buildings, freeing Core slots and making districts the source of those goods. (Chain restructure below, to be confirmed.) |
| Win condition | **The Beacon stays the win condition.** Its requirements are re-tuned to the new chains. |
| District types | **Three first** (Pits, Stacks, Greenbelt); Silicon Yards later. |
| Rings | Districts have **3-5-7-9-11** slots per ring, levels 1-5. |
| Plot sizes | District plots are smaller than the Core's at the same level: levels 1-2 **Small**, 3 **Medium**, 4 **Large**, 5 **Heavy**. **Colossal exists only in the Core**, so anything that needs it (the Beacon) belongs there. Building a big building on a small plot stays allowed in districts, with the same output penalty as today. |
| Founding / upgrades | Founding a district is paid from the Core stockpile. Upgrades are paid from the **district's own** stockpile, so resources must be funnelled there. From **district level 3** upgrade costs need goods that only other districts (or the market) supply. |
| Market | A new **order-book market**, separate from the convoy, seeded with NPC counterparties for now. Built so players can later post their own buy/sell orders at their own prices. |
| Multiplayer | Not yet. The market's tables and matching are designed to take player orders later. |
| Pacing | 15 s ticks stay for testing. The game gets much longer; balance is tuned by playtesting. |

## Open questions

- **Where population eats** once districts house people. Decided for now: the Core stockpile. Revisit if districts become large.
- **Hazards per district.** For now the hazard system acts on the Core only; each district will need its own exposure and probably its own hazard types.

## Proposed production restructure (to confirm)

Constraint: hub level 4 needs alloys and level 5 needs alloys and circuits, and districts only unlock at Core level 4. So the **Core keeps everything needed to reach level 4**, and the later chains move out.

Stays in the Core: the T0-T2 basics, kitchen and meals, the Foundry (alloys for the level 4 upgrade), warehouses, defence, housing, power.

Moves to districts:

| Building / good | Moves to | Why it fits |
| --- | --- | --- |
| Synthetics Reclaimer (raw synthetics) | Stacks | Plastics from petrochemical waste. |
| Circuit Fabricator | Stacks / later Silicon Yards | Circuits need polymers and rare earths instead of plain scrap. |
| Cell Forge (power cells) | the district that makes the last intermediate | The most demanding build; wants district goods as inputs. |
| Bulk alloys for level 5 and the Beacon | Pits | Ingots and rare earths from ore, so the Core Foundry is no longer the only route. |

New districts and their goods:

| District | Raw / local | Needs from another source |
| --- | --- | --- |
| **The Pits** (salvage, mining) | ore, ingots | reagents (for rare earths) |
| **The Stacks** (petrochemical) | crude, fuel, reagents, polymers | ingots (pipework) |
| **The Greenbelt** (bio domes) | biomass, fertiliser, medicine | reagents, polymers |
| *Silicon Yards* (later) | microchips, optics | rare earths, polymers |

Tier ladder: T0 raw local, T1 refined locally, T2 needs one other district's input, T3+ needs two or more districts.
The Beacon's requirements are then re-expressed in these goods (rare earths, polymers, microchips) so finishing the
game requires the whole web.

## Logistics

- **Shipments**: one-off transfers between districts (needed to found and upgrade). Take ticks by distance.
- **Routes**: standing flows of X units per tick from A to B with a reserve floor on the source. Idle-friendly.
- **Link capacity** per district pair, upgraded with building materials. Goods in transit are stored, so delays matter.

## Market

- Orders: side, resource, price, quantity, expiry, delivery district. Sells are held at posting, buys escrow credits.
- Matching by price then time, partial fills, a fee on fills as a credit sink.
- Seeded NPC market makers quote around a reference price that follows a seeded random walk, with shortage and glut
  events and limited depth, thinner for higher tiers. Deterministic and testable.
- Convoy stays: guaranteed, low volume, base goods, clearly worse than the market so there is no arbitrage.
- Later: player orders enter the same book; NPC depth shrinks as players arrive.

## Build order

1. **Refactor (this step).** `districts` table; buildings, orders and inventory belong to a district; the simulation
   runs per district plus one colony-wide pass; the Core is District 0. **No change in play**, proved by the existing
   tests, a migration test and the scripted-player balance test.
2. District map, founding, the 3-5-7-9-11 rings, upgrades, manual shipments, one district type.
3. Routes, link capacity, the logistics tab.
4. Remaining district types, cross-district costs, the chain restructure; extend the scripted player to several districts.
5. The market (order book, matching, NPC liquidity, UI).
6. Per-district hazards, telemetry, polish.

## Constraint from the progression rule

District level 5 only opens once the Beacon is built, so **nothing the Beacon needs may depend on a level-5 district**.
When the chains are restructured (step 4) the Beacon's inputs must all be producible by districts at level 4 or below.
Districts at level 5 are the endgame reward, not part of the path to it.

## Step 1 design notes

- `sim.stepDistrict` runs one district's production, power, upkeep, housing and comfort. `sim.stepColony` computes
  colony-wide crew and morale first, runs every district, then does population, meals, morale and growth against the
  Core stockpile. `sim.step` stays as the single-district entry point and is defined in terms of the new functions.
- The Core's level is still `colonies.hub_level` (so existing code and tests keep working); other districts will use
  `districts.level`.
- Database: `colony_buildings`, `colony_inventory` and `colony_work_orders` gain `district_id`. A trigger gives rows
  inserted without one the colony's Core district, so existing code keeps working. The migration is additive and
  keeps all existing colonies.
- The API accepts an optional `district` on building actions and defaults to the Core.

## Step 2 notes (built)

- `config.districtTypes.<type>`: name, colour, map position, `distance` (ticks to the Core), `foundCost`/`foundTicks`, `startingStock`,
  `ringPlotSize` and per-level `levels` (storage, base power, ring capacities 3-5-7-9-11, upgrade cost). The Pits is the first type.
- Buildings carry an optional `districts` list; without one they can go anywhere. Pits-only: Ore Drill, Smelter, Alloy Works. The Beacon is Core-only.
- Founding is a `found` work order at the Core (one district per type). Shipments (`colony_shipments`, schema v7): stock leaves
  at dispatch, arrives after `distance` ticks (district to district goes via the Core); overflow beyond storage is lost; limits in `config.logistics`.
- Reagents have no producer yet (the Stacks will make them), so the Pits level 3+ upgrades need them from the convoy for now.
- The state view carries `views[districtId]` (stock with rates, grid, hub, buildings, orders); top-level fields are still the Core's.

## Step 3 notes (built)

- **Routes** (`colony_routes`): a standing flow of up to `rate` units per tick from one district to another, never taking the source below `reserve`
  and never overfilling the destination. Routes are **direct transfers between stockpiles in the same tick** (`sim.applyRoutes`): no trucks, no delay, no
  shipments. The rates every district shows already include them (source down, destination up). At most `logistics.maxRoutes`. (An earlier version
  simulated a truck per tick, which used up the one-off shipment slots and hid the flows; the old `route_id` column is only read for in-flight leftovers.)
- **Links**: every satellite has one link to the Core (`districts.link_level`, levels in `config.logistics.link`). Its capacity (units per tick) is shared by every
  route touching that district; a route between two satellites counts against both. Widening a link is paid from the Core and is instant.
- One-off shipments are limited (`maxInFlight`) and take `distance` ticks. The Districts tab has a Districts / Logistics switch.

## Step 4 notes (built)

- **The Stacks**: crude pump, cracking tower (fuel + reagents), polymer plant (needs ingots from the Pits), fuel generator; and the buildings that moved here:
  synthetics reclaimer, circuit fabricator (now also needs polymers), cell forge. Needs from elsewhere: ingots, machined parts, alloys.
- **The Greenbelt**: bio dome, agri lab (fertiliser), pharma lab (medicine; needs reagents and polymers from the Stacks).
- **The Core** keeps everything up to hub level 4 (including the Foundry for the level 4 alloys). Hub level 5 needs circuits (Stacks) and the Beacon needs
  power cells (Stacks) and medicine (Greenbelt), so the whole web is on the path to the end. Nothing the Beacon needs depends on a level-5 district.
- District level 3+ upgrades need goods from other districts: Pits (reagents), Stacks (ingots), Greenbelt (reagents, polymers; level 5 also medicine).
- `test/balance.test.js` now drives the real actions and engine with a scripted player that founds all three districts, sets standing routes, tops up
  districts by hand, and finishes the Beacon (around tick 870; bound 450-1000). `BOT_LOG=1` prints a timeline, `BOT_DEBUG=<tick>` dumps district stocks.
- Placeholders still to tune by playtesting: every number in `districtTypes`, `logistics`, and the new building recipes; the use of fertiliser (nothing needs it yet).

## Chain rebalance and optional inputs (built)

- **Stacks** are shallower: the polymer plant also makes raw synthetics (the reclaimer is now optional), a circuit fab needs 4 synthetics and 3 polymers, and the
  crude pump, polymer plant, circuit fab and cracking tower fit a Small plot with no penalty. One plant feeds two fabs. Core hub level 5 upkeep takes 0.5 circuits/tick.
- **Pits**: the Alloy Works makes 9 alloys/tick (the Core Foundry makes 3), so once the Pits have Large plots it is the place for alloys. The Foundry stays buildable in the
  Core because the Core's own level 4 upgrade needs alloys before any district exists; after that it can be demolished to free ring slots for housing and support.
- **Greenbelt**: bio domes drink raw water (one pump, no purifier), the pharma lab fits a Medium plot, the agri lab a Small one.
- **District power**: every district gets 30/45/60/75/90 base power at levels 1-5.
- **Optional inputs** (`building.optional`): off by default, switched on per building from the Site pane (`POST /api/boost`, stored in `colony_buildings.boost`).
  While on and fully in stock the building spends a fixed amount per tick from its own district stockpile and gets a bonus (`outputMult` on its output, or `comfort` on
  homes, which feeds the morale target). If the stock is short nothing is spent and the pane says it is waiting. Hydroponics Bay: fertiliser (x1.35 rations).
  Dormitory/Habitat: medicine (+6/+8 comfort). It is generic, so more can be added in config.
- **Hazard sinks**: from hub level 4 Crop Blight also wants fertiliser, Toxic Spill and Raid want medicine (`requires[].fromHub`), so the Greenbelt matters all game.

## Step 5 notes: the exchange (built)

- **One book per resource** (`market_orders`), shared by NPC market makers and players, so player-to-player trading needs no new code. Orders match by price, then
  time; a trade happens at the price of the older (resting) order; a player never trades with themselves, and NPCs never trade with each other.
- **NPC market makers** (`src/marketsim.js`, pure and deterministic): a reference price per resource from the geometric mean of the convoy's buy and sell price,
  times a smooth seeded walk (three sine waves) and occasional shortage/glut windows (x1.45 / x0.7, with the affected side's depth cut to 35%). Five rungs per side,
  re-quoted every tick and regenerating 8% of their depth per tick, so eating the book leaves it thin for a while. Bids stay under 90% of the convoy's buy price
  and asks over 110% of its sell price, so the convoy is never a better deal than the book.
- **Orders** (`src/market.js`, `POST /api/market`, `/api/market-cancel`): sells are held from the chosen district's stockpile; buys escrow credits at the limit price and
  are refunded the difference when they fill at a better one; goods are delivered straight to the chosen district, and a buyer with no room waits rather than losing
  goods. Up to 10 open orders, 1000 per order, lifetimes of 30/100/300 ticks; expired and cancelled orders give everything back. A 4% fee on the seller's proceeds is
  the credit sink. Prices are credits per unit with two decimals.
- **Unlock**: hub level 4 (`config.exchange.unlockCoreLevel`), with the districts. A directive ("Name your price") ticks on the first order.
- **View**: `view.exchange` has the reference price, history, event, book (top five rungs, with the player's own share marked), the player's orders and recent trades.
- The convoy and express trips are unchanged: guaranteed, small, and priced worse.

## The Free Port, trade goods, shields and missions (built)

An endgame district, founded after the Beacon is built (`districtTypes.freeport.requires.beaconBuilt`), where colony goods are turned into **trade goods** that exist to be sold,
spent on hazards, or handed to factions.

- **District rules**: it builds anything except the other districts' base-resource extractors (`rawExtractor`: ore drill, crude pump) and Core-only structures
  (`sim.buildableIn`), so a player can power it themselves, ship in fuel, or run intermediate chains there. The **Trade Workshop** can only be built here.
- **Trade Workshop** (`building.recipeBuilding`): runs one recipe from `config.recipes`. The first choice is free and locks in; changing it costs credits
  (`tradeWorks.reset.feeTicks` ticks of the old recipe's output at market value, scaled by batch) and idles the workshop for `delayTicks`. Scrapping a configured workshop charges the same fee and keeps the slot clear for the same `delayTicks` (it shows as "clearing" on the map and cannot be built on), before a new building's own construction time starts.
  **Plot size sets the batch** (`tradeWorks.batchByPlot`): inputs, outputs, power and crew all scale together, so a big plot is more throughput per slot, never a better ratio.
  A recipe gets an output bonus beside a workshop making its ingredient (`recipe.adjacent`).
- **Trade goods** (`resource.trade`) are never carried by the convoy; the exchange is their market. Their reference price is a fixed premium (`priceRatio`) over the live price of
  their ingredients, so crafting from goods bought on the exchange can never be a money machine (a test checks it), and their books refill slowly (`exchange.tradeRegenPerTick`),
  so one workshop can saturate a market. Ten recipes in three tiers; higher tiers need lower-tier trade goods.
- **Shields** (`hazards.shield`): from the hazard card, deploy a trade good (Precision Tools, Field Kits, Growth Stimulants, Luxury Goods, by hazard) from the Core stock.
  If it is there when the hazard lands it is spent and the hazard has no effect at all: no penalty, no maintenance cost, no reserves spent. Without enough stock it falls back to the usual consequences.
- **Missions** (`src/missions.js`, `missions` and `standing` tables): three open at once. Each is offered in the name of every faction, each asking for a different good;
  fill one offer and the others lapse. Pays `rewardMult` x market value plus standing. Standing has no effect yet; it is a score, per faction and in total, and the hook for later.
  Deterministic per colony and tick. Factions are in `config.missions.factions`.

## Quality-of-life pass (built)

- **Routes**: up to 40 (was 12). **Links** now widen beyond 140 per tick, to level 10 (440 per tick): each level past 4 adds 60 per tick and costs
  `n x (4 frames + 2 fittings)` on top of the usual materials, a straight-line growth in trade goods. Paid from the Core, so the Free Port's goods have to be routed there.
- **Free Port building list**: the server decides what each district can build (`sim.buildableIn`) and sends it to the client (`buildableIn` in the client config); the menu
  used to apply only the per-district `districts` list, which hid every other district's buildings at the Free Port.
- **Expansions** (`building.expand`, `config.expansion`): build a building "upward" in its plot, to level 5. The whole line scales (inputs, outputs, power; homes for housing,
  storage, defence) by x1.4/1.8/2.2/2.6, and crew by x1.2/1.4/1.6/1.8, so it is size, never efficiency. Paid from the district's own stockpile with trade goods made by recipes
  at the Free Port (Structural Frames, Process Fittings, Habitat Modules). The cost is the class's base cost x (level - 1): a straight line. A work order; cancelling or
  demolishing refunds it. `colony_buildings.level`, `POST /api/expand`.
- **People**: a People tab shows population against homes, what each person eats, the whole colony's use, stock, net and how many more people the surplus would feed, the
  morale breakdown and thresholds, crew, and an "if you leave now" line.
- **Leaving instead of collapsing**: when food or water runs short, 6% of the people (at least one) leave each tick, down to `minPopulation` (5), and hunger costs morale in
  proportion to the shortage (min 20%) instead of the full rate, so a colony shrinks to what it can feed and recovers rather than being lost. Below morale 45 people also leave, slowly.
  Growth now needs a surplus big enough for the new people, so a colony no longer grows itself into a shortage. A colony with no food production at all is still lost.
- **Interface**: typed values everywhere there was a +/- stepper (hold Shift for steps of 100; steps are 10 for everything); logistics has its own tab; toasts sit left of the
  panel; the Brief tab drops the directives once they are all complete.

## Reclaimer and growth on a full stockpile (built)

- **Synthetics Reclaimer** now converts surplus raw synthetics into polymers at 2:1 (12 in, 6 out per tick at full speed; it sits beside a polymer plant for x1.1).
  Raw synthetics were priced near zero, which would have made that conversion a money machine on the exchange, so their price now follows the polymer price
  (`exchange.priceLinks`: half a polymer) and the convoy price was raised to match. A test checks that buying synthetics to convert never beats selling polymers.
- **Growth** no longer stops just because the surplus is thin while the store is full. `sim.canFeed`: new people are allowed if what the colony makes covers them, or, failing
  that, if the stock above 60% of the cap would carry the new shortfall for 2000 ticks (`populationGrowth.bufferFloor`, `bufferTicks`). A full store lets a colony whose production only just
  matches use keep growing a little; an empty one does not, and a real shortage is never carried. The People tab says when the colony is growing on its stockpile.

## Future work: per-district hazards (not built)

Hazards currently hit the colony as a whole: every effect reads the Core's reserves and defence, and building effects apply
across all districts. The next step is to let a hazard strike one district: forecasts would name a district, requirements
(reserves, defence) would be checked against that district's own stockpile and Sentinel Posts, and effects (output cuts,
looting, degraded buildings) would apply there only. Open questions: whether the Core can pre-position reserves by shipment
or route after the forecast, whether routes and links can be hit, and how the Free Port shields apply. Roadmap step 6.

## Growth and routes

The growth check ("can the colony feed more people?") judges the Core on its own production **plus what standing routes bring in
or take out** of it. Before this was counted, a Core that made less food than it ate but was fed by a route from another district
looked like a shortage to the growth check while the player's rates showed a healthy surplus, and the population stalled.
