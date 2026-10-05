# **FAILTECH Colony: Production Chains & Early Economy**

Numbers here mirror `game_config.json` (the config is the source of truth). Rates are per tick (default 3 s).

## **1\. The Baseline: Survival Drain**

* The colony starts with **20 population**. Each colonist consumes 0.1 clean water and 0.1 rations per tick, so the drain starts at **2 + 2 per tick**.
* Starting stock: 80 clean water, 100 rations. Do nothing and water runs out around tick 40; morale then falls 10 per tick and the colony collapses roughly 10 ticks later.
* Population grows by 1 every 10 ticks while morale is high and both water and rations are in surplus (capped by Hub level), which raises the drain.

## **2\. Power is a grid**

Energy is not stockpiled. Each tick, supply (Hub base power + Solar Arrays) is compared to demand (the energy input of everything running). If demand exceeds supply, **every consumer runs at supply/demand efficiency**. Paused buildings draw nothing.

| Source | Power |
| --- | --- |
| Hub level 1 / 2 / 3 | 20 / 30 / 40 |
| Solar Array | +25 |

## **3\. Buildings**

| Building | Cost | Inputs / tick | Outputs / tick | Build |
| --- | --- | --- | --- | --- |
| Solar Array | 100 scrap | | 25 power | 2 |
| Scrap Extractor | 200 scrap | 5 power | 40 scrap | 3 |
| Groundwater Pump | 150 scrap | 5 power | 20 raw water | 3 |
| Filtration Plant | 300 scrap, 10 parts | 10 power, 15 raw water | 15 clean water | 5 |
| Parts Assembler | 400 scrap | 10 power, 30 scrap | 5 machined parts | 6 |
| Hydroponics Bay | 500 scrap, 25 parts | 15 power, 5 clean water | 10 rations | 8 |
| Fabrication Works (hub L2) | 450 scrap, 30 parts | 12 power, 20 scrap, 3 parts | 4 building materials | 7 |

A building with partial inputs runs at partial efficiency (limited by its scarcest input). Chains resolve in order (extractors, refineries, producers) so output made this tick can be consumed this tick.

## **4\. Adjacency**

Neighbours are the two slots beside a building in its ring plus every touching slot in the rings above and below. Each matching neighbour multiplies output (clamped to x0.5 to x1.6):

* Filtration Plant next to Groundwater Pump: x1.15
* Parts Assembler next to Scrap Extractor: x1.10
* Hydroponics Bay next to Filtration Plant: x1.15
* Fabrication Works next to Parts Assembler: x1.10
* Hydroponics Bay next to Scrap Extractor: x0.85 (pollution)
* Groundwater Pump next to Scrap Extractor: x0.90
* Solar Array next to Solar Array: x0.95

## **5\. Hub levels**

| Level | Upgrade cost | Time | Storage / resource | Max pop | Rings |
| --- | --- | --- | --- | --- | --- |
| 1 | start | | 2,000 | 30 | 1 (6 slots) |
| 2 | 1,500 scrap, 60 parts | 10 | 5,000 | 60 | 2 (+12) |
| 3 | 4,000 scrap, 200 parts, 60 building materials | 16 | 10,000 | 100 | 3 (+18) |

## **6\. The Convoy**

Every 60 ticks. Standing export and import orders (max 500 per resource) execute on arrival at the prices in `game_config.json`. Sell surplus rations and water to afford building materials.

## **7\. Win condition**

Hub level 3, power covering demand, and both clean water and rations net-positive, held for 10 consecutive ticks.
