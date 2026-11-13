'use strict';
// The bot runner's side of the bot API (src/botApi.js): plain HTTP with the shared key as a bearer token.
class BotClient {
  constructor(base, key, { timeoutMs = 20000 } = {}) {
    this.base = String(base).replace(/\/+$/, '');
    this.key = key;
    this.timeoutMs = timeoutMs;
  }

  // A refused game action or claim (400 or 409 with { ok: false }) is an answer, not an error; anything else that is not a success throws.
  async req(method, path, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(`${this.base}/api/bot${path}`, {
        method,
        headers: { authorization: `Bearer ${this.key}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
    } finally { clearTimeout(timer); }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (res.ok || ((res.status === 400 || res.status === 409) && data && data.ok === false)) return data;
    const err = new Error(`${method} ${path}: ${res.status} ${(data && data.error) || res.statusText}`);
    err.status = res.status;
    throw err;
  }

  info() { return this.req('GET', '/info'); }
  async config() { return this.req('GET', '/config'); }
  // skip: "colonyId:parkedAt" keys to leave out of the listing (the runner's blacklist); since: only colonies parked since (ms)
  async parked(skip = [], since = 0) {
    const q = since > 0 ? `?since=${Math.floor(since)}` : '';
    return (await this.req(skip.length ? 'POST' : 'GET', `/parked${q}`, skip.length ? { skip } : undefined)).parked;
  }
  async parkedView(colonyId) { return (await this.req('GET', `/parked/${colonyId}`)).state; }
  claim(colonyId, profile) { return this.req('POST', '/claim', { colonyId, profile }); }
  async colonies() { return (await this.req('GET', '/colonies')).colonies; }
  async state(userId) { return (await this.req('GET', `/colonies/${userId}/state`)).state; }
  act(userId, route, body = {}) { return this.req('POST', `/colonies/${userId}/act/${route}`, body); }
  release(userId) { return this.req('POST', `/colonies/${userId}/release`, {}); }

  // What the brain plays through: one bot's state and actions.
  forBot(userId) { return { state: () => this.state(userId), act: (route, body) => this.act(userId, route, body) }; }
}

module.exports = { BotClient };
