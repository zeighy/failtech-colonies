'use strict';
// Admin panel: player accounts and their colonies. Create, edit (callsign, email, note), verify the address by hand, ban
// and lift bans, set a passcode or send a reset email, sign out everywhere, delete (parking the colony for someone else, or
// wiping it), grant credits or fragments, set a stock or the Headquarters timer, roll a colony back to a backup, and read the
// account's log and colony events.
const store = require('../db');
const accounts = require('../accounts');
const absence = require('../absence');
const backup = require('../backup');
const colonyRestore = require('../colonyRestore');
const serverlog = require('../serverlog');
const lifecycle = require('../lifecycle');
const engine = require('../engine');
const orbital = require('../orbital');
const hq = require('../hq');
const { db, config } = store;

const DAY = 86400000;
function colonyBrief(c) {
  if (!c) return null;
  const st = db.prepare('SELECT name FROM stations WHERE colony_id = ?').get(c.id);
  return {
    id: c.id, hub: c.hub_level, population: c.population, credits: c.credits, morale: Math.round(c.morale), age: c.age, status: c.status, won: !!c.won,
    shutdown: c.shutdown_tick !== null && c.shutdown_tick !== undefined, phase: absence.phase(c), parkedAt: c.parked_at, lastActive: c.last_active_at,
    station: st ? st.name : null, noBots: !!c.no_bots,
  };
}
function userRow(u) {
  return {
    id: u.id, username: u.username, email: u.email, verified: !!u.email_verified, createdAt: u.created_at || null, createdIp: u.created_ip,
    lastLoginAt: u.last_login_at, lastIp: u.last_ip, banned: !!u.banned_at && (!u.ban_until || u.ban_until > Date.now()), bannedAt: u.banned_at, banUntil: u.ban_until, banReason: u.ban_reason,
    note: u.admin_note, totp: !!u.totp_on, kind: u.bot_profile ? 'bot' : u.generated ? 'generated' : 'player', profile: u.bot_profile,
  };
}

module.exports = (r, h) => {
  const { need, audit, body, toInt, ok, bad } = h;
  const userOr404 = (req, res) => { const u = accounts.byId(toInt(req.params.id)); if (!u) bad(res, 'No such account.', 404); return u; };

  // ?q= callsign, email or address (also "#12" for an id); ?kind= player | bot | generated | all; ?filter= banned | unverified | online
  r.get('/users', need, (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const kind = ['player', 'bot', 'generated', 'all'].includes(req.query.kind) ? req.query.kind : 'player';
    const filter = String(req.query.filter || '');
    const page = Math.max(0, toInt(req.query.page) || 0);
    const where = [];
    const args = [];
    if (kind === 'player') where.push('u.generated = 0 AND u.bot_profile IS NULL');
    if (kind === 'bot') where.push('u.bot_profile IS NOT NULL');
    if (kind === 'generated') where.push('u.generated = 1');
    if (filter === 'banned') where.push('u.banned_at IS NOT NULL');
    if (filter === 'unverified') where.push('u.email_verified = 0 AND u.generated = 0 AND u.bot_profile IS NULL');
    if (filter === 'recent') { where.push('u.created_at >= ?'); args.push(Date.now() - 7 * DAY); }
    if (q) {
      const id = /^#(\d+)$/.exec(q);
      if (id) { where.push('u.id = ?'); args.push(Number(id[1])); } else {
        const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        where.push("(u.username LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.last_ip LIKE ? ESCAPE '\\' OR u.created_ip LIKE ? ESCAPE '\\')");
        args.push(like, like, like, like);
      }
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM users u ${w}`).get(...args).n;
    const rows = db.prepare(`SELECT u.* FROM users u ${w} ORDER BY u.id DESC LIMIT 50 OFFSET ?`).all(...args, page * 50);
    ok(res, { total, page, users: rows.map((u) => ({ ...userRow(u), colony: colonyBrief(db.prepare('SELECT * FROM colonies WHERE user_id = ?').get(u.id)) })) });
  });

  r.get('/users/:id', need, (req, res) => {
    const u = userOr404(req, res);
    if (!u) return;
    const c = db.prepare('SELECT * FROM colonies WHERE user_id = ?').get(u.id);
    const districts = c ? store.loadDistricts(c.id).map((d) => ({ id: d.id, type: d.type, name: d.name, level: d.type === 'core' ? c.hub_level : d.level })) : [];
    ok(res, {
      user: userRow(u), colony: colonyBrief(c), districts,
      resources: Object.entries(config.resources).map(([id, x]) => ({ id, name: x.name })).sort((a, b) => a.name.localeCompare(b.name)),
      fragments: c ? c.data_fragments : null, hqTimer: c ? hq.timer(c.id) : null, tickMs: engine.TICK_MS,
      events: c ? db.prepare('SELECT tick, kind, message FROM colony_events WHERE colony_id = ? ORDER BY id DESC LIMIT 60').all(c.id) : [],
      log: serverlog.query({ userId: u.id, limit: 100 }),
      sameIp: u.last_ip ? db.prepare('SELECT id, username FROM users WHERE (last_ip = ? OR created_ip = ?) AND id != ? LIMIT 20').all(u.last_ip, u.last_ip, u.id) : [],
    });
  });

  r.post('/users', need, async (req, res, next) => {
    try {
      const b = body(req.body);
      const username = typeof b.username === 'string' ? b.username.trim() : '';
      if (!accounts.CALLSIGN.test(username)) return bad(res, 'Callsign must be 3-20 letters, numbers or underscores.');
      const pw = accounts.checkPassword(b.password);
      if (pw) return bad(res, pw);
      const email = b.email ? accounts.normEmail(b.email) : null;
      if (b.email && !email) return bad(res, 'Bad email address.');
      if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username) || db.prepare('SELECT 1 FROM stations WHERE name = ? COLLATE NOCASE').get(username)) return bad(res, 'That callsign is taken.');
      if (email && accounts.emailTaken(email)) return bad(res, 'That email address is already in use.');
      const hash = await accounts.hashPassword(b.password);
      const id = Number(db.prepare('INSERT INTO users (username, password, email, email_verified, created_at, created_ip) VALUES (?, ?, ?, ?, ?, ?)').run(username, hash, email, email && b.verified !== false ? 1 : 0, Date.now(), 'admin').lastInsertRowid);
      audit(req, 'user.create', `${username} #${id}`, { email });
      serverlog.info('account', `Account ${username} created by admin ${req.admin.username}`, { userId: id });
      ok(res, { id });
    } catch (e) { next(e); }
  });

  r.post('/users/:id/update', need, (req, res) => {
    const u = userOr404(req, res);
    if (!u) return;
    const b = body(req.body);
    const changes = {};
    if (b.username !== undefined && b.username !== u.username) {
      const n = String(b.username).trim();
      if (!accounts.CALLSIGN.test(n)) return bad(res, 'Callsign must be 3-20 letters, numbers or underscores.');
      if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND id != ?').get(n, u.id) || db.prepare('SELECT 1 FROM stations WHERE name = ? COLLATE NOCASE').get(n)) return bad(res, 'That callsign is taken.');
      changes.username = n;
    }
    if (b.email !== undefined && (b.email || null) !== u.email) {
      const e = b.email ? accounts.normEmail(b.email) : null;
      if (b.email && !e) return bad(res, 'Bad email address.');
      if (e && accounts.emailTaken(e, u.id)) return bad(res, 'That email address is already in use.');
      changes.email = e;
      changes.email_verified = e && b.verified !== false ? 1 : 0; // an address an admin sets is taken as verified unless they say otherwise
    } else if (b.verified !== undefined) changes.email_verified = b.verified && u.email ? 1 : 0;
    if (b.note !== undefined) changes.admin_note = b.note ? String(b.note).slice(0, 1000) : null;
    const keys = Object.keys(changes);
    if (!keys.length) return ok(res);
    db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => changes[k]), u.id);
    if (changes.email_verified === 1 && !u.email_verified) db.prepare("UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = 'verify' AND used_at IS NULL").run(Date.now(), u.id);
    audit(req, 'user.update', `${u.username} #${u.id}`, { ...changes, admin_note: changes.admin_note !== undefined ? '(changed)' : undefined });
    serverlog.info('account', `Account ${u.username} changed by admin ${req.admin.username}: ${keys.join(', ')}`, { userId: u.id });
    ok(res);
  });

  r.post('/users/:id/verify', need, (req, res) => {
    const u = userOr404(req, res);
    if (!u) return;
    if (!u.email) {
      const t = db.prepare("SELECT email FROM email_tokens WHERE user_id = ? AND purpose = 'verify' ORDER BY id DESC LIMIT 1").get(u.id);
      if (!t) return bad(res, 'The account has no email address to verify.');
      if (accounts.emailTaken(t.email, u.id)) return bad(res, 'That address is in use by another account.');
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(t.email, u.id);
    }
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(u.id);
    db.prepare("UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = 'verify' AND used_at IS NULL").run(Date.now(), u.id);
    audit(req, 'user.verify', `${u.username} #${u.id}`);
    serverlog.info('account', `Email marked verified by admin ${req.admin.username}`, { userId: u.id });
    ok(res);
  });

  // hours: 0 or missing for a ban until lifted
  r.post('/users/:id/ban', need, (req, res) => {
    const u = userOr404(req, res);
    if (!u) return;
    const b = body(req.body);
    const hours = Number(b.hours) || 0;
    if (hours < 0 || hours > 24 * 3650) return bad(res, 'Bad duration.');
    const until = hours ? Date.now() + hours * 3600000 : null;
    const ended = accounts.ban(u.id, { reason: b.reason, until });
    lifecycle.kick(u.id);
    audit(req, 'user.ban', `${u.username} #${u.id}`, { reason: b.reason || null, hours: hours || 'indefinite' });
    serverlog.warn('account', `Suspended by admin ${req.admin.username}${until ? ` for ${hours} h` : ''}${b.reason ? `: ${b.reason}` : ''}`, { userId: u.id });
    ok(res, { sessionsEnded: ended });
  });
  r.post('/users/:id/unban', need, (req, res) => {
    const u = userOr404(req, res);
    if (!u) return;
    accounts.unban(u.id);
    audit(req, 'user.unban', `${u.username} #${u.id}`);
    serverlog.info('account', `Suspension lifted by admin ${req.admin.username}`, { userId: u.id });
    ok(res);
  });

  // { password } sets one; { sendReset: true } emails a reset to the verified address
  r.post('/users/:id/password', need, async (req, res, next) => {
    try {
      const u = userOr404(req, res);
      if (!u) return;
      const b = body(req.body);
      if (b.sendReset) {
        if (!u.email || !u.email_verified) return bad(res, 'The account has no verified email address.');
        const sent = await accounts.sendReset(u, null);
        if (!sent.ok) return bad(res, sent.error);
        audit(req, 'user.reset.email', `${u.username} #${u.id}`);
        return ok(res, { sentTo: sent.sentTo });
      }
      const pw = accounts.checkPassword(b.password);
      if (pw) return bad(res, pw);
      const ended = await accounts.setPassword(u.id, b.password);
      lifecycle.kick(u.id);
      audit(req, 'user.password', `${u.username} #${u.id}`);
      serverlog.info('account', `Passcode set by admin ${req.admin.username}`, { userId: u.id });
      ok(res, { sessionsEnded: ended });
    } catch (e) { next(e); }
  });
  // A player who lost their authenticator: the code is turned off (they can set it up again from the game's menu).
  r.post('/users/:id/totp-off', need, (req, res) => {
    const u = userOr404(req, res);
    if (!u) return;
    db.prepare('UPDATE users SET totp_secret = NULL, totp_on = 0, totp_step = 0 WHERE id = ?').run(u.id);
    audit(req, 'user.totp-off', `${u.username} #${u.id}`);
    serverlog.warn('account', `Authenticator code turned off by admin ${req.admin.username}`, { userId: u.id });
    ok(res);
  });
  r.post('/users/:id/logout', need, (req, res) => {
    const u = userOr404(req, res);
    if (!u) return;
    const n = store.endSessions(u.id);
    lifecycle.kick(u.id);
    audit(req, 'user.logout', `${u.username} #${u.id}`);
    ok(res, { sessionsEnded: n });
  });

  // colony: 'park' hands it to a generated account (where a bot or player may take it up), 'wipe' deletes it with the account
  r.post('/users/:id/delete', need, (req, res) => {
    const u = userOr404(req, res);
    if (!u) return;
    const b = body(req.body);
    if (b.confirm !== u.username) return bad(res, 'Type the callsign to confirm.');
    const c = db.prepare('SELECT id FROM colonies WHERE user_id = ?').get(u.id);
    if (c && b.colony !== 'park' && b.colony !== 'wipe') return bad(res, 'Choose what happens to the colony.');
    db.transaction(() => {
      if (c) { if (b.colony === 'park') absence.handOver(c.id); else store.wipeColony(c.id); }
      store.endSessions(u.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    })();
    lifecycle.kick(u.id);
    audit(req, 'user.delete', `${u.username} #${u.id}`, { email: u.email, colony: c ? b.colony : null });
    serverlog.warn('account', `Account ${u.username} deleted by admin ${req.admin.username}${c ? ` (colony ${b.colony === 'park' ? 'parked' : 'wiped'})` : ''}`);
    ok(res);
  });

  // ---- the colony (game-master tools) ----
  const colonyOr404 = (req, res) => { const c = db.prepare('SELECT * FROM colonies WHERE id = ?').get(toInt(req.params.id)); if (!c) bad(res, 'No such colony.', 404); return c; };
  r.post('/colonies/:id/credits', need, (req, res) => {
    const c = colonyOr404(req, res);
    if (!c) return;
    const b = body(req.body);
    const delta = Math.trunc(Number(b.delta));
    if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1e9) return bad(res, 'Bad amount.');
    const now = Math.max(0, c.credits + delta);
    db.prepare('UPDATE colonies SET credits = ? WHERE id = ?').run(now, c.id);
    store.addEvent(c.id, Number(store.getMeta('global_tick', 0)), delta > 0 ? 'good' : 'warn', `${delta > 0 ? 'Received' : 'Charged'} ${Math.abs(delta)} cr${b.reason ? `: ${String(b.reason).slice(0, 120)}` : ''}.`);
    audit(req, 'colony.credits', `colony #${c.id}`, { delta, reason: b.reason || null, before: c.credits, after: now });
    ok(res, { credits: now });
  });
  // delta: fragments to give or take. What is given also counts as recovered, which is what opens the Data screen.
  r.post('/colonies/:id/fragments', need, (req, res) => {
    const c = colonyOr404(req, res);
    if (!c) return;
    const b = body(req.body);
    const delta = toInt(b.delta);
    if (!delta || Math.abs(delta) > 10000) return bad(res, 'Bad amount.');
    const now = Math.max(0, c.data_fragments + delta);
    const change = now - c.data_fragments;
    if (!change) return bad(res, 'The colony has no fragments to take.');
    const tick = Number(store.getMeta('global_tick', 0));
    db.transaction(() => {
      db.prepare('UPDATE colonies SET data_fragments = ?, data_total = data_total + ? WHERE id = ?').run(now, Math.max(0, change), c.id);
      if (change > 0) orbital.setFlag(c.id, 'dataFragment', tick);
      const n = Math.abs(change);
      store.addEvent(c.id, tick, change > 0 ? 'good' : 'warn', `${change > 0 ? 'Received' : 'Lost'} ${n} data fragment${n === 1 ? '' : 's'}${b.reason ? `: ${String(b.reason).slice(0, 120)}` : ''}.`);
      audit(req, 'colony.fragments', `colony #${c.id}`, { delta: change, reason: b.reason || null, before: c.data_fragments, after: now });
    })();
    ok(res, { fragments: now });
  });
  // left: ticks from now; readyTick: the timer the admin was looking at, so a page left open cannot move the next one
  r.post('/colonies/:id/hq-timer', need, (req, res) => {
    const c = colonyOr404(req, res);
    if (!c) return;
    const b = body(req.body);
    const t = hq.timer(c.id);
    if (!t) return bad(res, 'No Headquarters work is in progress.', 409);
    if (toInt(b.readyTick) !== t.readyTick) return bad(res, 'The timer has changed. Reload the page.', 409);
    const left = toInt(b.left);
    if (!(left >= 0 && left <= t.total)) return bad(res, 'Time left must be between zero and the full duration.');
    hq.setTimer(c.id, left);
    audit(req, 'colony.hq-timer', `colony #${c.id}`, { work: t.name, before: t.left, after: left });
    ok(res);
  });
  r.post('/colonies/:id/stock', need, (req, res) => {
    const c = colonyOr404(req, res);
    if (!c) return;
    const b = body(req.body);
    const d = db.prepare('SELECT id, name FROM districts WHERE id = ? AND colony_id = ?').get(toInt(b.district), c.id);
    if (!d) return bad(res, 'No such district in that colony.');
    if (!Object.prototype.hasOwnProperty.call(config.resources, b.resource)) return bad(res, 'Unknown resource.');
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1e9) return bad(res, 'Bad amount.');
    const before = store.loadInventory(c.id, d.id)[b.resource] || 0;
    store.saveInventory(c.id, { [b.resource]: amount }, d.id);
    audit(req, 'colony.stock', `colony #${c.id}`, { district: d.id, resource: b.resource, before, after: amount });
    ok(res);
  });
  r.get('/colonies/:id/stock', need, (req, res) => {
    const c = colonyOr404(req, res);
    if (!c) return;
    ok(res, { districts: store.loadDistricts(c.id).map((d) => ({ id: d.id, name: d.name, type: d.type, inventory: store.loadInventory(c.id, d.id) })) });
  });

  // Which backups hold this colony (or, for an account without one, any colony of theirs), and how it stood in each.
  r.get('/users/:id/backups', need, (req, res) => {
    const u = userOr404(req, res);
    if (!u) return;
    const c = db.prepare('SELECT id FROM colonies WHERE user_id = ?').get(u.id);
    const out = [];
    for (const f of backup.listAll().slice(0, 60)) {
      const file = backup.resolve(f.name);
      try {
        const p = colonyRestore.peek(file, c ? { colonyId: c.id } : { userId: u.id });
        const byUser = c ? colonyRestore.peek(file, { userId: u.id }) : p;
        const list = [...p.colonies, ...byUser.colonies.filter((x) => !p.colonies.some((y) => y.id === x.id))];
        if (list.length) out.push({ backup: f.name, kind: f.kind, at: f.at, tick: p.tick, colonies: list });
      } catch (e) { /* unreadable backup: skipped */ }
    }
    ok(res, { current: c ? c.id : null, backups: out });
  });
  r.post('/colonies/:id/restore', need, (req, res) => {
    const b = body(req.body);
    const file = backup.resolve(b.backup);
    if (!file) return bad(res, 'No such backup.');
    const colonyId = toInt(req.params.id);
    const out = colonyRestore.restore({ file, colonyId, toUserId: b.toUserId ? toInt(b.toUserId) : null, current: b.current || null, note: b.note ? String(b.note).slice(0, 200) : null });
    if (!out.ok) return res.status(409).json(out);
    lifecycle.kick(out.userId);
    audit(req, 'colony.restore', `colony #${colonyId}`, { backup: b.backup, ...out });
    serverlog.warn('admin', `Colony #${colonyId} rolled back to ${b.backup} by ${req.admin.username}`, { userId: out.userId });
    ok(res, out);
  });
};
