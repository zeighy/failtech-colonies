'use strict';
// Orbit, part two: dropships and the anomalous territories.
//
// Territories are shared by every player. The server keeps at least `minAvailable` open and untaken, each with its own
// anomaly (which sets how long it lasts, how much the ship suffers there, and how rich the rare resource is) and its own
// four resources (two common, one district resource, one rare). When a player takes one, another appears a little later.
//
// A dropship flies down from the station carrying a construction kit and whatever was preloaded, and becomes the core of a
// small district (type 'territory') with five buildings: two rigs, a drill, a refinery and the anomaly tap. It flies home
// on request or when the anomaly closes the territory, carrying what the player chose (by default the rare and the district
// resource) up to its hold; everything else is lost. Late departures damage the ship, some anomalies damage it every tick,
// and leaving early destabilises the territory so it closes sooner for whoever comes next. A ship whose integrity runs out
// is lost, except the first time: then it limps home with its cargo gone.
const store = require('./db');
const ms = require('./marketsim');
const orbital = require('./orbital');
const perks = require('./perks');
const { own, toInt, toNum, isPlain } = require('./validate');
const { db, config } = store;
const O = config.orbital;
const T = O.territories;
const D = O.dropships;

const fail = (error) => ({ ok: false, error });
const OK = { ok: true };
const level = (ship) => D.levels[ship.level] || D.levels['1'];
const sum = (o) => Object.values(o || {}).reduce((n, v) => n + v, 0);
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };

// ---- the shared pool ------------------------------------------------------------------
function pick(r, list) { return list[Math.floor(r() * list.length) % list.length]; }
function pickWeighted(r, table) {
  const entries = Object.entries(table);
  let roll = r() * entries.reduce((n, [, a]) => n + a.weight, 0);
  for (const [k, a] of entries) { roll -= a.weight; if (roll <= 0) return k; }
  return entries[0][0];
}

// The rare resource is random, but evened out: it comes from whichever rares are least represented among the territories
// open right now. Pure chance would too often leave a rare missing for a long time (and a long-lived anomaly keeps a
// lucky streak on screen for days), which stalls a player who needs it. Every rare still comes up equally often overall.
function pickRare(r, tick) {
  const have = Object.fromEntries(T.rare.map((x) => [x, 0]));
  for (const t of openTerritories(tick)) { const k = parse(t.resources, {}).rare; if (k in have) have[k]++; }
  const least = Math.min(...Object.values(have));
  const pool = T.rare.filter((x) => have[x] === least);
  return pool[Math.floor(r() * pool.length) % pool.length];
}

function spawn(tick, seq) {
  const r = ms.rng(ms.hash(`territory:${tick}:${seq}:${db.prepare('SELECT COUNT(*) AS n FROM territories').get().n}`));
  const anomaly = pickWeighted(r, T.anomalies);
  const a = T.anomalies[anomaly];
  const dur = a.durationTicks[0] + Math.floor(r() * (a.durationTicks[1] - a.durationTicks[0] + 1));
  const commons = [...T.common];
  const common1 = commons.splice(Math.floor(r() * commons.length), 1)[0];
  const common2 = pick(r, commons);
  const resources = { common1, common2, district: pick(r, T.district), rare: pickRare(r, tick) };
  const n = db.prepare('SELECT COUNT(*) AS n FROM territories').get().n;
  const name = `${pick(r, T.names)} ${n + 1}`;
  const dataSite = r() < T.dataSite.chance ? 1 : 0; // a data site sits on top of whatever else the territory holds
  db.prepare('INSERT INTO territories (name, anomaly, resources, opens_tick, closes_tick, data_site) VALUES (?, ?, ?, ?, ?, ?)').run(name, anomaly, JSON.stringify(resources), tick, tick + dur, dataSite);
}

// The shared pool that keeps itself topped up: open, untaken, and neither stabilised (those stay open for a very long time
// and are counted apart) nor private to one station (from the stable territory finder).
const openTerritories = (tick) => db.prepare('SELECT * FROM territories WHERE closes_tick > ? AND taken_by IS NULL AND stabilized = 0 AND owner_colony IS NULL ORDER BY closes_tick').all(tick);

// Once per tick, before any colony: close expired territories (sending their ships home late), spawn replacements.
function advanceWorld(tick) {
  // (a stabilised territory can have ships from several stations on it)
  for (const ship of db.prepare("SELECT s.* FROM dropships s JOIN territories t ON t.id = s.territory_id WHERE s.state IN ('deploying', 'deployed') AND t.closes_tick <= ?").all(tick)) {
    const c = db.prepare('SELECT * FROM colonies WHERE id = ?').get(ship.colony_id);
    if (c) recall(c, ship, tick, { late: true });
  }
  db.prepare('UPDATE territories SET taken_by = NULL, taken_name = NULL WHERE closes_tick <= ? AND taken_by IS NOT NULL').run(tick);
  // keep old closed territories out of the way
  if (tick % 100 === 0) db.prepare('DELETE FROM territories WHERE closes_tick <= ? AND taken_by IS NULL').run(tick - 2000);
  const due = parse(store.getMeta('territory_respawn', '[]'), []);
  const later = due.filter((t) => t > tick);
  let seq = 0;
  for (let i = 0; i < due.length - later.length; i++) spawn(tick, seq++);
  if (later.length !== due.length) store.setMeta('territory_respawn', JSON.stringify(later));
  for (let k = openTerritories(tick).length; k < T.minAvailable; k++) spawn(tick, seq++);
}

// ---- ships ----------------------------------------------------------------------------
const shipsOf = (colonyId) => db.prepare('SELECT * FROM dropships WHERE colony_id = ? ORDER BY num').all(colonyId);
const shipOf = (c, id) => db.prepare('SELECT * FROM dropships WHERE id = ? AND colony_id = ?').get(toInt(id), c.id);

// `stabilize`: take a ready stabilizer along (Headquarters). `links`: how many extra link kits go with the ship.
function deploy(c, { ship, territory, preload, stabilize, links }, tick) {
  const st = orbital.stationOf(c.id);
  if (!st) return fail('There is no station.');
  const s = shipOf(c, ship);
  if (!s) return fail('No such dropship.');
  if (s.state !== 'docked') return fail('That dropship is not docked at the station.');
  if (s.integrity <= 0) return fail('That dropship needs repairs first.');
  const t = db.prepare('SELECT * FROM territories WHERE id = ?').get(toInt(territory));
  if (!t || t.closes_tick <= tick || (t.owner_colony && t.owner_colony !== c.id)) return fail('That territory has closed.');
  // a stabilised territory takes any number of stations, one ship each; a private one is its finder's alone
  if (db.prepare("SELECT 1 FROM dropships WHERE colony_id = ? AND territory_id = ? AND state IN ('deploying', 'deployed')").get(c.id, t.id)) return fail('One of your dropships is already down there.');
  if (t.taken_by && !t.stabilized && !t.owner_colony) return fail(`${t.taken_name || 'Another station'} is already down there.`);
  if (t.closes_tick <= tick + D.deployTicks) return fail('It will close before the ship could land.');
  const kits = links === undefined || links === null || links === '' ? 0 : toInt(links);
  if (!Number.isInteger(kits) || kits < 0) return fail('Bad number of link kits.');
  if (kits > perks.freeLinkKits(c.id)) return fail('Not that many territory link kits are free.');
  if (stabilize === true) {
    if (t.stabilized) return fail('That territory is already stabilised.');
    if (t.owner_colony) return fail('A stable territory needs no stabilizer.');
    if (!perks.stabilizers(c.id).length) return fail('You have no territory stabilizer.');
    if (!perks.stabilizerReady(c.id, tick)) return fail('Your territory stabilizers are still cooling down.');
  }
  const load = {};
  if (preload !== undefined && !isPlain(preload)) return fail('Bad preload.');
  for (const [r, q0] of Object.entries(preload || {})) {
    if (!own(config.resources, r)) return fail('Unknown resource.');
    const q = Math.floor(toNum(q0));
    if (!Number.isFinite(q) || q < 0) return fail('Bad quantity.');
    if (q > 0) load[r] = q;
  }
  if (sum(load) > level(s).hold) return fail(`The hold carries ${level(s).hold} in all.`);
  const inv = store.loadInventory(c.id, st.district_id);
  for (const [r, q] of Object.entries(load)) if ((inv[r] || 0) < q) return fail(`Not enough ${config.resources[r].name} in orbital storage.`);
  for (const [r, q] of Object.entries(load)) inv[r] -= q;
  store.saveInventory(c.id, inv, st.district_id);
  if (stabilize === true) perks.useStabilizer(c.id, tick); // it goes with the ship, and its cooldown starts now
  db.prepare("UPDATE dropships SET state = 'deploying', territory_id = ?, until_tick = ?, cargo = ?, plan = NULL, late = 0, stabilizer = ?, extra_links = ? WHERE id = ?")
    .run(t.id, tick + D.deployTicks, JSON.stringify(load), stabilize === true ? 1 : 0, kits, s.id);
  const wasOpen = !t.taken_by && !t.stabilized && !t.owner_colony;
  if (!t.taken_by) db.prepare('UPDATE territories SET taken_by = ?, taken_name = ? WHERE id = ?').run(c.id, st.name, t.id);
  if (!wasOpen) return OK;
  // another territory opens a little later, so a busy server never runs dry
  const r = ms.rng(ms.hash(`respawn:${t.id}:${tick}`));
  const due = parse(store.getMeta('territory_respawn', '[]'), []);
  due.push(tick + T.respawnTicks[0] + Math.floor(r() * (T.respawnTicks[1] - T.respawnTicks[0] + 1)));
  store.setMeta('territory_respawn', JSON.stringify(due));
  return OK;
}

// What comes home when nothing was chosen: the rare resource and the district resource.
const defaultPlan = (res) => ({ [res.rare]: true, [res.district]: true });

function setPlan(c, { ship, plan }) {
  const s = shipOf(c, ship);
  if (!s) return fail('No such dropship.');
  if (!isPlain(plan)) return fail('Bad plan.');
  const out = {};
  for (const [r, on] of Object.entries(plan)) { if (!own(config.resources, r)) return fail('Unknown resource.'); if (on === true) out[r] = true; }
  db.prepare('UPDATE dropships SET plan = ? WHERE id = ?').run(JSON.stringify(out), s.id);
  return OK;
}

// Fly a ship home from its territory. `late`: the anomaly closed it first. Called by the player (early) or by the world.
function recall(c, s, tick, { late = false } = {}) {
  const t = db.prepare('SELECT * FROM territories WHERE id = ?').get(s.territory_id);
  const res = t ? JSON.parse(t.resources) : {};
  const an = t ? orbital.anomalyOf(t) : null;
  let cargo = {};
  if (s.state === 'deployed' && s.district_id) {
    const inv = store.loadInventory(c.id, s.district_id);
    const plan = parse(s.plan, null) || defaultPlan(res);
    // rare first, then the district resource, then anything else chosen, up to the hold
    const order = Object.keys(plan).sort((a, b) => (b === res.rare) - (a === res.rare) || (b === res.district) - (a === res.district));
    let room = level(s).hold;
    for (const r of order) {
      const q = Math.min(Math.floor(inv[r] || 0), room);
      if (q > 0) { cargo[r] = q; room -= q; }
    }
    db.prepare('DELETE FROM districts WHERE id = ?').run(s.district_id);
  } else {
    cargo = parse(s.cargo, {}); // still on the way down: the preload comes back
  }
  let integrity = s.integrity - (late && an ? an.lateDamage : 0);
  let note = late ? `The territory closed with the dropship still down there. It took ${an ? an.lateDamage : 0}% damage leaving.` : 'The dropship is on its way back to the station.';
  if (integrity <= 0) {
    if (level(s).unbreakable) { // a Headquarters refit: it always makes it home, without its cargo
      integrity = D.savedIntegrity;
      cargo = {};
      note = 'The dropship barely made it off the ground and its cargo is gone, but its refit frame held. It is on its way home.';
    } else if (!s.saved_once) {
      integrity = D.savedIntegrity;
      cargo = {};
      db.prepare('UPDATE dropships SET saved_once = 1 WHERE id = ?').run(s.id);
      orbital.setFlag(c.id, 'shipSaved', tick);
      note = 'The dropship barely made it off the ground. Its cargo is gone, and next time it may not be so lucky.';
    } else {
      db.prepare('DELETE FROM dropships WHERE id = ?').run(s.id);
      orbital.setFlag(c.id, 'shipLost', tick);
      store.addEvent(c.id, tick, 'bad', 'A dropship broke up leaving the territory. It is lost, with everything it carried.');
      if (t) releaseTerritory(t, tick, late, c.id);
      return;
    }
  }
  // (link kits come home with the ship: they are free again from now)
  db.prepare("UPDATE dropships SET state = 'returning', until_tick = ?, cargo = ?, district_id = NULL, territory_id = NULL, integrity = ?, late = ?, stabilizer = 0, extra_links = 0 WHERE id = ?")
    .run(tick + D.returnTicks, JSON.stringify(cargo), integrity, late ? 1 : 0, s.id);
  store.addEvent(c.id, tick, late ? 'warn' : 'info', note);
  if (t) releaseTerritory(t, tick, late, c.id);
}

// A territory a ship has left is open to others again, but the departure destabilises it: it closes much sooner.
// A stabilised territory never destabilises (and keeps whoever else is down there), and nor does a private stable one.
function releaseTerritory(t, tick, late, colonyId) {
  if (t.stabilized || t.owner_colony) {
    const other = db.prepare("SELECT s.colony_id FROM dropships s WHERE s.territory_id = ? AND s.state IN ('deploying', 'deployed') AND s.colony_id != ? LIMIT 1").get(t.id, colonyId);
    const st = other && orbital.stationOf(other.colony_id);
    db.prepare('UPDATE territories SET taken_by = ?, taken_name = ? WHERE id = ?').run(other ? other.colony_id : null, st ? st.name : null, t.id);
    return;
  }
  if (late || t.closes_tick <= tick) { db.prepare('UPDATE territories SET taken_by = NULL, taken_name = NULL WHERE id = ?').run(t.id); return; }
  const left = t.closes_tick - tick;
  db.prepare('UPDATE territories SET taken_by = NULL, taken_name = NULL, closes_tick = ?, destabilized = 1 WHERE id = ?').run(tick + Math.max(1, Math.floor(left * T.destabilize)), t.id);
}

function returnShip(c, { ship }, tick) {
  const s = shipOf(c, ship);
  if (!s) return fail('No such dropship.');
  if (s.state !== 'deployed' && s.state !== 'deploying') return fail('That dropship is not in a territory.');
  recall(c, s, tick, { late: false });
  return OK;
}

// Per colony, every tick: landings, damage while deployed, ships arriving home, ships finished building. `stationInv` is the
// station stockpile from this tick's simulation (mutated; slots are enforced after).
function advanceColony(c, stationInv, tick) {
  for (const s of shipsOf(c.id)) {
    if (s.state === 'deploying' && s.until_tick <= tick) {
      const t = db.prepare('SELECT * FROM territories WHERE id = ?').get(s.territory_id);
      if (!t || t.closes_tick <= tick) { recall(c, s, tick, { late: false }); continue; }
      const did = Number(db.prepare("INSERT INTO districts (colony_id, type, level, name, created_tick, territory_id) VALUES (?, 'territory', 1, ?, ?, ?)").run(c.id, t.name, tick, t.id).lastInsertRowid);
      const inv = {};
      for (const r of Object.keys(config.resources)) inv[r] = 0;
      for (const [r, q] of Object.entries(D.starterKit)) inv[r] += q;
      for (const [r, q] of Object.entries(parse(s.cargo, {}))) inv[r] = (inv[r] || 0) + q;
      store.saveInventory(c.id, inv, did);
      db.prepare("UPDATE dropships SET state = 'deployed', district_id = ?, cargo = '{}' WHERE id = ?").run(did, s.id);
      orbital.setFlag(c.id, 'deployed', tick);
      store.addEvent(c.id, tick, 'good', `The dropship has landed in ${t.name}.`);
      if (s.stabilizer && !t.stabilized) stabilizeTerritory(c, t, tick);
    } else if (s.state === 'deployed') {
      const t = db.prepare('SELECT * FROM territories WHERE id = ?').get(s.territory_id);
      const an = t && orbital.anomalyOf(t);
      if (an && an.damagePerTick > 0) {
        const integrity = s.integrity - an.damagePerTick;
        db.prepare('UPDATE dropships SET integrity = ? WHERE id = ?').run(integrity, s.id);
        if (integrity <= 0) recall(c, { ...s, integrity }, tick, { late: false });
      }
    } else if (s.state === 'returning' && s.until_tick <= tick) {
      const cargo = parse(s.cargo, {});
      let rare = false;
      for (const [r, q] of Object.entries(cargo)) { if (stationInv) stationInv[r] = (stationInv[r] || 0) + q; if (orbital.isRare(r) && q > 0) rare = true; }
      db.prepare("UPDATE dropships SET state = 'docked', cargo = '{}', until_tick = 0 WHERE id = ?").run(s.id);
      if (rare) orbital.setFlag(c.id, 'rareReturned', tick);
      const what = Object.entries(cargo).map(([r, q]) => `${q} ${config.resources[r].name}`).join(', ');
      store.addEvent(c.id, tick, 'good', `A dropship is back at the station${what ? `, carrying ${what}` : ''}.`);
    } else if (s.state === 'building' && s.until_tick <= tick) {
      db.prepare("UPDATE dropships SET state = 'docked', until_tick = 0 WHERE id = ?").run(s.id);
      store.addEvent(c.id, tick, 'good', `Dropship ${s.num} is ready.`);
    }
  }
}

// A stabilizer lands: the territory's remaining time is multiplied, its harm stops (orbital.anomalyOf), and from now on any
// station may land there, and leaving never destabilises it.
function stabilizeTerritory(c, t, tick) {
  const mult = ((((config.hq || {}).categories || {}).territory || {}).options || {}).stabilizer;
  const left = Math.max(1, t.closes_tick - tick);
  db.prepare('UPDATE territories SET stabilized = 1, destabilized = 0, closes_tick = ? WHERE id = ?').run(tick + left * ((mult && mult.durationMult) || 100), t.id);
  store.addEvent(c.id, tick, 'good', `The stabilizer is running in ${t.name}. It will stay open far longer, its anomaly has stopped doing harm, and other stations can land there too.`);
}

// ---- stable territories (the stable territory finder) ----------------------------------------
// Which rares can the anomaly tap extract on ground holding these resources? The field buildings make what they can from
// what the territory holds (and from what they make), and a tap recipe works when both its inputs can be had.
function extractable(held) {
  const fits = Object.values(config.buildings).filter((b) => b.territory && b.territory.needs).map((b) => ({ ...b, ...b.territory }));
  const have = new Set(held);
  for (let again = true; again;) {
    again = false;
    for (const b of fits) {
      if (!held.includes(b.needs)) continue;
      if (!Object.keys(b.inputsPerTick).filter((r) => r !== 'energy').every((r) => have.has(r))) continue;
      for (const r of Object.keys(b.outputsPerTick)) if (!have.has(r)) { have.add(r); again = true; }
    }
  }
  return T.rare.filter((rare) => Object.values(config.tapRecipes).some((r) => r.rare === rare && Object.keys(r.inputsPerTick).filter((k) => k !== 'energy').every((k) => have.has(k))));
}
// The average lifetime of a territory, over every anomaly by how often it comes up.
function meanLifetime() {
  let w = 0; let sum = 0;
  for (const a of Object.values(T.anomalies)) { if (!a.weight) continue; w += a.weight; sum += a.weight * (a.durationTicks[0] + a.durationTicks[1]) / 2; }
  return w ? sum / w : 0;
}
// A territory only this colony can see and land on: a random rare, on ground that can extract it, open for a very long time.
function spawnPrivate(c, tick, durationMult) {
  const r = ms.rng(ms.hash(`stable:${c.id}:${tick}:${db.prepare('SELECT COUNT(*) AS n FROM territories').get().n}`));
  const rare = pick(r, T.rare);
  const grounds = [[0, 1], [0, 2], [1, 2]].flatMap(([a, b]) => T.district.map((d) => [T.common[a], T.common[b], d])).filter((g) => extractable(g).includes(rare));
  const [common1, common2, district] = grounds.length ? pick(r, grounds) : [T.common[0], T.common[1], T.district[0]];
  const n = db.prepare('SELECT COUNT(*) AS n FROM territories').get().n;
  const name = `${pick(r, T.names)} ${n + 1}`;
  const id = Number(db.prepare("INSERT INTO territories (name, anomaly, resources, opens_tick, closes_tick, data_site, owner_colony) VALUES (?, 'stable', ?, ?, ?, 0, ?)")
    .run(name, JSON.stringify({ common1, common2, district, rare }), tick, tick + Math.round(meanLifetime() * durationMult), c.id).lastInsertRowid);
  return { id, name, rare };
}

// ---- building, upgrading, repairing ----------------------------------------------------------
const maxShips = (colonyId) => D.max + perks.count(colonyId, 'dropships');
function buildShip(c, tick) {
  const st = orbital.stationOf(c.id);
  if (!st) return fail('There is no station.');
  const ships = shipsOf(c.id);
  if (ships.length >= maxShips(c.id)) return fail(`A station supports at most ${maxShips(c.id)} dropships.`);
  const bad = orbital.payFromStation(c, st, D.buildCost);
  if (bad) return fail(bad);
  let num = 1; while (ships.some((s) => s.num === num)) num++;
  db.prepare("INSERT INTO dropships (colony_id, num, level, integrity, state, until_tick, invested) VALUES (?, ?, 1, 100, 'building', ?, ?)").run(c.id, num, tick + D.buildTicks, JSON.stringify(Object.fromEntries(Object.entries(D.buildCost).filter(([r]) => r !== 'credits'))));
  return OK;
}

function upgradeShip(c, { ship }) {
  const st = orbital.stationOf(c.id);
  const s = shipOf(c, ship);
  if (!st || !s) return fail('No such dropship.');
  if (s.state !== 'docked') return fail('A dropship can only be upgraded while docked at the station.');
  const next = D.levels[s.level + 1];
  if (!next || next.hqOnly) return fail('That dropship is fully upgraded.');
  const bad = orbital.payFromStation(c, st, next.cost);
  if (bad) return fail(bad);
  const inv = parse(s.invested, {});
  for (const [r, q] of Object.entries(next.cost)) if (r !== 'credits') inv[r] = (inv[r] || 0) + q; // credits are not part of what a repair is worth
  db.prepare('UPDATE dropships SET level = level + 1, invested = ? WHERE id = ?').run(JSON.stringify(inv), s.id);
  return OK;
}

// Repairs cost the damaged share of everything ever put into the ship (its build and its upgrades).
function repairCost(s) {
  const dmg = Math.max(0, 100 - s.integrity) / 100;
  return Object.fromEntries(Object.entries(parse(s.invested, {})).map(([r, q]) => [r, Math.ceil(q * dmg)]).filter(([, q]) => q > 0));
}
function repairShip(c, { ship }) {
  const st = orbital.stationOf(c.id);
  const s = shipOf(c, ship);
  if (!st || !s) return fail('No such dropship.');
  if (s.state !== 'docked') return fail('A dropship can only be repaired while docked at the station.');
  if (s.integrity >= 100) return fail('That dropship is undamaged.');
  const bad = orbital.payFromStation(c, st, repairCost(s));
  if (bad) return fail(bad);
  db.prepare('UPDATE dropships SET integrity = 100 WHERE id = ?').run(s.id);
  return OK;
}

// ---- building in a territory -------------------------------------------------------------------
// What a territory holds: its two common resources, its district resource and its rare one (null outside a territory).
function fieldOf(districtId) {
  const row = db.prepare('SELECT t.resources FROM districts d JOIN territories t ON t.id = d.territory_id WHERE d.id = ?').get(districtId);
  return row ? JSON.parse(row.resources) : null;
}
// A field version of a ground building only makes sense where the territory holds what it works on.
function checkBuild(d, def) {
  if (def.dataRecovery) {
    const row = db.prepare('SELECT t.data_site FROM districts d JOIN territories t ON t.id = d.territory_id WHERE d.id = ?').get(d.id);
    if (!row || !row.data_site) return `${def.name} needs a data site, and ${d.name} has none.`;
    const queued = store.loadOrders(d.colony_id, d.id).some((o) => o.action_type === 'build' && o.data.type === 't_data');
    if (queued || db.prepare('SELECT 1 FROM colony_buildings WHERE district_id = ? AND building_type = ?').get(d.id, 't_data')) return `There is already a ${def.name} here.`;
    return null;
  }
  const need = def.territory && def.territory.needs;
  if (!need) return null;
  const f = fieldOf(d.id);
  return f && [f.common1, f.common2, f.district].includes(need) ? null : `${def.name} has nothing to work on in ${d.name}.`;
}
// The Anomaly Tap only draws this territory's own rare resource.
function checkRecipe(d, recipeId) {
  const f = fieldOf(d.id);
  const rec = config.tapRecipes[recipeId];
  return f && rec && rec.rare === f.rare ? null : 'That recipe does not draw anything from this anomaly.';
}

// ---- links between a territory and the station ------------------------------------------------
function checkTerritoryRoute(c, a, b, resource, rate, existingId) {
  const terr = a.type === 'territory' ? a : b;
  const other = a.type === 'territory' ? b : a;
  if (other.type !== 'station') return 'A territory links only to the station.';
  if (orbital.isRare(resource)) return 'Rare resources cannot travel on links. They come up by dropship.';
  const ship = db.prepare('SELECT * FROM dropships WHERE district_id = ?').get(terr.id);
  if (!ship) return 'There is no dropship in that territory.';
  if (rate > level(ship).linkRate) return `This dropship's links carry at most ${level(ship).linkRate} per tick.`;
  const links = store.loadRoutes(c.id).filter((r) => (r.fromDistrict === terr.id || r.toDistrict === terr.id) && r.id !== existingId);
  const most = D.maxLinks + (ship.extra_links || 0);
  if (!links.some((r) => r.fromDistrict === a.id && r.toDistrict === b.id && r.resource === resource) && links.length >= most) return `This territory has ${most} links and they are all in use.`;
  if (other.type === 'station' && b.type === 'station' && !orbital.hasRoomFor(c.id, resource)) return 'Orbital storage has no slot for that. Jettison a slot first.';
  return null;
}

// ---- the view ------------------------------------------------------------------------------
function view(c, tick) {
  const st = orbital.stationOf(c.id);
  const mineThere = new Set(db.prepare("SELECT territory_id FROM dropships WHERE colony_id = ? AND state IN ('deploying', 'deployed')").all(c.id).map((x) => x.territory_id));
  // (another station's private territory is never shown; a stabilised one shows its anomaly as it now behaves there)
  const list = db.prepare('SELECT * FROM territories WHERE closes_tick > ? AND (owner_colony IS NULL OR owner_colony = ?) ORDER BY closes_tick').all(tick, c.id).map((t) => ({
    id: t.id, name: t.name, anomaly: { key: t.anomaly, ...orbital.anomalyOf(t) }, resources: JSON.parse(t.resources), ticksLeft: t.closes_tick - tick,
    taken: t.taken_by || mineThere.has(t.id) ? { mine: mineThere.has(t.id), station: t.taken_name } : null, destabilized: !!t.destabilized, dataSite: !!t.data_site,
    stabilized: !!t.stabilized, private: !!t.owner_colony,
    // can one of this station's ships land there now? (an untaken one, a stabilised one, or its own private one)
    open: !mineThere.has(t.id) && (!t.taken_by || !!t.stabilized || !!t.owner_colony),
  }));
  const stab = perks.stabilizers(c.id);
  return {
    max: maxShips(c.id), buildCost: D.buildCost, buildTicks: D.buildTicks, levels: D.levels, deployTicks: D.deployTicks, returnTicks: D.returnTicks,
    contributeTicks: D.contributeTicks, maxLinks: D.maxLinks, starterKit: D.starterKit,
    // Headquarters equipment: stabilizers (and when each is ready again) and territory link kits
    stabilizers: stab.map((t) => Math.max(0, t - tick)), stabilizerCooldown: ((((config.hq || {}).categories || {}).territory || {}).options || {}).stabilizer ? config.hq.categories.territory.options.stabilizer.cooldownTicks : 0, linkKits: perks.count(c.id, 'extraLinks'), linkKitsFree: perks.freeLinkKits(c.id), l4Banked: perks.count(c.id, 'l4'),
    ships: st ? shipsOf(c.id).map((s) => {
      const t = s.territory_id ? list.find((x) => x.id === s.territory_id) || null : null;
      return {
        id: s.id, num: s.num, level: s.level, integrity: Math.max(0, Math.round(s.integrity * 10) / 10), state: s.state,
        ticksLeft: s.until_tick ? Math.max(0, s.until_tick - tick) : 0, districtId: s.district_id, territory: t,
        cargo: parse(s.cargo, {}), plan: parse(s.plan, null) || (t ? defaultPlan(t.resources) : null),
        hold: level(s).hold, power: level(s).power, linkRate: level(s).linkRate, savedOnce: !!s.saved_once, unbreakable: !!level(s).unbreakable,
        maxLinks: D.maxLinks + (s.extra_links || 0), extraLinks: s.extra_links || 0, stabilizer: !!s.stabilizer,
        repairCost: s.integrity < 100 ? repairCost(s) : null, next: D.levels[s.level + 1] && !D.levels[s.level + 1].hqOnly ? D.levels[s.level + 1] : null,
      };
    }) : [],
    territories: list,
  };
}

// ---- data sites ---------------------------------------------------------------------------
// A Data Recovery building runs attempts of `attemptTicks`, advancing by its efficiency each tick (so low power slows it).
// Each finished attempt succeeds with `successChance`; `attemptsPerFragment` successes make one fragment, which the colony
// keeps as a currency for unlocking data packets (lore). Nothing here touches the simulation.
function advanceData(c, results, tick) {
  const DS = T.dataSite;
  for (const r of results) {
    if (r.type !== 'territory') continue;
    for (const b of store.loadBuildings(c.id, r.id)) {
      if (b.type !== 't_data' || b.status !== 'active') continue;
      const st = r.buildings && r.buildings.get ? r.buildings.get(b.id) : null;
      const eff = st ? Math.max(0, Math.min(1, st.eff)) : 0;
      if (eff <= 0) continue;
      let prog = (b.dataProgress || 0) + eff;
      while (prog >= DS.attemptTicks - 1e-9) {
        prog -= DS.attemptTicks;
        const roll = ms.rng(ms.hash(`data:${c.id}:${b.id}:${tick}:${Math.round(prog * 100)}`))();
        if (roll >= DS.successChance) continue;
        addDataSuccess(c, tick);
      }
      db.prepare('UPDATE colony_buildings SET data_progress = ? WHERE id = ?').run(prog, b.id);
    }
  }
}

// One successful attempt toward the next fragment, from a rig or from trace recovery (minigames.js). `found` names it in the log.
function addDataSuccess(c, tick, found = 'A recovery attempt found something') {
  const DS = T.dataSite;
  const wins = db.prepare('SELECT data_successes FROM colonies WHERE id = ?').get(c.id).data_successes + 1;
  if (wins >= DS.attemptsPerFragment) {
    db.prepare('UPDATE colonies SET data_successes = 0, data_fragments = data_fragments + 1, data_total = data_total + 1 WHERE id = ?').run(c.id);
    store.addEvent(c.id, tick, 'good', 'A data fragment has been recovered.');
    orbital.setFlag(c.id, 'dataFragment', tick);
    return { wins: DS.attemptsPerFragment, of: DS.attemptsPerFragment, fragment: true };
  }
  db.prepare('UPDATE colonies SET data_successes = ? WHERE id = ?').run(wins, c.id);
  store.addEvent(c.id, tick, 'info', `${found} (${wins} of ${DS.attemptsPerFragment} toward a fragment).`);
  return { wins, of: DS.attemptsPerFragment, fragment: false };
}

// A packet unlocks in parts. Part 1 costs fragments; later parts cost fragments and a few orbital goods from the station, so
// reading everything takes expeditions and the foundry as well as data sites. A sealed part shows only its cost.
const packetParts = (p) => p.costs.length;
const partText = (p, i) => p[i === 0 ? 'text' : `text${i + 1}`];

function dataView(c) {
  const row = db.prepare('SELECT data_fragments, data_successes, data_total FROM colonies WHERE id = ?').get(c.id);
  const lv = Object.fromEntries(db.prepare('SELECT packet_id, level FROM colony_data_packets WHERE colony_id = ?').all(c.id).map((x) => [x.packet_id, x.level]));
  const DS = T.dataSite;
  return {
    unlocked: row.data_total > 0, fragments: row.data_fragments, total: row.data_total, successes: row.data_successes,
    perFragment: DS.attemptsPerFragment, attemptTicks: DS.attemptTicks, successChance: DS.successChance,
    packets: Object.entries(config.orbital.data.packets).map(([id, p]) => {
      const level = lv[id] || 0;
      const next = level < packetParts(p) ? { part: level + 1, ...p.costs[level] } : null;
      if (!level) return { id, level, next };                      // sealed: only what part 1 costs
      // `scenes[i]` is the id of a story beat that plays part i as a scene, or null when it is only text
      const story = require('./story');
      return { id, level, of: packetParts(p), name: p.name, texts: Array.from({ length: level }, (_, i) => partText(p, i) || ''), scenes: Array.from({ length: level }, (_, i) => (story.packetScene(id, i + 1) ? story.packetBeat(id, i + 1) : null)), next };
    }),
  };
}

function unlockPacket(c, { packet }) {
  const p = Object.prototype.hasOwnProperty.call(config.orbital.data.packets, packet) ? config.orbital.data.packets[packet] : null;
  if (!p) return fail('Unknown data packet.');
  const row = db.prepare('SELECT level FROM colony_data_packets WHERE colony_id = ? AND packet_id = ?').get(c.id, packet);
  const level = row ? row.level : 0;
  if (level >= packetParts(p)) return fail('You have already unlocked all of that packet.');
  const cost = p.costs[level];
  const have = db.prepare('SELECT data_fragments FROM colonies WHERE id = ?').get(c.id).data_fragments;
  if (have < cost.fragments) return fail(`That costs ${cost.fragments} data fragment${cost.fragments === 1 ? '' : 's'}.`);
  const goods = cost.goods || {};
  let inv = null; let did = null;
  if (Object.keys(goods).length) {
    const st = orbital.stationOf(c.id);
    if (!st) return fail('The goods for this part are paid from orbital storage, and there is no station.');
    did = st.district_id; inv = store.loadInventory(c.id, did);
    for (const [r, q] of Object.entries(goods)) if ((inv[r] || 0) < q) return fail(`Not enough ${config.resources[r].name} in orbital storage: ${q} needed.`);
  }
  db.prepare('UPDATE colonies SET data_fragments = data_fragments - ? WHERE id = ?').run(cost.fragments, c.id);
  if (inv) { for (const [r, q] of Object.entries(goods)) inv[r] -= q; store.saveInventory(c.id, inv, did); }
  db.prepare('INSERT INTO colony_data_packets (colony_id, packet_id, level) VALUES (?, ?, 1) ON CONFLICT (colony_id, packet_id) DO UPDATE SET level = level + 1').run(c.id, packet);
  return OK;
}

module.exports = { advanceWorld, advanceColony, advanceData, addDataSuccess, dataView, unlockPacket, spawn, spawnPrivate, extractable, meanLifetime, deploy, setPlan, returnShip, recall, buildShip, upgradeShip, repairShip, repairCost, checkTerritoryRoute, checkBuild, checkRecipe, view, shipsOf, maxShips };
