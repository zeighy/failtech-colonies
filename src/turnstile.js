'use strict';
// Cloudflare Turnstile on sign-in, sign-up and passcode reset requests. On when both TURNSTILE_SITE_KEY and
// TURNSTILE_SECRET_KEY are set. The page renders the widget with the site key; the server checks the token it produces with
// Cloudflare's siteverify (one use per token). If Cloudflare cannot be reached the request is refused (fail closed).
const URL_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const ORIGIN = 'https://challenges.cloudflare.com';

const siteKey = () => process.env.TURNSTILE_SITE_KEY || '';
const secret = () => process.env.TURNSTILE_SECRET_KEY || '';
const enabled = () => !!(siteKey() && secret());

async function siteverify(token, ip) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const form = new URLSearchParams({ secret: secret(), response: token });
    if (ip) form.set('remoteip', ip);
    const r = await fetch(URL_VERIFY, { method: 'POST', body: form, signal: ctl.signal });
    const j = await r.json();
    return { ok: !!j.success, codes: j['error-codes'] || [] };
  } catch (e) {
    return { ok: false, codes: ['unreachable'] };
  } finally { clearTimeout(timer); }
}

let verifier = siteverify; // tests swap this out (no network)
const setVerifier = (fn) => { verifier = fn || siteverify; };

// { ok } or { ok: false, error } for the client.
async function check(token, ip) {
  if (!enabled()) return { ok: true };
  if (typeof token !== 'string' || !token || token.length > 2048) return { ok: false, error: 'Complete the challenge.' };
  const r = await verifier(token, ip);
  if (r.ok) return { ok: true };
  return { ok: false, error: r.codes.includes('unreachable') ? 'The challenge could not be checked. Try again.' : 'The challenge failed. Try again.' };
}

module.exports = { enabled, siteKey, check, setVerifier, ORIGIN };
