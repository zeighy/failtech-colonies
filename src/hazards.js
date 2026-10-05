'use strict';
// Hazards: a forecast, a strike on a fixed tick, and (for some) a lingering effect.
//
// Rules of the game:
//  * A hazard only *starts* (is forecast) while the player is active.
//  * Once forecast, the strike tick is fixed and fires whether or not the player is
//    logged in.
//  * At the strike the colony responds with whatever reserves it has. Each
//    requirement is satisfied in proportion to what is stocked; the stock is
//    spent. Fully prepared = the hazard is averted. Otherwise the effect applies
//    at a severity equal to the unprepared fraction (a prorated penalty).
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

// How ready is the colony for this hazard type right now?
function assess(config, type, hubLevel, inventory, defense) {
  const def = config.hazards.types[type];
  const scale = scaleFor(config, hubLevel);
  const reqs = def.requires.map((r) => {
    const need = Math.ceil(r.amount * scale);
    const have = r.kind === 'stock' ? (inventory[r.resource] || 0) : defense;
    return { kind: r.kind, resource: r.resource || null, label: r.label, need, have, frac: Math.min(1, have / need) };
  });
  const prep = reqs.reduce((s, r) => s + r.frac, 0) / reqs.length;
  return { reqs, prep };
}

// Effects of the currently active hazard, fed into sim.step.
function modifiersFor(config, hazard, buildings) {
  const mods = { outputMult: {}, disabled: new Set() };
  if (!hazard || hazard.state !== 'active') return mods;
  const def = config.hazards.types[hazard.type];
  const eff = def.effect;
  if (eff.kind === 'output_mult') {
    for (const b of eff.buildings) mods.outputMult[b] = 1 - (1 - eff.mult) * hazard.severity;
  } else if (eff.kind === 'disable_random') {
    const id = hazard.data.buildingId;
    if (buildings.some((b) => b.id === id)) mods.disabled.add(id);
  }
  return mods;
}

// Human-readable effect for the UI.
function describeEffect(config, hazard) {
  const def = config.hazards.types[hazard.type];
  const eff = def.effect;
  if (eff.kind === 'output_mult') {
    const m = 1 - (1 - eff.mult) * hazard.severity;
    return `${eff.buildings.map((b) => config.buildings[b].name).join(', ')} output ×${m.toFixed(2)}`;
  }
  if (eff.kind === 'disable_random') {
    const b = hazard.data.buildingName;
    return b ? `${b} offline` : 'One structure goes offline for a while';
  }
  if (eff.kind === 'raid') {
    const parts = Object.entries(eff.steal).map(([res, f]) => `${Math.round(f * hazard.severity * 100)}% of ${res === 'credits' ? 'credits' : config.resources[res].name}`);
    return `Raiders loot ${parts.join(', ')}`;
  }
  return '';
}

function eligibleTypes(config, hubLevel, lastType) {
  return Object.entries(config.hazards.types)
    .filter(([id, d]) => hubLevel >= d.minHubLevel && id !== lastType);
}

// Start a forecast if the colony is due one and the player is here to see it.
function maybeSchedule(config, c, globalTick, active) {
  if (!enabled() || !active || c.age < c.next_hazard_age) return null;
  if (store.loadHazard(c.id)) return null;
  const r = rng(c.id * 7919 + (c.hazard_count + 1) * 104729);
  const last = db.prepare("SELECT type FROM colony_hazards WHERE colony_id = ? ORDER BY id DESC LIMIT 1").get(c.id);
  const pool = eligibleTypes(config, c.hub_level, last && last.type);
  const options = pool.length ? pool : eligibleTypes(config, c.hub_level, null);
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

// Advance this colony's hazard by one tick. May change inventory/credits.
// ctx: { config, c, globalTick, active, inventory, credits, defense, buildings }
function advance(ctx) {
  const { config, c, globalTick, active } = ctx;
  let { inventory, credits } = ctx;
  const h = store.loadHazard(c.id);
  const ev = (kind, msg) => store.addEvent(c.id, globalTick, kind, msg, 'hazard');
  let lastEvent = 0;
  const log = (kind, msg) => { lastEvent = ev(kind, msg); };
  const gap = () => between(rng(c.id * 31 + c.hazard_count * 977), config.hazards.gapTicks);
  const setNext = () => db.prepare('UPDATE colonies SET next_hazard_age = ? WHERE id = ?').run(c.age + 1 + gap(), c.id);

  if (h && h.state === 'active' && globalTick >= h.ends_tick) {
    const def = config.hazards.types[h.type];
    db.prepare('DELETE FROM colony_hazards WHERE id = ?').run(h.id);
    db.prepare('UPDATE colonies SET hazards_survived = hazards_survived + 1 WHERE id = ?').run(c.id);
    log('good', `${def.name} has passed.`);
  } else if (h && h.state === 'forecast' && globalTick >= h.strikes_tick) {
    const def = config.hazards.types[h.type];
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
    const severity = Math.max(0, 1 - prep);
    setNext();
    if (severity < 0.02) {
      db.prepare('DELETE FROM colony_hazards WHERE id = ?').run(h.id);
      db.prepare('UPDATE colonies SET hazards_survived = hazards_survived + 1 WHERE id = ?').run(c.id);
      log('good', `${def.name} averted: the colony was fully prepared.${spentTxt}`);
    } else {
      const eff = def.effect;
      const pctTxt = `${Math.round(prep * 100)}% prepared`;
      if (eff.kind === 'output_mult') {
        const ends = globalTick + def.durationTicks;
        db.prepare("UPDATE colony_hazards SET state = 'active', ends_tick = ?, severity = ? WHERE id = ?").run(ends, severity, h.id);
        log('bad', `${def.name} hits (${pctTxt}).${spentTxt} ${describeEffect(config, { type: h.type, severity, data: {} })} for ${def.durationTicks} ticks.`);
      } else if (eff.kind === 'disable_random') {
        const pool = ctx.buildings;
        if (!pool.length) {
          db.prepare('DELETE FROM colony_hazards WHERE id = ?').run(h.id);
          log('info', `${def.name} struck an empty colony: nothing to break.`);
        } else {
          const r = rng(c.id * 13 + c.hazard_count * 7);
          const b = pool[Math.floor(r() * pool.length)];
          const dur = Math.max(1, Math.ceil(def.durationTicks * severity));
          const name = config.buildings[b.type].name;
          db.prepare("UPDATE colony_hazards SET state = 'active', ends_tick = ?, severity = ?, data = ? WHERE id = ?")
            .run(globalTick + dur, severity, JSON.stringify({ buildingId: b.id, buildingName: name }), h.id);
          log('bad', `${def.name} (${pctTxt}).${spentTxt} ${name} in ring ${b.ring} is offline for ${dur} ticks.`);
        }
      } else if (eff.kind === 'raid') {
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
        db.prepare('DELETE FROM colony_hazards WHERE id = ?').run(h.id);
        db.prepare('UPDATE colonies SET hazards_survived = hazards_survived + 1 WHERE id = ?').run(c.id);
        log('bad', `Raiders struck (${pctTxt}). ${lost.length ? `They looted ${lost.join(', ')}.` : 'They found little worth taking.'}`);
      }
    }
  } else if (!h) {
    maybeSchedule(config, c, globalTick, active);
  }

  // Someone watching live already saw this; only away players get a report.
  if (lastEvent && active) db.prepare('UPDATE colonies SET report_cursor = ? WHERE id = ?').run(lastEvent, c.id);
  return { inventory, credits };
}

module.exports = { assess, modifiersFor, describeEffect, advance, scaleFor, enabled, rng };
