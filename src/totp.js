'use strict';
// Time-based one-time passwords (RFC 6238: HMAC-SHA1, 6 digits, 30-second steps), for admin sign-in. Works with any
// authenticator app; the secret is shown as base32 and as an otpauth:// URI to paste or type in.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  const clean = String(s).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Bad base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const newSecret = () => base32(crypto.randomBytes(20));

function code(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}

// One step either side is accepted (clock drift). Returns the step that matched, or null; the caller refuses a step that was
// already used, so a code cannot be replayed.
function check(secret, input, now = Date.now()) {
  if (typeof input !== 'string' || !/^\d{6}$/.test(input.trim())) return null;
  const step = Math.floor(now / 30000);
  for (const s of [step, step - 1, step + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(code(secret, s)), Buffer.from(input.trim()))) return s;
  }
  return null;
}

const uri = (secret, account, issuer) => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

module.exports = { newSecret, code, check, uri, base32, unbase32 };
