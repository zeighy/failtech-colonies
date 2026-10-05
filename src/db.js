'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const session = require('express-session');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'game_config.json'), 'utf8'));
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'failtech.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA_VERSION = 4;

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
    CREATE TABLE IF NOT EXISTS colony_inventory (
      colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
      resource_id TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (colony_id, resource_id)
    );
    CREATE TABLE IF NOT EXISTS colony_buildings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
      ring_index INTEGER NOT NULL,
      slot_index INTEGER NOT NULL,
      building_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      UNIQUE (colony_id, ring_index, slot_index)
    );
    CREATE TABLE IF NOT EXISTS colony_work_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
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
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}
migrate();

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

// ---- colonies ---------------------------------------------------------------
function foundColony(userId, { credits = config.global.startingState.credits, failures = 0 } = {}) {
  const s = config.global.startingState;
  const id = db.prepare(
    'INSERT INTO colonies (user_id, credits, morale, population, failures, last_seen_at, next_hazard_age) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, credits, config.global.startingMorale, s.population, failures, Date.now(), config.hazards.firstAtAge).lastInsertRowid;
  const ins = db.prepare('INSERT INTO colony_inventory (colony_id, resource_id, amount) VALUES (?, ?, ?)');
  for (const res of Object.keys(config.resources)) ins.run(id, res, s.resources[res] || 0);
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

function loadInventory(colonyId) {
  const inv = {};
  for (const r of db.prepare('SELECT resource_id, amount FROM colony_inventory WHERE colony_id = ?').all(colonyId)) inv[r.resource_id] = r.amount;
  return inv;
}

function saveInventory(colonyId, inv) {
  const up = db.prepare('INSERT INTO colony_inventory (colony_id, resource_id, amount) VALUES (?, ?, ?) ON CONFLICT(colony_id, resource_id) DO UPDATE SET amount = excluded.amount');
  for (const [res, amt] of Object.entries(inv)) if (config.resources[res]) up.run(colonyId, res, amt);
}

function loadBuildings(colonyId) {
  return db.prepare('SELECT id, ring_index AS ring, slot_index AS slot, building_type AS type, status FROM colony_buildings WHERE colony_id = ? ORDER BY id').all(colonyId);
}

function loadOrders(colonyId) {
  return db.prepare('SELECT * FROM colony_work_orders WHERE colony_id = ? ORDER BY id').all(colonyId)
    .map((o) => ({ ...o, data: JSON.parse(o.target_data) }));
}

function loadHazard(colonyId) {
  const h = db.prepare('SELECT * FROM colony_hazards WHERE colony_id = ? ORDER BY id DESC LIMIT 1').get(colonyId);
  return h ? { ...h, data: JSON.parse(h.data) } : null;
}

function loadContracts(colonyId) {
  const out = { export: {}, import: {} };
  for (const c of db.prepare('SELECT resource_id, side, amount FROM colony_contracts WHERE colony_id = ?').all(colonyId)) out[c.side][c.resource_id] = c.amount;
  return out;
}

module.exports = {
  db, config, SqliteStore, getMeta, setMeta,
  foundColony, ensureColony, wipeColony, addEvent,
  loadInventory, saveInventory, loadBuildings, loadOrders, loadContracts, loadHazard,
};
