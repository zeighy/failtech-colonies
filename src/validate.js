'use strict';
// Input validation helpers. Everything a client sends is untrusted: types are checked strictly (a string or an
// array is not a number), numbers must be finite and in range, and every lookup of a client-supplied name in a
// config table is an *own-property* lookup, so "constructor" or "__proto__" can never match a building or resource.

const hasOwn = (obj, key) => typeof key === 'string' && obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
// config[key] only when key is a real entry of the table; otherwise undefined.
const own = (obj, key) => (hasOwn(obj, key) ? obj[key] : undefined);

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

// A safe integer from a number, or from a plain decimal string ("12", "-3"). NaN for anything else
// ("0x10", "1e3", " 7", [7], true, null...).
function toInt(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v + 0 : NaN; // + 0 turns -0 into 0
  if (typeof v === 'string' && /^-?\d{1,15}$/.test(v)) return Number(v) + 0;
  return NaN;
}
// A finite number from a number or a plain decimal string. NaN otherwise.
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && /^-?\d{1,15}(\.\d{1,6})?$/.test(v)) return Number(v);
  return NaN;
}
// The request body, or an empty object when it is anything but a plain object.
const body = (b) => (isPlain(b) ? b : {});

module.exports = { hasOwn, own, isPlain, toInt, toNum, body };
