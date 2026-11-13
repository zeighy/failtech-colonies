'use strict';
// Issues a bot flags about its own play, for the telemetry log (bots/telemetry.js): things that went wrong or stayed
// wrong long enough to say its logic may be missing something. Each condition is checked every turn; it is *raised* once
// it has held for its grace period, and *cleared* (with how long it lasted) when it stops holding. Nothing here changes
// how the bot plays; it only reports.
//
// Every condition gives a short code and a detail object. The grace periods are in game ticks (15 s a tick: 240 = an hour).
const { assess } = require('../assess');

const HOUR = 240;

// code -> grace in ticks before it is raised
const GRACE = {
  at_risk: HOUR, // the takeover assessment, run on its own colony, no longer says stable
  shutdown: 0,
  collapse_clock: HOUR / 2, // a fresh colony's water clock runs for a while before the pumps are up
  starving: 0,
  power_short: HOUR / 2,
  morale_low: HOUR,
  people_leaving: 2 * HOUR,
  credits_low: 2 * HOUR,
  stalled: 0, // the condition itself already waits (no progress for a day)
  no_orbital_sales: 0, // likewise (a station and nothing sold for a day)
  launch_short: 0, // likewise (saving for a launch for a day)
  repeated_refusal: 0, // the same action refused turn after turn
  cannot_afford: 4 * HOUR, // goods it wanted moved, and could not pay for
  wanted_no_room: 6 * HOUR, // buildings it wants and has no plot for
  capped_paused: 12 * HOUR, // workshops paused at the storage cap for long
};

const DAY = 24 * HOUR;

// The conditions that hold this turn: { code: detail }.
function conditions(m, mem, out) {
  const v = m.v;
  const c = v.colony;
  const now = v.tick;
  const on = {};
  const a = assess(v, m.config);
  if (a.verdict !== 'stable') on.at_risk = { verdict: a.verdict, score: a.score, reasons: a.reasons };
  if (c.shutdown) on.shutdown = { ticks: c.shutdown.ticks || 0 };
  if (v.doom && v.doom.phase) on.collapse_clock = { phase: v.doom.phase, ticks: v.doom.ticks, resources: v.doom.resources };
  if ((c.starving || []).length) on.starving = { resources: c.starving };
  if (v.energy && v.energy.satisfaction < 0.75) on.power_short = { satisfaction: Math.round(v.energy.satisfaction * 100) / 100 };
  if (c.morale < 40) on.morale_low = { morale: Math.round(c.morale) };
  const outlook = (v.people || {}).outlook;
  if (outlook && outlook.state === 'shrinking') on.people_leaving = { why: outlook.why || null, population: c.population };
  if (c.credits < 2000) on.credits_low = { credits: Math.round(c.credits) };

  // progress: growth, or (once in orbit) selling, counts; a day of neither is a stall
  const T = mem.trade || {};
  const key = JSON.stringify([c.hubLevel, v.districts.map((d) => `${d.type}${d.level}`).sort(), !!c.won, !!(v.orbital && v.orbital.station), T.sold || 0, T.surfaceSold || 0]);
  const P = (mem.progress = mem.progress || { key, since: now });
  if (P.key !== key) { P.key = key; P.since = now; }
  if (now - P.since >= DAY) on.stalled = { since: P.since, ticks: now - P.since };

  // selling in orbit is every profile's main objective
  if (v.orbital && v.orbital.station) {
    const S = (mem.salesWatch = mem.salesWatch || { sold: T.sold || 0, since: now });
    if ((T.sold || 0) !== S.sold) { S.sold = T.sold || 0; S.since = now; }
    if (now - S.since >= DAY) on.no_orbital_sales = { since: S.since, selling: mem.selling || [], ticks: now - S.since };
  }

  // saving for a launch that never comes
  if (mem.launchSaving) {
    mem.launchSavingSince = mem.launchSavingSince || now;
    if (now - mem.launchSavingSince >= DAY) on.launch_short = { since: mem.launchSavingSince, short: mem.launchShort || {} };
  } else delete mem.launchSavingSince;

  // the same refusal, turn after turn
  const R = (mem.refusals = mem.refusals || {});
  const seen = new Set();
  for (const f of out.failures || []) {
    const k = f.replace(/\d+(\.\d+)?/g, '#').slice(0, 160); // numbers vary, the reason does not
    if (seen.has(k)) continue;
    seen.add(k);
    R[k] = R[k] ? { n: R[k].n + 1, since: R[k].since, last: now, example: f } : { n: 1, since: now, last: now, example: f };
  }
  for (const [k, r] of Object.entries(R)) if (!seen.has(k) && now - r.last > HOUR) delete R[k];
  for (const k of Object.keys(R).sort((x, y) => R[x].last - R[y].last).slice(0, Math.max(0, Object.keys(R).length - 50))) delete R[k];
  // refused in 30 turns (with no gap of an hour), and as lately as the last quarter hour
  const stuck = Object.values(R).filter((r) => r.n >= 30 && now - r.last <= HOUR / 4).sort((x, y) => y.n - x.n).slice(0, 5);
  if (stuck.length) on.repeated_refusal = { refusals: stuck.map((r) => ({ example: r.example, turns: r.n, since: r.since })) };

  const recent = (o, ticks) => Object.entries(o || {}).filter(([, t]) => now - t < ticks).map(([k]) => k);
  const cost = recent(mem.costShort, HOUR);
  if (cost.length) on.cannot_afford = { what: cost.slice(0, 10) };
  const wanted = recent(mem.wanted, HOUR);
  if (wanted.length) on.wanted_no_room = { what: wanted.slice(0, 10) };
  const paused = ((mem.supply || {}).paused || []);
  if (paused.length) on.capped_paused = { buildings: paused.length };
  return on;
}

// Compares this turn's conditions with what the bot already flagged. Returns { raised, cleared, open } and keeps the
// state in mem.issues: { code: { since, raised, detail } }.
function track(m, mem, out) {
  const now = m.v.tick;
  const on = conditions(m, mem, out);
  const I = (mem.issues = mem.issues || {});
  const raised = [];
  const cleared = [];
  for (const [code, detail] of Object.entries(on)) {
    const x = I[code] || (I[code] = { since: now, raised: false });
    x.detail = detail;
    if (!x.raised && now - x.since >= (GRACE[code] || 0)) { x.raised = true; x.raisedAt = now; raised.push({ code, since: x.since, detail }); }
  }
  for (const [code, x] of Object.entries(I)) {
    if (on[code]) continue;
    if (x.raised) cleared.push({ code, since: x.since, ticks: now - x.since, detail: x.detail });
    delete I[code];
  }
  const open = Object.entries(I).filter(([, x]) => x.raised).map(([code, x]) => ({ code, since: x.since, detail: x.detail }));
  return { raised, cleared, open };
}

module.exports = { track, conditions, GRACE };
