# **FAILTECH Colony: Production Chains, Hub, Hazards & Economy**

Numbers here mirror `game_config.json` (the config is the source of truth; most tables below were generated from it). A tick is **15 seconds** by default (`TICK_MS` overrides it).

## **1. Survival drain**

* Start: **20 population**, each eating 0.1 rations and drinking 0.1 clean water per tick (a starting drain of 2 + 2 per tick).
* Starting stock: 80 clean water, 100 rations. A colony that does nothing hits its first shortage around tick 40 and collapses around tick 50 (morale falls 10 per starving tick).
* Population grows by 1 every 10 ticks while morale is high and water and rations are both in surplus, capped by hub level.

## **2. Power is a grid**

Energy is not stockpiled. Each tick, supply (hub power plus generators) is compared with demand (the energy input of everything running). If demand exceeds supply, **every consumer runs at supply/demand efficiency**. Paused and damaged buildings draw nothing. Fuel generators (Scrap Burner) also consume an input and stop without it.

## **3. Tiers and chains**

| Tier | Resources |
| --- | --- |
| 0 (raw) | scrap, raw water, raw synthetics |
| 1 | clean water, rations, machined parts |
| 2 | building materials, prepared meals |
| 3 | alloys, circuits |
| 4 | power cells |

Chain to the finale: scrap + parts → **alloys** (Foundry); raw synthetics + parts → **circuits** (Circuit Fabricator); alloys + circuits → **power cells** (Cell Forge); the **Beacon Array** consumes power cells and a lot of energy while transmitting.

## **4. Buildings**

| Building | Type | Min plot | Cost | Inputs / tick | Outputs / tick | Crew | Comfort | Build |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Solar Array | generator | Small | 100 scrap | – | 25 power | – | – | 2 |
| Scrap Extractor | extractor | Small | 200 scrap | 5 power | 50 scrap | 2 | -6 | 3 |
| Groundwater Pump | extractor | Small | 150 scrap | 5 power | 20 raw water | 2 | -1 | 3 |
| Filtration Plant | refinery | Small | 300 scrap, 10 machined parts | 10 power, 15 raw water | 15 clean water | 2 | -1 | 5 |
| Parts Assembler | refinery | Small | 400 scrap | 10 power, 30 scrap | 6 machined parts | 3 | -4 | 6 |
| Hydroponics Bay | producer | Small | 500 scrap, 25 machined parts | 15 power, 5 clean water | 10 rations | 3 | +4 | 8 |
| Fabrication Works | refinery | Medium | 450 scrap, 30 machined parts | 12 power, 20 scrap, 2 machined parts | 4 building materials | 4 | -5 | 7 |
| Scrap Burner | generator | Large | 400 scrap, 30 machined parts | 15 scrap | 80 power | 2 | -7 | 6 |
| Synthetics Reclaimer | extractor | Small | 250 scrap, 10 machined parts | 8 power | 12 raw synthetics | 2 | -3 | 4 |
| Foundry | refinery | Large | 600 scrap, 40 machined parts, 20 building materials | 22 power, 40 scrap, 2 machined parts | 3 alloys | 5 | -8 | 8 |
| Circuit Fabricator | refinery | Large | 500 scrap, 50 machined parts, 30 building materials | 18 power, 10 raw synthetics, 1 machined parts | 2 circuits | 5 | -3 | 8 |
| Cell Forge | assembler | Heavy | 900 scrap, 80 machined parts, 80 building materials, 30 alloys, 20 circuits | 30 power, 3 alloys, 2 circuits | 1 power cells | 6 | -5 | 10 |
| Warehouse | utility | Medium | 300 scrap, 15 machined parts | – | +1000 storage | 1 | – | 4 |
| Watch Post | defense | Small | 250 scrap, 20 machined parts | 4 power | 1 defence | 2 | +2 | 4 |
| Beacon Array | beacon | Colossal | 1000 scrap, 200 building materials, 160 alloys, 100 circuits, 30 power cells | 60 power, 1 power cells | 1 signal | 8 | -2 | 20 |
| Kitchen | refinery | Medium | 350 scrap, 25 machined parts | 6 power, 6 rations, 3 clean water | 8 prepared meals | 3 | +2 | 5 |
| Dormitory | housing | Small | 250 scrap, 15 machined parts | – | 10 homes | – | – | 3 |
| Habitat Block | housing | Large | 700 scrap, 50 machined parts, 30 building materials | – | 30 homes | – | – | 6 |

A building with partial inputs runs at partial efficiency (limited by its scarcest input). Chains resolve in order (generators, extractors, refineries, assemblers, producers, beacon), so output made this tick can be consumed this tick.

## **4b. People, housing, crew and morale**

* **Housing.** The population cap is the hub's own quarters (30, 35, 40, 45, 50 at levels 1-5) plus the homes you build (Dormitory 10, Habitat Block 30; both scale with plot size like any other output). Population grows by 3 ticks per person (two at morale 90+) while food and water are in surplus, morale is 60+ and there is room. If homes are lost, people leave.
* **Crew.** Most buildings need workers. The workforce is 80% of the population. If there are fewer hands than posts, **every staffed building runs at the same reduced efficiency** (automated ones such as Solar Arrays and homes need nobody). The top bar shows crew as a percentage.
* **Meals.** Prepared Meals (Kitchen: rations + clean water + power) are optional: nobody starves without them. People eat 0.05 per head per tick; the share of people actually fed adds up to **+15** to the morale target.
* **Comfort.** Every building has a comfort effect on **adjacent homes** (see the table: industry is negative, greenery and guards are positive), summed per home and clamped to -15..+8. The colony's comfort is the capacity-weighted average over its homes, with the hub's own quarters counting as neutral.
* **Morale target** = base 80 + comfort + meals. Morale moves toward the target (2 per tick up, 1 down); starvation still drops it 10 per tick, and at 0 the colony collapses.
* **Output effect.** Morale scales production: ×1.0 between 70 and 85, a slowdown of 1.2% per point below 70 (floor ×0.5), and up to +8% at 100.

## **5. Plots**

Each ring has a plot size, and **plots get bigger outward**:

| Ring | Plot size | Slots |
| --- | --- | --- |
| 1 | Small | 6 |
| 2 | Medium | 8 |
| 3 | Large | 10 |
| 4 | Heavy | 12 |
| 5 | Colossal | 14 |

Every building has a **minimum plot size**. It can be placed on a smaller plot, but its **output is multiplied by 0.6 for each missing size step** (inputs are still consumed in full). Storage and defence bonuses scale the same way, and the Beacon's signal does too. This ties big buildings to the outer rings, and so indirectly to the hub level needed to open those rings, even though the buildings themselves are available from the start.

## **6. Adjacency**

Neighbours are the two slots beside a building in its ring plus every touching slot in the rings above and below. Each matching neighbour multiplies output (clamped to ×0.5 to ×1.6):

* Filtration Plant next to Groundwater Pump: ×1.15
* Parts Assembler next to Scrap Extractor: ×1.1
* Hydroponics Bay next to Filtration Plant: ×1.15
* Fabrication Works next to Parts Assembler: ×1.1
* Hydroponics Bay next to Scrap Extractor: ×0.85
* Groundwater Pump next to Scrap Extractor: ×0.9
* Solar Array next to Solar Array: ×0.95
* Foundry next to Scrap Extractor: ×1.1
* Circuit Fabricator next to Synthetics Reclaimer: ×1.15
* Cell Forge next to Foundry: ×1.1
* Cell Forge next to Circuit Fabricator: ×1.1
* Scrap Burner next to Scrap Extractor: ×1.1
* Watch Post next to Watch Post: ×1.1
* Circuit Fabricator next to Foundry: ×0.9

## **7. Hub levels**

| Level | Upgrade cost | Time | Storage | Hub quarters | Base power | Rings | Upkeep / tick | Convoy limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | start | – | 2,000 | 30 | 20 | 1 | – | ×1 |
| 2 | 1200 scrap, 60 machined parts | 10 | 4,000 | 35 | 30 | 2 | – | ×1.5 |
| 3 | 2500 scrap, 120 machined parts, 60 building materials | 14 | 6,000 | 40 | 40 | 3 | 12 power, 1 machined parts | ×2 |
| 4 | 3500 scrap, 180 machined parts, 140 building materials, 50 alloys | 14 | 8,000 | 45 | 50 | 4 | 25 power, 1 machined parts, 1 alloys | ×3 |
| 5 | 5000 scrap, 220 building materials, 100 alloys, 50 circuits | 18 | 12,000 | 50 | 60 | 5 | 40 power, 2 machined parts, 2 alloys, 1 circuits | ×4 |

From **level 3** the hub has upkeep: it draws power and supplies every tick. If the upkeep can't be met, the hub's own power output drops with it, which cascades into brownouts. Warehouses add storage on top of the hub's cap.

## **8. Hazards**

Hazards are forecast, then strike on a fixed tick, then **last for a while whatever the outcome**.

* A new hazard is only **started while the player is active** (recently connected). The first can come at colony age 45, then every 32-52 ticks, shrinking by 7% per hub level above 1 (floor 60%).
* Once forecast, the strike tick is fixed and fires **whether or not the player is logged in**.
* At the strike the colony spends its **reserves automatically**, each requirement met in proportion to what is stocked. That gives a preparedness fraction (**prep**).
* Then the hazard runs for its duration:
  * the **failure effect** applies at severity = 1 − prep (output cuts, degraded buildings, higher consumption, looting);
  * a **maintenance cost** applies in proportion to prep. **Weathering a hazard is never free**: a fully prepared colony takes no penalty but pays a running cost.
* A player who was away gets a **While you were away** report on return.
* Requirements scale with hub level (+60% per level above 1). Some hazards only appear at higher levels, and the Signal Storm only if a Beacon exists.

| Hazard | From hub | Warning | Lasts | Requirement (hub 1) | Failure effect | Maintenance if prepared |
| --- | --- | --- | --- | --- | --- | --- |
| Dust Storm | 1 | 20-30 | 12 | 30 machined parts | Solar Array output ×0.3 | panel cleaning: 0.6 per solar array of machined parts per tick |
| Equipment Fault | 1 | 18-28 | 14 | 25 machined parts, 150 scrap | 1 building(s) (+1 per 2 hub levels) at ×0.35 efficiency | round-the-clock repairs: 0.3 per running building of machined parts per tick |
| Crop Blight | 2 | 24-32 | 16 | 150 clean water | Hydroponics Bay output ×0.3 | constant flushing: 4 per hydroponics bay of clean water per tick |
| Raid | 2 | 26-36 | 8 | 3 defence | loots 30% scrap, 25% rations, 20% machined parts, 25% credits; 1 outer building(s) (+1 per 2 levels) at ×0.4 | ammunition and patrols: 3 per watch post of scrap per tick |
| Toxic Spill | 3 | 24-34 | 14 | 50 building materials, 120 clean water | Groundwater Pump, Filtration Plant output ×0.3 | filter replacements: 0.5 per groundwater pump, 0.5 per filtration plant of machined parts per tick |
| Cold Snap | 4 | 24-34 | 16 | 40 alloys, 150 rations | population consumption ×1.7 | heating and extra meals: consumption ×1.12 |
| Signal Storm (needs a Beacon Array) | 5 | 20-28 | 12 | 40 circuits, 3 power cells | Beacon Array output ×0.25 | recalibration: 1.5 per beacon array of circuits per tick |

## **9. The Convoy**

Every 40 ticks. Standing export and import orders execute on arrival at **that convoy's prices**. Prices drift per convoy (a slow wave plus noise, ×0.6 to ×1.6 of the base price) and are deterministic, so the next convoy's prices are shown in advance with the change from the last one. Per-convoy limits scale with hub level (the "Convoy limit" column above multiplies each resource's base limit). Base limits default to 500 per resource and are lower for the high tiers (alloys 80, circuits 60, power cells 20).

| Resource | Base buy | Base sell |
| --- | --- | --- |
| Scrap | 2 | 0.5 |
| Raw Water | 1.5 | 0.4 |
| Clean Water | 4 | 1.5 |
| Rations | 6 | 2.5 |
| Prepared Meals | 10 | 4 |
| Machined Parts | 15 | 6 |
| Building Materials | 30 | 12 |
| Raw Synthetics | 3 | 1 |
| Alloys | 40 | 15 |
| Circuits | 60 | 22 |
| Power Cells | 150 | 55 |

### Express convoy

A player-dispatched special trip, separate from the standing orders, for when you are short and can't wait for the scheduled convoy.

* Costs a **fee** (100 + 50 per hub level credits), arrives in **3 ticks**, then needs **10 ticks** to rest. One at a time.
* Prices are fixed at dispatch from the next scheduled convoy's prices, but **worse**: it charges ×1.5 when selling to you and pays ×0.6 when buying from you.
* Carries at most 40% of the scheduled per-convoy limit for each resource (which itself grows with hub level).
* **Goods and credits are held at dispatch**, so nothing can be spent twice. If storage is full on arrival, the undelivered share of the cost is refunded.
* The incoming-hazard card has an **Order express resupply** button that pre-fills the order with whatever reserves you are short.

## **10. Win condition: the Beacon**

Build the **Beacon Array** (only one; it wants a Colossal plot, which only exists in ring 5) and keep it running. Each tick it runs at full efficiency adds 1 signal, and **25 signal** completes the transmission. A cramped plot scales the signal by ×0.6 per missing size step, so it works but slowly. Anything that starves it of power or power cells, or knocks it offline, costs time.
