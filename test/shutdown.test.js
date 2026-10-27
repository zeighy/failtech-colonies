'use strict';
// A colony whose hope runs out shuts down instead of collapsing: non-essential buildings are parked, the people hold on,
// it cannot collapse again, and it recovers once supplies are back.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-shutdown-'));
process.env.DB_PATH = path.join(dir, 'shutdown.db');
process.env.SESSION_SECRET = 'x';
process.env.HAZARDS = 'off';
process.env.THEME = 'basic';
const store = require('../src/db');
const engine = require('../src/engine');
const actions = require('../src/actions');
const { viewFor } = require('../src/state');
const { db, config } = store;
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function colony() {
  const uid = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(`sd${++n}`, 'x').lastInsertRowid);
  const id = store.ensureColony(uid);
  const core = store.coreId(id);
  const put = (district, ring, slot, type) => db.prepare('INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, ?, ?, ?)').run(id, district, ring, slot, type);
  put(core, 1, 0, 'solar_array'); put(core, 1, 1, 'parts_assembler'); put(core, 1, 2, 'dormitory'); put(core, 1, 3, 'water_pump');
  const pits = Number(db.prepare("INSERT INTO districts (colony_id, type, level, name, created_tick) VALUES (?, 'pits', 1, 'Pits', 0)").run(id).lastInsertRowid);
  put(pits, 1, 0, 'solar_array'); put(pits, 1, 1, 'ore_drill');
  return { uid, id, core, pits };
}
const row = (id) => db.prepare('SELECT * FROM colonies WHERE id = ?').get(id);
const bld = (id, type, district) => db.prepare('SELECT * FROM colony_buildings WHERE colony_id = ? AND building_type = ? AND district_id = ?').get(id, type, district);
const starve = (c) => db.prepare("UPDATE colony_inventory SET amount = 0 WHERE district_id = ? AND resource_id IN ('clean_water','rations')").run(c.core);
const tick = (k = 1) => { for (let i = 0; i < k; i++) engine.processTick(); };

test('hope runs out: the colony shuts down, parks what is not essential and keeps its people', () => {
  const c = colony();
  starve(c);
  db.prepare('UPDATE colonies SET morale = 0.5 WHERE id = ?').run(c.id);
  tick(2);
  const r = row(c.id);
  assert.equal(r.status, 'active');
  assert.notEqual(r.shutdown_tick, null);
  assert.equal(r.shutdowns, 1);
  assert.ok(r.population >= config.global.minPopulation);
  assert.ok(r.morale >= 1);
  assert.equal(bld(c.id, 'solar_array', c.core).status, 'active', 'essential in the Core stays on');
  assert.equal(bld(c.id, 'water_pump', c.core).status, 'active');
  assert.equal(bld(c.id, 'dormitory', c.core).status, 'active', 'housing stays on');
  const asm = bld(c.id, 'parts_assembler', c.core);
  assert.equal(asm.status, 'paused'); assert.equal(asm.parked, 1);
  for (const t of ['solar_array', 'ore_drill']) assert.equal(bld(c.id, t, c.pits).parked, 1, `${t} in another district is parked`);
  const v = viewFor(c.uid);
  assert.ok(v.colony.shutdown && v.colony.parked === 3);
  assert.equal(v.doom.phase, 'shutdown');
  assert.ok(db.prepare("SELECT 1 FROM colony_events WHERE colony_id = ? AND message LIKE 'The colony has shut down%'").get(c.id));
});

test('while shut down it cannot collapse again, however long supplies stay out', () => {
  const c = colony();
  starve(c);
  db.prepare('UPDATE colonies SET morale = 0.5 WHERE id = ?').run(c.id);
  tick(2);
  for (let i = 0; i < 150; i++) { starve(c); tick(1); }
  const r = row(c.id);
  assert.equal(r.status, 'active');
  assert.equal(r.shutdowns, 1, 'one shutdown, not a loop of them');
  assert.ok(r.morale >= 1 && r.population >= config.global.minPopulation);
});

test('restarting parked buildings switches them back on; a manual toggle frees one at a time', () => {
  const c = colony();
  starve(c);
  db.prepare('UPDATE colonies SET morale = 0.5 WHERE id = ?').run(c.id);
  tick(2);
  const asm = bld(c.id, 'parts_assembler', c.core);
  assert.deepEqual(actions.toggle(c.uid, { ring: asm.ring_index, slot: asm.slot_index, paused: false }), { ok: true });
  assert.equal(bld(c.id, 'parts_assembler', c.core).parked, 0);
  assert.equal(viewFor(c.uid).colony.parked, 2);
  assert.deepEqual(actions.resumeOps(c.uid, {}), { ok: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM colony_buildings WHERE colony_id = ? AND status = 'paused'").get(c.id).n, 0);
  assert.match(actions.resumeOps(c.uid, {}).error, /No buildings are parked/);
  // a building the player paused on purpose is not touched by a restart
  const drill = bld(c.id, 'ore_drill', c.pits);
  actions.toggle(c.uid, { ring: drill.ring_index, slot: drill.slot_index, paused: true, district: c.pits });
  actions.resumeOps(c.uid, {});
  assert.equal(bld(c.id, 'ore_drill', c.pits).status, 'paused');
});

test('it recovers once nobody is starving and morale is back up; parked buildings wait for the player', () => {
  const c = colony();
  starve(c);
  db.prepare('UPDATE colonies SET morale = 0.5 WHERE id = ?').run(c.id);
  tick(2);
  assert.notEqual(row(c.id).shutdown_tick, null);
  db.prepare("UPDATE colony_inventory SET amount = 1500 WHERE district_id = ? AND resource_id IN ('clean_water','rations')").run(c.core);
  tick(200);
  const r = row(c.id);
  assert.equal(r.shutdown_tick, null, 'no longer shut down');
  assert.equal(r.shutdowns, 1);
  assert.equal(bld(c.id, 'parts_assembler', c.core).parked, 1, 'still parked until the player decides');
  assert.ok(db.prepare("SELECT 1 FROM colony_events WHERE colony_id = ? AND message LIKE 'The colony has stabilised%'").get(c.id));
  // and a later collapse shuts it down again
  starve(c);
  db.prepare('UPDATE colonies SET morale = 0.5 WHERE id = ?').run(c.id);
  tick(2);
  assert.equal(row(c.id).shutdowns, 2);
});
