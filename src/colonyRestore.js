'use strict';
// Rolling one colony back to how it stood in a backup, while the rest of the world carries on.
//
// Every row that belongs to the colony is replaced by the backup's: the colony, its districts and everything in them, its
// orders, missions, settlements, story, station, dropships, Headquarters... The shared world is left as it is now: the market
// books and trade history, the territories (bar the colony's own private ones), global projects. So that nothing is created
// or lost at the edges:
//   - the colony's open orders today are dropped with it; the orders it had open in the backup are not restored but refunded
//     into the restored colony (goods back to where they came from, held credits back to its balance);
//   - a dropship that was down on a territory that has since closed, or that someone else now holds, comes back docked
//     (its landing party and what it had gathered are lost with the territory);
//   - a station name now taken by another station gets a number after it.
// Ticks in the backup are older than the live clock, so anything that was under way finishes on the next tick.
const Database = require('better-sqlite3');
const fs = require('fs');
const store = require('./db');
const absence = require('./absence');
const { db } = store;

// Tables keyed by colony_id, in an order that satisfies the foreign keys (colonies and districts first).
const BY_COLONY = [
  'districts', 'hq_discoveries', 'colony_inventory', 'colony_buildings', 'colony_work_orders', 'colony_contracts', 'colony_events', 'colony_express',
  'colony_hazards', 'colony_shipments', 'colony_routes', 'missions', 'standing', 'requisitions', 'settlements', 'story_beats', 'orbital_slots',
  'orbital_shipments', 'dropships', 'credit_ledger', 'colony_data_packets', 'minigame_sessions', 'minigame_skill', 'colony_hq',
];

const cols = (schema, table) => db.prepare('SELECT name FROM pragma_table_info(?, ?)').all(table, schema).map((r) => r.name);
const hasTable = (schema, table) => !!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(table);

// A quick look at a backup, without attaching it: its clock, and its colonies (optionally only one account's).
function peek(file, { userId = null, colonyId = null } = {}) {
  if (!fs.existsSync(file)) return { ok: false, error: 'No such backup.' };
  const b = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const meta = (k) => { const r = b.prepare('SELECT value FROM meta WHERE key = ?').get(k); return r ? r.value : null; };
    const where = colonyId ? 'c.id = ?' : userId ? 'c.user_id = ?' : '1 = 1';
    const args = colonyId ? [colonyId] : userId ? [userId] : [];
    const hasStations = !!b.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stations'").get();
    const colonies = b.prepare(`SELECT c.id, c.user_id AS userId, u.username, c.hub_level AS hub, c.population, c.credits, c.age, c.status, c.won${hasStations ? ', s.name AS station' : ''}
      FROM colonies c LEFT JOIN users u ON u.id = c.user_id ${hasStations ? 'LEFT JOIN stations s ON s.colony_id = c.id' : ''} WHERE ${where} ORDER BY c.id LIMIT 500`).all(...args);
    return { ok: true, tick: Number(meta('global_tick') || 0), version: b.pragma('user_version', { simple: true }), colonies };
  } finally { b.close(); }
}

// set: columns given a value of their own instead of the backup's (the colony's owner).
function copyRows(table, where, args, set = {}) {
  if (!hasTable('bk', table)) return 0;
  const live = new Set(cols('main', table));
  const names = cols('bk', table).filter((c) => live.has(c));
  const into = names.map((c) => `"${c}"`).join(', ');
  const from = names.map((c) => (c in set ? '?' : `"${c}"`)).join(', ');
  const vals = names.filter((c) => c in set).map((c) => set[c]);
  return db.prepare(`INSERT INTO main.${table} (${into}) SELECT ${from} FROM bk.${table} WHERE ${where}`).run(...vals, ...args).changes;
}

// file: the backup. colonyId: the colony to roll back. toUserId: who it belongs to afterwards (default: whoever holds it now,
// else its holder in the backup). current: what happens to another colony that account runs now ('park' it for someone
// else, or 'wipe' it); without it, such a restore is refused.
function restore({ file, colonyId, toUserId = null, current = null, note = null }) {
  if (!fs.existsSync(file)) return { ok: false, error: 'No such backup.' };
  const p = peek(file, { colonyId });
  if (!p.ok) return p;
  const bc = p.colonies[0];
  if (!bc) return { ok: false, error: 'That colony is not in the backup.' };
  const liveNow = db.prepare('SELECT id, user_id FROM colonies WHERE id = ?').get(colonyId);
  const owner = toUserId || (liveNow ? liveNow.user_id : bc.userId);
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(owner)) return { ok: false, error: 'The account to restore it to does not exist.' };
  const other = db.prepare('SELECT id FROM colonies WHERE user_id = ? AND id != ?').get(owner, colonyId);
  if (other && current !== 'park' && current !== 'wipe') return { ok: false, error: 'That account runs another colony now: choose whether to park or wipe it.', otherColony: other.id };

  db.prepare('ATTACH DATABASE ? AS bk').run(file);
  try {
    const out = db.transaction(() => {
      const tick = Number(store.getMeta('global_tick', 0));
      if (other) { if (current === 'park') absence.handOver(other.id); else store.wipeColony(other.id); }
      // today's orbital orders have no foreign key to the colony; its ground orders go with it (cascade)
      db.prepare('DELETE FROM orbital_orders WHERE colony_id = ?').run(colonyId);
      db.prepare('DELETE FROM colonies WHERE id = ?').run(colonyId); // cascades through everything it owns
      copyRows('colonies', 'id = ?', [colonyId], { user_id: owner });
      const districtIds = db.prepare('SELECT id FROM bk.districts WHERE colony_id = ?').all(colonyId).map((r) => r.id);
      for (const t of BY_COLONY) copyRows(t, 'colony_id = ?', [colonyId]);
      if (districtIds.length) copyRows('slot_locks', `district_id IN (${districtIds.map(() => '?').join(',')})`, districtIds);
      // its private territories, if they have been cleared away since
      if (hasTable('bk', 'territories') && cols('bk', 'territories').includes('owner_colony')) {
        const live = new Set(cols('main', 'territories'));
        const both = cols('bk', 'territories').filter((c) => live.has(c)).map((c) => `"${c}"`).join(', ');
        db.prepare(`INSERT OR IGNORE INTO main.territories (${both}) SELECT ${both} FROM bk.territories WHERE owner_colony = ?`).run(colonyId);
      }
      // the station, under a name nobody else has taken since
      let station = null;
      if (hasTable('bk', 'stations')) {
        const st = db.prepare('SELECT * FROM bk.stations WHERE colony_id = ?').get(colonyId);
        if (st) {
          let name = st.name;
          for (let i = 2; db.prepare('SELECT 1 FROM stations WHERE name = ? COLLATE NOCASE').get(name) || db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND id != ?').get(name, owner); i++) name = `${st.name} ${i}`;
          copyRows('stations', 'colony_id = ?', [colonyId]);
          if (name !== st.name) {
            db.prepare('UPDATE stations SET name = ? WHERE colony_id = ?').run(name, colonyId);
            db.prepare('UPDATE districts SET name = ? WHERE id = ?').run(name, st.district_id);
          }
          station = name;
        }
      }
      // refund what the backup's open orders were holding
      let refundCredits = 0;
      const refunds = [];
      const addStock = db.prepare('UPDATE colony_inventory SET amount = amount + ? WHERE district_id = ? AND resource_id = ?');
      if (hasTable('bk', 'market_orders')) {
        for (const o of db.prepare("SELECT * FROM bk.market_orders WHERE colony_id = ? AND owner = 'player' AND status = 'open'").all(colonyId)) {
          if (o.side === 'sell' && o.qty > 0 && o.district_id && districtIds.includes(o.district_id)) { addStock.run(o.qty, o.district_id, o.resource_id); refunds.push(`${o.qty} ${o.resource_id}`); } else if (o.side === 'buy') refundCredits += o.escrow || 0;
        }
      }
      if (hasTable('bk', 'orbital_orders')) {
        const stD = db.prepare('SELECT district_id FROM stations WHERE colony_id = ?').get(colonyId);
        for (const o of db.prepare("SELECT * FROM bk.orbital_orders WHERE colony_id = ? AND status = 'open'").all(colonyId)) {
          if (o.side === 'sell' && stD && o.remaining > 0) {
            if (!addStock.run(o.remaining, stD.district_id, o.resource_id).changes) db.prepare('INSERT INTO colony_inventory (colony_id, district_id, resource_id, amount) VALUES (?, ?, ?, ?)').run(colonyId, stD.district_id, o.resource_id, o.remaining);
            refunds.push(`${o.remaining} ${o.resource_id}`);
          } else if (o.side === 'buy') refundCredits += Math.floor(o.remaining * o.price);
        }
      }
      if (refundCredits) db.prepare('UPDATE colonies SET credits = credits + ? WHERE id = ?').run(refundCredits, colonyId);
      // dropships down on a territory that is gone or someone else's come home
      let docked = 0;
      for (const s of db.prepare("SELECT * FROM dropships WHERE colony_id = ? AND state IN ('deploying', 'deployed')").all(colonyId)) {
        const t = s.territory_id ? db.prepare('SELECT * FROM territories WHERE id = ?').get(s.territory_id) : null;
        const ours = t && t.closes_tick > tick && (!t.taken_by || t.taken_by === colonyId || t.stabilized || t.owner_colony === colonyId);
        if (ours) {
          if (!t.taken_by && !t.stabilized && !t.owner_colony) db.prepare('UPDATE territories SET taken_by = ?, taken_name = ? WHERE id = ?').run(colonyId, station, t.id);
          continue;
        }
        if (s.district_id) db.prepare('DELETE FROM districts WHERE id = ? AND colony_id = ?').run(s.district_id, colonyId);
        db.prepare("UPDATE dropships SET state = 'docked', territory_id = NULL, district_id = NULL, until_tick = 0, cargo = '{}', plan = NULL, stabilizer = 0, extra_links = 0 WHERE id = ?").run(s.id);
        docked++;
      }
      // it belongs to the account it was restored to, and its commander can carry on at once
      db.prepare('UPDATE colonies SET user_id = ?, parked_at = NULL, away_notice = NULL, last_active_at = ?, last_seen_at = ? WHERE id = ?').run(owner, Date.now(), Date.now(), colonyId);
      db.prepare('UPDATE users SET notice = NULL WHERE id = ?').run(owner);
      store.addEvent(colonyId, tick, 'info', note || 'The colony was restored from an earlier record.');
      return { ok: true, colonyId, userId: owner, backupTick: p.tick, refundCredits, refunds, docked, station, replacedOther: other ? { id: other.id, how: current } : null };
    })();
    return out;
  } finally {
    db.prepare('DETACH DATABASE bk').run();
  }
}

module.exports = { restore, peek };
