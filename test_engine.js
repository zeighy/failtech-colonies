const { db, seedColonyForUser } = require('./db');
const { processTick } = require('./engine');

// Reset db for test
db.exec('DELETE FROM colony_work_orders');
db.exec('DELETE FROM colony_buildings');
db.exec('DELETE FROM colony_inventory');
db.exec('DELETE FROM colonies');
db.exec('DELETE FROM users');

// Create test user
db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('test_user', 'test');
const user = db.prepare('SELECT id FROM users WHERE username = ?').get('test_user');
const colonyId = seedColonyForUser(user.id);

// Add a work order
db.prepare('INSERT INTO colony_work_orders (colony_id, action_type, target_data, ticks_remaining) VALUES (?, ?, ?, ?)')
  .run(colonyId, 'build', JSON.stringify({ ring_index: 1, slot_index: 0, building_type: 'solar_array' }), 1);

console.log("State before tick:");
console.log(db.prepare('SELECT * FROM colony_buildings WHERE colony_id = ?').all(colonyId));

processTick();

console.log("State after 1st tick (Building should be built):");
console.log(db.prepare('SELECT * FROM colony_buildings WHERE colony_id = ?').all(colonyId));

processTick();
console.log("State after 2nd tick (Resources updated):");
console.log(db.prepare('SELECT resource_id, amount FROM colony_inventory WHERE colony_id = ?').all(colonyId));
