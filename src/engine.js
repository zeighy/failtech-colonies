'use strict';
const EventEmitter = require('events');
const sim = require('./sim');
const store = require('./db');
const { db, config } = store;

const neighborMap = sim.buildNeighborMap(config);
const events = new EventEmitter();
const TICK_MS = Number(process.env.TICK_MS) || config.global.tickRateMs;

let timer = null;

const timing = () => ({
  tickMs: TICK_MS,
  globalTick: Number(store.getMeta('global_tick', 0)),
  lastTickAt: Number(store.getMeta('last_tick_at', Date.now())),
});

function loadState(c) {
  return {
    hubLevel: c.hub_level, population: c.population, morale: c.morale, age: c.age,
    goalTicks: c.goal_ticks, won: !!c.won, credits: c.credits,
    inventory: store.loadInventory(c.id), buildings: store.loadBuildings(c.id),
  };
}

function tickColony(c, globalTick) {
  const state = loadState(c);
  const res = sim.step(config, state, neighborMap);
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
  if (res.won && !c.won) ev('good', 'COLONY SELF-SUSTAINING. Hub level 3 with a stable power and supply loop. Mission accomplished.');

  // Work orders
  for (const o of store.loadOrders(c.id)) {
    if (o.ticks_remaining > 1) {
      db.prepare('UPDATE colony_work_orders SET ticks_remaining = ticks_remaining - 1 WHERE id = ?').run(o.id);
      continue;
    }
    if (o.action_type === 'build') {
      db.prepare("INSERT INTO colony_buildings (colony_id, ring_index, slot_index, building_type) VALUES (?, ?, ?, ?)")
        .run(c.id, o.data.ring, o.data.slot, o.data.type);
      ev('good', `${config.buildings[o.data.type].name} completed in ring ${o.data.ring}.`);
    } else if (o.action_type === 'upgrade') {
      hubLevel = o.data.level;
      ev('good', `Hub upgraded to level ${hubLevel}.${config.hubLevels[hubLevel].ringCapacities[hubLevel] ? ` Ring ${hubLevel} unlocked.` : ''}`);
    }
    db.prepare('DELETE FROM colony_work_orders WHERE id = ?').run(o.id);
  }

  // Convoy
  if (globalTick % config.global.convoyIntervalTicks === 0) {
    const out = sim.runConvoy(config, { hubLevel, inventory, credits }, store.loadContracts(c.id));
    inventory = out.inventory;
    credits = out.credits;
    ev('info', 'The convoy has arrived.');
    for (const l of out.log) ev(l.kind, l.msg);
  }

  let status = c.status;
  if (res.failed) {
    status = 'failed';
    ev('bad', 'The population has lost all hope. The colony is abandoned.');
  }

  store.saveInventory(c.id, inventory);
  db.prepare(`UPDATE colonies SET hub_level = ?, credits = ?, morale = ?, population = ?, age = age + 1, status = ?,
    won = ?, goal_ticks = ?, starving = ?, brownout = ? WHERE id = ?`)
    .run(hubLevel, credits, res.morale, population, status, res.won ? 1 : 0, res.goalTicks, starving ? 1 : 0, brownout ? 1 : 0, c.id);
}

const processTick = db.transaction(() => {
  const globalTick = Number(store.getMeta('global_tick', 0)) + 1;
  for (const c of db.prepare("SELECT * FROM colonies WHERE status = 'active'").all()) tickColony(c, globalTick);
  store.setMeta('global_tick', globalTick);
  return globalTick;
});

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
  for (let i = 0; i < due; i++) processTick();
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

module.exports = { events, start, stop, processTick, runDueTicks, timing, neighborMap, TICK_MS };
