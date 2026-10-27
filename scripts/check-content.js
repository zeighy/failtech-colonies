'use strict';
// Validates the active theme (THEME=<folder>, default "recontinuation"): theme.json against game_config.json and story.json
// against itself. Exits 1 and prints every problem, so a content edit can be checked without starting the game.
process.env.DB_PATH = process.env.DB_PATH || require('path').join(require('os').tmpdir(), `failtech-check-${process.pid}.db`);
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'check';
const fs = require('fs');
const store = require('../src/db');
const story = require('../src/story');
const problems = [...store.config.theme.problems.map((p) => `theme: ${p}`), ...story.problems.map((p) => `story: ${p}`)];
store.db.close();
for (const f of [process.env.DB_PATH, `${process.env.DB_PATH}-wal`, `${process.env.DB_PATH}-shm`]) { try { fs.rmSync(f); } catch (e) { /* none */ } }
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
if (story.notes.length) {
  const files = {};
  for (const n of story.notes) { const f = [...n.matchAll(/"([^"]+)"/g)].pop()[1]; files[f] = (files[f] || 0) + 1; }
  console.log(`note: ${Object.keys(files).length} art files are named in story.json but not in assets/ yet (the game shows silhouettes and plain backdrops): ${Object.keys(files).sort().join(', ')}`);
}
console.log(`OK: theme "${store.config.theme.id}", ${story.story.beats.length} beats, ${Object.keys(story.story.scenes).length} scenes, ${Object.keys(story.story.characters).length} characters.`);
