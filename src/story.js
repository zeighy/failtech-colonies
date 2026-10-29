'use strict';
// Story: scripted narrative layered over the game, delivered as dialogue scenes (a full-screen overlay) or mail (an
// inbox). It never changes the simulation: beats are *triggered by* what the colony has done and nothing flows back,
// not even the choices in a branching scene. All text lives in content/<theme>/story.json:
//
//   characters  { id: { name, title?, color?, portrait? (large, for scenes), avatar? (square, for the call card and mail window;
//               falls back to the portrait), side? ('left'|'right') } }
//   scenes      { id: { title?, background? (file in assets/), start, nodes: { nodeId: node } } }
//     node      { who: characterId | null (narration), text: [passage, ...], next?: nodeId, choices?: [{ label, next }] }
//               A node with neither next nor choices ends the scene. Choices only pick the next node.
//   beats       [ { id, phase: 'campaign' | 'open', trigger, delivery: 'dialogue' | 'mail', scene?, mail? } ]
//     campaign  beats are delivered strictly in file order (a beat waits for the one before it).
//     open      beats are independent and fire whenever their trigger does.
//     mail      { from: characterId, subject, body: [paragraph, ...], scene? (adds an "open transmission" button) }
//
// Triggers (all evaluated against the colony's own state, so a beat can never be missed, only late):
//   { type: 'start' }                        the colony exists
//   { type: 'directive', id }                a Brief directive is done
//   { type: 'hubLevel', min }                Core level reached
//   { type: 'district', district }           a district of that type exists
//   { type: 'standing', faction, min }       faction standing reached
//   { type: 'missions', min }                missions filled
//   { type: 'hazards', min }                 hazards survived
//   { type: 'population', min }              people in the colony
//   { type: 'progress', min }                the Beacon has been transmitting for min ticks
//   { type: 'won' }                          the Beacon message got through
//   { type: 'campaignDone' }                 every Brief directive is done (the open-ended phase)
//   { type: 'after', beat, delayTicks? }     some ticks after another beat was delivered
//   { type: 'orbital', flag }                an orbit milestone (unlocked, staging, catapult, command, cycleDone, launched,
//                                            ring2, ring3, deployed, rareReturned, shipSaved, shipLost, contributed, projectCompleted, dataFragment)
const store = require('./db');
const theme = require('./theme');
const fs = require('fs');
const path = require('path');
const { DIRECTIVE_IDS } = require('./objectives');
const { own, isPlain } = require('./validate');
const { db, config } = store;

const FILE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const COLOR = /^#[0-9a-f]{3,8}$/i;
// The fixed set of moods a portrait can come in. A mood image is <portrait name>_<mood>.png beside the portrait, so
// mags.png has mags_happy.png, mags_sad.png and so on. Missing ones fall back to the default (neutral) portrait.
const MOODS = ['happy', 'sad', 'angry', 'afraid', 'surprised', 'serious', 'thoughtful'];
const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;

// Orbit milestones a beat can wait for (see src/orbital.js setFlag, and the launch site).
const ORBITAL_FLAGS = ['unlocked', 'staging', 'catapult', 'command', 'cycleDone', 'launched', 'ring2', 'ring3', 'deployed', 'rareReturned', 'shipSaved', 'shipLost', 'contributed', 'projectCompleted', 'dataFragment'];
const TRIGGERS = {
  start: () => [],
  directive: (t) => (DIRECTIVE_IDS.includes(t.id) ? [] : [`unknown directive "${t.id}"`]),
  progress: (t) => (Number.isFinite(t.min) ? [] : ['needs a numeric min']),
  hubLevel: (t) => (Number.isInteger(t.min) && t.min >= 1 ? [] : ['needs an integer min >= 1']),
  district: (t) => (own(config.districtTypes, t.district) ? [] : [`unknown district "${t.district}"`]),
  standing: (t) => [...(own(config.missions.factions, t.faction) ? [] : [`unknown faction "${t.faction}"`]), ...(Number.isFinite(t.min) ? [] : ['needs a numeric min'])],
  missions: (t) => (Number.isFinite(t.min) ? [] : ['needs a numeric min']),
  hazards: (t) => (Number.isFinite(t.min) ? [] : ['needs a numeric min']),
  population: (t) => (Number.isFinite(t.min) ? [] : ['needs a numeric min']),
  won: () => [],
  campaignDone: () => [],
  after: (t) => (nonEmpty(t.beat) ? [] : ['needs a beat id']),
  orbital: (t) => (ORBITAL_FLAGS.includes(t.flag) ? [] : [`unknown orbital flag "${t.flag}" (${ORBITAL_FLAGS.join(', ')})`]),
};

// Everything wrong with a story file, as readable lines. Empty means it is safe to run.
function validate(story, cfg = config) {
  const out = [];
  const bad = (where, msg) => out.push(`${where}: ${msg}`);
  if (!isPlain(story.characters) || !isPlain(story.scenes) || !Array.isArray(story.beats)) { bad('story.json', 'needs "characters" and "scenes" objects and a "beats" list'); return out; }
  for (const [id, ch] of Object.entries(story.characters)) {
    const w = `characters.${id}`;
    if (!nonEmpty(ch.name)) bad(w, 'needs a name');
    for (const f of ['portrait', 'avatar']) if (ch[f] !== undefined && !(typeof ch[f] === 'string' && FILE.test(ch[f]))) bad(w, `${f} must be a plain file name in assets/`);
    if (ch.color !== undefined && !COLOR.test(ch.color)) bad(w, 'color must look like #aabbcc');
    if (ch.side !== undefined && !['left', 'right'].includes(ch.side)) bad(w, 'side must be left or right');
  }
  const who = (w, id) => { if (id !== null && id !== undefined && !own(story.characters, id)) bad(w, `unknown character "${id}"`); };
  for (const [id, sc] of Object.entries(story.scenes)) {
    const w = `scenes.${id}`;
    if (!isPlain(sc.nodes) || !own(sc.nodes, sc.start)) { bad(w, '"start" must name one of its nodes'); continue; }
    if (sc.background !== undefined && !(typeof sc.background === 'string' && FILE.test(sc.background))) bad(w, 'background must be a plain file name in assets/');
    const reach = new Set();
    const walk = (n) => { if (reach.has(n) || !own(sc.nodes, n)) return; reach.add(n); const node = sc.nodes[n]; if (node.next) walk(node.next); (node.choices || []).forEach((c) => walk(c.next)); };
    walk(sc.start);
    for (const [nid, node] of Object.entries(sc.nodes)) {
      const nw = `${w}.${nid}`;
      who(nw, node.who);
      if (node.tag !== undefined && !nonEmpty(node.tag)) bad(nw, 'tag must be text');
      if (node.mood !== undefined && node.mood !== 'neutral' && !MOODS.includes(node.mood)) bad(nw, `mood must be neutral or one of ${MOODS.join(', ')}`);
      if (node.prompt !== undefined && !nonEmpty(node.prompt)) bad(nw, 'prompt must be text');
      if (node.prompt !== undefined && !node.choices) bad(nw, 'a prompt only makes sense with choices');
      if (!Array.isArray(node.text) || !node.text.length || !node.text.every(nonEmpty)) bad(nw, '"text" must be a list of passages');
      if (node.next && !own(sc.nodes, node.next)) bad(nw, `next "${node.next}" is not a node`);
      if (node.choices !== undefined) {
        if (!Array.isArray(node.choices) || !node.choices.length) bad(nw, '"choices" must be a non-empty list');
        else for (const ch of node.choices) { if (!nonEmpty(ch.label)) bad(nw, 'every choice needs a label'); if (!own(sc.nodes, ch.next)) bad(nw, `choice "${ch.label}" leads to unknown node "${ch.next}"`); }
        if (node.next) bad(nw, 'a node has either next or choices, not both');
      }
      if (!reach.has(nid)) bad(nw, 'can never be reached from the scene start');
    }
  }
  const seen = new Set();
  const ids = new Set(story.beats.map((b) => b && b.id));
  for (const b of story.beats) {
    const w = `beats.${b && b.id}`;
    if (!b || !nonEmpty(b.id) || !/^[a-z0-9_]+$/i.test(b.id)) { bad(w, 'needs an id of letters, digits and underscores'); continue; }
    if (seen.has(b.id)) bad(w, 'duplicate id');
    seen.add(b.id);
    if (!['campaign', 'open'].includes(b.phase)) bad(w, 'phase must be campaign or open');
    if (!b.trigger || !own(TRIGGERS, b.trigger.type)) bad(w, `unknown trigger type "${b.trigger && b.trigger.type}"`);
    else {
      for (const m of TRIGGERS[b.trigger.type](b.trigger)) bad(w, `trigger ${m}`);
      if (b.trigger.type === 'after' && !ids.has(b.trigger.beat)) bad(w, `trigger after unknown beat "${b.trigger.beat}"`);
    }
    if (b.delivery === 'dialogue') { if (!own(story.scenes, b.scene)) bad(w, `unknown scene "${b.scene}"`); } else if (b.delivery === 'mail') {
      const m = b.mail;
      if (!isPlain(m) || !nonEmpty(m.subject) || !Array.isArray(m.body) || !m.body.length || !m.body.every(nonEmpty)) bad(w, 'mail needs a subject and a body list');
      else { who(w, m.from); if (m.from === undefined || m.from === null) bad(w, 'mail needs a sender'); if (m.scene !== undefined && !own(story.scenes, m.scene)) bad(w, `unknown scene "${m.scene}"`); }
    } else bad(w, 'delivery must be dialogue or mail');
  }
  return out;
}

// Artwork named in story.json that is not in assets/ yet is dropped (the game shows a silhouette or a plain backdrop) and
// listed as a note, so the story can be written before the art exists.
function dropMissingArt(story) {
  const notes = [];
  const have = (f) => fs.existsSync(path.join(theme.dir(), 'assets', f));
  for (const [id, ch] of Object.entries(story.characters)) for (const f of ['portrait', 'avatar']) if (ch[f] && FILE.test(ch[f]) && !have(ch[f])) { notes.push(`characters.${id}: ${f} "${ch[f]}" is not in assets/ yet`); delete ch[f]; }
  for (const [id, sc] of Object.entries(story.scenes)) if (sc.background && FILE.test(sc.background) && !have(sc.background)) { notes.push(`scenes.${id}: background "${sc.background}" is not in assets/ yet`); delete sc.background; }
  // Which mood portraits exist, and which moods the script asks for that are not drawn yet.
  const used = {};
  for (const sc of Object.values(story.scenes)) for (const nd of Object.values(sc.nodes)) if (nd.who && nd.mood && nd.mood !== 'neutral') (used[nd.who] = used[nd.who] || new Set()).add(nd.mood);
  for (const [id, ch] of Object.entries(story.characters)) {
    ch.moodArt = {};
    if (!ch.portrait) continue;
    const ext = path.extname(ch.portrait), base = ch.portrait.slice(0, -ext.length);
    for (const m of MOODS) if (have(`${base}_${m}${ext}`)) ch.moodArt[m] = `${base}_${m}${ext}`;
    for (const m of used[id] || []) if (!ch.moodArt[m]) notes.push(`characters.${id}: mood "${m}" is used in a scene but "${base}_${m}${ext}" is not in assets/ yet`);
  }
  return notes;
}

function loadStory() {
  const story = theme.readJson(path.join(theme.dir(), 'story.json'), { characters: {}, scenes: {}, beats: [] });
  const problems = story.beats.length || Object.keys(story.scenes).length ? validate(story) : [];
  const notes = problems.length ? [] : dropMissingArt(story);
  for (const p of problems) console.warn(`[story ${theme.themeId()}] ${p}`);
  // A broken story is switched off rather than half-played.
  return problems.length ? { story: { characters: {}, scenes: {}, beats: [] }, problems, notes } : { story, problems, notes };
}
const { story, problems, notes } = loadStory();
const beatOf = new Map(story.beats.map((b) => [b.id, b]));

// ---- triggers --------------------------------------------------------------------
function fires(t, x) {
  switch (t.type) {
    case 'start': return true;
    case 'directive': return x.done.has(t.id);
    case 'hubLevel': return x.view.colony.hubLevel >= t.min;
    case 'district': return (x.view.districts || []).some((d) => d.type === t.district);
    case 'standing': return ((x.view.missions && x.view.missions.standing[t.faction]) || 0) >= t.min;
    case 'missions': return ((x.view.missions && x.view.missions.filled) || 0) >= t.min;
    case 'hazards': return x.view.colony.hazardsSurvived >= t.min;
    case 'population': return x.view.colony.population >= t.min;
    case 'progress': return (x.view.colony.progress || 0) >= t.min;
    case 'won': return !!x.view.colony.won;
    case 'campaignDone': return x.campaignDone;
    case 'orbital': {
      const o = x.view.orbital;
      if (!o) return false;
      if (t.flag === 'unlocked') return !!o.unlocked;
      if (o.site && o.site[t.flag] !== undefined) return !!o.site[t.flag];
      return !!(o.flags && o.flags[t.flag] !== undefined);
    }
    case 'after': { const d = x.delivered.get(t.beat); return !!d && x.tick - d.tick >= (t.delayTicks || 0); }
    default: return false;
  }
}

// Deliver the next beat whose moment has come, one at a time. Idempotent: a beat is stored once per colony and never
// fires twice. `done` is the set of earned directive ids, `campaignDone` whether the Brief is complete.
//
// Pacing: beats are worked out in script order, but at most one is delivered per call.
//  - A dialogue (a "call") is never delivered while another call is still unanswered.
//  - When several beats are due at once (an existing colony catching up, or one event unlocking two beats), they come
//    one by one: the next arrives only once everything delivered so far has been answered or read.
function evaluate(colonyId, view, done, campaignDone, tick) {
  if (!story.beats.length) return;
  const rows = db.prepare('SELECT beat_id, tick, seen FROM story_beats WHERE colony_id = ?').all(colonyId);
  const delivered = new Map(rows.map((r) => [r.beat_id, r]));
  const x = { view, done: new Set(done), campaignDone, delivered, tick };
  // Everything that is due now, in order. Beats are only pretend-delivered here so later beats can chain off them.
  const queue = [];
  for (let pass = 0; pass < story.beats.length; pass++) {
    let changed = false;
    let prevCampaignOk = true;
    for (const b of story.beats) {
      const have = delivered.has(b.id);
      if (!have && (b.phase !== 'campaign' || prevCampaignOk) && fires(b.trigger, x)) { delivered.set(b.id, { beat_id: b.id, tick }); queue.push(b); changed = true; }
      if (b.phase === 'campaign') prevCampaignOk = delivered.has(b.id);
    }
    if (!changed) break;
  }
  if (!queue.length) return;
  const unseen = rows.filter((r) => !r.seen && beatOf.has(r.beat_id));
  const callWaiting = unseen.some((r) => beatOf.get(r.beat_id).delivery === 'dialogue');
  const next = queue[0];
  if (next.delivery === 'dialogue' && callWaiting) return;
  if (queue.length > 1 && unseen.length) return;
  db.prepare('INSERT OR IGNORE INTO story_beats (colony_id, beat_id, tick) VALUES (?, ?, ?)').run(colonyId, next.id, tick);
}

// What the live view carries: light metadata only. The text is fetched from /api/story once it has been delivered, so
// the full script never travels to a player ahead of time.
function view(colonyId) {
  const rows = db.prepare('SELECT beat_id, tick, seen FROM story_beats WHERE colony_id = ? ORDER BY tick, rowid').all(colonyId);
  const items = rows.filter((r) => beatOf.has(r.beat_id)).map((r) => {
    const b = beatOf.get(r.beat_id);
    const scene = b.delivery === 'dialogue' ? story.scenes[b.scene] : null;
    return {
      id: b.id, kind: b.delivery, phase: b.phase, tick: r.tick, seen: !!r.seen,
      title: b.delivery === 'mail' ? b.mail.subject : (scene && scene.title) || b.id,
      from: b.delivery === 'mail' ? b.mail.from : null,
      hasScene: b.delivery === 'dialogue' || !!(b.mail && b.mail.scene),
    };
  });
  return {
    items,
    pending: items.filter((i) => i.kind === 'dialogue' && !i.seen).map((i) => i.id),
    unreadMail: items.filter((i) => i.kind === 'mail' && !i.seen).length,
    rev: items.length,
  };
}

// The text for everything this colony has been sent, plus the cast.
function content(colonyId) {
  const have = new Set(db.prepare('SELECT beat_id FROM story_beats WHERE colony_id = ?').all(colonyId).map((r) => r.beat_id));
  const beats = {};
  const scenes = {};
  for (const b of story.beats) {
    if (!have.has(b.id)) continue;
    const sceneId = b.delivery === 'dialogue' ? b.scene : b.mail.scene;
    beats[b.id] = b.delivery === 'mail' ? { kind: 'mail', mail: b.mail, scene: sceneId || null } : { kind: 'dialogue', scene: sceneId };
    if (sceneId) scenes[sceneId] = story.scenes[sceneId];
  }
  return { characters: story.characters, beats, scenes, theme: theme.themeId() };
}

// Mark one delivered beat (or every pending dialogue) as seen. Only a beat this colony has actually been sent counts.
function markSeen(colonyId, beatId, all) {
  const mark = db.prepare('UPDATE story_beats SET seen = 1 WHERE colony_id = ? AND beat_id = ?');
  if (!all) return mark.run(colonyId, beatId).changes;
  let n = 0;
  for (const r of db.prepare('SELECT beat_id FROM story_beats WHERE colony_id = ? AND seen = 0').all(colonyId)) {
    const b = beatOf.get(r.beat_id);
    if (b && b.delivery === 'dialogue') n += mark.run(colonyId, r.beat_id).changes;
  }
  return n;
}

module.exports = { MOODS, evaluate, view, content, markSeen, validate, fires, story, problems, notes, beatOf, TRIGGERS };
