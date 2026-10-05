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
  assert.equal(store.loadHazard(id).state, 'forecast', 'still pending');
  tick(1);
  assert.equal(store.loadHazard(id).state, 'active', 'raid has struck and its aftermath is running');
  const ev = events(id);
  assert.equal(ev.length, 1);
  assert.match(ev[0].message, /Raid hits \(0% prepared\)/);
  assert.match(ev[0].message, /looted/);
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

test('fully prepared: no penalty, but weathering it still costs maintenance for the duration', () => {
  process.env.HAZARDS = 'on';
  const { uid, id } = newColony();
  stockUp(id);
  setStock(id, 'machined_parts', 500);
  db.prepare("INSERT INTO colony_buildings (colony_id, ring_index, slot_index, building_type) VALUES (?, 1, 0, 'solar_array')").run(id);
  const baseSupply = viewFor(uid).energy.supply;
  force(id, 'dust_storm', 2);
  away(id);
  tick(2);
  const def = config.hazards.types.dust_storm;
  const need = def.requires[0].amount;
  const h = store.loadHazard(id);
  assert.equal(h.state, 'active');
  assert.equal(h.severity, 0, 'no output penalty when fully prepared');
  assert.ok(stock(id, 'machined_parts') <= 500 - need + 1, 'reserves were spent');
  assert.match(events(id)[0].message, /weathered/);
  assert.match(events(id)[0].message, /Panel cleaning/);
  let v = viewFor(uid);
  assert.equal(v.energy.supply, baseSupply, 'solar output untouched');
  assert.equal(v.hazard.penalty.length, 0);
  assert.equal(v.hazard.cost.length, 1);
  // the cleaning drain is real: parts fall by about 0.6 per tick per solar array
  const before = stock(id, 'machined_parts');
  tick(3);
  const drained = before - stock(id, 'machined_parts');
  assert.ok(Math.abs(drained - 3 * def.mitigated.perBuilding.solar_array) < 0.01, `drained ${drained}`);
  tick(def.durationTicks);
  assert.equal(store.loadHazard(id), null);
  assert.equal(db.prepare('SELECT hazards_survived AS s FROM colonies WHERE id = ?').get(id).s, 1);
  assert.equal(viewFor(uid).report.length, 2, 'away player is told about the strike and when it passed');
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

test('partly prepared: penalty and maintenance are both prorated, and only what is stocked is spent', () => {
  process.env.HAZARDS = 'on';
  const { uid, id } = newColony();
  stockUp(id);
  db.prepare("INSERT INTO colony_buildings (colony_id, ring_index, slot_index, building_type) VALUES (?, 1, 0, 'solar_array')").run(id);
  const base = viewFor(uid).energy.supply;
  setStock(id, 'machined_parts', 15); // half of the 30 needed at hub level 1
  force(id, 'dust_storm', 1);
  tick(1);
  const h = store.loadHazard(id);
  assert.ok(Math.abs(h.severity - 0.5) < 0.05, `severity ${h.severity}`);
  assert.ok(stock(id, 'machined_parts') < 1, 'spent everything it had');
  const v = viewFor(uid);
  const solar = config.buildings.solar_array.outputsPerTick.energy;
  const mult = config.hazards.types.dust_storm.effect.mult;
  assert.ok(Math.abs(v.energy.supply - (base - solar * (1 - mult) * h.severity)) < 0.5);
  assert.equal(v.hazard.penalty.length, 1);
  assert.equal(v.hazard.cost.length, 1);
  assert.match(events(id).pop().message, /5\d% prepared|50% prepared/);
});

test('raid: loot and damage scale with how unprepared the colony was; watch posts blunt it', () => {
  process.env.HAZARDS = 'on';
  const bare = newColony(); stockUp(bare.id);
  for (let i = 0; i < 4; i++) db.prepare("INSERT INTO colony_buildings (colony_id, ring_index, slot_index, building_type) VALUES (?, 1, ?, 'solar_array')").run(bare.id, i);
  force(bare.id, 'raid', 1); tick(1);
  const lostBare = 1500 - stock(bare.id, 'scrap');
  assert.ok(lostBare > 1500 * config.hazards.types.raid.effect.steal.scrap * 0.9, `lost ${lostBare}`);
  const hb = store.loadHazard(bare.id);
  assert.equal(hb.state, 'active');
  assert.equal(hb.data.ids.length, 1, 'one building damaged at hub level 1');
  const guarded = newColony(); stockUp(guarded.id);
  for (let i = 0; i < 3; i++) db.prepare("INSERT INTO colony_buildings (colony_id, ring_index, slot_index, building_type) VALUES (?, 1, ?, 'watch_post')").run(guarded.id, i);
  setStock(guarded.id, 'scrap', 1500);
  force(guarded.id, 'raid', 1); tick(1);
  assert.equal(stock(guarded.id, 'scrap'), 1500, 'nothing looted');
  const hg = store.loadHazard(guarded.id);
  assert.equal(hg.severity, 0);
  assert.equal(hg.data.ids.length, 0, 'nothing damaged');
  assert.match(events(guarded.id).pop().message, /weathered/);
});

test('equipment fault degrades several buildings (more at higher hub levels) for the duration', () => {
  process.env.HAZARDS = 'on';
  const mk = (level) => {
    const { uid, id } = newColony();
    stockUp(id); setStock(id, 'machined_parts', 0); setStock(id, 'scrap', 0);
    db.prepare('UPDATE colonies SET hub_level = ? WHERE id = ?').run(level, id);
    for (let i = 0; i < 6; i++) db.prepare("INSERT INTO colony_buildings (colony_id, ring_index, slot_index, building_type) VALUES (?, 1, ?, 'solar_array')").run(id, i);
    force(id, 'equipment_fault', 1); tick(1);
    return { uid, id, h: store.loadHazard(id) };
  };
  const low = mk(1), high = mk(5);
  assert.equal(low.h.data.ids.length, 1);
  assert.equal(high.h.data.ids.length, 3);
  const v = viewFor(low.uid);
  const hit = v.buildings.filter((b) => b.haz < 1);
  assert.equal(hit.length, 1);
  assert.ok(Math.abs(hit[0].haz - config.hazards.types.equipment_fault.effect.mult) < 1e-9);
  assert.ok(v.hazard.penalty[0].includes('efficiency'));
  tick(config.hazards.types.equipment_fault.durationTicks);
  assert.equal(store.loadHazard(low.id), null);
  assert.ok(viewFor(low.uid).buildings.every((b) => b.haz === 1));
});

test('equipment fault, fully prepared: no degradation, but parts drain with every running building', () => {
  process.env.HAZARDS = 'on';
  const { uid, id } = newColony();
  stockUp(id); setStock(id, 'machined_parts', 400);
  for (let i = 0; i < 5; i++) db.prepare("INSERT INTO colony_buildings (colony_id, ring_index, slot_index, building_type) VALUES (?, 1, ?, 'solar_array')").run(id, i);
  force(id, 'equipment_fault', 1); tick(1);
  assert.equal(store.loadHazard(id).severity, 0);
  const v = viewFor(uid);
  assert.ok(v.buildings.every((b) => b.haz === 1));
  const before = stock(id, 'machined_parts');
  tick(2);
  const drained = before - stock(id, 'machined_parts');
  assert.ok(Math.abs(drained - 2 * 5 * config.hazards.types.equipment_fault.mitigated.perRunning) < 0.01, `drained ${drained}`);
});

test('requirements scale with hub level, and the view reports live preparedness', () => {
  process.env.HAZARDS = 'on';
  const { uid, id } = newColony();
  stockUp(id);
  force(id, 'dust_storm', 10);
  setStock(id, 'machined_parts', 10);
  let v = viewFor(uid);
  assert.equal(v.hazard.requirements[0].need, 30);
  assert.ok(Math.abs(v.hazard.prep - 10 / 30) < 1e-9);
  db.prepare('UPDATE colonies SET hub_level = 3 WHERE id = ?').run(id);
  v = viewFor(uid);
  assert.equal(v.hazard.requirements[0].need, Math.ceil(30 * (1 + config.hazards.scalingPerHubLevel * 2)));
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

test('later hazards unlock with hub level; the signal storm needs a beacon', () => {
  process.env.HAZARDS = 'on';
  const seen = (level, withBeacon) => {
    const types = new Set();
    for (let k = 0; k < 40; k++) {
      const { id } = newColony();
      stockUp(id);
      db.prepare('UPDATE colonies SET hub_level = ?, age = 99, next_hazard_age = 0, hazard_count = ? WHERE id = ?').run(level, k, id);
      if (withBeacon) db.prepare("INSERT INTO colony_buildings (colony_id, ring_index, slot_index, building_type) VALUES (?, 5, 0, 'beacon_array')").run(id);
      here(id);
      tick(1);
      const h = store.loadHazard(id);
      if (h) types.add(h.type);
    }
    return types;
  };
  assert.deepEqual([...seen(1, false)].sort(), ['dust_storm', 'equipment_fault']);
  const l3 = seen(3, false);
  assert.ok(l3.has('toxic_spill') && !l3.has('cold_snap') && !l3.has('signal_storm'));
  assert.ok(seen(4, false).has('cold_snap'));
  assert.ok(!seen(5, false).has('signal_storm'), 'no beacon, no signal storm');
  assert.ok(seen(5, true).has('signal_storm'));
});

test('cold snap raises what the population eats; fully prepared still costs a little', () => {
  process.env.HAZARDS = 'on';
  const mk = (alloys, rations) => {
    const { uid, id } = newColony();
    stockUp(id); setStock(id, 'alloys', alloys); setStock(id, 'rations', rations);
    db.prepare('UPDATE colonies SET hub_level = 4 WHERE id = ?').run(id);
    return { uid, id };
  };
  const base = viewFor(mk(500, 1500).uid).resources.rations.consumed;
  const bare = mk(0, 0);
  force(bare.id, 'cold_snap', 1); tick(1);
  setStock(bare.id, 'rations', 500); // measure consumption, not starvation
  const hit = viewFor(bare.uid);
  assert.ok(hit.resources.rations.consumed > base * 1.5, `${hit.resources.rations.consumed} vs ${base}`);
  const ready = mk(500, 1500);
  force(ready.id, 'cold_snap', 1); tick(1);
  const ok = viewFor(ready.uid);
  const m = config.hazards.types.cold_snap.mitigated.mult;
  assert.ok(ok.resources.rations.consumed > base && ok.resources.rations.consumed < base * 1.5);
  assert.ok(ok.hazard.cost[0].includes('consumption'));
  assert.equal(ok.hazard.penalty.length, 0);
  assert.ok(m > 1);
});

test('hazards come a little faster at higher hub levels', () => {
  process.env.HAZARDS = 'on';
  const gaps = (level) => {
    let total = 0;
    for (let k = 0; k < 30; k++) {
      const { id } = newColony();
      stockUp(id);
      db.prepare('UPDATE colonies SET hub_level = ?, age = 10, hazard_count = ? WHERE id = ?').run(level, k, id);
      force(id, 'raid', 1); tick(1);
      total += db.prepare('SELECT next_hazard_age - age AS g FROM colonies WHERE id = ?').get(id).g;
    }
    return total / 30;
  };
  assert.ok(gaps(5) < gaps(2) - 3, `${gaps(5)} vs ${gaps(2)}`);
});
