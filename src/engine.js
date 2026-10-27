'use strict';
const EventEmitter = require('events');
const sim = require('./sim');
const store = require('./db');
const shutdown = require('./shutdown');
const hazards = require('./hazards');
const market = require('./market');
const missions = require('./missions');
const { db, config } = store;

const neighborMap = sim.buildNeighborMap(config);
// One neighbour map per district type (the Core plus anything defined under config.districtTypes).
const neighborMaps = { core: neighborMap };
for (const type of Object.keys(config.districtTypes || {})) neighborMaps[type] = sim.buildNeighborMap(config, type);
const events = new EventEmitter();
const TICK_MS = Number(process.env.TICK_MS) || config.global.tickRateMs;

let timer = null;

const timing = () => ({
  tickMs: TICK_MS,
  globalTick: Number(store.getMeta('global_tick', 0)),
  lastTickAt: Number(store.getMeta('last_tick_at', Date.now())),
});

// Every district of the colony with its stockpile and buildings. The Core's level lives on the colony row.
function loadDistricts(c) {
  return store.loadDistricts(c.id).map((d) => ({
    id: d.id, type: d.type, name: d.name,
    level: d.type === 'core' ? c.hub_level : d.level,
    inventory: store.loadInventory(c.id, d.id), buildings: store.loadBuildings(c.id, d.id),
  }));
}

function tickColony(c, globalTick, tickTime) {
  missions.advance(c, globalTick);
  const districts = loadDistricts(c);
  const core = districts.find((d) => d.type === 'core');
  const hazard = store.loadHazard(c.id);
  const hazardMods = hazards.modifiersFor(config, hazard, core.buildings); // hazards act on the Core for now
  const full = sim.stepColony(
    config,
    { population: c.population, morale: c.morale, age: c.age, progress: c.progress, won: !!c.won },
    districts,
    { neighborMaps, mods: { [core.id]: hazardMods }, popConsumptionMult: hazardMods.popConsumptionMult, routes: store.loadRoutes(c.id) },
  );
  const res = sim.coreView(full);
  const ev = (kind, msg) => store.addEvent(c.id, globalTick, kind, msg);
  const names = (list) => list.map((r) => config.resources[r].name).join(' and ');

  let inventory = res.inventory;
  let credits = c.credits;
  let hubLevel = c.hub_level;
  let population = res.population;

  const starving = res.starving.length > 0;
  if (starving && !c.starving) ev('bad', `Shortage of ${names(res.starving)}! Morale is falling.`);
  if (!starving && c.starving) ev('good', 'Supplies restored. Morale is recovering.');
  const brownout = res.energy.satisfaction < 0.999;
  if (brownout && !c.brownout) ev('warn', `Brownout: grid supplies ${Math.floor(res.energy.supply)} of ${Math.ceil(res.energy.demand)} power. Production is throttled.`);
  if (!brownout && c.brownout) ev('good', 'Power grid stable again.');
  if (res.grew) ev('info', `Population grew to ${population}.`);
  if (res.left && (c.age % 4 === 0 || population <= config.global.minPopulation)) {
    const why = { hunger: 'There is not enough food or water: people are leaving', despair: 'Morale is low: people are leaving', housing: 'There are not enough homes: people are leaving' }[res.leftWhy];
    ev('warn', `${why}. Population is ${population}.`);
  }
  const need = config.global.beacon.transmitTicks;
  for (const q of [0.25, 0.5, 0.75]) {
    if (c.progress < need * q && res.progress >= need * q && !res.won) ev('info', `Beacon transmission ${Math.round(q * 100)}% complete.`);
  }
  if (res.won && !c.won) ev('good', 'THE BEACON HAS REACHED THE WORLD. Transmission complete. Mission accomplished.');

  // Work orders
  for (const o of store.loadOrders(c.id)) {
    if (o.ticks_remaining > 1) {
      db.prepare('UPDATE colony_work_orders SET ticks_remaining = ticks_remaining - 1 WHERE id = ?').run(o.id);
      continue;
    }
    const d = districts.find((x) => x.id === o.district_id) || core; // orders from before districts belong to the Core
    const where = d.type === 'core' ? '' : ` in ${d.name}`;
    if (o.action_type === 'build') {
      db.prepare('INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, ?, ?, ?)')
        .run(c.id, d.id, o.data.ring, o.data.slot, o.data.type);
      ev('good', `${config.buildings[o.data.type].name} completed in ring ${o.data.ring}${where}.`);
    } else if (o.action_type === 'upgrade') {
      const caps = sim.levelDef(config, d.type, o.data.level).ringCapacities;
      if (d.type === 'core') hubLevel = o.data.level;
      else db.prepare('UPDATE districts SET level = ? WHERE id = ?').run(o.data.level, d.id);
      ev('good', `${d.type === 'core' ? 'Hub' : d.name} upgraded to level ${o.data.level}.${caps[o.data.level] ? ` Ring ${o.data.level} unlocked.` : ''}`);
    }
    if (o.action_type === 'expand') {
      // (the building may have been demolished meanwhile; demolishing refunds and removes the order, so this is a safety net)
      const upd = db.prepare('UPDATE colony_buildings SET level = ? WHERE district_id = ? AND ring_index = ? AND slot_index = ?').run(o.data.level, d.id, o.data.ring, o.data.slot);
      if (upd.changes) ev('good', `${config.buildings[o.data.type].name} expanded to level ${o.data.level}${where}.`);
    }
    if (o.action_type === 'found') {
      const t = config.districtTypes[o.data.type];
      const nid = db.prepare("INSERT INTO districts (colony_id, type, level, name, created_tick) VALUES (?, ?, 1, ?, ?)")
        .run(c.id, o.data.type, t.name, globalTick).lastInsertRowid;
      const stock = {};
      for (const r of Object.keys(config.resources)) stock[r] = (t.startingStock || {})[r] || 0;
      store.saveInventory(c.id, stock, nid);
      ev('good', `${t.name} founded. A new district is online.`);
    }
    db.prepare('DELETE FROM colony_work_orders WHERE id = ?').run(o.id);
  }

  // Shipments that have reached their destination (anything over the storage cap is lost)
  for (const sh of store.loadShipments(c.id)) {
    if (globalTick < sh.arrivesTick) continue;
    const dest = full.districts.find((r) => r.id === sh.toDistrict);
    const name = (districts.find((x) => x.id === sh.toDistrict) || {}).name || 'the district';
    if (dest) {
      const cap = dest.cap;
      const into = dest.id === core.id ? inventory : dest.inventory;
      const room = Math.max(0, Math.floor(cap - (into[sh.resource] || 0)));
      const got = Math.min(sh.qty, Math.max(room, 0));
      into[sh.resource] = (into[sh.resource] || 0) + got;
      if (!sh.routeId || got < sh.qty) ev(got < sh.qty ? 'warn' : 'good', `${sh.routeId ? 'Route shipment' : 'Shipment'} arrived in ${name}: ${got} ${config.resources[sh.resource].name}${got < sh.qty ? ` (${sh.qty - got} lost, storage full)` : ''}.`);
    }
    db.prepare('DELETE FROM colony_shipments WHERE id = ?').run(sh.id);
  }

  // Standing routes: direct per-tick flows between stockpiles (see sim.applyRoutes).
  const bags = new Map(full.districts.map((r) => [r.id, { inv: r.id === core.id ? inventory : r.inventory, cap: r.cap }]));
  sim.applyRoutes(config, store.loadRoutes(c.id), bags);

  // Convoy
  if (globalTick % config.global.convoyIntervalTicks === 0) {
    const k = globalTick / config.global.convoyIntervalTicks;
    const out = sim.runConvoy(config, { hubLevel, inventory, credits, cap: res.cap }, store.loadContracts(c.id), sim.marketPrices(config, k));
    inventory = out.inventory;
    credits = out.credits;
    ev('info', 'The convoy has arrived.');
    for (const l of out.log) ev(l.kind, l.msg);
  }

  // Hope has run out: the colony shuts down instead of collapsing (see src/shutdown.js). While shut down it cannot
  // collapse again; it recovers once nobody is starving and morale has climbed back.
  const status = c.status;
  const sd = config.global.shutdown;
  const wasShut = c.shutdown_tick !== null && c.shutdown_tick !== undefined;
  let morale = res.morale;
  let shutdownTick = wasShut ? c.shutdown_tick : null;
  if (res.failed && !wasShut) {
    const parked = shutdown.park(c.id);
    morale = sd.morale;
    shutdownTick = globalTick;
    db.prepare('UPDATE colonies SET shutdowns = shutdowns + 1 WHERE id = ?').run(c.id);
    ev('bad', `The colony has shut down. ${parked} building${parked === 1 ? ' is' : 's are'} switched off and only the essentials are running. Rebuild from here, or abandon the colony from the menu.`);
  } else if (wasShut) {
    morale = Math.max(1, morale);
    if (!starving && morale >= sd.recoverMorale) {
      shutdownTick = null;
      ev('good', 'The colony has stabilised and is no longer shut down. Parked buildings stay off until you restart them.');
    }
  }

  // Express convoy delivery
  const trip = store.loadExpress(c.id);
  if (trip && globalTick >= trip.arrives_tick) {
    const x = config.global.express;
    inventory = { ...inventory };
    const got = [];
    for (const [resId, b] of Object.entries(trip.buy)) {
      const room = Math.max(0, Math.floor(res.cap - (inventory[resId] || 0)));
      const qty = Math.min(b.qty, room);
      inventory[resId] = (inventory[resId] || 0) + qty;
      if (qty < b.qty) credits += Math.round(b.cost * (b.qty - qty) / b.qty); // storage full: refund the undelivered share
      if (qty > 0) got.push(`${qty} ${config.resources[resId].name}`);
    }
    let pay = 0;
    for (const s of Object.values(trip.sell)) pay += s.pay;
    credits += pay;
    db.prepare('DELETE FROM colony_express WHERE id = ?').run(trip.id);
    db.prepare('UPDATE colonies SET express_ready_tick = ? WHERE id = ?').run(globalTick + x.cooldownTicks, c.id);
    ev('good', `The express convoy arrived${got.length ? `, delivering ${got.join(', ')}` : ''}${pay ? `, and paid ${pay} cr for your goods` : ''}.`);
  }

  // Hazards: forecasts, strikes and expiries. Players only start new ones while active,
  // but a forecast hazard always lands on its tick, logged in or not.
  if (status === 'active') {
    const active = c.last_seen_at >= tickTime - config.global.activeWindowSeconds * 1000;
    const out = hazards.advance({ config, c, globalTick, active, inventory, credits, defense: res.defense, buildings: core.buildings });
    inventory = out.inventory;
    credits = out.credits;
  }

  store.saveInventory(c.id, inventory, core.id);
  for (const r of full.districts) if (r.id !== core.id) store.saveInventory(c.id, r.inventory, r.id);
  db.prepare(`UPDATE colonies SET hub_level = ?, credits = ?, morale = ?, population = ?, age = age + 1, status = ?,
    won = ?, progress = ?, starving = ?, brownout = ? WHERE id = ?`)
    .run(hubLevel, Math.floor(credits), morale, population, status, res.won ? 1 : 0, res.progress, starving ? 1 : 0, brownout ? 1 : 0, c.id);
  db.prepare('UPDATE colonies SET shutdown_tick = ? WHERE id = ?').run(shutdownTick, c.id);
}

const processTickTx = db.transaction((tickTime) => {
  const globalTick = Number(store.getMeta('global_tick', 0)) + 1;
  market.advance(globalTick); // quotes, matching and expiry happen before any colony ticks, so settlements are in its stock
  for (const c of db.prepare("SELECT * FROM colonies WHERE status = 'active'").all()) tickColony(c, globalTick, tickTime);
  store.setMeta('global_tick', globalTick);
  return globalTick;
});

// BEGIN IMMEDIATE: the tick takes the write lock before it reads anything.
const processTick = (tickTime = Date.now()) => processTickTx.immediate(tickTime);

// Runs every tick that has come due, including those missed while the server was down.
function runDueTicks(now = Date.now()) {
  let last = Number(store.getMeta('last_tick_at', 0));
  if (!last) { last = now; store.setMeta('last_tick_at', last); }
  let due = Math.floor((now - last) / TICK_MS);
  if (due <= 0) return 0;
  if (due > config.global.maxOfflineTicks) {
    last = now - config.global.maxOfflineTicks * TICK_MS;
    due = config.global.maxOfflineTicks;
  }
  // Catch-up ticks carry their own virtual time, so "was the player around?" is judged then, not now.
  for (let i = 0; i < due; i++) processTick(last + (i + 1) * TICK_MS);
  store.setMeta('last_tick_at', last + due * TICK_MS);
  events.emit('tick', timing());
  return due;
}

function start() {
  if (timer) return;
  const caught = runDueTicks();
  if (caught > 1) console.log(`Caught up ${caught} ticks of offline progress.`);
  timer = setInterval(() => {
    try { runDueTicks(); } catch (err) { console.error('Tick error:', err); }
  }, 250);
  console.log(`Engine running: 1 tick = ${TICK_MS} ms.`);
}

function stop() { clearInterval(timer); timer = null; }

module.exports = { events, start, stop, processTick, runDueTicks, timing, neighborMap, neighborMaps, TICK_MS };
