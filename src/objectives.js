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
  const next = config.hubLevels[v.colony.hubLevel + 1];
  const maxHub = Math.max(...Object.keys(config.hubLevels).map(Number));
  const sustain = config.global.goalSustainTicks;
  const base = config.hubLevels[v.colony.hubLevel].baseEnergy;
  return [
    { id: 'power', title: 'Lights out',
      hint: "The hub's own supply won't carry much. Everything that wants energy competes for the same grid, and a shortfall slows all of it.",
      done: v.energy.supply > base + EPS },
    { id: 'scrap', title: 'Running on fumes',
      hint: 'Scrap pays for every structure and some machines eat it. The cache only ever goes down unless something is digging.',
      done: made('scrap') },
    { id: 'parts', title: 'Components',
      hint: "The advanced structures need parts you aren't holding. Nobody sells them cheaply, and they don't appear on their own.",
      done: made('machined_parts') },
    { id: 'water', title: 'Something drinkable', timing: () => deadlineFor(config, v, 'clean_water'),
      hint: "Water from the ground is poison. The colony drinks from clean tanks, and the tanks are draining.",
      done: made('clean_water') },
    { id: 'food', title: 'Something edible', timing: () => deadlineFor(config, v, 'rations'),
      hint: "Rations don't appear on their own. Growing food needs light, clean water and components, and it takes time to build.",
      done: made('rations') },
    { id: 'adjacency', title: 'Good neighbours',
      hint: "Placement matters. Inspect a structure to see who sits beside it, and think about who shouldn't.",
      done: v.buildings.some((b) => b.mult > 1 + EPS) },
    { id: 'steady', title: 'Break even', live: true,
      hint: 'Everything the colony consumes must be replaced. Watch the green and red rates beside your stockpiles and the grid at the top.',
      done: made('clean_water') && made('rations') && netOf('clean_water') >= -EPS && netOf('rations') >= -EPS && v.energy.satisfaction >= 1 - EPS },
    { id: 'market', title: 'Open the market', timing: () => ({ kind: 'convoy', ticks: v.convoy.ticksLeft }),
      hint: 'A convoy passes on a schedule. It only trades what you arranged before it arrived, and it pays for surplus.',
      done: Object.keys(v.contracts.export).length + Object.keys(v.contracts.import).length > 0 },
    { id: 'hub2', title: 'Room to grow', timing: () => (next ? etaFor(v, next.upgradeCost) : null),
      hint: 'The first ring fills quickly. The hub itself can be pushed further, at a price, and more of the map opens up with it.',
      done: v.colony.hubLevel >= 2 },
    { id: 'materials', title: 'Heavy lifting',
      hint: 'The largest upgrade wants a material nobody mines. Something has to forge it, and that something has to be unlocked first.',
      done: made('building_materials') || v.resources.building_materials.amount >= 1 },
    { id: 'hub3', title: 'Final tier', timing: () => (v.colony.hubLevel === maxHub - 1 ? etaFor(v, next.upgradeCost) : null),
      hint: 'One more push of the hub. It will not be cheap, and the colony has to survive the wait.',
      done: v.colony.hubLevel >= maxHub },
    { id: 'hold', title: 'Hold the line', live: true,
      hint: `Power, water and food all in surplus, with the hub at its peak, for ${sustain} ticks running.`,
      progress: { value: v.colony.won ? sustain : v.colony.goalTicks, max: sustain },
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
