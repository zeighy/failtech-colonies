# Orbit: the multiplayer endgame

Orbit is where colonies stop being separate games. Every station shares the same anomalous territories, the same orbital market and the same global project. This document describes the design and where each part lives in the code. Every number is in `game_config.json` (`orbital`, `orbitalTypes`, `orbitalRecipes` and the buildings marked `hidden: "orbital"`). The generated tables are in section 16 of `prod_guide.md`.

## Unlock

- Orbit is invisible until the colony's standing with all factions adds up to `orbital.unlockStanding` (500). Before that, the orbital buildings are missing from the build menu and the API answers "Unknown building type." The only sign of it is a one-line hint on the Missions screen (`ui.missionsHint`).
- `orbital.checkUnlock` sets `colonies.orbital_unlocked` once and it stays set, even if standing later drops. It runs on every view and before every orbital action, so the unlock is immediate.
- On unlock, a second chapter of directives appears in the Brief (`objectives.js`, chapter 2, ids `o_*`). It is never shown before the unlock. The campaign's "Brief complete" ending counts chapter 1 only.

## The launch chain (ground)

| Building | Where | Rule |
| --- | --- | --- |
| Orbital Staging Platform | Core, Colossal plot only (`strictPlot`) | one only; takes one launch cycle at a time |
| Orbital Catapult | Core, Colossal plot only | must be next to the staging platform (`requiresAdjacent`); burns a little fuel to stay warm |
| Orbital Command Center | Free Port, Heavy plot only | must be running for a launch; it is the way into the orbit view |

- A launch cycle is stored in the staging building's `recipe` column, with progress in `colonies.launch_progress`.
- While a cycle is loaded, the platform adds the cycle's per-tick draw to its own inputs (`sim.rates`). Progress grows by the fully supplied share of each tick only, so a starved cycle stalls rather than finishing on credit.
- When progress reaches the cycle length, the cycle sets `launch_ready` and stops drawing. The catapult panel then offers the launch.
- Cycles:
  - `station`: the first launch. The player names the station: 3 to 24 characters, unique, not a username, not "Market maker". It arrives with a starter kit and dropship 1.
  - `ring2` and `ring3`: later launches that unlock the station's second and third rings. `ring3` also costs orbital goods made in orbit.
- Abandoning a cycle resets its progress and refunds nothing that was drawn.

## The station

- The station is a district of type `station` (`config.orbitalTypes`).
- Ring 1 has 4 Medium slots. Ring 2 (6 Large) and ring 3 (9 Heavy) come from the ring launches, and the radar shows the locked rings as "launched from the colony".
- Only station buildings can be built there:
  - **Klein Reactor:** burns power cells for power. The station has almost no base power.
  - **Orbital Foundry:** a crewless workshop. It runs the standard trade recipes at 2.5 × power (clamped 10 to 60) plus six orbital-only recipes, each of which needs two rare resources. It gets an adjacency bonus beside a reactor.
- **The rare resources are balanced.** Four of them feed two recipes each at 1 per tick; the other four feed one recipe each at 2 per tick. So if every orbital recipe runs, every rare resource is drawn at the same 2 per tick, and no territory roll is a worse pull than another.
- **Storage is slot-limited.** Each slot holds one resource, up to the level's cap.
  - Every tick the largest stocks claim slots first (`orbital.enforceSlots`). Anything left without a slot is lost, with a warning in the log.
  - Jettisoning empties a slot and removes the routes that carry that resource. The slot must then be rebuilt before it can be used again.
  - Storage upgrades add slots and raise the cap.
- **Orbital links** are ordinary routes between the Core and the station, in either direction. There are 4 at level 1, upgradable in count and rate. Rare resources never travel by link; they only come home by dropship.
- **Express launch** sends up to 400 of one resource from the Core for fuel. It arrives in 12 ticks and has a long cooldown, so it is for emergencies, not supply.
- **Express drop** is the other way: up to 400 of one resource from orbital storage to the Core, for a capsule (10 fittings from orbital storage) and no fuel. It needs the Command Center running and shares the express slot and cooldown with launches.

## Dropships and anomalous territories

- **Territories** are a shared world pool (`territories.advanceWorld`).
  - At least 7 are open at any time. A taken territory is replaced after a short delay.
  - Each territory has an anomaly that sets its lifetime, a rare-resource multiplier and its risk. Two of them are the gentle ones for someone learning the ropes: **Lull** stays open 2 to 5 days at the cost of a ×0.6 rare yield, and **Gloam** stays open 1.5 to 3.5 days at the cost of ×0.7 ship power (`powerMult`). Both do little damage if the ship is late.
  - **The rare is evened out.** A new territory's rare is picked at random from the rares that are least represented among the territories open right now, so with seven open they are always seven different rares, a rare another player just took is the first to come back, and every rare still comes up equally often over time. (Pure chance left a needed rare missing for long stretches.)
  - Each territory has two common resources (of Reclaim, Aquifer Draw and Raw Ink), one district resource (Raw Ore or Crude) and one rare resource. That makes 6 combinations of what the ground gives, and which rare resources can be extracted from them varies (see the Anomaly Tap below).
  - A territory has three rings (3 Small, 5 Medium and 7 Large plots), all open from the start. Power is what limits how much of it a player can use, until the dropship is upgraded. A fourth ring is a planned expansion.
- **Deploying** a docked dropship to a territory:
  - It lands after 15 ticks with a small construction kit plus anything preloaded from orbital storage.
  - The territory becomes a district of type `territory`. Its storage is the ship's hold and its power is the ship's power.
  - Only one station can hold a territory at a time.
- **Territory buildings:**
  - No power buildings and no crew: the dropship supplies all the power.
  - Field versions of ordinary ground buildings, paid from the hold, each with a `territory` block over its definition (`sim.territoryDef`). They are only offered where the territory holds what they work on (`needs`): the extractors for Reclaim, Aquifer Draw, Raw Ore and Crude, plus the water purifier, parts press, smelter, cracking tower and polymer plant. The Ink Reclaimer is an extractor for Raw Ink there, and the polymer plant needs no ingots there.
  - The **Anomaly Tap** is a recipe building, like the Free Port's trade workshop. Each territory has one rare resource, and the tap offers only that rare resource's recipes (two alternatives each, `tapRecipes`). Every recipe takes 8 + 8 of two ordinary goods and 18 power for 0.5 of the rare resource per cycle (× the plot's batch × the anomaly's richness). Changing the recipe costs no credits, only idle ticks, so players can find out what a rare resource needs by trying.
  - The game does not list the recipes. They are in the production guide only.
  - Roughly half of all territories can extract their rare resource (a test keeps it between 40% and 65%, with every rare working in 2 to 4 of the 6 combinations).
- **Links:** up to 2 per ship, between the territory and the station, at the ship's link rate. Rare resources are excluded.
- **Recalling** a ship:
  - It takes cargo by the player's plan, rare first, up to the hold.
  - The territory district is removed, and the cargo arrives in station storage 150 ticks later.
  - Leaving early destabilises the territory, so the next visitor gets only 35% of its remaining time.
  - Still being there when it closes forces a late recall that damages the ship.
  - Shear and Flare anomalies also damage a parked ship every tick.
- **Damage and loss:**
  - Repairs cost the ship's invested value × the damage share.
  - The first time a ship would be destroyed, it limps home at 10% integrity with its cargo lost. The second time, it is gone.
  - Up to 3 ships can be owned, built and upgraded at the station.

## Expansion levels 6 to 10

- Ground buildings can be expanded past level 5, up to 10 (output ×3.0 to ×4.6), once the colony's first rare resource has come home to its station (the `rareReturned` flag). Until then the expansion card stops at 5 and nothing says there is more. The story hints at it in the same moment (Vane and the footings).
- Each level past 5 costs the usual ground goods × (level - 1), plus the class's orbital goods × 1, 2, 3, 5, 8 for levels 6 to 10:
  - housing: Cliffside Rejuvenator and Stabilized Alloy;
  - infrastructure: Sirius Cell and Phononic Amplifier;
  - industry: Dense Metal and Sirius Core.
- The goods are paid from the building's own district, like any expansion, so they come down from orbit to the Core (by link or express drop) and are routed or shipped on from there. This is what the downward links and the express drop are for.
- `sim.expansionMax` gives a colony's ceiling, and `sim.expansionCost` adds the orbital goods above `expansion.maxLevel`.

## Orbital market

- This market is separate from the ground exchange. It trades only trade goods (`trade` or `orbitalTrade`), straight from orbital storage, and every order shows the station that posted it.
- Market makers post a small bid and ask per good around the ground reference price every 240 ticks. They never trade with each other. They set the price band and a suggestion; they are not a shop.
- Matching:
  - Price first, then time, at the resting order's price.
  - Sellers pay a 4% fee.
  - Sells hold their goods and buys hold their credits from the moment they are posted.
  - A buy also needs a free storage slot for the good.
- Orbital-only resources never appear on the ground exchange or in contracts.

## Global projects

- One project runs at a time for the whole server (`projects.advanceWorld`). Each project goes through these states:
  - **announced:** shows the next project and when it opens.
  - **active:** takes contributions.
  - **bonus:** completed. The bonus runs for half the contribution period.
  - **failed or done:** the next project is announced.
- Needs are per player, multiplied by the number of stations active since the previous announcement, so a small server can still finish one.
- The contribution period is twice the time it would take one player to make their share at a reference rate.
- Contributions travel by dropship. A ship is away for 240 ticks and delivers halfway through the trip. If the project closes first, the cargo comes back.
- There are seven projects in rotation, and every orbital good is needed by at least two of them, so projects are a sink for all six.
- Completion gives every colony standing with the project's faction, and one of two kinds of bonus:
  - an efficiency bonus for a set of buildings, on every colony;
  - a drip of one rare resource into every station's storage.

## Story

- Story triggers can use the sticky flags in `colonies.orbital_flags`, set by `orbital.setFlag` (trigger `{ "type": "orbital", "flag": "launched" }`). The flags are:
  - `unlocked`, `staging`, `catapult`, `command`, `cycleDone`
  - `launched`, `ring2`, `ring3`
  - `deployed`, `rareReturned`, `shipSaved`, `shipLost`
  - `contributed`, `projectCompleted`
- The Recontinuation story adds five scenes and eight mails for chapter two (the ring launches and a lost dropship are flavour beats with no directive). The basic theme has a shorter set.

## Code map

| File | What it owns |
| --- | --- |
| `src/orbital.js` | unlock, flags, launch cycles and launches, station, slots, links, express launch, the orbit view |
| `src/territories.js` | the territory pool, dropships, deploy, recall, damage, repair, territory links |
| `src/orbitalMarket.js` | the orbital order book and the market makers |
| `src/projects.js` | global projects, contributions and bonuses |
| `src/sim.js` | field versions of ground buildings (`territoryDef`), recipe books (`recipeBook`), district overrides (`capOverride`, `baseEnergy`, `outputMult`, `globalOut`) |
| `public/js/orbit.js` | the Orbital Command panes (storage, territories, market, project) and the launch controls |
| `test/orbital.test.js` | the whole chain, from unlock to projects |

Once per tick, the shared world advances before any colony: territories, then projects, then the orbital market. Each colony's station then handles landings, returns, contributions, express arrivals and slot enforcement after the colony steps.
