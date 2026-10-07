# Districts: design

Status: **agreed direction, under construction.** Step 1 (the refactor) is being built first; everything after it is
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
| Unlock | District map appears at **Core hub level 4**. Initially a district can only reach **level 2**, just enough to route its signature resource back to the Core. |
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

- **District level cap curve.** At Core level 4 a district may reach level 2. What lifts the cap to 3, 4 and 5 (Core level 5? something else)?
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
