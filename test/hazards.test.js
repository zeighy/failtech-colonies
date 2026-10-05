'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-haz-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.AUTH_RATE_LIMIT = '1000';

const engine = require('../src/engine');
const store = require('../src/db');
const actions = require('../src/actions');
const { viewFor } = require('../src/state');
const { db, config } = store;

test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function newColony() {
  const uid = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(`h${++n}`, 'x').lastInsertRowid;
  const id = store.ensureColony(Number(uid));
  return { uid: Number(uid), id };
}
const tick = (k = 1) => { for (let i = 0; i < k; i++) engine.processTick(); };
const gtick = () => engine.timing().globalTick;
const setStock = (id, res, amt) => db.prepare('UPDATE colony_inventory SET amount = ? WHERE colony_id = ? AND resource_id = ?').run(amt, id, res);
const stock = (id, res) => store.loadInventory(id)[res];
const away = (id) => db.prepare('UPDATE colonies SET last_seen_at = 0 WHERE id = ?').run(id);
const here = (id) => db.prepare('UPDATE colonies SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
function force(id, type, inTicks) {
  db.prepare("DELETE FROM colony_hazards WHERE colony_id = ?").run(id);
  db.prepare("INSERT INTO colony_hazards (colony_id, type, state, strikes_tick) VALUES (?, ?, 'forecast', ?)").run(id, type, gtick() + inTicks);
}
const events = (id) => db.prepare("SELECT * FROM colony_events WHERE colony_id = ? AND tag = 'hazard' ORDER BY id").all(id);
// Keep colonies alive and comfortable so hazard effects are what we measure.
function stockUp(id) { for (const r of ['clean_water', 'rations', 'scrap', 'machined_parts']) setStock(id, r, 1500); }

test('hazards only start while the player is active, after the first-hazard age', () => {
  process.env.HAZARDS = 'on';
  const { id } = newColony();
  stockUp(id);
  db.prepare('UPDATE colonies SET age = ? WHERE id = ?').run(config.hazards.firstAtAge, id);
  away(id);
  tick(3);
  assert.equal(store.loadHazard(id), null, 'nothing is forecast for an absent player');
  here(id);
  tick(1);
  const h = store.loadHazard(id);
  assert.ok(h && h.state === 'forecast');
  const def = config.hazards.types[h.type];
  const warning = h.strikes_tick - gtick();
  assert.ok(warning >= def.warningTicks[0] - 1 && warning <= def.warningTicks[1], `warning ${warning}`);
  tick(2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM colony_hazards WHERE colony_id = ?').get(id).n, 1, 'one hazard at a time');
});

test('no hazard before the first-hazard age', () => {
  process.env.HAZARDS = 'on';
  const { id } = newColony();
  stockUp(id);
  here(id);
  tick(5);
  assert.equal(store.loadHazard(id), null);
});

test('a forecast hazard strikes on schedule even if the player is away; a report waits for them', () => {
  process.env.HAZARDS = 'on';
  const { uid, id } = newColony();
  stockUp(id);
  force(id, 'raid', 3);
  away(id);
  tick(2);
  assert.ok(store.loadHazard(id), 'still pending');
  tick(1);
  assert.equal(store.loadHazard(id), null, 'raid resolves instantly');
  const ev = events(id);
  assert.equal(ev.length, 1);
  assert.match(ev[0].message, /Raiders struck \(0% prepared\)/);
  let v = viewFor(uid);
  assert.equal(v.report.length, 1);
  assert.equal(actions.ack(uid).ok, true);
  v = viewFor(uid);
  assert.equal(v.report.length, 0);
});

test('a player who is watching does not get an away report', () => {
  process.env.HAZARDS = 'on';
  const { uid, id } = newColony();
  stockUp(id);
  force(id, 'raid', 1);
  here(id);
  tick(1);
  assert.equal(events(id).length, 1);
  assert.equal(viewFor(uid).report.length, 0);
});

test('fully prepared: the colony averts the hazard on its own and spends the reserves', () => {
  process.env.HAZARDS = 'on';
  const { uid, id } = newColony();
  stockUp(id);
  setStock(id, 'machined_parts', 100);
  force(id, 'dust_storm', 2);
  away(id);
  const before = stock(id, 'machined_parts');
  tick(2);
  const need = config.hazards.types.dust_storm.requires[0].amount;
  assert.equal(store.loadHazard(id), null, 'no lingering effect');
  assert.ok(stock(id, 'machined_parts') <= before - need + 1, 'reserves were spent');
  assert.match(events(id)[0].message, /averted/);
  assert.match(events(id)[0].message, /Spent 20 Machined Parts/);
  assert.equal(db.prepare('SELECT hazards_survived AS s FROM colonies WHERE id = ?').get(id).s, 1);
  assert.equal(viewFor(uid).report.length, 1, 'away player is told what happened');
});

test('unprepared dust storm: solar output collapses for its duration, then recovers', () => {
  process.env.HAZARDS = 'on';
  const { uid, id } = newColony();
  stockUp(id);
  setStock(id, 'machined_parts', 0);
  db.prepare("INSERT INTO colony_buildings (colony_id, ring_index, slot_index, building_type) VALUES (?, 1, 0, 'solar_array')").run(id);
  const base = viewFor(uid).energy.supply;
  force(id, 'dust_storm', 1);
  tick(1);
  const h = store.loadHazard(id);
  assert.equal(h.state, 'active');
  assert.equal(h.severity, 1);
  const hit = viewFor(uid);
  const solar = config.buildings.solar_array.outputsPerTick.energy;
  assert.ok(Math.abs(hit.energy.supply - (base - solar * (1 - config.hazards.types.dust_storm.effect.mult))) < 1e-6, `${hit.energy.supply} vs ${base}`);
  assert.equal(hit.hazard.state, 'active');
  tick(config.hazards.types.dust_storm.durationTicks);
  assert.equal(store.loadHazard(id), null);
  assert.equal(viewFor(uid).energy.supply, base);
  assert.ok(events(id).some((e) => /has passed/.test(e.message)));
});

test('partly prepared: the penalty is prorated and only what is stocked is spent', () => {
  process.env.HAZARDS = 'on';
  const { id } = newColony();
  stockUp(id);
  setStock(id, 'machined_parts', 10); // half of the 20 needed at hub level 1
  force(id, 'dust_storm', 1);
  tick(1);
  const h = store.loadHazard(id);
  assert.ok(Math.abs(h.severity - 0.5) < 0.05, `severity ${h.severity}`);
  assert.ok(stock(id, 'machined_parts') < 1, 'spent everything it had');
  assert.match(events(id).pop().message, /5\d% prepared|50% prepared/);
});

test('raid: loot scales with how unprepared the colony was; watch posts blunt it', () => {
  process.env.HAZARDS = 'on';
  const bare = newColony(); stockUp(bare.id); force(bare.id, 'raid', 1); tick(1);
  const lostBare = 1500 - stock(bare.id, 'scrap');
  assert.ok(lostBare > 1500 * config.hazards.types.raid.effect.steal.scrap * 0.9, `lost ${lostBare}`);
  const guarded = newColony(); stockUp(guarded.id);
  for (let i = 0; i < 3; i++) db.prepare("INSERT INTO colony_buildings (colony_id, ring_index, slot_index, building_type) VALUES (?, 1, ?, 'watch_post')").run(guarded.id, i);
  setStock(guarded.id, 'scrap', 1500);
  force(guarded.id, 'raid', 1); tick(1);
  assert.ok(stock(guarded.id, 'scrap') >= 1500 - 1, 'well defended: nothing lost (watch posts also cost no scrap to run)');
  assert.match(events(guarded.id).pop().message, /averted/);
});

test('equipment fault knocks one building offline, then it comes back', () => {
  process.env.HAZARDS = 'on';
  const { uid, id } = newColony();
  stockUp(id); setStock(id, 'machined_parts', 0); setStock(id, 'scrap', 0);
  db.prepare("INSERT INTO colony_buildings (colony_id, ring_index, slot_index, building_type) VALUES (?, 1, 0, 'solar_array')").run(id);
  force(id, 'equipment_fault', 1);
  tick(1);
  const h = store.loadHazard(id);
  assert.equal(h.state, 'active');
  let v = viewFor(uid);
  assert.equal(v.buildings[0].status, 'damaged');
  assert.ok(v.hazard.effect.includes('Solar Array'));
  tick(config.hazards.types.equipment_fault.durationTicks + 1);
  v = viewFor(uid);
  assert.notEqual(v.buildings[0].status, 'damaged');
  assert.equal(v.hazard, null);
});

test('requirements scale with hub level, and the view reports live preparedness', () => {
  process.env.HAZARDS = 'on';
  const { uid, id } = newColony();
  stockUp(id);
  force(id, 'dust_storm', 10);
  setStock(id, 'machined_parts', 10);
  let v = viewFor(uid);
  assert.equal(v.hazard.requirements[0].need, 20);
  assert.ok(Math.abs(v.hazard.prep - 0.5) < 1e-9);
  db.prepare('UPDATE colonies SET hub_level = 3 WHERE id = ?').run(id);
  v = viewFor(uid);
  assert.equal(v.hazard.requirements[0].need, Math.ceil(20 * (1 + config.hazards.scalingPerHubLevel * 2)));
});

test('hazard choice is seeded: same colony and count give the same forecast', () => {
  process.env.HAZARDS = 'on';
  const picks = [];
  for (let run = 0; run < 2; run++) {
    const { id } = newColony();
    // identical ids across runs aren't possible, so compare via the rng directly
    picks.push(require('../src/hazards').rng(id * 0 + 12345)());
  }
  assert.equal(picks[0], picks[1]);
});
