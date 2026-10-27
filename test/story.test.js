'use strict';
// The theme layer and the story: content validation, delivery order, secrecy of undelivered text, and safety.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-story-'));
process.env.DB_PATH = path.join(dir, 'story.db');
process.env.SESSION_SECRET = 'x';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.BCRYPT_ROUNDS = '4';
process.env.API_RATE_LIMIT = '100000';
process.env.HAZARDS = 'off';

const app = require('../server');
const store = require('../src/db');
const story = require('../src/story');
const theme = require('../src/theme');
const objectives = require('../src/objectives');
const { db, config } = store;

let server, base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b || {}) };
}
let n = 0;
async function player() {
  const c = client();
  const r = await c.post('/api/register', { username: `story${++n}`, password: 'hunter2hunter2' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}

// ---- theme ---------------------------------------------------------------------
test('the shipped theme and story are valid and cover every id', () => {
  assert.deepEqual(config.theme.problems, []);
  assert.deepEqual(story.problems, []);
  const t = theme.readJson(path.join(theme.dir(), 'theme.json'));
  for (const [section, [table]] of Object.entries(theme.SECTIONS)) {
    for (const id of Object.keys(table(config))) assert.ok(t[section] && t[section][id], `theme.${section}.${id} is missing`);
  }
  const ids = objectives.evaluate(config, fakeView(), []).list.map((d) => d.id);
  for (const id of ids) assert.ok(t.directives[id], `theme.directives.${id} is missing`);
});

test('a theme replaces wording only, reports mistakes, and keeps defaults for anything it leaves out', () => {
  const cfg = JSON.parse(JSON.stringify(config));
  const before = cfg.buildings.foundry.desc;
  const problems = theme.apply(cfg, {
    resources: { scrap: { name: 'Salvage' }, nonsense: { name: 'x' } },
    buildings: { foundry: { name: 'Forge', cost: 5, desc: '' } },
    missionTitles: ['One'],
    directives: { power: { title: 'only a title' } },
  });
  assert.equal(cfg.resources.scrap.name, 'Salvage');
  assert.equal(cfg.buildings.foundry.name, 'Forge');
  assert.equal(cfg.buildings.foundry.desc, before, 'an empty replacement is refused');
  assert.deepEqual(cfg.buildings.foundry.cost, config.buildings.foundry.cost, 'rules are never themable');
  assert.deepEqual(cfg.missions.titles, ['One']);
  assert.equal(problems.length, 4);
  assert.ok(problems.some((p) => /nonsense/.test(p)) && problems.some((p) => /not a themable field/.test(p)) && problems.some((p) => /needs title and hint/.test(p)));
});

test('THEME must be a plain folder name', () => {
  const was = process.env.THEME;
  try {
    for (const bad of ['../x', 'a/b', '.hidden', 'A B', '']) {
      process.env.THEME = bad;
      if (bad === '') assert.equal(theme.themeId(), 'default');
      else assert.throws(() => theme.themeId(), /not a valid folder/);
    }
  } finally { if (was === undefined) delete process.env.THEME; else process.env.THEME = was; }
});

// ---- validation ------------------------------------------------------------------
const good = () => ({
  characters: { a: { name: 'A' } },
  scenes: { s: { start: 'x', nodes: { x: { who: 'a', text: ['hi'], next: 'y' }, y: { who: null, text: ['bye'] } } } },
  beats: [{ id: 'b1', phase: 'campaign', trigger: { type: 'start' }, delivery: 'dialogue', scene: 's' }],
});
test('story validation catches broken content', () => {
  assert.deepEqual(story.validate(good()), []);
  const edit = (f) => { const s = good(); f(s); return story.validate(s).join('\n'); };
  assert.match(edit((s) => { s.scenes.s.nodes.x.who = 'ghost'; }), /unknown character "ghost"/);
  assert.match(edit((s) => { s.scenes.s.nodes.x.next = 'nowhere'; }), /not a node/);
  assert.match(edit((s) => { s.scenes.s.nodes.z = { text: ['orphan'] }; }), /never be reached/);
  assert.match(edit((s) => { s.scenes.s.nodes.x.text = []; }), /list of passages/);
  assert.match(edit((s) => { s.scenes.s.nodes.x.choices = [{ label: 'go', next: 'nope' }]; }), /unknown node "nope"|not both/);
  assert.match(edit((s) => { s.beats[0].trigger = { type: 'telepathy' }; }), /unknown trigger type/);
  assert.match(edit((s) => { s.beats[0].trigger = { type: 'directive', id: 'nope' }; }), /unknown directive/);
  assert.match(edit((s) => { s.beats[0].scene = 'none'; }), /unknown scene/);
  assert.match(edit((s) => { s.beats.push({ ...s.beats[0] }); }), /duplicate id/);
  assert.match(edit((s) => { s.characters.a.portrait = '../../etc/passwd'; }), /plain file name/);
  assert.match(edit((s) => { s.beats[0] = { id: 'm', phase: 'open', trigger: { type: 'start' }, delivery: 'mail', mail: { from: 'a', subject: 's', body: [] } }; }), /subject and a body/);
  assert.match(edit((s) => { s.beats[0].trigger = { type: 'after', beat: 'gone' }; }), /unknown beat/);
});

// ---- delivery --------------------------------------------------------------------
function fakeView(over = {}) {
  const res = new Proxy({}, { get: () => ({ amount: 0, net: 0, produced: 0, ticksLeft: null, cap: 100 }) });
  return {
    colony: { hubLevel: 1, hazardsSurvived: 0, population: 30, won: false, morale: 80, starving: [] },
    resources: res, buildings: [], orders: [], districts: [], views: {}, routes: [], energy: { satisfaction: 1 },
    contracts: { export: {}, import: {} }, convoy: { ticksLeft: 5 }, missions: { standing: {}, filled: 0 }, ...over,
  };
}
let uid = 1000;
function bareColony() {
  const id = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(`bare${++uid}`, 'x').lastInsertRowid);
  return store.ensureColony(id);
}
const delivered = (cid) => db.prepare('SELECT beat_id FROM story_beats WHERE colony_id = ? ORDER BY rowid').all(cid).map((r) => r.beat_id);
// What a player does between ticks: answer every call and read every mail.
const readAll = (cid) => db.prepare('UPDATE story_beats SET seen = 1 WHERE colony_id = ?').run(cid);

test('campaign beats are delivered strictly in order, one at a time; open beats are independent; nothing fires twice', () => {
  const cid = bareColony();
  story.evaluate(cid, fakeView(), [], false, 1);
  assert.deepEqual(delivered(cid), ['c01_prologue']);
  readAll(cid);
  // a later directive is done, but the one before it (power) is not: its beat waits
  story.evaluate(cid, fakeView(), ['steady'], false, 2);
  assert.deepEqual(delivered(cid), ['c01_prologue']);
  // three beats are now due (power, steady, market): they arrive one at a time, each only after the last was dealt with
  const due = ['power', 'steady', 'market'];
  story.evaluate(cid, fakeView(), due, false, 3);
  assert.deepEqual(delivered(cid), ['c01_prologue', 'c02_power']);
  story.evaluate(cid, fakeView(), due, false, 4);
  assert.deepEqual(delivered(cid), ['c01_prologue', 'c02_power'], 'the unread mail holds the next one back while a backlog is waiting');
  readAll(cid);
  story.evaluate(cid, fakeView(), due, false, 5);
  assert.deepEqual(delivered(cid), ['c01_prologue', 'c02_power', 'c03_steady']);
  readAll(cid);
  story.evaluate(cid, fakeView(), due, false, 6);
  assert.deepEqual(delivered(cid), ['c01_prologue', 'c02_power', 'c03_steady', 'c04_market']);
  readAll(cid);
  // an open beat does not wait for the campaign
  const v = fakeView({ missions: { standing: { cinder: 12 }, filled: 1 } });
  story.evaluate(cid, v, due, false, 7);
  assert.ok(delivered(cid).includes('o01_cinder'));
  readAll(cid);
  story.evaluate(cid, v, due, false, 8);
  assert.equal(delivered(cid).filter((b) => b === 'o01_cinder').length, 1);
  assert.equal(delivered(cid).length, 5);
});

test('a call is never delivered while another call is unanswered, but a lone mail is not held up by unread mail', () => {
  const cid = bareColony();
  story.evaluate(cid, fakeView(), [], false, 1); // c01 is a dialogue: unanswered
  story.evaluate(cid, fakeView(), ['power', 'steady'], false, 2);
  assert.deepEqual(delivered(cid), ['c01_prologue'], 'nothing new while the call rings');
  readAll(cid);
  story.evaluate(cid, fakeView(), ['power'], false, 3);
  assert.deepEqual(delivered(cid), ['c01_prologue', 'c02_power']);
  // a single due beat (a call, c03) arrives even though a mail (c02) is unread: only a backlog waits for mail
  story.evaluate(cid, fakeView(), ['power', 'steady'], false, 4);
  assert.deepEqual(delivered(cid), ['c01_prologue', 'c02_power', 'c03_steady']);
});

test('trigger types read the colony state', () => {
  const x = (view, extra = {}) => ({ view: fakeView(view), done: new Set(), campaignDone: false, delivered: new Map(), tick: 100, ...extra });
  assert.equal(story.fires({ type: 'hubLevel', min: 3 }, x({ colony: { hubLevel: 3 } })), true);
  assert.equal(story.fires({ type: 'hubLevel', min: 3 }, x({ colony: { hubLevel: 2 } })), false);
  assert.equal(story.fires({ type: 'district', district: 'pits' }, x({ districts: [{ type: 'pits' }] })), true);
  assert.equal(story.fires({ type: 'district', district: 'pits' }, x()), false);
  assert.equal(story.fires({ type: 'campaignDone' }, x({}, { campaignDone: true })), true);
  assert.equal(story.fires({ type: 'after', beat: 'a', delayTicks: 5 }, x({}, { delivered: new Map([['a', { tick: 96 }]]) })), false);
  assert.equal(story.fires({ type: 'after', beat: 'a', delayTicks: 5 }, x({}, { delivered: new Map([['a', { tick: 95 }]]) })), true);
  assert.equal(story.fires({ type: 'bogus' }, x()), false);
});

test('a new colony is greeted, text is only sent once delivered, and seen state is private and validated', async () => {
  const a = await player();
  const s1 = (await a.get('/api/state')).body;
  assert.ok(s1.story.pending.includes('c01_prologue'));
  assert.equal(s1.story.items.find((i) => i.id === 'c01_prologue').seen, false);
  const text = (await a.get('/api/story')).body;
  assert.ok(text.beats.c01_prologue && text.scenes.prologue.nodes.wake.text.length);
  assert.equal(text.beats.c08_answered, undefined, 'later chapters are not sent ahead of time');
  assert.ok(!JSON.stringify(text).includes('harbour on the far side'));
  assert.ok(!JSON.stringify(s1).includes('Core systems are up'), 'the live view carries metadata, not script text');

  assert.equal((await a.post('/api/story-seen', { beat: 'nonsense' })).status, 400);
  assert.equal((await a.post('/api/story-seen', { beat: '__proto__' })).status, 400);
  assert.equal((await a.post('/api/story-seen', { beat: ['c01_prologue'] })).status, 400);
  assert.equal((await a.post('/api/story-seen', { beat: 'c08_answered' })).status, 400, 'cannot mark what was never delivered');
  assert.equal((await a.post('/api/story-seen', { beat: 'c01_prologue' })).status, 200);
  const s2 = (await a.get('/api/state')).body;
  assert.equal(s2.story.pending.length, 0);
  assert.equal(s2.story.items.find((i) => i.id === 'c01_prologue').seen, true);

  const b = await player();
  assert.ok((await b.get('/api/state')).body.story.pending.includes('c01_prologue'), 'another player is unaffected');
  assert.equal((await a.post('/api/story-seen', { all: true })).status, 200);
});

test('the story and theme endpoints: story needs a login, theme is public and carries no script', async () => {
  const anon = client();
  assert.equal((await anon.get('/api/story')).status, 401);
  const t = await anon.get('/api/theme');
  assert.equal(t.status, 200);
  assert.equal(t.body.ui.brand, 'FAILTECH');
  assert.ok(!JSON.stringify(t.body).includes('Hub Steward'));
});

test('theme assets: only files inside assets/ are served', async () => {
  fs.writeFileSync(path.join(theme.dir(), 'assets', '_probe.txt'), 'ok');
  try {
    const c = client();
    assert.equal((await c.get('/theme-assets/_probe.txt')).status, 200);
    for (const bad of ['/theme-assets/../story.json', '/theme-assets/..%2Fstory.json', '/theme-assets/%2e%2e/theme.json', '/theme-assets/missing.png']) {
      const r = await c.get(bad);
      assert.notEqual(r.status, 200, bad);
      assert.ok(!String(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)).includes('"characters"'), bad);
    }
  } finally { fs.rmSync(path.join(theme.dir(), 'assets', '_probe.txt'), { force: true }); }
});

test('restarting a colony starts its story over', async () => {
  const a = await player();
  await a.post('/api/story-seen', { beat: 'c01_prologue' });
  const r = await a.post('/api/reset');
  assert.equal(r.status, 200);
  const s = (await a.get('/api/state')).body;
  assert.ok(s.story.pending.includes('c01_prologue'));
});

// ---- every theme shipped in content/ ----------------------------------------------
test('every theme in content/ applies cleanly and has a valid story', () => {
  const themes = theme.listThemes();
  assert.ok(themes.includes('default') && themes.includes('recontinuation'));
  for (const id of themes) {
    const cfg = JSON.parse(JSON.stringify(config));
    const t = theme.readJson(path.join(theme.ROOT, id, 'theme.json'));
    assert.deepEqual(theme.apply(cfg, t), [], `${id}: theme.json`);
    const s = theme.readJson(path.join(theme.ROOT, id, 'story.json'), { characters: {}, scenes: {}, beats: [] });
    assert.deepEqual(story.validate(s, cfg), [], `${id}: story.json`);
  }
});

test('directive ids used by content match the real Brief', () => {
  const ids = objectives.evaluate(config, fakeView(), []).list.map((d) => d.id);
  assert.deepEqual(objectives.DIRECTIVE_IDS, ids);
});

test('new validation rules: prompt needs choices, trigger progress needs a number, ranks need to rise', () => {
  const edit = (f) => { const s = good(); f(s); return story.validate(s).join('\n'); };
  assert.match(edit((s) => { s.scenes.s.nodes.x.prompt = 'hmm'; }), /prompt only makes sense/);
  assert.match(edit((s) => { s.beats[0].trigger = { type: 'progress' }; }), /numeric min/);
  const cfg = JSON.parse(JSON.stringify(config));
  assert.equal(theme.apply(cfg, { ranks: { cinder: [{ min: 0, name: 'A' }, { min: 10, name: 'B' }] } }).length, 0);
  assert.deepEqual(cfg.missions.factions.cinder.ranks.map((r) => r.name), ['A', 'B']);
  assert.equal(theme.apply(cfg, { ranks: { cinder: [{ min: 5, name: 'A' }] } }).length, 1);
  assert.equal(theme.apply(cfg, { ranks: { cinder: [{ min: 0, name: 'A' }, { min: 0, name: 'B' }] } }).length, 1);
  assert.equal(theme.apply(cfg, { ranks: { nobody: [{ min: 0, name: 'A' }] } }).length, 1);
});

// ---- the Recontinuation script, run as a whole -----------------------------------
test('Recontinuation: 12 dialogues, 22 campaign mails and 12 open beats, delivered in the written order', () => {
  const s = theme.readJson(path.join(theme.ROOT, 'recontinuation', 'story.json'));
  const campaign = s.beats.filter((b) => b.phase === 'campaign');
  const open = s.beats.filter((b) => b.phase === 'open');
  assert.equal(campaign.filter((b) => b.delivery === 'dialogue').length, 12);
  assert.equal(campaign.filter((b) => b.delivery === 'mail').length, 22);
  assert.equal(open.filter((b) => b.delivery === 'dialogue').length, 6);
  assert.equal(open.filter((b) => b.delivery === 'mail').length, 6);
  // Run the real evaluator over this script with every condition satisfied and the clock moving.
  const all = objectives.DIRECTIVE_IDS;
  const view = fakeView({
    colony: { hubLevel: 5, hazardsSurvived: 3, population: 200, won: true, progress: 25, morale: 90, starving: [] },
    districts: [{ type: 'pits' }, { type: 'greenbelt' }], missions: { standing: { cinder: 40, verdant: 40, meridian: 40 }, filled: 12 },
  });
  const delivered = new Map();
  for (const b of s.beats) if (b.phase === 'campaign') delivered.set(b.id, null);
  // evaluate against a fresh sandbox colony using the real tables
  const cid = bareColony();
  const real = require('../src/story');
  const saved = real.story;
  Object.assign(saved, s); // the loaded story is replaced for this colony only, then restored below
  const keep = { characters: saved.characters, scenes: saved.scenes, beats: saved.beats };
  try {
    real.beatOf.clear(); s.beats.forEach((b) => real.beatOf.set(b.id, b));
    for (let tick = 1; tick <= 200; tick++) { real.evaluate(cid, view, all, true, tick); readAll(cid); }
    const got = db.prepare('SELECT beat_id FROM story_beats WHERE colony_id = ? ORDER BY rowid').all(cid).map((r) => r.beat_id);
    assert.equal(got.length, s.beats.length, 'every beat is reachable');
    const campaignOrder = got.filter((id) => campaign.some((b) => b.id === id));
    assert.deepEqual(campaignOrder, campaign.map((b) => b.id), 'campaign beats arrive in script order');
    const before = (a, b) => got.indexOf(a) < got.indexOf(b);
    assert.ok(before('d09_three_theories', 'd10_form_7b') && before('m21_maintenance_window', 'm22_open_operations'));
  } finally {
    Object.assign(saved, keep); real.beatOf.clear(); keep.beats.forEach((b) => real.beatOf.set(b.id, b));
  }
});

test('Recontinuation text follows the house style: no em or en dashes, no banned phrases', () => {
  for (const f of ['theme.json', 'story.json']) {
    const txt = fs.readFileSync(path.join(theme.ROOT, 'recontinuation', f), 'utf8');
    assert.ok(!/[–—]/.test(txt), `${f} has a dash`);
    assert.ok(!/golden cage/i.test(txt), `${f} has "golden cage"`);
  }
});
