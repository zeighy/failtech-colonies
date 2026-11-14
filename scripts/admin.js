#!/usr/bin/env node
'use strict';
// Admin accounts from the command line: the first one is made here, and this is the way back in if every admin is locked out.
// It works on the database the server uses (DB_PATH), whether the server is running or not.
//
//   npm run admin -- create <name> [--role admin|viewer]     asks for a passcode (or reads ADMIN_PASSWORD)
//   npm run admin -- passwd <name>                           a new passcode; signs that admin out
//   npm run admin -- totp-off <name>                         turns off its authenticator code (it sets one up again)
//   npm run admin -- enable <name> | disable <name>
//   npm run admin -- list
const readline = require('readline');

const args = process.argv.slice(2);
const [cmd, name] = args;
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };

function ask(prompt) {
  if (process.env.ADMIN_PASSWORD) return Promise.resolve(process.env.ADMIN_PASSWORD);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) rl.output.write(s); else rl.output.write('*'); }; // hide what is typed
    rl.question(prompt, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

async function main() {
  const store = require('../src/db');
  const admin = require('../src/admin');
  const bcrypt = require('bcrypt');
  const { db } = store;
  const find = () => db.prepare('SELECT * FROM admins WHERE username = ? COLLATE NOCASE').get(name || '');
  if (cmd === 'list') {
    const rows = db.prepare('SELECT * FROM admins ORDER BY id').all();
    if (!rows.length) console.log('No admins yet. Make one: npm run admin -- create <name>');
    for (const a of rows) console.log(`${a.id}\t${a.username}\t${a.role}${a.totp_on ? '\t2fa' : '\t-'}${a.disabled ? '\tdisabled' : ''}`);
    return 0;
  }
  if (!name) { console.error('Usage: npm run admin -- create|passwd|totp-off|enable|disable <name>, or list'); return 2; }
  if (cmd === 'create') {
    const pw = await ask(`Passcode for ${name}: `);
    if (!process.env.ADMIN_PASSWORD && (await ask('Again: ')) !== pw) { console.error('They do not match.'); return 1; }
    const out = await admin.createAdmin(name, pw, opt('role', 'admin'));
    if (!out.ok) { console.error(out.error); return 1; }
    db.prepare('INSERT INTO admin_audit (at, admin, action, target, ip) VALUES (?, ?, ?, ?, ?)').run(Date.now(), '(cli)', 'admin.create', name, 'cli');
    console.log(`Admin ${name} created. Sign in to the panel and set up an authenticator code under Account.`);
    return 0;
  }
  const a = find();
  if (!a) { console.error(`No admin called ${name}.`); return 1; }
  if (cmd === 'passwd') {
    const pw = await ask(`New passcode for ${a.username}: `);
    const bad = admin.checkPass(pw);
    if (bad) { console.error(bad); return 1; }
    db.prepare('UPDATE admins SET password = ? WHERE id = ?').run(await bcrypt.hash(pw, Number(process.env.BCRYPT_ROUNDS) || 12), a.id);
    admin.endAdminSessions(a.id);
  } else if (cmd === 'totp-off') {
    db.prepare('UPDATE admins SET totp_on = 0, totp_secret = NULL WHERE id = ?').run(a.id);
    admin.endAdminSessions(a.id);
  } else if (cmd === 'enable' || cmd === 'disable') {
    db.prepare('UPDATE admins SET disabled = ? WHERE id = ?').run(cmd === 'disable' ? 1 : 0, a.id);
    if (cmd === 'disable') admin.endAdminSessions(a.id);
  } else { console.error(`Unknown command ${cmd}.`); return 2; }
  db.prepare('INSERT INTO admin_audit (at, admin, action, target, ip) VALUES (?, ?, ?, ?, ?)').run(Date.now(), '(cli)', `admin.${cmd}`, a.username, 'cli');
  console.log('Done.');
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
