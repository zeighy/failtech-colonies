'use strict';
// Admin panel: the world. The overview; colonies by phase (live, stewarded, parked) and what can be done to a parked one
// (give it back to its commander, hand it to a generated account for the bots, keep it from the bots, assign it to an
// account, wipe it); the two markets: what trades, at what price, who trades most, trades worth a second look, open orders
// (cancel any, the goods and credits they hold go back), freezing a market and nudging a good's price.
const fs = require('fs');
const store = require('../db');
const absence = require('../absence');
const engine = require('../engine');
const market = require('../market');
const orbitalMarket = require('../orbitalMarket');
const marketControl = require('../marketControl');
const ms = require('../marketsim');
const backup = require('../backup');
const botApi = require('../botApi');
const lifecycle = require('../lifecycle');
const serverlog = require('../serverlog');
const { db, config } = store;

const HOUR = 3600000;
const DAY = 24 * HOUR;
const tickNow = () => Number(store.getMeta('global_tick', 0));
const ticksPerDay = () => Math.round(DAY / engine.TICK_MS);
const resName = (r) => (config.resources[r] ? config.resources[r].name : r);

function phaseCounts(now = Date.now()) {
  const out = { live: 0, stewarded: 0, parked: 0 };
  for (const c of db.prepare('SELECT last_active_at, parked_at FROM colonies').all()) out[absence.phase(c, now)]++;
  return out;
}

module.exports = (r, h) => {
  const { need, audit, body, toInt, ok, bad } = h;

  r.get('/overview', need, (req, res) => {
    const now = Date.now();
    const t = engine.timing();
    const count = (sql, ...a) => db.prepare(sql).get(...a).n;
    const players = "generated = 0 AND bot_profile IS NULL";
    const bk = backup.listAll();
    const lastAuto = bk.find((b) => b.kind === 'auto');
    const runner = botApi.runnerStatus();
    const dayTicks = ticksPerDay();
    let dbSize = 0;
    for (const f of [store.dbPath, `${store.dbPath}-wal`]) { try { dbSize += fs.statSync(f).size; } catch (e) { /* none */ } }
    ok(res, {
      server: { tick: t.globalTick, tickMs: t.tickMs, lastTickAt: t.lastTickAt, clockPaused: lifecycle.clockPaused(), hold: lifecycle.pauseState(), idlePause: process.env.IDLE_PAUSE !== 'off', uptime: now - lifecycle.started, maintenance: lifecycle.maintenance(), notice: lifecycle.notice(), dbSize, node: process.version, pid: process.pid, ...lifecycle.stats() },
      players: {
        total: count(`SELECT COUNT(*) AS n FROM users WHERE ${players}`),
        verified: count(`SELECT COUNT(*) AS n FROM users WHERE ${players} AND email_verified = 1`),
        unverified: count(`SELECT COUNT(*) AS n FROM users WHERE ${players} AND email_verified = 0`),
        banned: count(`SELECT COUNT(*) AS n FROM users WHERE ${players} AND banned_at IS NOT NULL`),
        new7d: count(`SELECT COUNT(*) AS n FROM users WHERE ${players} AND created_at >= ?`, now - 7 * DAY),
        signedIn24h: count(`SELECT COUNT(*) AS n FROM users WHERE ${players} AND last_login_at >= ?`, now - DAY),
        active24h: count(`SELECT COUNT(*) AS n FROM colonies c JOIN users u ON u.id = c.user_id WHERE u.${players.replace(' AND ', ' AND u.')} AND c.last_active_at >= ?`, now - DAY),
      },
      colonies: { ...phaseCounts(now), total: count('SELECT COUNT(*) AS n FROM colonies'), stations: count('SELECT COUNT(*) AS n FROM stations'), shutdown: count('SELECT COUNT(*) AS n FROM colonies WHERE shutdown_tick IS NOT NULL') },
      bots: { api: botApi.enabled(), paused: botApi.paused(), accounts: count('SELECT COUNT(*) AS n FROM users WHERE bot_profile IS NOT NULL'), runnerSeen: runner ? runner.at : null, waiting: runner && runner.status ? runner.status.waiting : null },
      market: {
        frozen: marketControl.frozenAll(), adjusted: Object.keys(marketControl.adjustments()).length,
        groundTrades24h: count('SELECT COUNT(*) AS n FROM market_trades WHERE tick >= ?', t.globalTick - dayTicks),
        orbitTrades24h: count('SELECT COUNT(*) AS n FROM orbital_trades WHERE tick >= ?', t.globalTick - dayTicks),
        openPlayerOrders: count("SELECT COUNT(*) AS n FROM market_orders WHERE owner = 'player' AND status = 'open'") + count("SELECT COUNT(*) AS n FROM orbital_orders WHERE colony_id IS NOT NULL AND status = 'open'"),
      },
      backups: { count: bk.length, lastAuto: lastAuto ? lastAuto.at : null, pendingRestore: backup.pendingRestore(), settings: backup.settings() },
      recentErrors: serverlog.query({ level: 'error', limit: 8 }),
      signups: db.prepare(`SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM users WHERE ${players} AND created_at >= ? GROUP BY day ORDER BY day`).all(now - 30 * DAY),
    });
  });

  // ---- colonies ----
  r.get('/colonies', need, (req, res) => {
    const phase = ['live', 'stewarded', 'parked', 'all'].includes(req.query.phase) ? req.query.phase : 'parked';
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
    const now = Date.now();
    const rows = db.prepare(`SELECT c.*, u.username, u.generated, u.bot_profile, s.name AS station FROM colonies c JOIN users u ON u.id = c.user_id LEFT JOIN stations s ON s.colony_id = c.id
      WHERE (? = '' OR u.username LIKE ? OR s.name LIKE ? OR c.id = ?) ORDER BY COALESCE(c.parked_at, c.last_active_at) DESC LIMIT 1000`).all(q, `%${q}%`, `%${q}%`, Number(q) || -1);
    const list = rows.map((c) => ({ ...c, phase: absence.phase(c, now) })).filter((c) => phase === 'all' || c.phase === phase).slice(0, 300).map((c) => ({
      id: c.id, holder: c.username, holderId: c.user_id, kind: c.bot_profile ? 'bot' : c.generated ? 'generated' : 'player', profile: c.bot_profile,
      phase: c.phase, parkedAt: c.parked_at, lastActive: c.last_active_at, hub: c.hub_level, population: c.population, credits: c.credits, status: c.status,
      shutdown: c.shutdown_tick !== null, won: !!c.won, station: c.station, noBots: !!c.no_bots,
    }));
    ok(res, { phase, colonies: list });
  });
  const colonyOr404 = (req, res) => { const c = db.prepare('SELECT * FROM colonies WHERE id = ?').get(toInt(req.params.id)); if (!c) bad(res, 'No such colony.', 404); return c; };
  const who = (c) => db.prepare('SELECT username FROM users WHERE id = ?').get(c.user_id).username;

  r.post('/colonies/:id/park', need, (req, res) => {
    const c = colonyOr404(req, res);
    if (!c) return;
    db.prepare('UPDATE colonies SET parked_at = ? WHERE id = ? AND parked_at IS NULL').run(Date.now(), c.id);
    lifecycle.kick(c.user_id);
    audit(req, 'colony.park', `colony #${c.id} (${who(c)})`);
    ok(res);
  });
  // back to its commander, live again
  r.post('/colonies/:id/unpark', need, (req, res) => {
    const c = colonyOr404(req, res);
    if (!c) return;
    db.prepare('UPDATE colonies SET parked_at = NULL, away_notice = NULL, last_active_at = ? WHERE id = ?').run(Date.now(), c.id);
    audit(req, 'colony.unpark', `colony #${c.id} (${who(c)})`);
    ok(res);
  });
  // to a generated account (bots may claim it); its commander is told it was claimed, as for any claim
  r.post('/colonies/:id/handover', need, (req, res) => {
    const c = colonyOr404(req, res);
    if (!c) return;
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(c.user_id);
    db.transaction(() => {
      if (u && !u.generated && !u.bot_profile) db.prepare('UPDATE users SET notice = ? WHERE id = ?').run(JSON.stringify({ kind: 'claimed', at: Date.now() }), u.id);
      absence.handOver(c.id);
      if (u && u.bot_profile) db.prepare('DELETE FROM users WHERE id = ?').run(u.id); // an emptied bot account goes
    })();
    lifecycle.kick(c.user_id);
    audit(req, 'colony.handover', `colony #${c.id} (${u ? u.username : '?'})`);
    ok(res);
  });
  r.post('/colonies/:id/nobots', need, (req, res) => {
    const c = colonyOr404(req, res);
    if (!c) return;
    const on = !!body(req.body).on;
    db.prepare('UPDATE colonies SET no_bots = ? WHERE id = ?').run(on ? 1 : 0, c.id);
    audit(req, on ? 'colony.nobots' : 'colony.bots-allowed', `colony #${c.id} (${who(c)})`);
    ok(res);
  });
  // give it to an account that has no colony (it is live again, theirs to run)
  r.post('/colonies/:id/assign', need, (req, res) => {
    const c = colonyOr404(req, res);
    if (!c) return;
    const to = db.prepare('SELECT * FROM users WHERE id = ?').get(toInt(body(req.body).userId));
    if (!to) return bad(res, 'No such account.');
    if (to.generated || to.bot_profile) return bad(res, 'Assign it to a player account.');
    if (db.prepare('SELECT 1 FROM colonies WHERE user_id = ?').get(to.id)) return bad(res, 'That account already runs a colony.');
    const from = db.prepare('SELECT * FROM users WHERE id = ?').get(c.user_id);
    db.transaction(() => {
      db.prepare('UPDATE colonies SET user_id = ?, parked_at = NULL, away_notice = NULL, last_active_at = ? WHERE id = ?').run(to.id, Date.now(), c.id);
      db.prepare('UPDATE users SET notice = NULL WHERE id = ?').run(to.id);
      if (from && (from.generated || from.bot_profile)) db.prepare('DELETE FROM users WHERE id = ?').run(from.id);
      else if (from) db.prepare('UPDATE users SET notice = ? WHERE id = ?').run(JSON.stringify({ kind: 'claimed', at: Date.now() }), from.id);
    })();
    lifecycle.kick(c.user_id);
    audit(req, 'colony.assign', `colony #${c.id}`, { from: from ? from.username : null, to: to.username });
    ok(res);
  });
  r.post('/colonies/:id/wipe', need, (req, res) => {
    const c = colonyOr404(req, res);
    if (!c) return;
    if (toInt(body(req.body).confirm) !== c.id) return bad(res, 'Type the colony number to confirm.');
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(c.user_id);
    db.transaction(() => {
      db.prepare('DELETE FROM orbital_orders WHERE colony_id = ?').run(c.id);
      store.wipeColony(c.id);
      if (u && (u.generated || u.bot_profile)) db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    })();
    lifecycle.kick(c.user_id);
    audit(req, 'colony.wipe', `colony #${c.id} (${u ? u.username : '?'})`, { hub: c.hub_level, population: c.population });
    serverlog.warn('admin', `Colony #${c.id} wiped by ${req.admin.username}`, { userId: u && !u.generated ? u.id : null });
    ok(res);
  });
  r.get('/colonies/:id/events', need, (req, res) => {
    const c = colonyOr404(req, res);
    if (!c) return;
    ok(res, { events: db.prepare('SELECT tick, kind, message FROM colony_events WHERE colony_id = ? ORDER BY id DESC LIMIT 200').all(c.id) });
  });

  // ---- clock ----
  r.post('/clock', need, (req, res) => {
    const paused = !!body(req.body).paused;
    store.setMeta('clock_paused', paused ? '1' : '0');
    if (!paused) store.setMeta('last_tick_at', Date.now()); // the paused time is not caught up
    engine.checkHold(); // players' tabs and the bots hear of it at once
    audit(req, paused ? 'clock.pause' : 'clock.resume');
    serverlog.warn('maintenance', `Game clock ${paused ? 'paused' : 'resumed'} by ${req.admin.username}`);
    ok(res);
  });

  // ---- markets ----
  r.get('/market', need, (req, res) => {
    const tick = tickNow();
    const day = tick - ticksPerDay();
    const adjust = marketControl.adjustments();
    const groundVol = Object.fromEntries(db.prepare('SELECT resource_id AS r, SUM(qty) AS q, SUM(qty * price) AS v, COUNT(*) AS n FROM market_trades WHERE tick >= ? GROUP BY resource_id').all(day).map((x) => [x.r, x]));
    const orbitVol = Object.fromEntries(db.prepare('SELECT resource_id AS r, SUM(qty) AS q, SUM(qty * price) AS v, COUNT(*) AS n FROM orbital_trades WHERE tick >= ? GROUP BY resource_id').all(day).map((x) => [x.r, x]));
    const best = (table, ownerCol, res, side) => db.prepare(`SELECT price FROM ${table} WHERE resource_id = ? AND side = ? AND status = 'open' AND ${table === 'market_orders' ? 'qty' : 'remaining'} > 0 ORDER BY price ${side === 'buy' ? 'DESC' : 'ASC'} LIMIT 1`).get(res, side);
    const openBy = (table, res, cond) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE resource_id = ? AND status = 'open' AND ${cond}`).get(res).n;
    const goods = Object.keys(config.resources).map((res) => {
      const groundOk = !config.resources[res].orbitalOnly;
      const orbitOk = orbitalMarket.tradeable(res);
      const ref = ms.refPrice(config, res, tick);
      const ev = groundOk ? ms.event(config, res, tick) : null;
      const bb = groundOk ? best('market_orders', 'owner', res, 'buy') : null;
      const ba = groundOk ? best('market_orders', 'owner', res, 'sell') : null;
      const ob = orbitOk ? best('orbital_orders', 'colony_id', res, 'buy') : null;
      const oa = orbitOk ? best('orbital_orders', 'colony_id', res, 'sell') : null;
      return {
        resource: res, name: resName(res), tier: config.resources[res].tier, ground: groundOk, orbit: orbitOk, ref: Math.round(ref * 100) / 100, adjust: adjust[res] || 1, event: ev ? ev.kind : null,
        groundBid: bb ? bb.price : null, groundAsk: ba ? ba.price : null, orbitBid: ob ? ob.price : null, orbitAsk: oa ? oa.price : null,
        groundOpen: groundOk ? openBy('market_orders', res, "owner = 'player'") : 0, orbitOpen: orbitOk ? openBy('orbital_orders', res, 'colony_id IS NOT NULL') : 0,
        groundVol: groundVol[res] || null, orbitVol: orbitVol[res] || null,
      };
    });
    const topTraders = db.prepare(`SELECT colony, u.username, SUM(v) AS value, SUM(n) AS trades FROM (
        SELECT buy_colony AS colony, qty * price AS v, 1 AS n FROM market_trades WHERE tick >= ? AND buy_colony IS NOT NULL
        UNION ALL SELECT sell_colony, qty * price, 1 FROM market_trades WHERE tick >= ? AND sell_colony IS NOT NULL
      ) t LEFT JOIN colonies c ON c.id = t.colony LEFT JOIN users u ON u.id = c.user_id GROUP BY colony ORDER BY value DESC LIMIT 15`).all(day, day);
    ok(res, { tick, frozen: marketControl.frozenAll(), feeRate: { ground: config.exchange.feeRate, orbit: config.orbital.market.feeRate }, goods, topTraders });
  });

  r.get('/market/orders', need, (req, res) => {
    const kind = req.query.kind === 'orbit' ? 'orbit' : 'ground';
    const resF = typeof req.query.resource === 'string' && config.resources[req.query.resource] ? req.query.resource : null;
    const colony = toInt(req.query.colony);
    const tick = tickNow();
    let rows;
    if (kind === 'ground') {
      rows = db.prepare(`SELECT o.id, o.colony_id AS colony, u.username, o.side, o.resource_id AS resource, o.price, o.qty, o.qty_total AS total, o.escrow, o.created_tick AS created, o.expires_tick AS expires
        FROM market_orders o LEFT JOIN colonies c ON c.id = o.colony_id LEFT JOIN users u ON u.id = c.user_id
        WHERE o.owner = 'player' AND o.status = 'open' AND (? IS NULL OR o.resource_id = ?) AND (? IS NULL OR o.colony_id = ?) ORDER BY o.resource_id, o.side, o.price LIMIT 500`)
        .all(resF, resF, Number.isNaN(colony) ? null : colony, Number.isNaN(colony) ? null : colony);
    } else {
      rows = db.prepare(`SELECT o.id, o.colony_id AS colony, o.station_name AS username, o.side, o.resource_id AS resource, o.price, o.remaining AS qty, o.qty AS total, o.created_tick AS created, o.expires_tick AS expires
        FROM orbital_orders o WHERE o.colony_id IS NOT NULL AND o.status = 'open' AND (? IS NULL OR o.resource_id = ?) AND (? IS NULL OR o.colony_id = ?) ORDER BY o.resource_id, o.side, o.price LIMIT 500`)
        .all(resF, resF, Number.isNaN(colony) ? null : colony, Number.isNaN(colony) ? null : colony);
    }
    ok(res, { kind, tick, orders: rows.map((o) => ({ ...o, name: resName(o.resource), ticksLeft: o.expires - tick })) });
  });
  // Cancel player orders; what they hold goes back to their owners (who are told the exchange cancelled them).
  r.post('/market/orders/cancel', need, (req, res) => {
    const b = body(req.body);
    const kind = b.kind === 'orbit' ? 'orbit' : 'ground';
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(toInt).filter(Number.isInteger).slice(0, 500);
    if (!ids.length) return bad(res, 'No orders given.');
    const tick = tickNow();
    let n = 0;
    db.transaction(() => {
      for (const id of ids) {
        if (kind === 'ground') {
          const o = db.prepare("SELECT * FROM market_orders WHERE id = ? AND owner = 'player' AND status = 'open'").get(id);
          if (o) { market.close(o, 'cancelled', tick, 'was cancelled by the exchange'); n++; }
        } else {
          const o = db.prepare("SELECT * FROM orbital_orders WHERE id = ? AND colony_id IS NOT NULL AND status = 'open'").get(id);
          if (o) {
            orbitalMarket.release(o);
            db.prepare("UPDATE orbital_orders SET status = 'cancelled' WHERE id = ?").run(o.id);
            store.addEvent(o.colony_id, tick, 'info', `Orbital market: your ${o.side} order for ${o.remaining} ${resName(o.resource_id)} was cancelled by the market.`);
            n++;
          }
        }
      }
    })();
    audit(req, 'market.cancel', kind, { ids, cancelled: n });
    serverlog.warn('market', `${n} ${kind} order(s) cancelled by ${req.admin.username}`);
    ok(res, { cancelled: n });
  });

  r.get('/market/trades', need, (req, res) => {
    const kind = req.query.kind === 'orbit' ? 'orbit' : 'ground';
    const resF = typeof req.query.resource === 'string' && config.resources[req.query.resource] ? req.query.resource : null;
    const rows = kind === 'ground'
      ? db.prepare(`SELECT t.id, t.tick, t.resource_id AS resource, t.price, t.qty, t.buy_colony AS buyer, t.sell_colony AS seller, ub.username AS buyerName, us.username AS sellerName
          FROM market_trades t LEFT JOIN colonies cb ON cb.id = t.buy_colony LEFT JOIN users ub ON ub.id = cb.user_id LEFT JOIN colonies cs ON cs.id = t.sell_colony LEFT JOIN users us ON us.id = cs.user_id
          WHERE (? IS NULL OR t.resource_id = ?) ORDER BY t.id DESC LIMIT 300`).all(resF, resF)
      : db.prepare('SELECT id, tick, resource_id AS resource, price, qty, buyer AS buyerName, seller AS sellerName FROM orbital_trades WHERE (? IS NULL OR resource_id = ?) ORDER BY id DESC LIMIT 300').all(resF, resF);
    ok(res, { kind, trades: rows.map((t) => ({ ...t, name: resName(t.resource) })) });
  });

  // Trades worth a second look on the ground exchange over the last few days: two player colonies trading with each other
  // whose accounts share an address, the same pair trading again and again, or a price far from the reference.
  r.get('/market/flags', need, (req, res) => {
    const tick = tickNow();
    const since = tick - 3 * ticksPerDay();
    const pairs = db.prepare(`SELECT t.buy_colony AS buyer, t.sell_colony AS seller, ub.username AS buyerName, us.username AS sellerName, ub.last_ip AS buyerIp, us.last_ip AS sellerIp,
        ub.created_ip AS buyerIp0, us.created_ip AS sellerIp0, COUNT(*) AS trades, SUM(t.qty * t.price) AS value
      FROM market_trades t JOIN colonies cb ON cb.id = t.buy_colony JOIN users ub ON ub.id = cb.user_id JOIN colonies cs ON cs.id = t.sell_colony JOIN users us ON us.id = cs.user_id
      WHERE t.tick >= ? AND ub.bot_profile IS NULL AND us.bot_profile IS NULL GROUP BY t.buy_colony, t.sell_colony ORDER BY trades DESC LIMIT 200`).all(since);
    const flags = [];
    for (const p of pairs) {
      const ips = [p.buyerIp, p.buyerIp0].filter(Boolean);
      const shared = ips.some((ip) => ip === p.sellerIp || ip === p.sellerIp0);
      if (shared) flags.push({ kind: 'same-address', ...p });
      else if (p.trades >= 10) flags.push({ kind: 'repeat-pair', ...p });
    }
    const odd = [];
    for (const t of db.prepare('SELECT * FROM market_trades WHERE tick >= ? AND buy_colony IS NOT NULL AND sell_colony IS NOT NULL ORDER BY id DESC LIMIT 2000').all(since)) {
      const ref = ms.refPrice(config, t.resource_id, t.tick);
      const ratio = t.price / ref;
      if (ratio < 0.4 || ratio > 2.5) odd.push({ id: t.id, tick: t.tick, resource: t.resource_id, name: resName(t.resource_id), price: t.price, ref: Math.round(ref * 100) / 100, ratio: Math.round(ratio * 100) / 100, qty: t.qty, buyer: t.buy_colony, seller: t.sell_colony });
      if (odd.length >= 100) break;
    }
    ok(res, { pairs: flags.map(({ buyerIp, sellerIp, buyerIp0, sellerIp0, ...x }) => ({ ...x, address: x.kind === 'same-address' ? buyerIp || buyerIp0 : undefined })), oddPrices: odd });
  });

  r.post('/market/freeze', need, (req, res) => {
    const b = body(req.body);
    const kind = b.kind === 'orbit' ? 'orbit' : 'ground';
    marketControl.setFrozen(kind, !!b.on);
    audit(req, b.on ? 'market.freeze' : 'market.unfreeze', kind);
    serverlog.warn('market', `${kind === 'orbit' ? 'Orbital market' : 'Exchange'} ${b.on ? 'frozen' : 'reopened'} by ${req.admin.username}`);
    ok(res, { frozen: marketControl.frozenAll() });
  });
  r.post('/market/adjust', need, (req, res) => {
    const b = body(req.body);
    const before = marketControl.adjustments()[b.resource] || 1;
    const out = marketControl.setAdjust(b.resource, b.mult === null || b.mult === '' ? null : Number(b.mult));
    if (!out.ok) return bad(res, out.error);
    if (config.resources[b.resource] && !config.resources[b.resource].orbitalOnly) market.requote(b.resource, tickNow()); // the market makers quote the new price now
    audit(req, 'market.adjust', b.resource, { before, after: out.adjust[b.resource] || 1 });
    serverlog.warn('market', `Price of ${resName(b.resource)} set to ×${out.adjust[b.resource] || 1} by ${req.admin.username}`);
    ok(res, out);
  });
};
