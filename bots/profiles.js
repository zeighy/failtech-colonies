'use strict';
// How each bot plays. Every profile runs the same brain (bots/brain): keep the colony alive first, grow it from the ground up,
// reach orbit, and sell something on the orbital market, which is every profile's main objective. What differs is temper:
// how much stock it keeps back, which districts it founds first, which trade goods its Free Port makes, and how it trades.
//
//   safety       multipliers on the food, water and power margins and on the stock kept back from any sale
//   districts    the order districts are founded in (all three are founded in the end)
//   workshops    the trade goods the Free Port's workshops make, in the order they are built (besides the launch goods)
//   orbitSell    what it sells on the orbital market, and how it prices it:
//                  goods: 'orbital' (foundry goods: lattice cores, null alloy...), 'trade' (Free Port goods), or 'any'
//                  price: 'band'  a price drawn at random between `band[0]` and `band[1]` times the market maker's price,
//                                 fresh for every order
//                         'under' just under the best ask (it wants to sell)
//                         'ref'   at the reference price
//                  lot:   [min, max] units per order (modest amounts)
//   orbitBuy     small purchases on the orbital market: up to `lot` units of a good it uses, never above `maxRef` times the
//                reference, and never more than `budget` of its credits on open buys
//   surface      ground exchange trading: sells and buys around the reference price, for activity at the port
//   projects     the share of what the station holds that it gives to the global project (0: it sells instead)
//   requisitions fill the Office's requisitions from what it can spare
//   alts         switch to alternative recipes as they open
// and, for a profile that does not chase growth (the money pit):
//   settle       once the station is up it stays as it is: no more launches, expansions, new lines or household options
//   convoy       sells surplus by convoy earlier and deeper: { from, to } as shares of the Core's storage cap
//   sink         takes goods off the orbital market once rich: past `from` credits, every `every` ticks it buys `lot` units
//                of what other stations have listed (never the market maker's asks) at up to `maxRef` times the reference,
//                and jettisons them; `goods`: 'orbital' (orbital goods only), 'any', or 'orbital_first' (trade goods too, only
//                when no orbital good qualifies, in lots of `tradeLot`); a slot is dumped at `dumpAt` units (`tradeDumpAt` for
//                trade goods)
const PROFILES = {
  broker: {
    name: 'Foundry Broker',
    blurb: 'Drives hard for orbit and the foundry, and sells orbital goods at a price drawn between 20% under and 20% over the market maker\'s.',
    safety: 1,
    districts: ['stacks', 'pits', 'greenbelt'],
    workshops: ['tool_steel', 'plastics', 'precision_tools'],
    orbitSell: { goods: 'orbital', price: 'band', band: [0.8, 1.2], lot: [1, 4], keep: 0 },
    orbitBuy: { lot: [1, 3], maxRef: 1.0, budget: 0.04, goods: 'rare_inputs' },
    surface: null,
    projects: 0,
    requisitions: true,
    alts: true,
  },
  porter: {
    name: 'Port Trader',
    blurb: 'Builds a busy Free Port and keeps the ground exchange moving with its trade goods; in orbit it sells the same goods.',
    safety: 1.1,
    districts: ['pits', 'greenbelt', 'stacks'],
    workshops: ['curios', 'preserves', 'tool_steel', 'plastics', 'tinctures', 'luxuries'],
    orbitSell: { goods: 'trade', price: 'under', lot: [3, 12], keep: 20 },
    orbitBuy: { lot: [2, 6], maxRef: 0.95, budget: 0.03, goods: 'trade' },
    surface: { sellShare: 0.5, lot: [5, 40], buyLot: [3, 15], buyBudget: 0.03, spread: [0.97, 1.08], maxOrders: 8, goods: 'trade_and_surplus' },
    projects: 0.3,
    requisitions: true,
    alts: true,
  },
  steward: {
    name: 'Steward',
    blurb: 'Plays it safe: deep food and water reserves, slow and steady growth; gives its orbital goods to the global projects and sells spare trade goods at the reference price.',
    safety: 1.8,
    districts: ['greenbelt', 'pits', 'stacks'],
    workshops: ['preserves', 'tinctures', 'tool_steel', 'plastics'],
    orbitSell: { goods: 'trade', price: 'ref', lot: [2, 8], keep: 40 },
    orbitBuy: { lot: [1, 2], maxRef: 0.9, budget: 0.01, goods: 'trade' },
    surface: null,
    projects: 1,
    requisitions: false,
    alts: false,
  },
  industrialist: {
    name: 'Industrialist',
    blurb: 'Builds big, takes every alternative recipe, fills requisitions, and sells whatever it makes most of in orbit.',
    safety: 0.9,
    districts: ['pits', 'stacks', 'greenbelt'],
    workshops: ['tool_steel', 'plastics', 'precision_tools', 'curios', 'luxuries'],
    orbitSell: { goods: 'any', price: 'under', lot: [2, 10], keep: 30 },
    orbitBuy: { lot: [1, 4], maxRef: 1.0, budget: 0.03, goods: 'rare_inputs' },
    surface: null,
    projects: 0.5,
    requisitions: true,
    alts: true,
  },
  scavenger: {
    name: 'Scavenger',
    blurb: 'Lean and opportunistic: picks up cheap asks on the orbital market in small lots and sells orbital and trade goods near the reference.',
    safety: 1.2,
    districts: ['stacks', 'greenbelt', 'pits'],
    workshops: ['curios', 'plastics', 'tool_steel'],
    orbitSell: { goods: 'any', price: 'ref', lot: [1, 6], keep: 10 },
    orbitBuy: { lot: [1, 5], maxRef: 0.92, budget: 0.05, goods: 'any' },
    surface: null,
    projects: 0,
    requisitions: true,
    alts: true,
  },
  moneypit: {
    name: 'Money Pit',
    blurb: 'Reaches orbit and settles: a steady population, surplus sold by convoy, and past 2 million credits it buys up the orbital goods (failing those, trade goods) others have listed, a few at a time, and jettisons them.',
    safety: 1.4,
    districts: ['greenbelt', 'pits', 'stacks'],
    workshops: ['preserves', 'tool_steel', 'plastics'],
    orbitSell: null,
    orbitBuy: null,
    surface: null,
    projects: 0,
    requisitions: true,
    alts: true,
    settle: true,
    convoy: { from: 0.6, to: 0.4 },
    sink: { from: 2000000, every: 30, lot: [1, 4], maxRef: 1.15, goods: 'orbital_first', dumpAt: 40, tradeLot: [5, 30], tradeDumpAt: 200 },
  },
};

const ORDER = Object.keys(PROFILES);
const get = (id) => PROFILES[id] || null;

module.exports = { PROFILES, ORDER, get };
