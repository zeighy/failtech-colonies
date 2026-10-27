'use strict';
// Onboarding directives and the "doom clock". Pure: takes the config plus the
// colony view built in state.js and returns what the Brief tab renders.
//
// Directives deliberately hint at *what is missing*, never *what to press*.
// Milestones are sticky (persisted by the caller) so a temporary stall does not
// un-tick progress; `live` directives always reflect the current state.

const EPS = 1e-6;

// ---- doom clock -------------------------------------------------------------
// Ticks until collapse if nothing changes: time until a critical stock runs
// dry, plus the morale runway after that (morale falls a fixed amount per tick).
function doomClock(config, v) {
  const g = config.global;
  const runway = Math.ceil(v.colony.morale / (100 / g.moraleFailureThresholdTicks) - EPS);
  if (v.colony.starving.length) {
    return { phase: 'starving', ticks: runway, untilShortage: 0, resources: v.colony.starving };
  }
  let soonest = null;
  const draining = [];
  for (const [res, def] of Object.entries(config.resources)) {
    if (!def.critical) continue;
    const r = v.resources[res];
    if (r.ticksLeft === null) continue;
    const t = Math.ceil(r.ticksLeft - EPS);
    draining.push({ resource: res, ticks: t });
    if (soonest === null || t < soonest.ticks) soonest = { resource: res, ticks: t };
  }
  if (!soonest) return null;
  return { phase: 'depleting', ticks: soonest.ticks + runway, untilShortage: soonest.ticks, resources: [soonest.resource], draining };
}

// ---- helpers ----------------------------------------------------------------
// How long until the colony could pay `cost` at current net income, or which
// resources have no income at all (so no estimate is possible).
function affordInfo(v, cost) {
  let ticks = 0;
  const blocked = [];
  for (const [res, amt] of Object.entries(cost)) {
    const short = amt - v.resources[res].amount;
    if (short <= EPS) continue;
    const net = v.resources[res].net;
    if (net <= EPS) blocked.push(res);
    else ticks = Math.max(ticks, Math.ceil(short / net));
  }
  return { ticks: blocked.length ? null : ticks, blocked };
}
const ticksToAfford = (v, cost) => affordInfo(v, cost).ticks;

// Earliest completion of the structure that produces `res`, given what the
// colony owns, has queued, and earns right now. { lead: ticks|null, blocked: [res] }
function leadTimeFor(config, v, res) {
  const lvl = v.colony.hubLevel;
  const candidates = Object.entries(config.buildings)
    .filter(([, d]) => (d.outputsPerTick[res] || 0) > 0 && (!d.minHubLevel || d.minHubLevel <= lvl) && (!d.districts || d.districts.includes('core')));
  let best = { lead: null, blocked: [] };
  for (const [id, d] of candidates) {
    const queued = v.orders.find((o) => o.kind === 'build' && o.data.type === id);
    let lead; let blocked = [];
    if (queued) lead = queued.remaining;
    else if (v.buildings.some((b) => b.type === id)) lead = 0;
    else {
      const a = affordInfo(v, d.cost);
      blocked = a.blocked;
      lead = a.ticks === null ? null : a.ticks + d.constructionTicks;
    }
    if (lead !== null && (best.lead === null || lead < best.lead)) best = { lead, blocked: [] };
    else if (lead === null && best.lead === null) best = { lead: null, blocked };
  }
  return best;
}

function slackStatus(slack) {
  return slack < 0 ? 'late' : slack < 8 ? 'tight' : 'ok';
}

// A survival directive's schedule: how long the stock lasts vs. how soon the
// colony could realistically have something producing.
function deadlineFor(config, v, res) {
  const r = v.resources[res];
  if (r.ticksLeft === null) return { kind: 'deadline', status: 'ok', stockTicks: null, lead: null, blocked: [] };
  const stock = Math.floor(r.ticksLeft + EPS);
  const { lead, blocked } = leadTimeFor(config, v, res);
  // No estimate possible: something it needs has no income yet. Not "late", but not safe either.
  if (lead === null) return { kind: 'deadline', status: 'blocked', stockTicks: stock, lead: null, blocked };
  return { kind: 'deadline', status: slackStatus(stock - lead), stockTicks: stock, lead, blocked: [] };
}

function etaFor(v, cost) {
  const info = affordInfo(v, cost);
  return { kind: 'eta', ticks: info.ticks, affordable: info.ticks === 0, blocked: info.blocked };
}

const DIRECTIVES = (config, v) => {
  const netOf = (r) => v.resources[r].net;
  const made = (r) => v.resources[r].produced > EPS;
  const madeAny = (r) => Object.values(v.views || {}).some((d) => d.resources[r] && (d.resources[r].produced > EPS || d.resources[r].amount >= 1));
  const lvl = v.colony.hubLevel;
  const nextLevel = config.hubLevels[lvl + 1];
  const hubGoal = (n) => ({ done: lvl >= n, timing: () => (lvl === n - 1 ? etaFor(v, config.hubLevels[n].upgradeCost) : null) });
  const need = config.global.beacon.transmitTicks;
  const beacon = config.buildings.beacon_array;
  const hasBuilding = (type) => v.buildings.some((b) => b.type === type);
  return [
    { id: 'power', title: 'Lights out',
      hint: "The hub's own supply won't carry much. Everything that wants energy competes for the same grid, and a shortfall slows all of it.",
      done: v.buildings.some((b) => config.buildings[b.type].type === 'generator') },
    { id: 'scrap', title: 'Running on fumes',
      hint: 'Scrap pays for every structure and some machines eat it. The cache only ever goes down unless something is digging.',
      done: made('scrap') },
    { id: 'parts', title: 'Components',
      hint: "The advanced structures need parts you aren't holding. Nobody sells them cheaply, and they don't appear on their own.",
      done: made('machined_parts') },
    { id: 'water', title: 'Something drinkable', timing: () => deadlineFor(config, v, 'clean_water'),
      hint: 'Water from the ground is poison. The colony drinks from clean tanks, and the tanks are draining.',
      done: made('clean_water') },
    { id: 'food', title: 'Something edible', timing: () => deadlineFor(config, v, 'rations'),
      hint: "Rations don't appear on their own. Growing food needs light, clean water and components, and it takes time to build.",
      done: made('rations') },
    { id: 'adjacency', title: 'Good neighbours',
      hint: 'Placement matters. Inspect a structure to see who sits beside it, and think about who shouldn\'t.',
      done: v.buildings.some((b) => b.adj > 1 + EPS) },
    { id: 'steady', title: 'Break even', live: true,
      hint: 'Everything the colony consumes must be replaced. Watch the green and red rates beside your stockpiles and the grid at the top.',
      done: made('clean_water') && made('rations') && netOf('clean_water') >= -EPS && netOf('rations') >= -EPS && v.energy.satisfaction >= 1 - EPS },
    { id: 'market', title: 'Open the market', timing: () => ({ kind: 'convoy', ticks: v.convoy.ticksLeft }),
      hint: 'A convoy passes on a schedule, at prices that move. It only trades what you arranged before it arrived, and it pays for surplus.',
      done: Object.keys(v.contracts.export).length + Object.keys(v.contracts.import).length > 0 },
    { id: 'hub2', title: 'Room to grow', ...hubGoal(2),
      hint: 'The first ring fills quickly. The hub itself can be pushed further, at a price, and more of the map opens up with it.' },
    { id: 'plots', title: 'Elbow room',
      hint: 'Some structures want more room than the inner rings offer. A cramped plot still works, at a cost. The outer rings are bigger.',
      done: v.buildings.some((b) => config.buildings[b.type].minPlotSize > 1 && b.plot >= 1 - EPS) },
    { id: 'housing', title: 'A roof overhead',
      hint: "The hub's own quarters only hold so many, and machines need people to run them. More homes mean more hands, and more hands mean more can run at once.",
      done: v.buildings.some((b) => config.buildings[b.type].housing) },
    { id: 'meals', title: 'Something worth eating',
      hint: 'Bare rations keep people alive, not happy. A proper meal does something rations never will, and it starts with the rations you already make.',
      done: made('meals') || v.resources.meals.amount >= 1 },
    { id: 'quiet', title: 'A quiet corner',
      hint: 'People sleep badly beside furnaces and diggers. Where the homes go decides how the neighbourhood feels, and a good meal can only offset so much.',
      done: v.buildings.some((b) => b.comfort !== null && b.comfort !== undefined && b.comfort >= 0) },
    { id: 'storm', title: 'Trouble comes with a warning',
      hint: 'Something will eventually be headed your way. What the colony has in reserve when it lands decides how badly it hurts.',
      done: v.colony.hazardsSurvived >= 1 },
    { id: 'materials', title: 'Heavy lifting',
      hint: 'The larger upgrades want a material nobody mines. Something has to forge it, and that something wants a bigger plot.',
      done: made('building_materials') || v.resources.building_materials.amount >= 1 },
    { id: 'hub3', title: "The crown's price", ...hubGoal(3),
      hint: 'A bigger hub is a hungrier one. From here it draws on the colony just to stay standing, so plan for the drain before you pay for it.' },
    { id: 'alloys', title: 'Hard metal',
      hint: 'Structural metals need furnaces, and furnaces need room to breathe.',
      done: made('alloys') || v.resources.alloys.amount >= 1 },
    { id: 'hub4', title: 'A wider circle', ...hubGoal(4),
      hint: 'Another ring, another bill. The upkeep climbs, and it now includes things you had to make.' },
    { id: 'district', title: 'Beyond the walls',
      hint: 'The hub is wide enough to reach past its own rings. Somewhere out there is ground worth holding, and it will need to be paid for from your own stockpile.',
      done: (v.districts || []).length > 1 },
    { id: 'ore', title: 'Raw from the ground',
      hint: 'A satellite makes its own power and keeps its own stockpile. Whatever it digs up has to be fed and powered before it is any use to the colony.',
      done: Object.values(v.views || {}).some((d) => !d.core && ((d.resources.ore && d.resources.ore.amount > 0) || (d.resources.ingots && d.resources.ingots.amount > 0))) },
    { id: 'route', title: 'Keep it flowing',
      hint: 'Hauling goods by hand does not scale. Some things are needed every tick, and a standing arrangement can bring them without you. Mind how much the road can carry.',
      done: (v.routes || []).length > 0 },
    { id: 'exchange', title: 'Name your price',
      hint: 'The convoy takes what it is offered at its own prices. Somewhere there is a place where you can say what you will pay, or what you will take, and wait for someone to agree.',
      done: !!(v.exchange && v.exchange.activity) },
    { id: 'synth', title: 'Something synthetic',
      hint: 'Plastics and fine chemistry come from the old refineries, a long way from the hub. Whoever works there will need metal they cannot make.',
      done: madeAny('raw_synthetics') || madeAny('polymers') },
    { id: 'circuits', title: 'Fine work',
      hint: 'Precision parts need synthetics, a chemical ingredient, patience, and a plot that gives them space.',
      done: madeAny('circuits') },
    { id: 'cells', title: 'Concentrated power',
      hint: 'Something has to combine your best metals and your finest circuits into a compact power source. It is the most demanding thing you will build.',
      done: madeAny('power_cells') },
    { id: 'medicine', title: 'Something to heal with',
      hint: 'The last materials for the transmitter are grown, not forged, in the one place that still has clean ground. It will want chemistry and plastics from elsewhere.',
      done: madeAny('medicine') },
    { id: 'hub5', title: 'The far ring', ...hubGoal(5),
      hint: 'The outermost ring has plots big enough for anything. The hub has to be strong enough to open it.' },
    { id: 'beacon', title: 'Reach out', timing: () => (hasBuilding('beacon_array') ? null : etaFor(v, beacon.cost)),
      hint: 'A transmitter big enough to be heard across the wastes wants the largest plot, the finest materials, and a great deal of power.',
      done: hasBuilding('beacon_array') },
    { id: 'transmit', title: 'Hold the signal', live: true,
      hint: 'It has to keep running, powered and supplied, until the message gets through. Anything that interrupts it costs you time.',
      progress: { value: Math.floor(v.colony.won ? need : v.colony.progress), max: need },
      done: v.colony.won },
    { id: 'harbour', title: 'Someone heard',
      hint: 'The signal reached something. There is a place now that will take anything you can make, and it is not short of ways to waste your time. It will want paying for, in full.',
      done: (v.districts || []).some((d) => d.type === 'freeport') },
    { id: 'mission', title: 'A name in the harbour',
      hint: 'People there post what they need and name what they will pay. Doing someone a favour is a kind of currency, though nobody has said what it buys.',
      done: !!(v.missions && v.missions.filled > 0) },
  ];
};

// `persisted`: ids already earned (sticky). Returns the view fragment plus the
// full set of done ids so the caller can persist new ones.
function evaluate(config, v, persisted = []) {
  const earned = new Set(persisted);
  const items = DIRECTIVES(config, v);
  const doneIds = [];
  const list = items.map((d) => {
    const done = d.live ? d.done : (earned.has(d.id) || d.done);
    if (done && !d.live) doneIds.push(d.id);
    const t = (config.theme && config.theme.directives[d.id]) || d;
    return { id: d.id, title: t.title, hint: t.hint, done, live: !!d.live, progress: d.progress || null, timing: null, _t: d.timing };
  });
  const current = list.findIndex((d) => !d.done);
  list.forEach((d, i) => {
    d.current = i === current;
    if (!d.done && d._t) d.timing = d._t();
    delete d._t;
  });
  return {
    list, doneIds,
    remaining: list.filter((d) => !d.done).length,
    doom: doomClock(config, v),
  };
}

// Every directive id, in Brief order. Content (themes, story triggers) is validated against this list.
const DIRECTIVE_IDS = ['power',  'scrap',  'parts',  'water',  'food',  'adjacency',  'steady',  'market',  'hub2',  'plots',  'housing',  'meals',  'quiet',  'storm',  'materials',  'hub3',  'alloys',  'hub4',  'district',  'ore',  'route',  'exchange',  'synth',  'circuits',  'cells',  'medicine',  'hub5',  'beacon',  'transmit',  'harbour',  'mission'];

module.exports = { DIRECTIVE_IDS, evaluate, doomClock, ticksToAfford, leadTimeFor };
