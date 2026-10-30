'use strict';
// Orbit, part one: the unlock, the launch cycle, the station and its storage, the links to the Core and the express launch.
//
// Flow: a colony with enough faction standing (orbital.unlockStanding, summed over every faction) sees the orbital buildings.
// With the Staging Platform, the Catapult beside it and the Orbital Command Center built, a launch cycle is loaded at the
// staging platform; it draws its materials every tick until the payload is complete, then unloads itself and waits. Pressing
// Launch at the catapult sends it up: the first launch founds the station (the player names it), later ones open its rings.
//
// The station is a district of type 'station' (config.orbitalTypes). Its stockpile is orbital storage, which only has a few
// slots: each slot holds one kind of resource, and anything arriving without a slot is lost. Jettisoning a slot frees it,
// but it then has to be rebuilt before it can hold anything again.
const store = require('./db');
const { own, toInt, toNum } = require('./validate');
const { db, config } = store;
const O = config.orbital;

const fail = (error) => ({ ok: false, error });
const OK = { ok: true };

// ---- lookups ------------------------------------------------------------------------
const stationOf = (colonyId) => db.prepare('SELECT * FROM stations WHERE colony_id = ?').get(colonyId) || null;
const standingTotal = (colonyId) => db.prepare('SELECT COALESCE(SUM(points), 0) AS n FROM standing WHERE colony_id = ?').get(colonyId).n;
const storageLevel = (st) => O.storage.levels[st.storage_level] || O.storage.levels['1'];
const linksLevel = (st) => O.links.levels[st.links_level] || O.links.levels['1'];
const isRare = (res) => !!(config.resources[res] && config.resources[res].rare);
const flagsOf = (c) => { try { return JSON.parse(c.orbital_flags || '{}'); } catch (e) { return {}; } };

// Sticky story and directive milestones ("ever launched", "ever deployed"...). Returns true the first time.
function setFlag(colonyId, key, tick) {
  const row = db.prepare('SELECT orbital_flags FROM colonies WHERE id = ?').get(colonyId);
  const f = flagsOf(row || {});
  if (f[key] !== undefined) return false;
  f[key] = tick;
  db.prepare('UPDATE colonies SET orbital_flags = ? WHERE id = ?').run(JSON.stringify(f), colonyId);
  return true;
}

// The building rows of one type anywhere in the colony.
const buildingsOf = (colonyId, type) => db.prepare('SELECT * FROM colony_buildings WHERE colony_id = ? AND building_type = ?').all(colonyId, type);

// ---- unlock -------------------------------------------------------------------------
// Sticky: once recognised, always recognised (standing can only go up today, but the flag makes it explicit).
function checkUnlock(c, tick) {
  if (c.orbital_unlocked) return false;
  if (standingTotal(c.id) < O.unlockStanding) return false;
  db.prepare('UPDATE colonies SET orbital_unlocked = 1 WHERE id = ?').run(c.id);
  c.orbital_unlocked = 1;
  store.addEvent(c.id, tick, 'good', 'Your name is known across the lands now. New plans have arrived for the Core and the Free Port.');
  return true;
}

// ---- storage slots --------------------------------------------------------------------
function slots(colonyId) {
  return db.prepare('SELECT idx, resource_id AS resource, state FROM orbital_slots WHERE colony_id = ? ORDER BY idx').all(colonyId);
}
function ensureSlots(colonyId, count) {
  const have = slots(colonyId).length;
  const ins = db.prepare("INSERT OR IGNORE INTO orbital_slots (colony_id, idx, resource_id, state) VALUES (?, ?, NULL, 'open')");
  for (let i = have; i < count; i++) ins.run(colonyId, i);
}

// Bring a station stockpile in line with its slots: a resource with no slot takes a free one if there is one, otherwise it
// is lost; nothing holds more than the slot capacity. Mutates `inv`; returns [{resource, qty}] lost.
function enforceSlots(colonyId, inv, cap) {
  // Slots are rows made when a store is upgraded, so a change to how many slots a level has (or a store upgraded before it)
  // would never show up. Top the rows up to what the level now gives, every tick.
  const st = stationOf(colonyId);
  if (st) ensureSlots(colonyId, storageLevel(st).slots);
  const all = slots(colonyId);
  const held = new Map(all.filter((s) => s.resource).map((s) => [s.resource, s]));
  const free = all.filter((s) => !s.resource && s.state === 'open');
  const claim = db.prepare('UPDATE orbital_slots SET resource_id = ? WHERE colony_id = ? AND idx = ?');
  const lost = [];
  // when slots are contested, the biggest stocks keep theirs (a trickle of new output never pushes out a real stockpile)
  for (const res of Object.keys(inv).sort((x, y) => (inv[y] || 0) - (inv[x] || 0))) {
    const amt = inv[res] || 0;
    if (amt <= 1e-6) { inv[res] = 0; continue; }
    if (!held.has(res)) {
      const s = free.shift();
      if (s) { claim.run(res, colonyId, s.idx); held.set(res, s); } else { lost.push({ resource: res, qty: amt }); inv[res] = 0; continue; }
    }
    if (amt > cap) { lost.push({ resource: res, qty: amt - cap, full: true }); inv[res] = cap; }
  }
  return lost;
}

// Would a resource fit in this station's storage right now (it has a slot, or a free one exists)?
function hasRoomFor(colonyId, res) {
  const all = slots(colonyId);
  return all.some((s) => s.resource === res) || all.some((s) => !s.resource && s.state === 'open');
}

// ---- districts: what the simulation needs to know about orbital places ----------------
// The station's storage cap comes from its storage level, not its ring level. A territory gets its power and hold from the
// dropship sitting on it, its resources from the territory, and the anomaly's bonus on the rare-resource tap.
function districtExtras(c, d) {
  if (d.type === 'station') {
    const st = stationOf(c.id);
    if (st) return { capOverride: storageLevel(st).cap };
  }
  if (d.type === 'territory') {
    const row = db.prepare('SELECT territory_id FROM districts WHERE id = ?').get(d.id);
    const t = row && db.prepare('SELECT * FROM territories WHERE id = ?').get(row.territory_id);
    const ship = db.prepare('SELECT * FROM dropships WHERE district_id = ?').get(d.id);
    const lv = O.dropships.levels[(ship && ship.level) || 1];
    const out = { capOverride: lv.hold, baseEnergy: lv.power };
    if (t) {
      out.territory = JSON.parse(t.resources);
      const an = O.territories.anomalies[t.anomaly];
      if (an) { out.outputMult = { t_tap: an.rareMult }; out.baseEnergy = Math.round(lv.power * (an.powerMult || 1)); } // some anomalies thin the ship's power
    }
    return out;
  }
  return {};
}

// ---- launch cycle ---------------------------------------------------------------------
// Which cycle comes next for this colony: the station itself, then its rings.
function nextCycle(colonyId) {
  const st = stationOf(colonyId);
  if (!st) return 'station';
  const level = db.prepare('SELECT level FROM districts WHERE id = ?').get(st.district_id).level;
  return Object.keys(O.launch.cycles).find((k) => O.launch.cycles[k].stationLevel === level + 1) || null;
}

// Everything the launch chain needs, built (not under construction) and switched on.
function launchSite(colonyId) {
  const one = (type) => buildingsOf(colonyId, type)[0] || null;
  return { staging: one('orbital_staging'), catapult: one('orbital_catapult'), command: one('orbital_command') };
}

// Called every tick with the colony's stepColony result: count the cycle's progress and finish it.
function advanceLaunch(c, launchGain, tick) {
  if (!(launchGain > 0)) return;
  const staging = launchSite(c.id).staging;
  if (!staging || !staging.recipe) return;
  const cyc = O.launch.cycles[staging.recipe];
  if (!cyc) return;
  const progress = (c.launch_progress || 0) + launchGain;
  if (progress + 1e-6 >= cyc.ticks) {
    db.prepare('UPDATE colony_buildings SET recipe = NULL WHERE id = ?').run(staging.id);
    db.prepare('UPDATE colonies SET launch_progress = 0, launch_ready = ? WHERE id = ?').run(staging.recipe, c.id);
    setFlag(c.id, 'cycleDone', tick);
    store.addEvent(c.id, tick, 'good', 'The launch payload is complete. The staging platform has stood down and the catapult is ready to launch.');
  } else {
    db.prepare('UPDATE colonies SET launch_progress = ? WHERE id = ?').run(progress, c.id);
  }
}

function loadCycle(c, { cycle }, tick) {
  if (!c.orbital_unlocked && !checkUnlock(c, tick)) return fail('Nothing is known about that yet.');
  const site = launchSite(c.id);
  if (!site.staging) return fail('Build the staging platform first.');
  if (!site.catapult) return fail('Build the catapult beside the staging platform first.');
  if (!site.command) return fail('Build the Orbital Command Center first.');
  if (c.launch_ready) return fail('A payload is already waiting on the catapult. Launch it first.');
  const next = nextCycle(c.id);
  if (cycle === null || cycle === false) {
    db.prepare('UPDATE colony_buildings SET recipe = NULL WHERE id = ?').run(site.staging.id);
    db.prepare('UPDATE colonies SET launch_progress = 0 WHERE id = ?').run(c.id);
    return OK;
  }
  if (typeof cycle !== 'string' || !own(O.launch.cycles, cycle)) return fail('Unknown launch cycle.');
  if (cycle !== next) return fail(next ? 'That is not the next launch.' : 'There is nothing left to launch.');
  if (site.staging.recipe === cycle) return OK;
  db.prepare('UPDATE colony_buildings SET recipe = ? WHERE id = ?').run(cycle, site.staging.id);
  db.prepare('UPDATE colonies SET launch_progress = 0 WHERE id = ?').run(c.id);
  return OK;
}

// A station name: 3 to 24 letters, digits, spaces and a little punctuation, unique, and never anyone's callsign.
function checkName(name) {
  if (typeof name !== 'string') return 'Give the station a name.';
  const n = name.trim().replace(/\s+/g, ' ');
  const { min, max } = O.stationName;
  if (n.length < min || n.length > max) return `A station name is ${min} to ${max} characters.`;
  if (!/^[A-Za-z0-9][A-Za-z0-9 '.-]*[A-Za-z0-9.]$/.test(n)) return 'Use letters, digits, spaces, apostrophes, dots and hyphens.';
  if (/^market maker$/i.test(n)) return 'That name is reserved.';
  if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(n)) return 'That name is taken. Station names cannot match a callsign.';
  if (db.prepare('SELECT 1 FROM stations WHERE name = ? COLLATE NOCASE').get(n)) return 'Another station already has that name.';
  return null;
}

function launch(c, { name }, tick) {
  const site = launchSite(c.id);
  if (!c.launch_ready) return fail('Nothing is ready to launch. Complete a launch cycle at the staging platform.');
  if (!site.catapult || site.catapult.status !== 'active') return fail('The catapult must be built and switched on.');
  const core = store.coreId(c.id);
  if ((store.loadInventory(c.id, core).fuel || 0) < 1) return fail('The catapult has no fuel.');
  const cyc = O.launch.cycles[c.launch_ready];
  const st = stationOf(c.id);
  if (c.launch_ready === 'station') {
    if (!site.command || site.command.status !== 'active') return fail('The Orbital Command Center must be running to track the launch.');
    const bad = checkName(name);
    if (bad) return fail(bad);
    const n = name.trim().replace(/\s+/g, ' ');
    const did = Number(db.prepare("INSERT INTO districts (colony_id, type, level, name, created_tick) VALUES (?, 'station', 1, ?, ?)").run(c.id, n, tick).lastInsertRowid);
    db.prepare('INSERT INTO stations (colony_id, name, district_id, launched_tick) VALUES (?, ?, ?, ?)').run(c.id, n, did, tick);
    ensureSlots(c.id, O.storage.levels['1'].slots);
    const inv = {};
    for (const r of Object.keys(config.resources)) inv[r] = 0;
    Object.assign(inv, O.launch.starterKit);
    enforceSlots(c.id, inv, O.storage.levels['1'].cap);
    store.saveInventory(c.id, inv, did);
    db.prepare("INSERT INTO dropships (colony_id, num, level, integrity, state, invested) VALUES (?, 1, 1, 100, 'docked', ?)").run(c.id, JSON.stringify(O.dropships.freeValue));
    setFlag(c.id, 'launched', tick);
    store.addEvent(c.id, tick, 'good', `Launch! ${n} is in orbit. The Orbital Command view is open.`);
  } else {
    if (!st) return fail('There is no station to upgrade.');
    const sinv = store.loadInventory(c.id, st.district_id);
    for (const [r, q] of Object.entries(cyc.orbitalCost || {})) {
      if ((sinv[r] || 0) < q) return fail(`The station needs ${q} ${config.resources[r].name} in orbital storage for this upgrade.`);
    }
    for (const [r, q] of Object.entries(cyc.orbitalCost || {})) sinv[r] -= q;
    store.saveInventory(c.id, sinv, st.district_id);
    db.prepare('UPDATE districts SET level = ? WHERE id = ?').run(cyc.stationLevel, st.district_id);
    setFlag(c.id, `ring${cyc.stationLevel}`, tick);
    store.addEvent(c.id, tick, 'good', `Launch! The station's ring ${cyc.stationLevel} is in place.`);
  }
  db.prepare('UPDATE colonies SET launch_ready = NULL, launch_progress = 0 WHERE id = ?').run(c.id);
  return OK;
}

// ---- express launch -------------------------------------------------------------------
function expressCost(qty) { return Math.ceil(O.express.fuelBase + qty * O.express.fuelPerUnit); }

function expressLaunch(c, { resource, qty, dir }, tick) {
  const st = stationOf(c.id);
  if (!st) return fail('There is no station to launch to.');
  if (dir === 'down') return expressDrop(c, st, { resource, qty }, tick);
  const site = launchSite(c.id);
  if (!site.catapult || site.catapult.status !== 'active') return fail('The catapult must be built and switched on.');
  if (c.express_launch_ready_tick > tick) return fail(`The launch slot is not ready for ${c.express_launch_ready_tick - tick} more ticks.`);
  if (!own(config.resources, resource) || isRare(resource)) return fail('That cannot be launched.');
  qty = toInt(qty);
  if (Number.isNaN(qty) || qty < 1 || qty > O.express.maxQty) return fail(`Launch between 1 and ${O.express.maxQty}.`);
  if (!hasRoomFor(c.id, resource)) return fail('Orbital storage has no slot for that. Jettison a slot first.');
  const core = store.coreId(c.id);
  const inv = store.loadInventory(c.id, core);
  const fuel = expressCost(qty) + (resource === 'fuel' ? qty : 0);
  if ((inv[resource] || 0) < qty) return fail(`Not enough ${config.resources[resource].name} in the Core.`);
  if ((inv.fuel || 0) < fuel) return fail(`An express launch of ${qty} needs ${expressCost(qty)} fuel.`);
  inv[resource] -= qty;
  inv.fuel -= expressCost(qty);
  store.saveInventory(c.id, inv, core);
  db.prepare('INSERT INTO orbital_shipments (colony_id, resource_id, qty, arrives_tick) VALUES (?, ?, ?, ?)').run(c.id, resource, qty, tick + O.express.travelTicks);
  db.prepare('UPDATE colonies SET express_launch_ready_tick = ? WHERE id = ?').run(tick + O.express.cooldownTicks, c.id);
  return OK;
}

// An express drop: the other way, a capsule from orbital storage down to the Core. Gravity does the work, so it costs no
// fuel, only the capsule (paid from orbital storage); it shares the express slot and its cooldown with launches.
function expressDrop(c, st, { resource, qty }, tick) {
  const D = O.express.drop;
  const site = launchSite(c.id);
  if (!site.command || site.command.status !== 'active') return fail('The Orbital Command Center must be running to bring a capsule down.');
  if (c.express_launch_ready_tick > tick) return fail(`The express slot is not ready for ${c.express_launch_ready_tick - tick} more ticks.`);
  if (!own(config.resources, resource) || isRare(resource)) return fail('That cannot be dropped.');
  qty = toInt(qty);
  if (Number.isNaN(qty) || qty < 1 || qty > O.express.maxQty) return fail(`Drop between 1 and ${O.express.maxQty}.`);
  const inv = store.loadInventory(c.id, st.district_id);
  const need = { ...D.cost }; need[resource] = (need[resource] || 0) + qty;
  for (const [r, q] of Object.entries(need)) if ((inv[r] || 0) < q) return fail(r === resource ? `Not enough ${config.resources[r].name} in orbital storage.` : `A drop capsule needs ${Object.entries(D.cost).map(([k, v]) => `${v} ${config.resources[k].name}`).join(', ')} from orbital storage.`);
  for (const [r, q] of Object.entries(need)) inv[r] -= q;
  store.saveInventory(c.id, inv, st.district_id);
  db.prepare("INSERT INTO orbital_shipments (colony_id, resource_id, qty, arrives_tick, dest) VALUES (?, ?, ?, ?, 'core')").run(c.id, resource, qty, tick + D.travelTicks);
  db.prepare('UPDATE colonies SET express_launch_ready_tick = ? WHERE id = ?').run(tick + O.express.cooldownTicks, c.id);
  return OK;
}

// Express launches and drops that have arrived: into the station stockpile (slots are enforced afterwards) or the Core's.
function arrivals(c, inv, tick, coreInv) {
  for (const s of db.prepare('SELECT * FROM orbital_shipments WHERE colony_id = ? AND arrives_tick <= ?').all(c.id, tick)) {
    const down = s.dest === 'core';
    if (down && !coreInv) continue;
    const into = down ? coreInv : inv;
    into[s.resource_id] = (into[s.resource_id] || 0) + s.qty;
    db.prepare('DELETE FROM orbital_shipments WHERE id = ?').run(s.id);
    store.addEvent(c.id, tick, 'good', down ? `Express drop landed at the Core: ${s.qty} ${config.resources[s.resource_id].name}.` : `Express launch arrived in orbit: ${s.qty} ${config.resources[s.resource_id].name}.`);
  }
}

// ---- storage and link upgrades, jettison, rebuild ----------------------------------------
// `cost` may carry `credits` beside the goods; the goods come out of orbital storage and the credits out of the treasury.
function payFromStation(c, st, cost) {
  const { credits = 0, ...goods } = cost;
  const inv = store.loadInventory(c.id, st.district_id);
  const have = db.prepare('SELECT credits FROM colonies WHERE id = ?').get(c.id).credits;
  if (have < credits) return `Not enough credits: ${credits} cr needed.`;
  for (const [r, q] of Object.entries(goods)) if ((inv[r] || 0) < q) return `Not enough ${config.resources[r].name} in orbital storage (${q} needed).`;
  for (const [r, q] of Object.entries(goods)) inv[r] -= q;
  store.saveInventory(c.id, inv, st.district_id);
  if (credits) db.prepare('UPDATE colonies SET credits = credits - ? WHERE id = ?').run(credits, c.id);
  return null;
}

function upgradeStorage(c) {
  const st = stationOf(c.id);
  if (!st) return fail('There is no station.');
  const next = O.storage.levels[st.storage_level + 1];
  if (!next) return fail('Orbital storage is already at its largest.');
  const bad = payFromStation(c, st, next.cost);
  if (bad) return fail(bad);
  db.prepare('UPDATE stations SET storage_level = storage_level + 1 WHERE colony_id = ?').run(c.id);
  ensureSlots(c.id, next.slots);
  return OK;
}

function upgradeLinks(c) {
  const st = stationOf(c.id);
  if (!st) return fail('There is no station.');
  const next = O.links.levels[st.links_level + 1];
  if (!next) return fail('The station already has every link it can hold.');
  const bad = payFromStation(c, st, next.cost);
  if (bad) return fail(bad);
  db.prepare('UPDATE stations SET links_level = links_level + 1 WHERE colony_id = ?').run(c.id);
  return OK;
}

function jettison(c, { slot }) {
  const st = stationOf(c.id);
  if (!st) return fail('There is no station.');
  const idx = toInt(slot);
  const s = slots(c.id).find((x) => x.idx === idx);
  if (!s) return fail('No such storage slot.');
  if (s.state !== 'open') return fail('That slot is already gone.');
  if (s.resource) {
    const inv = store.loadInventory(c.id, st.district_id);
    inv[s.resource] = 0;
    store.saveInventory(c.id, inv, st.district_id);
    // routes moving that resource up or down stop with it
    db.prepare('DELETE FROM colony_routes WHERE colony_id = ? AND resource_id = ? AND (from_district = ? OR to_district = ?)').run(c.id, s.resource, st.district_id, st.district_id);
  }
  db.prepare("UPDATE orbital_slots SET resource_id = NULL, state = 'jettisoned' WHERE colony_id = ? AND idx = ?").run(c.id, idx);
  return OK;
}

function rebuildSlot(c, { slot }) {
  const st = stationOf(c.id);
  if (!st) return fail('There is no station.');
  const idx = toInt(slot);
  const s = slots(c.id).find((x) => x.idx === idx);
  if (!s) return fail('No such storage slot.');
  if (s.state !== 'jettisoned') return fail('That slot does not need rebuilding.');
  const bad = payFromStation(c, st, O.storage.rebuildCost);
  if (bad) return fail(bad);
  db.prepare("UPDATE orbital_slots SET state = 'open' WHERE colony_id = ? AND idx = ?").run(c.id, idx);
  return OK;
}

// ---- links between the Core and the station ---------------------------------------------
// Checked by actions.setRoute when either end is the station. Returns an error message or null.
function checkStationRoute(c, a, b, resource, rate, existingId) {
  const st = stationOf(c.id);
  if (!st) return 'There is no station.';
  const other = a.type === 'station' ? b : a;
  if (other.type !== 'core') return 'Orbital links only run between the Core and the station.';
  if (isRare(resource)) return 'Rare resources cannot travel on links. They come up by dropship.';
  const lv = linksLevel(st);
  if (rate > lv.rate) return `An orbital link carries at most ${lv.rate} per tick.`;
  const links = store.loadRoutes(c.id).filter((r) => (r.fromDistrict === st.district_id || r.toDistrict === st.district_id) && r.id !== existingId);
  const sameEnds = (r) => (r.fromDistrict === a.id && r.toDistrict === b.id && r.resource === resource);
  if (!links.some(sameEnds) && links.length >= lv.count) return `The station has ${lv.count} orbital links and they are all in use.`;
  if (a.type === 'core' && !hasRoomFor(c.id, resource)) return 'Orbital storage has no slot for that. Jettison a slot first.';
  return null;
}

// ---- the view ----------------------------------------------------------------------------
function view(c, tick, opts = {}) {
  const site = launchSite(c.id);
  const st = stationOf(c.id);
  const next = nextCycle(c.id);
  const stagingCycle = site.staging && site.staging.recipe ? site.staging.recipe : null;
  const out = {
    unlocked: !!c.orbital_unlocked,
    unlockStanding: O.unlockStanding,
    standing: standingTotal(c.id),
    flags: flagsOf(c),
    site: { staging: !!site.staging, catapult: !!site.catapult, command: !!site.command },
    launch: {
      next, loaded: stagingCycle, ready: c.launch_ready || null,
      progress: stagingCycle ? Math.floor(c.launch_progress || 0) : 0,
      ticks: stagingCycle ? O.launch.cycles[stagingCycle].ticks : next ? O.launch.cycles[next].ticks : 0,
    },
    station: null,
  };
  if (!st) return out;
  const district = db.prepare('SELECT * FROM districts WHERE id = ?').get(st.district_id);
  const sl = storageLevel(st); const ll = linksLevel(st);
  const inv = store.loadInventory(c.id, st.district_id);
  out.station = {
    name: st.name, districtId: st.district_id, level: district.level, launchedTick: st.launched_tick,
    storage: {
      level: st.storage_level, cap: sl.cap, next: O.storage.levels[st.storage_level + 1] || null,
      slots: slots(c.id).map((s) => ({ ...s, amount: s.resource ? Math.floor(inv[s.resource] || 0) : 0 })),
    },
    links: {
      level: st.links_level, count: ll.count, rate: ll.rate, next: O.links.levels[st.links_level + 1] || null,
      list: store.loadRoutes(c.id).filter((r) => r.fromDistrict === st.district_id || r.toDistrict === st.district_id)
        .map((r) => ({ id: r.id, resource: r.resource, rate: r.rate, reserve: r.reserve, dir: r.toDistrict === st.district_id ? 'up' : 'down', flow: (opts.flows || {})[r.id] || 0 })),
    },
    express: {
      readyIn: Math.max(0, (c.express_launch_ready_tick || 0) - tick), maxQty: O.express.maxQty, fuelBase: O.express.fuelBase, fuelPerUnit: O.express.fuelPerUnit,
      travelTicks: O.express.travelTicks, cooldownTicks: O.express.cooldownTicks,
      drop: { cost: O.express.drop.cost, travelTicks: O.express.drop.travelTicks },
      inFlight: db.prepare('SELECT resource_id AS resource, qty, arrives_tick, dest FROM orbital_shipments WHERE colony_id = ?').all(c.id).map((s) => ({ resource: s.resource, qty: s.qty, dir: s.dest === 'core' ? 'down' : 'up', ticksLeft: Math.max(0, s.arrives_tick - tick) })),
    },
  };
  return out;
}

module.exports = {
  stationOf, standingTotal, setFlag, flagsOf, checkUnlock, slots, ensureSlots, enforceSlots, hasRoomFor, districtExtras,
  nextCycle, launchSite, advanceLaunch, loadCycle, checkName, launch, expressLaunch, expressCost, arrivals,
  upgradeStorage, upgradeLinks, jettison, rebuildSlot, checkStationRoute, payFromStation, isRare, view,
};
