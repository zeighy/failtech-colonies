'use strict';
// Hazards: a forecast, a strike on a fixed tick, then a period of consequences.
//
// Rules of the game:
//  * A hazard only *starts* (is forecast) while the player is active.
//  * Once forecast, the strike tick is fixed and fires whether or not the player is
//    logged in.
//  * At the strike the colony spends its reserves in proportion to what it has
//    (prep = how much of the requirement it could meet).
//  * The hazard then runs for `durationTicks`, whatever the outcome:
//      - the *failure* effect (output cuts, degraded buildings, higher consumption,
//        looting) applies at severity = 1 - prep;
//      - a *mitigated* cost (maintenance drain, extra consumption) applies in
//        proportion to prep: weathering a hazard is never free.
const store = require('./db');
const { db } = store;

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (r, [lo, hi]) => lo + Math.floor(r() * (hi - lo + 1));

const enabled = () => process.env.HAZARDS !== 'off';
const scaleFor = (config, hubLevel) => 1 + config.hazards.scalingPerHubLevel * (hubLevel - 1);
const gapFactor = (config, hubLevel) => Math.max(config.hazards.gapFloor, 1 - config.hazards.gapShrinkPerHubLevel * (hubLevel - 1));
const countFor = (spec, hubLevel) => spec.baseCount + Math.floor((hubLevel - 1) / spec.levelsPerExtra);

// How ready is the colony for this hazard type right now?
function assess(config, type, hubLevel, inventory, defense) {
  const def = config.hazards.types[type];
  const scale = scaleFor(config, hubLevel);
  const reqs = def.requires.filter((r) => !r.fromHub || hubLevel >= r.fromHub).map((r) => {
    const need = Math.ceil(r.amount * scale);
    const have = r.kind === 'stock' ? (inventory[r.resource] || 0) : defense;
    return { kind: r.kind, resource: r.resource || null, label: r.label, need, have, frac: Math.min(1, have / need) };
  });
  const prep = reqs.reduce((s, r) => s + r.frac, 0) / reqs.length;
  return { reqs, prep };
}

const isRunning = (b) => b.status === 'active';

// Effects of the active hazard, fed into sim.step.
function modifiersFor(config, hazard, buildings) {
  const mods = { outputMult: {}, degraded: {}, disabled: new Set(), popConsumptionMult: 1, drain: {} };
  if (!hazard || hazard.state !== 'active') return mods;
  const def = config.hazards.types[hazard.type];
  if (!def) return mods;
  const sev = hazard.severity;
  const data = hazard.data || {};
  const prep = data.prep === undefined ? 1 - sev : data.prep;
  const eff = def.effect;
  const alive = (ids) => (ids || []).filter((id) => buildings.some((b) => b.id === id));

  if (sev > 0) {
    if (eff.kind === 'output_mult') {
      for (const b of eff.buildings) mods.outputMult[b] = 1 - (1 - eff.mult) * sev;
    } else if (eff.kind === 'degrade_random') {
      for (const id of alive(data.ids)) mods.degraded[id] = 1 - (1 - eff.mult) * sev;
    } else if (eff.kind === 'raid') {
      for (const id of alive(data.ids)) mods.degraded[id] = 1 - (1 - eff.damage.mult) * sev;
    } else if (eff.kind === 'pop_consumption') {
      mods.popConsumptionMult *= 1 + (eff.mult - 1) * sev;
    }
  }
  const m = def.mitigated;
  if (m && prep > 0) {
    if (m.kind === 'drain') {
      let amount = 0;
      const running = buildings.filter(isRunning);
      for (const [type, per] of Object.entries(m.perBuilding || {})) amount += per * running.filter((b) => b.type === type).length;
      if (m.perRunning) amount += m.perRunning * running.length;
      if (amount > 0) mods.drain[m.resource] = (mods.drain[m.resource] || 0) + amount * prep;
    } else if (m.kind === 'pop_consumption') {
      mods.popConsumptionMult *= 1 + (m.mult - 1) * prep;
    }
  }
  return mods;
}

// Human-readable consequences, for the UI and the event log.
// hazard: { type, severity, data:{prep, names?}, state:'active' }; buildings: current buildings.
function effectLines(config, hazard, buildings, hubLevel) {
  const def = config.hazards.types[hazard.type];
  const sev = hazard.severity;
  const data = hazard.data || {};
  const prep = data.prep === undefined ? 1 - sev : data.prep;
  const eff = def.effect;
  const lines = { penalty: [], cost: [] };
  const names = (list) => list.map((b) => config.buildings[b].name).join(', ');
  if (sev > 0.02) {
    if (eff.kind === 'output_mult') {
      lines.penalty.push(`${names(eff.buildings)} output ×${(1 - (1 - eff.mult) * sev).toFixed(2)}`);
    } else if (eff.kind === 'degrade_random') {
      const n = data.names ? data.names.length : countFor(eff, hubLevel);
      const who = data.names && data.names.length ? data.names.join(', ') : `${n} random structure${n === 1 ? '' : 's'}`;
      lines.penalty.push(`${who} at ×${(1 - (1 - eff.mult) * sev).toFixed(2)} efficiency`);
    } else if (eff.kind === 'raid') {
      const loot = Object.entries(eff.steal).map(([res, f]) => `${Math.round(f * sev * 100)}% of ${res === 'credits' ? 'credits' : config.resources[res].name}`);
      const n = data.names ? data.names.length : countFor(eff.damage, hubLevel);
      lines.penalty.push(`Loots ${loot.join(', ')}`);
      lines.penalty.push(`${n} outer structure${n === 1 ? '' : 's'} damaged (×${(1 - (1 - eff.damage.mult) * sev).toFixed(2)})`);
    } else if (eff.kind === 'pop_consumption') {
      lines.penalty.push(`Population consumption ×${(1 + (eff.mult - 1) * sev).toFixed(2)}`);
    }
  }
  const mods = modifiersFor(config, { type: hazard.type, state: 'active', severity: sev, data: { ...data, prep } }, buildings);
  const m = def.mitigated;
  if (m && prep > 0.02) {
    if (m.kind === 'drain') {
      const amt = mods.drain[m.resource] || 0;
      if (amt > 0.005) lines.cost.push(`${m.label}: −${amt.toFixed(1)} ${config.resources[m.resource].name}/tick`);
    } else if (m.kind === 'pop_consumption') {
      lines.cost.push(`${m.label}: consumption ×${(1 + (m.mult - 1) * prep).toFixed(2)}`);
    }
  }
  return lines;
}

function eligibleTypes(config, hubLevel, lastType, buildings) {
  return Object.entries(config.hazards.types)
    .filter(([id, d]) => hubLevel >= d.minHubLevel && id !== lastType
      && (!d.needsBuilding || buildings.some((b) => b.type === d.needsBuilding)));
}

// Start a forecast if the colony is due one and the player is here to see it.
function maybeSchedule(config, c, globalTick, active, buildings) {
  if (!enabled() || !active || c.age < c.next_hazard_age) return null;
  if (store.loadHazard(c.id)) return null;
  const r = rng(c.id * 7919 + (c.hazard_count + 1) * 104729);
  const last = db.prepare('SELECT type FROM colony_hazards WHERE colony_id = ? ORDER BY id DESC LIMIT 1').get(c.id);
  const pool = eligibleTypes(config, c.hub_level, last && last.type, buildings);
  const options = pool.length ? pool : eligibleTypes(config, c.hub_level, null, buildings);
  if (!options.length) return null;
  const total = options.reduce((s, [, d]) => s + d.weight, 0);
  let roll = r() * total;
  let pick = options[0];
  for (const o of options) { roll -= o[1].weight; if (roll <= 0) { pick = o; break; } }
  const [type, def] = pick;
  const warning = between(r, def.warningTicks);
  db.prepare("INSERT INTO colony_hazards (colony_id, type, state, strikes_tick) VALUES (?, ?, 'forecast', ?)").run(c.id, type, globalTick + warning);
  db.prepare('UPDATE colonies SET hazard_count = hazard_count + 1 WHERE id = ?').run(c.id);
  store.addEvent(c.id, globalTick, 'warn', `Forecast: ${def.name} in ${warning} ticks. Check the Brief tab for what the colony will need.`, 'forecast');
  return type;
}

// Which buildings does this strike hit? Raids hit the outermost; faults are random.
function pickTargets(effect, c, buildings, hubLevel) {
  const spec = effect.kind === 'raid' ? effect.damage : effect;
  if (!spec || !spec.baseCount) return [];
  const n = Math.min(countFor(spec, hubLevel), buildings.length);
  if (!n) return [];
  if (effect.kind === 'raid') {
    return buildings.slice().sort((a, b) => b.ring - a.ring || a.id - b.id).slice(0, n);
  }
  const r = rng(c.id * 13 + c.hazard_count * 7);
  const pool = buildings.slice();
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  return out;
}

// Advance this colony's hazard by one tick. May change inventory/credits.
// ctx: { config, c, globalTick, active, inventory, credits, defense, buildings }
function advance(ctx) {
  const { config, c, globalTick, active, buildings } = ctx;
  let { inventory, credits } = ctx;
  const h = store.loadHazard(c.id);
  const ev = (kind, msg) => store.addEvent(c.id, globalTick, kind, msg, 'hazard');
  let lastEvent = 0;
  const log = (kind, msg) => { lastEvent = ev(kind, msg); };
  const gap = () => {
    const [lo, hi] = config.hazards.gapTicks;
    const f = gapFactor(config, c.hub_level);
    return between(rng(c.id * 31 + c.hazard_count * 977), [Math.round(lo * f), Math.round(hi * f)]);
  };
  const setNext = () => db.prepare('UPDATE colonies SET next_hazard_age = ? WHERE id = ?').run(c.age + 1 + gap(), c.id);
  const survived = () => db.prepare('UPDATE colonies SET hazards_survived = hazards_survived + 1 WHERE id = ?').run(c.id);

  if (h && h.state === 'active' && globalTick >= h.ends_tick) {
    const def = config.hazards.types[h.type];
    db.prepare('DELETE FROM colony_hazards WHERE id = ?').run(h.id);
    survived();
    log('good', `${def.name} has passed.`);
  } else if (h && h.state === 'forecast' && globalTick >= h.strikes_tick) {
    const def = config.hazards.types[h.type];
    const eff = def.effect;
    const { reqs, prep } = assess(config, h.type, c.hub_level, inventory, ctx.defense);
    // The colony spends its reserves in proportion to how much it has.
    const spent = [];
    inventory = { ...inventory };
    for (const r of reqs) {
      if (r.kind !== 'stock') continue;
      const used = Math.floor(r.need * r.frac);
      if (used > 0) { inventory[r.resource] -= used; spent.push(`${used} ${config.resources[r.resource].name}`); }
    }
    const spentTxt = spent.length ? ` Spent ${spent.join(' and ')}.` : '';
    const severity = prep >= 0.98 ? 0 : Math.max(0, 1 - prep);
    const effPrep = severity === 0 ? 1 : prep;
    setNext();

    const targets = severity > 0 ? pickTargets(eff, c, buildings.filter(isRunning), c.hub_level) : [];
    const data = { prep: effPrep, ids: targets.map((b) => b.id), names: targets.map((b) => config.buildings[b.type].name) };

    let lootTxt = '';
    if (eff.kind === 'raid' && severity > 0) {
      const lost = [];
      for (const [res, frac] of Object.entries(eff.steal)) {
        if (res === 'credits') {
          const take = Math.floor(credits * frac * severity);
          if (take > 0) { credits -= take; lost.push(`${take} credits`); }
        } else {
          const take = Math.floor((inventory[res] || 0) * frac * severity);
          if (take > 0) { inventory[res] -= take; lost.push(`${take} ${config.resources[res].name}`); }
        }
      }
      lootTxt = lost.length ? ` They looted ${lost.join(', ')}.` : '';
    }

    const lines = effectLines(config, { type: h.type, state: 'active', severity, data }, buildings, c.hub_level);
    // Looting already happened; don't list it again as an ongoing effect.
    const ongoing = [...lines.penalty.filter((l) => !l.startsWith('Loots')), ...lines.cost];
    const pctTxt = `${Math.round(effPrep * 100)}% prepared`;
    if (!ongoing.length && !lootTxt) {
      db.prepare('DELETE FROM colony_hazards WHERE id = ?').run(h.id);
      survived();
      log('good', `${def.name} passed harmlessly (${pctTxt}).${spentTxt}`);
    } else {
      db.prepare("UPDATE colony_hazards SET state = 'active', ends_tick = ?, severity = ?, data = ? WHERE id = ?")
        .run(globalTick + def.durationTicks, severity, JSON.stringify(data), h.id);
      const head = severity === 0 ? `${def.name} weathered (${pctTxt}).` : `${def.name} hits (${pctTxt}).`;
      log(severity === 0 ? 'good' : severity < 0.5 ? 'warn' : 'bad',
        `${head}${spentTxt}${lootTxt}${ongoing.length ? ` For ${def.durationTicks} ticks: ${ongoing.join('; ')}.` : ''}`);
    }
  } else if (!h) {
    maybeSchedule(config, c, globalTick, active, buildings);
  }

  // Someone watching live already saw this; only away players get a report.
  if (lastEvent && active) db.prepare('UPDATE colonies SET report_cursor = ? WHERE id = ?').run(lastEvent, c.id);
  return { inventory, credits };
}

module.exports = { assess, modifiersFor, effectLines, advance, scaleFor, enabled, rng, countFor };
