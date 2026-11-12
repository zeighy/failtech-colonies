'use strict';
// Reorganising a colony: when something the bot needs has no free plot (another purifier, a habitat, a launch pad), a
// building the place can do without gives up its plot, through the queue's replace-in-place. A colony taken over from a
// player is often laid out for a different plan; this is how it is brought round, one plot at a time, never touching what
// keeps people alive or what the plan still counts on.
const { CORE_PLAN, PLANS, LATE } = require('./ground');
const { fpPlan } = require('./endgame');

// Never replaced
const KEEP = new Set(['beacon_array', 'orbital_staging', 'orbital_catapult', 'orbital_command', 'habitat', 'dormitory', 'warehouse']);
// What people live on: kept unless there is plenty of it
const VITAL = { water_purifier: 'clean_water', hydroponics_bay: 'rations', water_pump: 'unpurified_water', kitchen: 'meals' };

class Reorg {
  constructor(m, mem, P, ground) { this.m = m; this.mem = mem; this.P = P; this.G = ground; mem.reorg = mem.reorg || { done: 0, last: {} }; this.r = mem.reorg; }

  // How many of each building the plan wants in this place at its level (plus what it has asked for since).
  planned(d) {
    const late = this.m.v.colony.won;
    const list = d.type === 'core' ? CORE_PLAN.concat(late ? LATE.core : []) : d.type === 'freeport' ? fpPlan(this.P).map((x) => (Array.isArray(x) ? x[0] : x)) : (PLANS[d.type] || []).concat(late ? LATE[d.type] || [] : []);
    const out = {};
    for (const it of list) {
      if (it === 'orbit') continue;
      if (it.startsWith('wait:')) { if (d.level < Number(it.split(':')[1])) break; continue; }
      out[it] = (out[it] || 0) + 1;
    }
    return out;
  }

  // The building in this place that can best give up a plot big enough for `type`, or null.
  victim(d, type) {
    const m = this.m;
    const def = m.def(type);
    const want = this.planned(d);
    const counts = {};
    for (const b of m.buildings(d)) counts[b.type] = (counts[b.type] || 0) + 1;
    let best = null;
    for (const b of m.buildings(d)) {
      if (b.type === type || KEEP.has(b.type)) continue;
      const bd = m.def(b.type);
      if (!bd || bd.hidden === 'orbital') continue;
      if (m.plotOf(d, b.ring) < (def.minPlotSize || 1)) continue;
      if (this.m.orders(d).some((o) => o.data && o.data.ring === b.ring && o.data.slot === b.slot)) continue;
      let score = 0;
      const extra = (counts[b.type] || 0) - (want[b.type] || 0);
      if (extra > 0) score += 2 + extra; // more of these than the plan wants
      if (b.eff !== undefined && b.eff < 0.05 && !b.paused) score += 3; // standing idle (nothing to work with)
      if (b.paused) score += 1;
      // what it makes is piling up against the cap
      const outs = Object.keys(bd.outputsPerTick || {}).filter((r) => r !== 'energy');
      if (outs.length && outs.every((r) => m.amount(d, r) >= m.cap(d) * 0.85)) score += 3;
      // never what feeds or waters the colony while that is not plentiful
      const vital = VITAL[b.type];
      if (vital && !(m.net(d, vital) > 8 * this.P.safety && m.amount(d, vital) > m.cap(d) * 0.5)) continue;
      // nor a generator while the grid is short
      if (bd.type === 'generator' && d.energy && d.energy.satisfaction < 1.05 && extra <= 0) continue;
      if (score < 3) continue;
      if (!best || score > best.score) best = { b, score };
    }
    return best && best.b;
  }

  // The launch pads need two Colossal plots side by side: a building on one gives way, and its neighbour is cleared too
  // unless it is already free.
  async padSite(d) {
    const m = this.m;
    const taken = m.used(d);
    const nb = m.neighbours(d.type);
    const ok = (b) => b && !KEEP.has(b.type) && m.def(b.type).hidden !== 'orbital' && !VITAL[b.type];
    const at = new Map(m.buildings(d).map((b) => [`${b.ring}:${b.slot}`, b]));
    const big = m.buildings(d).filter((b) => m.plotOf(d, b.ring) >= 5 && ok(b));
    for (const b of big) {
      const mates = (nb.get(`${b.ring}:${b.slot}`) || []).filter(([r]) => m.plotOf(d, r) >= 5);
      if (mates.some(([r, s]) => !taken.has(`${r}:${s}`))) return b;
    }
    for (const b of big) {
      const mate = (nb.get(`${b.ring}:${b.slot}`) || []).map(([r, s]) => at.get(`${r}:${s}`)).find((x) => x && m.plotOf(d, x.ring) >= 5 && ok(x));
      if (mate && await m.act('demolish', { ring: mate.ring, slot: mate.slot, district: d.id })) { this.mem.events.push(`cleared ${mate.type} for the launch pads`); return b; }
    }
    return null;
  }

  async turn() {
    const m = this.m;
    const wanted = this.mem.wanted || {};
    for (const [k, at] of Object.entries(wanted)) {
      if (m.tick - at > 40) { delete wanted[k]; continue; }
      const [did, type] = k.split(':');
      const d = m.v.views[did];
      if (!d || !m.def(type)) { delete wanted[k]; continue; }
      if (m.orders(d).some((o) => o.kind === 'replace')) continue; // one at a time per place
      if (type !== 'orbital_staging' && this.G.place(d, type)) { delete wanted[k]; continue; } // room has appeared
      if (this.r.last[did] && m.tick - this.r.last[did] < 60) continue;
      if (!m.can(d, m.def(type).cost)) continue;
      const b = type === 'orbital_staging' ? await this.padSite(d) : this.victim(d, type);
      if (!b) continue;
      if (await m.act('replace', { ring: b.ring, slot: b.slot, type, district: d.id })) {
        this.r.done++; this.r.last[did] = m.tick; delete wanted[k];
        this.mem.events.push(`reorganised: ${b.type} at ${d.type} ${b.ring}:${b.slot} -> ${type}`);
      }
    }
  }
}

module.exports = { Reorg };
