'use strict';
// Admin panel: the bots. What the runner last reported (it reports every loop through the bot API's heartbeat), the bot
// accounts and their colonies, the parked colonies they could claim, and the controls: pause them, switch the bot API off,
// override the runner's limit, profiles and claim rule, issue a new key, change a bot's profile, make a bot give its colony
// back (parked, optionally kept from the bots), and read or export the telemetry the runner sent.
const store = require('../db');
const botApi = require('../botApi');
const absence = require('../absence');
const serverlog = require('../serverlog');
const profiles = require('../../bots/profiles');
const { db } = store;

const DAY = 86400000;

module.exports = (r, h) => {
  const { need, audit, body, toInt, ok, bad } = h;

  r.get('/bots', need, (req, res) => {
    const runner = botApi.runnerStatus();
    const st = runner && runner.status ? runner.status : null;
    const reported = new Map(((st && st.bots) || []).map((b) => [b.user, b]));
    const bots = db.prepare(`SELECT u.id AS userId, u.username, u.bot_profile AS profile, c.id AS colonyId, c.hub_level AS hub, c.population, c.credits, c.status, c.shutdown_tick, c.parked_at, s.name AS station
      FROM users u LEFT JOIN colonies c ON c.user_id = u.id LEFT JOIN stations s ON s.colony_id = c.id WHERE u.bot_profile IS NOT NULL ORDER BY u.id`).all()
      .map((b) => { const rep = reported.get(b.username); return { ...b, shutdown: b.shutdown_tick !== null, last: rep ? rep.last : null, errors: rep ? rep.errors : null, claimedAt: rep ? rep.claimedAt : null, trade: rep ? rep.trade : null }; });
    const settings = st && st.settings ? st.settings : {};
    const days = settings.parkedDays === undefined ? 7 : settings.parkedDays;
    const since = days > 0 ? Date.now() - days * DAY : 0;
    const candidates = absence.listParked(200, [], since).length;
    ok(res, {
      api: { enabled: botApi.enabled(), key: botApi.keySource(), off: store.getMeta('bot_api_off') === '1', keyFile: process.env.BOT_API_KEY_FILE || null },
      control: botApi.control(),
      runner: runner ? { at: runner.at, ip: runner.ip, pid: st && st.pid, paused: st && st.paused, limit: st && st.limit, active: st && st.active, waiting: st && st.waiting, profiles: st && st.profiles, settings, lastPoll: st && st.lastPoll, rejectedCount: st && st.rejectedCount, blockedCount: st && st.blockedCount, blocked: st && st.blocked } : null,
      bots, candidates, excluded: db.prepare('SELECT COUNT(*) AS n FROM colonies WHERE parked_at IS NOT NULL AND no_bots = 1').get().n,
      profiles: profiles.ORDER.map((id) => ({ id, name: profiles.PROFILES[id].name, blurb: profiles.PROFILES[id].blurb })),
    });
  });

  r.post('/bots/pause', need, (req, res) => {
    const on = !!body(req.body).on;
    store.setMeta('bots_paused', on ? '1' : '0');
    audit(req, on ? 'bots.pause' : 'bots.resume');
    serverlog.warn('bots', `Bots ${on ? 'paused' : 'resumed'} by ${req.admin.username}`);
    ok(res);
  });
  r.post('/bots/api', need, (req, res) => {
    const on = !!body(req.body).on;
    store.setMeta('bot_api_off', on ? '0' : '1');
    audit(req, on ? 'bots.api.on' : 'bots.api.off');
    serverlog.warn('bots', `Bot API switched ${on ? 'on' : 'off'} by ${req.admin.username}`);
    ok(res);
  });
  // { limit, profiles, claim }: null for any of them hands it back to the runner's own settings
  r.post('/bots/overrides', need, (req, res) => {
    const b = body(req.body);
    const o = {};
    if (b.limit !== undefined) {
      if (b.limit === null || b.limit === '') o.limit = null;
      else { const n = toInt(b.limit); if (!Number.isInteger(n) || n < 0 || n > 200) return bad(res, 'Limit between 0 and 200.'); o.limit = n; }
    }
    if (b.profiles !== undefined) {
      if (b.profiles === null || (Array.isArray(b.profiles) && !b.profiles.length)) o.profiles = null;
      else if (!Array.isArray(b.profiles) || b.profiles.some((p) => !profiles.get(p))) return bad(res, 'Unknown profile.');
      else o.profiles = [...new Set(b.profiles)];
    }
    if (b.claim !== undefined) {
      if (b.claim === null || b.claim === '') o.claim = null;
      else if (b.claim !== 'all' && b.claim !== 'given_up') return bad(res, 'Claim is "all" or "given_up".');
      else o.claim = b.claim;
    }
    const out = botApi.setOverrides(o);
    audit(req, 'bots.overrides', null, out);
    ok(res, { overrides: out });
  });
  r.post('/bots/key', need, (req, res) => {
    const out = botApi.resetKey();
    audit(req, 'bots.key.reset', null, { file: out.file, wrote: out.wrote });
    serverlog.warn('bots', `Bot API key reset by ${req.admin.username}`);
    ok(res, out);
  });
  const botOr404 = (req, res) => { const u = db.prepare('SELECT * FROM users WHERE id = ? AND bot_profile IS NOT NULL').get(toInt(req.params.userId)); if (!u) bad(res, 'No such bot.', 404); return u; };
  r.post('/bots/:userId/profile', need, (req, res) => {
    const u = botOr404(req, res);
    if (!u) return;
    const p = body(req.body).profile;
    if (!profiles.get(p)) return bad(res, 'Unknown profile.');
    db.prepare('UPDATE users SET bot_profile = ? WHERE id = ?').run(p, u.id);
    audit(req, 'bot.profile', u.username, { from: u.bot_profile, to: p });
    ok(res);
  });
  // The bot gives its colony back: parked under a generated account, and (noBots) kept from being claimed again.
  r.post('/bots/:userId/release', need, (req, res) => {
    const u = botOr404(req, res);
    if (!u) return;
    const c = db.prepare('SELECT id FROM colonies WHERE user_id = ?').get(u.id);
    botApi.release(u.id);
    if (c && body(req.body).noBots) db.prepare('UPDATE colonies SET no_bots = 1 WHERE id = ?').run(c.id);
    audit(req, 'bot.release', u.username, { colony: c ? c.id : null, noBots: !!body(req.body).noBots });
    serverlog.info('bots', `Bot ${u.username} released colony #${c ? c.id : '?'} (admin ${req.admin.username})`);
    ok(res);
  });

  // ---- telemetry ----
  const telemetryRows = (q, limit) => {
    const days = Math.min(365, Math.max(0, Number(q.days) || 7));
    const where = ['at >= ?'];
    const args = [days ? Date.now() - days * DAY : 0];
    if (typeof q.bot === 'string' && q.bot) { where.push('bot = ?'); args.push(q.bot.slice(0, 40)); }
    if (typeof q.ev === 'string' && q.ev) { where.push('ev = ?'); args.push(q.ev.slice(0, 32)); }
    return db.prepare(`SELECT id, at, ev, bot, profile, colony, data FROM bot_telemetry WHERE ${where.join(' AND ')} ORDER BY id ${limit ? 'DESC' : 'ASC'} ${limit ? 'LIMIT ?' : ''}`).all(...args, ...(limit ? [limit] : []));
  };
  r.get('/bots/telemetry', need, (req, res) => {
    const rows = telemetryRows(req.query, 0);
    const byEv = {}; const issues = {}; const giveUps = {}; const refusals = {}; const perBot = {};
    for (const row of rows) {
      byEv[row.ev] = (byEv[row.ev] || 0) + 1;
      let d = {};
      try { d = JSON.parse(row.data); } catch (e) { d = {}; }
      if (row.bot) { const p = perBot[row.bot] || (perBot[row.bot] = { bot: row.bot, profile: row.profile, colony: row.colony, entries: 0, issues: 0, errors: 0, milestones: [], gaveUp: null }); p.entries++; if (row.ev === 'issue') p.issues++; if (row.ev === 'error') p.errors++; if (row.ev === 'milestone') p.milestones.push(d.what); if (row.ev === 'give_up') p.gaveUp = d.reason || d.detail || 'gave up'; }
      if (row.ev === 'issue' && d.code) issues[d.code] = (issues[d.code] || 0) + 1;
      if (row.ev === 'give_up') { const k = d.reason || 'unknown'; giveUps[k] = (giveUps[k] || 0) + 1; }
      if (row.ev === 'issue' && d.code === 'repeated_refusal' && d.detail) { const k = String(d.detail).replace(/\d+/g, '#').slice(0, 120); refusals[k] = (refusals[k] || 0) + 1; }
    }
    const top = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 15);
    ok(res, { total: rows.length, byEv, issues: top(issues), giveUps: top(giveUps), refusals: top(refusals), perBot: Object.values(perBot).map((p) => ({ ...p, milestones: p.milestones.slice(-6) })), recent: telemetryRows(req.query, 60).map((x) => ({ ...x, data: JSON.parse(x.data) })) });
  });
  // JSON lines, the same shape as the runner's own log file, so `npm run bots:report -- --file <it>` reads it.
  r.get('/bots/telemetry/export', need, (req, res) => {
    const rows = telemetryRows(req.query, 0);
    audit(req, 'bots.telemetry.export', null, { rows: rows.length, days: req.query.days || 7, bot: req.query.bot || null, ev: req.query.ev || null });
    res.set({ 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="bots-telemetry-${new Date().toISOString().slice(0, 10)}.jsonl"` });
    res.send(rows.map((x) => x.data).join('\n') + (rows.length ? '\n' : ''));
  });
};
