'use strict';
// What a colony has unlocked at Headquarters (see hq.js), read by the parts of the game each unlock changes. Kept apart
// from hq.js so that orbital.js, territories.js and the logistics code can read it without requiring hq.js (which needs them).
//
//   orbitalLinks  extra links between the Core and the station
//   hcSlots       high-capacity orbital storage slots
//   dropships     extra dropship bays
//   l4            level-4 refits banked (a refit whose ship was no longer eligible when it finished)
//   routes        extra standing routes between districts
//   linkBoost     how many +amount boosts every district link has
//   stabilizers   one entry per stabilizer: the tick from which it can go out again
//   extraLinks    extra territory link kits
//   finders       stable territories found
//   discoveries   districts discovered
const store = require('./db');
const { db, config } = store;

const parse = (s) => { try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } };

function of(colonyId) {
  const row = db.prepare('SELECT perks FROM colony_hq WHERE colony_id = ?').get(colonyId);
  return row ? parse(row.perks) : {};
}
const count = (colonyId, key) => Number(of(colonyId)[key]) || 0;
function save(colonyId, perks) {
  db.prepare('UPDATE colony_hq SET perks = ? WHERE colony_id = ?').run(JSON.stringify(perks), colonyId);
}
function add(colonyId, key, n = 1) {
  const p = of(colonyId);
  p[key] = (Number(p[key]) || 0) + n;
  save(colonyId, p);
  return p[key];
}

const opt = (cat, key) => ((((config.hq || {}).categories || {})[cat] || {}).options || {})[key] || {};
// Extra capacity on every district link, per tick.
const linkBonus = (colonyId) => count(colonyId, 'linkBoost') * (opt('surface', 'linkBoost').amount || 0);
// The standing-route limit between districts.
const routeBonus = (colonyId) => count(colonyId, 'routes') * (opt('surface', 'route').amount || 1);
const maxRoutes = (colonyId) => config.logistics.maxRoutes + routeBonus(colonyId);
// A high-capacity slot holds this many times an ordinary one.
const hcMult = () => opt('station', 'hcSlot').capMult || 10;

// Stabilizers: how many there are, and which are ready to go out at `tick`.
const stabilizers = (colonyId) => (Array.isArray(of(colonyId).stabilizers) ? of(colonyId).stabilizers : []);
const stabilizerReady = (colonyId, tick) => stabilizers(colonyId).some((t) => t <= tick);
// Send one out: the first ready one goes on cooldown. Returns false when none is ready.
function useStabilizer(colonyId, tick) {
  const p = of(colonyId);
  const list = Array.isArray(p.stabilizers) ? p.stabilizers : [];
  const i = list.findIndex((t) => t <= tick);
  if (i < 0) return false;
  list[i] = tick + (opt('territory', 'stabilizer').cooldownTicks || 0);
  p.stabilizers = list;
  save(colonyId, p);
  return true;
}
// Territory link kits not out with a ship right now.
function freeLinkKits(colonyId) {
  const out = db.prepare("SELECT COALESCE(SUM(extra_links), 0) AS n FROM dropships WHERE colony_id = ? AND state IN ('deploying', 'deployed')").get(colonyId).n;
  return Math.max(0, count(colonyId, 'extraLinks') - out);
}

module.exports = { of, count, save, add, linkBonus, routeBonus, maxRoutes, hcMult, stabilizers, stabilizerReady, useStabilizer, freeLinkKits };
