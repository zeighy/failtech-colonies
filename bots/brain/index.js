'use strict';
// One bot turn. The order matters: staying alive comes first (inside the ground turn, survival runs after the plans so
// it can push urgent food, water, homes and power to the front of the queues), then growing, then the endgame, orbit and
// trade, then reorganising whatever had no room.
//
// `mem` is the bot's memory between turns. It is kept small and only ever a help: the runner saves it, but a bot that lost
// it (a restart, a fresh claim) plays on from the view alone.
const { Colony } = require('./model');
const { Ground } = require('./ground');
const { Endgame } = require('./endgame');
const { Orbit } = require('./orbit');
const { Trade } = require('./trade');
const { Reorg } = require('./reorg');
const { Supply } = require('./supply');
const issues = require('./issues');
const { assess } = require('../assess');

function rngFrom(seed) { // mulberry32: decisions vary between bots, and are repeatable in tests
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const GIVE_UP_SHUTDOWN_TICKS = 2880; // shut down for half a day of play

// What the bot should do with a colony it runs: play on, or give it up (it has failed, or has stayed shut down too long).
function verdict(v) { return judge(v).verdict; }
function judge(v) {
  if (!v || v.lost) return { verdict: 'gone', reason: 'lost', detail: 'the server no longer has this colony for the bot' };
  const c = v.colony;
  if (c.status !== 'active') return { verdict: 'give_up', reason: `status_${c.status}`, detail: `the colony's status is ${c.status}` };
  if (c.shutdown && c.shutdown.ticks > GIVE_UP_SHUTDOWN_TICKS) return { verdict: 'give_up', reason: 'shutdown_too_long', detail: `shut down for ${c.shutdown.ticks} ticks (limit ${GIVE_UP_SHUTDOWN_TICKS})` };
  return { verdict: 'play', reason: null, detail: null };
}

// What the bot knew about its colony when it gave up, for the telemetry log: the takeover assessment run on it, the
// issues it had open, and its plans.
function postmortem(v, config, mem) {
  return {
    reason: null,
    assessment: v && v.colony ? assess(v, config) : null,
    state: v && v.colony ? { status: v.colony.status, failures: v.colony.failures, shutdown: v.colony.shutdown || null, starving: v.colony.starving || [], population: v.colony.population, morale: Math.round(v.colony.morale || 0) } : null,
    doom: v && v.doom ? v.doom : null,
    openIssues: Object.entries(mem.issues || {}).filter(([, x]) => x.raised).map(([code, x]) => ({ code, since: x.since, detail: x.detail })),
    plans: brief(mem),
  };
}

// The parts of the bot's memory that explain what it was doing (kept small for the log).
function brief(mem) {
  return {
    selling: mem.selling || [], launchSaving: !!mem.launchSaving, launchShort: mem.launchSaving ? mem.launchShort || {} : {},
    paused: ((mem.supply || {}).paused || []).length, trade: mem.trade || null,
  };
}

async function takeTurn({ config, api, profile, mem, log = () => {}, maxActions = 40 }) {
  const m = new Colony({ config, api, log, maxActions });
  await m.refresh();
  mem.events = [];
  mem.rngState = (mem.rngState || 0) + 1;
  const rng = rngFrom((mem.seed || 1) * 7919 + mem.rngState);
  mem.cadence = mem.lastTick ? Math.max(1, m.tick - mem.lastTick) : 4;
  const j = judge(m.v);
  const out = { verdict: j.verdict, reason: j.reason, actions: 0, failures: [], events: mem.events, issues: { raised: [], cleared: [], open: [] } };
  if (out.verdict !== 'play') {
    out.summary = m.v && m.v.colony ? summary(m.v) : null;
    out.postmortem = { ...postmortem(m.v, config, mem), reason: j.reason, detail: j.detail };
    return out;
  }
  const G = new Ground(m, mem, profile);
  // a shutdown that has lifted leaves its buildings parked until someone switches them back on
  if (!m.colony.shutdown && m.colony.parked > 0) await m.act('resume');
  if (m.v.absence && m.v.absence.notice) await m.act('ack');
  // settlements are something players do; a bot has its own objectives, so any it inherited are let go
  for (const sm of ((m.v.settlements || {}).active || [])) if (await m.act('settle-drop', { id: sm.id })) mem.events.push(`stopped sponsoring ${sm.name}`);
  try {
    await G.turn();
    await new Supply(m, mem, profile, G).turn();
    if (m.v.colony.won) await new Endgame(m, mem, profile, G, rng).turn();
    if (m.v.orbital && m.v.orbital.station) await new Orbit(m, mem, profile, G).turn();
    await new Trade(m, mem, profile, G, rng).turn();
    await new Reorg(m, mem, profile, G).turn();
  } finally {
    mem.lastTick = m.tick;
    out.actions = m.acted;
    out.failures = m.failures;
    out.summary = summary(m.v);
    out.brief = brief(mem);
  }
  out.issues = issues.track(m, mem, out);
  return out;
}

// A line for the runner's log and status page.
function summary(v) {
  const c = v.colony;
  const places = v.districts.filter((d) => !d.orbital).map((d) => `${d.type}${d.level}`).join(' ');
  return {
    tick: v.tick, hub: c.hubLevel, pop: c.population, morale: Math.round(c.morale), credits: c.credits,
    places, won: c.won, orbit: !!(v.orbital && v.orbital.unlocked), station: !!(v.orbital && v.orbital.station),
    standing: v.orbital ? v.orbital.standing : 0, doom: v.doom ? `${v.doom.phase} ${v.doom.ticks}` : null, shutdown: !!c.shutdown,
  };
}

module.exports = { takeTurn, verdict, judge, summary, brief, postmortem, rngFrom };
