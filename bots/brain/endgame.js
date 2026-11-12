'use strict';
// After the Beacon: the Free Port and its trade workshops, faction missions for standing, and once the orbit opens the
// launch chain (command center, staging platform, catapult), the launch cycle and the launch itself.
// Ported from the scripted player in scripts/playtest.js, with the Free Port plan counted by what stands (workshops by their
// recipe) so a colony someone else started is carried on rather than rebuilt.

// The goods the launch is made from, and what they need: frames (tool steel, plastics), fittings (precision tools, plastics,
// circuits), modules (frames, luxuries). Luxuries need preserves and curios. These workshops are built whatever the profile.
const LAUNCH_INPUTS = ['tool_steel', 'plastics', 'curios', 'preserves', 'precision_tools', 'luxuries'];
const LAUNCH_GOODS = ['frames', 'fittings', 'modules'];

// The Free Port, as [building, workshop recipe, plot size] with 'wait:N' and 'orbit' (hold until the orbital plans arrive).
function fpPlan(P) {
  const goods = [...new Set([...(P.workshops || []), ...LAUNCH_INPUTS])];
  const small = goods.filter((g) => !['precision_tools', 'luxuries'].includes(g)); // (those take goods made from the first ones)
  const big = goods.filter((g) => !small.slice(0, 4).includes(g));
  return [
    ['scrap_extractor'], ['scrap_extractor'], ['water_pump'],
    'wait:2', ['bio_dome'], ['bio_dome'], ['water_purifier'], ['bio_dome'], ['scrap_extractor'],
    'wait:3', ...small.slice(0, 3).map((g) => ['trade_workshop', g, 2]), ['fuel_generator', null, 2], ...small.slice(3, 4).map((g) => ['trade_workshop', g, 2]), ['fuel_generator', null, 2],
    'wait:4', ...big.slice(0, 5).map((g) => ['trade_workshop', g, 3]), ['fuel_generator', null, 3], ...big.slice(5).map((g) => ['trade_workshop', g, 3]),
    'wait:5', 'orbit', ['trade_workshop', 'frames', 4], ['trade_workshop', 'fittings', 4], ['trade_workshop', 'modules', 4], ['fuel_generator', null, 4], ['trade_workshop', 'frames', 4], ['trade_workshop', 'tool_steel', 4], ['fuel_generator', null, 4],
  ];
}

// What the Free Port is sent, as shares of its link (36 a tick of it is kept for the launch goods going out)
const fpLevel = (L, n) => (L.freeport || 0) >= n;
const fpShare = (w) => (L, K) => Math.max(1, Math.floor(w * Math.min(1, ((K.freeport || 0) - 36) / 186) * (fpLevel(L, 5) ? 1 : fpLevel(L, 4) ? 0.7 : 0.3)));
const LATE_ROUTES = [
  ['pits', 'freeport', 'ingots', fpShare(70), 40, (L) => fpLevel(L, 3)],
  ['stacks', 'freeport', 'polymers', fpShare(55), 40, (L) => fpLevel(L, 3)],
  ['stacks', 'freeport', 'fuel', fpShare(30), 40, (L) => fpLevel(L, 3)],
  ['stacks', 'freeport', 'reagents', fpShare(5), 40, (L) => fpLevel(L, 3)],
  ['core', 'freeport', 'machined_parts', fpShare(10), 150, (L) => fpLevel(L, 3)],
  ['stacks', 'freeport', 'circuits', fpShare(6), 30, (L) => fpLevel(L, 4)],
  ['core', 'freeport', 'alloys', fpShare(10), 150, (L) => fpLevel(L, 5)],
  ['pits', 'core', 'alloys', 12, 60, (L) => L.pits >= 4],
  ['stacks', 'core', 'fuel', 6, 40, (L) => L.stacks >= 4],
  ['stacks', 'core', 'power_cells', 3, 0, (L) => L.stacks >= 5],
];

const NAME_A = ['Halden', 'Corvel', 'Tessary', 'Ostrin', 'Calder', 'Pryne', 'Kessel', 'Brannock', 'Sallow', 'Wexley', 'Arden', 'Tirn', 'Morrow', 'Vashti', 'Lantry', 'Quell', 'Ember', 'Cassle', 'Dorran', 'Hesk'];
const NAME_B = ['Reach', 'Spindle', 'Anchor', 'Lantern', 'Hollow', 'Crown', 'Rest', 'Watch', 'Gate', 'Perch'];

class Endgame {
  constructor(m, mem, P, ground, rng) { this.m = m; this.mem = mem; this.P = P; this.G = ground; this.rng = rng; mem.fp = mem.fp || { pending: {} }; this.f = mem.fp; }

  // ---- the Free Port ----------------------------------------------------------------------------------------------
  async freePort(fp) {
    const m = this.m;
    const G = this.G;
    // a finished workshop is given its recipe (the first one is free): the one it was built for, else the one most short
    const plan = fpPlan(this.P);
    const want = {};
    for (const it of plan) if (Array.isArray(it) && it[1]) want[it[1]] = (want[it[1]] || 0) + 1;
    const have = {};
    for (const b of m.buildings(fp)) if (b.type === 'trade_workshop' && b.recipe) have[b.recipe] = (have[b.recipe] || 0) + 1;
    for (const b of m.buildings(fp)) {
      if (b.type !== 'trade_workshop' || b.recipe) continue;
      const k = `${b.ring}:${b.slot}`;
      const orbitOk = m.v.orbital.unlocked;
      const recipe = this.f.pending[k] || Object.keys(want).find((g) => (have[g] || 0) < want[g] && (orbitOk || !LAUNCH_GOODS.includes(g)));
      if (recipe && await m.act('recipe', { ring: b.ring, slot: b.slot, recipe, district: fp.id })) { have[recipe] = (have[recipe] || 0) + 1; delete this.f.pending[k]; }
    }
    // pending recipes for workshops still on order
    const queued = {};
    for (const o of m.orders(fp)) if (o.kind === 'build' && o.data.type === 'trade_workshop') { const r = this.f.pending[`${o.data.ring}:${o.data.slot}`]; if (r) queued[r] = (queued[r] || 0) + 1; }
    const seen = {};
    for (const item of plan) {
      fp = m.v.views[fp.id];
      if (item === 'orbit') { if (!m.v.orbital.unlocked) break; continue; }
      if (typeof item === 'string') { if (fp.level < Number(item.split(':')[1])) { await G.askUpgrade(fp); break; } continue; }
      const [type, recipe, plot] = item;
      const key = `${type}:${recipe || ''}`;
      seen[key] = (seen[key] || 0) + 1;
      const count = type === 'trade_workshop' ? (have[recipe] || 0) + (queued[recipe] || 0) : m.count(fp, type);
      if (count >= seen[key]) continue;
      const pos = G.place(fp, type, { plot }) || (plot ? G.place(fp, type) : null);
      if (!pos) { G.missing(fp, type); continue; }
      if (G.shortHanded(type)) break;
      if (m.waiting(fp).length >= 1) break;
      if (!await m.act('build', { ...pos, type, district: fp.id })) break;
      if (recipe) { this.f.pending[`${pos.ring}:${pos.slot}`] = recipe; queued[recipe] = (queued[recipe] || 0) + 1; }
    }
    fp = m.v.views[fp.id];
    const front = m.waiting(fp)[0];
    if (front && !m.busy(fp)) await G.topUp(fp, front.cost);
  }

  // ---- missions: standing until the orbit opens, then only what is left over ----------------------------------------
  async missions(fp) {
    const m = this.m;
    const open = (m.v.missions || {}).open || [];
    const orbit = m.v.orbital.unlocked;
    for (const q of open) {
      fp = m.v.views[fp.id];
      // once orbit is open the launch inputs are kept back; anything else in stock beyond a lot can still earn standing
      const ok = q.offers.filter((o) => m.amount(fp, o.good) >= o.qty + (orbit ? (LAUNCH_INPUTS.includes(o.good) || LAUNCH_GOODS.includes(o.good) ? 1e9 : 20) : 0));
      const best = ok.sort((a, b) => b.standing - a.standing || b.reward - a.reward)[0];
      if (best) await m.act('mission', { id: q.id, faction: best.faction, district: fp.id });
    }
  }

  // ---- the launch chain -------------------------------------------------------------------------------------------
  // Two Colossal plots side by side in the Core for the staging platform and the catapult.
  launchPair(core) {
    const m = this.m;
    const caps = m.rings(core);
    const taken = m.used(core);
    const nb = m.neighbours('core');
    const big = Object.keys(caps).map(Number).filter((r) => m.plotOf(core, r) >= 5);
    const staging = m.buildings(core).find((b) => b.type === 'orbital_staging');
    if (staging) {
      const next = (nb.get(`${staging.ring}:${staging.slot}`) || []).find(([r, s]) => m.plotOf(core, r) >= 5 && !taken.has(`${r}:${s}`));
      return next ? { staging: null, catapult: { ring: next[0], slot: next[1] } } : null;
    }
    for (const pref of [['5:12', '5:13']]) if (pref.every((k) => !taken.has(k)) && (nb.get(pref[0]) || []).some(([r, s]) => `${r}:${s}` === pref[1])) { const [a, b] = pref.map((k) => k.split(':').map(Number)); return { staging: { ring: a[0], slot: a[1] }, catapult: { ring: b[0], slot: b[1] } }; }
    for (const r of big) {
      for (let s = 0; s < caps[r]; s++) {
        if (taken.has(`${r}:${s}`)) continue;
        const mate = (nb.get(`${r}:${s}`) || []).find(([r2, s2]) => m.plotOf(core, r2) >= 5 && (r2 in caps) && s2 < caps[r2] && !taken.has(`${r2}:${s2}`));
        if (mate) return { staging: { ring: r, slot: s }, catapult: { ring: mate[0], slot: mate[1] } };
      }
    }
    return null;
  }

  async launchChain(core, fp) {
    const m = this.m;
    const G = this.G;
    const B = m.config.buildings;
    const built = (t) => m.hasBuilt(t);
    const ordered = (t) => m.ordered(t);
    // finished launch goods go to the Core, except what the command center still has to be paid with
    const hold = built('orbital_command') || ordered('orbital_command') ? {} : B.orbital_command.cost;
    if (G.every(5)) for (const r of LAUNCH_GOODS) {
      const keep = (hold[r] || 0) + 10;
      const cur = m.route(fp, core, r);
      if (!cur || cur.reserve !== keep) await G.routes([['freeport', 'core', r, 12, keep]]);
    }
    if (!built('orbital_command') && !ordered('orbital_command') && fp.level >= 5) {
      const pos = G.place(fp, 'orbital_command', { plot: 4, reserved: [] });
      if (!pos) G.missing(fp, 'orbital_command');
      else if (m.can(fp, B.orbital_command.cost)) await m.act('build', { ...pos, type: 'orbital_command', district: fp.id });
      else await G.topUp(fp, { circuits: B.orbital_command.cost.circuits });
    }
    core = m.core();
    const pair = this.launchPair(core);
    if (!built('orbital_staging') && !ordered('orbital_staging')) {
      if (!pair) G.missing(core, 'orbital_staging');
      else if (m.can(core, B.orbital_staging.cost)) await m.act('build', { ...pair.staging, type: 'orbital_staging' });
    }
    if (built('orbital_staging') && !built('orbital_catapult') && !ordered('orbital_catapult') && m.can(core, B.orbital_catapult.cost)) {
      const p = this.launchPair(m.core());
      if (p && p.catapult) await m.act('build', { ...p.catapult, type: 'orbital_catapult' });
      else G.missing(m.core(), 'orbital_catapult');
    }
    for (const t of ['orbital_staging', 'orbital_catapult', 'orbital_command']) {
      for (const d of m.places()) { const o = m.waiting(d).find((x) => x.data.type === t); if (o && o.pos > 1) await m.act('queue-move', { orderId: o.id, to: 'top' }); }
    }
    const L = m.v.orbital.launch;
    if (built('orbital_staging') && built('orbital_catapult') && built('orbital_command') && !L.ready && !L.loaded && L.next === 'station') await m.act('launch-cycle', { cycle: 'station' });
    if (L.ready === 'station') {
      for (let i = 0; i < 4; i++) {
        const name = `${NAME_A[Math.floor(this.rng() * NAME_A.length)]} ${NAME_B[Math.floor(this.rng() * NAME_B.length)]}${i > 1 ? ` ${Math.floor(this.rng() * 90) + 10}` : ''}`;
        if (await m.act('launch', { name })) { this.mem.events.push(`launched ${name}`); break; }
      }
    }
  }

  async turn() {
    const m = this.m;
    const G = this.G;
    let fp = m.byType('freeport');
    const core = m.core();
    if (!fp) {
      if (m.v.foundable && m.v.foundable.freeport && !(m.v.founding || []).some((o) => o.type === 'freeport') && m.can(core, m.config.districtTypes.freeport.foundCost)) {
        if (await m.act('found', { type: 'freeport' })) {
          const mine = m.waiting(m.core()).find((o) => o.kind === 'found');
          if (mine && mine.pos > 1) await m.act('queue-move', { orderId: mine.id, to: 'top' });
        }
      }
      return;
    }
    // the Beacon has done its work: switched off it frees the power it still draws
    const beacon = m.buildings(m.core()).find((b) => b.type === 'beacon_array');
    if (beacon && !beacon.paused) await m.act('toggle', { ring: beacon.ring, slot: beacon.slot, paused: true });
    await this.freePort(fp);
    if (G.every(5)) {
      await G.routes(LATE_ROUTES);
      fp = m.byType('freeport');
      const l = m.link(fp);
      if (fp.level >= 5 && l && l.capacity < 222 && l.next && G.every(20)) {
        if (!await m.act('link', { district: fp.id })) await G.topUp(m.core(), Object.fromEntries(Object.entries(l.next.upgradeCost || {}).filter(([r]) => m.config.resources[r].trade)));
      }
    }
    await this.missions(m.byType('freeport'));
    if (m.v.orbital.unlocked && !m.v.orbital.station) await this.launchChain(m.core(), m.byType('freeport'));
  }
}

module.exports = { Endgame, LAUNCH_GOODS, LAUNCH_INPUTS, fpPlan };
