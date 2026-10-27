'use strict';
// Orbit, part four: global projects. One project at a time, shared by every player:
//   announced (the next project and when it starts) -> active (players contribute by dropship) ->
//   bonus (completed: a bonus for every player for half the contribution period) or failed -> the next is announced.
// Requirements scale with the number of active players with a station, so a small server can still finish one. The
// contribution period is twice the time it would take to make the per-player share at a reference rate.
const store = require('./db');
const ms = require('./marketsim');
const orbital = require('./orbital');
const { own, toInt, toNum, isPlain } = require('./validate');
const { db, config } = store;
const P = config.orbital.projects;
const D = config.orbital.dropships;

const fail = (error) => ({ ok: false, error });
const OK = { ok: true };
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };
const defOf = (key) => P.list.find((p) => p.key === key);
const current = () => db.prepare('SELECT * FROM global_projects ORDER BY id DESC LIMIT 1').get() || null;

function refRate(res) {
  const r = config.resources[res];
  return r.orbitalTrade ? P.refRate.orbital : r.rare ? P.refRate.rare : P.refRate.trade;
}

function announce(tick) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM global_projects').get().n;
  const def = P.list[n % P.list.length];
  db.prepare("INSERT INTO global_projects (key, status, announced_tick, starts_tick, ends_tick, needs) VALUES (?, 'announced', ?, ?, ?, '{}')").run(def.key, tick, tick + P.announceTicks, tick + P.announceTicks);
}

// Players who count towards the size of a project: colonies with a station seen since the previous project was announced.
function activePlayers(sinceTick, tick, tickTime, tickMs) {
  const since = tickTime - Math.max(1, tick - sinceTick) * tickMs;
  return Math.max(1, db.prepare('SELECT COUNT(*) AS n FROM stations s JOIN colonies c ON c.id = s.colony_id WHERE c.last_seen_at >= ?').get(since).n);
}

function start(p, tick, tickTime, tickMs) {
  const def = defOf(p.key);
  const prev = db.prepare('SELECT announced_tick FROM global_projects WHERE id < ? ORDER BY id DESC LIMIT 1').get(p.id);
  const players = activePlayers(prev ? prev.announced_tick : p.announced_tick, tick, tickTime, tickMs);
  const needs = Object.fromEntries(Object.entries(def.needs).map(([r, q]) => [r, q * players]));
  const make = Math.max(...Object.entries(def.needs).map(([r, q]) => q / refRate(r)));
  const period = Math.round(Math.min(P.maxPeriod, Math.max(P.minPeriod, 2 * make)));
  const r = ms.rng(ms.hash(`project:${p.id}:${tick}`));
  const drip = def.bonus.kind === 'drip' ? config.orbital.territories.rare[Math.floor(r() * config.orbital.territories.rare.length)] : null;
  db.prepare("UPDATE global_projects SET status = 'active', starts_tick = ?, ends_tick = ?, needs = ?, players = ?, drip_resource = ? WHERE id = ?")
    .run(tick, tick + period, JSON.stringify(needs), players, drip, p.id);
}

const everyStation = () => db.prepare('SELECT colony_id FROM stations').all().map((r) => r.colony_id);

// Once per tick, before any colony.
function advanceWorld(tick, tickTime = Date.now(), tickMs = 15000) {
  const p = current();
  if (!p) { announce(tick); return; }
  const def = defOf(p.key);
  if (p.status === 'announced' && tick >= p.starts_tick) {
    start(p, tick, tickTime, tickMs);
    for (const id of everyStation()) store.addEvent(id, tick, 'info', `Global project open: ${def.name}.`);
  } else if (p.status === 'active') {
    const needs = parse(p.needs, {}); const got = parse(p.contributed, {});
    if (Object.entries(needs).every(([r, q]) => (got[r] || 0) >= q)) {
      const period = p.ends_tick - p.starts_tick;
      db.prepare("UPDATE global_projects SET status = 'bonus', bonus_ends_tick = ?, closed_tick = ? WHERE id = ?").run(tick + Math.floor(period / 2), tick, p.id);
      if (def.faction) {
        // every player gains standing with the faction behind the project
        for (const c of db.prepare('SELECT id FROM colonies').all()) {
          db.prepare('INSERT INTO standing (colony_id, faction, points) VALUES (?, ?, ?) ON CONFLICT(colony_id, faction) DO UPDATE SET points = points + excluded.points').run(c.id, def.faction, P.standingReward);
        }
      }
      for (const id of everyStation()) { store.addEvent(id, tick, 'good', `Global project complete: ${def.name}. ${def.bonus.label}.`); orbital.setFlag(id, 'projectCompleted', tick); }
    } else if (tick >= p.ends_tick) {
      db.prepare("UPDATE global_projects SET status = 'failed', closed_tick = ? WHERE id = ?").run(tick, p.id);
      for (const id of everyStation()) store.addEvent(id, tick, 'info', `Global project closed unfinished: ${def.name}.`);
      announce(tick);
    }
  } else if (p.status === 'bonus' && tick >= p.bonus_ends_tick) {
    db.prepare("UPDATE global_projects SET status = 'done' WHERE id = ?").run(p.id);
    announce(tick);
  }
}

// Output multipliers by building type while an efficiency bonus is running (for every colony).
function globalOut() {
  const p = current();
  if (!p || p.status !== 'bonus') return null;
  const b = defOf(p.key).bonus;
  if (b.kind !== 'efficiency') return null;
  return Object.fromEntries(b.buildings.map((t) => [t, b.mult]));
}

function contribute(c, { ship, cargo }, tick) {
  const st = orbital.stationOf(c.id);
  if (!st) return fail('There is no station.');
  const p = current();
  if (!p || p.status !== 'active') return fail('No global project is taking contributions right now.');
  const s = db.prepare('SELECT * FROM dropships WHERE id = ? AND colony_id = ?').get(toInt(ship), c.id);
  if (!s) return fail('No such dropship.');
  if (s.state !== 'docked') return fail('That dropship is not docked at the station.');
  if (s.integrity <= 0) return fail('That dropship needs repairs first.');
  if (!isPlain(cargo)) return fail('Bad cargo.');
  const needs = parse(p.needs, {});
  const load = {};
  for (const [r, q0] of Object.entries(cargo)) {
    if (!own(needs, r)) return fail('The project does not need that.');
    const q = Math.floor(toNum(q0));
    if (!Number.isFinite(q) || q < 0) return fail('Bad quantity.');
    if (q > 0) load[r] = q;
  }
  const total = Object.values(load).reduce((n, v) => n + v, 0);
  if (!total) return fail('Load something first.');
  const hold = (D.levels[s.level] || D.levels['1']).hold;
  if (total > hold) return fail(`The hold carries ${hold} in all.`);
  const inv = store.loadInventory(c.id, st.district_id);
  for (const [r, q] of Object.entries(load)) if ((inv[r] || 0) < q) return fail(`Not enough ${config.resources[r].name} in orbital storage.`);
  for (const [r, q] of Object.entries(load)) inv[r] -= q;
  store.saveInventory(c.id, inv, st.district_id);
  db.prepare("UPDATE dropships SET state = 'contributing', project_id = ?, until_tick = ?, cargo = ? WHERE id = ?").run(p.id, tick + D.contributeTicks, JSON.stringify(load), s.id);
  return OK;
}

// Per colony, every tick: contributions delivered halfway through the trip, ships home at the end, and the drip bonus.
function advanceColony(c, stationInv, tick) {
  for (const s of db.prepare("SELECT * FROM dropships WHERE colony_id = ? AND state = 'contributing'").all(c.id)) {
    const cargo = parse(s.cargo, {});
    const deliverAt = s.until_tick - Math.floor(D.contributeTicks / 2);
    if (tick >= deliverAt && Object.keys(cargo).length) {
      const p = db.prepare('SELECT * FROM global_projects WHERE id = ?').get(s.project_id);
      if (p && p.status === 'active') {
        const got = parse(p.contributed, {});
        for (const [r, q] of Object.entries(cargo)) {
          got[r] = (got[r] || 0) + q;
          db.prepare('INSERT INTO global_contributions (project_id, colony_id, resource_id, qty) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, colony_id, resource_id) DO UPDATE SET qty = qty + excluded.qty').run(p.id, c.id, r, q);
        }
        db.prepare('UPDATE global_projects SET contributed = ? WHERE id = ?').run(JSON.stringify(got), p.id);
        db.prepare("UPDATE dropships SET cargo = '{}' WHERE id = ?").run(s.id);
        orbital.setFlag(c.id, 'contributed', tick);
        store.addEvent(c.id, tick, 'good', `Contribution delivered to ${defOf(p.key).name}.`);
        continue;
      }
    }
    if (tick >= s.until_tick) {
      for (const [r, q] of Object.entries(cargo)) if (stationInv) stationInv[r] = (stationInv[r] || 0) + q; // the project closed: the cargo comes back
      db.prepare("UPDATE dropships SET state = 'docked', cargo = '{}', project_id = NULL, until_tick = 0 WHERE id = ?").run(s.id);
      store.addEvent(c.id, tick, 'info', 'A dropship is back at the station from the global project.');
    }
  }
  const p = current();
  if (stationInv && p && p.status === 'bonus' && p.drip_resource) {
    const b = defOf(p.key).bonus;
    if (b.kind === 'drip') stationInv[p.drip_resource] = (stationInv[p.drip_resource] || 0) + b.perTick;
  }
}

function view(c, tick) {
  const p = current();
  if (!p) return null;
  const def = defOf(p.key);
  const mine = Object.fromEntries(db.prepare('SELECT resource_id, qty FROM global_contributions WHERE project_id = ? AND colony_id = ?').all(p.id, c.id).map((r) => [r.resource_id, r.qty]));
  const next = p.status === 'announced' ? null : P.list[db.prepare('SELECT COUNT(*) AS n FROM global_projects').get().n % P.list.length];
  return {
    id: p.id, key: p.key, name: def.name, desc: def.desc, faction: def.faction, bonus: def.bonus, status: p.status,
    startsIn: p.status === 'announced' ? Math.max(0, p.starts_tick - tick) : 0,
    endsIn: p.status === 'active' ? Math.max(0, p.ends_tick - tick) : 0,
    bonusLeft: p.status === 'bonus' ? Math.max(0, p.bonus_ends_tick - tick) : 0,
    needs: p.status === 'announced' ? def.needs : parse(p.needs, {}), perPlayer: def.needs, players: p.players,
    contributed: parse(p.contributed, {}), mine, drip: p.drip_resource,
    next: next ? { key: next.key, name: next.name } : null, standingReward: P.standingReward,
  };
}

module.exports = { advanceWorld, advanceColony, globalOut, contribute, view, current, defOf };
