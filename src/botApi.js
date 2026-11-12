'use strict';
// The bot API: how the bot runner (bots/runner.js, a separate process) finds parked colonies, claims them and plays them.
//
// It is off unless BOT_API_KEY is set, and every request must carry that key as a bearer token. A bot plays through the very
// same actions as a player (src/routes.js) under an account of its own: a generated callsign whose passcode nobody knows,
// marked with the profile it plays (users.bot_profile). Claiming goes through absence.claim, so the colony's previous
// commander, if they were a real player, is told when they next sign in, exactly as for any other claim.
//
//   GET  /api/bot/info                         tick, tick length and what the server allows
//   GET  /api/bot/config                       the game config (the bot plans with the same numbers the server runs)
//   GET  /api/bot/parked                       parked colonies waiting to be claimed
//   GET  /api/bot/parked/:colonyId             the full view of one, so the runner can judge it before claiming
//   POST /api/bot/claim {colonyId, profile}    claim it into a new bot account
//   GET  /api/bot/colonies                     the colonies bots run now
//   GET  /api/bot/colonies/:userId/state       one bot's view (what a player's client gets)
//   POST /api/bot/colonies/:userId/act/:route  one game action, as POST /api/<route> for a player
//   POST /api/bot/colonies/:userId/release     give the colony up: it parks again, under a generated account
const crypto = require('crypto');
const express = require('express');
const store = require('./db');
const actions = require('./actions');
const absence = require('./absence');
const engine = require('./engine');
const security = require('./security');
const ACTION_ROUTES = require('./routes');
const { body: plainBody, toInt } = require('./validate');
const { viewFor } = require('./state');
const { db, config } = store;

const ACTIONS = new Map(ACTION_ROUTES);
// Actions a bot never takes: wiping the colony is not a bot's call (a failed colony is released instead).
const REFUSED = new Set(['reset', 'restart']);
const PROFILE = /^[a-z][a-z0-9_]{1,23}$/;

const key = () => process.env.BOT_API_KEY || '';
const enabled = () => key().length >= 16;

function sameSecret(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function auth(req, res, next) {
  if (!enabled()) return res.status(404).json({ ok: false, error: 'Not found.' });
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  if (!m || !sameSecret(m[1], key())) return res.status(401).json({ ok: false, error: 'Bad bot key.' });
  next();
}

const botUser = (userId) => db.prepare('SELECT id, username, bot_profile AS profile FROM users WHERE id = ? AND bot_profile IS NOT NULL').get(userId);

// A bot taking its turn is a commander at the screen: the colony stays simulated, and hazards may start for it.
function present(userId) {
  absence.markActive(userId);
  db.prepare('UPDATE colonies SET last_seen_at = ? WHERE user_id = ?').run(Date.now(), userId);
}

// A new account for a bot: a callsign like any generated one, a passcode nobody knows, and the profile it plays.
function botAccount(profile) {
  const id = absence.generatedAccount();
  db.prepare('UPDATE users SET generated = 0, bot_profile = ? WHERE id = ?').run(profile, id);
  return id;
}

const claim = db.transaction((colonyId, profile, now = Date.now()) => {
  const c = db.prepare('SELECT * FROM colonies WHERE id = ?').get(colonyId);
  if (!c || absence.phase(c, now) !== 'parked') return { ok: false, error: 'Only a parked colony can be claimed.' };
  const userId = botAccount(profile);
  const r = absence.claim(colonyId, userId, now);
  if (!r.ok) throw new Error(r.error); // (rolls the new account back with it)
  db.prepare('UPDATE colonies SET away_notice = NULL WHERE id = ?').run(colonyId);
  return { ok: true, userId, username: db.prepare('SELECT username FROM users WHERE id = ?').get(userId).username };
});

// Give a colony back: it parks again under a generated account (where a player or another bot may claim it), and the bot
// account, now empty, is removed.
const release = db.transaction((userId, now = Date.now()) => {
  const c = db.prepare('SELECT id FROM colonies WHERE user_id = ?').get(userId);
  if (c) absence.release(c.id, now);
  db.prepare('DELETE FROM users WHERE id = ? AND bot_profile IS NOT NULL').run(userId);
  return { ok: true };
});

function router() {
  const r = express.Router();
  const limit = security.limiter({ windowMs: 10000, max: Number(process.env.BOT_API_RATE_LIMIT) || 1500, key: () => 'bot' });
  r.use(auth, limit);
  let cfgJson = null;

  r.get('/info', (req, res) => {
    const t = engine.timing();
    res.json({ ok: true, tick: t.globalTick, tickMs: t.tickMs, nextTickAt: t.lastTickAt + t.tickMs, absence: config.global.absence });
  });
  r.get('/config', (req, res) => res.type('json').send(cfgJson || (cfgJson = JSON.stringify(config))));

  r.get('/parked', (req, res) => {
    const list = absence.listParked(Math.min(200, toInt(req.query.limit) || 100)).map((p) => {
      const c = db.prepare('SELECT hub_level, population, status, won FROM colonies WHERE id = ?').get(p.id);
      return { colonyId: p.id, holder: p.username, generated: !!p.generated, bot: false, parkedAt: p.parkedAt, lastActive: p.lastActive, hubLevel: c.hub_level, population: c.population, status: c.status, won: !!c.won };
    });
    res.json({ ok: true, parked: list });
  });
  r.get('/parked/:colonyId', (req, res) => {
    const c = db.prepare('SELECT * FROM colonies WHERE id = ?').get(toInt(req.params.colonyId));
    if (!c || absence.phase(c) !== 'parked') return res.status(404).json({ ok: false, error: 'No such parked colony.' });
    res.json({ ok: true, state: viewFor(c.user_id) });
  });
  r.post('/claim', (req, res) => {
    const b = plainBody(req.body);
    const colonyId = toInt(b.colonyId);
    if (Number.isNaN(colonyId)) return res.status(400).json({ ok: false, error: 'Bad colony.' });
    if (typeof b.profile !== 'string' || !PROFILE.test(b.profile)) return res.status(400).json({ ok: false, error: 'Bad profile.' });
    const out = claim(colonyId, b.profile);
    res.status(out.ok ? 200 : 409).json(out);
  });

  r.get('/colonies', (req, res) => {
    const list = db.prepare(`SELECT u.id AS userId, u.username, u.bot_profile AS profile, c.id AS colonyId, c.hub_level AS hubLevel, c.status, c.population, c.parked_at AS parkedAt
      FROM users u LEFT JOIN colonies c ON c.user_id = u.id WHERE u.bot_profile IS NOT NULL ORDER BY u.id`).all();
    res.json({ ok: true, colonies: list });
  });
  const forBot = (req, res, next) => {
    const u = botUser(toInt(req.params.userId));
    if (!u) return res.status(404).json({ ok: false, error: 'No such bot.' });
    req.bot = u;
    next();
  };
  r.get('/colonies/:userId/state', forBot, (req, res) => {
    present(req.bot.id);
    res.json({ ok: true, state: viewFor(req.bot.id) });
  });
  r.post('/colonies/:userId/act/:route', forBot, (req, res) => {
    const name = ACTIONS.get(req.params.route);
    if (!name || REFUSED.has(req.params.route)) return res.status(404).json({ ok: false, error: 'No such action.' });
    present(req.bot.id);
    const result = actions[name](req.bot.id, plainBody(req.body));
    const withState = req.query.state !== '0';
    res.status(result.ok ? 200 : 400).json({ ...result, state: result.ok && withState ? viewFor(req.bot.id) : undefined });
  });
  r.post('/colonies/:userId/release', forBot, (req, res) => res.json(release(req.bot.id)));
  return r;
}

module.exports = { router, enabled, claim, release, botAccount };
