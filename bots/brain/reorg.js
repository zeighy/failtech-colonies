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
const bd0 = (m, b) => m.def(b.type) || {};
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
      if (b.recipe && bd0(m, b).recipeBuilding) continue; // a configured workshop cannot be replaced, only scrapped
      const bd = m.def(b.type);
      if (!bd || bd.hidden === 'orbital') continue;
      if (m.plotOf(d, b.ring) < (def.minPlotSize || 1)) continue;
      if (this.m.orders(d).some((o) => o.data && o.data.ring === b.ring && o.data.slot === b.slot)) continue;
      const extra = (counts[b.type] || 0) - (want[b.type] || 0);
      // a type it put somewhere itself lately, or a type this place is itself asking for, is never given up: that is how a
      // reorganiser goes round in circles
      if ((this.r.recent || {})[`${d.id}:${b.type}`] > m.tick - 3000) continue;
      if ((this.mem.wanted || {})[`${d.id}:${b.type}`]) continue;
      const idle = b.eff !== undefined && b.eff < 0.05 && !b.paused && (!d.energy || d.energy.satisfaction >= 0.9);
      // switched off because its output sits at the cap, and not the colony's last of its kind
      const capped = ((this.mem.supply || {}).paused || []).includes(b.id) && m.countAll(b.type) >= 2;
      // surplus means more than the plan wants of a kind the plan knows; a kind it does not plan (a player's reclamation
      // plant, say) is someone else's design and only gives way if it stands idle or its output has nowhere to go
      const surplus = (want[b.type] || 0) > 0 && extra > 0;
      if (!surplus && !idle && !capped) continue;
      // what it makes must still be coming in (or be plentiful) without it
      const eff = Math.max(0, Math.min(1, b.eff === undefined ? 1 : b.eff)) * (b.mult || 1);
      let fine = true;
      for (const [r, q] of Object.entries(bd.outputsPerTick || {})) {
        if (r === 'energy') { const e = d.energy || {}; if ((e.supply || 0) - q * eff < (e.demand || 0) * 1.1) fine = false; continue; }
        const vital = ['clean_water', 'rations', 'meals', 'unpurified_water'].includes(r);
        const after = m.net(d, r) - q * eff;
        if (vital ? after < 4 * this.P.safety : after < 0 && m.amount(d, r) < m.cap(d) * 0.5) fine = false;
      }
      if (!fine) continue;
      let score = 2 + (surplus ? extra : 0) + (idle ? 3 : 0) + (capped ? 3 : 0) + (b.paused ? 1 : 0);
      const outs = Object.keys(bd.outputsPerTick || {}).filter((r) => r !== 'energy');
      if (outs.length && outs.every((r) => m.amount(d, r) >= m.cap(d) * 0.85)) score += 3; // its output is piling up
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
      if (m.byType('freeport') && m.buildings(d).some((x) => x.type === type && x.xnext)) continue; // expanded instead (supply.js)
      if (!m.can(d, m.def(type).cost)) continue;
      const b = type === 'orbital_staging' ? await this.padSite(d) : this.victim(d, type);
      if (!b) continue;
      if (await m.act('replace', { ring: b.ring, slot: b.slot, type, district: d.id })) {
        this.r.done++; this.r.last[did] = m.tick; delete wanted[k]; (this.r.recent = this.r.recent || {})[`${did}:${type}`] = m.tick;
        this.mem.events.push(`reorganised: ${b.type} at ${d.type} ${b.ring}:${b.slot} -> ${type}`);
      }
    }
  }
}

module.exports = { Reorg };
