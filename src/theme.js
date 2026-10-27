'use strict';
// The theme layer: everything a player reads that is *wording* rather than *rules* lives in content/<theme>/.
//   (the folder named by THEME; default "recontinuation". "basic" is the neutral original wording.)
//   theme.json  names and descriptions for resources, buildings, districts, hazards, factions, recipes and directives,
//               plus the UI labels. Partial files are fine: anything missing keeps the name in game_config.json.
//   story.json  characters, scenes, beats and mail (see src/story.js).
//   assets/     portraits and backgrounds, served at /theme-assets/.
// Ids (polymer_plant, pits, rations...) never change; only what is shown. Pick a theme with THEME=<folder>.
const fs = require('fs');
const path = require('path');
const { DIRECTIVE_IDS } = require('./objectives');

const ROOT = path.join(__dirname, '..', 'content');
const DEFAULT_THEME = 'recontinuation';
const THEME_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function themeId() {
  const id = process.env.THEME || DEFAULT_THEME;
  if (!THEME_ID.test(id)) throw new Error(`THEME "${id}" is not a valid folder name.`);
  return id;
}
const dir = (id = themeId()) => path.join(ROOT, id);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error(`${path.relative(process.cwd(), file)}: ${e.message}`);
  }
}

// Which config table holds each themable section, and which text fields may be replaced.
const SECTIONS = {
  resources: [(c) => c.resources, ['name']],
  buildings: [(c) => c.buildings, ['name', 'desc']],
  districts: [(c) => c.districtTypes, ['name', 'desc']],
  hazards: [(c) => c.hazards.types, ['name', 'desc']],
  factions: [(c) => c.missions.factions, ['name', 'desc']],
  recipes: [(c) => c.recipes, ['name']],
};

// Problems found while applying a theme (unknown ids, non-string text). Returned, never thrown, so one typo does not
// stop the game; `npm run check-content` and the test suite turn them into failures.
function apply(config, theme) {
  const problems = [];
  for (const [section, [table, fields]] of Object.entries(SECTIONS)) {
    for (const [id, text] of Object.entries(theme[section] || {})) {
      const target = Object.prototype.hasOwnProperty.call(table(config), id) ? table(config)[id] : null;
      if (!target) { problems.push(`theme.${section}.${id}: no such id in game_config.json`); continue; }
      for (const [field, value] of Object.entries(text || {})) {
        if (!fields.includes(field)) { problems.push(`theme.${section}.${id}.${field}: not a themable field (${fields.join(', ')})`); continue; }
        if (typeof value !== 'string' || !value.trim()) { problems.push(`theme.${section}.${id}.${field}: must be non-empty text`); continue; }
        target[field] = value;
      }
    }
  }
  if (theme.ui && theme.ui.terms !== undefined) {
    const t = theme.ui.terms;
    if (!Array.isArray(t) || !t.every((r) => Array.isArray(r) && r.length === 2 && r.every((x) => typeof x === 'string' && x.length))) problems.push('theme.ui.terms: must be a list of [from, to] text pairs');
  }
  // Faction ranks are fiction only: [{ min, name }] in ascending order, the first at 0. They never change a rule.
  for (const [id, ranks] of Object.entries(theme.ranks || {})) {
    if (!Object.prototype.hasOwnProperty.call(config.missions.factions, id)) { problems.push(`theme.ranks.${id}: no such faction`); continue; }
    const ok = Array.isArray(ranks) && ranks.length && ranks[0].min === 0 && ranks.every((r, i) => r && typeof r.name === 'string' && r.name.trim() && Number.isFinite(r.min) && (i === 0 || r.min > ranks[i - 1].min));
    if (ok) config.missions.factions[id].ranks = ranks; else problems.push(`theme.ranks.${id}: needs a list of { min, name } starting at min 0 and rising`);
  }
  if (Array.isArray(theme.missionTitles) && theme.missionTitles.length) {
    if (theme.missionTitles.every((t) => typeof t === 'string' && t.trim())) config.missions.titles = theme.missionTitles;
    else problems.push('theme.missionTitles: must be a list of non-empty text');
  }
  for (const [id, text] of Object.entries(theme.directives || {})) {
    if (!DIRECTIVE_IDS.includes(id)) { problems.push(`theme.directives.${id}: no such directive`); continue; }
    if (!text || typeof text.title !== 'string' || typeof text.hint !== 'string') problems.push(`theme.directives.${id}: needs title and hint text`);
  }
  return problems;
}

// Load the active theme and apply it to the config in place. Called once, right after game_config.json is read.
function load(config) {
  const id = themeId();
  const theme = readJson(path.join(dir(id), 'theme.json'), {});
  const problems = apply(config, theme);
  for (const p of problems) console.warn(`[theme ${id}] ${p}`);
  const ui = { brand: 'FAILTECH', subtitle: '', title: 'FAILTECH', tabs: {}, labels: {}, loginNote: '', won: null, failed: null, ...(theme.ui || {}) };
  config.theme = { id, meta: theme.meta || {}, ui, directives: theme.directives || {}, problems };
  return config.theme;
}

// Folder names under content/ that look like themes.
const listThemes = () => fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && THEME_ID.test(e.name)).map((e) => e.name);

module.exports = { DEFAULT_THEME, listThemes, load, apply, dir, themeId, readJson, SECTIONS, ROOT };
