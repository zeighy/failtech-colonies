'use strict';
// Shutdown: when a colony's hope runs out it no longer collapses. It shuts down instead: every building that is not
// essential is parked (switched off), the people hold on at a low ebb, and the player decides what to do. Parked
// buildings stay where they are; `resume` switches them back on. A colony can be abandoned from the menu at any time.
const store = require('./db');
const { db, config } = store;

// A building stays on during a shutdown if it is housing, or an essential building in the Core.
// Everything in every other district is parked.
function park(colonyId) {
  const rows = db.prepare(`SELECT b.id, b.building_type AS type, b.status, d.type AS dtype FROM colony_buildings b
    JOIN districts d ON d.id = b.district_id WHERE b.colony_id = ?`).all(colonyId);
  const set = db.prepare("UPDATE colony_buildings SET status = 'paused', parked = 1 WHERE id = ?");
  let n = 0;
  for (const b of rows) {
    const def = config.buildings[b.type];
    if (!def || def.housing || b.status !== 'active') continue;
    if (b.dtype === 'core' && def.essential) continue;
    set.run(b.id); n++;
  }
  return n;
}

// Switch every parked building back on. Returns how many.
function resume(colonyId) {
  return db.prepare("UPDATE colony_buildings SET status = 'active', parked = 0 WHERE colony_id = ? AND parked = 1").run(colonyId).changes;
}

const parkedCount = (colonyId) => db.prepare('SELECT COUNT(*) AS n FROM colony_buildings WHERE colony_id = ? AND parked = 1').get(colonyId).n;

module.exports = { park, resume, parkedCount };
