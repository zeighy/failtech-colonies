'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const session = require('express-session');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'game_config.json'), 'utf8'));
require('./theme').load(config); // names and wording come from content/<theme>/theme.json
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'failtech.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000'); // wait for a competing writer instead of failing at once
// The database holds password hashes and every colony: keep it readable by the owner only.
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.chmodSync(f, 0o600); } catch (e) { /* not created yet */ } }

const SCHEMA_VERSION = 22;

function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  )`);
  const v = db.pragma('user_version', { simple: true });
  if (v < 4) {
    // Ring sizes and the economy changed in v4, so old colonies no longer fit the map.
    // Accounts survive; colonies are re-founded on next login.
    db.exec(`
      DROP TABLE IF EXISTS colony_hazards;
      DROP TABLE IF EXISTS colony_events;
      DROP TABLE IF EXISTS colony_contracts;
      DROP TABLE IF EXISTS colony_work_orders;
      DROP TABLE IF EXISTS colony_buildings;
      DROP TABLE IF EXISTS colony_inventory;
      DROP TABLE IF EXISTS colonies;
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS colonies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
      hub_level INTEGER NOT NULL DEFAULT 1,
      credits INTEGER NOT NULL,
      morale REAL NOT NULL,
      population INTEGER NOT NULL,
      age INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      won INTEGER NOT NULL DEFAULT 0,
      progress REAL NOT NULL DEFAULT 0,
      starving INTEGER NOT NULL DEFAULT 0,
      brownout INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      milestones TEXT NOT NULL DEFAULT '[]',
      last_seen_at INTEGER NOT NULL DEFAULT 0,
      next_hazard_age INTEGER NOT NULL DEFAULT 0,
      hazard_count INTEGER NOT NULL DEFAULT 0,
      hazards_survived INTEGER NOT NULL DEFAULT 0,
      report_cursor INTEGER NOT NULL DEFAULT 0
    );
    -- A district is a base: its own rings, stockpile, buildings and power grid. Every colony has exactly
    -- one 'core' district (the original colony, whose level is colonies.hub_level).
    CREATE TABLE IF NOT EXISTS districts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      created_tick INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS colony_inventory (
      colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
      district_id INTEGER NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
      resource_id TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (district_id, resource_id)
    );
    CREATE TABLE IF NOT EXISTS colony_buildings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
      district_id INTEGER REFERENCES districts(id) ON DELETE CASCADE,
      ring_index INTEGER NOT NULL,
      slot_index INTEGER NOT NULL,
      building_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      UNIQUE (district_id, ring_index, slot_index)
    );
    CREATE TABLE IF NOT EXISTS slot_locks (
      district_id INTEGER NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
      ring_index INTEGER NOT NULL,
      slot_index INTEGER NOT NULL,
      until_tick INTEGER NOT NULL,
      PRIMARY KEY (district_id, ring_index, slot_index)
    );
    CREATE TABLE IF NOT EXISTS colony_work_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
      district_id INTEGER REFERENCES districts(id) ON DELETE CASCADE,
      action_type TEXT NOT NULL,
      target_data TEXT NOT NULL,
      ticks_remaining INTEGER NOT NULL,
      ticks_total INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS colony_contracts (
      colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
      resource_id TEXT NOT NULL,
      side TEXT NOT NULL,
      amount INTEGER NOT NULL,
      PRIMARY KEY (colony_id, resource_id, side)
    );
    CREATE TABLE IF NOT EXISTS colony_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
      tick INTEGER NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      tag TEXT
    );
    CREATE TABLE IF NOT EXISTS colony_express (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
      dispatched_tick INTEGER NOT NULL,
      arrives_tick INTEGER NOT NULL,
      sell TEXT NOT NULL DEFAULT '{}',   -- {res: {qty, pay}}  stock already taken, credits owed on arrival
      buy TEXT NOT NULL DEFAULT '{}'     -- {res: {qty, cost}} credits already taken, goods delivered on arrival
    );
    CREATE TABLE IF NOT EXISTS colony_hazards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      state TEXT NOT NULL,             -- 'forecast' | 'active'
      strikes_tick INTEGER NOT NULL,
      ends_tick INTEGER NOT NULL DEFAULT 0,
      severity REAL NOT NULL DEFAULT 0,
      data TEXT NOT NULL DEFAULT '{}'
    );
  `);
  // v5 (additive): express convoy cooldown
  if (!db.prepare("SELECT 1 FROM pragma_table_info('colonies') WHERE name = 'express_ready_tick'").get()) {
    db.exec('ALTER TABLE colonies ADD COLUMN express_ready_tick INTEGER NOT NULL DEFAULT 0');
  }
  // v6: districts. Existing colonies keep everything; their stockpile, buildings and orders become the Core district's.
  if (v < 6) migrateToDistricts();
  // v7 (additive): shipments between districts. Stock is taken at dispatch and lands on arrival.
  db.exec(`CREATE TABLE IF NOT EXISTS colony_shipments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
    from_district INTEGER NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
    to_district INTEGER NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
    resource_id TEXT NOT NULL,
    qty INTEGER NOT NULL,
    dispatched_tick INTEGER NOT NULL,
    arrives_tick INTEGER NOT NULL
  )`);
  // v8 (additive): standing routes, the shipments they send, and the capacity of each district's link to the Core.
  db.exec(`CREATE TABLE IF NOT EXISTS colony_routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
    from_district INTEGER NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
    to_district INTEGER NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
    resource_id TEXT NOT NULL,
    rate INTEGER NOT NULL,
    reserve INTEGER NOT NULL DEFAULT 0,
    UNIQUE (from_district, to_district, resource_id)
  )`);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('colony_shipments') WHERE name = 'route_id'").get()) {
    db.exec('ALTER TABLE colony_shipments ADD COLUMN route_id INTEGER');
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('districts') WHERE name = 'link_level'").get()) {
    db.exec('ALTER TABLE districts ADD COLUMN link_level INTEGER NOT NULL DEFAULT 1');
  }
  // v9 (additive): optional inputs a player can switch on per building
  if (!db.prepare("SELECT 1 FROM pragma_table_info('colony_buildings') WHERE name = 'boost'").get()) {
    db.exec('ALTER TABLE colony_buildings ADD COLUMN boost INTEGER NOT NULL DEFAULT 0');
  }
  // v10 (additive): the exchange. NPC market makers and players share one order book.
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,                       -- 'npc' | 'player'
      colony_id INTEGER REFERENCES colonies(id) ON DELETE CASCADE,
      district_id INTEGER REFERENCES districts(id) ON DELETE SET NULL,   -- sells: where the goods came from; buys: where they are delivered
      side TEXT NOT NULL,                        -- 'buy' | 'sell'
      resource_id TEXT NOT NULL,
      price REAL NOT NULL,                       -- credits per unit
      qty INTEGER NOT NULL,                      -- remaining
      qty_total INTEGER NOT NULL,
      escrow INTEGER NOT NULL DEFAULT 0,         -- buys: credits held for the remaining quantity
      level INTEGER,                             -- npc ladder rung
      created_tick INTEGER NOT NULL,
      expires_tick INTEGER,
      status TEXT NOT NULL DEFAULT 'open'        -- open | filled | cancelled | expired
    );
    CREATE INDEX IF NOT EXISTS market_orders_book ON market_orders (resource_id, side, status, price);
    CREATE TABLE IF NOT EXISTS market_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL,
      resource_id TEXT NOT NULL,
      price REAL NOT NULL,
      qty INTEGER NOT NULL,
      buy_colony INTEGER,
      sell_colony INTEGER
    );
  `);
  // v11 (additive): Trade Workshop recipes, missions and faction standing
  for (const [col, ddl] of [['recipe', 'TEXT'], ['recipe_ready_tick', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!db.prepare("SELECT 1 FROM pragma_table_info('colony_buildings') WHERE name = ?").get(col)) db.exec(`ALTER TABLE colony_buildings ADD COLUMN ${col} ${ddl}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
      slot INTEGER NOT NULL,
      title TEXT NOT NULL,
      offers TEXT NOT NULL,                      -- [{faction, good, qty, reward, standing}]
      created_tick INTEGER NOT NULL,
      expires_tick INTEGER NOT NULL,
      closed_tick INTEGER,
      status TEXT NOT NULL DEFAULT 'open',       -- open | done | expired
      filled_faction TEXT
    );
    CREATE TABLE IF NOT EXISTS standing (
      colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
      faction TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (colony_id, faction)
    );
  `);
  // v12 (additive): NPC rungs regenerate lazily, from the tick they were last brought up to date
  if (!db.prepare("SELECT 1 FROM pragma_table_info('market_orders') WHERE name = 'synced_tick'").get()) {
    db.exec('ALTER TABLE market_orders ADD COLUMN synced_tick INTEGER NOT NULL DEFAULT 0');
  }
  // Callsigns are unique regardless of case, enforced by the database (the app also checks, but only the index is race-proof).
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_username_nocase ON users (username COLLATE NOCASE)'); } catch (e) { console.warn('Could not enforce case-insensitive callsigns (existing duplicates?):', e.message); }
  // v13 (additive): building expansion level (1 = as built)
  if (!db.prepare("SELECT 1 FROM pragma_table_info('colony_buildings') WHERE name = 'level'").get()) {
    db.exec('ALTER TABLE colony_buildings ADD COLUMN level INTEGER NOT NULL DEFAULT 1');
  }
  // A building inserted without a district belongs to the colony's Core district.
  db.exec(`CREATE TRIGGER IF NOT EXISTS buildings_default_district AFTER INSERT ON colony_buildings
    WHEN NEW.district_id IS NULL BEGIN
      UPDATE colony_buildings SET district_id = (SELECT id FROM districts WHERE colony_id = NEW.colony_id AND type = 'core') WHERE id = NEW.id;
    END`);
  // v14 (additive): story beats delivered to a colony. `seen` is "played" for a dialogue and "read" for a mail.
  db.exec(`
    CREATE TABLE IF NOT EXISTS story_beats (
      colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
      beat_id TEXT NOT NULL,
      tick INTEGER NOT NULL,
      seen INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (colony_id, beat_id)
    );
  `);
  // v15 (additive): shutdown. A colony that would have collapsed parks its non-essential buildings and carries on.
  for (const [table, col, ddl] of [['colonies', 'shutdown_tick', 'INTEGER'], ['colonies', 'shutdowns', 'INTEGER NOT NULL DEFAULT 0'], ['colony_buildings', 'parked', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  }
  // v16 (additive): orbit. Launches, the station and its storage, dropships, the shared anomalous territories, the orbital
  // market and global projects.
  for (const [table, col, ddl] of [
    ['colonies', 'orbital_unlocked', 'INTEGER NOT NULL DEFAULT 0'], ['colonies', 'orbital_flags', "TEXT NOT NULL DEFAULT '{}'"],
    ['colonies', 'launch_progress', 'REAL NOT NULL DEFAULT 0'], ['colonies', 'launch_ready', 'TEXT'],
    ['colonies', 'express_launch_ready_tick', 'INTEGER NOT NULL DEFAULT 0'], ['districts', 'territory_id', 'INTEGER'],
  ]) {
    if (!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS stations (
      colony_id INTEGER PRIMARY KEY REFERENCES colonies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      district_id INTEGER NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
      storage_level INTEGER NOT NULL DEFAULT 1,
      links_level INTEGER NOT NULL DEFAULT 1,
      launched_tick INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS stations_name_nocase ON stations (name COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS orbital_slots (
      colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      resource_id TEXT,
      state TEXT NOT NULL DEFAULT 'open',          -- open | jettisoned
      PRIMARY KEY (colony_id, idx)
    );
    CREATE TABLE IF NOT EXISTS orbital_shipments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
      resource_id TEXT NOT NULL,
      qty INTEGER NOT NULL,
      arrives_tick INTEGER NOT NULL,
      dest TEXT NOT NULL DEFAULT 'station'           -- station (an express launch) | core (an express drop)
    );
    CREATE TABLE IF NOT EXISTS dropships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
      num INTEGER NOT NULL,
      level INTEGER NOT NULL DEFAULT 1,
      integrity REAL NOT NULL DEFAULT 100,
      state TEXT NOT NULL DEFAULT 'docked',         -- building | docked | deploying | deployed | returning | contributing
      territory_id INTEGER,
      district_id INTEGER,
      project_id INTEGER,
      until_tick INTEGER NOT NULL DEFAULT 0,
      cargo TEXT NOT NULL DEFAULT '{}',
      plan TEXT,                                     -- what to bring back: {resource: true}
      invested TEXT NOT NULL DEFAULT '{}',
      saved_once INTEGER NOT NULL DEFAULT 0,
      late INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS territories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      anomaly TEXT NOT NULL,
      resources TEXT NOT NULL,                       -- {common1, common2, district, rare}
      opens_tick INTEGER NOT NULL,
      closes_tick INTEGER NOT NULL,
      taken_by INTEGER,
      taken_name TEXT,
      destabilized INTEGER NOT NULL DEFAULT 0,
      data_site INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS global_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      status TEXT NOT NULL,                          -- announced | active | bonus | done | failed
      announced_tick INTEGER NOT NULL,
      starts_tick INTEGER NOT NULL,
      ends_tick INTEGER NOT NULL,
      bonus_ends_tick INTEGER,
      needs TEXT NOT NULL,
      contributed TEXT NOT NULL DEFAULT '{}',
      players INTEGER NOT NULL DEFAULT 1,
      drip_resource TEXT,
      closed_tick INTEGER
    );
    CREATE TABLE IF NOT EXISTS global_contributions (
      project_id INTEGER NOT NULL REFERENCES global_projects(id) ON DELETE CASCADE,
      colony_id INTEGER NOT NULL,
      resource_id TEXT NOT NULL,
      qty REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, colony_id, resource_id)
    );
    CREATE TABLE IF NOT EXISTS orbital_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      colony_id INTEGER,                             -- NULL: a market maker
      station_name TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      qty INTEGER NOT NULL,
      remaining INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',          -- open | filled | cancelled | expired
      created_tick INTEGER NOT NULL,
      expires_tick INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS orbital_orders_book ON orbital_orders (resource_id, side, status, price);
    CREATE TABLE IF NOT EXISTS orbital_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL,
      resource_id TEXT NOT NULL,
      price REAL NOT NULL,
      qty INTEGER NOT NULL,
      buyer TEXT NOT NULL,
      seller TEXT NOT NULL
    );
  `);
  // data sites: a territory can hold one, Data Recovery buildings work it, and fragments are kept per colony
  for (const [tbl, col, ddl] of [['territories', 'data_site', 'INTEGER NOT NULL DEFAULT 0'], ['colony_buildings', 'data_progress', 'REAL NOT NULL DEFAULT 0'],
    ['colonies', 'data_fragments', 'INTEGER NOT NULL DEFAULT 0'], ['colonies', 'data_successes', 'INTEGER NOT NULL DEFAULT 0'], ['colonies', 'data_total', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!db.prepare(`SELECT 1 FROM pragma_table_info('${tbl}') WHERE name = ?`).get(col)) db.exec(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${ddl}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS credit_ledger (
      colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
      tick INTEGER NOT NULL,
      kind TEXT NOT NULL,
      amount INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS credit_ledger_window ON credit_ledger (colony_id, kind, tick);
    CREATE TABLE IF NOT EXISTS colony_data_packets (
      colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
      packet_id TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (colony_id, packet_id)
    );
  `);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('colony_data_packets') WHERE name = 'level'").get()) db.exec('ALTER TABLE colony_data_packets ADD COLUMN level INTEGER NOT NULL DEFAULT 1');
  if (!db.prepare("SELECT 1 FROM pragma_table_info('orbital_shipments') WHERE name = 'dest'").get()) db.exec("ALTER TABLE orbital_shipments ADD COLUMN dest TEXT NOT NULL DEFAULT 'station'");
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

function migrateToDistricts() {
  const hasCol = (table, col) => !!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col);
  db.transaction(() => {
    for (const c of db.prepare("SELECT id, hub_level FROM colonies WHERE id NOT IN (SELECT colony_id FROM districts WHERE type = 'core')").all()) {
      db.prepare("INSERT INTO districts (colony_id, type, level, name, created_tick) VALUES (?, 'core', ?, 'The Core', 0)").run(c.id, c.hub_level);
    }
    const core = "(SELECT id FROM districts d WHERE d.colony_id = o.colony_id AND d.type = 'core')";
    if (!hasCol('colony_inventory', 'district_id')) {
      db.exec(`
        CREATE TABLE colony_inventory_v6 (
          colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
          district_id INTEGER NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
          resource_id TEXT NOT NULL,
          amount REAL NOT NULL DEFAULT 0,
          PRIMARY KEY (district_id, resource_id)
        );
        INSERT INTO colony_inventory_v6 (colony_id, district_id, resource_id, amount)
          SELECT o.colony_id, ${core}, o.resource_id, o.amount FROM colony_inventory o;
        DROP TABLE colony_inventory;
        ALTER TABLE colony_inventory_v6 RENAME TO colony_inventory;
      `);
    }
    if (!hasCol('colony_buildings', 'district_id')) {
      db.exec(`
        CREATE TABLE colony_buildings_v6 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
          district_id INTEGER REFERENCES districts(id) ON DELETE CASCADE,
          ring_index INTEGER NOT NULL,
          slot_index INTEGER NOT NULL,
          building_type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          UNIQUE (district_id, ring_index, slot_index)
        );
        INSERT INTO colony_buildings_v6 (id, colony_id, district_id, ring_index, slot_index, building_type, status)
          SELECT o.id, o.colony_id, ${core}, o.ring_index, o.slot_index, o.building_type, o.status FROM colony_buildings o;
        DROP TABLE colony_buildings;
        ALTER TABLE colony_buildings_v6 RENAME TO colony_buildings;
      `);
    }
    if (!hasCol('colony_work_orders', 'district_id')) {
      db.exec('ALTER TABLE colony_work_orders ADD COLUMN district_id INTEGER REFERENCES districts(id) ON DELETE CASCADE');
      db.exec(`UPDATE colony_work_orders AS o SET district_id = ${core} WHERE district_id IS NULL`);
    }
  })();
}
migrate();
// v17 (additive): the work queue and route targets. An order is 'queued' until its turn comes and 'active' while it is
// being carried out; orders from before the queue are 'active' and finish side by side. A route can stop at a target
// stock in the destination (0 = fill it).
for (const [table, col, ddl] of [['colony_work_orders', 'state', "TEXT NOT NULL DEFAULT 'active'"], ['colony_work_orders', 'position', 'INTEGER NOT NULL DEFAULT 0'], ['colony_routes', 'target', 'INTEGER NOT NULL DEFAULT 0']]) {
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

// v18 (additive): requisitions (requests for ordinary goods from an early hub level) and the boons they lend.
db.exec(`
  CREATE TABLE IF NOT EXISTS requisitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
    slot INTEGER NOT NULL,
    title TEXT NOT NULL,
    good TEXT NOT NULL,
    qty INTEGER NOT NULL,
    reward INTEGER NOT NULL,
    boon TEXT NOT NULL,
    created_tick INTEGER NOT NULL,
    expires_tick INTEGER NOT NULL,
    closed_tick INTEGER,
    status TEXT NOT NULL DEFAULT 'open'        -- open | done | expired
  );
`);
if (!db.prepare("SELECT 1 FROM pragma_table_info('colonies') WHERE name = 'boons'").get()) db.exec("ALTER TABLE colonies ADD COLUMN boons TEXT NOT NULL DEFAULT '{}'");
// v19 (additive): build slots. Every place starts with one; the Core and the districts can buy more (config.global.buildQueue.slotTiers).
if (!db.prepare("SELECT 1 FROM pragma_table_info('districts') WHERE name = 'build_slots'").get()) db.exec('ALTER TABLE districts ADD COLUMN build_slots INTEGER NOT NULL DEFAULT 1');
// v20 (additive): settlements the colony sponsors after the Beacon (see settlements.js), and the Core reserve they respect.
db.exec(`
  CREATE TABLE IF NOT EXISTS settlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    trait TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'offer',      -- offer | active | done (stands on its own) | gone
    stage INTEGER NOT NULL DEFAULT 1,
    commitment INTEGER NOT NULL DEFAULT 2,     -- 0 off, 1 half, 2 full
    level REAL NOT NULL DEFAULT 0,             -- how well it has been supplied lately, 0 to 1
    drive TEXT NOT NULL DEFAULT '{}',          -- what has been contributed to the current drive
    sent REAL NOT NULL DEFAULT 0,
    standing_acc REAL NOT NULL DEFAULT 0,
    boon_until INTEGER NOT NULL DEFAULT 0,
    appeal TEXT,
    next_appeal INTEGER NOT NULL DEFAULT 0,
    created_tick INTEGER NOT NULL,
    expires_tick INTEGER NOT NULL DEFAULT 0,
    started_tick INTEGER,
    done_tick INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_settlements_colony ON settlements(colony_id, status);
`);
if (!db.prepare("SELECT 1 FROM pragma_table_info('colonies') WHERE name = 'settle_reserve'").get()) db.exec('ALTER TABLE colonies ADD COLUMN settle_reserve REAL NOT NULL DEFAULT 0.25');
if (!db.prepare("SELECT 1 FROM pragma_table_info('settlements') WHERE name = 'answers'").get()) db.exec('ALTER TABLE settlements ADD COLUMN answers INTEGER NOT NULL DEFAULT 0'); // appeals answered (the story listens for it)
// v21 (additive): absence (see absence.js). `last_active_at` is the commander's last real interaction (last_seen_at also
// counts an idle open tab); a colony stops being simulated a while after it, and is parked (parked_at) later still.
// Generated accounts hold parked colonies their commander gave up; `notice` tells a commander their colony was claimed;
// `bot_profile` marks an account the bot runner plays (src/botApi.js), with the profile it plays.
if (!db.prepare("SELECT 1 FROM pragma_table_info('colonies') WHERE name = 'last_active_at'").get()) {
  db.exec('ALTER TABLE colonies ADD COLUMN last_active_at INTEGER NOT NULL DEFAULT 0');
  db.exec('UPDATE colonies SET last_active_at = last_seen_at');
}
for (const [table, col, ddl] of [['colonies', 'parked_at', 'INTEGER'], ['colonies', 'away_notice', 'TEXT'], ['users', 'generated', 'INTEGER NOT NULL DEFAULT 0'], ['users', 'notice', 'TEXT'], ['users', 'bot_profile', 'TEXT']]) {
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
// v22 (additive): trace recovery minigames (see minigames.js). Standing earned stays the faction score; what is spent on plays
// is counted apart (`standing_spent`). One active session per colony; each game keeps its difficulty per colony.
if (!db.prepare("SELECT 1 FROM pragma_table_info('colonies') WHERE name = 'standing_spent'").get()) db.exec('ALTER TABLE colonies ADD COLUMN standing_spent INTEGER NOT NULL DEFAULT 0');
db.exec(`
  CREATE TABLE IF NOT EXISTS minigame_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    level INTEGER NOT NULL,
    paid TEXT NOT NULL,                        -- free | standing
    cost INTEGER NOT NULL DEFAULT 0,
    day TEXT NOT NULL,                         -- the server day it was started (YYYY-MM-DD), for the daily limits
    secret TEXT NOT NULL,                      -- never sent to the client while the session is active
    state TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active'      -- active | won | lost | expired | abandoned
  );
  CREATE UNIQUE INDEX IF NOT EXISTS minigame_one_active ON minigame_sessions(colony_id) WHERE status = 'active';
  CREATE INDEX IF NOT EXISTS minigame_by_day ON minigame_sessions(colony_id, day);
  CREATE TABLE IF NOT EXISTS minigame_skill (
    colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 0,
    streak INTEGER NOT NULL DEFAULT 0,         -- wins in a row (> 0) or losses in a row (< 0)
    PRIMARY KEY (colony_id, kind)
  );
`);
db.pragma(`user_version = ${SCHEMA_VERSION}`);

// ---- meta -----------------------------------------------------------------
const getMeta = (k, fallback = null) => {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(k);
  return row ? row.value : fallback;
};
const setMeta = (k, v) =>
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));

// ---- sessions ---------------------------------------------------------------
class SqliteStore extends session.Store {
  get(sid, cb) {
    try {
      const row = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?').get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      db.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires')
        .run(sid, JSON.stringify(sess), exp);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) {
    try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
}

function purgeSessions() {
  db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
}

// ---- colonies ---------------------------------------------------------------
function foundColony(userId, { credits = config.global.startingState.credits, failures = 0 } = {}) {
  const s = config.global.startingState;
  const id = db.prepare(
    'INSERT INTO colonies (user_id, credits, morale, population, failures, last_seen_at, last_active_at, next_hazard_age) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, credits, config.global.startingMorale, s.population, failures, Date.now(), Date.now(), config.hazards.firstAtAge).lastInsertRowid;
  const core = db.prepare("INSERT INTO districts (colony_id, type, level, name, created_tick) VALUES (?, 'core', 1, 'The Core', 0)").run(id).lastInsertRowid;
  const ins = db.prepare('INSERT INTO colony_inventory (colony_id, district_id, resource_id, amount) VALUES (?, ?, ?, ?)');
  for (const res of Object.keys(config.resources)) ins.run(id, core, res, s.resources[res] || 0);
  addEvent(id, 0, 'info', 'Colony founded. Keep your people fed, watered and powered.');
  return id;
}

function ensureColony(userId) {
  const row = db.prepare('SELECT id FROM colonies WHERE user_id = ?').get(userId);
  return row ? row.id : foundColony(userId);
}

function wipeColony(colonyId) {
  const row = db.prepare('SELECT user_id, credits, failures FROM colonies WHERE id = ?').get(colonyId);
  db.prepare('DELETE FROM colonies WHERE id = ?').run(colonyId); // cascades
  return row;
}

function addEvent(colonyId, tick, kind, message, tag = null) {
  const id = db.prepare('INSERT INTO colony_events (colony_id, tick, kind, message, tag) VALUES (?, ?, ?, ?, ?)').run(colonyId, tick, kind, message, tag).lastInsertRowid;
  db.prepare(`DELETE FROM colony_events WHERE colony_id = ? AND id NOT IN
    (SELECT id FROM colony_events WHERE colony_id = ? ORDER BY id DESC LIMIT ?)`)
    .run(colonyId, colonyId, config.global.eventLogSize);
  return Number(id);
}

// ---- districts -------------------------------------------------------------------
// Most callers only know about the Core; every loader defaults to it, so single-base code keeps working.
function coreId(colonyId) {
  const r = db.prepare("SELECT id FROM districts WHERE colony_id = ? AND type = 'core'").get(colonyId);
  return r ? r.id : null;
}
function loadDistricts(colonyId) {
  // A district's name is wording, so it always comes from the active theme (not from what was stored when it was founded).
  return db.prepare('SELECT id, type, level, name, link_level AS linkLevel, build_slots AS buildSlots, created_tick AS createdTick FROM districts WHERE colony_id = ? ORDER BY id').all(colonyId)
    .map((d) => ({ ...d, name: d.type !== 'core' && config.districtTypes[d.type] ? config.districtTypes[d.type].name : d.name }));
}

function loadInventory(colonyId, districtId = coreId(colonyId)) {
  const inv = {};
  for (const r of db.prepare('SELECT resource_id, amount FROM colony_inventory WHERE district_id = ?').all(districtId)) inv[r.resource_id] = r.amount;
  return inv;
}

function saveInventory(colonyId, inv, districtId = coreId(colonyId)) {
  const up = db.prepare('INSERT INTO colony_inventory (colony_id, district_id, resource_id, amount) VALUES (?, ?, ?, ?) ON CONFLICT(district_id, resource_id) DO UPDATE SET amount = excluded.amount');
  for (const [res, amt] of Object.entries(inv)) if (config.resources[res]) up.run(colonyId, districtId, res, amt);
}

function loadBuildings(colonyId, districtId = coreId(colonyId)) {
  const tick = Number(getMeta('global_tick', 0));
  return db.prepare('SELECT id, ring_index AS ring, slot_index AS slot, building_type AS type, status, boost, level, recipe, recipe_ready_tick AS readyTick, data_progress AS dataProgress, district_id AS districtId FROM colony_buildings WHERE district_id = ? ORDER BY id').all(districtId)
    .map((b) => ({ ...b, resetting: b.readyTick > tick }));
}

// With a districtId: that district's orders. Without: every order in the colony.
// Slots that cannot be built on yet because a configured workshop was just scrapped there.
function loadSlotLocks(districtId, tick) {
  return db.prepare('SELECT ring_index AS ring, slot_index AS slot, until_tick AS untilTick FROM slot_locks WHERE district_id = ? AND until_tick > ?').all(districtId, tick);
}
// Work orders, in the order they run: the ones under way first, then the queue from front to back.
function loadOrders(colonyId, districtId) {
  const rows = districtId === undefined
    ? db.prepare("SELECT * FROM colony_work_orders WHERE colony_id = ? ORDER BY (state = 'queued'), position, id").all(colonyId)
    : db.prepare("SELECT * FROM colony_work_orders WHERE colony_id = ? AND district_id = ? ORDER BY (state = 'queued'), position, id").all(colonyId, districtId);
  return rows.map((o) => ({ ...o, data: JSON.parse(o.target_data) }));
}

// Has the colony built a Beacon (in any district)? Used for progression unlocks.
function hasBeacon(colonyId) {
  const types = Object.keys(config.buildings).filter((k) => config.buildings[k].transmit);
  if (!types.length) return false;
  const marks = types.map(() => '?').join(',');
  return !!db.prepare(`SELECT 1 FROM colony_buildings WHERE colony_id = ? AND building_type IN (${marks}) LIMIT 1`).get(colonyId, ...types);
}

function loadShipments(colonyId) {
  return db.prepare('SELECT id, from_district AS fromDistrict, to_district AS toDistrict, resource_id AS resource, qty, dispatched_tick AS dispatchedTick, arrives_tick AS arrivesTick, route_id AS routeId FROM colony_shipments WHERE colony_id = ? ORDER BY arrives_tick, id').all(colonyId);
}

function loadRoutes(colonyId) {
  return db.prepare('SELECT id, from_district AS fromDistrict, to_district AS toDistrict, resource_id AS resource, rate, reserve, target FROM colony_routes WHERE colony_id = ? ORDER BY id').all(colonyId);
}

function loadHazard(colonyId) {
  const h = db.prepare('SELECT * FROM colony_hazards WHERE colony_id = ? ORDER BY id DESC LIMIT 1').get(colonyId);
  return h ? { ...h, data: JSON.parse(h.data) } : null;
}

function loadExpress(colonyId) {
  const e = db.prepare('SELECT * FROM colony_express WHERE colony_id = ? ORDER BY id DESC LIMIT 1').get(colonyId);
  return e ? { ...e, sell: JSON.parse(e.sell), buy: JSON.parse(e.buy) } : null;
}

function loadContracts(colonyId) {
  const out = { export: {}, import: {} };
  for (const c of db.prepare('SELECT resource_id, side, amount FROM colony_contracts WHERE colony_id = ?').all(colonyId)) out[c.side][c.resource_id] = c.amount;
  return out;
}

module.exports = {
  db, config, dbPath, purgeSessions, SqliteStore, getMeta, setMeta,
  foundColony, ensureColony, wipeColony, addEvent,
  coreId, hasBeacon, loadDistricts, loadInventory, saveInventory, loadBuildings, loadOrders, loadSlotLocks, loadShipments, loadRoutes, loadContracts, loadHazard, loadExpress,
};
