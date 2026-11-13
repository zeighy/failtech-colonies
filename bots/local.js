'use strict';
// The bot brain played in-process, with no HTTP in between: the same view and the same actions the bot API serves
// (src/routes.js), for tests and for scripts/botplay.js. Requires the game's own modules, so it is only for use beside a
// database (the real runner never loads it).
const ACTION_ROUTES = require('../src/routes');

function localApi(userId) {
  const actions = require('../src/actions');
  const { viewFor } = require('../src/state');
  const map = new Map(ACTION_ROUTES);
  return {
    state: async () => viewFor(userId),
    act: async (route, body = {}) => {
      const name = map.get(route);
      if (!name || route === 'reset' || route === 'restart') return { ok: false, error: 'No such action.' };
      const r = actions[name](userId, body);
      return r.ok ? { ...r, state: viewFor(userId) } : r;
    },
  };
}

module.exports = { localApi };
