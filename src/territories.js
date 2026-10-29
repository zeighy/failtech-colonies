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

const openTerritories = (tick) => db.prepare('SELECT * FROM territories WHERE closes_tick > ? AND taken_by IS NULL ORDER BY closes_tick').all(tick);

// Once per tick, before any colony: close expired territories (sending their ships home late), spawn replacements.
function advanceWorld(tick) {
  for (const t of db.prepare('SELECT * FROM territories WHERE closes_tick <= ? AND taken_by IS NOT NULL').all(tick)) {
    const ship = db.prepare("SELECT * FROM dropships WHERE territory_id = ? AND state IN ('deploying', 'deployed')").get(t.id);
    const c = ship && db.prepare('SELECT * FROM colonies WHERE id = ?').get(ship.colony_id);
    if (ship && c) recall(c, ship, tick, { late: true });
    db.prepare('UPDATE territories SET taken_by = NULL, taken_name = NULL WHERE id = ?').run(t.id);
  }
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

function deploy(c, { ship, territory, preload }, tick) {
  const st = orbital.stationOf(c.id);
  if (!st) return fail('There is no station.');
  const s = shipOf(c, ship);
  if (!s) return fail('No such dropship.');
  if (s.state !== 'docked') return fail('That dropship is not docked at the station.');
  if (s.integrity <= 0) return fail('That dropship needs repairs first.');
  const t = db.prepare('SELECT * FROM territories WHERE id = ?').get(toInt(territory));
  if (!t || t.closes_tick <= tick) return fail('That territory has closed.');
  if (t.taken_by) return fail(`${t.taken_name || 'Another station'} is already down there.`);
  if (t.closes_tick <= tick + D.deployTicks) return fail('It will close before the ship could land.');
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
  db.prepare("UPDATE dropships SET state = 'deploying', territory_id = ?, until_tick = ?, cargo = ?, plan = NULL, late = 0 WHERE id = ?").run(t.id, tick + D.deployTicks, JSON.stringify(load), s.id);
  db.prepare('UPDATE territories SET taken_by = ?, taken_name = ? WHERE id = ?').run(c.id, st.name, t.id);
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
  const an = t ? T.anomalies[t.anomaly] : null;
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
    if (!s.saved_once) {
      integrity = D.savedIntegrity;
      cargo = {};
      db.prepare('UPDATE dropships SET saved_once = 1 WHERE id = ?').run(s.id);
      orbital.setFlag(c.id, 'shipSaved', tick);
      note = 'The dropship barely made it off the ground. Its cargo is gone, and next time it may not be so lucky.';
    } else {
      db.prepare('DELETE FROM dropships WHERE id = ?').run(s.id);
      orbital.setFlag(c.id, 'shipLost', tick);
      store.addEvent(c.id, tick, 'bad', 'A dropship broke up leaving the territory. It is lost, with everything it carried.');
      if (t) releaseTerritory(t, tick, late);
      return;
    }
  }
  db.prepare("UPDATE dropships SET state = 'returning', until_tick = ?, cargo = ?, district_id = NULL, territory_id = NULL, integrity = ?, late = ? WHERE id = ?")
    .run(tick + D.returnTicks, JSON.stringify(cargo), integrity, late ? 1 : 0, s.id);
  store.addEvent(c.id, tick, late ? 'warn' : 'info', note);
  if (t) releaseTerritory(t, tick, late);
}

// A territory a ship has left is open to others again, but the departure destabilises it: it closes much sooner.
function releaseTerritory(t, tick, late) {
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
    } else if (s.state === 'deployed') {
      const t = db.prepare('SELECT * FROM territories WHERE id = ?').get(s.territory_id);
      const an = t && T.anomalies[t.anomaly];
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

// ---- building, upgrading, repairing ----------------------------------------------------------
function buildShip(c, tick) {
  const st = orbital.stationOf(c.id);
  if (!st) return fail('There is no station.');
  const ships = shipsOf(c.id);
  if (ships.length >= D.max) return fail(`A station supports at most ${D.max} dropships.`);
  const bad = orbital.payFromStation(c, st, D.buildCost);
  if (bad) return fail(bad);
  const num = [1, 2, 3, 4, 5, 6].find((n) => !ships.some((s) => s.num === n));
  db.prepare("INSERT INTO dropships (colony_id, num, level, integrity, state, until_tick, invested) VALUES (?, ?, 1, 100, 'building', ?, ?)").run(c.id, num, tick + D.buildTicks, JSON.stringify(D.buildCost));
  return OK;
}

function upgradeShip(c, { ship }) {
  const st = orbital.stationOf(c.id);
  const s = shipOf(c, ship);
  if (!st || !s) return fail('No such dropship.');
  if (s.state !== 'docked') return fail('A dropship can only be upgraded while docked at the station.');
  const next = D.levels[s.level + 1];
  if (!next) return fail('That dropship is fully upgraded.');
  const bad = orbital.payFromStation(c, st, next.cost);
  if (bad) return fail(bad);
  const inv = parse(s.invested, {});
  for (const [r, q] of Object.entries(next.cost)) inv[r] = (inv[r] || 0) + q;
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
  if (!links.some((r) => r.fromDistrict === a.id && r.toDistrict === b.id && r.resource === resource) && links.length >= D.maxLinks) return `A territory has ${D.maxLinks} links and they are both in use.`;
  if (other.type === 'station' && b.type === 'station' && !orbital.hasRoomFor(c.id, resource)) return 'Orbital storage has no slot for that. Jettison a slot first.';
  return null;
}

// ---- the view ------------------------------------------------------------------------------
function view(c, tick) {
  const st = orbital.stationOf(c.id);
  const anomaly = (k) => ({ key: k, ...T.anomalies[k] });
  const list = db.prepare('SELECT * FROM territories WHERE closes_tick > ? ORDER BY closes_tick').all(tick).map((t) => ({
    id: t.id, name: t.name, anomaly: anomaly(t.anomaly), resources: JSON.parse(t.resources), ticksLeft: t.closes_tick - tick,
    taken: t.taken_by ? { mine: t.taken_by === c.id, station: t.taken_name } : null, destabilized: !!t.destabilized, dataSite: !!t.data_site,
  }));
  return {
    max: D.max, buildCost: D.buildCost, buildTicks: D.buildTicks, levels: D.levels, deployTicks: D.deployTicks, returnTicks: D.returnTicks,
    contributeTicks: D.contributeTicks, maxLinks: D.maxLinks, starterKit: D.starterKit,
    ships: st ? shipsOf(c.id).map((s) => {
      const t = s.territory_id ? list.find((x) => x.id === s.territory_id) || null : null;
      return {
        id: s.id, num: s.num, level: s.level, integrity: Math.max(0, Math.round(s.integrity * 10) / 10), state: s.state,
        ticksLeft: s.until_tick ? Math.max(0, s.until_tick - tick) : 0, districtId: s.district_id, territory: t,
        cargo: parse(s.cargo, {}), plan: parse(s.plan, null) || (t ? defaultPlan(t.resources) : null),
        hold: level(s).hold, power: level(s).power, linkRate: level(s).linkRate, savedOnce: !!s.saved_once,
        repairCost: s.integrity < 100 ? repairCost(s) : null, next: D.levels[s.level + 1] || null,
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
        const row = db.prepare('SELECT data_successes FROM colonies WHERE id = ?').get(c.id);
        const wins = row.data_successes + 1;
        if (wins >= DS.attemptsPerFragment) {
          db.prepare('UPDATE colonies SET data_successes = 0, data_fragments = data_fragments + 1, data_total = data_total + 1 WHERE id = ?').run(c.id);
          store.addEvent(c.id, tick, 'good', 'A data fragment has been recovered.');
          orbital.setFlag(c.id, 'dataFragment', tick);
        } else {
          db.prepare('UPDATE colonies SET data_successes = ? WHERE id = ?').run(wins, c.id);
          store.addEvent(c.id, tick, 'info', `A recovery attempt found something (${wins} of ${DS.attemptsPerFragment} toward a fragment).`);
        }
      }
      db.prepare('UPDATE colony_buildings SET data_progress = ? WHERE id = ?').run(prog, b.id);
    }
  }
}

// The packets: cost and wording are public; the text only once unlocked.
function dataView(c) {
  const row = db.prepare('SELECT data_fragments, data_successes, data_total FROM colonies WHERE id = ?').get(c.id);
  const mine = new Set(db.prepare('SELECT packet_id FROM colony_data_packets WHERE colony_id = ?').all(c.id).map((x) => x.packet_id));
  const DS = T.dataSite;
  return {
    unlocked: row.data_total > 0, fragments: row.data_fragments, total: row.data_total, successes: row.data_successes,
    perFragment: DS.attemptsPerFragment, attemptTicks: DS.attemptTicks, successChance: DS.successChance,
    packets: Object.entries(config.orbital.data.packets).map(([id, p]) => ({ id, name: p.name, desc: p.desc, cost: p.cost, unlocked: mine.has(id), text: mine.has(id) ? p.text : null })),
  };
}

function unlockPacket(c, { packet }) {
  const p = Object.prototype.hasOwnProperty.call(config.orbital.data.packets, packet) ? config.orbital.data.packets[packet] : null;
  if (!p) return fail('Unknown data packet.');
  if (db.prepare('SELECT 1 FROM colony_data_packets WHERE colony_id = ? AND packet_id = ?').get(c.id, packet)) return fail('You already have that packet.');
  const row = db.prepare('SELECT data_fragments FROM colonies WHERE id = ?').get(c.id);
  if (row.data_fragments < p.cost) return fail(`That packet costs ${p.cost} data fragment${p.cost === 1 ? '' : 's'}.`);
  db.prepare('UPDATE colonies SET data_fragments = data_fragments - ? WHERE id = ?').run(p.cost, c.id);
  db.prepare('INSERT INTO colony_data_packets (colony_id, packet_id) VALUES (?, ?)').run(c.id, packet);
  return OK;
}

module.exports = { advanceWorld, advanceColony, advanceData, dataView, unlockPacket, spawn, deploy, setPlan, returnShip, recall, buildShip, upgradeShip, repairShip, repairCost, checkTerritoryRoute, checkBuild, checkRecipe, view, shipsOf };
