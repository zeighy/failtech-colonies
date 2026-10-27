'use strict';
// The exchange's price model: pure, deterministic and DB-free. Every price is a function of (resource, tick), so the
// market is reproducible and testable. Prices wander on a smooth seeded walk, with occasional shortage and glut
// events, and the NPC market makers quote a ladder of orders around the reference price.

function hash(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const phases = new Map();
function phasesFor(res, n) {
  const key = `${res}:${n}`;
  if (!phases.has(key)) { const r = rng(hash(`walk:${res}`)); phases.set(key, Array.from({ length: n }, () => r())); }
  return phases.get(key);
}

// The middle of the convoy's buy and sell prices: the exchange trades in the gap between them.
const midPrice = (config, res) => Math.sqrt(config.resources[res].buy * config.resources[res].sell);

// Smooth multiplier from a few seeded sine waves.
function walk(config, res, tick) {
  const w = config.exchange.walk;
  const ph = phasesFor(res, w.periods.length);
  let m = 0;
  w.periods.forEach((p, i) => { m += Math.sin(2 * Math.PI * (tick / p + ph[i])); });
  return 1 + (w.amplitude * m) / w.periods.length * 1.6;
}

// Shortage / glut windows: one chance per `period` ticks per resource. null when quiet.
function event(config, res, tick) {
  const e = config.exchange.events;
  const w = Math.floor(tick / e.period);
  const r = rng(hash(`event:${res}:${w}`));
  if (r() >= e.chance) return null;
  const kind = r() < 0.5 ? 'shortage' : 'glut';
  const start = w * e.period + Math.floor(r() * (e.period - e.duration));
  if (tick < start || tick >= start + e.duration) return null;
  return { kind, startedAt: start, ticksLeft: start + e.duration - tick };
}

// Trade goods have no walk of their own: their price follows their ingredients' (a fixed premium on what they cost
// to make), so crafting from goods bought on the exchange can never be a money machine. They still have events.
const makers = new WeakMap();
function makerOf(config, res) {
  if (!makers.has(config)) {
    const m = {};
    for (const rec of Object.values(config.recipes || {})) for (const out of Object.keys(rec.outputsPerTick)) m[out] = rec;
    makers.set(config, m);
  }
  return makers.get(config)[res];
}
function refPrice(config, res, tick) {
  const ev = event(config, res, tick);
  const mult = ev ? config.exchange.events[ev.kind].price : 1;
  // Some goods follow another good's price, so a conversion between them can never be a money machine
  // (raw synthetics are half a polymer: the reclaimer turns two into one).
  const link = config.exchange.priceLinks && config.exchange.priceLinks[res];
  if (link) return link.ratio * refPrice(config, link.of, tick) * mult;
  const rec = config.resources[res].trade && makerOf(config, res);
  if (rec) {
    let cost = 0;
    for (const [r, q] of Object.entries(rec.inputsPerTick)) if (r !== 'energy') cost += q * refPrice(config, r, tick);
    return config.tradeWorks.priceRatio * cost / rec.outputsPerTick[res] * mult;
  }
  return midPrice(config, res) * walk(config, res, tick) * mult;
}

// Prices are in credits per unit with two decimals (cheap goods trade for fractions of a credit).
const money = (v) => Math.max(0.01, Math.round(v * 100) / 100);

const depthTarget = (config, res) => config.exchange.depthByTier[config.resources[res].tier] || 100;

// NPC quotes: `levels` rungs per side. Prices stay inside the convoy's band so the convoy is never a better deal
// than the book (bids below 90% of the convoy's buy price, asks above 110% of its sell price).
function ladder(config, res, tick) {
  const x = config.exchange;
  const ref = refPrice(config, res, tick);
  const ev = event(config, res, tick);
  const r = config.resources[res];
  const askDepth = ev && ev.kind === 'shortage' ? x.events.shortage.askDepth : 1;
  const bidDepth = ev && ev.kind === 'glut' ? x.events.glut.bidDepth : 1;
  const base = depthTarget(config, res);
  const asks = []; const bids = [];
  for (let k = 0; k < x.levels; k++) {
    const off = x.spread + k * x.step;
    asks.push({ level: k, price: money(Math.max(ref * (1 + off), r.sell * x.convoyBand.askMinOfConvoySell)), target: Math.max(1, Math.round(base * askDepth * (1 + k * 0.4))) });
    bids.push({ level: k, price: money(Math.min(ref * (1 - off), r.buy * x.convoyBand.bidMaxOfConvoyBuy)), target: Math.max(1, Math.round(base * bidDepth * (1 + k * 0.4))) });
  }
  return { ref, asks, bids, event: ev };
}

const history = (config, res, tick, n = config.exchange.historyTicks) =>
  Array.from({ length: n }, (_, i) => Math.round(refPrice(config, res, Math.max(0, tick - (n - 1 - i))) * 100) / 100);

module.exports = { money, hash, rng, midPrice, walk, event, refPrice, ladder, history, depthTarget };
