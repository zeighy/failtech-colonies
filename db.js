const Database = require('better-sqlite3');
const fs = require('fs');

const db = new Database('failtech.db', { verbose: console.log });
db.pragma('journal_mode = WAL');

// Read game config to populate initial defaults later if needed
const gameConfig = JSON.parse(fs.readFileSync('./game_config.json', 'utf8'));

// Initialize database schema
function initDb() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS colonies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            hub_level INTEGER DEFAULT 1,
            credits INTEGER DEFAULT ${gameConfig.global.startingState.credits},
            morale INTEGER DEFAULT ${gameConfig.global.startingMorale},
            population INTEGER DEFAULT ${gameConfig.global.startingState.population},
            last_tick_processed INTEGER DEFAULT 0,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS colony_inventory (
            colony_id INTEGER NOT NULL,
            resource_id TEXT NOT NULL,
            amount REAL DEFAULT 0,
            PRIMARY KEY(colony_id, resource_id),
            FOREIGN KEY(colony_id) REFERENCES colonies(id)
        );

        CREATE TABLE IF NOT EXISTS colony_buildings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            colony_id INTEGER NOT NULL,
            ring_index INTEGER NOT NULL,
            slot_index INTEGER NOT NULL,
            building_type TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            FOREIGN KEY(colony_id) REFERENCES colonies(id),
            UNIQUE(colony_id, ring_index, slot_index)
        );

        CREATE TABLE IF NOT EXISTS colony_work_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            colony_id INTEGER NOT NULL,
            action_type TEXT NOT NULL,
            target_data TEXT NOT NULL,
            ticks_remaining INTEGER NOT NULL,
            FOREIGN KEY(colony_id) REFERENCES colonies(id)
        );
    `);
    console.log("Database schema initialized.");
}

initDb();

function seedColonyForUser(userId) {
    // Check if user already has a colony
    const existing = db.prepare('SELECT id FROM colonies WHERE user_id = ?').get(userId);
    if (existing) {
        return existing.id;
    }

    const insertColony = db.prepare('INSERT INTO colonies (user_id) VALUES (?)');
    const result = insertColony.run(userId);
    const colonyId = result.lastInsertRowid;

    // Seed inventory
    const insertInv = db.prepare('INSERT INTO colony_inventory (colony_id, resource_id, amount) VALUES (?, ?, ?)');
    const resources = gameConfig.global.startingState.resources;
    for (const [res, amt] of Object.entries(resources)) {
        insertInv.run(colonyId, res, amt);
    }

    // Hub is implicitly Ring 0, let's just make sure inventory is populated.
    console.log(`Seeded colony ${colonyId} for user ${userId}.`);
    return colonyId;
}

module.exports = {
    db,
    initDb,
    seedColonyForUser,
    gameConfig
};
