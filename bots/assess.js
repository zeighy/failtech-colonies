'use strict';
// Before a bot takes a parked colony over, it looks at where the colony is heading. A parked colony is frozen exactly as its
// commander left it, so the view's rates are the rates it would wake up to. A colony already on its way to collapse is left
// alone: a bot that claims it would only preside over the end.
//
// The verdict is 'stable' (claim it), 'at_risk' (it could be saved, but the bot does not gamble on it), or 'collapsing'.
// `reasons` says why, for the runner's log.

// Could the colony stop a draining stock before it runs dry? It can if it has the plots, the stock to pay for the line that
// makes it (and for whatever feeds that line, when nothing makes that either, and a generator to run them) and the time to
// build them one after another. A colony that has only just been founded is like this: nothing made yet, but plenty to build with.
function canFix(v, config, res, ticks) {
  const B = config.buildings;
  const net = (r) => ((v.resources[r] || {}).net || 0);
  const inCore = (b) => !b.districts || b.districts.includes('core');
  const makers = (r) => Object.entries(B).filter(([, b]) => inCore(b) && !b.hidden && (b.outputsPerTick || {})[r] > 0 && !b.minHubLevel);
  const plan = [];
  const add = (r, depth) => {
    if (depth > 2) return false;
    if (plan.some((k) => (B[k].outputsPerTick || {})[r] > 0)) return true; // one line already planned makes it
    const opts = makers(r).sort((a, b) => Object.keys(a[1].inputsPerTick || {}).length - Object.keys(b[1].inputsPerTick || {}).length);
    for (const [k, b] of opts) {
      const inputs = Object.entries(b.inputsPerTick || {}).filter(([i]) => i !== 'energy');
      const before = plan.length;
      if (inputs.every(([i, q]) => net(i) >= q || add(i, depth + 1))) { plan.push(k); return true; }
      plan.length = before;
    }
    return false;
  };
  if (!add(res, 0)) return false;
  const e = v.energy || {};
  const stock = (r) => ((v.resources[r] || {}).amount || 0);
  // what the lines cost; a cost the stock cannot meet is made first, when something simple makes it (parts from scrap)
  let wait = 0;
  const making = new Set();
  for (let pass = 0; pass < 3; pass++) {
    const power = plan.reduce((n, k) => n + ((B[k].inputsPerTick || {}).energy || 0), 0);
    if ((!e.supply || e.supply - e.demand < power) && !plan.includes('solar_array')) plan.push('solar_array');
    const cost = {};
    for (const k of plan) for (const [r, q] of Object.entries(B[k].cost || {})) cost[r] = (cost[r] || 0) + q;
    const short = Object.entries(cost).filter(([r, q]) => stock(r) < q && !making.has(r));
    if (!short.length) break;
    if (pass === 2) return false;
    for (const [r, q] of short) {
      if (!add(r, 1)) return false;
      const made = plan.reduce((n, k) => n + ((B[k].outputsPerTick || {})[r] || 0) - ((B[k].inputsPerTick || {})[r] || 0), 0);
      if (!made) return false;
      making.add(r);
      wait += (q - stock(r)) / made;
    }
  }
  const caps = (v.hub && v.hub.rings) || {};
  const free = Object.values(caps).reduce((a, b) => a + b, 0) - (v.buildings || []).length - (v.orders || []).filter((o) => o.kind === 'build').length;
  if (free < plan.length) return false;
  const time = plan.reduce((n, k) => n + (B[k].constructionTicks || 0), 0) + wait + (v.orders || []).reduce((n, o) => n + (o.remaining || 0), 0);
  return time + 10 < ticks;
}

function assess(v, config) {
  const reasons = [];
  const fatal = [];
  if (!v || !v.colony) return { verdict: 'collapsing', score: 0, reasons: ['no colony'] };
  const c = v.colony;
  if (c.status && c.status !== 'active') fatal.push(`status ${c.status}`);
  if (c.shutdown) fatal.push('shut down');
  if ((c.starving || []).length) fatal.push(`starving (${c.starving.join(', ')})`);
  const min = config.global.minPopulation || 0;
  if (c.population <= min + 2) fatal.push(`population ${c.population} at the floor`);
  if (c.morale < 20) fatal.push(`morale ${Math.round(c.morale)}`);

  let score = 100;
  // the collapse clock: how long until a critical stock runs dry at these rates
  const doom = v.doom;
  if (doom && doom.phase === 'starving') fatal.push('collapse clock: starving');
  else if (doom && doom.phase === 'depleting') {
    // a deficit the treasury could cover from the convoy for a good while is a nuisance, not a death sentence
    const r = doom.resources[0];
    const res = v.resources[r];
    const price = ((v.market || {}).prices || {})[r] ? v.market.prices[r].buy : 10;
    const ticksBought = res && res.net < 0 ? c.credits / (price * -res.net) : Infinity;
    const runway = doom.ticks + Math.min(ticksBought, 2000);
    const fixable = (doom.draining || doom.resources.map((x) => ({ resource: x, ticks: doom.untilShortage }))).every((x) => canFix(v, config, x.resource, x.ticks + (doom.ticks - doom.untilShortage)));
    if (runway < 120 && fixable) { score -= 25; reasons.push(`${r} runs out in ${doom.untilShortage} ticks, but there is time and stock to build for it`); } else if (runway < 120) fatal.push(`collapse clock ${doom.ticks} ticks (${r})`);
    else if (runway < 480) { score -= 35; reasons.push(`${r} runs out in ${doom.untilShortage} ticks`); } else { score -= 10; reasons.push(`${r} slowly falling`); }
  }
  // the grid, the crews, the mood
  const e = v.energy;
  if (e && e.satisfaction < 0.5) fatal.push(`power at ${Math.round(e.satisfaction * 100)}%`);
  else if (e && e.satisfaction < 0.9) { score -= 20; reasons.push(`power at ${Math.round(e.satisfaction * 100)}%`); }
  const staff = c.staffing ? c.staffing.ratio : 1;
  if (staff < 0.4) fatal.push(`crews at ${Math.round(staff * 100)}%`);
  else if (staff < 0.75) { score -= 15; reasons.push(`crews at ${Math.round(staff * 100)}%`); }
  if (c.morale < 40) { score -= 20; reasons.push(`morale ${Math.round(c.morale)}`); }
  const out = (v.people || {}).outlook;
  if (out && out.state === 'shrinking') { score -= 25; reasons.push(`people leaving (${out.why || 'unknown'})`); }
  // water and food: what is on hand and where it is going (with the morale runway once a stock is gone)
  const runwayTicks = Math.ceil(c.morale / (100 / config.global.moraleFailureThresholdTicks));
  for (const r of ['clean_water', 'rations']) {
    const x = v.resources[r];
    if (!x) continue;
    if (x.net < 0 && x.amount / -x.net < 200 && !canFix(v, config, r, x.amount / -x.net + runwayTicks)) { score -= 20; reasons.push(`${r} ${Math.round(x.amount)} falling ${x.net.toFixed(1)}/tick`); }
  }
  if (c.failures > 2) { score -= 10; reasons.push(`${c.failures} collapses before`); }
  if (fatal.length) return { verdict: 'collapsing', score: 0, reasons: fatal.concat(reasons) };
  return { verdict: score >= 60 ? 'stable' : score >= 30 ? 'at_risk' : 'collapsing', score, reasons };
}

module.exports = { assess, canFix };
