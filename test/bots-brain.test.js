'use strict';
// The bot brain's decisions, on small hand-made views (no server, no database): the late-game knots the telemetry showed
// (expansions waiting on orbital goods, the station's next ring, slots and links for selling, buying back what it sells).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Colony } = require('../bots/brain/model');
const { Ground } = require('../bots/brain/ground');
const { Supply } = require('../bots/brain/supply');
const { Orbit } = require('../bots/brain/orbit');
const { Trade } = require('../bots/brain/trade');
const { rngFrom } = require('../bots/brain');
const profiles = require('../bots/profiles');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'game_config.json'), 'utf8'));

// A view with the given places (type -> { resources: { r: amount | { amount, net } }, buildings, level }) and, optionally,
// a station (slots: [[resource, amount]...] padded to `size` open slots) and an orbital market.
function world({ places = {}, station = null, market = null, credits = 100000, tick = 1000, next = 'ring3', colony = {} } = {}) {
  const calls = [];
  const api = { act: async (route, body) => { calls.push({ route, body }); return { ok: true, id: calls.length }; } };
  const m = new Colony({ config, api, maxActions: 100 });
  const views = {};
  const districts = [];
  let id = 1;
  const res = (o) => Object.fromEntries(Object.entries(o || {}).map(([r, x]) => [r, typeof x === 'number' ? { amount: x, net: 0 } : x]));
  for (const [type, p] of Object.entries({ core: {}, ...places })) {
    const d = { id: id++, type, level: p.level || 5, resources: res(p.resources), buildings: p.buildings || [], orders: [], cap: 20000 };
    views[d.id] = d; districts.push({ id: d.id, type });
  }
  let orbital = { unlocked: true, station: null, launch: { next }, market, project: null, ships: { ships: [], territories: [] } };
  if (station) {
    const sid = id++;
    const slots = station.slots.map(([r, a], i) => ({ idx: i, state: 'open', resource: r, amount: a }));
    while (slots.length < (station.size || 6)) slots.push({ idx: slots.length, state: 'open', resource: null, amount: 0 });
    views[sid] = { id: sid, type: 'station', level: 1, resources: res(Object.fromEntries(station.slots)), buildings: [], orders: [], cap: 2000 };
    districts.push({ id: sid, type: 'station', orbital: true });
    orbital = { ...orbital, station: { districtId: sid, storage: { level: 1, cap: 2000, slots }, links: { level: 1, count: 4, rate: 25, list: [] } } };
  }
  m.v = {
    tick, districts, views, routes: [], shipments: [], orbital,
    colony: { credits, population: 100, maxPopulation: 100, morale: 80, hubLevel: 5, won: true, staffing: { ratio: 1, posts: 50 }, ...colony },
    resources: { clean_water: { amount: 5000, net: 5, cap: 20000 }, rations: { amount: 5000, net: 5, cap: 20000 } },
  };
  return { m, calls, byType: (t) => m.byType(t) };
}
const lv5 = (type, cost) => ({ id: 1, type, ring: 1, slot: 0, level: 5, xnext: { level: 6, cost } });

test('an expansion that needs orbital goods nobody on the ground holds asks the station instead of waiting on it', async () => {
  const cost = { frames: 15, fittings: 10, null_alloy: 2, lattice_cores: 2 };
  const { m, calls } = world({ places: { greenbelt: { buildings: [lv5('hydroponics_bay', cost)] }, freeport: {} } });
  const mem = {};
  const G = new Ground(m, mem, profiles.get('porter'));
  const S = new Supply(m, mem, profiles.get('porter'), G);
  const gb = m.byType('greenbelt');
  assert.equal(await S.expand(gb, 'hydroponics_bay'), false, 'not counted as under way: the plan looks for another plot');
  assert.deepEqual(Object.keys(mem.orbitDown).sort(), ['lattice_cores', 'null_alloy']);
  assert.equal(G.expandable(gb, gb.buildings[0]), false);
  assert.equal(calls.length, 0);
  // once the Core holds them they are shipped like anything else (the Core keeps none back)
  m.core().resources.null_alloy = { amount: 2, net: 0 };
  m.core().resources.lattice_cores = { amount: 2, net: 0 };
  assert.equal(G.expandable(gb, gb.buildings[0]), true);
  assert.equal(await S.expand(gb, 'hydroponics_bay'), true);
  assert.ok(calls.some((c) => c.route === 'shipment' && c.body.resource === 'null_alloy'), JSON.stringify(calls));
});

test('the station keeps the next ring\'s orbital goods back from sale', async () => {
  const market = (asks = []) => ({ maxOpenOrders: 10, maxQty: 500, ttlOptions: [60, 240, 960], orders: [], goods: [{ resource: 'lattice_cores', reference: 100, band: [50, 200], asks, bids: [] }] });
  const sell = async (have) => {
    const { m, calls } = world({ station: { slots: [['lattice_cores', have]] }, market: market() });
    const t = new Trade(m, { events: [] }, profiles.get('industrialist'), new Ground(m, {}, profiles.get('industrialist')), rngFrom(3));
    await t.orbitSell();
    return calls.filter((c) => c.route === 'orbit-market' && c.body.side === 'sell');
  };
  const need = config.orbital.launch.cycles.ring3.orbitalCost.lattice_cores;
  assert.equal((await sell(need + 1)).length, 0, 'one over the reserve is less than a lot');
  const s = await sell(need + 3);
  assert.equal(s.length, 1);
  assert.ok(s[0].body.qty <= 3, JSON.stringify(s));
});

test('a bot never buys back what it is selling, and a rich one buys what the next ring needs', async () => {
  const goods = [
    { resource: 'curios', reference: 30, band: [10, 60], asks: [{ price: 20, qty: 50, mine: false }], bids: [] },
    { resource: 'null_alloy', reference: 100, band: [50, 200], asks: [{ price: 110, qty: 40, mine: false }], bids: [] },
  ];
  const market = { maxOpenOrders: 10, maxQty: 500, ttlOptions: [60, 240, 960], orders: [], goods };
  let w = world({ station: { slots: [['curios', 300]] }, market });
  let t = new Trade(w.m, { selling: ['curios'], events: [] }, profiles.get('scavenger'), new Ground(w.m, {}, profiles.get('scavenger')), rngFrom(1));
  await t.orbitBuy();
  assert.equal(w.calls.length, 0, JSON.stringify(w.calls));
  // rich, and the station lacks the ring's goods: the cheap ask is taken (and the missing rest is still to find)
  w = world({ station: { slots: [['curios', 300], ['lattice_cores', 60]] }, market, credits: 2e6 });
  t = new Trade(w.m, { events: [] }, profiles.get('steward'), new Ground(w.m, {}, profiles.get('steward')), rngFrom(1));
  await t.launchBuy();
  const buy = w.calls.find((c) => c.route === 'orbit-market');
  assert.ok(buy && buy.body.resource === 'null_alloy' && buy.body.side === 'buy' && buy.body.qty === 40, JSON.stringify(w.calls));
});

test('trade counters survive another step starting them, and fills are told apart from orders', async () => {
  const market = { maxOpenOrders: 10, maxQty: 500, ttlOptions: [60, 240, 960], orders: [], goods: [] };
  const { m } = world({ station: { slots: [] }, market });
  const mem = { trade: { boughtForSupply: 40 } }; // (the supply step bought something on the ground first)
  const t = new Trade(m, mem, profiles.get('steward'), null, rngFrom(1));
  assert.equal(mem.trade.sold, 0);
  assert.equal(mem.trade.boughtForSupply, 40);
  // an order of 10 posted; next turn 4 are left, then it is gone before it was due to expire
  m.lastResult = { id: 7 };
  t.posted('sell', 10, 240);
  market.orders = [{ id: 7, side: 'sell', remaining: 4, ticksLeft: 200 }];
  t.fills();
  assert.equal(mem.trade.soldFilled, 6);
  market.orders = [];
  t.fills();
  assert.equal(mem.trade.soldFilled, 10);
});

test('a foundry run that fits only without the trade good on sale takes its slot; the next ring\'s goods come first', () => {
  const ship = { id: 1, state: 'docked', integrity: 100, hold: 600, power: 50, linkRate: 15 };
  const goods = Object.keys(config.orbitalRecipes).map((g) => ({ resource: g, reference: g === 'lattice_cores' ? 50 : g === 'null_alloy' ? 40 : 100, band: [1, 999], asks: [], bids: [] }));
  const make = (size, selling) => {
    const { m } = world({ station: { slots: [['power_cells', 100], ['frames', 150], ['fittings', 110]], size }, market: { goods, orders: [] } });
    const o = new Orbit(m, { selling }, profiles.get('scavenger'), null);
    o.tripFor = () => ({ plan: { rate: 1, links: [] } });
    return o;
  };
  const tight = make(6, ['curios']);
  assert.equal(tight.chooseRun(ship), null, 'three slots kept, one for curios: two left, and every run needs three');
  assert.ok(tight.chooseRun(ship, 1), 'with the curios slot given up, a run fits');
  assert.equal(make(9, []).chooseRun(ship).good, 'lattice_cores', 'the next ring needs lattice cores, worth more than their price says');
  // while squeezed, only orbital goods are put up for sale
  const { m } = world({ station: { slots: [] }, market: { goods, orders: [] }, places: { freeport: { resources: { curios: 900 } } } });
  const mem = { orbit: { run: { good: 'phase_cells', squeezed: true } } };
  const t = new Trade(m, mem, profiles.get('scavenger'), null, rngFrom(1));
  assert.deepEqual(t.chooseSelling(), []);
  delete mem.orbit.run.squeezed;
  assert.deepEqual(t.chooseSelling(), ['curios']);
});

test('full homes past level 5 take larger families or tighter spaces while the place can spare the goods', async () => {
  const H = config.expansion.classes.housing.options;
  const habitat = (extra = {}) => ({ id: 5, type: 'habitat', ring: 3, slot: 0, level: 5, ...extra });
  const { m, calls } = world({ places: {} });
  m.core().buildings = [habitat()];
  m.core().resources = { scrap: { amount: 5000, net: 30 }, biomass: { amount: 4000, net: 20 }, meals: { amount: 50, net: 1 } };
  const G = new Ground(m, { events: [] }, profiles.get('industrialist'));
  await G.households();
  assert.deepEqual(calls.map((c) => [c.body.option, c.body.enabled]), [['tighter_spaces', true]], 'not larger families: too few meals');
  assert.ok(H.tighter_spaces.inputsPerTick.scrap > 0);
  // the goods run out: switched off
  calls.length = 0;
  m.core().buildings = [habitat({ boosts: { tighter_spaces: 'starved' } })];
  await G.households();
  assert.deepEqual(calls.map((c) => [c.body.option, c.body.enabled]), [['tighter_spaces', false]]);
  // room in the homes already: nothing switched on
  calls.length = 0;
  m.core().buildings = [habitat()];
  m.v.colony.maxPopulation = 200;
  await G.households();
  assert.equal(calls.length, 0);
});

test('the money pit, past 2 million credits, takes a few listed orbital goods off the market now and then and jettisons them', async () => {
  const { Sink } = require('../bots/brain/sink');
  const P = profiles.get('moneypit');
  const goods = [
    { resource: 'lattice_cores', reference: 1400, band: [700, 2800], bids: [], asks: [{ price: 1300, qty: 1, maker: true }, { price: 1450, qty: 3, maker: false }] },
    { resource: 'null_alloy', reference: 1400, band: [700, 2800], bids: [], asks: [{ price: 1500, qty: 9, maker: false }, { price: 2000, qty: 50, maker: false }] },
    { resource: 'frames', reference: 216, band: [100, 400], bids: [], asks: [{ price: 200, qty: 500, maker: false }] },
    { resource: 'curios', reference: 30, band: [15, 60], bids: [], asks: [{ price: 30, qty: 400, maker: false }] },
  ];
  const market = { maxOpenOrders: 10, maxQty: 1000, ttlOptions: [100, 300, 1000], orders: [], goods };
  const station = (more = [], size = 6) => ({ slots: [['power_cells', 100], ['frames', 150], ['fittings', 110], ...more], size });
  // not rich enough: nothing
  let w = world({ station: station(), market, credits: 1500000 });
  await new Sink(w.m, { events: [] }, P, rngFrom(1)).turn();
  assert.equal(w.calls.length, 0);
  // rich: the orbital good with the most units others listed within 15% of the reference (null alloy: 9; its 2000 ask is
  // too dear, and lattice cores' cheaper ask is the market maker's), from its cheapest ask, a few units. Never frames, and
  // curios only when no orbital good qualifies, however many are listed.
  w = world({ station: station(), market, credits: 2500000 });
  const mem = { events: [] };
  const sink = new Sink(w.m, mem, P, rngFrom(1));
  await sink.turn();
  const buy = w.calls.find((c) => c.route === 'orbit-market');
  assert.ok(buy && buy.body.resource === 'null_alloy' && buy.body.side === 'buy' && buy.body.price === 1500, JSON.stringify(w.calls));
  assert.ok(buy.body.qty >= 1 && buy.body.qty <= 4);
  assert.deepEqual(mem.sink.goods, ['null_alloy']);
  // not again until the interval has passed
  w.calls.length = 0;
  await sink.turn();
  assert.equal(w.calls.length, 0);
  // a slot of what it bought, once it holds enough, is jettisoned and rebuilt
  w = world({ station: station([['null_alloy', 45]]), market, credits: 100 });
  await new Sink(w.m, { events: [], sink: { bought: 45, spent: 0, dumped: 0, at: 0, goods: ['null_alloy'] } }, P, rngFrom(1)).turn();
  assert.deepEqual(w.calls.map((c) => c.route), ['jettison', 'rebuild-slot']);
  // every slot taken: the fullest of its own goes to make room for the next buy
  w = world({ station: station([['null_alloy', 5], ['lattice_cores', 30], ['chiral_serum', 2]]), market, credits: 2500000 });
  await new Sink(w.m, { events: [], sink: { bought: 0, spent: 0, dumped: 0, at: 0, goods: ['null_alloy', 'lattice_cores', 'chiral_serum'] } }, P, rngFrom(1)).turn();
  assert.deepEqual(w.calls.map((c) => c.route), ['orbit-market'], 'it holds null alloy already, so no room is needed');
  // a good it holds no slot for: the fullest slot of its own goes first
  const only = { ...market, goods: [{ resource: 'resonators', reference: 1400, band: [700, 2800], bids: [], asks: [{ price: 1400, qty: 2, maker: false }] }] };
  w = world({ station: station([['null_alloy', 5], ['lattice_cores', 30], ['chiral_serum', 2]]), market: only, credits: 2500000 });
  await new Sink(w.m, { events: [], sink: { bought: 0, spent: 0, dumped: 0, at: 0, goods: ['null_alloy', 'lattice_cores', 'chiral_serum'] } }, P, rngFrom(1)).turn();
  assert.deepEqual(w.calls.map((c) => [c.route, c.body.slot === undefined ? c.body.resource : c.body.slot]), [['jettison', 4], ['rebuild-slot', 4], ['orbit-market', 'resonators']]);
  // no orbital good worth taking (the maker's ask only, or too dear): trade goods instead, in bigger lots
  const tradeOnly = { ...market, goods: [{ ...goods[0], asks: [goods[0].asks[0]] }, { ...goods[1], asks: [goods[1].asks[1]] }, goods[2], goods[3], { resource: 'tool_steel', reference: 68, band: [34, 136], bids: [], asks: [{ price: 70, qty: 100, maker: false }] }] };
  w = world({ station: station(), market: tradeOnly, credits: 2500000 });
  await new Sink(w.m, { events: [] }, P, rngFrom(1)).turn();
  const tb = w.calls.find((c) => c.route === 'orbit-market');
  assert.ok(tb && tb.body.resource === 'curios' && tb.body.qty >= P.sink.tradeLot[0] && tb.body.qty <= P.sink.tradeLot[1], JSON.stringify(w.calls));
});

test('the money pit settles once its station is up: no expansions, no launches, surplus out by convoy', async () => {
  const P = profiles.get('moneypit');
  const { Endgame } = require('../bots/brain/endgame');
  const cost = { frames: 15, fittings: 10 };
  const { m, calls } = world({ station: { slots: [] }, places: { greenbelt: { buildings: [lv5('hydroponics_bay', cost)], resources: { frames: 100, fittings: 100 } }, freeport: {} } });
  const mem = { events: [] };
  const G = new Ground(m, mem, P);
  assert.equal(G.settled(), true);
  assert.equal(await new Supply(m, mem, P, G).expand(m.byType('greenbelt'), 'hydroponics_bay'), false);
  m.v.orbital.site = { staging: {}, catapult: {}, command: {} };
  m.v.orbital.launch = { next: 'ring2', ready: 'ring2' };
  await new Endgame(m, mem, P, G, rngFrom(1)).turn();
  assert.ok(!calls.some((c) => c.route === 'launch' || c.route === 'launch-cycle'), JSON.stringify(calls));
  // the convoy takes anything it carries above 60% of the Core's cap, down to 40%
  calls.length = 0;
  m.core().resources = { ingots: { amount: 15000, net: 0 }, clean_water: { amount: 9000, net: 5 } };
  m.v.contracts = { export: {}, import: {} };
  m.v.market = { prices: { clean_water: { buy: 3 }, rations: { buy: 3 } } };
  m.v.resources = { clean_water: { amount: 9000, net: 5, ticksLeft: null }, rations: { amount: 9000, net: 5, ticksLeft: null } };
  await G.contracts();
  const ex = calls.filter((c) => c.route === 'contract' && c.body.side === 'export');
  assert.ok(ex.some((c) => c.body.resource === 'ingots' && c.body.amount > 0), JSON.stringify(ex));
  assert.ok(!ex.some((c) => c.body.resource === 'clean_water'), 'below 60%: kept');
});
