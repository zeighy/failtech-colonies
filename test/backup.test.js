'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-backup-'));
process.env.DB_PATH = path.join(dir, 'game.db');
process.env.SESSION_SECRET = 'x';
process.env.THEME = 'basic'; // assertions use the neutral wording, whatever the default theme is
process.env.BACKUP_DIR = path.join(dir, 'bk');
process.env.BACKUP_KEEP = '3';
const Database = require('better-sqlite3');
const store = require('../src/db');
const backup = require('../src/backup');
test.after(() => { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('a backup is a complete, readable, owner-only copy of the live database', async () => {
  store.db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('keeper', 'hash');
  const f = await backup.backupNow();
  assert.match(path.basename(f), /^failtech-\d{8}-\d{6}\.db$/);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
  const copy = new Database(f, { readonly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM users WHERE username = ?').get('keeper').n, 1);
  assert.equal(copy.pragma('user_version', { simple: true }), store.db.pragma('user_version', { simple: true }));
  copy.close();
  assert.equal(fs.readdirSync(process.env.BACKUP_DIR).filter((n) => n.endsWith('.part')).length, 0, 'no half-written files are left');
});

test('only the newest few are kept, and only our own files are ever removed', async () => {
  const bk = process.env.BACKUP_DIR;
  fs.writeFileSync(path.join(bk, 'notes.txt'), 'mine');
  for (const n of ['failtech-20200101-000000.db', 'failtech-20200102-000000.db', 'failtech-20200103-000000.db']) fs.writeFileSync(path.join(bk, n), '');
  await backup.backupNow();
  const names = backup.list(bk);
  assert.equal(names.length, 3);
  assert.ok(!names.includes('failtech-20200101-000000.db') && !names.includes('failtech-20200102-000000.db'), 'the oldest went first');
  assert.ok(fs.existsSync(path.join(bk, 'notes.txt')), 'unrelated files stay');
});

test('backups can be turned off', () => {
  process.env.BACKUP_INTERVAL_HOURS = '0';
  const logs = [];
  const stop = backup.start({ log: (m) => logs.push(m), error: () => {} });
  assert.match(logs[0], /off/);
  stop();
  delete process.env.BACKUP_INTERVAL_HOURS;
});
