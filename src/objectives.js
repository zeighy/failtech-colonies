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
    .filter(([, d]) => (d.outputsPerTick[res] || 0) > 0 && (!d.minHubLevel || d.minHubLevel <= lvl));
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
    { id: 'storm', title: 'Trouble comes with a warning',
      hint: 'Something will eventually be headed your way. What the colony has in reserve when it lands decides how badly it hurts.',
      done: v.colony.hazardsSurvived >= 1 },
    { id: 'materials', title: 'Heavy lifting',
      hint: 'The larger upgrades want a material nobody mines. Something has to forge it, and that something wants a bigger plot.',
      done: made('building_materials') || v.resources.building_materials.amount >= 1 },
    { id: 'hub3', title: "The crown's price", ...hubGoal(3),
      hint: 'A bigger hub is a hungrier one. From here it draws on the colony just to stay standing, so plan for the drain before you pay for it.' },
    { id: 'synth', title: 'Something synthetic',
      hint: 'The old world left plastics in the wreckage. They are where anything delicate begins.',
      done: made('raw_synthetics') || v.resources.raw_synthetics.amount >= 1 },
    { id: 'alloys', title: 'Hard metal',
      hint: 'Structural metals need furnaces, and furnaces need room to breathe.',
      done: made('alloys') || v.resources.alloys.amount >= 1 },
    { id: 'circuits', title: 'Fine work',
      hint: 'Precision parts need synthetics, patience, and a plot that gives them space.',
      done: made('circuits') || v.resources.circuits.amount >= 1 },
    { id: 'hub4', title: 'A wider circle', ...hubGoal(4),
      hint: 'Another ring, another bill. The upkeep climbs, and it now includes things you had to make.' },
    { id: 'cells', title: 'Concentrated power',
      hint: 'Something has to combine your best metals and your finest circuits into a compact power source. It is the most demanding thing you will build.',
      done: made('power_cells') || v.resources.power_cells.amount >= 1 },
    { id: 'hub5', title: 'The far ring', ...hubGoal(5),
      hint: 'The outermost ring has plots big enough for anything. The hub has to be strong enough to open it.' },
    { id: 'beacon', title: 'Reach out', timing: () => (hasBuilding('beacon_array') ? null : etaFor(v, beacon.cost)),
      hint: 'A transmitter big enough to be heard across the wastes wants the largest plot, the finest materials, and a great deal of power.',
      done: hasBuilding('beacon_array') },
    { id: 'transmit', title: 'Hold the signal', live: true,
      hint: 'It has to keep running, powered and supplied, until the message gets through. Anything that interrupts it costs you time.',
      progress: { value: Math.floor(v.colony.won ? need : v.colony.progress), max: need },
      done: v.colony.won },
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
    return { id: d.id, title: d.title, hint: d.hint, done, live: !!d.live, progress: d.progress || null, timing: null, _t: d.timing };
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

module.exports = { evaluate, doomClock, ticksToAfford, leadTimeFor };
