'use strict';
// Admin panel: operations. Backups and snapshots (take, keep, delete, download, look inside, full restore at a restart),
// the server log (filter, page, export), maintenance mode and the players' banner, updates from the repository, restarts,
// signing every player out, database checks, and a test email.
const fs = require('fs');
const path = require('path');
const store = require('../db');
const backup = require('../backup');
const colonyRestore = require('../colonyRestore');
const serverlog = require('../serverlog');
const lifecycle = require('../lifecycle');
const mail = require('../mail');
const accounts = require('../accounts');
const turnstile = require('../turnstile');
const updater = require('./updater');
const { db } = store;

// Environment settings worth seeing, with secrets hidden.
const SHOWN = ['PORT', 'TICK_MS', 'IDLE_PAUSE', 'THEME', 'DB_PATH', 'TRUST_PROXY', 'ALLOWED_ORIGINS', 'PUBLIC_URL', 'EMAIL_VERIFICATION', 'MAIL_TRANSPORT', 'MAIL_FROM', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER',
  'TURNSTILE_SITE_KEY', 'BACKUP_INTERVAL_HOURS', 'BACKUP_KEEP', 'BACKUP_DIR', 'ADMIN_HOST', 'ADMIN_PORT', 'ADMIN_ALLOW', 'BOT_API_KEY_FILE', 'SERVER_LOG_DAYS', 'BOT_TELEMETRY_DAYS', 'RESTART_EXIT_CODE'];
const SECRET = ['SESSION_SECRET', 'SMTP_PASS', 'RESEND_API_KEY', 'POSTMARK_TOKEN', 'TURNSTILE_SECRET_KEY', 'BOT_API_KEY'];

function csvCell(v) {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // no formulas when opened in a spreadsheet
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

module.exports = (r, h) => {
  const { need, audit, body, toInt, ok, bad } = h;

  // ---- backups ----
  r.get('/backups', need, (req, res) => ok(res, { backups: backup.listAll(), settings: backup.settings(), pendingRestore: backup.pendingRestore() }));
  r.post('/backups', need, async (req, res, next) => {
    try {
      const b = body(req.body);
      const f = b.kind === 'snapshot' ? await backup.snapshot(b.label) : await backup.backupNow();
      audit(req, b.kind === 'snapshot' ? 'backup.snapshot' : 'backup.now', path.basename(f));
      serverlog.info('backup', `${b.kind === 'snapshot' ? 'Snapshot' : 'Backup'} ${path.basename(f)} taken by ${req.admin.username}`);
      ok(res, { name: path.basename(f) });
    } catch (e) { next(e); }
  });
  r.post('/backups/:name/keep', need, (req, res) => {
    const to = backup.keepAsSnapshot(req.params.name, body(req.body).label);
    if (!to) return bad(res, 'Could not keep that backup (missing, or already kept).');
    audit(req, 'backup.keep', req.params.name, { as: path.basename(to) });
    ok(res, { name: path.basename(to) });
  });
  r.post('/backups/:name/delete', need, (req, res) => {
    if (body(req.body).confirm !== req.params.name) return bad(res, 'Confirm with the file name.');
    if (!backup.remove(req.params.name)) return bad(res, 'No such backup.', 404);
    audit(req, 'backup.delete', req.params.name);
    ok(res);
  });
  r.get('/backups/:name/download', need, (req, res) => {
    if (req.admin.role !== 'admin') return bad(res, 'Read-only account.', 403); // a backup holds every password hash
    const f = backup.resolve(req.params.name);
    if (!f) return bad(res, 'No such backup.', 404);
    audit(req, 'backup.download', req.params.name);
    res.download(f, req.params.name);
  });
  r.get('/backups/:name/colonies', need, (req, res) => {
    const f = backup.resolve(req.params.name);
    if (!f) return bad(res, 'No such backup.', 404);
    const userId = toInt(req.query.userId);
    ok(res, colonyRestore.peek(f, { userId: Number.isInteger(userId) ? userId : null }));
  });
  // The whole world back to a backup: the server restarts, swaps the database at start-up, and keeps the current one as a
  // pre-restore copy.
  r.post('/backups/:name/restore', need, (req, res) => {
    if (body(req.body).confirm !== req.params.name) return bad(res, 'Confirm with the file name.');
    const job = backup.requestRestore(req.params.name);
    if (!job) return bad(res, 'No such backup.', 404);
    audit(req, 'backup.restore.full', req.params.name);
    serverlog.warn('backup', `Full restore of ${req.params.name} requested by ${req.admin.username}; restarting`);
    const restarting = lifecycle.restart(`full restore of ${req.params.name}`);
    ok(res, { restarting, supervised: lifecycle.supervised() });
  });
  r.post('/backups/restore/cancel', need, (req, res) => { backup.cancelRestore(); audit(req, 'backup.restore.cancel'); ok(res); });

  // ---- logs ----
  const logFilter = (q) => ({
    level: ['info', 'warn', 'error'].includes(q.level) ? q.level : null,
    category: typeof q.category === 'string' && /^[a-z]{1,20}$/.test(q.category) ? q.category : null,
    userId: Number.isInteger(toInt(q.userId)) ? toInt(q.userId) : undefined,
    q: typeof q.q === 'string' ? q.q.slice(0, 100) : '',
    since: Number(q.since) || null, until: Number(q.until) || null, before: Number.isInteger(toInt(q.before)) ? toInt(q.before) : null,
  });
  r.get('/logs', need, (req, res) => {
    ok(res, { logs: serverlog.query({ ...logFilter(req.query), limit: 200 }), categories: db.prepare('SELECT DISTINCT category FROM server_log ORDER BY category').all().map((x) => x.category) });
  });
  r.get('/logs/export', need, (req, res) => {
    const rows = serverlog.query({ ...logFilter(req.query), limit: 5000 });
    const csv = req.query.format === 'csv';
    audit(req, 'logs.export', null, { rows: rows.length, format: csv ? 'csv' : 'jsonl' });
    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Content-Disposition', `attachment; filename="server-log-${stamp}.${csv ? 'csv' : 'jsonl'}"`);
    if (csv) {
      const cols = ['id', 'at', 'level', 'category', 'message', 'userId', 'username', 'ip', 'data'];
      res.type('text/csv').send([cols.join(','), ...rows.map((x) => cols.map((c) => csvCell(c === 'at' ? new Date(x.at).toISOString() : x[c])).join(','))].join('\n'));
    } else res.type('application/x-ndjson').send(rows.map((x) => JSON.stringify({ ...x, at: new Date(x.at).toISOString() })).join('\n'));
  });

  // ---- maintenance ----
  r.get('/maintenance', need, async (req, res, next) => {
    try {
      const counts = {};
      for (const t of ['users', 'colonies', 'districts', 'colony_buildings', 'colony_events', 'market_orders', 'market_trades', 'orbital_orders', 'orbital_trades', 'sessions', 'server_log', 'admin_audit', 'bot_telemetry', 'email_tokens']) {
        counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
      }
      const env = {};
      for (const k of SHOWN) if (process.env[k] !== undefined && process.env[k] !== '') env[k] = process.env[k];
      for (const k of SECRET) if (process.env[k]) env[k] = '(set)';
      ok(res, {
        code: await updater.info(), update: await updater.settings(), supervised: lifecycle.supervised(), restartCode: lifecycle.RESTART_CODE,
        maintenance: lifecycle.maintenance(), notice: lifecycle.notice(), clockPaused: lifecycle.clockPaused(), hold: lifecycle.pauseState(), idlePause: process.env.IDLE_PAUSE !== 'off',
        mail: mail.status(), turnstile: turnstile.enabled(), emailVerification: accounts.verificationRequired(),
        counts, env, dbPath: store.dbPath, dbBytes: (() => { try { return fs.statSync(store.dbPath).size; } catch (e) { return 0; } })(),
      });
    } catch (e) { next(e); }
  });
  r.post('/maintenance/mode', need, (req, res) => {
    const b = body(req.body);
    lifecycle.setMaintenance(!!b.on, b.message);
    let ended = 0;
    if (b.on && b.signOut) ended = db.prepare('DELETE FROM sessions').run().changes;
    audit(req, b.on ? 'maintenance.on' : 'maintenance.off', null, { message: b.message || null, signOut: !!b.signOut });
    serverlog.warn('maintenance', `Maintenance mode ${b.on ? 'on' : 'off'} (${req.admin.username})`);
    ok(res, { sessionsEnded: ended });
  });
  r.post('/maintenance/notice', need, (req, res) => {
    const b = body(req.body);
    const hours = Number(b.hours) || 0;
    lifecycle.setNotice(b.text ? String(b.text) : '', { level: b.level, until: hours > 0 ? Date.now() + hours * 3600000 : null });
    audit(req, b.text ? 'notice.set' : 'notice.clear', null, { text: b.text || null, level: b.level || 'info', hours: hours || null });
    ok(res, { notice: lifecycle.notice() });
  });
  r.post('/maintenance/sessions', need, (req, res) => {
    const n = db.prepare('DELETE FROM sessions').run().changes;
    audit(req, 'sessions.end-all', null, { ended: n });
    serverlog.warn('maintenance', `All player sessions ended by ${req.admin.username} (${n})`);
    ok(res, { ended: n });
  });
  r.post('/maintenance/restart', need, (req, res) => {
    audit(req, 'server.restart');
    serverlog.warn('maintenance', `Restart requested by ${req.admin.username}`);
    ok(res, { restarting: lifecycle.restart('restart from the admin panel'), supervised: lifecycle.supervised() });
  });
  r.post('/maintenance/db/check', need, (req, res) => {
    const rows = db.pragma('quick_check').map((x) => x.quick_check);
    const fk = db.pragma('foreign_key_check').length;
    audit(req, 'db.check', null, { result: rows.slice(0, 5), fk });
    ok(res, { result: rows.slice(0, 50), foreignKeyProblems: fk });
  });
  r.post('/maintenance/db/optimize', need, (req, res) => {
    const before = fs.statSync(store.dbPath).size;
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    db.pragma('optimize');
    const after = fs.statSync(store.dbPath).size;
    audit(req, 'db.optimize', null, { before, after });
    ok(res, { before, after });
  });
  r.post('/maintenance/test-email', need, async (req, res, next) => {
    try {
      const to = accounts.normEmail(body(req.body).to);
      if (!to) return bad(res, 'Bad address.');
      await mail.send({ to, subject: 'Test from the admin panel', text: `This is a test message sent by ${req.admin.username}.`, html: `<p>This is a test message sent by ${req.admin.username}.</p>` });
      audit(req, 'mail.test', to);
      ok(res, { transport: mail.transportName() });
    } catch (e) { bad(res, `Sending failed: ${e.message}`, 502); }
  });

  // ---- updates ----
  r.post('/update/settings', need, (req, res) => {
    const b = body(req.body);
    const out = updater.setSettings({ repo: typeof b.repo === 'string' ? b.repo.trim() : undefined, branch: typeof b.branch === 'string' ? b.branch.trim() : undefined });
    if (!out.ok) return bad(res, out.error);
    audit(req, 'update.settings', null, { repo: b.repo, branch: b.branch });
    ok(res);
  });
  r.post('/update/check', need, (req, res) => {
    const out = updater.check();
    if (!out.ok) return bad(res, out.error, 409);
    ok(res, out);
  });
  r.post('/update/apply', need, (req, res) => {
    const b = body(req.body);
    const out = updater.apply({ force: !!b.force, restart: b.restart !== false, snapshot: (label) => backup.snapshot(label) });
    if (!out.ok) return bad(res, out.error, 409);
    audit(req, b.force ? 'update.apply.force' : 'update.apply');
    serverlog.warn('maintenance', `Update started by ${req.admin.username}${b.force ? ' (forced)' : ''}`);
    ok(res, out);
  });
  r.get('/jobs/:id', need, (req, res) => {
    const j = updater.job(toInt(req.params.id));
    if (!j) return bad(res, 'No such job.', 404);
    ok(res, { job: j });
  });
};
