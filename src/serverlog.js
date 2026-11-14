'use strict';
// The server log: what happened to accounts (sign-ups, sign-ins, failed sign-ins, verification, passcode resets, bans), what
// admins did that touches the game, backups, market interventions, bot control and server errors. It is a table, so the
// admin panel can filter, read and export it. Entries older than SERVER_LOG_DAYS (default 90) are pruned.
//
// Colony events (what a commander sees in their own log) stay in colony_events; admin actions are also in admin_audit.
const store = require('./db');
const { db } = store;

const LEVELS = new Set(['info', 'warn', 'error']);
const keepDays = () => Math.max(1, Number(process.env.SERVER_LOG_DAYS) || 90);
let writes = 0;

function write(level, category, message, { userId = null, ip = null, data = null } = {}) {
  try {
    db.prepare('INSERT INTO server_log (at, level, category, message, user_id, ip, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), LEVELS.has(level) ? level : 'info', String(category).slice(0, 32), String(message).slice(0, 1000), userId, ip ? String(ip).slice(0, 64) : null, data === null ? null : JSON.stringify(data).slice(0, 8000));
    if (++writes % 500 === 0) prune();
  } catch (e) { console.error('server log write failed:', e.message); }
}

function prune(now = Date.now()) {
  return db.prepare('DELETE FROM server_log WHERE at < ?').run(now - keepDays() * 86400000).changes;
}

// Filters: level, category, userId, q (text in the message), since/until (ms), before (id, for paging back).
function query({ level, category, userId, q, since, until, before, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (level) { where.push('l.level = ?'); args.push(level); }
  if (category) { where.push('l.category = ?'); args.push(category); }
  if (Number.isInteger(userId)) { where.push('l.user_id = ?'); args.push(userId); }
  if (q) { where.push("(l.message LIKE ? ESCAPE '\\' OR l.ip LIKE ? ESCAPE '\\' OR l.data LIKE ? ESCAPE '\\')"); const like = `%${String(q).replace(/[\\%_]/g, (m) => `\\${m}`)}%`; args.push(like, like, like); }
  if (since) { where.push('l.at >= ?'); args.push(since); }
  if (until) { where.push('l.at <= ?'); args.push(until); }
  if (before) { where.push('l.id < ?'); args.push(before); }
  const sql = `SELECT l.id, l.at, l.level, l.category, l.message, l.user_id AS userId, u.username, l.ip, l.data FROM server_log l LEFT JOIN users u ON u.id = l.user_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.id DESC LIMIT ?`;
  return db.prepare(sql).all(...args, Math.min(5000, Math.max(1, limit))).map((r) => ({ ...r, data: r.data ? safeParse(r.data) : null }));
}
function safeParse(s) { try { return JSON.parse(s); } catch (e) { return s; } }

const info = (category, message, extra) => write('info', category, message, extra);
const warn = (category, message, extra) => write('warn', category, message, extra);
const error = (category, message, extra) => write('error', category, message, extra);

module.exports = { write, info, warn, error, query, prune };
