'use strict';
// Headquarters: the long sink after the story. It opens once the colony has read any data packet.
//
//  1. Activation: one huge bill (config.hq.activation.cost) delivered from the Core in any instalments, like a settlement's
//     drive. Goods held anywhere else have to be shipped or linked to the Core first.
//  2. Rebuilding: `activation.ticks` after the last delivery, the company's headquarters is back up.
//  3. Chartered: the colony gets its independent charter: credits, a badge after its station's name, and free unlocks.
//     From then on the player picks one option of one category at a time. Before they commit they see which goods it takes
//     but not how many; once committed the bill is the category's cost x costMult^n and the work takes baseTicks x
//     timeMult^n, where n counts every paid unlock so far (one counter for all categories, so cheap picks make the
//     expensive ones dearer too). Bills are paid from the Core (credits from the treasury), in any instalments. Abandoning
//     an unlock refunds nothing; switching to another carries `switchCarry` of what was delivered across, for the goods
//     both bills share. Free unlocks skip the bill and the wait and do not move the counter.
//
// What each option does is applied by the code it changes, reading perks.js.
const store = require('./db');
const ms = require('./marketsim');
const orbital = require('./orbital');
const territories = require('./territories');
const perks = require('./perks');
const sim = require('./sim');
const { own, toInt, toNum } = require('./validate');
const { db, config } = store;
const H = config.hq;

const fail = (error) => ({ ok: false, error });
const OK = { ok: true };
const parse = (s, d) => { try { const v = JSON.parse(s); return v === null || v === undefined ? d : v; } catch (e) { return d; } };
const tickNow = () => Number(store.getMeta('global_tick', 0));
const R = config.resources;
const nameOf = (r) => (r === 'credits' ? 'credits' : (R[r] || { name: r }).name);

const unlocked = (c) => !!H && !!db.prepare('SELECT 1 FROM colony_data_packets WHERE colony_id = ? AND level >= 1').get(c.id);
// The colony's Headquarters row, made the first time it is asked for once it has opened (null before that).
function rowOf(c, tick = tickNow()) {
  if (!H) return null;
  const r = db.prepare('SELECT * FROM colony_hq WHERE colony_id = ?').get(c.id);
  if (r || !unlocked(c)) return r || null;
  db.prepare('INSERT OR IGNORE INTO colony_hq (colony_id, opened_tick) VALUES (?, ?)').run(c.id, tick);
  orbital.setFlag(c.id, 'hqOpened', tick);
  store.addEvent(c.id, tick, 'good', 'The company headquarters has been located. It is down, and it needs rebuilding. The Headquarters screen is open.');
  return db.prepare('SELECT * FROM colony_hq WHERE colony_id = ?').get(c.id);
}
const chartered = (colonyId) => !!db.prepare("SELECT 1 FROM colony_hq WHERE colony_id = ? AND stage = 'chartered'").get(colonyId);

// ---- bills and timers ---------------------------------------------------------------------
const category = (cat) => (own(H.categories, cat) ? H.categories[cat] : null);
const option = (cat, opt) => { const k = category(cat); return k && own(k.options, opt) ? k.options[opt] : null; };
// The bill for an unlock of a category after n paid unlocks.
function billFor(cat, n) {
  const m = H.costMult ** n;
  return Object.fromEntries(Object.entries(category(cat).cost).map(([r, q]) => [r, Math.round(q * m)]));
}
const ticksFor = (n) => Math.round(H.baseTicks * H.timeMult ** n);
const done = (need, got) => Object.entries(need).every(([r, q]) => (got[r] || 0) >= q);

// Can this option be taken right now? Returns a reason when it cannot.
function blocked(c, cat, opt) {
  if ((cat === 'station' || cat === 'territory') && !orbital.stationOf(c.id)) return 'There is no station.';
  if (cat === 'district' && !sim.districtsUnlocked(config, { coreLevel: c.hub_level })) return 'Districts are not open yet.';
  if (cat === 'station' && opt === 'shipL4' && !eligibleShips(c).length) return 'No dropship is at level 3.';
  return null;
}
const eligibleShips = (c) => db.prepare('SELECT * FROM dropships WHERE colony_id = ? AND level = 3 ORDER BY num').all(c.id);

// ---- paying from the Core -------------------------------------------------------------------
// Deliver toward a bill: one resource (and an amount, or as much as is still needed), or with no resource everything
// the Core holds that the bill still needs (credits only ever go when asked for by name). Mutates `got`.
function deliver(c, need, got, { resource, qty }) {
  const core = store.coreId(c.id);
  const stock = store.loadInventory(c.id, core);
  const credits = db.prepare('SELECT credits FROM colonies WHERE id = ?').get(c.id).credits;
  const have = (r) => (r === 'credits' ? credits : Math.floor(stock[r] || 0));
  const give = {};
  if (resource !== undefined && resource !== null && resource !== '') {
    if (!own(need, resource)) return fail('The bill does not need that.');
    const left = need[resource] - (got[resource] || 0);
    if (left <= 0) return fail(`The bill has all the ${nameOf(resource)} it needs.`);
    const q = qty === undefined || qty === null || qty === '' ? left : Math.floor(toNum(qty));
    if (!Number.isFinite(q) || q < 1) return fail('Bad quantity.');
    const amount = Math.min(q, left, have(resource));
    if (amount < 1) return fail(resource === 'credits' ? 'Not enough credits.' : `There is no ${nameOf(resource)} in the Core.`);
    give[resource] = amount;
  } else {
    for (const [r, q] of Object.entries(need)) {
      if (r === 'credits') continue;
      const amount = Math.min(q - (got[r] || 0), have(r));
      if (amount >= 1) give[r] = amount;
    }
    if (!Object.keys(give).length) return fail('The Core holds nothing the bill still needs.');
  }
  const take = db.prepare('UPDATE colony_inventory SET amount = amount - ? WHERE district_id = ? AND resource_id = ?');
  for (const [r, q] of Object.entries(give)) {
    if (r === 'credits') db.prepare('UPDATE colonies SET credits = credits - ? WHERE id = ?').run(q, c.id);
    else take.run(q, core, r);
    got[r] = (got[r] || 0) + q;
  }
  return { ok: true, given: give };
}

// Contribute to whatever Headquarters needs now: the activation bill, or the unlock under way.
function give(c, args = {}, tick = tickNow()) {
  const r = rowOf(c, tick);
  if (!r) return fail('Headquarters has not been found yet.');
  if (r.stage === 'activation') {
    const got = parse(r.got, {});
    const out = deliver(c, H.activation.cost, got, args);
    if (!out.ok) return out;
    if (done(H.activation.cost, got)) {
      db.prepare("UPDATE colony_hq SET got = ?, stage = 'rebuilding', ready_tick = ? WHERE colony_id = ?").run(JSON.stringify(got), tick + H.activation.ticks, c.id);
      store.addEvent(c.id, tick, 'good', 'The last of the Headquarters bill has been delivered. The rebuild is under way.');
      return { ...out, completed: true };
    }
    db.prepare('UPDATE colony_hq SET got = ? WHERE colony_id = ?').run(JSON.stringify(got), c.id);
    return out;
  }
  if (r.stage !== 'chartered') return fail('Headquarters is being rebuilt. Nothing more is needed.');
  const cur = parse(r.cur, null);
  if (!cur || cur.state !== 'funding') return fail('No unlock is waiting for goods.');
  const out = deliver(c, cur.need, cur.got, args);
  if (!out.ok) return out;
  if (done(cur.need, cur.got)) {
    cur.state = 'building'; cur.readyTick = tick + ticksFor(cur.n);
    store.addEvent(c.id, tick, 'good', `Headquarters has everything it needs for ${option(cur.cat, cur.opt).name}. The work is under way.`);
  }
  db.prepare('UPDATE colony_hq SET cur = ? WHERE colony_id = ?').run(JSON.stringify(cur), c.id);
  return cur.state === 'building' ? { ...out, completed: true } : out;
}

// ---- choosing an unlock ----------------------------------------------------------------------
// Commit to an option (`free`: spend a free unlock on it instead, which applies at once). With an unlock already waiting
// for goods this is a switch: part of what was delivered carries over, for the goods both bills share.
function start(c, { category: cat, option: opt, ship, free }, tick = tickNow()) {
  const r = rowOf(c, tick);
  if (!r || r.stage !== 'chartered') return fail('Unlocks open once Headquarters is rebuilt and the charter granted.');
  if (!option(cat, opt)) return fail('Unknown unlock.');
  const why = blocked(c, cat, opt);
  if (why) return fail(why);
  let shipId = null;
  if (option(cat, opt).needsShip) {
    const s = db.prepare('SELECT * FROM dropships WHERE id = ? AND colony_id = ?').get(toInt(ship), c.id);
    if (!s) return fail('Choose which dropship to refit.');
    if (s.level !== 3) return fail('Only a level-3 dropship can be refitted to level 4.');
    shipId = s.id;
  }
  if (free === true) {
    if (r.free < 1) return fail('There is no free unlock to spend.');
    db.prepare('UPDATE colony_hq SET free = free - 1 WHERE colony_id = ?').run(c.id);
    apply(c, cat, opt, shipId, tick);
    return OK;
  }
  const old = parse(r.cur, null);
  if (old && old.state === 'building') return fail('An unlock is already being built. It has to finish first.');
  if (old && old.cat === cat && old.opt === opt && old.ship === shipId) return fail('That unlock is already the one under way.');
  // committing (or switching) takes data fragments, so data sites stay worth working once every packet is read
  const frags = H.fragmentCost || 0;
  if (frags && db.prepare('SELECT data_fragments FROM colonies WHERE id = ?').get(c.id).data_fragments < frags) return fail(`Committing takes ${frags} data fragment${frags === 1 ? '' : 's'}.`);
  if (frags) db.prepare('UPDATE colonies SET data_fragments = data_fragments - ? WHERE id = ?').run(frags, c.id);
  const n = r.unlocks;
  const need = billFor(cat, n);
  const got = {};
  if (old) {
    // switching: a share of what was delivered moves over, for what both bills take
    for (const [res, q] of Object.entries(old.got || {})) if (own(need, res)) got[res] = Math.min(need[res], Math.floor(q * H.switchCarry));
  }
  const cur = { cat, opt, ship: shipId, need, got, state: 'funding', n, startedTick: tick };
  if (done(need, got)) { cur.state = 'building'; cur.readyTick = tick + ticksFor(n); }
  db.prepare('UPDATE colony_hq SET cur = ? WHERE colony_id = ?').run(JSON.stringify(cur), c.id);
  if (old) store.addEvent(c.id, tick, 'info', `Headquarters switched to ${option(cat, opt).name}. Part of what was delivered carried over.`);
  return OK;
}

// Give up the unlock that is waiting for goods. Nothing delivered comes back.
function abort(c, args, tick = tickNow()) {
  const r = rowOf(c, tick);
  const cur = r && parse(r.cur, null);
  if (!cur) return fail('No unlock is under way.');
  if (cur.state === 'building') return fail('That unlock is already being built.');
  db.prepare('UPDATE colony_hq SET cur = NULL WHERE colony_id = ?').run(c.id);
  store.addEvent(c.id, tick, 'warn', `Headquarters abandoned ${option(cur.cat, cur.opt).name}. What was delivered stays spent.`);
  return OK;
}

// A banked level-4 refit (one whose ship was no longer at level 3 when the work finished), used on another ship.
function refit(c, { ship }, tick = tickNow()) {
  if (perks.count(c.id, 'l4') < 1) return fail('There is no level-4 refit waiting.');
  const s = db.prepare('SELECT * FROM dropships WHERE id = ? AND colony_id = ?').get(toInt(ship), c.id);
  if (!s || s.level !== 3) return fail('Only a level-3 dropship can be refitted to level 4.');
  perks.add(c.id, 'l4', -1);
  db.prepare('UPDATE dropships SET level = 4 WHERE id = ?').run(s.id);
  store.addEvent(c.id, tick, 'good', `Dropship ${s.num} has been refitted to level 4.`);
  return OK;
}

// ---- what an unlock does ------------------------------------------------------------------------
function apply(c, cat, opt, shipId, tick) {
  const say = (msg) => store.addEvent(c.id, tick, 'good', `Headquarters: ${msg}`);
  if (cat === 'district') {
    const d = discover(c, tick);
    say(`a new district has been charted: ${discoveryName(d)}. It can be founded from the Districts screen.`);
  } else if (opt === 'orbitalLink') { perks.add(c.id, 'orbitalLinks'); say('the station has one more link to the Core.'); }
  else if (opt === 'hcSlot') {
    perks.add(c.id, 'hcSlots');
    const st = orbital.stationOf(c.id);
    if (st) orbital.ensureSlots(c.id, config.orbital.storage.levels[st.storage_level].slots);
    say('a high-capacity storage slot has been added to the station.');
  } else if (opt === 'dropship') { perks.add(c.id, 'dropships'); say('the station has room for one more dropship.'); }
  else if (opt === 'shipL4') {
    const s = shipId && db.prepare('SELECT * FROM dropships WHERE id = ? AND colony_id = ?').get(shipId, c.id);
    if (s && s.level === 3) { db.prepare('UPDATE dropships SET level = 4 WHERE id = ?').run(s.id); say(`dropship ${s.num} has been refitted to level 4.`); }
    else { perks.add(c.id, 'l4'); say('a level-4 refit is ready, but its dropship is no longer at level 3. Use it on another from the Expeditions screen.'); }
  } else if (opt === 'route') { perks.add(c.id, 'routes'); say(`${option(cat, opt).amount} more standing routes can run between districts.`); }
  else if (opt === 'linkBoost') { perks.add(c.id, 'linkBoost'); say(`every district link carries ${option(cat, opt).amount} more per tick.`); }
  else if (opt === 'stabilizer') {
    const p = perks.of(c.id);
    p.stabilizers = [...(Array.isArray(p.stabilizers) ? p.stabilizers : []), 0];
    perks.save(c.id, p);
    say('a territory stabilizer is ready. Take it along when a dropship deploys.');
  } else if (opt === 'finder') {
    const t = territories.spawnPrivate(c, tick, option(cat, opt).durationMult);
    perks.add(c.id, 'finders');
    say(`a stable territory has been found: ${t.name}, with ${nameOf(t.rare)}. Only your station can see it.`);
  } else if (opt === 'extraLink') { perks.add(c.id, 'extraLinks'); say('a territory link kit is ready. Take it along when a dropship deploys.'); }
}

// ---- discovered districts -----------------------------------------------------------------------
const D = () => H.categories.district;
const discoveryRow = (colonyId, id) => db.prepare('SELECT * FROM hq_discoveries WHERE id = ? AND colony_id = ?').get(toInt(id), colonyId);
function discoveryName(idOrRow) {
  const d = typeof idOrRow === 'object' ? idOrRow : db.prepare('SELECT * FROM hq_discoveries WHERE id = ?').get(idOrRow);
  return d ? store.districtName(d.type, d.type, d.prefix) : 'a discovered district';
}
// The first discovery is a Free Port; after that the type is random among those discovered the fewest times (so every
// type turns up before any comes round again), never the same as the one before.
function discover(c, tick) {
  const prev = db.prepare('SELECT * FROM hq_discoveries WHERE colony_id = ? ORDER BY seq').all(c.id);
  const seq = prev.length + 1;
  const r = ms.rng(ms.hash(`discover:${c.id}:${seq}:${tick}`));
  const types = Object.keys(config.districtTypes);
  const last = prev.length ? prev[prev.length - 1].type : null;
  let type;
  if (seq === 1 && types.includes('freeport')) type = 'freeport';
  else {
    const count = (t) => prev.filter((p) => p.type === t).length;
    const fresh = types.filter((t) => t !== last);
    const fewest = Math.min(...fresh.map(count));
    const pool = fresh.filter((t) => count(t) === fewest);
    type = pool[Math.floor(r() * pool.length) % pool.length];
  }
  const usedPrefix = new Set(prev.map((p) => p.prefix));
  const names = D().names.filter((p) => !usedPrefix.has(p));
  const prefix = names.length ? names[Math.floor(r() * names.length) % names.length] : `${D().names[seq % D().names.length]} ${seq}`;
  // on an outer ring of the map, at the bearing furthest from every district already drawn (originals and discoveries)
  const taken = [...Object.values(config.districtTypes).map((t) => t.angle), ...prev.map((p) => p.angle)];
  const gap = (a) => Math.min(...taken.map((b) => { const d = Math.abs(((a - b) % 360 + 540) % 360 - 180); return d; }));
  let angle = -90;
  for (let a = -180; a < 180; a += 5) if (gap(a) > gap(angle)) angle = a;
  const id = Number(db.prepare('INSERT INTO hq_discoveries (colony_id, seq, type, prefix, extra_distance, angle, created_tick) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(c.id, seq, type, prefix, D().extraDistance * seq, angle, tick).lastInsertRowid);
  perks.add(c.id, 'discoveries');
  return discoveryRow(c.id, id);
}
// Found a discovered district: checked here, then queued in the Core like any founding (`enqueue(orderData)`).
function found(c, { discovery }, enqueue) {
  const d = discoveryRow(c.id, discovery);
  if (!d) return fail('Unknown district.');
  if (d.district_id && db.prepare('SELECT 1 FROM districts WHERE id = ?').get(d.district_id)) return fail(`${discoveryName(d)} is already founded.`);
  if (store.loadOrders(c.id).some((o) => o.action_type === 'found' && o.data.discovery === d.id)) return fail(`${discoveryName(d)} is already being founded.`);
  if (!sim.districtsUnlocked(config, { coreLevel: c.hub_level })) return fail(`Districts open at hub level ${config.districtProgression.unlockCoreLevel}.`);
  if (!sim.districtFoundable(config, d.type, { coreLevel: c.hub_level, beaconBuilt: store.hasBeacon(c.id) })) return fail(`${discoveryName(d)} opens once the Beacon is built.`);
  return enqueue({ type: d.type, discovery: d.id });
}

// ---- every tick -----------------------------------------------------------------------------------
// The rebuild and the unlock under way finish on their own timers. Returns credits the colony gains this tick (the
// charter's), which the engine adds to the treasury it is about to save.
function advance(c, tick) {
  if (!H) return 0;
  const r = rowOf(c, tick);
  if (!r) return 0;
  if (r.stage === 'rebuilding' && tick >= r.ready_tick) {
    db.prepare("UPDATE colony_hq SET stage = 'chartered', free = free + ?, chartered_tick = ? WHERE colony_id = ?").run(H.charter.freeUnlocks, tick, c.id);
    orbital.setFlag(c.id, 'chartered', tick);
    store.addEvent(c.id, tick, 'good', `Headquarters is back up. The colony holds its independent charter: ${H.charter.credits.toLocaleString('en-US')} credits, and ${H.charter.freeUnlocks === 1 ? 'one unlock' : `${H.charter.freeUnlocks} unlocks`} on the house.`);
    return H.charter.credits;
  }
  const cur = parse(r.cur, null);
  if (r.stage === 'chartered' && cur && cur.state === 'building' && tick >= cur.readyTick) {
    db.prepare('UPDATE colony_hq SET cur = NULL, unlocks = unlocks + 1 WHERE colony_id = ?').run(c.id);
    apply(c, cur.cat, cur.opt, cur.ship, tick);
  }
  return 0;
}

// ---- the admin panel ---------------------------------------------------------------------------------
// The timer running now: the rebuild, or the unlock being built (null when neither is). Unlike view(), this never makes
// the colony's row, so looking at a colony does not open its Headquarters.
function timer(colonyId, tick = tickNow()) {
  if (!H) return null;
  const r = db.prepare('SELECT * FROM colony_hq WHERE colony_id = ?').get(colonyId);
  if (!r) return null;
  const running = (name, readyTick, total) => ({ name, readyTick, total, left: Math.max(0, readyTick - tick) });
  if (r.stage === 'rebuilding') return running('Rebuild', r.ready_tick, H.activation.ticks);
  const cur = parse(r.cur, null);
  if (r.stage !== 'chartered' || !cur || cur.state !== 'building') return null;
  const o = option(cur.cat, cur.opt);
  return running(o ? o.name : cur.opt, cur.readyTick, ticksFor(cur.n));
}
// Move the running timer to `left` ticks from now. At 0 advance() finishes the work on the colony's next tick.
function setTimer(colonyId, left, tick = tickNow()) {
  const r = db.prepare('SELECT stage, cur FROM colony_hq WHERE colony_id = ?').get(colonyId);
  if (r.stage === 'rebuilding') db.prepare('UPDATE colony_hq SET ready_tick = ? WHERE colony_id = ?').run(tick + left, colonyId);
  else db.prepare('UPDATE colony_hq SET cur = ? WHERE colony_id = ?').run(JSON.stringify({ ...parse(r.cur, null), readyTick: tick + left }), colonyId);
}

// ---- the view --------------------------------------------------------------------------------------
function view(c, tick = tickNow()) {
  const r = rowOf(c, tick);
  if (!r) return { unlocked: false };
  const out = { unlocked: true, stage: r.stage, switchCarry: H.switchCarry, charter: { credits: H.charter.credits, freeUnlocks: H.charter.freeUnlocks, badge: H.charter.badge } };
  if (r.stage === 'activation' || r.stage === 'rebuilding') {
    out.activation = { need: H.activation.cost, got: parse(r.got, {}), ticks: H.activation.ticks, readyIn: r.stage === 'rebuilding' ? Math.max(0, r.ready_tick - tick) : null };
    return out;
  }
  const cur = parse(r.cur, null);
  const p = perks.of(c.id);
  out.free = r.free;
  out.fragmentCost = H.fragmentCost || 0;
  out.fragments = db.prepare('SELECT data_fragments FROM colonies WHERE id = ?').get(c.id).data_fragments;
  out.unlocks = r.unlocks;
  out.charteredTick = r.chartered_tick;
  // which goods each category takes, but not how many: that is only shown once committed
  out.categories = Object.entries(H.categories).map(([key, k]) => ({
    key, name: k.name, desc: k.desc, goods: Object.keys(k.cost),
    options: Object.entries(k.options).map(([ok, o]) => ({ key: ok, name: o.name, desc: o.desc, needsShip: !!o.needsShip, blocked: blocked(c, key, ok) })),
  }));
  out.ships = eligibleShips(c).map((s) => ({ id: s.id, num: s.num, state: s.state }));
  out.cur = cur ? {
    category: cur.cat, option: cur.opt, name: option(cur.cat, cur.opt).name, ship: cur.ship, need: cur.need, got: cur.got, state: cur.state,
    ticks: ticksFor(cur.n), readyIn: cur.state === 'building' ? Math.max(0, cur.readyTick - tick) : null,
  } : null;
  out.perks = {
    orbitalLinks: Number(p.orbitalLinks) || 0, hcSlots: Number(p.hcSlots) || 0, dropships: Number(p.dropships) || 0, l4: Number(p.l4) || 0,
    routes: perks.routeBonus(c.id), linkBoost: perks.linkBonus(c.id), stabilizers: (Array.isArray(p.stabilizers) ? p.stabilizers : []).length,
    extraLinks: Number(p.extraLinks) || 0, finders: Number(p.finders) || 0, discoveries: Number(p.discoveries) || 0,
  };
  return out;
}
// Districts Headquarters has charted, founded or not (for the district map and the Districts screen).
function discoveries(c) {
  const orders = store.loadOrders(c.id).filter((o) => o.action_type === 'found' && o.data.discovery);
  return db.prepare('SELECT * FROM hq_discoveries WHERE colony_id = ? ORDER BY seq').all(c.id).map((d) => {
    const o = orders.find((x) => x.data.discovery === d.id);
    const founded = d.district_id && db.prepare('SELECT 1 FROM districts WHERE id = ?').get(d.district_id) ? d.district_id : null;
    return { id: d.id, seq: d.seq, type: d.type, name: discoveryName(d), distance: store.districtDistance(d.type, d.extra_distance), angle: d.angle, districtId: founded,
      founding: o ? { id: o.id, remaining: o.ticks_remaining, total: o.ticks_total, queued: o.state === 'queued' } : null };
  });
}

module.exports = { unlocked, rowOf, chartered, billFor, ticksFor, give, start, abort, refit, advance, view, timer, setTimer, discoveries, discover, found, discoveryRow, discoveryName, apply };
