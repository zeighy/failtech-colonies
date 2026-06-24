const { db, gameConfig } = require('./db');

function getAdjacencyMultiplier(colonyId, targetBuildingType, ringIndex, slotIndex) {
    let multiplier = 1.0;
    const rules = gameConfig.adjacencyModifiers.rules.filter(r => r.targetBuilding === targetBuildingType);
    if (rules.length === 0) return multiplier;

    const ringCap = gameConfig.hubLevels["1"].ringCapacities; // Simplify for MVP, or get actual hub level

    // Simplistic adjacency: check left/right in the same ring
    const capacity = 6; // Hardcode ring 1 capacity for MVP to avoid complexity right now, real code would look it up

    const adjacentSlots = [
        (slotIndex - 1 + capacity) % capacity,
        (slotIndex + 1) % capacity
    ];

    const getBuilding = db.prepare('SELECT building_type FROM colony_buildings WHERE colony_id = ? AND ring_index = ? AND slot_index = ?');

    for (let adjSlot of adjacentSlots) {
        const adjBuilding = getBuilding.get(colonyId, ringIndex, adjSlot);
        if (adjBuilding) {
            for (let rule of rules) {
                if (rule.adjacentBuilding === adjBuilding.building_type) {
                    multiplier *= rule.outputMultiplier;
                }
            }
        }
    }
    return multiplier;
}

function processTick() {
    const transaction = db.transaction(() => {
        const colonies = db.prepare('SELECT id, morale, population FROM colonies').all();

        for (const colony of colonies) {
            // 1. Process Work Orders
            const workOrders = db.prepare('SELECT * FROM colony_work_orders WHERE colony_id = ?').all(colony.id);
            for (const order of workOrders) {
                if (order.ticks_remaining > 1) {
                    db.prepare('UPDATE colony_work_orders SET ticks_remaining = ticks_remaining - 1 WHERE id = ?').run(order.id);
                } else {
                    // Complete work order
                    if (order.action_type === 'build') {
                        const data = JSON.parse(order.target_data);
                        db.prepare("INSERT INTO colony_buildings (colony_id, ring_index, slot_index, building_type, status) VALUES (?, ?, ?, ?, 'active')")
                            .run(colony.id, data.ring_index, data.slot_index, data.building_type);
                    }
                    db.prepare('DELETE FROM colony_work_orders WHERE id = ?').run(order.id);
                }
            }

            // 2. Process Production/Consumption for Active Buildings
            const buildings = db.prepare("SELECT * FROM colony_buildings WHERE colony_id = ? AND status = 'active'").all(colony.id);

            // Get current inventory into a map
            const invRows = db.prepare('SELECT resource_id, amount FROM colony_inventory WHERE colony_id = ?').all(colony.id);
            let inventory = {};
            for (let row of invRows) {
                inventory[row.resource_id] = row.amount;
            }

            for (const bldg of buildings) {
                const typeData = gameConfig.buildings[bldg.building_type];
                if (!typeData) continue;

                // Check inputs
                let canProduce = true;
                for (let [res, amt] of Object.entries(typeData.inputsPerTick)) {
                    if ((inventory[res] || 0) < amt) {
                        canProduce = false;
                        break;
                    }
                }

                if (canProduce) {
                    // Deduct inputs
                    for (let [res, amt] of Object.entries(typeData.inputsPerTick)) {
                        inventory[res] -= amt;
                    }
                    // Add outputs
                    const multiplier = getAdjacencyMultiplier(colony.id, bldg.building_type, bldg.ring_index, bldg.slot_index);
                    for (let [res, amt] of Object.entries(typeData.outputsPerTick)) {
                        inventory[res] = (inventory[res] || 0) + (amt * multiplier);
                    }
                }
            }

            // 3. Deduct Baseline Population Consumption
            const popCons = gameConfig.global.populationConsumptionPerTick;
            const pop = colony.population;
            inventory['clean_water'] = (inventory['clean_water'] || 0) - (popCons['clean_water'] * pop);
            inventory['rations'] = (inventory['rations'] || 0) - (popCons['rations'] * pop);

            // 4. Handle Failure States / Morale
            let newMorale = colony.morale;
            if (inventory['clean_water'] <= 0 || inventory['rations'] <= 0) {
                inventory['clean_water'] = Math.max(0, inventory['clean_water']);
                inventory['rations'] = Math.max(0, inventory['rations']);
                // Drop morale for mvp simulation simplicity
                newMorale -= 10;
            } else {
                 if (newMorale < gameConfig.global.startingMorale) {
                     newMorale += 5; // slow recovery
                 }
            }
            newMorale = Math.max(0, Math.min(100, newMorale));

            // 5. Save State
            db.prepare('UPDATE colonies SET morale = ?, last_tick_processed = last_tick_processed + 1 WHERE id = ?').run(newMorale, colony.id);

            // Save inventory
            const upsertInv = db.prepare('INSERT INTO colony_inventory (colony_id, resource_id, amount) VALUES (?, ?, ?) ON CONFLICT(colony_id, resource_id) DO UPDATE SET amount = excluded.amount');
            for (let [res, amt] of Object.entries(inventory)) {
                upsertInv.run(colony.id, res, amt);
            }
        }
    });

    transaction();
}

let tickInterval;

function startEngine() {
    tickInterval = setInterval(() => {
        try {
            processTick();
        } catch (err) {
            console.error("Error processing tick:", err);
        }
    }, 1000); // 1 second tick for MVP testing purposes instead of 60000ms
    console.log("Game engine started.");
}

function stopEngine() {
    if (tickInterval) clearInterval(tickInterval);
}

module.exports = {
    processTick,
    startEngine,
    stopEngine
};
