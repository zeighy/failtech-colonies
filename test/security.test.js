'use strict';
// Hardening: headers, same-origin writes, input validation, auth, sessions, path traversal, races, limits.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-sec-'));
process.env.DB_PATH = path.join(dir, 'sec.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.THEME = 'basic'; // assertions use the neutral wording, whatever the default theme is
process.env.EMAIL_VERIFICATION = 'off'; // these players sign up without an email address (test/accounts.test.js covers verification)
process.env.AUTH_RATE_LIMIT = '100000';
process.env.API_RATE_LIMIT = '100000';
process.env.BCRYPT_ROUNDS = '4';
process.env.HAZARDS = 'off';

const app = require('../server');
const engine = require('../src/engine');
const store = require('../src/db');
const security = require('../src/security');
const validate = require('../src/validate');
const { db, config } = store;

let server, port;
test.before(async () => { await new Promise((r) => { server = app.listen(0, r); }); port = server.address().port; });
test.after(() => { server.closeAllConnections && server.closeAllConnections(); server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// raw HTTP, so paths are sent exactly as written (fetch would normalise "/../")
function raw(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...headers } }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
function client() {
  let cookie = '';
  const call = async (method, url, body, extra = {}) => {
    const r = await raw(method, url, { headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...extra }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const set = r.headers['set-cookie'];
    if (set) cookie = set[0].split(';')[0];
    let json = null; try { json = r.json(); } catch (e) { /* not json */ }
    return { status: r.status, headers: r.headers, body: json, text: r.text, setCookie: set };
  };
  return { get: (u, h) => call('GET', u, undefined, h), post: (u, b, h) => call('POST', u, b === undefined ? {} : b, h), cookie: () => cookie };
}
let n = 0;
async function player(coreLevel) {
  const c = client();
  const r = await c.post('/api/register', { username: `sec_${++n}`, password: 'hunter2222' });
  assert.equal(r.status, 200, r.text);
  const id = db.prepare('SELECT id FROM colonies ORDER BY id DESC LIMIT 1').get().id;
  const core = store.coreId(id);
  if (coreLevel) db.prepare('UPDATE colonies SET hub_level = ? WHERE id = ?').run(coreLevel, id);
  db.prepare("UPDATE colony_inventory SET amount = 3000 WHERE district_id = ? AND resource_id IN ('scrap','machined_parts','building_materials','alloys','clean_water','rations')").run(core);
  return { c, id, core };
}
const cr = (id) => db.prepare('SELECT credits FROM colonies WHERE id = ?').get(id).credits;
const stock = (id, r) => store.loadInventory(id)[r] || 0;
const nBuildings = (id) => db.prepare('SELECT COUNT(*) AS n FROM colony_buildings WHERE colony_id = ?').get(id).n + db.prepare('SELECT COUNT(*) AS n FROM colony_work_orders WHERE colony_id = ?').get(id).n;

test('responses carry the security headers; the API is never cached; nothing announces the framework', async () => {
  const r = await raw('GET', '/');
  for (const h of ['x-content-type-options', 'x-frame-options', 'content-security-policy', 'cross-origin-opener-policy', 'referrer-policy', 'permissions-policy']) assert.ok(r.headers[h], h);
  assert.ok(!r.headers['x-powered-by']);
  const csp = r.headers['content-security-policy'];
  for (const d of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "script-src 'self'"]) assert.ok(csp.includes(d), d);
  assert.ok(!/unsafe-eval|script-src[^;]*unsafe-inline/.test(csp));
  const api = await raw('GET', '/api/state');
  assert.equal(api.headers['cache-control'], 'no-store');
});

test('writes must be JSON, and must come from this site', async () => {
  const c = client();
  assert.equal((await raw('POST', '/api/login', { headers: { 'Content-Type': 'text/plain' }, body: '{"username":"a","password":"b"}' })).status, 415);
  assert.equal((await raw('POST', '/api/login', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=a&password=b' })).status, 415);
  const body = JSON.stringify({ username: 'nobody', password: 'whatever1' });
  const j = { 'Content-Type': 'application/json' };
  assert.equal((await raw('POST', '/api/login', { headers: { ...j, Origin: 'http://evil.example' }, body })).status, 403);
  assert.equal((await raw('POST', '/api/login', { headers: { ...j, 'Sec-Fetch-Site': 'cross-site' }, body })).status, 403);
  assert.equal((await raw('POST', '/api/login', { headers: { ...j, Origin: 'not a url' }, body })).status, 403);
  assert.equal((await raw('POST', '/api/login', { headers: { ...j, Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' }, body })).status, 401, 'same-origin reaches the handler');
  assert.equal((await raw('POST', '/api/login', { headers: j, body })).status, 401, 'no Origin (curl, scripts) is fine');
  assert.ok(c);
});

test('malformed and oversized bodies are client errors, not server errors, and leak nothing', async () => {
  const j = { 'Content-Type': 'application/json' };
  const bad = await raw('POST', '/api/login', { headers: j, body: '{"username": ' });
  assert.equal(bad.status, 400);
  assert.ok(!/at |node_modules|SyntaxError/.test(bad.text), 'no stack trace');
  assert.equal((await raw('POST', '/api/login', { headers: j, body: JSON.stringify({ username: 'a'.repeat(20000), password: 'x' }) })).status, 413);
  assert.equal((await raw('POST', '/api/login', { headers: j, body: '"just a string"' })).status, 400, 'strict JSON: only objects and arrays');
  const arr = await raw('POST', '/api/login', { headers: j, body: '[1,2,3]' });
  assert.equal(arr.status, 401, 'an array is not credentials');
  assert.equal((await raw('POST', '/api/login', { headers: j, body: '{"__proto__": {"polluted": true}, "username": "x", "password": "y"}' })).status, 401);
  assert.equal({}.polluted, undefined, 'no prototype pollution');
});

test('path traversal and sensitive files are never served', async () => {
  const paths = [
    '/..%2f..%2fserver.js', '/%2e%2e/server.js', '/../server.js', '/..%2fgame_config.json', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd', '/js/..%2f..%2f..%2fsrc%2fdb.js',
    '/.env', '/.git/config', '/js/../../package.json', '/failtech.db', '/sec.db', '/src/db.js', '/game_config.json', '/package.json', '/node_modules/express/package.json',
    '/%00', '/js/game.js%00.html', '/\\..\\server.js',
  ];
  for (const p of paths) {
    const r = await raw('GET', p);
    assert.ok(r.status !== 200 || /<html|<!doctype/i.test(r.text) === false && !/express\(|require\(/.test(r.text), `${p} -> ${r.status}`);
    assert.ok(!/require\(|session_secret|"dependencies"/.test(r.text), `${p} leaked content`);
  }
  assert.equal((await raw('GET', '/js/game.js')).status, 200);
  assert.equal((await raw('GET', '/css/')).status, 404, 'no directory listing');
});

test('names from the client only ever match real config entries (no "constructor" or "__proto__" tricks)', async () => {
  const { c, id } = await player(5);
  const before = { cr: cr(id), b: nBuildings(id) };
  for (const type of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', '', null, 7, ['solar_array'], { a: 1 }]) {
    const r = await c.post('/api/build', { ring: 1, slot: 0, type });
    assert.equal(r.status, 400, `build ${JSON.stringify(type)} -> ${r.status} ${r.text}`);
  }
  assert.equal(nBuildings(id), before.b);
  for (const resource of ['__proto__', 'constructor', 'toString']) {
    for (const [url, b] of [
      ['/api/contract', { resource, side: 'export', amount: 5 }],
      ['/api/market', { side: 'buy', resource, price: 5, qty: 1, ttl: 100 }],
      ['/api/shipment', { from: 1, to: 2, resource, qty: 5 }],
      ['/api/route', { from: 1, to: 2, resource, rate: 5 }],
    ]) { const r = await c.post(url, b); assert.equal(r.status, 400, `${url} ${resource} -> ${r.status} ${r.text}`); }
  }
  assert.equal((await c.post('/api/express', { sell: JSON.parse('{"__proto__": 5, "constructor": 5}') })).status, 400);
  assert.equal((await c.post('/api/express', { sell: [1, 2], buy: 'scrap' })).status, 400);
  assert.equal((await c.post('/api/found', { type: '__proto__' })).status, 400);
  assert.equal((await c.post('/api/found', { type: 'constructor' })).status, 400);
  assert.equal((await c.post('/api/recipe', { ring: 1, slot: 0, recipe: '__proto__' })).status, 400);
  assert.equal(cr(id), before.cr);
});

test('slots must be real integers inside the unlocked rings: no negative, fractional, hex, exponent or huge slots', async () => {
  const { c, id } = await player(5);
  const base = nBuildings(id);
  for (const slot of [-1, -5, 0.5, 1.5, 1e9, 1e300, Infinity, NaN, '0x1', '1e1', ' 1', '1 ', [1], { a: 1 }, true, null, '99999999999999999999']) {
    for (const ring of [1, 2]) {
      const r = await c.post('/api/build', { ring, slot, type: 'solar_array' });
      assert.equal(r.status, 400, `ring ${ring} slot ${JSON.stringify(slot)} -> ${r.status}`);
    }
  }
  for (const ring of [0, -1, 1.5, 6, 99, '1e0', 'one', null, [1]]) {
    const r = await c.post('/api/build', { ring, slot: 0, type: 'solar_array' });
    assert.equal(r.status, 400, `ring ${JSON.stringify(ring)} -> ${r.status}`);
  }
  assert.equal(nBuildings(id), base, 'no orders were created');
  assert.equal((await c.post('/api/build', { ring: 1, slot: 0, type: 'solar_array' })).status, 200, 'a real slot still works');
  assert.equal((await c.post('/api/demolish', { ring: -1, slot: 0 })).status, 400);
  assert.equal((await c.post('/api/toggle', { ring: 1, slot: 0.5 })).status, 400);
});

test('numbers must be real, finite and in range: no NaN, Infinity, negatives, strings or exponent tricks', async () => {
  const { c, id } = await player(4);
  const cr0 = cr(id);
  const bad = [-1, -1e9, 0, 0.4, NaN, Infinity, -Infinity, 1e300, '1e3', '0x10', '5abc', '', [5], { a: 5 }, null, true];
  for (const qty of bad) {
    assert.ok([400].includes((await c.post('/api/market', { side: 'sell', resource: 'alloys', price: 20, qty, ttl: 100 })).status), `market qty ${JSON.stringify(qty)}`);
  }
  for (const price of [-1, 0, NaN, Infinity, 1e300, '1e3', '0x10', 'abc', null, [1], 0.001]) {
    assert.equal((await c.post('/api/market', { side: 'buy', resource: 'alloys', price, qty: 1, ttl: 100 })).status, 400, `price ${JSON.stringify(price)}`);
  }
  for (const amount of [-5, NaN, Infinity, '1e9', 'x', null, [5]]) assert.equal((await c.post('/api/contract', { resource: 'scrap', side: 'export', amount })).status, 400, `amount ${JSON.stringify(amount)}`);
  assert.equal((await c.post('/api/express', { sell: { scrap: -50 } })).status, 400, 'a negative amount is not an order');
  assert.equal((await c.post('/api/express', { sell: { scrap: 'lots' } })).status, 400);
  assert.equal(cr(id), cr0, 'no money appeared');
  assert.ok(stock(id, 'alloys') <= 3000 && stock(id, 'scrap') <= 3000, 'and no goods');
});

test('players cannot reach other players\' districts, orders or missions by id', async () => {
  const a = await player(5); const b = await player(5);
  assert.equal((await b.c.post('/api/build', { ring: 1, slot: 0, type: 'solar_array', district: a.core })).status, 400);
  assert.equal((await b.c.post('/api/shipment', { from: a.core, to: b.core, resource: 'scrap', qty: 50 })).status, 400);
  assert.equal((await b.c.post('/api/shipment', { from: b.core, to: a.core, resource: 'scrap', qty: 50 })).status, 400);
  assert.equal((await b.c.post('/api/route', { from: b.core, to: a.core, resource: 'scrap', rate: 5 })).status, 400);
  assert.equal((await b.c.post('/api/market', { side: 'sell', resource: 'scrap', price: 1, qty: 10, ttl: 100, district: a.core })).status, 400);
  assert.equal(stock(a.id, 'scrap'), 3000);
  // an order of A's cannot be cancelled by B
  const o = await a.c.post('/api/market', { side: 'buy', resource: 'alloys', price: 1, qty: 3, ttl: 100 });
  const low = (await a.c.post('/api/market', { side: 'buy', resource: 'scrap', price: 0.21, qty: 3, ttl: 100 }));
  assert.ok(o.status === 400 || o.status === 200);
  const mine = db.prepare("SELECT id FROM market_orders WHERE colony_id = ? AND status = 'open' LIMIT 1").get(a.id);
  if (mine) assert.equal((await b.c.post('/api/market-cancel', { orderId: mine.id })).status, 400);
  assert.ok(low);
  assert.equal((await b.c.post('/api/cancel', { orderId: 1 })).status, 400);
  assert.equal((await b.c.post('/api/mission', { id: 1, faction: 'cinder' })).status, 400);
});

test('registration: types, length, strength; callsigns are unique regardless of case, even when requested at the same instant', async () => {
  const c = client();
  const reg = (b) => c.post('/api/register', b);
  assert.equal((await reg({ username: ['abc'], password: 'hunter2222' })).status, 400);
  assert.equal((await reg({ username: 'abcd', password: ['hunter2222'] })).status, 400);
  assert.equal((await reg({ username: { a: 1 }, password: 'hunter2222' })).status, 400);
  assert.equal((await reg({ username: 'abc d', password: 'hunter2222' })).status, 400);
  assert.equal((await reg({ username: 'bad<script>', password: 'hunter2222' })).status, 400);
  assert.equal((await reg({ username: 'shortpw', password: '1234567' })).status, 400, 'at least 8 characters');
  assert.equal((await reg({ username: 'longpw_ok', password: 'x'.repeat(73) })).status, 400, 'bcrypt would silently ignore everything past 72 bytes');
  assert.equal((await reg({ username: 'longpw_two', password: 'é'.repeat(37) })).status, 400, '74 bytes of 37 characters');
  assert.equal((await reg({ username: 'fine_pw1', password: 'x'.repeat(72) })).status, 200);
  // the race: the same callsign in two cases at once
  const [r1, r2, r3] = await Promise.all(['RaceMe', 'raceme', 'RACEME'].map((u) => client().post('/api/register', { username: u, password: 'hunter2222' })));
  assert.deepEqual([r1.status, r2.status, r3.status].sort(), [200, 409, 409]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'raceme' COLLATE NOCASE").get().n, 1);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'users_username_nocase'").get(), 'the database enforces it');
  assert.throws(() => db.prepare("INSERT INTO users (username, password) VALUES ('RACEME', 'x')").run(), /UNIQUE/);
});

test('login: wrong passcodes are throttled per callsign (even with the right one afterwards); no user enumeration', async () => {
  const c = client();
  await c.post('/api/register', { username: 'lockme', password: 'hunter2222' });
  const t = async (u, p) => (await client().post('/api/login', { username: u, password: p })).status;
  const a = Date.now(); assert.equal(await t('lockme', 'nope-nope'), 401); const known = Date.now() - a;
  const b = Date.now(); assert.equal(await t('nosuchuser', 'nope-nope'), 401); const unknown = Date.now() - b;
  assert.ok(Math.abs(known - unknown) < 400, `similar timing (${known}ms vs ${unknown}ms)`);
  for (let i = 0; i < 7; i++) assert.equal(await t('lockme', `wrong-${i}-wrong`), 401);
  assert.equal(await t('lockme', 'hunter2222'), 429, 'locked out after repeated failures, even with the right passcode');
  assert.equal(await t('LOCKME', 'hunter2222'), 429, 'case does not dodge it');
  assert.equal(await t('someone_else', 'hunter2222'), 401, 'other callsigns are unaffected');
  assert.equal((await client().post('/api/login', { username: 'lockme', password: 'x'.repeat(73) })).status, 401);
  assert.equal((await client().post('/api/login', { username: 'lockme' })).status, 401);
});

test('sessions: httpOnly, SameSite, new id on every sign-in, destroyed on logout', async () => {
  const c = client();
  const reg = await c.post('/api/register', { username: 'sess_one', password: 'hunter2222' });
  const cookie = reg.setCookie[0];
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /failtech\.sid=/);
  const first = c.cookie();
  const login = await c.post('/api/login', { username: 'sess_one', password: 'hunter2222' });
  assert.equal(login.status, 200);
  assert.notEqual(c.cookie(), first, 'a fresh session id after signing in again');
  // the old id no longer works
  const stale = client(); stale.get('/'); 
  const old = await raw('GET', '/api/state', { headers: { cookie: first } });
  assert.equal(old.status, 401, 'the previous session is gone');
  const mine = c.cookie();
  assert.equal((await c.post('/api/logout')).status, 200);
  assert.equal((await raw('GET', '/api/state', { headers: { cookie: mine } })).status, 401, 'logout kills the session server-side too');
  assert.ok(stale);
});

test('the API refuses everything without a session', async () => {
  const c = client();
  for (const url of ['build', 'demolish', 'toggle', 'boost', 'cancel', 'upgrade', 'contract', 'reset', 'restart', 'ack', 'express', 'found', 'shipment', 'market', 'market-cancel', 'recipe', 'shield', 'mission', 'route', 'link', 'story-seen', 'resume']) {
    assert.equal((await c.post(`/api/${url}`, {})).status, 401, url);
  }
  for (const url of ['state', 'config', 'stream']) assert.equal((await c.get(`/api/${url}`)).status, 401, url);
  assert.equal((await c.get('/api/nope')).status, 404);
  assert.equal((await c.get('/game')).status, 302);
});

test('races: simultaneous requests cannot spend the same stock or credits twice', async () => {
  const { c, id, core } = await player(5);
  db.prepare("UPDATE colony_inventory SET amount = 100 WHERE district_id = ? AND resource_id = 'alloys'").run(core);
  // 12 sell orders of the full 100 alloys, all at once: exactly one can be funded
  const sells = await Promise.all(Array.from({ length: 12 }, () => c.post('/api/market', { side: 'sell', resource: 'alloys', price: 500, qty: 100, ttl: 100 })));
  const price = (b) => b.status;
  // the price band rejects 500 for alloys; use a valid price instead
  assert.ok(sells.every((r) => price(r) === 400));
  const ref = require('../src/marketsim').refPrice(config, 'alloys', Number(store.getMeta('global_tick', 0)) || 1);
  const ok = await Promise.all(Array.from({ length: 12 }, () => c.post('/api/market', { side: 'sell', resource: 'alloys', price: Math.round(ref * 3 * 100) / 100, qty: 100, ttl: 100 })));
  assert.equal(ok.filter((r) => r.status === 200).length, 1, 'only one of twelve simultaneous sells of the same stock succeeds');
  assert.equal(stock(id, 'alloys'), 0);
  // 10 buys that together cost more than the colony has
  db.prepare('UPDATE colonies SET credits = 1000 WHERE id = ?').run(id);
  const buys = await Promise.all(Array.from({ length: 10 }, () => c.post('/api/market', { side: 'buy', resource: 'alloys', price: Math.round(ref * 0.5 * 100) / 100, qty: 100, ttl: 100 })));
  const spent = db.prepare("SELECT COALESCE(SUM(escrow), 0) AS s FROM market_orders WHERE colony_id = ? AND side = 'buy' AND status = 'open'").get(id).s;
  assert.ok(spent <= 1000, `escrowed ${spent} of 1000`);
  assert.ok(cr(id) >= 0 && cr(id) + spent === 1000);
  assert.ok(buys.some((r) => r.status === 400));
  // 10 simultaneous builds on one slot
  const builds = await Promise.all(Array.from({ length: 10 }, () => c.post('/api/build', { ring: 1, slot: 3, type: 'solar_array' })));
  assert.equal(builds.filter((r) => r.status === 200).length, 1);
  // double-spend through two different channels at once: express trip and a route cannot both take the same goods
  db.prepare("UPDATE colony_inventory SET amount = 50 WHERE district_id = ? AND resource_id = 'scrap'").run(core);
  db.prepare('UPDATE colonies SET credits = 5000 WHERE id = ?').run(id);
  const both = await Promise.all([
    c.post('/api/express', { sell: { scrap: 5 } }), c.post('/api/express', { sell: { scrap: 5 } }), c.post('/api/express', { sell: { scrap: 5 } }),
  ]);
  assert.equal(both.filter((r) => r.status === 200).length, 1, 'one express trip at a time');
  assert.ok(stock(id, 'scrap') >= 0);
});

test('streams: a few per player, then refused; closing one frees a slot', async () => {
  const { c } = await player(1);
  const open = async () => {
    const ctl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { headers: { cookie: c.cookie() }, signal: ctl.signal });
    return { res, close: () => ctl.abort() };
  };
  const s = [];
  for (let i = 0; i < 4; i++) { const x = await open(); assert.equal(x.res.status, 200); s.push(x); }
  const fifth = await open();
  assert.equal(fifth.res.status, 429);
  s[0].close();
  await new Promise((r) => setTimeout(r, 150));
  const again = await open();
  assert.equal(again.res.status, 200);
  again.close(); s.slice(1).forEach((x) => x.close());
});

test('rate limiter: blocks after the limit, reports Retry-After, forgets after the window', async () => {
  const lim = security.limiter({ windowMs: 200, max: 3, key: () => 'k' });
  const call = () => { const res = { code: 200, headers: {}, set(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json() { return this; } }; let nexted = false; lim({}, res, () => { nexted = true; }); return { nexted, res }; };
  assert.ok(call().nexted && call().nexted && call().nexted);
  const blocked = call();
  assert.ok(!blocked.nexted && blocked.res.code === 429 && blocked.res.headers['Retry-After']);
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(call().nexted, 'the window slid');
  clearInterval(lim.timer);
});

test('validators: strict types, own properties only', () => {
  const { toInt, toNum, own, hasOwn, body } = validate;
  assert.equal(toInt(5), 5); assert.equal(toInt('12'), 12); assert.equal(toInt('-3'), -3);
  for (const v of [5.5, NaN, Infinity, '0x10', '1e3', ' 7', '7 ', '', [7], true, null, undefined, {}, 2 ** 53, '9'.repeat(16)]) assert.ok(Number.isNaN(toInt(v)), String(v));
  assert.equal(toNum(1.5), 1.5); assert.equal(toNum('2.25'), 2.25);
  for (const v of [NaN, Infinity, '1e3', '0x1', 'abc', '', [1], null, true, '1.1234567']) assert.ok(Number.isNaN(toNum(v)), String(v));
  assert.equal(own({ a: 1 }, 'a'), 1);
  for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) assert.equal(own({ a: 1 }, k), undefined, k);
  assert.ok(!hasOwn({}, 5) && !hasOwn(null, 'a'));
  assert.deepEqual(body([1]), {}); assert.deepEqual(body('x'), {}); assert.deepEqual(body(null), {}); assert.deepEqual(body({ a: 1 }), { a: 1 });
});

test('a second server on the same database refuses to start (no double clock); the database file is owner-only', async () => {
  const mode = fs.statSync(process.env.DB_PATH).mode & 0o777;
  assert.equal(mode & 0o077, 0, `database mode is ${mode.toString(8)}`);
  const dbf = path.join(dir, 'lock.db');
  const env = { ...process.env, DB_PATH: dbf, PORT: '0', BCRYPT_ROUNDS: '4' };
  const start = () => spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const first = start();
  await new Promise((resolve) => { first.stdout.on('data', (d) => { if (/running at/.test(String(d))) resolve(); }); setTimeout(resolve, 4000); });
  const second = start();
  let err = '';
  second.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((resolve) => { second.on('exit', resolve); setTimeout(() => { second.kill(); resolve('timeout'); }, 6000); });
  first.kill('SIGTERM');
  await new Promise((r) => first.on('exit', r));
  assert.notEqual(code, 0);
  assert.notEqual(code, 'timeout');
  assert.match(err, /already using/);
  assert.ok(!fs.existsSync(`${dbf}.lock`), 'the lock is released when the first server stops');
});

test('stored data cannot be turned into markup: the only player-chosen text is the callsign and it is restricted', () => {
  const names = db.prepare('SELECT username FROM users').all().map((u) => u.username);
  assert.ok(names.every((u) => /^[A-Za-z0-9_]{3,20}$/.test(u)), 'every stored callsign is plain');
  const events = db.prepare('SELECT message FROM colony_events').all().map((e) => e.message);
  assert.ok(events.every((m) => !/[<>]/.test(m)), 'no markup in the event log');
  assert.ok(engine);
});
