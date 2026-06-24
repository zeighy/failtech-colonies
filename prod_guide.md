# **FAILTECH Colony: Initial Production Chains & Early Economy**

This document outlines the core production loops established in the MVP game configuration. It details how primary resources flow into secondary products and the immediate survival pressures the player faces upon starting a new colony.

## **1\. The Baseline: Survival Drain**

Before the player builds anything, they are already on a timer. The colony starts with a **Population of 20**.

* **Consumption Rate:** Each unit of population consumes 0.1 clean\_water and 0.1 rations per tick.  
* **Colony Drain:** The starting colony loses **2 Clean Water** and **2 Rations** every single tick.  
* **Buffer:** The player starts with 50 Clean Water and 50 Rations. If they do nothing, their colony will hit critical failure (zero food/water) in exactly 25 ticks.

## **2\. Tier 1: Power & Heavy Industry**

To build advanced structures to save the colony, the player needs machined\_parts. They start with 0\. Therefore, heavy industry must be prioritized.

* **Solar Array (Generator):** The backbone of the colony.  
  * *Output:* \+10 Energy/tick.  
  * *Role:* Prevents the colony's energy grid from collapsing when industrial buildings are turned on.  
* **Parts Assembler (Refinery):** The first required bottleneck.  
  * *Input:* \-10 Energy, \-30 Scrap.  
  * *Output:* \+5 Machined Parts.  
  * *Role:* Converts raw scrap into the advanced materials needed to construct life-support systems (Water Purifiers and Hydroponics).  
* **Scrap Extractor (Extractor):**  
  * *Input:* \-5 Energy.  
  * *Output:* \+25 Scrap.  
  * *Role:* The Parts Assembler burns through 30 scrap per tick. The starting stash of 1000 scrap will vanish quickly without an Extractor to replenish it.

## **3\. Tier 2: The Water Loop**

Once the player has manufactured at least 10 machined\_parts, they can address the colony's thirst. This requires a two-step logistical chain.

* **Step A: Groundwater Pump**  
  * *Input:* \-5 Energy.  
  * *Output:* \+20 Unpurified Water.  
  * *Role:* Pulls toxic/raw water from the planet. This water cannot be consumed by the population.  
* **Step B: Filtration Plant**  
  * *Input:* \-10 Energy, \-15 Unpurified Water.  
  * *Output:* \+15 Clean Water.  
  * *Role:* Refines the raw water. The \+15 output easily covers the colony's \-2 consumption drain, allowing the player to stockpile a surplus for the Convoy.

## **4\. Tier 3: Sustenance**

Food is the most resource-intensive chain to establish, requiring 25 machined\_parts just to construct the building.

* **Hydroponics Bay (Producer)**  
  * *Input:* \-15 Energy, \-5 Clean Water.  
  * *Output:* \+10 Rations.  
  * *Role:* Halts the starvation timer. Note that it requires *Clean Water* to function, meaning the Water Loop must be fully operational before food production can begin.

## **5\. Strategic Spatial Placement (Adjacency)**

Players are rewarded for planning their concentric rings carefully:

* **The Industrial Sector:** Placing the *Parts Assembler* directly adjacent to the *Scrap Extractor* grants a \+10% bonus to machined part output.  
* **The Water Sector:** Placing the *Filtration Plant* adjacent to the *Groundwater Pump* yields a \+15% boost to clean water production, heavily incentivizing players to group related supply chains together on the map.

## **Summary of a Successful Start**

To survive the first hour, a player must ideally follow this sequence:

1. Build a **Solar Array** and **Parts Assembler** to start generating Machined Parts.  
2. Build a **Scrap Extractor** to feed the Assembler before starting scrap runs out.  
3. Once 10 parts are fabricated, build the **Groundwater Pump** and **Filtration Plant** to stabilize water.  
4. Once 25 parts are fabricated, build the **Hydroponics Bay** to stabilize food.  
5. Continuously build **Solar Arrays** throughout this process to handle the escalating energy inputs required by the new buildings.

