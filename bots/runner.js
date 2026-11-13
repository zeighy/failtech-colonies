#!/usr/bin/env node
'use strict';
// The bot runner: a small utility server that keeps a few parked colonies in play, so a world with only a handful of
// players still has neighbours, trade on the exchange and the orbital market, and stations in orbit.
//
// It talks to the game server only through the bot API (src/botApi.js), so it can run on the same machine or another one.
// Every hour it asks for colonies parked in the last week; while it runs fewer bots than its limit it looks at each candidate (see
// assess.js), claims the stable ones and gives each a profile (profiles.js), choosing the profile fewest bots are playing.
// Each bot then takes a turn every few ticks (brain/). A colony that fails, or stays shut down for long, is given back:
// it parks again for someone else. After BOT_RECHECK_HOURS the runner looks at a given-back colony once more; if it still
// isn't fit to take over it goes on the blacklist and is never looked at again, unless someone else takes it up and it
// parks again later (it is then a new candidate). The blacklist is kept in the state file; delete an entry to undo it.
//
// Settings (environment):
//   BOT_SERVER          the game server's address                          default http://127.0.0.1:3000
//   BOT_API_KEY         the key the game server was started with (required, at least 16 characters)
//   BOT_LIMIT           how many colonies bots may run at once              default 5
//   BOT_PROFILES        which profiles to use, comma-separated              default all of them
//   BOT_CLAIM           'all' parked colonies, or only 'given_up' ones (whose commander chose to start over)   default all
//   BOT_TURN_TICKS      game ticks between a bot's turns                    default 4 (a minute at 15 s a tick)
//   BOT_POLL_SECONDS    seconds between looks for parked colonies           default 3600 (an hour)
//   BOT_PARKED_DAYS     only colonies parked in the last this many days are candidates (0: any)   default 7
//   BOT_RECHECK_HOURS   how long a colony judged unsafe, or given back, is left alone   default 24
//   BOT_STATE_FILE      where the bots' memory is kept between restarts    default ./bots-state.json
//   BOT_STATUS_PORT     if set, GET /status on this port (bound to 127.0.0.1) shows what every bot is doing
//   BOT_LOG             'quiet' for errors only, 'verbose' for every event  default normal
//   BOT_TELEMETRY       the telemetry log (JSON lines; 'off' for none)     default ./bots-telemetry.jsonl
//   BOT_TELEMETRY_LEVEL 'normal', or 'verbose' to add every turn's actions and refusals   default normal
//   BOT_TELEMETRY_SNAPSHOT_MINUTES   how often each bot's colony is written down       default 60
//   BOT_TELEMETRY_MAX_MB / BOT_TELEMETRY_KEEP   rotate the log past this size / keep this many old ones   default 20 / 10
// The telemetry log (bots/telemetry.js) records claims, rejections, milestones, regular snapshots, the issues bots flag
// (bots/brain/issues.js), and every give-up with its reason and a look at the colony; `npm run bots:report` reads it.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { BotClient } = require('./client');
const { assess } = require('./assess');
const profiles = require('./profiles');
const { takeTurn, summary } = require('./brain');
const { Telemetry } = require('./telemetry');

// how long a bot has run its colony
const played = (b) => ({ hours: Math.round((Date.now() - b.claimedAt) / 360000) / 10, ticks: b.mem.firstTick !== undefined && b.mem.lastTick ? b.mem.lastTick - b.mem.firstTick : null });
const RECENT = 40; // events and refusals kept per bot for a give-up report

// what changed for the better since the last turn: hub levels, districts and their levels, the Beacon, orbit, the station
function milestones(prev, now) {
  if (!prev || !now) return [];
  const out = [];
  if (now.hub > prev.hub) out.push(`hub level ${now.hub}`);
  const lv = (s) => Object.fromEntries((s || '').split(' ').filter(Boolean).map((x) => { const m = /^(.*?)(\d+)$/.exec(x); return m ? [m[1], Number(m[2])] : [x, 0]; }));
  const a = lv(prev.places); const b = lv(now.places);
  for (const [t, l] of Object.entries(b)) if (a[t] === undefined) out.push(`founded ${t}`); else if (l > a[t]) out.push(`${t} level ${l}`);
  if (now.won && !prev.won) out.push('the Beacon transmitted');
  if (now.orbit && !prev.orbit) out.push('orbit opened');
  if (now.station && !prev.station) out.push('station launched');
  return out;
}

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

function settings() {
  const list = env('BOT_PROFILES', profiles.ORDER.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of list) if (!profiles.get(p)) throw new Error(`Unknown bot profile "${p}". Known: ${profiles.ORDER.join(', ')}.`);
  return {
    server: env('BOT_SERVER', 'http://127.0.0.1:3000'),
    key: env('BOT_API_KEY', ''),
    limit: Math.max(0, Number(env('BOT_LIMIT', 5))),
    profiles: list,
    claim: env('BOT_CLAIM', 'all'),
    turnTicks: Math.max(1, Number(env('BOT_TURN_TICKS', 4))),
    pollMs: Math.max(10, Number(env('BOT_POLL_SECONDS', 3600))) * 1000,
    parkedMs: Math.max(0, Number(env('BOT_PARKED_DAYS', 7))) * 86400000,
    recheckMs: Math.max(0, Number(env('BOT_RECHECK_HOURS', 24))) * 3600000,
    stateFile: path.resolve(env('BOT_STATE_FILE', 'bots-state.json')),
    statusPort: env('BOT_STATUS_PORT', null),
    log: env('BOT_LOG', 'normal'),
    telemetry: env('BOT_TELEMETRY', 'bots-telemetry.jsonl'),
    telemetryLevel: env('BOT_TELEMETRY_LEVEL', 'normal'),
    snapshotMs: Math.max(1, Number(env('BOT_TELEMETRY_SNAPSHOT_MINUTES', 60))) * 60000,
    telemetryMaxBytes: Math.max(1, Number(env('BOT_TELEMETRY_MAX_MB', 20))) * 1048576,
    telemetryKeep: Math.max(1, Number(env('BOT_TELEMETRY_KEEP', 10))),
  };
}

class Runner {
  constructor(s, client) {
    this.s = s;
    this.client = client || new BotClient(s.server, s.key);
    this.bots = new Map(); // userId -> { userId, username, profile, colonyId, mem, last, errors }
    this.rejected = {}; // colonyId -> { at, verdict, reasons, abandoned?, due? }, looked at again after recheckMs
    this.blocked = {}; // colonyId -> { at, parkedAt, verdict, reasons }: given back by a bot and still unfit; never looked at again
    this.config = null;
    this.tickMs = 15000;
    this.stopped = false;
    this.lastPoll = 0;
    this.tel = new Telemetry({ file: s.telemetry || 'off', level: s.telemetryLevel, maxBytes: s.telemetryMaxBytes, keep: s.telemetryKeep, onError: (msg) => this.say('error', msg) });
    this.load();
  }

  // a telemetry entry about one bot
  log(ev, b, data = {}) { this.tel.write(ev, { bot: b.username, profile: b.profile, colony: b.colonyId, ...data }); }

  say(level, msg) {
    if (this.s.log === 'quiet' && level !== 'error') return;
    if (level === 'debug' && this.s.log !== 'verbose') return;
    (level === 'error' ? console.error : console.log)(`[bots ${new Date().toISOString()}] ${msg}`);
  }

  // ---- memory across restarts -----------------------------------------------------------------------------------
  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.s.stateFile, 'utf8'));
      this.saved = j.bots || {};
      this.rejected = j.rejected || {};
      this.blocked = j.blocked || {};
    } catch (e) { this.saved = {}; }
  }
  save() {
    const bots = {};
    for (const [id, b] of this.bots) bots[id] = { mem: b.mem, claimedAt: b.claimedAt };
    const tmp = `${this.s.stateFile}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), bots, rejected: this.rejected, blocked: this.blocked }), { mode: 0o600 });
      fs.renameSync(tmp, this.s.stateFile);
    } catch (e) { this.say('error', `could not save ${this.s.stateFile}: ${e.message}`); }
  }

  // ---- the bots the server says we run --------------------------------------------------------------------------
  async sync() {
    const list = await this.client.colonies();
    const seen = new Set();
    for (const row of list) {
      seen.add(row.userId);
      if (!row.colonyId) { await this.client.release(row.userId); continue; } // an account with nothing left to run
      if (!this.bots.has(row.userId)) {
        const prev = this.saved[row.userId] || {};
        this.bots.set(row.userId, { userId: row.userId, username: row.username, profile: profiles.get(row.profile) ? row.profile : this.s.profiles[0], colonyId: row.colonyId, mem: prev.mem || { seed: row.userId }, claimedAt: prev.claimedAt || Date.now(), errors: 0, last: null });
        this.say('info', `running ${row.username} (${row.profile}) on colony ${row.colonyId}`);
      }
    }
    for (const id of [...this.bots.keys()]) if (!seen.has(id)) this.bots.delete(id);
  }

  pickProfile() {
    const used = Object.fromEntries(this.s.profiles.map((p) => [p, 0]));
    for (const b of this.bots.values()) if (used[b.profile] !== undefined) used[b.profile]++;
    const least = Math.min(...Object.values(used));
    const pool = this.s.profiles.filter((p) => used[p] === least);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // ---- finding and claiming parked colonies ---------------------------------------------------------------------
  async poll() {
    this.lastPoll = Date.now();
    await this.sync();
    // a lowered limit: the most recently claimed bots give their colonies back
    while (this.bots.size > this.s.limit) {
      const last = [...this.bots.values()].sort((a, b) => b.claimedAt - a.claimedAt)[0];
      await this.release(last, 'over the limit');
    }
    if (this.bots.size >= this.s.limit) return;
    const now = Date.now();
    // a colony a bot gave up stays marked when its wait is over: one more look decides whether it is blacklisted
    for (const [id, r] of Object.entries(this.rejected)) if (now - r.at > this.s.recheckMs) { if (r.abandoned) r.due = true; else delete this.rejected[id]; }
    // only recently parked colonies (a colony a bot gives back parks afresh, so it counts as recent)
    const since = this.s.parkedMs > 0 ? now - this.s.parkedMs : 0;
    for (const [id, x] of Object.entries(this.blocked)) if (x.parkedAt < since) delete this.blocked[id]; // out of the window anyway
    let parked = await this.client.parked(Object.entries(this.blocked).map(([id, x]) => `${id}:${x.parkedAt}`), since);
    if (this.s.claim === 'given_up') parked = parked.filter((p) => p.generated);
    // colonies nobody will come back for first, then the furthest along (more to sell, sooner)
    parked.sort((a, b) => (b.generated - a.generated) || (b.hubLevel - a.hubLevel) || (a.parkedAt - b.parkedAt));
    for (const p of parked) {
      if (this.bots.size >= this.s.limit) break;
      if (this.blocked[p.colonyId]) delete this.blocked[p.colonyId]; // parked again since (the listing skips the blacklisted park)
      const prior = this.rejected[p.colonyId];
      if (prior && !prior.due) continue;
      let view;
      try { view = await this.client.parkedView(p.colonyId); } catch (e) { continue; }
      const a = assess(view, this.config);
      if (a.verdict !== 'stable' && prior && prior.abandoned) {
        delete this.rejected[p.colonyId];
        this.blocked[p.colonyId] = { at: now, parkedAt: p.parkedAt, verdict: a.verdict, reasons: a.reasons };
        this.tel.write('blacklist', { colony: p.colonyId, holder: p.holder, hub: p.hubLevel, parkedAt: p.parkedAt, verdict: a.verdict, score: a.score, reasons: a.reasons });
        this.say('info', `blacklisted colony ${p.colonyId} (${p.holder}, hub ${p.hubLevel}): a bot gave it up and it is still ${a.verdict}${a.reasons.length ? ` - ${a.reasons.join('; ')}` : ''}`);
        continue;
      }
      if (a.verdict !== 'stable') {
        this.rejected[p.colonyId] = { at: now, verdict: a.verdict, reasons: a.reasons };
        this.tel.write('reject', { colony: p.colonyId, holder: p.holder, generated: p.generated, hub: p.hubLevel, population: p.population, recheck: !!prior, verdict: a.verdict, score: a.score, reasons: a.reasons });
        this.say('info', `left colony ${p.colonyId} (${p.holder}, hub ${p.hubLevel}) alone: ${a.verdict}${a.reasons.length ? ` - ${a.reasons.join('; ')}` : ''}`);
        continue;
      }
      delete this.rejected[p.colonyId];
      const profile = this.pickProfile();
      const r = await this.client.claim(p.colonyId, profile);
      if (!r || !r.ok) { this.say('info', `could not claim colony ${p.colonyId}: ${(r && r.error) || 'refused'}`); continue; }
      this.bots.set(r.userId, { userId: r.userId, username: r.username, profile, colonyId: p.colonyId, mem: { seed: r.userId }, claimedAt: Date.now(), errors: 0, last: null });
      this.log('claim', this.bots.get(r.userId), { holder: p.holder, generated: p.generated, reclaim: !!prior, assessment: a, colonyState: summary(view) });
      this.say('info', `claimed colony ${p.colonyId} (hub ${p.hubLevel}, score ${a.score}) as ${r.username}, playing ${profiles.get(profile).name}`);
    }
    this.save();
  }

  // abandoned: the bot gave the colony up (it failed or stayed shut down), rather than being over the limit
  async release(b, why, abandoned = false) {
    try { await this.client.release(b.userId); } catch (e) { this.say('error', `release of ${b.username} failed: ${e.message}`); return; }
    this.bots.delete(b.userId);
    this.rejected[b.colonyId] = { at: Date.now(), verdict: 'released', reasons: [why], ...(abandoned ? { abandoned: true } : {}) };
    if (!abandoned) this.log('release', b, { why, played: played(b) });
    this.say('info', `${b.username} gave colony ${b.colonyId} back (${why})`);
  }

  // ---- turns ----------------------------------------------------------------------------------------------------------
  async turn(b) {
    const P = profiles.get(b.profile);
    try {
      const out = await takeTurn({ config: this.config, api: this.client.forBot(b.userId), profile: P, mem: b.mem });
      b.errors = 0;
      b.last = { at: Date.now(), ...out.summary, actions: out.actions, verdict: out.verdict };
      this.record(b, out);
      if (out.verdict === 'give_up') {
        this.log('give_up', b, { ...out.postmortem, played: played(b), lastSnapshot: b.mem.lastSnapshot || null, final: out.summary, recentEvents: b.recent || [], recentRefusals: b.recentRefusals || [] });
        return this.release(b, out.postmortem.detail, true);
      }
      if (out.verdict === 'gone') { this.log('gone', b, { played: played(b) }); this.bots.delete(b.userId); return null; }
      for (const e of out.events) this.say('debug', `${b.username}: ${e}`);
      if (out.events.length && this.s.log !== 'verbose') this.say('info', `${b.username} (${b.profile}): ${out.events.slice(0, 4).join('; ')}${out.events.length > 4 ? '...' : ''}`);
      for (const f of out.failures) this.say('debug', `${b.username} refused: ${f}`);
    } catch (e) {
      b.errors++;
      this.log('error', b, { where: 'turn', message: e.message, status: e.status || null, stack: String(e.stack || '').split('\n').slice(1, 5).map((x) => x.trim()), errorsInARow: b.errors });
      this.say('error', `${b.username} turn failed: ${e.message}`);
      if (e.status === 404) this.bots.delete(b.userId); // the server no longer knows this bot
    }
    return null;
  }

  async loop() {
    const info = await this.client.info();
    this.tickMs = info.tickMs;
    this.config = await this.client.config();
    await this.poll();
    while (!this.stopped) {
      const started = Date.now();
      if (Date.now() - this.lastPoll >= this.s.pollMs) { try { await this.poll(); } catch (e) { this.tel.write('error', { where: 'poll', message: e.message }); this.say('error', `poll failed: ${e.message}`); } }
      for (const b of [...this.bots.values()]) { if (this.stopped) break; await this.turn(b); }
      this.save();
      const wait = Math.max(1000, this.s.turnTicks * this.tickMs - (Date.now() - started));
      await new Promise((r) => { this.wake = r; this.timer = setTimeout(r, wait); });
    }
  }

  // telemetry for one turn: milestones, flagged issues, a snapshot now and then, and (verbose) the turn itself
  record(b, out) {
    const mem = b.mem;
    const s = out.summary;
    if (s && mem.firstTick === undefined) mem.firstTick = s.tick;
    const tick = s ? s.tick : null;
    b.recent = (b.recent || []).concat(out.events.map((e) => ({ tick, e }))).slice(-RECENT);
    b.recentRefusals = (b.recentRefusals || []).concat(out.failures.map((f) => ({ tick, f }))).slice(-RECENT);
    if (s) {
      for (const m of milestones(mem.seen, s)) this.log('milestone', b, { tick, what: m, hub: s.hub, places: s.places, pop: s.pop });
      mem.seen = { hub: s.hub, places: s.places, won: s.won, orbit: s.orbit, station: s.station };
    }
    for (const x of out.issues.raised) { this.log('issue', b, { tick, ...x }); this.say('info', `${b.username} flagged ${x.code}`); }
    for (const x of out.issues.cleared) this.log('issue_cleared', b, { tick, ...x });
    if (this.tel.verbose) this.log('turn', b, { tick, actions: out.actions, events: out.events, refusals: out.failures });
    if (s && out.verdict === 'play' && Date.now() - (mem.snapshotAt || 0) >= (this.s.snapshotMs || 3600000)) {
      mem.snapshotAt = Date.now();
      mem.lastSnapshot = { ...s, at: new Date().toISOString() };
      this.log('snapshot', b, { ...s, plans: out.brief, open: out.issues.open.map((x) => x.code), played: played(b) });
    }
  }

  stop() { this.stopped = true; clearTimeout(this.timer); if (this.wake) this.wake(); this.save(); }

  status() {
    return {
      limit: this.s.limit, profiles: this.s.profiles, lastPoll: this.lastPoll,
      bots: [...this.bots.values()].map((b) => ({ user: b.username, profile: b.profile, colony: b.colonyId, claimedAt: b.claimedAt, errors: b.errors, last: b.last, trade: b.mem.trade || null })),
      rejected: this.rejected,
      blocked: this.blocked,
    };
  }
}

async function main() {
  const s = settings();
  if (!s.key || s.key.length < 16) { console.error('BOT_API_KEY must be set (at least 16 characters), the same key the game server was started with.'); process.exit(2); }
  const runner = new Runner(s);
  runner.tel.write('start', { server: s.server, limit: s.limit, profiles: s.profiles, claim: s.claim, turnTicks: s.turnTicks, pollSeconds: s.pollMs / 1000, parkedDays: s.parkedMs / 86400000, recheckHours: s.recheckMs / 3600000, level: s.telemetryLevel });
  if (s.statusPort) {
    http.createServer((req, res) => {
      if (req.url === '/status') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(runner.status(), null, 1)); return; }
      if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
      res.writeHead(404); res.end();
    }).listen(Number(s.statusPort), '127.0.0.1', () => runner.say('info', `status on http://127.0.0.1:${s.statusPort}/status`));
  }
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { runner.say('info', `${sig}: stopping`); runner.stop(); setTimeout(() => process.exit(0), 200); });
  runner.say('info', `bot runner for ${s.server}: up to ${s.limit} bots, profiles ${s.profiles.join(', ')}`);
  // the game server may not be up yet: keep trying
  for (;;) {
    try { await runner.loop(); break; } catch (e) {
      runner.say('error', `${e.message}; retrying in 30 s`);
      if (runner.stopped) break;
      await new Promise((r) => setTimeout(r, 30000));
    }
  }
}

if (require.main === module) main();
module.exports = { Runner, settings };
