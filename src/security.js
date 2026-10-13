'use strict';
// HTTP hardening: response headers, same-origin enforcement, JSON-only writes and in-memory rate limiting.
// No dependencies. Limiters are per process, which is right for the single-instance design.

const SELF = "'self'";
const CSP = [
  `default-src ${SELF}`, `script-src ${SELF}`, `style-src ${SELF} 'unsafe-inline'`, `img-src ${SELF} data:`, `connect-src ${SELF}`,
  "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

function headers(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': CSP,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
}

// A browser attaches Origin (and Sec-Fetch-Site) to cross-site writes. Refuse any write that did not come from this site.
// Requests with no Origin at all (curl, tests, scripts) are allowed: they cannot be forged by a victim's browser.
function sameOrigin(allowed = []) {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const site = req.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ ok: false, error: 'Cross-site request refused.' });
    const origin = req.get('origin');
    if (origin) {
      let host;
      try { host = new URL(origin).host; } catch (e) { return res.status(403).json({ ok: false, error: 'Bad origin.' }); }
      if (host !== req.get('host') && !allowed.includes(origin)) return res.status(403).json({ ok: false, error: 'Cross-site request refused.' });
    }
    next();
  };
}

// Writes must be JSON (which a cross-site HTML form cannot send without a CORS preflight).
function jsonOnly(req, res, next) {
  if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ ok: false, error: 'Send JSON.' });
  next();
}

// Sliding-window limiter. key(req) picks who is counted; over the limit gets a 429 with Retry-After.
function limiter({ windowMs, max, key, message = 'Too many requests. Slow down.' }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  }, Math.max(1000, windowMs)).unref();
  const mw = (req, res, next) => {
    const now = Date.now();
    const k = key(req);
    const rec = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (rec.length >= max) {
      res.set('Retry-After', String(Math.ceil((windowMs - (now - rec[0])) / 1000)));
      return res.status(429).json({ ok: false, error: message });
    }
    rec.push(now);
    hits.set(k, rec);
    next();
  };
  mw.reset = () => hits.clear();
  mw.timer = timer;
  return mw;
}

// Failed-login throttle per callsign (so a distributed guess at one account is slowed too). Counts failures only.
function failureTracker({ windowMs, max }) {
  const fails = new Map();
  return {
    blocked(k) { const now = Date.now(); const r = (fails.get(k) || []).filter((t) => now - t < windowMs); fails.set(k, r); return r.length >= max; },
    fail(k) { const r = fails.get(k) || []; r.push(Date.now()); fails.set(k, r); },
    clear(k) { fails.delete(k); },
    sweep() { const now = Date.now(); for (const [k, v] of fails) if (!v.some((t) => now - t < windowMs)) fails.delete(k); },
  };
}

module.exports = { headers, sameOrigin, jsonOnly, limiter, failureTracker, CSP };
