(function () {
  'use strict';

  // ------------------------------------------------------------------ helpers
  var $ = function (id) { return document.getElementById(id); };
  var NS = 'http://www.w3.org/2000/svg';
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var fmt = function (n) { return Math.floor(n + 1e-6).toLocaleString('en-US'); };
  var rate = function (n) {
    if (Math.abs(n) < 0.05) return '±0';
    var s = Math.abs(n) < 10 ? Math.abs(n).toFixed(1) : String(Math.round(Math.abs(n)));
    return (n > 0 ? '+' : '−') + s;
  };
  var pct = function (n) { return Math.round(n * 100) + '%'; };
  function svgEl(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  // ------------------------------------------------------------------ state
  var CFG = null;          // static config
  var S = null;            // the server view, with the buildings/stock/grid of the active district swapped in
  var RAW = null;          // the server view as received
  var activeId = null;     // district being looked at (the Core by default)
  var radarFor = null;     // district the radar was built for
  var mk = { res: 'alloys', side: 'buy', qty: 50, price: null, district: null, ttl: 100 }; // exchange order being composed
  var msrc = null;         // district missions are filled from
  var dmode = 'overview';  // Districts tab: 'overview' | 'logistics'
  var route = { from: null, to: null, res: 'scrap', rate: 10, reserve: 0, target: 0 }; // route being composed
  var ship = { from: null, to: null, res: 'scrap', qty: 100 }; // shipment being composed
  var sel = null;          // { ring, slot } | { hub: true } | null
  var ws = null;           // the workspace open over the map (a screen from the dock), or null
  var bellSeen = 0;        // newest event the player has looked at in the notifications popover
  var pins = null;         // stock the player pinned to the overview (null = automatic)
  var msgTab = 'mail', msgSel = {};     // tab of the Messages window
  var offset = 0;          // server clock - client clock
  var lastEventId = null;
  var shown = {};          // modals already shown (per page load)
  var connected = true;
  var confirmKey = null, confirmTimer = null, confirmAt = 0; // two-step buttons: the second click only counts after a short pause (not a double click)
  var CONFIRM_DELAY = 700;
  var restarting = false;  // suppresses the collapse modal while a restart is in flight
  var slotEls = {};        // "r:s" -> {g, cell, ...}
  var ringLabels = {};     // ring -> svg text (plot size / locked notice)
  var viewR = 0, targetR = 0; // radar zoom: current / target visible radius
  var viewC = [0, 0], goalR = 0, goalC = [0, 0]; // radar centre, and where the view is gliding to
  var userView = false, autoFocus = false, dragEndAt = 0; // the player (or a selection on a phone) has set the view; when a drag ended
  var acking = false;      // away report acknowledgement in flight
  var pending = [];        // actions clicked while offline, waiting to be sent
  var pendingSeq = 0, flushing = false, lastMsgAt = Date.now(), es = null;
  var apiDown = false;     // sends are failing even if the live stream still looks alive
  var convoyMode = 'scheduled'; // 'scheduled' | 'express'
  var xdraft = { sell: {}, buy: {} }; // express order being composed
  var hubEl = null;
  var STEP = {}; // every stepper moves by 10 (hold Shift for 100); type a value for anything else
  var MOBILE = document.documentElement.getAttribute('data-shell') === 'mobile'; // the phone shell (mobile.html)
  var groundId = null;     // the surface district looked at last (where a surface screen opens from orbit)
  var drawer = null;       // phone shell: the sheet over everything ('more' = every screen, 'places' = where to go)
  var buildCat = 'all';    // build menu filter
  var replaceAt = null;    // { ring, slot } of the building being replaced (the build menu is open on it), or null
  function inOrbit() { return !!(RAW && activeD().orbital); }
  function stationId() { return RAW && RAW.orbital && RAW.orbital.station ? RAW.orbital.station.districtId : null; }
  function enterOrbit() { var id = stationId(); if (id === null) return; enter(id); }
  // Every screen, in one fixed order. The desk shell lists them all down the left edge; the phone shell keeps four on its
  // bottom bar and the rest one tap behind More. A screen is [id, name, icon, shortcut key].
  var NAV = [
    { id: 'colony', name: 'Colony', tabs: [['brief', 'Brief', 'check', 'b'], ['people', 'People', 'users', 'p'], ['hub', 'Hub', 'hub', 'h'], ['districts', 'Districts', 'map', 'd'], ['settle', 'Settlements', 'camp', 'g']] },
    { id: 'economy', name: 'Economy', tabs: [['stockpile', 'Stockpile', 'box', 's'], ['logistics', 'Logistics', 'route', 'l'], ['convoy', 'Convoy', 'truck', 'c'], ['exchange', 'Exchange', 'scale', 'x'], ['missions', 'Missions', 'flag', 'n']] },
    { id: 'orbit', name: 'Orbit', tabs: [['ostore', 'Storage', 'box', 'o'], ['omarket', 'Market', 'scale'], ['oterr', 'Expeditions', 'ship', 'e'], ['oproject', 'Project', 'globe']] },
    { id: 'data', name: 'Archive', tabs: [['data', 'Data', 't_data'], ['hq', 'Headquarters', 'hub']] }
  ];
  var MTABS = [['map', 'Map', 'radar'], ['brief', 'Brief', 'check'], ['stockpile', 'Stock', 'box'], ['convoy', 'Trade', 'truck']]; // the phone's bottom bar, before More
  var ORBIT_WS = { ostore: 1, omarket: 1, oterr: 1, oproject: 1 };
  // Orbit stays out of sight until there is a station, and the Data screen until the first fragment has been recovered.
  // Headquarters sits beside the Data screen and opens once a data packet has been read.
  function navGroups() {
    return NAV.filter(function (g) { return g.id === 'orbit' ? stationId() !== null : g.id === 'data' ? !!(S && ((S.data && S.data.unlocked) || (S.hq && S.hq.unlocked))) : true; })
      .map(function (g) { return g.id === 'data' && !(S && S.hq && S.hq.unlocked) ? { id: g.id, name: g.name, tabs: g.tabs.filter(function (t) { return t[0] !== 'hq'; }) } : g; });
  }
  function tabOf(id) { var t = null; NAV.forEach(function (g) { g.tabs.forEach(function (x) { if (x[0] === id) t = x; }); }); return t; }
  function groupOf(id) { return navGroups().filter(function (g) { return g.tabs.some(function (t) { return t[0] === id; }); })[0] || null; }
  function groundD() { return (RAW && RAW.districts.filter(function (d) { return d.id === groundId && !d.orbital; })[0]) || RAW.districts.filter(function (d) { return d.core; })[0]; }
  function tabLabel(t) { var ui = CFG.ui && CFG.ui.tabs; return (t[0] === 'hub' && !groundD().core ? 'District' : (ui && ui[t[0]]) || t[1]); }
  // A screen that has nothing to offer yet (it says when it opens). It keeps its place in the list, marked with a lock.
  function tabLocked(id) {
    if (id === 'districts' || id === 'logistics') return !S.districtsUnlocked;
    if (id === 'exchange') return !S.exchange.unlocked;
    if (id === 'settle') return !(S.settlements && S.settlements.unlocked);
    if (id === 'missions') return !S.freeport && !(S.requisitions && S.requisitions.unlocked);
    return false;
  }
  // Where a link that names a screen goes: the map, a workspace, or one of the two overlays. Surface screens open on the
  // surface and orbital ones in orbit, so asking for one from the other place moves the view there first.
  function go(t) {
    drawer = null;
    if (t === 'comms' || t === 'log') { renderNav(); renderDrawer(); messages(t === 'log' ? 'history' : 'mail'); return; }
    if (t === 'site' || t === 'map') { ws = null; document.body.classList.remove('panel-full'); renderAll(); return; }
    if (!tabOf(t) || !groupOf(t)) { renderAll(); return; }
    if (ORBIT_WS[t]) { if (!inOrbit()) look(stationId()); }
    else if (t !== 'data' && t !== 'hq' && inOrbit()) look(groundD().id);
    ws = t; renderAll();
    var b = $('sheet-body'); if (b) b.scrollTop = 0;
  }

  // ------------------------------------------------------------------ api
  // A number the player can type into. The panel is not redrawn while it has focus, and the value is applied when they leave
  // the field or press Enter (see commitNum).
  function numIn(kind, val, attrs) {
    return '<input class="numin" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" data-num="' + kind + '" ' + attrs + ' value="' + esc(String(val)) + '" aria-label="Amount">';
  }
  function api(path, body) {
    return fetch('/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body || {})
    }).then(function (r) {
      // signed out, or something to settle first (an email to confirm, a suspension, maintenance): the sign-in page says which
      if (r.status === 401 || (r.status === 403 && path !== 'logout') || r.status === 503) { location.href = '/'; return new Promise(function () {}); }
      return r.json();
    });
  }
  // ---- offline queue -------------------------------------------------------
  // Clicks made while disconnected are kept here, shown on screen, and sent in order on
  // reconnect. Express trips, resets and restarts need a live connection (they spend money
  // at the moment of sending), so they are refused instead.
  var QUEUEABLE = { build: 1, demolish: 1, toggle: 1, boost: 1, cancel: 1, upgrade: 1, contract: 1 }; // founding and shipments spend stock at once, so they need a live link
  function isNetErr(e) { return e instanceof TypeError; }
  function labelFor(path, body) {
    var where = function (r, s) { return 'R' + r + '·' + (s + 1); };
    var nameAt = function (r, s) { var b = S && buildingAt(r, s); return b ? CFG.buildings[b.type].name : 'structure'; };
    if (path === 'build') return 'Build ' + CFG.buildings[body.type].name + ' (' + where(body.ring, body.slot) + ')';
    if (path === 'demolish') return 'Demolish ' + nameAt(body.ring, body.slot) + ' (' + where(body.ring, body.slot) + ')';
    if (path === 'toggle') return (body.paused ? 'Pause ' : 'Resume ') + nameAt(body.ring, body.slot) + ' (' + where(body.ring, body.slot) + ')';
    if (path === 'boost') { var bb = S && buildingAt(body.ring, body.slot), bd = bb && CFG.buildings[bb.type], bc = body.option && bd && bd.expand && CFG.expansion.classes[bd.expand], opt = bc ? (bc.options || {})[body.option] : bd && bd.optional; return (body.enabled ? 'Switch on ' : 'Switch off ') + (opt ? opt.label : 'optional input') + ' (' + where(body.ring, body.slot) + ')'; }
    if (path === 'cancel') return 'Cancel a work order';
    if (path === 'upgrade') return 'Upgrade ' + (activeD().core ? 'the hub' : activeD().name);
    if (path === 'contract') return body.amount ? (body.side === 'export' ? 'Sell ' : 'Buy ') + body.amount + ' ' + CFG.resources[body.resource].name + ' each convoy' : 'Clear ' + body.side + ' order for ' + CFG.resources[body.resource].name;
    return path;
  }
  function queueKey(path, body) {
    if (path === 'contract') return 'contract:' + body.resource + ':' + body.side;
    if (body.ring !== undefined) return path + ':' + body.district + ':' + body.ring + ':' + body.slot;
    return path + ':' + (body.orderId || '');
  }
  function queuedBuild(r, s) { return pending.filter(function (p) { return p.path === 'build' && p.body.district === activeId && p.body.ring === r && p.body.slot === s; })[0]; }
  function enqueue(path, body) {
    if (!QUEUEABLE[path]) { toast('You are offline. That action needs a live connection.'); return Promise.resolve({ ok: false, offline: true }); }
    var key = queueKey(path, body), label = labelFor(path, body);
    pending = pending.filter(function (p) { return p.key !== key; }); // a newer click replaces the one it supersedes
    pending.push({ id: ++pendingSeq, key: key, path: path, body: body, label: label, at: Date.now() });
    toast('Offline: "' + label + '" is waiting to be sent. It goes out when you reconnect.');
    if (S) { renderQueue(); renderRadar(); renderAlerts(); renderPanel(); }
    return Promise.resolve({ ok: true, held: true });
  }
  function goOffline() {
    if (!connected) return;
    connected = false;
    if (S) { renderAlerts(); renderQueue(); }
  }
  function act(path, body, okMsg) {
    if (!connected || navigator.onLine === false) return enqueue(path, body);
    return api(path, body).then(function (d) {
      if (!d.ok) { toast(d.error || 'Action failed.'); return d; }
      if (d.state) setState(d.state);
      if (okMsg) toast(okMsg, true);
      return d;
    }).catch(function (e) {
      if (isNetErr(e)) { apiDown = true; goOffline(); return enqueue(path, body); }
      toast('Something went wrong sending that.');
      return { ok: false };
    });
  }
  function flush() {
    if (flushing || !pending.length || !connected) return;
    flushing = true;
    var sent = 0, failed = 0;
    renderQueue(); renderAlerts();
    (function next() {
      if (!pending.length) {
        flushing = false;
        if (sent || failed) toast('Reconnected: ' + sent + ' queued action' + (sent === 1 ? '' : 's') + ' sent' + (failed ? ', ' + failed + ' rejected' : '') + '.', !failed);
        renderAll();
        return;
      }
      var item = pending[0];
      api(item.path, item.body).then(function (d) {
        pending.shift();
        if (d.ok) { sent++; if (d.state) setState(d.state); }
        else { failed++; toast('Queued "' + item.label + '" was rejected: ' + (d.error || 'failed')); }
        renderQueue();
        next();
      }).catch(function (e) {
        if (isNetErr(e)) { flushing = false; apiDown = true; goOffline(); renderAll(); return; } // still offline: keep the rest
        pending.shift(); failed++; next();
      });
    })();
  }

  function toast(msg, ok) {
    var el = document.createElement('div');
    el.className = 'toast' + (ok === 'info' ? ' info' : ok ? ' ok' : '');
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(function () { el.classList.add('out'); setTimeout(function () { el.remove(); }, 320); }, ok ? 2200 : 3600);
    while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
  }

  // ------------------------------------------------------------------ geometry
  var HUB_R = 56, RING_GAP = 6, SLOT_GAP = 5, RING_WIDTHS = [50, 58, 66, 74, 82];
  function ringW(r) { return RING_WIDTHS[r - 1] || 82; }
  function ringInner(r) { var x = HUB_R + 22; for (var i = 1; i < r; i++) x += ringW(i) + RING_GAP; return x; }
  function ringOuter(r) { return ringInner(r) + ringW(r); }
  function polar(r, a) { return [r * Math.cos(a), r * Math.sin(a)]; }
  // Some rings are turned a few degrees so their slots straddle the seams of the rings beside them.
  function ringTurn(ring) { var g = GEO().rotation || {}; return (g[ring] || 0) * Math.PI / 180; }
  function sectorPath(ring, i, cap) {
    var r0 = ringInner(ring), r1 = ringOuter(ring);
    var rot = ringTurn(ring);
    var a0 = -Math.PI / 2 + rot + (i / cap) * 2 * Math.PI, a1 = -Math.PI / 2 + rot + ((i + 1) / cap) * 2 * Math.PI;
    var o0 = a0 + SLOT_GAP / (2 * r1), o1 = a1 - SLOT_GAP / (2 * r1);
    var i0 = a0 + SLOT_GAP / (2 * r0), i1 = a1 - SLOT_GAP / (2 * r0);
    var large = (o1 - o0) > Math.PI ? 1 : 0;
    var p = function (pt) { return pt[0].toFixed(2) + ' ' + pt[1].toFixed(2); };
    return 'M' + p(polar(r1, o0)) + ' A' + r1 + ' ' + r1 + ' 0 ' + large + ' 1 ' + p(polar(r1, o1)) +
      ' L' + p(polar(r0, i1)) + ' A' + r0 + ' ' + r0 + ' 0 ' + large + ' 0 ' + p(polar(r0, i0)) + ' Z';
  }
  function slotCenter(ring, i, cap) {
    var rm = ringInner(ring) + ringW(ring) / 2;
    return polar(rm, -Math.PI / 2 + ringTurn(ring) + ((i + 0.5) / cap) * 2 * Math.PI);
  }
  function activeD() { return RAW.districts.filter(function (d) { return d.id === activeId; })[0] || RAW.districts[0]; }
  // Rings, plots, neighbours and level table of the district being viewed.
  function GEO() {
    var d = activeD();
    if (d.core) return { rings: CFG.rings, ringPlotSize: CFG.ringPlotSize, neighbors: CFG.neighbors, levels: CFG.hubLevels, rotation: CFG.ringRotation };
    var t = CFG.districtTypes[d.type] || CFG.orbitalTypes[d.type];
    return { rings: t.rings, ringPlotSize: t.ringPlotSize, neighbors: t.neighbors, levels: t.levels, rotation: t.ringRotation };
  }
  // A few ground buildings are built in a territory too, with their `territory` block laid over them (no crew, a field build,
  // sometimes different inputs and outputs).
  function bdef(k) {
    var d = CFG.buildings[k];
    return d && d.territory && activeD() && activeD().type === 'territory' ? Object.assign({}, d, d.territory) : d;
  }
  // What this territory holds: the two common resources, the district resource and the rare one.
  function field() { var v = S && S.views && S.views[activeId]; return v && v.territory ? v.territory : null; }
  function bookFor(d) {
    if (d && d.recipeSet === 'tap') {
      var f = field(), book = {};
      Object.keys(CFG.tapRecipes).forEach(function (k) { if (f && CFG.tapRecipes[k].rare === f.rare) book[k] = CFG.tapRecipes[k]; });
      return book;
    }
    return d && d.recipeSet === 'orbital' ? CFG.orbitalRecipeBook : CFG.recipes;
  }
  function plotName(ring) { return CFG.plotSizes[GEO().ringPlotSize[ring]].name; }
  function plotMultFor(def, ring) {
    var deficit = Math.max(0, def.minPlotSize - GEO().ringPlotSize[ring]);
    return Math.pow(CFG.plotPenalty, deficit);
  }
  function setView(R) { $('radar').setAttribute('viewBox', (viewC[0] - R).toFixed(1) + ' ' + (viewC[1] - R).toFixed(1) + ' ' + (2 * R).toFixed(1) + ' ' + (2 * R).toFixed(1)); }
  // Zoom the radar to fit the unlocked rings plus a peek at the next one (and, on a desk, never so close that a new colony fills the screen).
  function zoomTarget() {
    var unlocked = Object.keys(S.hub.rings).length, total = Object.keys(GEO().rings).length;
    return Math.max(MOBILE ? 0 : 270, ringOuter(Math.min(unlocked + 1, total)) + 30);
  }
  // The player's own zoom and pan: the wheel, a pinch, a drag, or the buttons on the map. "Fit" hands the view back.
  function mapMaxR() { return ringOuter(Object.keys(GEO().rings).length) + 40; }
  function mapSide() { var b = $('radar').getBoundingClientRect(); return { box: b, side: Math.min(b.width, b.height) }; }
  function clampView() { var m = mapMaxR(); viewC[0] = clamp(viewC[0], -m, m); viewC[1] = clamp(viewC[1], -m, m); }
  function zoomBy(f, px, py) { // f < 1 zooms in; (px, py) is the point on screen that stays put
    var g = mapSide(); if (!g.side || !viewR) return;
    var r1 = clamp(viewR * f, 110, mapMaxR());
    if (px !== undefined) {
      viewC[0] += (px - (g.box.left + g.box.width / 2)) / g.side * 2 * (viewR - r1);
      viewC[1] += (py - (g.box.top + g.box.height / 2)) / g.side * 2 * (viewR - r1);
    }
    viewR = r1; held();
  }
  function panBy(dx, dy) {
    var g = mapSide(); if (!g.side || !viewR) return;
    viewC[0] -= dx / g.side * 2 * viewR; viewC[1] -= dy / g.side * 2 * viewR;
    held();
  }
  function held() { userView = true; autoFocus = false; clampView(); goalR = viewR; goalC = viewC.slice(); setView(viewR); renderZoom(); }
  function fitView() { userView = false; autoFocus = false; renderZoom(); }
  // On a phone the map shrinks when something is selected, so the view glides in on the chosen plot and its neighbours.
  function focusSlot(ring, slot) {
    if (!MOBILE || (userView && !autoFocus)) return;
    var cap = GEO().rings[ring]; if (!cap) return;
    var c = slotCenter(ring, slot, cap), r = Math.min(zoomTarget(), Math.max(190, ringW(ring) * 3));
    goalR = r; goalC = [c[0] * 0.8, c[1] * 0.8]; userView = true; autoFocus = true; renderZoom();
  }
  function renderZoom() {
    var el = $('zoomctl'); if (!el) return;
    var h = '<button data-act="zoom" data-z="in" title="Zoom in" aria-label="Zoom in">' + icon('plus', 15) + '</button><button data-act="zoom" data-z="out" title="Zoom out" aria-label="Zoom out">' + icon('minus', 15) + '</button>' +
      '<button data-act="zoom" data-z="fit" class="' + (userView ? 'on' : '') + '" title="Fit the map to the screen" aria-label="Fit the map">' + icon('fit', 15) + '</button>';
    if (el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; }
  }

  // ------------------------------------------------------------------ derived lookups
  function buildingAt(r, s) { return S.buildings.filter(function (b) { return b.ring === r && b.slot === s; })[0]; }
  function lockAt(r, s) { return (S.locks || []).filter(function (l) { return l.ring === r && l.slot === s; })[0]; }
  function orderAt(r, s) { return S.orders.filter(function (o) { return (o.kind === 'build' || o.kind === 'replace') && o.data.ring === r && o.data.slot === s; })[0]; }
  function ordersAt(r, s) { return S.orders.filter(function (o) { return o.data.ring === r && o.data.slot === s; }); }
  function waitingOf(orders) { return orders.filter(function (o) { return o.state === 'queued'; }); }
  // Build slots: how many orders this place carries out at once, and whether one is free for a new order right now
  // (the queue is strict, so anything already waiting goes first).
  function slotCount() { return (S.slots && S.slots.count) || 1; }
  function slotFree() { return S.orders.length - waitingOf(S.orders).length < slotCount() && !waitingOf(S.orders).length; }
  function slotUnlocked(r, s) { var cap = S.hub.rings[r]; return !!cap && s < cap; }
  function neighborsOf(r, s) { return GEO().neighbors[r + ':' + s] || []; }
  function neighborTypes(r, s) {
    return neighborsOf(r, s).map(function (n) { var b = buildingAt(n[0], n[1]); return b && b.type; }).filter(Boolean);
  }
  function previewMult(type, r, s) {
    var m = 1, parts = [], nt = neighborTypes(r, s);
    CFG.adjacencyRules.forEach(function (rule) {
      if (rule.targetBuilding !== type) return;
      nt.forEach(function (t) { if (t === rule.adjacentBuilding) { m *= rule.outputMultiplier; parts.push({ type: t, mult: rule.outputMultiplier }); } });
    });
    return { mult: clamp(m, 0.5, 1.6), parts: parts };
  }
  // While the simulation is paused, time on screen stands still: countdowns hold where they were and nothing moves between ticks.
  function nowT() { return S && S.paused ? S.serverNow : Date.now() + offset; }
  function frac() {
    if (!S || S.paused) return 0;
    return clamp(1 - (S.nextTickAt - nowT()) / S.tickMs, 0, 1);
  }
  function canAfford(cost) {
    return Object.keys(cost).every(function (r) { return S.resources[r].amount >= cost[r]; });
  }
  function canAffordCore(cost) {
    return Object.keys(cost).every(function (r) { return S.coreRes[r].amount >= cost[r]; });
  }
  function pill(res, amt, cls) {
    var r = CFG.resources[res] || { name: res, color: '#ffd23f' };
    if (res === 'energy') r = { name: 'Power', color: 'var(--energy)' };
    return '<span class="pill ' + (cls || '') + '" style="--c:' + r.color + '"><i></i>' + esc(typeof amt === 'number' ? fmtAmt(amt) : amt) + ' ' + esc(r.name) + '</span>';
  }
  function fmtAmt(n) { return Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1); }
  function ioPills(def, eff, mult) {
    var h = '';
    Object.keys(def.inputsPerTick).forEach(function (r) { h += pill(r, def.inputsPerTick[r] * eff, 'in'); });
    Object.keys(def.outputsPerTick).forEach(function (r) { h += pill(r, def.outputsPerTick[r] * eff * mult, 'out'); });
    return h;
  }

  // ------------------------------------------------------------------ radar construction
  function buildRadar() {
    var svg = $('radar');
    svg.innerHTML = ''; slotEls = {}; ringLabels = {};
    var RINGS = GEO().rings;
    var defs = svgEl('defs', {}, svg);
    var grad = svgEl('radialGradient', { id: 'sweepfade', cx: '0', cy: '0', r: '1', gradientUnits: 'objectBoundingBox' }, defs);
    svgEl('stop', { offset: '0', 'stop-color': '#ff9f1c', 'stop-opacity': '0' }, grad);
    var maxR = 0;
    Object.keys(RINGS).forEach(function (r) { maxR = Math.max(maxR, ringOuter(+r)); });
    var bg = svgEl('g', {}, svg);
    // faint concentric guides + bearing ticks
    [HUB_R + 10].concat(Object.keys(RINGS).map(function (r) { return ringOuter(+r) + 3; })).forEach(function (r) {
      svgEl('circle', { cx: 0, cy: 0, r: r, 'class': 'ring-line' }, bg);
    });
    for (var d = 0; d < 360; d += 10) {
      var a = d * Math.PI / 180, len = d % 30 === 0 ? 9 : 4, ro = maxR + 14;
      var p0 = polar(ro, a), p1 = polar(ro + len, a);
      svgEl('line', { x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1], 'class': 'ring-tick' }, bg);
    }
    // radar sweep
    var sw = svgEl('g', { 'class': 'sweep', 'pointer-events': 'none' }, svg);
    var R = maxR + 14, a1 = -50 * Math.PI / 180;
    svgEl('path', { d: 'M0 0 L' + R + ' 0 A' + R + ' ' + R + ' 0 0 0 ' + (R * Math.cos(a1)).toFixed(1) + ' ' + (R * Math.sin(a1)).toFixed(1) + ' Z', fill: 'rgba(255,159,28,.05)' }, sw);
    svgEl('line', { x1: 0, y1: 0, x2: R, y2: 0, stroke: 'rgba(255,159,28,.35)', 'stroke-width': 1 }, sw);

    // slots
    var slotsG = svgEl('g', {}, svg);
    Object.keys(RINGS).forEach(function (rs) {
      var ring = +rs, cap = RINGS[rs];
      for (var i = 0; i < cap; i++) {
        var g = svgEl('g', { 'class': 'slot empty', tabindex: 0, role: 'button', 'data-slot': ring + ':' + i }, slotsG);
        var title = svgEl('title', {}, g);
        var cell = svgEl('path', { d: sectorPath(ring, i, cap), 'class': 'cell' }, g);
        var c = slotCenter(ring, i, cap);
        var inner = svgEl('g', { transform: 'translate(' + c[0].toFixed(1) + ' ' + c[1].toFixed(1) + ')', 'pointer-events': 'none' }, g);
        var isz = 22 + ring * 2;  // icons grow with the plot
        var plus = svgEl('path', { d: 'M-6 0H6M0 -6V6', 'class': 'plus' }, inner);
        var ico = svgEl('svg', { x: -isz / 2, y: -isz / 2, width: isz, height: isz, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'class': 'ico' }, inner);
        var tag = svgEl('text', { x: 0, y: isz / 2 + 9, 'class': 'tag' }, inner);
        var pbg = svgEl('rect', { x: -16, y: isz / 2 + 4, width: 32, height: 3, rx: 1.5, 'class': 'pbar-bg' }, inner);
        var pb = svgEl('rect', { x: -16, y: isz / 2 + 4, width: 0, height: 3, rx: 1.5, 'class': 'pbar' }, inner);
        // hazard marker: red '!' = being hurt, amber ring = paying upkeep, dashed ring = in the forecast's path
        var badge = svgEl('g', { 'class': 'badge', transform: 'translate(' + (isz / 2 + 1) + ' ' + (-isz / 2 - 2) + ')' }, inner);
        svgEl('circle', { r: 6 }, badge);
        svgEl('text', { y: 3 }, badge).textContent = '!';
        (function (ring, i) {
          g.addEventListener('click', function () { onSlot(ring, i); });
          g.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSlot(ring, i); } });
        })(ring, i);
        slotEls[ring + ':' + i] = { g: g, title: title, ico: ico, tag: tag, plus: plus, pbg: pbg, pb: pb, isz: isz, sig: '' };
      }
    });

    Object.keys(RINGS).forEach(function (rs) {
      var lab = svgEl('text', { x: 0, y: -(ringInner(+rs) + ringW(+rs) / 2) + 3, 'class': 'ring-label' }, svg);
      ringLabels[rs] = lab;
    });

    // hub
    var hub = svgEl('g', { 'class': 'hub-core', tabindex: 0, role: 'button' }, svg);
    svgEl('title', {}, hub).textContent = activeD().core ? 'Hub: open upgrade panel' : 'District core: open its panel';
    svgEl('circle', { cx: 0, cy: 0, r: HUB_R, 'class': 'hub-pulse' }, hub);
    svgEl('circle', { cx: 0, cy: 0, r: HUB_R, 'class': 'disc' }, hub);
    svgEl('circle', { cx: 0, cy: 0, r: HUB_R - 7, fill: 'none', stroke: 'rgba(255,159,28,.25)', 'stroke-dasharray': '2 5' }, hub);
    var t1 = svgEl('text', { x: 0, y: -3, 'font-size': activeD().core ? 15 : 12, 'class': 'no-terms' }, hub); t1.textContent = activeD().core ? ((CFG.ui && CFG.ui.hubLabel) || 'HUB') : activeD().name.replace(/^The /, '').toUpperCase();
    var t2 = svgEl('text', { x: 0, y: 15, 'font-size': 10, 'letter-spacing': '.12em' }, hub);
    hub.addEventListener('click', function () { if (Date.now() - dragEndAt < 300) return; sel = { hub: true }; replaceAt = null; go('hub'); });
    hub.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hub.dispatchEvent(new Event('click')); } });
    hubEl = { g: hub, sub: t2 };
    svg.onclick = function (e) { if (e.target === svg && Date.now() - dragEndAt > 300) { sel = null; renderAll(); } };
  }

  function onSlot(ring, slot) {
    if (Date.now() - dragEndAt < 300) return; // the end of a drag or a pinch, not a tap
    document.body.classList.remove('panel-full');
    replaceAt = null;
    if (!slotUnlocked(ring, slot)) { sel = { ring: ring, slot: slot }; ws = null; renderAll(); return; }
    sel = { ring: ring, slot: slot };
    ws = null;
    confirmKey = null;
    renderAll();
    focusSlot(ring, slot);
    var pn = $('panel'); if (pn && MOBILE) pn.scrollTop = 0;
  }

  // ------------------------------------------------------------------ radar update
  function renderRadar() {
    var nb = {};
    if (sel && sel.ring) neighborsOf(sel.ring, sel.slot).forEach(function (n) { nb[n[0] + ':' + n[1]] = 1; });
    Object.keys(slotEls).forEach(function (k) {
      var el = slotEls[k], p = k.split(':'), r = +p[0], s = +p[1];
      var unlocked = slotUnlocked(r, s);
      var b = unlocked && buildingAt(r, s), o = unlocked && !b && orderAt(r, s), q = unlocked && !b && !o && queuedBuild(r, s);
      var cls = 'slot', name = 'Ring ' + r + ' · Slot ' + (s + 1) + ' · ' + plotName(r) + ' plot';
      var c = null, icoName = null, tag = '';
      if (!unlocked) { cls += ' locked'; name += ' (locked)'; }
      else if (b) {
        var def = CFG.buildings[b.type]; c = def.color; icoName = b.type;
        cls += ' built' + (b.paused ? ' paused' : '');
        if (!b.paused && b.status && b.status !== 'running' && b.status !== 'standby') cls += (b.eff < 0.01 ? ' stalled' : ' low');
        if (b.plot < 0.999) cls += ' cramped';
        tag = b.paused ? 'OFF' : b.status === 'no_recipe' ? 'SET?' : b.status === 'resetting' ? 'RESET' : b.status === 'damaged' ? 'DOWN' : b.status === 'standby' ? '' : (b.eff < 0.995 ? pct(b.eff) : (b.plot < 0.999 ? '×' + b.plot.toFixed(2) : ''));
        name = def.name + ' (' + name + ')' + (b.plot < 0.999 ? ' · cramped plot' : '');
        if (b.mark) { cls += ' hz-' + b.mark; name += ' · ' + MARK_TXT[b.mark]; }
        if (!tag && b.level > 1) tag = '▲' + b.level;
        if (!tag && def.housing && b.comfort) { tag = (b.comfort > 0 ? '+' : '−') + Math.abs(b.comfort); cls += b.comfort > 0 ? ' cmf-good' : ' cmf-bad'; }
        var sw = orderAt(r, s);
        if (sw) { cls += ' swap'; tag = 'SWAP'; name += ' · queued to be replaced by ' + CFG.buildings[sw.data.type].name; }
      } else if (q) {
        cls += ' queued'; c = CFG.buildings[q.body.type].color; icoName = q.body.type; tag = 'QUEUED';
        name = 'Queued while offline: ' + CFG.buildings[q.body.type].name;
      } else if (o && o.state === 'queued') {
        cls += ' planned'; c = CFG.buildings[o.data.type].color; icoName = o.data.type; tag = '#' + o.pos;
        name = 'In the work queue (number ' + o.pos + '): ' + CFG.buildings[o.data.type].name;
      } else if (o) {
        cls += ' building'; c = CFG.buildings[o.data.type].color; icoName = o.data.type;
        name = (o.kind === 'replace' ? 'Converting to ' : 'Building ') + CFG.buildings[o.data.type].name;
      } else if (lockAt(r, s)) {
        cls += ' clearing'; icoName = 'lock'; tag = 'CLEAR ' + lockAt(r, s).ticksLeft + 't';
        name += ' · being cleared: ' + lockAt(r, s).ticksLeft + ' ticks';
      } else cls += ' empty';
      if (sel && sel.ring === r && sel.slot === s) cls += ' sel';
      if (nb[k]) cls += ' nb';
      var sig = cls + '|' + icoName + '|' + tag + '|' + name;
      if (sig === el.sig) return;
      el.sig = sig;
      el.g.setAttribute('class', cls);
      el.g.setAttribute('aria-label', name);
      el.title.textContent = name;
      el.g.style.setProperty('--c', c || '');
      el.ico.innerHTML = icoName ? (icoName === 'lock' ? '<g opacity=".35">' + ICONS.lock + '</g>' : ICONS[icoName]) : '';
      el.tag.textContent = tag;
      el.plus.style.display = (!b && !o && !q && unlocked && !lockAt(r, s)) ? '' : 'none';
      var under = o && o.state !== 'queued';
      el.pbg.style.display = under ? '' : 'none';
      el.pb.style.display = under ? '' : 'none';
      el.ico.setAttribute('y', o || tag ? -el.isz / 2 - 4 : -el.isz / 2);
    });
    Object.keys(ringLabels).forEach(function (r) {
      var open = !!S.hub.rings[r];
      ringLabels[r].textContent = open ? plotName(r).toUpperCase() + ' PLOTS' : 'RING ' + r + ' · ' + plotName(r).toUpperCase() + ' PLOTS · LOCKED · ' + (activeD().type === 'station' ? 'LAUNCHED FROM THE COLONY' : (activeD().core ? 'HUB' : 'DISTRICT') + ' LV ' + r);
      ringLabels[r].setAttribute('class', 'ring-label' + (open ? ' open' : ''));
    });
    targetR = zoomTarget();
    if (!viewR) { viewR = goalR = targetR; viewC = [0, 0]; goalC = [0, 0]; userView = false; autoFocus = false; setView(viewR); renderZoom(); }
    if (autoFocus && !(sel && sel.ring)) fitView();
    hubEl.g.classList.toggle('sel', !!(sel && sel.hub));
    var upo = S.orders.filter(function (x) { return x.kind === 'upgrade'; })[0];
    hubEl.sub.textContent = upo ? (upo.state === 'queued' ? 'UPGRADE QUEUED' : 'UPGRADING') : 'LEVEL ' + activeD().level;
  }

  // construction progress bars on the map update every frame
  function frameRadar(f) {
    S.orders.forEach(function (o) {
      if ((o.kind !== 'build' && o.kind !== 'replace') || o.state === 'queued') return;
      var el = slotEls[o.data.ring + ':' + o.data.slot];
      if (el) el.pb.setAttribute('width', (32 * clamp((o.total - o.remaining + f) / o.total, 0, 1)).toFixed(1));
    });
  }

  // ------------------------------------------------------------------ top bar & resources
  // The vitals are a row of chips: the colony's own first, then whatever matters about the place being looked at. Each chip is
  // described as data and patched in place, so a chip under the pointer is never swapped out mid-click.
  function lab(k, dflt) { var l = CFG.ui && CFG.ui.labels && CFG.ui.labels[k]; return esc(l || dflt); }
  function short(n) { return n >= 1e7 ? Math.floor(n / 1e6) + 'M' : n >= 1e6 ? (Math.floor(n / 1e5) / 10) + 'M' : n >= 1e5 ? Math.floor(n / 1e3) + 'k' : n >= 1e4 ? (Math.floor(n / 100) / 10) + 'k' : fmt(n); }
  function convoyHtml() { return clock(S.convoy.arrivesAt - nowT()) + (MOBILE ? '' : ' <small>' + S.convoy.ticksLeft + 't</small>'); }
  function powerChip(label) {
    var e = S.energy, ok = e.satisfaction >= 0.999;
    return { k: 'power', icon: 'bolt', place: true, label: label, cls: ok ? '' : e.satisfaction > 0.5 ? 'warn' : 'bad',
      title: 'Supply ' + Math.floor(e.supply) + ', demand ' + Math.ceil(e.demand) + (e.buffered > 0.5 ? ' · ' + Math.round(e.buffered) + ' of the supply is standby power, burning its reserve' : '') + (ok ? '' : ' · production at ' + pct(e.satisfaction)),
      html: '<span class="' + (ok ? '' : 'bad') + '">' + Math.floor(e.supply) + '</span><small>/ ' + Math.ceil(e.demand) + (MOBILE ? '' : ' used') + '</small>',
      meter: [e.demand ? clamp(e.supply / e.demand, 0, 1) * 100 : 100, ok ? 'var(--energy)' : e.satisfaction > 0.5 ? 'var(--warn)' : 'var(--bad)'] };
  }
  function plainChip(k, ico, label, html, cls, tab, title, id) { return { k: k, icon: ico, place: true, label: label, html: html, cls: cls || '', tab: tab || '', title: title || '', id: id || '' }; }
  // What the top bar says about the place being looked at (the colony's vitals are always the same).
  function placeChips(d, O) {
    if (!d.orbital) return [powerChip(lab('energy', 'Power')), plainChip('convoy', 'truck', lab('convoy', 'Next convoy'), convoyHtml(), '', 'convoy', 'The next scheduled convoy', 'c-convoy')];
    if (d.type === 'station' && O && O.station) {
      var st = O.station, used = st.storage.slots.filter(function (x) { return x.resource; }).length, x = S.express;
      var out = [powerChip('Station power'), plainChip('ostore', 'box', 'Storage', used + ' <small>/ ' + st.storage.slots.length + (MOBILE ? '' : ' slots') + '</small>', used >= st.storage.slots.length ? 'warn' : '', 'ostore', 'Orbital storage slots in use'),
        plainChip('express', 'truck', 'Express slot', x.active ? 'In flight' : x.readyIn > 0 ? '<span class="dim">' + x.readyIn + 't</span>' : '<span class="good">Ready</span>', '', 'ostore', 'The express convoy: ' + (x.active ? 'in flight' : x.readyIn > 0 ? 'cooling down' : 'ready to dispatch'))];
      var p = O.project;
      if (p && p.status !== 'done' && p.status !== 'failed') out.push(plainChip('project', 'globe', 'Project', (p.status === 'announced' ? (MOBILE ? 'in ' : 'opens ') + p.startsIn + 't' : p.status === 'active' ? (MOBILE ? '' : 'ends ') + p.endsIn + 't' : (MOBILE ? '+' : 'bonus ') + p.bonusLeft + 't'), p.status === 'active' && p.endsIn <= 20 ? 'warn' : '', 'oproject', p.name));
      return out;
    }
    var sh = O && O.ships.ships.filter(function (z) { return z.districtId === d.id; })[0], t = sh && sh.territory;
    var o2 = [powerChip('Ship power')];
    if (sh) {
      o2.push(plainChip('hold', 'box', 'Hold', fmt(sh.hold), '', '', 'Cargo the dropship can carry home'));
      if (t) o2.push(plainChip('closes', 'hourglass', 'Closes in', t.ticksLeft + 't' + (MOBILE ? '' : ' <small>' + clock(t.ticksLeft * S.tickMs) + '</small>'), t.ticksLeft <= 6 ? 'bad' : t.ticksLeft <= 15 ? 'warn' : '', '', t.anomaly.name + ' closes in ' + t.ticksLeft + ' ticks'));
      o2.push(plainChip('hull', 'ship', 'Hull', sh.integrity + '<small>%</small>', sh.integrity < 35 ? 'bad' : sh.integrity < 60 ? 'warn' : '', '', 'Dropship integrity'));
    }
    if (t && t.dataSite) {
      var rig = (S.buildings || []).filter(function (b) { return b.type === 't_data'; })[0];
      o2.push(plainChip('datasite', 't_data', 'Data site', rig ? Math.floor(rig.dataProgress || 0) + ' <small>/ ' + S.data.attemptTicks + 't</small>' : '<span class="dim">no rig</span>', '', S.data.unlocked ? 'data' : '', rig ? 'A recovery attempt in progress' : 'Build Data Recovery here'));
    }
    return o2;
  }
  function colonyChips() {
    var c = S.colony, out = [];
    out.push({ k: 'credits', icon: 'coin', label: lab('credits', 'Credits'), html: MOBILE ? short(c.credits) : fmt(c.credits) + ' <small>cr</small>', title: fmt(c.credits) + ' credits' });
    var crew = c.staffing.ratio < 0.999;
    out.push({ k: 'pop', icon: 'users', label: lab('population', 'People'), tab: 'people', cls: crew ? 'warn' : '',
      html: c.population + ' <small>/' + (MOBILE ? '' : ' ') + c.maxPopulation + '</small>' + (crew && !MOBILE ? ' <small class="warn">crew ' + pct(c.staffing.ratio) + '</small>' : ''),
      title: 'Housing: hub quarters ' + c.housing.base + (c.housing.built ? ' + homes ' + Math.floor(c.housing.built) : '') + ' · ' + Math.floor(c.staffing.workforce) + ' hands for ' + c.staffing.posts + ' posts' });
    var m = clamp(c.morale, 0, 100), mcls = m > 60 ? '' : m > 30 ? 'warn' : 'bad';
    out.push({ k: 'morale', icon: 'heart', label: lab('morale', 'Morale'), tab: 'people', cls: mcls, html: Math.round(m) + '<small>%</small>',
      title: 'Target ' + Math.round(c.moraleInfo.target) + ' (base ' + c.moraleInfo.base + ', homes ' + (c.moraleInfo.comfort >= 0 ? '+' : '') + c.moraleInfo.comfort.toFixed(1) + ', meals +' + c.moraleInfo.meals.toFixed(0) + ') · output ×' + c.moraleInfo.productivity.toFixed(2),
      meter: [m, m > 60 ? 'var(--good)' : m > 30 ? 'var(--warn)' : 'var(--bad)'] });
    var d = S.doom, doom = { k: 'doom', icon: 'hourglass', label: lab('doom', 'Collapse in'), tab: 'brief', cls: '' };
    if (d && d.phase === 'shutdown') { doom.html = '<span class="warn">Shut down</span>'; doom.title = 'The colony is shut down. Non-essential buildings are parked until you restart them.'; doom.cls = 'warn'; }
    else if (!d) { doom.html = '<span class="good">Stable</span>'; doom.title = 'No critical supply is draining at current rates.'; }
    else {
      var urgent = d.phase === 'starving' || d.ticks <= 20;
      doom.cls = urgent ? 'bad' : d.ticks <= 40 ? 'warn' : '';
      doom.html = '<span class="' + doom.cls + '">' + d.ticks + 't</span>' + (MOBILE ? '' : '<small>' + clock(d.ticks * S.tickMs) + '</small>');
      doom.title = d.phase === 'starving' ? 'Collapse in ' + d.ticks + ' ticks unless supplies are restored.'
        : 'If nothing changes, ' + d.resources.map(function (r) { return CFG.resources[r].name; }).join(' & ') + ' runs short in ' + d.untilShortage + ' ticks and the colony collapses ' + d.ticks + ' ticks from now.';
    }
    out.push(doom);
    var hz = S.hazard, haz = { k: 'hazard', icon: 'warn', label: 'Hazard in', tab: 'brief', cls: '', meter: [0, 'var(--good)'] };
    if (!hz) { haz.html = '<span class="dim">Clear</span>'; haz.title = 'No hazard is forecast.'; }
    else if (hz.state === 'forecast') {
      haz.cls = hz.prep < 0.5 && hz.ticksUntil <= 12 ? 'bad' : hz.prep < 0.8 ? 'warn' : '';
      haz.html = '<span class="' + haz.cls + '">' + hz.ticksUntil + 't</span><small>' + pct(hz.prep) + (MOBILE ? '' : ' ready') + '</small>';
      haz.title = hz.name + ' strikes in ' + hz.ticksUntil + ' ticks (' + clock(hz.ticksUntil * S.tickMs) + '). The bar is how prepared the colony is.';
      haz.meter[0] = hz.prep * 100;
    } else {
      haz.cls = hz.severity > 0.02 ? 'bad' : 'warn';
      haz.html = '<span class="' + haz.cls + '">Active</span><small>' + hz.ticksLeft + 't' + (MOBILE ? '' : ' left') + '</small>';
      haz.title = hz.name + (hz.severity > 0.02 ? ' is in effect.' : ' is being weathered.') + ' The bar is how well the colony is holding.';
      haz.meter[0] = clamp(1 - hz.severity, 0, 1) * 100;
    }
    haz.meter[1] = haz.cls === 'bad' ? 'var(--bad)' : haz.cls === 'warn' ? 'var(--warn)' : 'var(--good)';
    out.push(haz);
    return out;
  }
  function chipCls(o) { return 'chip' + (o.place ? ' place' : '') + (o.cls ? ' ' + o.cls : '') + (o.tab ? ' click' : ''); }
  function chipHtml(o) {
    if (o.sep) return '<div class="vsep" data-k="sep" aria-hidden="true"></div>';
    return '<div class="' + chipCls(o) + '" data-k="' + o.k + '"' + (o.tab ? ' data-act="tab" data-tab="' + o.tab + '" role="button" tabindex="0"' : '') + '><span class="label">' + icon(o.icon, 12) + '<span>' + o.label + '</span></span>' +
      '<span class="v num"' + (o.id ? ' id="' + o.id + '"' : '') + '></span>' + (o.meter ? '<div class="meter"><i></i></div>' : '') + '</div>';
  }
  function renderChips(el, chips) {
    var sig = chips.map(function (c) { return c.sep ? 'sep' : c.k + ':' + (c.tab || '') + ':' + c.label; }).join('|');
    if (el.dataset.sig !== sig) { el.innerHTML = chips.map(chipHtml).join(''); el.dataset.sig = sig; }
    chips.forEach(function (c, i) {
      var n = el.children[i]; if (!n || c.sep) return;
      var cls = chipCls(c); if (n.className !== cls) n.className = cls;
      var tt = window.Terms ? window.Terms.rewrite(c.title || '') : (c.title || ''); if (n.title !== tt) n.title = tt;
      var v = n.querySelector('.v'); if (v.dataset.h !== c.html) { v.innerHTML = c.html; v.dataset.h = c.html; }
      if (c.meter) { var b = n.querySelector('.meter i'); b.style.width = c.meter[0] + '%'; b.style.background = c.meter[1]; }
    });
  }
  function newEvents() { return S.events.filter(function (e) { return e.id > bellSeen && e.kind !== 'info'; }); }
  function renderTop() {
    var chips = colonyChips();
    // on a phone the two groups sit on two rows: the colony's five, then the place's
    if (MOBILE) renderChips($('vitals'), chips.concat(placeChips(activeD(), S.orbital)));
    else renderChips($('vitals'), chips.concat([{ sep: true }], placeChips(activeD(), S.orbital)));
    var cnt = window.Story.counts(), nb = cnt.calls + newEvents().length;
    $('bell-n').textContent = nb; $('bell-n').hidden = !nb;
    $('bell-btn').classList.toggle('ring', cnt.calls > 0);
    $('mail-n').textContent = cnt.mail; $('mail-n').hidden = !cnt.mail;
    if ($('c-user')) $('c-user').textContent = S.user;
  }

  // ------------------------------------------------------------------ stockpile
  // How each resource is doing, in a few words (also what the overview calls out).
  function stockNote(k) {
    var r = S.resources[k], txt = '', cls = '';
    if (r.ticksLeft !== null && r.ticksLeft < 40) { txt = r.amount < 0.5 ? 'EMPTY' : 'empty in ' + Math.ceil(r.ticksLeft) + 't'; cls = r.ticksLeft < 15 ? 'bad' : 'warn'; }
    else if (r.amount >= r.cap - 0.5 && r.net > 0) { txt = 'FULL · wasting'; cls = 'warn'; }
    else txt = 'cap ' + fmt(r.cap);
    if (cls === '' && (r.routeIn || r.routeOut)) { txt = (r.routeIn ? '↘ +' + fmt(r.routeIn) + ' routed in' : '') + (r.routeIn && r.routeOut ? ' · ' : '') + (r.routeOut ? '↗ −' + fmt(r.routeOut) + ' routed out' : ''); cls = 'dim'; }
    return [txt, cls];
  }
  function stockKeys() {
    return Object.keys(CFG.resources).filter(function (k) {
      var r = S.resources[k], def = CFG.resources[k];
      return r && !(def.showFromHub && def.showFromHub > S.colony.hubLevel && r.amount < 0.5 && r.produced <= 0 && r.consumed <= 0);
    });
  }
  function pinKeys() {
    var ok = stockKeys();
    if (pins !== null) return pins.filter(function (k) { return ok.indexOf(k) >= 0; });
    var a = ok.filter(function (k) { return CFG.resources[k].critical || stockAttention().indexOf(k) >= 0; });
    if (a.length < 4) ok.forEach(function (k) { if (a.length < 5 && a.indexOf(k) < 0 && S.resources[k].amount >= 1) a.push(k); });
    return a.slice(0, 8);
  }
  function togglePin(k) {
    var cur = pinKeys().slice(), i = cur.indexOf(k);
    if (i >= 0) cur.splice(i, 1); else if (cur.length < 10) cur.push(k); else { toast('Ten pinned is the limit. Unpin one first.'); return; }
    pins = cur; storeSet('pins:' + S.user, cur.join(',')); renderAll();
  }
  function stockAttention() { return stockKeys().filter(function (k) { var c = stockNote(k)[1]; return c === 'bad' || c === 'warn'; }); }
  function stockRow(k, full) {
    var r = S.resources[k], def = CFG.resources[k], n = stockNote(k);
    var amt = '<span data-sr-amt>' + fmt(r.amount) + '</span>';
    var net = '<span class="num ' + (r.net > 0.05 ? 'good' : r.net < -0.05 ? 'bad' : '') + '">' + rate(r.net) + '/t</span>';
    var pinned = pinKeys().indexOf(k) >= 0;
    if (!full) return '<div class="pn-pin' + (def.critical && r.amount < 0.5 && r.net < 0 ? ' bad' : '') + '" data-sr="' + k + '"><span><i class="dot" style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:7px;background:' + def.color + '"></i>' + esc(def.name) + '</span><span class="num"><b>' + amt + '</b> ' + net + (n[1] === 'bad' || n[1] === 'warn' ? ' <small class="' + n[1] + '">' + n[0] + '</small>' : '') + ' <button class="pn-x" data-act="pin" data-res="' + k + '" title="Unpin" aria-label="Unpin ' + esc(def.name) + '">&times;</button></span></div>';
    return '<tr data-sr="' + k + '" class="' + (def.critical && r.amount < 0.5 && r.net < 0 ? 'crit' : '') + '" title="Tier ' + def.tier + '"><td><i class="dot" style="background:' + def.color + '"></i>' + esc(def.name) + '<span class="tier">T' + def.tier + '</span></td>' +
      '<td class="num"><b>' + amt + '</b></td><td>' + net + '</td><td><span class="fillbar"><i data-sr-bar style="width:' + (r.amount / r.cap * 100).toFixed(1) + '%;background:' + def.color + '"></i></span></td><td class="' + n[1] + '" style="text-align:left">' + esc(n[0]) + '</td><td><button class="pinbtn' + (pinned ? ' on' : '') + '" data-act="pin" data-res="' + k + '" aria-pressed="' + pinned + '" title="' + (pinned ? 'Unpin from the overview' : 'Pin to the overview') + '">' + (pinned ? '★' : '☆') + '</button></td></tr>';
  }
  // The stock bar (desk shell): the pinned stock of the place being looked at, in view whatever else is open.
  function barKeys() {
    if (!activeD().orbital) return pinKeys();
    return Object.keys(S.resources).filter(function (k) { return CFG.resources[k] && S.resources[k].amount >= 0.5; })
      .sort(function (a, b) { return S.resources[b].amount - S.resources[a].amount; }).slice(0, 10);
  }
  function renderStockbar() {
    var el = $('stockbar'); if (!el) return;
    var d = activeD(), to = d.orbital ? (d.type === 'station' ? 'ostore' : '') : 'stockpile', keys = barKeys();
    var h = '<span class="label">' + esc(d.core ? 'Core' : d.type === 'station' ? 'Station' : d.name.replace(/^The /, '')) + ' stock</span>' + keys.map(function (k) {
      var r = S.resources[k], def = CFG.resources[k], n = d.orbital ? ['', ''] : stockNote(k), flag = n[1] === 'bad' || n[1] === 'warn';
      return '<button class="sb' + (flag ? ' ' + n[1] : '') + '" data-sr="' + k + '"' + (to ? ' data-act="tab" data-tab="' + to + '"' : ' disabled') + ' title="' + esc(def.name + (flag ? ' · ' + n[0] : '') + ' · ' + rate(r.net) + ' per tick') + '"><i style="background:' + def.color + '"></i>' +
        '<span class="nm">' + esc(def.name) + '</span><b class="num" data-sr-amt>' + fmt(r.amount) + '</b><span class="num net ' + (r.net > 0.05 ? 'good' : r.net < -0.05 ? 'bad' : 'dim') + '">' + rate(r.net) + '</span></button>';
    }).join('') + (keys.length ? '' : '<span class="dim">' + (d.orbital ? 'Nothing held here yet.' : 'Nothing pinned.') + '</span>') +
      (d.orbital ? '' : '<button class="linkbtn" data-act="tab" data-tab="stockpile" title="Choose which stock is pinned here">' + (pins === null ? 'Choose' : 'Edit') + '</button>');
    if (el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; }
  }
  // Switch district without leaving the workspace (the place tabs' 'enter' closes it).
  function stockSwitch() {
    var ground = S.districts.filter(function (d) { return !d.orbital; });
    if (ground.length < 2) return '';
    return '<div class="sd-tabs" role="tablist" aria-label="District">' + ground.map(function (d) {
      var t = d.core ? null : CFG.districtTypes[d.type];
      return '<button class="sd-tab" role="tab" data-act="sdist" data-id="' + d.id + '" aria-selected="' + (d.id === activeId) + '" style="--c:' + (t ? t.color : 'var(--amber)') + '"><i></i>' + esc(d.core ? 'Core' : d.name.replace(/^The /, '')) + '<small>L' + d.level + '</small></button>';
    }).join('') + '</div>';
  }
  function stockpileTab() {
    var keys = stockKeys();
    return '<div class="wide">' + stockSwitch() + '<div class="p-title"><h3>Stockpile</h3><span class="dim" style="margin-left:auto">' + esc(activeD().core ? 'The colony' : activeD().name) + ' · ' + keys.length + ' kinds</span></div>' +
      '<table class="stock"><thead><tr><th>Resource</th><th>On hand</th><th>Net</th><th>Fill</th><th style="text-align:left">Status</th><th>Pin</th></tr></thead><tbody>' + keys.map(function (k) { return stockRow(k, true); }).join('') + '</tbody></table></div>';
  }
  // ---- data: fragments recovered from data sites, spent on lore packets
  function rigsList() {
    var out = [];
    S.districts.filter(function (d) { return d.type === 'territory'; }).forEach(function (d) {
      var v = S.views[d.id];
      (v ? v.buildings : []).filter(function (b) { return b.type === 't_data'; }).forEach(function (b) { out.push({ district: d, b: b }); });
    });
    return out;
  }
  function rigBlock(b) {
    if (b.type !== 't_data') return '';
    var D = S.data;
    return '<div class="label sec">Recovery</div><dl class="kv"><dt>This attempt</dt><dd>' + Math.floor(b.dataProgress || 0) + ' / ' + D.attemptTicks + ' ticks</dd>' +
      '<dt>Toward a fragment</dt><dd>' + D.successes + ' / ' + D.perFragment + ' successful attempts</dd></dl>' +
      '<div class="dim" style="font-size:11px">~' + Math.round(D.successChance * 100) + '% success · low power slows it</div>';
  }
  function dataTab() {
    var D = S.data, rigs = rigsList();
    var h = '<div class="p-title"><h3>Data</h3><span class="dim" style="margin-left:auto">' + D.total + ' fragment' + (D.total === 1 ? '' : 's') + ' recovered in all</span></div>' +
      '<div class="data-bal"><div><span class="label">Fragments</span><b class="num">' + D.fragments + '</b></div><div class="grow"><span class="label">Next fragment</span><div class="meter wide"><i style="width:' + (D.successes / D.perFragment * 100).toFixed(0) + '%;background:var(--cyan)"></i></div>' +
      '<small class="dim">' + D.successes + ' of ' + D.perFragment + ' successes · ' + D.attemptTicks + ' t per attempt</small></div></div>';
    if (window.Mini) h += window.Mini.section();
    h += '<div class="sheet-h">Recovery rigs</div>';
    h += rigs.length ? rigs.map(function (x) {
      var st = STATUS[x.b.status] || STATUS.running;
      return '<div class="ov-row"><div class="grow"><b>' + esc(x.district.name) + '</b><div class="dim" style="font-size:12px">Attempt ' + Math.floor(x.b.dataProgress || 0) + ' / ' + D.attemptTicks + ' ticks · <span class="' + st[1] + '">' + st[0] + '</span></div></div><div class="meter" style="width:120px"><i style="width:' + ((x.b.dataProgress || 0) / D.attemptTicks * 100).toFixed(0) + '%;background:var(--cyan)"></i></div></div>';
    }).join('') : '<div class="dim" style="font-size:12px">No rig is working. Build Data Recovery in a territory that has a data site.</div>';
    h += '<div class="sheet-h">Data packets</div>';
    var biggest = Math.max.apply(null, D.packets.map(function (p) { return p.level ? 0 : p.next.fragments; }).concat([1]));
    var st = RAW.orbital && RAW.orbital.station, sv = st && S.views[st.districtId];
    var stock = function (r) { return { amount: sv && sv.resources[r] ? sv.resources[r].amount : 0 }; };
    h += D.packets.map(function (p) {
      var n = p.next, can = !!n && D.fragments >= n.fragments && Object.keys(n.goods || {}).every(function (r) { return stock(r).amount >= n.goods[r]; });
      var cost = n ? '<span class="num">' + n.fragments + ' fragment' + (n.fragments === 1 ? '' : 's') + '</span>' + (n.goods ? '<span class="io" style="display:inline-flex;margin-left:6px">' + Object.keys(n.goods).map(function (r) { return pill(r, n.goods[r], stock(r).amount < n.goods[r] ? 'no' : ''); }).join('') + '</span>' : '') : '';
      var btn = n ? '<button class="btn' + (can ? ' primary' : '') + '" data-act="dataunlock" data-packet="' + esc(p.id) + '"' + (can ? '' : ' disabled') + '>' + (p.level ? 'Read on' : 'Unlock') + '</button>' : '';
      if (!p.level) return '<div class="packet sealed"><div class="top"><b>' + icon('lock', 14) + ' Sealed packet</b><span class="dim">' + cost + '</span></div>' +
        '<div class="psize" title="Size, from the cost"><i style="width:' + Math.round(n.fragments / biggest * 100) + '%"></i></div>' + btn + '</div>';
      return '<div class="packet open"><div class="top"><b>' + esc(p.name) + '</b>' + (p.of > 1 ? '<span class="dim">Part ' + p.level + ' of ' + p.of + '</span>' : '<span class="good">Unlocked</span>') + '</div>' +
        p.texts.map(function (t, i) { return '<div class="ptext">' + (p.of > 1 ? '<div class="label">Part ' + (i + 1) + '</div>' : '') + (t ? esc(t).split(/\n+/).map(function (x) { return '<p>' + x + '</p>'; }).join('') : '') +
          (p.scenes[i] ? '<button class="btn primary" data-story="scene" data-beat="' + esc(p.scenes[i]) + '" style="margin-top:6px">' + icon('play', 12) + ' Play</button>' : '') + '</div>'; }).join('') +
        (n ? '<div class="pmore"><div class="grow"><b>More inside</b> <span class="dim">Part ' + n.part + ' of ' + p.of + '</span><div style="margin-top:4px">' + cost + '</div></div>' + btn + '</div>' : (p.of > 1 ? '<div class="good" style="font-size:12px;margin-top:6px">Complete</div>' : '')) + '</div>';
    }).join('');
    return h;
  }
  // ---- headquarters: the long sink after the story (src/hq.js)
  var hqPick = null; // { category, option, ship }: an option looked at but not committed to
  // A long wait in words: days, hours and minutes of real time.
  function longTime(ticks) {
    var m = Math.round(ticks * S.tickMs / 60000), d = Math.floor(m / 1440), hh = Math.floor((m % 1440) / 60), mm = m % 60;
    return d ? d + ' d' + (hh ? ' ' + hh + ' h' : '') : hh ? hh + ' h' + (mm ? ' ' + mm + ' min' : '') : Math.max(1, mm) + ' min';
  }
  function hqHave(r) { return r === 'credits' ? S.colony.credits : Math.floor(S.coreRes[r] ? S.coreRes[r].amount : 0); }
  function hqName(r) { return r === 'credits' ? 'Credits' : (CFG.resources[r] || { name: r }).name; }
  function hqColor(r) { return r === 'credits' ? 'var(--amber)' : (CFG.resources[r] || {}).color; }
  // A good named without an amount (before an unlock is committed, the bill's sizes stay hidden).
  function hqGood(r) { return '<span class="pill" style="--c:' + hqColor(r) + '"><i></i>' + esc(hqName(r)) + '</span>'; }
  // The bill, one row per good: delivered of needed, what the Core holds, and a button to send it.
  function hqBill(need, got) {
    var total = 0, have = 0;
    Object.keys(need).forEach(function (r) { total += need[r]; have += Math.min(need[r], got[r] || 0); });
    var h = '<div class="meter wide" style="margin:6px 0 10px"><i style="width:' + clamp(have / total * 100, 0, 100).toFixed(1) + '%;background:var(--amber)"></i></div>';
    var any = false;
    h += Object.keys(need).map(function (r) {
      var g = got[r] || 0, left = Math.max(0, need[r] - g), core = hqHave(r), can = left > 0 && core >= 1;
      if (can && r !== 'credits') any = true;
      return '<div class="need hqneed" style="--c:' + hqColor(r) + '"><div class="top"><b><i class="dot" style="background:' + hqColor(r) + '"></i>' + esc(hqName(r)) + '</b><span class="num">' + fmt(g) + ' / ' + fmt(need[r]) + '</span></div>' +
        '<div class="meter wide"><i style="width:' + clamp(g / need[r] * 100, 0, 100).toFixed(1) + '%;background:' + hqColor(r) + '"></i></div>' +
        '<div class="hqrow"><span class="dim">' + (left ? (r === 'credits' ? 'Treasury: ' : 'In the Core: ') + fmt(core) : '<span class="good">Delivered</span>') + '</span>' +
        (left ? '<button class="btn" data-act="hqgive" data-res="' + r + '"' + (can ? '' : ' disabled') + '>Send ' + fmt(Math.min(left, core)) + '</button>' : '') + '</div></div>';
    }).join('');
    return { html: h, any: any, pct: total ? have / total : 0 };
  }
  function hqTab() {
    var Q = S.hq;
    if (!Q || !Q.unlocked) return '<div class="empty-state">' + icon('lock', 36) + '<div>Nothing is known about this yet.</div></div>';
    var title = '<div class="p-title">' + icon('hub', 22) + '<h3>' + esc(tabLabel(['hq', 'Headquarters'])) + '</h3>' + (Q.stage === 'chartered' ? '<span class="hqbadge" title="Independent charter">' + esc(Q.charter.badge) + ' Chartered</span>' : '') + '</div>';
    if (Q.stage === 'activation') {
      var b = hqBill(Q.activation.need, Q.activation.got);
      return title + '<p class="p-desc">Deliver from the <b>Core</b>, in any instalments. Rebuild: ' + longTime(Q.activation.ticks) + '.</p>' +
        '<div class="label sec">Activation · ' + Math.floor(b.pct * 100) + '% delivered</div>' + b.html +
        '<div class="actions"><button class="btn primary" data-act="hqgive"' + (b.any ? '' : ' disabled') + '>Send all from the Core</button></div>' +
        '<div class="note">Charter: ' + fmt(Q.charter.credits) + ' credits, ' + esc(Q.charter.badge) + ' on your station, ' + Q.charter.freeUnlocks + ' free unlock' + (Q.charter.freeUnlocks === 1 ? '' : 's') + '.</div>';
    }
    if (Q.stage === 'rebuilding') {
      var left = Q.activation.readyIn, all = Q.activation.ticks;
      return title + '<div class="label sec">Rebuilding · ' + longTime(left) + ' left</div><div class="meter wide"><i style="width:' + clamp((all - left) / all * 100, 0, 100).toFixed(1) + '%;background:var(--good)"></i></div>';
    }
    var h = title + '<p class="p-desc">One unlock at a time. Each paid unlock raises the cost and time of the next.</p>';
    if (Q.free > 0) h += '<div class="note good">' + icon('check', 13) + ' ' + Q.free + ' free unlock' + (Q.free === 1 ? '' : 's') + ' available.</div>';
    var cur = Q.cur;
    if (cur) {
      h += '<div class="label sec">Under way</div><div class="optcard on"><div class="top"><b>' + esc(cur.name) + '</b><span class="dim">' + esc(Q.categories.filter(function (k) { return k.key === cur.category; })[0].name) + '</span></div>';
      if (cur.state === 'building') {
        h += '<div class="dim" style="font-size:12px;margin-bottom:6px">Ready in ' + longTime(cur.readyIn) + '</div><div class="meter wide"><i style="width:' + clamp((cur.ticks - cur.readyIn) / cur.ticks * 100, 0, 100).toFixed(1) + '%;background:var(--good)"></i></div>';
      } else {
        var bb = hqBill(cur.need, cur.got);
        h += '<div class="dim" style="font-size:12px">' + Math.floor(bb.pct * 100) + '% delivered · then ' + longTime(cur.ticks) + '</div>' + bb.html +
          '<div class="actions"><button class="btn primary" data-act="hqgive"' + (bb.any ? '' : ' disabled') + '>Send all from the Core</button>' +
          '<button class="btn danger" data-act="hqabort" data-key="hqabort">' + (confirmKey === 'hqabort' ? 'Confirm: no refund' : 'Abandon') + '</button></div>';
      }
      h += '</div>';
    }
    h += '<div class="label sec">Unlocks · ' + Q.unlocks + ' paid' + (Q.fragmentCost ? ' · ' + Q.fragments + ' fragment' + (Q.fragments === 1 ? '' : 's') : '') + '</div>';
    Q.categories.forEach(function (k) {
      h += '<div class="hqcat"><div class="top"><b>' + esc(k.name) + '</b></div>' +
        '<div class="io">' + k.goods.map(hqGood).join('') + '</div>' +
        k.options.map(function (o) {
          var on = hqPick && hqPick.category === k.key && hqPick.option === o.key, isCur = cur && cur.category === k.key && cur.option === o.key;
          var r = '<div class="hqopt' + (on ? ' on' : '') + (o.blocked ? ' blocked' : '') + '"><div class="top"><b>' + esc(o.name) + '</b>' + (isCur ? '<span class="good">under way</span>' : o.blocked ? '<span class="warn">' + esc(o.blocked) + '</span>' : on ? '' : '<button class="btn" data-act="hqpick" data-cat="' + k.key + '" data-opt="' + o.key + '">Choose</button>') + '</div>' +
            '<div class="dim" style="font-size:12px">' + esc(o.desc) + '</div>';
          if (on && !o.blocked) {
            if (o.needsShip) {
              if (!Q.ships.some(function (x) { return x.id === hqPick.ship; })) hqPick.ship = Q.ships.length ? Q.ships[0].id : null;
              r += '<label class="field" style="margin-top:8px"><span class="label">Dropship to refit</span><select data-sel="hq:ship">' + Q.ships.map(function (x) { return '<option value="' + x.id + '"' + (x.id === hqPick.ship ? ' selected' : '') + '>Dropship ' + x.num + ' (' + x.state + ')</option>'; }).join('') + '</select></label>';
            }
            var building = cur && cur.state === 'building', fr = Q.fragmentCost, frOk = Q.fragments >= fr;
            var frTxt = fr ? ' (' + fr + ' fragment' + (fr === 1 ? '' : 's') + ')' : '';
            r += '<div class="actions">' +
              (Q.free > 0 ? '<button class="btn primary" data-act="hqstart" data-free="1">Take it free</button>' : '') +
              (building ? '' : '<button class="btn' + (Q.free > 0 || !frOk ? '' : ' primary') + '" data-act="hqstart"' + (frOk ? '' : ' disabled') + '>' + (cur ? 'Switch' : 'Commit') + frTxt + '</button>') +
              '<button class="btn" data-act="hqpick">Cancel</button></div>' +
              (building && !(Q.free > 0) ? '<div class="dim" style="font-size:11px">' + esc(cur.name) + ' is being built.</div>' : '') +
              (!building && (cur || !frOk) ? '<div class="dim" style="font-size:11px">' + (cur ? 'Drops ' + esc(cur.name) + ', keeps ' + Math.round(Q.switchCarry * 100) + '% of shared goods. ' : '') + (frOk ? '' : '<span class="warn">Not enough fragments.</span>') + '</div>' : '');
          }
          return r + '</div>';
        }).join('') + '</div>';
    });
    var P = Q.perks, have = [];
    if (P.discoveries) have.push(P.discoveries + ' district' + (P.discoveries === 1 ? '' : 's') + ' discovered');
    if (P.orbitalLinks) have.push('+' + P.orbitalLinks + ' orbital link' + (P.orbitalLinks === 1 ? '' : 's'));
    if (P.hcSlots) have.push(P.hcSlots + ' high-capacity slot' + (P.hcSlots === 1 ? '' : 's'));
    if (P.dropships) have.push('+' + P.dropships + ' dropship bay' + (P.dropships === 1 ? '' : 's'));
    if (P.l4) have.push(P.l4 + ' level-4 refit' + (P.l4 === 1 ? '' : 's') + ' waiting');
    if (P.routes) have.push('+' + P.routes + ' standing route' + (P.routes === 1 ? '' : 's'));
    if (P.linkBoost) have.push('+' + P.linkBoost + '/t on every district link');
    if (P.stabilizers) have.push(P.stabilizers + ' territory stabilizer' + (P.stabilizers === 1 ? '' : 's'));
    if (P.finders) have.push(P.finders + ' stable territor' + (P.finders === 1 ? 'y' : 'ies') + ' found');
    if (P.extraLinks) have.push(P.extraLinks + ' territory link kit' + (P.extraLinks === 1 ? '' : 's'));
    if (have.length) h += '<div class="label sec">Unlocked so far</div><div class="io">' + have.map(function (x) { return '<span class="pill out"><i style="background:var(--good)"></i>' + esc(x) + '</span>'; }).join('') + '</div>';
    return h;
  }
  // construction/stock numbers interpolate between ticks
  function frameStock(f) {
    document.querySelectorAll('[data-sr]').forEach(function (row) {
      var r = S.resources[row.dataset.sr]; if (!r) return;
      var v = clamp(r.amount + r.net * f, 0, r.cap);
      var a = row.querySelector('[data-sr-amt]'); if (a) a.textContent = fmt(v);
      var b = row.querySelector('[data-sr-bar]'); if (b) b.style.width = (v / r.cap * 100).toFixed(1) + '%';
    });
  }

  // ------------------------------------------------------------------ connection status, dock, workspaces, overview
  function renderNet() {
    var h = '';
    if (!connected) h = '<div class="alert warn">' + icon('warn', 14) + (pending.length ? 'Offline: ' + pending.length + ' action' + (pending.length === 1 ? '' : 's') + ' waiting to be sent' : 'Connection lost. Retrying…') + '</div>';
    else if (flushing) h = '<div class="alert warn">' + icon('truck', 14) + 'Reconnected: sending ' + pending.length + ' queued action' + (pending.length === 1 ? '' : 's') + '…</div>';
    if (S && S.paused) h += '<div class="alert warn">' + icon('pause', 14) + 'Simulation paused</div>';
    if (S && S.notice && S.notice.text) h += '<div class="alert ' + (S.notice.level === 'info' ? 'info' : S.notice.level === 'warn' ? 'warn' : '') + '">' + icon('bell', 14) + esc(S.notice.text) + '</div>';
    if ($('net').dataset.h !== h) { $('net').innerHTML = h; $('net').dataset.h = h; }
  }
  function renderAlerts() { renderNet(); }

  function readyFlags() {
    var next = dlevel(GEO().levels[activeD().level + 1]);
    var up = !!(next && next.upgradeCost && !S.hub.upgrading && canAfford(next.upgradeCost) && (activeD().core || activeD().level + 1 <= S.districtLevelCap));
    var found = !!(S.districtsUnlocked && Object.keys(CFG.districtTypes).some(function (k) {
      return S.foundable[k] && !districtOf(k) && !S.founding.some(function (f) { return f.type === k && !f.discovery; }) && canAffordCore(CFG.districtTypes[k].foundCost);
    })) || (S.discoveries || []).some(function (x) { return !x.districtId && !x.founding && S.foundable[x.type] && canAffordCore(CFG.districtTypes[x.type].foundCost); });
    return { up: up, found: found };
  }
  // What the Brief has to say that cannot wait: a shutdown, a clock running down, a hazard on its way or in effect.
  function briefAlert() {
    var d = S.doom, hz = S.hazard;
    if (S.colony.shutdown) return 'bad';
    if (d && (d.phase === 'starving' || d.ticks <= 20)) return 'bad';
    if (hz && hz.state === 'active') return hz.severity > 0.02 ? 'bad' : 'warn';
    if (hz && hz.prep < 0.8) return hz.prep < 0.5 && hz.ticksUntil <= 12 ? 'bad' : 'warn';
    return d && d.ticks <= 40 ? 'warn' : '';
  }
  function tabBadge(t) {
    if (t === 'brief') { var a = briefAlert(); return a ? '<span class="dotb ' + a + '" title="Needs a look"></span>' : ''; }
    if (t === 'stockpile') { var n = stockAttention().length; return n ? '<em class="warn">' + n + '</em>' : ''; }
    if (t === 'missions') { var rq = reqReady().length; return rq ? '<span class="dotb good" title="A requisition can be delivered"></span>' : ''; }
    var f = readyFlags();
    if (t === 'hub' && f.up) return '<span class="dotb good" title="An upgrade is affordable"></span>';
    if (t === 'districts' && f.found) return '<span class="dotb good" title="A district can be founded"></span>';
    if (t === 'settle' && settleNews().length) return '<span class="dotb good" title="' + esc(settleNews()[0]) + '"></span>';
    if (t === 'hq' && S.hq && S.hq.unlocked && (S.hq.free > 0 || (S.hq.stage === 'chartered' && !S.hq.cur))) return '<span class="dotb good" title="' + (S.hq.free > 0 ? 'A free piece of work is waiting' : 'Nothing is under way') + '"></span>';
    return '';
  }
  // The screens. Desk: one fixed list down the left edge, every screen one click away and always in the same place.
  // Phone: four fixed tabs and More, which opens the full list.
  function navBtn(t, cls) {
    var locked = tabLocked(t[0]), key = t[3] && !MOBILE ? ' (' + t[3].toUpperCase() + ')' : '';
    return '<button class="nv' + (cls || '') + (locked ? ' locked' : '') + '" data-act="tab" data-tab="' + t[0] + '" aria-current="' + (ws === t[0] ? 'page' : 'false') + '" title="' + esc(tabLabel(t)) + (locked ? ' · not open yet' : '') + key + '">' +
      icon(t[2], MOBILE ? 20 : 17) + '<span class="nl">' + esc(tabLabel(t)) + '</span>' + (locked ? '<span class="lk">' + icon('lock', 11) + '</span>' : tabBadge(t[0])) + '</button>';
  }
  function renderNav() {
    var h = '';
    if (MOBILE) {
      var inBar = {}, other = '';
      // in orbit, Stock is the station's storage (the surface stockpile would pull the view back down to the Core)
      var up = inOrbit() && stationId() !== null;
      MTABS.forEach(function (t) {
        if (t[0] === 'stockpile' && up) t = ['ostore', t[1], t[2]];
        inBar[t[0]] = 1;
        h += '<button class="nv" data-act="tab" data-tab="' + t[0] + '" aria-current="' + (!drawer && (t[0] === 'map' ? !ws : ws === t[0]) ? 'page' : 'false') + '">' + icon(t[2], 21) + '<span class="nl no-terms">' + t[1] + '</span>' + (t[0] === 'map' ? '' : tabBadge(t[0])) + '</button>';
      });
      navGroups().forEach(function (g) { g.tabs.forEach(function (t) { if (!inBar[t[0]] && !other && !tabLocked(t[0]) && tabBadge(t[0])) other = '<span class="dotb good"></span>'; }); });
      h += '<button class="nv" data-act="drawer" data-d="more" aria-current="' + (drawer === 'more' || (!drawer && ws && !inBar[ws]) ? 'page' : 'false') + '" aria-expanded="' + (drawer === 'more') + '">' + icon('more', 21) + '<span class="nl no-terms">More</span>' + other + '</button>';
    } else {
      h = '<button class="nv home" data-act="tab" data-tab="map" aria-current="' + (ws ? 'false' : 'page') + '" title="The map (M or Esc)">' + icon('radar', 17) + '<span class="nl">Map</span></button>';
      navGroups().forEach(function (g) { h += '<div class="nv-sec">' + esc(g.name) + '</div>' + g.tabs.map(function (t) { return navBtn(t); }).join(''); });
    }
    var el = $('nav');
    if (el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; }
    // the current directive, beside the work queue (desk shell)
    var dd = $('dock-dir');
    if (dd) {
      var cur = currentDirective();
      var dh = cur ? '<button class="dir-chip" data-act="tab" data-tab="brief" title="' + esc(cur.hint) + '">' + icon('check', 14) + '<span class="label">Next step</span><b>' + esc(cur.title) + '</b>' +
        (cur.progress ? '<small class="num">' + cur.progress.value + ' / ' + cur.progress.max + '</small>' : '') + '</button>' : '';
      if (dd.dataset.h !== dh) { dd.innerHTML = dh; dd.dataset.h = dh; }
    }
  }
  function currentDirective() { var ds = S.brief.directives; return ds.filter(function (x) { return x.current; })[0] || ds.filter(function (x) { return !x.done; })[0] || null; }
  // Phone shell: the sheet that slides over everything. 'more' lists every screen, the messages and the account;
  // 'places' lists where the view can go.
  function drawerHtml() {
    var h = '<div class="dr-card" role="dialog" aria-modal="true"><div class="dr-head"><h3>' + (drawer === 'places' ? 'Go to' : 'All screens') + '</h3><button class="pn-x" data-act="drawer" data-d="" aria-label="Close">&times;</button></div><div class="dr-body">';
    if (drawer === 'places') {
      var lastG = null;
      placeItems().forEach(function (p) {
        if (p.group !== lastG) { lastG = p.group; h += '<div class="nv-sec">' + p.group + '</div>'; }
        h += '<button class="dr-place' + (p.on ? ' on' : '') + (p.cls || '') + '" ' + p.act + ' style="--c:' + p.color + '"><i></i><span class="grow"><b>' + esc(p.name) + '</b>' + (p.note ? '<small>' + esc(p.note) + '</small>' : '') + '</span>' +
          (p.tag ? '<em>' + p.tag + '</em>' : '') + (p.small ? '<small class="num">' + p.small + '</small>' : '') + '</button>';
      });
      if (!S.districtsUnlocked) h += '<div class="note" style="margin-top:12px">Only the Core until hub level ' + CFG.districtProgression.unlockCoreLevel + '.</div>';
    } else {
      navGroups().forEach(function (g) { h += '<div class="nv-sec">' + esc(g.name) + '</div><div class="dr-grid">' + g.tabs.map(function (t) { return navBtn(t, ' tile'); }).join('') + '</div>'; });
      var cnt = window.Story.counts();
      h += '<div class="nv-sec">Messages</div><div class="dr-grid">' + [['mail', 'Mail', 'mail', cnt.mail], ['calls', 'Calls', 'play', cnt.calls], ['history', 'History', 'list', 0]].map(function (t) {
        return '<button class="nv tile" data-act="msgs" data-t="' + t[0] + '">' + icon(t[2], 20) + '<span class="nl">' + t[1] + '</span>' + (t[3] ? '<em>' + t[3] + '</em>' : '') + '</button>';
      }).join('') + '</div>';
      h += '<div class="nv-sec">Command</div><div class="dim" style="font-size:12px;margin:0 2px 8px">Signed in as <b>' + esc(S.user) + '</b></div><div class="stack">' +
        '<button class="btn block" data-act="layout" data-ui="desktop">' + icon('screen', 14) + ' Use the desktop layout</button>' +
        '<button class="btn block" data-act="menu" data-m="account">' + icon('lock', 14) + ' Account</button>' +
        '<button class="btn block" data-act="menu" data-m="logout">Sign out</button>' +
        '<button class="btn block danger" data-act="menu" data-m="confirmReset">Abandon colony &amp; start over</button></div>';
    }
    return h + '</div></div>';
  }
  function renderDrawer() {
    var el = $('drawer'); if (!el) return;
    if (!drawer || !S) { if (!el.hidden) { el.hidden = true; el.dataset.h = ''; el.innerHTML = ''; } return; }
    var h = drawerHtml();
    el.hidden = false;
    if (el.dataset.h !== h) { var b = el.querySelector('.dr-body'), top = b ? b.scrollTop : 0; el.innerHTML = h; el.dataset.h = h; b = el.querySelector('.dr-body'); if (b) b.scrollTop = top; }
  }
  function wsHtml(t) {
    if (window.Orbit.panes[t]) return window.Orbit.panes[t]();
    return t === 'hub' ? (activeD().core ? hubTab() : districtHubTab()) : t === 'people' ? peopleTab() : t === 'districts' ? districtsTab() : t === 'settle' ? settleTab() : t === 'logistics' ? logisticsPage() :
      t === 'convoy' ? convoyTab() : t === 'exchange' ? exchangeTab() : t === 'missions' ? missionsTab() : t === 'stockpile' ? stockpileTab() : t === 'data' ? dataTab() : t === 'hq' ? hqTab() : briefTab();
  }
  var lastSheetTabs = '', lastSheet = '';
  function renderSheet() {
    var sh = $('sheet');
    var g = ws ? groupOf(ws) : null;
    if (!ws || !g) { ws = null; sh.hidden = true; lastSheet = ''; lastSheetTabs = ''; document.body.classList.remove('ws-open'); return; }
    sh.hidden = false; document.body.classList.add('ws-open');
    var cur = tabOf(ws), th;
    if (MOBILE) th = g.tabs.length > 1 ? g.tabs.map(function (t) {
      return '<button class="dtab" role="tab" data-act="tab" data-tab="' + t[0] + '" aria-selected="' + (ws === t[0]) + '">' + icon(t[2], 14) + '<span>' + esc(tabLabel(t)) + '</span>' + (tabLocked(t[0]) ? '' : tabBadge(t[0])) + '</button>';
    }).join('') : '<h2 class="sheet-title">' + icon(cur[2], 17) + '<span>' + esc(tabLabel(cur)) + '</span></h2>';
    else th = '<span class="crumb">' + esc(g.name) + '</span><h2 class="sheet-title">' + icon(cur[2], 17) + '<span>' + esc(tabLabel(cur)) + '</span></h2>';
    if (th !== lastSheetTabs) {
      $('sheet-tabs').innerHTML = th; lastSheetTabs = th;
      var on = $('sheet-tabs').querySelector('[aria-selected="true"]'); if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
    var ae = document.activeElement;
    if (ae && ae.classList && ae.classList.contains('numin') && sh.contains(ae)) { panelDeferred = true; return; }
    var h = '<div class="ws-col' + (ws === 'stockpile' || ws === 'exchange' ? ' wide' : '') + '">' + wsHtml(ws) + '</div>';
    if (h === lastSheet) return;
    lastSheet = h;
    var b = $('sheet-body'), top = b.scrollTop;
    b.innerHTML = h; b.scrollTop = top;
  }

  // The overview: what the place needs from the player when nothing is selected.
  function attention() {
    var out = [], c = S.colony, hz = S.hazard;
    if (c.shutdown) out.push(['bad', 'Colony shut down' + (c.parked ? ' · ' + c.parked + ' building' + (c.parked === 1 ? '' : 's') + ' parked' : ''), 'brief']);
    if (c.starving.length && !c.shutdown) out.push(['bad', 'Shortage of ' + c.starving.map(function (r) { return CFG.resources[r].name; }).join(' & ') + ' · collapse in ' + Math.ceil(c.morale / (100 / CFG.failureThresholdTicks)) + ' ticks', 'stockpile']);
    var full = [];
    stockAttention().forEach(function (k) {
      if (c.starving.indexOf(k) >= 0) return;
      var n = stockNote(k);
      if (/FULL/.test(n[0])) { full.push(CFG.resources[k].name); return; }
      out.push([n[1], CFG.resources[k].name + ' ' + (n[0] === 'EMPTY' ? 'is empty' : n[0]), 'stockpile']);
    });
    if (full.length) out.push(['warn', full.length === 1 ? full[0] + ' is full and wasting' : full.length + ' stockpiles are full and wasting: ' + full.slice(0, 3).join(', ') + (full.length > 3 ? '…' : ''), 'stockpile']);
    if (S.energy.satisfaction < 0.999) out.push(['warn', 'Brownout · production at ' + pct(S.energy.satisfaction), '']);
    else if (S.energy.buffered > 0.5) out.push(['warn', 'Standby power is covering ' + Math.round(S.energy.buffered) + ' of the grid\'s load', '']);
    if (S.hub.eff < 0.999) out.push(['warn', 'Hub under-maintained: short of ' + CFG.resources[S.hub.limiting].name, 'hub']);
    if (hz) out.push([hz.state === 'forecast' ? (hz.prep < 0.5 && hz.ticksUntil <= 12 ? 'bad' : 'warn') : (hz.severity > 0.02 ? 'bad' : 'warn'),
      hz.name + (hz.state === 'forecast' ? ' in ' + hz.ticksUntil + 't · ' + Math.round(hz.prep * 100) + '% prepared' : hz.severity > 0.02 ? ' in effect' : ' being weathered'), 'brief']);
    S.allOrders.forEach(function (o) {
      if (!o.waiting) return;
      var sh = Object.keys(o.waiting.short);
      if (sh.length) out.push(['warn', 'The work queue ' + (o.dname ? 'in ' + o.dname : 'in the Core') + ' is waiting for ' + sh.map(function (r) { return fmt(o.waiting.short[r]) + ' ' + CFG.resources[r].name; }).join(', '), '', o.did]);
    });
    var rq = reqReady();
    if (rq.length) out.push(['good', rq.length === 1 ? 'A requisition can be delivered: ' + fmt(rq[0].qty) + ' ' + CFG.resources[rq[0].good].name : rq.length + ' requisitions can be delivered', 'missions']);
    var f = readyFlags();
    if (f.up) out.push(['good', 'An upgrade is affordable', 'hub']);
    if (f.found) out.push(['good', 'A district can be founded', 'districts']);
    settleNews().forEach(function (m) { out.push(['good', m, 'settle']); });
    return out.slice(0, 8);
  }
  function placeSummary() {
    var d = activeD(), open = Object.keys(S.hub.rings).reduce(function (n, r) { return n + S.hub.rings[r]; }, 0);
    var used = S.buildings.length + S.orders.filter(function (o) { return o.kind === 'build' || (o.kind === 'replace' && o.state !== 'queued'); }).length + (S.locks || []).length, e = S.energy;
    return '<div class="label sec">' + esc(d.core ? 'The Core' : d.name) + ' at a glance</div><dl class="kv">' +
      '<dt>Structures</dt><dd>' + S.buildings.length + ' online' + (S.orders.length ? ' · ' + S.orders.length + ' in the work queue' : '') + '</dd>' +
      (slotCount() > 1 ? '<dt>Build slots</dt><dd>' + slotCount() + ' at a time</dd>' : '') +
      '<dt>Free plots</dt><dd class="' + (open - used > 0 ? 'good' : 'dim') + '">' + Math.max(0, open - used) + ' of ' + open + '</dd>' +
      '<dt>Power</dt><dd class="' + (e.satisfaction < 0.999 ? 'bad' : '') + '">' + Math.floor(e.supply) + ' supply · ' + Math.ceil(e.demand) + ' used</dd>' +
      (d.core ? '<dt>Level</dt><dd>' + d.level + (S.hub.upgrading ? ' · upgrading' : '') + '</dd>' : '<dt>Level</dt><dd>' + d.level + ' · link ' + d.link.load + ' / ' + d.link.capacity + ' per tick</dd>') + '</dl>' +
      '<button class="btn block" data-act="tab" data-tab="hub">' + icon('hub', 12) + ' ' + (d.core ? 'Hub' : 'District') + ' &amp; upgrades</button>';
  }
  function overview() {
    var d = activeD(), q = MOBILE ? queueHtml(true) : '';
    if (d.orbital) {
      var h0 = window.Orbit.panes.oplace();
      var side = window.Orbit.sideHtml();
      return h0 + (q ? '<div class="label sec">Work queue</div><div class="qlist">' + q + '</div>' : '') + '<div class="label sec">' + (d.type === 'station' ? 'Orbital stock' : 'Territory stock') + '</div>' + side.replace(/^<h2[^>]*>.*?<\/h2>/, '');
    }
    var h = '', cur = currentDirective();
    if (d.core && !S.buildings.length && !S.orders.length) h += '<div class="note good" style="margin-top:0"><b>Start here.</b> ' + (MOBILE ? 'Tap' : 'Click') + ' any empty plot on the map to see what can be built on it. The hub in the middle shows what an upgrade unlocks.</div>';
    if (cur) {
      h += '<div class="label sec" style="margin-top:0">Next step</div><div class="ov-card"><h4>' + esc(cur.title) + '</h4><p>' + esc(cur.hint) + '</p>' + timingLine(cur.timing) +
        '<button class="btn" data-act="tab" data-tab="brief">' + S.brief.remaining + ' left in the Brief</button></div>';
    }
    var at = attention();
    h += '<div class="label sec"' + (h ? '' : ' style="margin-top:0"') + '>Needs attention</div><div class="ov-card" style="border-left-color:' + (at.some(function (x) { return x[0] === 'bad'; }) ? 'var(--bad)' : at.length ? 'var(--warn)' : 'var(--good)') + '">';
    if (!at.length) h += '<div class="ov-row"><span class="ov-dot good"></span><span class="grow dim">Nothing needs attention.</span></div>';
    at.forEach(function (a) {
      var away = a[3] !== undefined && a[3] !== activeId;
      var inner = '<span class="ov-dot ' + a[0] + '"></span><span class="grow">' + esc(a[1]) + '</span>' + (a[2] || away ? '<span class="dim">›</span>' : '');
      h += '<div class="ov-row">' + (a[2] ? '<button data-act="tab" data-tab="' + a[2] + '">' + inner + '</button>' : away ? '<button data-act="enter" data-id="' + a[3] + '">' + inner + '</button>' : inner) + '</div>';
    });
    h += '</div>';
    if (!MOBILE) return h + placeSummary(); // on a desk the pinned stock is in the stock bar and the queue in the bottom bar
    if (q) h += '<div class="label sec">Work queue</div><div class="qlist">' + q + '</div>';
    var pk = pinKeys();
    h += '<div class="label sec" style="display:flex;justify-content:space-between"><span>Pinned stock</span><button class="linkbtn" data-act="tab" data-tab="stockpile">' + (pins === null ? 'Choose' : 'Edit') + '</button></div>' +
      (pk.length ? pk.map(function (k) { return stockRow(k, false); }).join('') : '<div class="dim" style="font-size:12px">Nothing pinned. Pin stock from the Stockpile.</div>');
    return h + placeSummary();
  }
  function rightPane() {
    if (sel && sel.ring) return '<button class="pn-x pn-close" data-act="desel" title="Close (Esc)" aria-label="Close">&times;</button>' + siteTab();
    return overview();
  }

  function siteTab() {
    if (!sel || sel.hub) {
      var n = S.buildings.length;
      return '<div class="empty-state">' + icon('site', 36) + '<div>Select a slot on the radar.</div>' +
        '<div class="dim" style="margin-top:8px;font-size:12px">' + n + ' structure' + (n === 1 ? '' : 's') + ' online · ' + S.orders.length + ' under construction</div></div>';
    }
    var r = sel.ring, s = sel.slot, head = 'Ring ' + r + ' &middot; Slot ' + (s + 1) + ' &middot; ' + plotName(r) + ' plot';
    if (!slotUnlocked(r, s)) {
      return '<div class="p-title">' + icon('lock', 22) + '<h3>' + head + '</h3></div><div class="note">Ring ' + r + ' (' + plotName(r) + ' plots) unlocks at ' + (activeD().core ? 'hub' : 'district') + ' level ' + r + '.</div>' +
        '<div class="actions"><button class="btn primary" data-act="tab" data-tab="hub">View ' + (activeD().core ? 'hub' : 'district') + ' upgrade</button></div>';
    }
    var b = buildingAt(r, s), o = orderAt(r, s), qd = !b && !o && queuedBuild(r, s);
    if (qd) {
      var qdef = CFG.buildings[qd.body.type];
      return '<div class="p-title" style="--c:' + qdef.color + '">' + icon(qd.body.type, 22) + '<h3>' + esc(qdef.name) + '</h3></div><div class="label">' + head + ' · queued while offline</div>' +
        '<div class="note warn">Not sent yet: waiting for the connection.</div>' +
        '<div class="actions"><button class="btn danger" data-act="pcancel" data-id="' + qd.id + '">Discard queued order</button></div>';
    }
    if (o && !b) return orderPanel(o, head);
    if (b && replaceAt && replaceAt.ring === r && replaceAt.slot === s) return buildMenu(r, s, head, b);
    if (b) return builtPanel(b, head);
    var lk = lockAt(r, s);
    if (lk) return '<div class="p-title">' + icon('lock', 22) + '<h3>' + head + '</h3></div><div class="label">Being cleared</div><p class="p-desc">A configured workshop was scrapped here. The slot is free to build on again in <b>' + span(lk.ticksLeft) + '</b>, the same wait as changing a recipe.</p>';
    return buildMenu(r, s, head);
  }

  // ---- the work queue: strict order, paid for when an order starts; one build slot per place until more are bought ----
  function shortPills(short) { return Object.keys(short).map(function (r) { return pill(r, short[r], 'no'); }).join(''); }
  // What the place still needs before the order at the front of its queue can start.
  function waitingLine(o) {
    if (!o.waiting) return '';
    var keys = Object.keys(o.waiting.short);
    if (keys.length) return '<div class="note warn" style="margin:8px 0 0">Waiting for stock: this place is short of</div><div class="io" style="margin-top:6px">' + shortPills(o.waiting.short) + '</div>';
    return o.waiting.why ? '<div class="note warn" style="margin:8px 0 0">Waiting: ' + esc(o.waiting.why) + '.</div>' : '';
  }
  function orderName(o) {
    return o.kind === 'build' ? 'Build ' + CFG.buildings[o.data.type].name : o.kind === 'replace' ? 'Replace ' + CFG.buildings[o.data.from].name + ' with ' + CFG.buildings[o.data.type].name
      : o.kind === 'found' ? 'Found ' + (o.data.discovery ? ((S.discoveries || []).filter(function (x) { return x.id === o.data.discovery; })[0] || { name: CFG.districtTypes[o.data.type].name }).name : CFG.districtTypes[o.data.type].name) : o.kind === 'expand' ? 'Expand ' + CFG.buildings[o.data.type].name + ' → ' + o.data.level : 'Upgrade → L' + o.data.level;
  }
  // The buttons a waiting order gets: to the front, and off the queue.
  function queueBtns(o) {
    return (o.pos > 1 ? '<button class="btn" data-act="qmove" data-id="' + o.id + '" data-to="top" title="Build this next">Move to the front</button>' : '') +
      '<button class="btn danger" data-act="cancel" data-id="' + o.id + '" title="Nothing has been paid for it yet">Remove from the queue</button>';
  }
  // The pane for a plot that has a build or a replacement on it: under way, or waiting its turn.
  function orderPanel(o, head) {
    var d = CFG.buildings[o.data.type], swap = o.kind === 'replace';
    var h = '<div class="p-title" style="--c:' + d.color + '">' + icon(o.data.type, 22) + '<h3>' + esc(d.name) + '</h3></div>';
    if (o.state === 'queued') {
      return h + '<div class="label">' + head + ' · in the work queue</div>' +
        '<p class="p-desc">Number <b>' + o.pos + '</b> of ' + waitingOf(S.orders).length + ' waiting here. Orders are built ' + (slotCount() > 1 ? slotCount() + ' at a time' : 'one at a time') + ', strictly in order, and each is paid for when it starts.</p>' +
        '<div class="label sec" style="margin-top:0">It will cost</div><div class="io">' + costPills(o.cost, S.resources) + '</div>' + waitingLine(o) +
        '<div class="actions">' + queueBtns(o) + '</div>';
    }
    return h + '<div class="label">' + head + ' · ' + (swap ? 'being converted from ' + esc(CFG.buildings[o.data.from].name) : 'under construction') + '</div>' +
      '<p class="p-desc">' + o.remaining + ' tick' + (o.remaining === 1 ? '' : 's') + ' remaining.</p>' +
      '<div class="actions">' + rushBtn(o) + '<button class="btn danger" data-act="cancel" data-id="' + o.id + '">Cancel &amp; refund</button></div>' +
      (swap ? '<div class="dim" style="font-size:11px;margin-top:8px">Cancel refunds the new building only.</div>' : '');
  }
  // What happens if this is ordered now: it starts, or it joins the queue, and what the place is short of.
  function queueNote(cost, back) {
    var waiting = waitingOf(S.orders).length, busy = !slotFree();
    var short = Object.keys(cost).filter(function (r) { return (S.resources[r] ? S.resources[r].amount : 0) + ((back || {})[r] || 0) < cost[r]; });
    if (!busy && !short.length) return '';
    return '<div class="bonus warn">' + (busy ? 'Joins the queue as number ' + (waiting + 1) : 'Queued') +
      (short.length ? ' · short of ' + short.map(function (r) { return esc(CFG.resources[r].name); }).join(', ') + ', so it waits for stock when its turn comes' : '') + '</div>';
  }
  // Rush: pay credits to finish a work order on the next tick (two clicks, like the other costly buttons).
  function rushBtn(o, cls) {
    if (!o.rush) return '';
    var armedNow = confirmKey === 'rush:' + o.id, can = S.colony.credits >= o.rush;
    return '<button class="btn ' + (cls || '') + '" data-act="rush" data-id="' + o.id + '"' + (can ? '' : ' disabled') + ' title="Finish this on the next tick. Each rush in a day costs 20% more than the one before.">' +
      (armedNow ? 'Confirm: ' : 'Rush: ') + fmt(o.rush) + ' cr</button>';
  }
  var MARK_TXT = { hit: 'Hurt by the current hazard', upkeep: 'Paying the hazard\'s maintenance cost', risk: 'In the forecast hazard\'s path' };
  var STATUS = {
    running: ['Running', 'good'], paused: ['Paused', 'dim'], no_power: ['No power', 'bad'], low_power: ['Low power', 'warn'],
    starved: ['Missing inputs', 'bad'], low_input: ['Short on inputs', 'warn'], damaged: ['Damaged: awaiting repairs', 'bad'], understaffed: ['Short-staffed', 'warn'],
    no_recipe: ['No recipe chosen', 'warn'], resetting: ['Retooling', 'warn'], standby: ['Standing by', 'dim']
  };
  function plotName2(size) { return CFG.plotSizes[size].name; }
  // Replace: swap the building for another on the same plot, through the work queue.
  function replaceRow(b, d) {
    var sw = orderAt(b.ring, b.slot);
    if (sw) return '<div class="note" style="margin:0 0 12px"><b>Queued to be replaced</b> by ' + esc(CFG.buildings[sw.data.type].name) + ' (number ' + sw.pos + ' in the queue). It keeps working until then.' +
      waitingLine(sw) + '<div class="actions" style="margin-top:8px">' + queueBtns(sw) + '</div></div>';
    if (d.recipeBuilding && b.recipe) return '';
    if (ordersAt(b.ring, b.slot).length) return '';
    return '<button class="btn block" style="margin:-4px 0 12px" data-act="replacemode" title="Swap it for another building on this plot, through the work queue">' + icon('route', 12) + ' Replace with…</button>';
  }
  function paused0(b) { return b.paused; }
  // A home's rows: how many people it holds and what that is made of, and the comfort it feels and where that comes from.
  function homesRows(b, d) {
    var base = d.housing, tot = b.homes === null || b.homes === undefined ? base * b.plot * (b.xscale || 1) : b.homes, parts = [base + ' base'];
    if (b.plot < 0.999 || b.plot > 1.001) parts.push('plot ×' + b.plot.toFixed(2));
    if (b.xscale > 1.001) parts.push('level ×' + b.xscale.toFixed(2));
    if (b.homeMult > 1.001) parts.push('households ×' + b.homeMult.toFixed(2));
    var cp = [];
    if (b.comfortNb) cp.push((b.comfortNb > 0 ? '+' : '−') + Math.abs(b.comfortNb) + ' neighbours');
    if (b.comfortOpt) cp.push((b.comfortOpt > 0 ? '+' : '−') + Math.abs(b.comfortOpt) + ' households');
    return '<dt>Homes</dt><dd>+' + Math.floor(tot + 0.0001) + ' people<div class="dim" style="font-size:11px">' + parts.join(' · ') + '</div></dd>' +
      '<dt>Comfort</dt><dd class="' + (b.comfort > 0 ? 'good' : b.comfort < 0 ? 'bad' : 'dim') + '">' + (b.comfort > 0 ? '+' : '') + (b.comfort || 0) + (cp.length ? '<div class="dim" style="font-size:11px">' + cp.join(' · ') + '</div>' : '') + '</dd>';
  }
  function builtPanel(b, head) {
    var d = bdef(b.type), st = STATUS[b.paused ? 'paused' : b.status] || STATUS.running;
    var why = (!b.paused && b.limiting) ? ' <span class="dim">(' + esc(CFG.resources[b.limiting].name) + ')</span>' : '';
    var key = 'dem:' + b.id, refund = Math.round(CFG.demolishRefund * 100);
    var h = '<div class="p-title" style="--c:' + d.color + '">' + icon(b.type, 22) + '<h3>' + esc(d.name) + '</h3></div>' +
      '<div class="label">' + head + '</div><p class="p-desc">' + esc(d.desc) + '</p>' +
      '<div class="actions quick"><button class="btn" data-act="toggle" data-ring="' + b.ring + '" data-slot="' + b.slot + '">' + icon(b.paused ? 'play' : 'pause', 12) + ' ' + (b.paused ? 'Resume' : 'Pause') + '</button>' +
      '<button class="btn danger" data-act="demolish" data-ring="' + b.ring + '" data-slot="' + b.slot + '" data-key="' + key + '" title="Refunds ' + refund + '% of the build cost">' +
      (confirmKey === key ? 'Confirm?' : 'Demolish') + '</button></div>' + replaceRow(b, d) +
      '<dl class="kv"><dt>Status</dt><dd class="' + st[1] + '">' + st[0] + why + '</dd>' +
      (d.buffer ? '' : '<dt>Efficiency</dt><dd>' + pct(b.paused ? 0 : b.eff) + '</dd>') +
      '<dt>Adjacency</dt><dd class="' + (b.adj > 1.001 ? 'good' : b.adj < 0.999 ? 'bad' : 'dim') + '">' + (Math.abs(b.adj - 1) < 0.001 ? 'none' : '×' + b.adj.toFixed(2)) + '</dd>' +
      '<dt>Plot</dt><dd class="' + (b.plot < 0.999 ? 'bad' : 'good') + '">' + plotName(b.ring) + (b.plot < 0.999 ? ' · too small for ' + plotName2(d.minPlotSize) + ' · ×' + b.plot.toFixed(2) : (d.minPlotSize > 1 ? ' · fits' : '')) + '</dd>' +
      (d.workers ? '<dt>Crew</dt><dd class="' + (S.colony.staffing.ratio < 0.999 ? 'warn' : '') + '">' + d.workers + ' needed' + (S.colony.staffing.ratio < 0.999 ? ' · colony at ' + pct(S.colony.staffing.ratio) + ' staffed' : '') + '</dd>' : '') +
      (b.xscale > 1.001 ? '<dt>Level ' + b.level + '</dt><dd class="good">×' + b.xscale.toFixed(2) + ' throughput</dd>' : '') +
      (!d.housing && b.opt && Math.abs(b.opt - 1) > 0.001 ? '<dt>Optional input</dt><dd class="good">×' + b.opt.toFixed(2) + ' output</dd>' : '') +
      (!d.housing && !d.buffer && !paused0(b) && Math.abs(b.prod - 1) > 0.001 && d.outputsPerTick && Object.keys(d.outputsPerTick).length ? '<dt>Morale</dt><dd class="' + (b.prod < 1 ? 'bad' : 'good') + '">×' + b.prod.toFixed(2) + ' output</dd>' : '') +
      (d.housing ? homesRows(b, d) : '') +
      (b.mark ? '<dt>Hazard</dt><dd class="' + (b.mark === 'hit' ? 'bad' : 'warn') + '">' + MARK_TXT[b.mark] + (b.haz < 0.999 ? ' · ×' + b.haz.toFixed(2) : '') + '</dd>' : (b.haz !== undefined && Math.abs(b.haz - 1) > 0.001 ? '<dt>Events &amp; projects</dt><dd class="' + (b.haz < 1 ? 'bad' : 'good') + '">×' + b.haz.toFixed(2) + ' output</dd>' : '')) + '</dl>' + rigBlock(b) +
      (d.buffer ? '' : '<div class="label sec">Per tick at current efficiency</div><div class="io">' + ioPills(ioOf(b, d), (b.paused ? 0 : b.eff) * (b.xscale || 1), b.mult * b.haz * (b.opt || 1) * (b.prod === undefined ? 1 : b.prod)) + '</div>') +
      (d.storageBonus ? '<div class="io" style="margin-top:6px">' + pill('scrap', '+' + fmt(d.storageBonus * b.mult * (b.xscale || 1)) + ' storage each') + '</div>' : '') +
      (d.defense ? '<div class="io" style="margin-top:6px"><span class="pill out"><i style="background:var(--bad)"></i>Defence ' + (d.defense * b.eff * b.mult * (b.xscale || 1)).toFixed(1) + '</span></div>' : '') +
      (d.transmit && !(d.afterTransmit && S.colony.won) ? '<div class="io" style="margin-top:6px"><span class="pill out"><i style="background:#fff"></i>Signal ' + (b.eff * b.mult).toFixed(2) + ' / tick</span></div>' : '') +
      (d.afterTransmit && S.colony.won ? '<div class="note good" style="margin-top:8px">Transmission complete.</div>' : '');
    if (d.buffer) h += bufferCard(b, d);
    if (d.alternatives && !activeD().orbital) h += processCard(b, d);
    if (d.expand) h += expansionCard(b, d);
    if (d.recipeBuilding) h += recipeCard(b);
    if (d.launchPad || d.catapult || d.commandCenter) h += window.Orbit.launchCard(b, d);
    if (d.optional) h += optionalCard(d, b);
    h += classOptionsCard(d, b);
    var nts = neighborTypes(b.ring, b.slot);
    h += '<div class="label sec">Neighbours</div>';
    h += nts.length ? '<div class="io">' + nts.map(function (t) {
      var rule = CFG.adjacencyRules.filter(function (x) { return x.targetBuilding === b.type && x.adjacentBuilding === t; })[0];
      var cm = d.housing ? (CFG.buildings[t].comfort || 0) : 0;
      var cls = d.housing ? (cm > 0 ? 'out' : cm < 0 ? 'no' : '') : (rule ? (rule.outputMultiplier > 1 ? 'out' : 'no') : '');
      var suffix = d.housing ? (cm ? ' ' + (cm > 0 ? '+' : '−') + Math.abs(cm) : '') : (rule ? ' ×' + rule.outputMultiplier : '');
      return '<span class="pill ' + cls + '" style="--c:' + CFG.buildings[t].color + '">' + esc(CFG.buildings[t].name) + suffix + '</span>';
    }).join('') + '</div>' : '<div class="dim" style="font-size:12px">No adjacent structures.</div>';
    if (!d.housing && d.comfort) {
      var homes = neighborTypes(b.ring, b.slot).filter(function (t) { return CFG.buildings[t].housing; }).length;
      h += '<div class="dim" style="font-size:11px;margin-top:8px">Adjacent homes feel this building: ' + (d.comfort > 0 ? '+' : '−') + Math.abs(d.comfort) + ' comfort each' + (homes ? ' (' + homes + ' next door)' : '') + '.</div>';
    }
    return h + '<div class="dim" style="font-size:11px;margin-top:12px">Demolishing refunds ' + refund + '% of the build cost.</div>';
  }


  // ---- alternative recipes: another way to run the same building, opening up as the colony progresses ------
  function ioOf(b, d) {
    if (d.afterTransmit && S.colony.won) return { inputsPerTick: d.afterTransmit.inputsPerTick, outputsPerTick: d.outputsPerTick || {} }; // the Beacon has sent: it only needs power now
    var alt = d.alternatives && b.recipe && d.alternatives[b.recipe]; return alt ? { inputsPerTick: alt.inputsPerTick, outputsPerTick: alt.outputsPerTick } : d;
  }
  function altOpen(alt) {
    var u = alt.unlock || {};
    return !(u.level && activeD().level < u.level) && !(u.milestone && !(S.milestones || {})[u.milestone]);
  }
  // Orbit is not mentioned anywhere until the colony has the standing to see it.
  function orbitKnown() { return !!(S && S.orbital && S.orbital.unlocked); }
  function altNeeds(alt) {
    var u = alt.unlock || {};
    if (u.level && activeD().level < u.level) return 'Opens at ' + (activeD().core ? 'hub' : 'district') + ' level ' + u.level;
    if (u.milestone && !(S.milestones || {})[u.milestone]) {
      if (u.milestone === 'station' && !orbitKnown()) return 'Unlock conditions unknown at this time';
      return 'Opens once ' + ({ beacon: 'the Beacon is built', freeport: 'the Free Port is founded', station: 'a station is in orbit' }[u.milestone] || 'the colony has come further');
    }
    return '';
  }
  function ioLines(io) {
    return '<div class="io">' + Object.keys(io.inputsPerTick).map(function (r) { return pill(r, io.inputsPerTick[r], 'in'); }).join('') + '</div><div class="io" style="margin-top:4px">' +
      Object.keys(io.outputsPerTick).map(function (r) { return pill(r, io.outputsPerTick[r], 'out'); }).join('') + '</div>';
  }
  function processCard(b, d) {
    var cur = d.alternatives[b.recipe] || null, T = (CFG.production || {}).switchTicks || 0;
    var h = '<div class="label sec">Recipe</div><div class="optcard on"><div class="top"><b>' + esc(cur ? cur.name : 'Standard') + '</b><span class="dim">' + (cur ? 'alternative' : 'as built') + '</span></div>' +
      (cur && cur.desc ? '<div class="dim" style="font-size:12px;margin-bottom:6px">' + esc(cur.desc) + '</div>' : '') + ioLines(ioOf(b, d)) + '</div>';
    if (b.resetting) return h + '<div class="note warn">Retooling: idle ' + b.resetting + ' more tick' + (b.resetting === 1 ? '' : 's') + '.</div>';
    h += '<div class="dim" style="font-size:11px;margin:8px 0 4px">Other ways to run it · free to switch, idle ' + T + ' ticks</div>';
    var list = [];
    if (cur) list.push(['', { name: 'Standard', desc: 'The recipe it was built with.', inputsPerTick: d.inputsPerTick, outputsPerTick: d.outputsPerTick }]);
    Object.keys(d.alternatives).forEach(function (k) { if (k !== b.recipe) list.push([k, d.alternatives[k]]); });
    return h + list.map(function (x) {
      var k = x[0], alt = x[1], open = !k || altOpen(alt), on = recipePick === 'p:' + k;
      var outs = Object.keys(alt.outputsPerTick).map(function (o) { return mp(alt.outputsPerTick[o]) + ' ' + esc(o === 'energy' ? 'Power' : CFG.resources[o].name); }).join(', ');
      return '<div class="recipe' + (on ? ' sel' : '') + (open ? '' : ' locked') + '"><button class="rname" data-act="recpick" data-rec="p:' + k + '"><b>' + (open ? '' : icon('lock', 11) + ' ') + esc(alt.name) + '</b><small>' + (open ? outs + '/t' : esc(altNeeds(alt))) + '</small></button>' +
        (on ? (alt.desc ? '<div class="dim" style="font-size:12px;padding:0 10px 6px">' + esc(alt.desc) + '</div>' : '') + ioLines(alt) +
          '<div class="actions"><button class="btn primary" data-act="procset" data-ring="' + b.ring + '" data-slot="' + b.slot + '" data-rec="' + k + '"' + (open ? '' : ' disabled') + '>' + (open ? 'Switch to this · idle ' + T + ' ticks' : esc(altNeeds(alt))) + '</button></div>' : '') + '</div>';
    }).join('');
  }
  // A buffer (the Cell Bank): standing by, or making up a shortfall on the grid.
  function bufferCard(b, d) {
    var cap = d.buffer.power * b.plot * (b.xscale || 1), now = cap * (b.paused ? 0 : b.eff);
    var burn = Object.keys(d.buffer.perTick).map(function (r) { return pill(r, d.buffer.perTick[r] * (b.xscale || 1), 'in'); }).join('');
    return '<div class="label sec">Standby power</div><div class="optcard' + (now > 0.5 ? ' on' : '') + '"><div class="top"><b>' + (now > 0.5 ? 'Discharging ' + Math.round(now) + ' power' : 'Standing by') + '</b><span class="dim">up to ' + Math.round(cap) + '</span></div>' +
      '<div class="dim" style="font-size:12px;margin-bottom:6px">Covers grid shortfalls. At full output:</div><div class="io">' + burn + '<span class="pill out"><i style="background:var(--energy)"></i>' + Math.round(cap) + ' Power</span></div></div>';
  }

  // ---- Trade Workshop: the recipe is chosen once, and costs credits to change --------------
  var recipePick = null; // recipe being looked at in the picker, if any
  function recipeLines(rec, b) {
    var batch = CFG.tradeWorks.batchByPlot[GEO().ringPlotSize[b.ring]] || 1;
    var io = function (o) { return Object.keys(o).map(function (r) { return pill(r, o[r] * batch, 'in'); }).join(''); };
    var out = Object.keys(rec.outputsPerTick).map(function (r) { return pill(r, rec.outputsPerTick[r] * batch, 'out'); }).join('');
    return { batch: batch, html: '<div class="io">' + io(rec.inputsPerTick) + '</div><div class="io" style="margin-top:4px">' + out + '</div>' };
  }
  function recipeCard(b) {
    var BOOK = bookFor(CFG.buildings[b.type]);
    var rec = b.recipe ? BOOK[b.recipe] : null, batch = CFG.tradeWorks.batchByPlot[GEO().ringPlotSize[b.ring]] || 1;
    var h = '<div class="label sec">Recipe</div>';
    if (rec) {
      var adjn = Object.keys(rec.adjacent || {}).map(function (r) { return BOOK[r] ? esc(BOOK[r].name) + ' ×' + rec.adjacent[r] : ''; }).filter(Boolean);
      h += '<div class="optcard on"><div class="top"><b>' + esc(rec.name) + '</b><span class="dim">Tier ' + rec.tier + '</span></div>' + recipeLines(rec, b).html +
        '<div class="dim" style="font-size:11px;margin-top:6px">Batch ×' + batch + ' on a ' + plotName(b.ring) + ' plot</div>' +
        (adjn.length ? '<div class="dim" style="font-size:11px;margin-top:4px">Runs better beside: ' + adjn.join(', ') + '</div>' : '') + '</div>';
      if (b.resetting) h += '<div class="note warn">Resetting: idle for ' + b.resetting + ' more ticks.</div>';
    } else h += CFG.buildings[b.type].freeReset
      ? '<div class="note warn">No recipe chosen · switching is free</div>'
      : '<div class="note warn">No recipe chosen · first pick free, changes cost credits</div>';
    var changing = !!rec;
    if (!b.resetting) {
      h += '<div class="dim" style="font-size:11px;margin:8px 0 4px">' + (changing ? 'Change recipe · costs <b>' + fmt(b.resetFee) + ' cr</b> and ' + CFG.tradeWorks.reset.delayTicks + ' idle ticks' : 'Choose a recipe') + '</div>' +
        Object.keys(BOOK).filter(function (k) { return k !== b.recipe; }).map(function (k) {
          var r = BOOK[k], on = recipePick === k;
          return '<div class="recipe' + (on ? ' sel' : '') + '"><button class="rname" data-act="recpick" data-rec="' + k + '"><b>' + esc(r.name) + '</b><small>T' + r.tier + ' · ' + Object.keys(r.outputsPerTick).map(function (o) { return mp(r.outputsPerTick[o] * batch) + ' ' + esc(CFG.resources[o].name); }).join(', ') + '/t</small></button>' +
            (on ? recipeLines(r, b).html + '<div class="actions"><button class="btn primary" data-act="recset" data-ring="' + b.ring + '" data-slot="' + b.slot + '" data-rec="' + k + '"' + (changing && S.colony.credits < b.resetFee ? ' disabled' : '') + '>' + (changing ? 'Change for ' + fmt(b.resetFee) + ' cr' : 'Lock in this recipe') + '</button></div>' : '') + '</div>';
        }).join('');
    }
    return h;
  }
  // Optional input: off by default; while on and in stock it costs a fixed amount per tick for a bonus.
  function optionalCard(d, b) { return '<div class="label sec">Optional input</div>' + optCard(d.optional, b, b.boost, null); }
  // The expansion class's own optional inputs (housing's households), each switched separately, opening at a level.
  function classOptionsCard(d, b) {
    var cls = d.expand && CFG.expansion.classes[d.expand], os = cls && cls.options;
    if (!os) return '';
    return '<div class="label sec">' + (d.housing ? 'Households' : 'Options') + '</div>' + Object.keys(os).map(function (k) { return optCard(os[k], b, (b.boosts || {})[k] || null, k); }).join('');
  }
  function optCard(o, b, st, key) {
    var on = !!st, working = st === 'on', need = o.unlock && o.unlock.level, locked = need && (b.level || 1) < need;
    var effect = [o.outputMult ? 'Output ×' + o.outputMult : '', o.housingMult ? 'Homes ×' + o.housingMult : '', o.comfort ? 'Comfort +' + o.comfort + ' for these homes' : ''].filter(Boolean).join(' · ');
    var short = Object.keys(o.inputsPerTick).filter(function (r) { return S.resources[r] && S.resources[r].amount < o.inputsPerTick[r]; });
    return '<div class="optcard' + (working ? ' on' : '') + '"><div class="top"><b>' + esc(o.label) + '</b><span class="' + (working ? 'good' : on ? 'warn' : 'dim') + '">' + (locked ? 'Level ' + need : working ? 'Active' : on ? 'Waiting for stock' : 'Off') + '</span></div>' +
      '<div class="dim" style="font-size:12px;margin-bottom:6px">' + esc(o.desc) + '</div>' +
      '<div class="io">' + ioPills({ inputsPerTick: o.inputsPerTick, outputsPerTick: {} }, 1, 1) + '<span class="pill out"><i style="background:var(--good)"></i>' + esc(effect) + '</span></div>' +
      (on && !working ? '<div class="note warn" style="margin:8px 0 0">' + (short.length ? 'Short of ' + short.map(function (r) { return esc(CFG.resources[r].name); }).join(', ') + ' here.' : 'Waiting for the building to run.') + '</div>' : '') +
      (locked ? '' : '<div class="actions"><button class="btn' + (on ? '' : ' primary') + '" data-act="boost" data-ring="' + b.ring + '" data-slot="' + b.slot + '"' + (key ? ' data-opt="' + key + '"' : '') + '>' + (on ? 'Switch off' : 'Switch on') + '</button></div>') + '</div>';
  }
  function nbComfort(r, s) {
    var sum = 0, causes = [];
    neighborsOf(r, s).forEach(function (n) {
      var nb = buildingAt(n[0], n[1]);
      if (nb && nb.status !== undefined && !nb.paused) { var cm = CFG.buildings[nb.type].comfort || 0; if (cm) { sum += cm; causes.push(CFG.buildings[nb.type].name); } }
    });
    return { sum: Math.max(CFG.morale.comfortMin, Math.min(CFG.morale.comfortMax, sum)), causes: causes };
  }
  function adjacentHomes(r, s) {
    return neighborsOf(r, s).filter(function (n) { var nb = buildingAt(n[0], n[1]); return nb && CFG.buildings[nb.type].housing; }).length;
  }
  // What building this would do to the place: the power left over, the new net rate of everything it makes or uses, and
  // whether there are hands for it. It shows the consequence of a choice, at full output; it does not make the choice.
  function afterLine(d, mult) {
    var parts = [], ein = d.inputsPerTick.energy || 0, eout = (d.outputsPerTick.energy || 0) * mult, seen = {};
    if (ein || eout) {
      var spare = S.energy.supply - S.energy.demand + eout - ein;
      parts.push('<span class="' + (spare < -0.05 ? 'bad' : '') + '">Power ' + (spare < -0.05 ? Math.ceil(-spare) + ' short' : Math.floor(spare + 0.05) + ' spare') + '</span>');
    }
    Object.keys(d.outputsPerTick).concat(Object.keys(d.inputsPerTick)).forEach(function (r) {
      if (r === 'energy' || seen[r] || !S.resources[r] || !CFG.resources[r]) return;
      seen[r] = 1;
      var net = S.resources[r].net + (d.outputsPerTick[r] || 0) * mult - (d.inputsPerTick[r] || 0);
      parts.push('<span class="' + (net < -0.05 ? 'bad' : net > 0.05 ? 'good' : '') + '">' + esc(CFG.resources[r].name) + ' ' + rate(net) + '/t</span>');
    });
    var st = S.colony.staffing;
    if (d.workers && st.posts + d.workers > st.workforce + 0.001) parts.push('<span class="warn">' + Math.ceil(st.posts + d.workers - st.workforce) + ' hands short</span>');
    return parts.length ? '<div class="after"><span class="dim">After, at full output:</span> ' + parts.join(' <span class="dim">·</span> ') + '</div>' : '';
  }
  // The build menu sorts what a place offers into a few kinds, so a long list can be cut down with one click.
  var CATS = [['all', 'All'], ['power', 'Power'], ['raw', 'Extraction'], ['make', 'Production'], ['homes', 'Housing'], ['other', 'Support']];
  var CAT_OF = { generator: 'power', extractor: 'raw', refinery: 'make', assembler: 'make', producer: 'make', workshop: 'make', housing: 'homes' };
  function catOf(d) { return CAT_OF[d.type] || 'other'; }
  function buildMenu(r, s, head, old) {
    var dtype = activeD().type;
    var oldDef = old ? bdef(old.type) : null, back = {};
    if (old) Object.keys(oldDef.cost).forEach(function (x) { back[x] = Math.floor(oldDef.cost[x] * CFG.demolishRefund); });
    var full = S.orders.length >= (S.queueMax || 8);
    var keys = Object.keys(CFG.buildings).filter(function (k) {
      var d = bdef(k);
      if (old && k === old.type) return false;
      if ((CFG.buildableIn[dtype] || []).indexOf(k) < 0) return false;
      if (d.hidden === 'orbital' && !(S.orbital && S.orbital.unlocked)) return false; // unknown until the colony is recognised
      if (d.needs && (!field() || [field().common1, field().common2, field().district].indexOf(d.needs) < 0)) return false; // nothing to work on here
      return true;
    });
    var have = {}; keys.forEach(function (k) { have[catOf(bdef(k))] = (have[catOf(bdef(k))] || 0) + 1; });
    var cat = buildCat !== 'all' && have[buildCat] ? buildCat : 'all';
    var h = old
      ? '<div class="label">' + head + '</div><h3 style="margin:4px 0 8px;font-size:15px">Replace ' + esc(oldDef.name) + ' with…</h3>' +
        '<div class="note" style="margin:0 0 10px">' + esc(oldDef.name) + ' runs until its turn, then is scrapped (' + Math.round(CFG.demolishRefund * 100) + '% refund). Build time ×' + CFG.buildQueue.replaceTimeMult + ' · expansions lost.</div>' +
        '<button class="btn block" style="margin-bottom:10px" data-act="replacemode">' + icon('back', 12) + ' Keep ' + esc(oldDef.name) + '</button>'
      : '<div class="label">' + head + ' · empty</div><h3 style="margin:4px 0 10px;font-size:15px">Construct</h3>';
    if (full) h += '<div class="note warn" style="margin:0 0 10px">Work queue full (' + S.orders.length + ').</div>';
    if (Object.keys(have).length > 1 && keys.length > 5) h += '<div class="cats" role="tablist" aria-label="Kind of building">' + CATS.filter(function (c) { return c[0] === 'all' || have[c[0]]; }).map(function (c) {
      return '<button role="tab" data-act="cat" data-cat="' + c[0] + '" aria-selected="' + (cat === c[0]) + '">' + c[1] + '<small>' + (c[0] === 'all' ? keys.length : have[c[0]]) + '</small></button>';
    }).join('') + '</div>';
    h += '<div class="stack">';
    keys.forEach(function (k) {
      var d = bdef(k);
      if (cat !== 'all' && catOf(d) !== cat) return;
      var blocked = null;
      if (d.strictPlot && GEO().ringPlotSize[r] < d.minPlotSize) blocked = 'Needs a ' + plotName2(d.minPlotSize) + ' plot';
      else if (d.requiresAdjacent) {
        var near = neighborsOf(r, s).some(function (n) { var nb = buildingAt(n[0], n[1]); return nb && nb.type === d.requiresAdjacent; });
        if (!S.buildings.some(function (x) { return x.type === d.requiresAdjacent; })) blocked = 'Build the ' + CFG.buildings[d.requiresAdjacent].name + ' first, and let it finish';
        else if (!near) blocked = 'Must stand right beside the ' + CFG.buildings[d.requiresAdjacent].name;
      }
      var owned = S.buildings.filter(function (b) { return b.type === k; }).length + S.orders.filter(function (o) { return (o.kind === 'build' || o.kind === 'replace') && o.data.type === k; }).length;
      var ticks = old ? Math.ceil(d.constructionTicks * CFG.buildQueue.replaceTimeMult) : d.constructionTicks;
      var capped = d.maxCount && owned >= d.maxCount;
      var pv = previewMult(k, r, s);
      var plot = plotMultFor(d, r);
      var notes = '';
      if (pv.parts.length) {
        notes += '<div class="bonus ' + (pv.mult > 1 ? 'good' : 'bad') + '">Adjacency ×' + pv.mult.toFixed(2) + ' · ' +
          pv.parts.map(function (p) { return esc(CFG.buildings[p.type].name); }).join(', ') + '</div>';
      }
      if (d.minPlotSize > 1) {
        notes += plot < 0.999
          ? '<div class="bonus bad">Wants a ' + plotName2(d.minPlotSize) + ' plot · this one is ' + plotName(r) + ' · output ×' + plot.toFixed(2) + '</div>'
          : '<div class="bonus good">Wants a ' + plotName2(d.minPlotSize) + ' plot · fits</div>';
      }
      if (d.optional) notes += '<div class="bonus" style="color:var(--dim)">Optional: ' + esc(d.optional.label) + ' (' + Object.keys(d.optional.inputsPerTick).map(function (x) { return d.optional.inputsPerTick[x] + ' ' + CFG.resources[x].name + '/t'; }).join(', ') + ')</div>';
      if (d.housing) {
        var cc = nbComfort(r, s);
        notes += '<div class="bonus ' + (cc.sum > 0 ? 'good' : cc.sum < 0 ? 'bad' : '') + '">Comfort here: ' + (cc.sum > 0 ? '+' : cc.sum < 0 ? '−' : '') + Math.abs(cc.sum) + (cc.causes.length ? ' · ' + cc.causes.map(esc).join(', ') : ' · quiet') + '</div>';
      } else if (d.comfort) {
        var hm = adjacentHomes(r, s);
        if (hm) notes += '<div class="bonus ' + (d.comfort < 0 ? 'bad' : 'good') + '">' + hm + ' adjacent home' + (hm === 1 ? '' : 's') + ' would feel ' + (d.comfort > 0 ? '+' : '−') + Math.abs(d.comfort) + ' comfort</div>';
      }
      if (blocked) notes = '<div class="bonus bad">' + esc(blocked) + '</div>' + notes;
      h += '<button class="opt" data-act="' + (old ? 'replace' : 'build') + '" data-type="' + k + '"' + (capped || blocked || full ? ' disabled' : '') + ' style="--c:' + d.color + '">' +
        '<div class="top">' + icon(k, 20) + '<b>' + esc(d.name) + '</b><small>' + ticks + ' ticks</small></div>' +
        (capped ? '<div class="warn" style="font-size:11px">Already built: only ' + d.maxCount + ' allowed</div>' :
          '<div class="io">' + Object.keys(d.cost).map(function (c) { return pill(c, d.cost[c], S.resources[c].amount + (back[c] || 0) < d.cost[c] ? 'no' : ''); }).join('') + '</div>') +
        '<div class="io" style="margin-top:6px;opacity:.85">' + ioPills(d, 1, pv.mult * plot) +
        (d.workers ? '<span class="pill"><i style="background:#a3b8cc"></i>Crew ' + d.workers + '</span>' : '') +
        (d.housing ? '<span class="pill out"><i style="background:#a3b8cc"></i>' + Math.floor(d.housing * plot) + ' homes</span>' : '') +
        (d.storageBonus ? pill('scrap', '+' + fmt(d.storageBonus * plot) + ' storage') : '') +
        (d.defense ? '<span class="pill out"><i style="background:var(--bad)"></i>Defence ' + (d.defense * plot).toFixed(1) + '</span>' : '') +
        (d.transmit ? '<span class="pill out"><i style="background:#fff"></i>Signal ' + plot.toFixed(2) + ' / tick</span>' : '') + '</div>' + (capped || blocked ? '' : afterLine(d, pv.mult * plot) + queueNote(d.cost, back)) + notes + '</button>';
    });
    return h + '</div>';
  }

  // ---- Brief: doom clock + directives ----------------------------------------
  function span(n) { return n + ' tick' + (n === 1 ? '' : 's') + ' <span class="dim">(' + clock(n * S.tickMs) + ')</span>'; }
  function names(list) { return list.map(function (r) { return CFG.resources[r].name; }).join(', '); }
  function doomCard() {
    var d = S.doom;
    if (d && d.phase === 'shutdown') {
      var pk = S.colony.parked;
      return '<div class="doom warn"><div class="label">Shutdown</div><div class="big warn">COLONY SHUT DOWN</div>' +
        '<div>' + (pk ? pk + ' building' + (pk === 1 ? ' is' : 's are') + ' parked. Only the essentials are running.' : 'Everything is running again, but the colony is still recovering.') + '</div>' +
        (pk ? '<div class="actions" style="margin-top:10px"><button class="btn primary" data-act="resumeOps">Restart parked buildings (' + pk + ')</button></div>' : '') + '</div>';
    }
    if (!d) {
      return '<div class="doom ok"><div class="label">Collapse clock</div><div class="big good">STABLE</div>' +
        '<div class="dim">Nothing critical is draining.</div></div>';
    }
    var urgent = d.phase === 'starving' || d.ticks <= 20, cls = urgent ? 'bad' : d.ticks <= 40 ? 'warn' : '';
    var h = '<div class="doom ' + cls + '"><div class="label">Collapse clock</div><div class="big ' + cls + '">' + span(d.ticks) + '</div>';
    if (d.phase === 'starving') {
      h += '<div>Shortage of ' + esc(names(d.resources)) + '. Morale is falling every tick.</div>';
    } else {
      h += '<div>First shortage in ' + span(d.untilShortage) + ', then morale runs out.</div><div class="drain">';
      d.draining.forEach(function (x) {
        h += '<span class="pill"><i style="background:' + CFG.resources[x.resource].color + '"></i>' + esc(CFG.resources[x.resource].name) + ' ' + x.ticks + 't</span>';
      });
      h += '</div>';
    }
    return h + '<div class="dim" style="margin-top:6px;font-size:11px">At current rates. Change the rates, change the clock.</div></div>';
  }
  var TIMING_LABEL = { ok: 'On track', tight: 'Tight', late: 'Behind schedule', blocked: 'Blocked' };
  function timingLine(tm) {
    if (!tm) return '';
    if (tm.kind === 'convoy') return '<div class="tm">Next convoy in ' + span(tm.ticks) + '</div>';
    if (tm.kind === 'eta') {
      if (tm.affordable) return '<div class="tm good">Within your means right now</div>';
      if (tm.ticks === null) return '<div class="tm warn">No income yet of ' + esc(names(tm.blocked)) + '</div>';
      return '<div class="tm">Affordable in ~' + span(tm.ticks) + ' at current income</div>';
    }
    if (tm.stockTicks === null) return '';
    var h = '<div class="tm"><span class="st ' + tm.status + '">' + TIMING_LABEL[tm.status] + '</span> Stock lasts ~' + tm.stockTicks + ' ticks';
    if (tm.lead !== null) h += '; earliest finish ~' + tm.lead + ' ticks';
    else if (tm.blocked.length) h += '; waiting on ' + esc(names(tm.blocked));
    return h + '</div>';
  }
  function effectBlock(z) {
    var h = '';
    if (z.penalty.length) h += '<div class="bad" style="margin-top:6px">' + z.penalty.map(esc).join('<br>') + '</div>';
    if (z.cost.length) h += '<div class="warn" style="margin-top:6px">' + z.cost.map(esc).join('<br>') + '</div>';
    return h;
  }
  function shortfalls(z) {
    return z.requirements.filter(function (r) { return r.kind === 'stock' && r.have < r.need; });
  }
  function threatCard() {
    var z = S.hazard;
    if (!z) return '';
    var h;
    if (z.state === 'active') {
      var rough = z.severity > 0.02;
      var mk = S.coreBuildings.filter(function (b) { return b.mark; }).length;
      return '<div class="threat ' + (rough ? 'bad' : 'warn') + '"><div class="label">' + (rough ? 'Hazard in effect' : 'Hazard weathered, costs continue') + '</div><div class="big ' + (rough ? 'bad' : '') + '">' + esc(z.name) + '</div>' +
        '<div class="dim">' + Math.round(z.prep * 100) + '% prepared · ends in ' + span(z.ticksLeft) + '</div>' + effectBlock(z) +
        (mk ? '<div class="dim" style="margin-top:6px">' + mk + ' structure' + (mk === 1 ? ' is' : 's are') + ' affected and marked on the map.</div>' : '') + '</div>';
    }
    var marked = S.coreBuildings.filter(function (b) { return b.mark; }).length;
    var ready = z.prep >= 0.98, cls = ready ? 'good' : z.prep < 0.5 ? 'bad' : 'warn';
    h = '<div class="threat ' + cls + '"><div class="label">Incoming hazard</div><div class="big">' + esc(z.name) + '</div>' +
      '<div>Strikes in ' + span(z.ticksUntil) + ' and lasts ' + z.durationTicks + ' ticks.</div><div class="dim" style="margin:4px 0 8px">' + esc(z.desc) + '</div>';
    z.requirements.forEach(function (r) {
      h += '<div class="req"><div class="row"><span>' + esc(r.label) + '</span><span class="num ' + (r.frac >= 0.999 ? 'good' : '') + '">' + fmt(r.have) + ' / ' + fmt(r.need) + '</span></div>' +
        '<div class="meter"><i style="width:' + (r.frac * 100).toFixed(0) + '%;background:' + (r.frac >= 0.999 ? 'var(--good)' : 'var(--warn)') + '"></i></div></div>';
    });
    h += '<div style="margin-top:8px"><b>' + Math.round(z.prep * 100) + '% prepared.</b> ' + (ready ? 'Still costs:' : 'If it struck now:') + '</div>' + effectBlock(z);
    if (z.shield) {
      var sh = z.shield, short = sh.have < sh.need;
      h += '<div class="shield' + (sh.enabled ? ' on' : '') + '"><div><b>Deploy ' + sh.need + ' ' + esc(CFG.resources[sh.resource].name) + '</b><div class="dim" style="font-size:11px">Blocks this hazard; spent when it lands. In the Core: ' + sh.have + (short ? ' <span class="warn">(not enough yet)</span>' : '') + '</div></div>' +
        '<button class="btn' + (sh.enabled ? '' : ' primary') + '" data-act="shield">' + (sh.enabled ? 'Stand down' : 'Deploy') + '</button></div>';
    }
    var sf = shortfalls(z);
    if (sf.length) h += '<div class="actions" style="margin-top:10px"><button class="btn" data-act="xprefill">' + icon('truck', 12) + ' Order express resupply</button></div>';
    if (marked) h += '<div class="dim" style="margin-top:6px">' + marked + ' structure' + (marked === 1 ? ' is' : 's are') + ' in its path (dashed marker on the map).</div>';
    return h + '<div class="dim" style="margin-top:8px;font-size:11px">Reserves are spent automatically, even while you are away.</div></div>';
  }

  function briefTab() {
    var ds = S.brief.directives, done = ds.filter(function (d) { return d.done; }).length;
    if (!S.brief.remaining) return threatCard() + doomCard() + '<div class="note good" style="margin-top:16px">All ' + ds.length + ' directives complete.</div>';
    var h = threatCard() + doomCard() + '<div class="p-title" style="margin-top:16px"><h3>Directives</h3><span class="dim num" style="margin-left:auto">' + done + ' / ' + ds.length + '</span></div>' +
      '<div class="meter" style="margin:4px 0 10px"><i style="width:' + (done / ds.length * 100).toFixed(0) + '%;background:var(--amber)"></i></div>';
    // Finished directives fold away under one line; only the current one carries its hint, the rest show a title and progress.
    var row = function (d) {
      var r = '<div class="dir' + (d.done ? ' done' : '') + (d.current ? ' current' : '') + '"><span class="tick">' + icon('check', 11) + '</span><div class="body"><b>' + esc(d.title) + '</b>';
      if (!d.done) {
        if (d.current) r += '<div class="hint">' + esc(d.hint) + '</div>' + timingLine(d.timing);
        if (d.progress) r += '<div class="meter" style="margin-top:6px"><i style="width:' + (d.progress.value / d.progress.max * 100).toFixed(0) + '%;background:var(--good)"></i></div><div class="tm num">' + d.progress.value + ' / ' + d.progress.max + '</div>';
      }
      return r + '</div></div>';
    };
    if (done) h += '<details class="howto" data-how="briefdone"' + (HOW.briefdone ? ' open' : '') + '><summary>' + done + ' done</summary><div>' + ds.filter(function (d) { return d.done; }).map(row).join('') + '</div></details>';
    var chapterShown = false;
    ds.filter(function (d) { return !d.done; }).forEach(function (d) {
      if (d.chapter === 2 && !chapterShown) { chapterShown = true; h += '<div class="label sec" style="color:#90e0ef">' + esc((CFG.ui && CFG.ui.chapterTwo) || 'Chapter two: orbit') + '</div>'; }
      h += row(d);
    });
    return h + '<div class="dim" style="margin-top:14px;font-size:11px">Directives point at what is missing, not how to fix it.</div>';
  }

  // Upgrades cost less while a settlement's builders are helping: the same rounding the server uses.
  function dcost(cost) {
    var d = S.settlements && S.settlements.effects ? S.settlements.effects.discount : 0, o = {};
    if (!cost || !d) return cost;
    Object.keys(cost).forEach(function (r) { o[r] = Math.max(1, Math.ceil(cost[r] * (1 - d) - 1e-9)); });
    return o;
  }
  function dlevel(lv) { return lv && lv.upgradeCost ? Object.assign({}, lv, { upgradeCost: dcost(lv.upgradeCost) }) : lv; }
  function discountNote() {
    var d = S.settlements && S.settlements.effects ? S.settlements.effects.discount : 0;
    return d ? '<div class="bonus good">Settlement builders: ' + (d * 100).toFixed(1).replace(/\.0$/, '') + '% off this upgrade</div>' : '';
  }
  function upgradeLabel(cost) { return slotFree() && canAfford(cost) ? 'Begin upgrade' : 'Queue upgrade'; }
  // The hub's build slots: how many orders run side by side here, and the next slot it can buy.
  function slotsCard() {
    var sl = S.slots;
    if (!sl || sl.max <= 1) return '';
    var core = activeD().core;
    var h = '<div class="label sec">Build slots</div><p class="p-desc" style="margin:0 0 8px">' +
      (sl.count === 1 ? 'One order at a time.' : '<b>' + sl.count + '</b> orders at once.') + ' The queue still runs in order.</p>';
    if (!sl.next) return h + '<div class="note good">Every build slot is open.</div>';
    var n = sl.next, gated = S.colony.hubLevel < n.coreLevel, cash = S.colony.credits >= n.credits, ok = canAfford(n.cost) && cash;
    h += '<div class="opt" style="cursor:default"><div class="top"><b>Build slot ' + n.slots + '</b><small>takes effect at once</small></div>' +
      '<div class="io">' + costPills(n.cost, S.resources) + (n.credits ? '<span class="pill ' + (cash ? '' : 'no') + '" style="--c:var(--amber)"><i></i>' + fmt(n.credits) + ' cr</span>' : '') + '</div>' +
      '<div class="dim" style="font-size:11px;margin-top:8px">Runs one more order at once. Paid from ' + (core ? 'the Core' : '<b>this</b> district') + ' and credits.</div></div>';
    if (gated) return h + '<div class="note warn">Build slot ' + n.slots + ' opens at hub level ' + n.coreLevel + '.</div>';
    return h + '<div class="actions"><button class="btn ' + (confirmKey === 'bslot' ? 'danger' : 'primary') + '" data-act="bslot" data-key="bslot"' + (ok ? '' : ' disabled') + '>' +
      (confirmKey === 'bslot' ? 'Confirm: add build slot ' + n.slots : 'Add build slot ' + n.slots) + '</button></div>';
  }
  function upgradeNote(up) {
    if (up.state === 'queued') return '<div class="note">Queued #' + up.pos + '.' + waitingLine(up) + '<div class="actions" style="margin-top:8px">' + queueBtns(up) + '</div></div>';
    return '<div class="note">Upgrade in progress: ' + up.remaining + ' ticks remaining. <a href="#" data-act="cancel" data-id="' + up.id + '" style="color:var(--amber)">Cancel</a></div>';
  }
  function upkeepPills(up) {
    var h = '';
    Object.keys(up || {}).forEach(function (r) { h += pill(r, up[r], 'in'); });
    return h || '<span class="dim">None</span>';
  }
  function hubTab() {
    var c = S.colony, lv = CFG.hubLevels[c.hubLevel], next = dlevel(CFG.hubLevels[c.hubLevel + 1]);
    var slots = function (l) { return Object.keys(l.ringCapacities).reduce(function (a, k) { return a + l.ringCapacities[k]; }, 0); };
    var h = stockSwitch() + '<div class="p-title">' + icon('hub', 22) + '<h3>Command Hub · Level ' + c.hubLevel + '</h3></div>' +
      '<dl class="kv"><dt>Storage per resource</dt><dd>' + fmt(S.hub.maxStorage) + (S.hub.maxStorage > S.hub.baseStorage ? ' <span class="dim">(' + fmt(S.hub.baseStorage) + ' + warehouses)</span>' : '') + '</dd>' +
      '<dt>Hub quarters</dt><dd>' + lv.baseHousing + ' people</dd>' +
      '<dt>Hub power</dt><dd class="' + (S.hub.eff < 0.999 ? 'bad' : '') + '">' + S.hub.power.toFixed(0) + (lv.upkeepPerTick && lv.upkeepPerTick.energy ? ' <span class="dim">(' + lv.baseEnergy + ' base − ' + lv.upkeepPerTick.energy + ' upkeep)</span>' : '') + '</dd>' +
      '<dt>Rings online</dt><dd>' + Object.keys(lv.ringCapacities).length + ' (' + slots(lv) + ' slots)</dd>' +
      '<dt>Defence</dt><dd>' + S.defense.toFixed(1) + '</dd></dl>';
    var st = c.staffing, ho = c.housing, mi = c.moraleInfo, sg = function (v) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1); };
    h += '<div class="label sec">Population &amp; morale</div><dl class="kv">' +
      '<dt>People</dt><dd>' + c.population + ' / ' + ho.cap + ' <span class="dim">(quarters ' + ho.base + (ho.built ? ' + homes ' + Math.floor(ho.built) : '') + ')</span></dd>' +
      '<dt>Crew</dt><dd class="' + (st.ratio < 0.999 ? 'warn' : '') + '">' + Math.floor(st.workforce) + ' hands for ' + Math.ceil(st.posts) + ' posts' + (st.commuters ? ' · ' + st.commuters + ' commute in' : '') + (st.ratio < 0.999 ? ' · ×' + st.ratio.toFixed(2) + ' output' : '') + '</dd>' +
      '<dt>Morale</dt><dd>' + Math.round(c.morale) + ' <span class="dim">→ target ' + Math.round(mi.target) + '</span></dd>' +
      '<dt>Target is</dt><dd class="dim">base ' + mi.base + ' · homes ' + sg(mi.comfort) + ' · meals ' + sg(mi.meals) + '</dd>' +
      '<dt>Fed meals</dt><dd>' + pct(mi.mealCoverage) + ' of people</dd>' +
      '<dt>Output effect</dt><dd class="' + (mi.productivity < 0.999 ? 'bad' : mi.productivity > 1.001 ? 'good' : 'dim') + '">×' + mi.productivity.toFixed(2) + '</dd></dl>' +
      (st.ratio < 0.999 ? '<div class="note warn">Short of hands: staffed buildings run slower.</div>' : '') +
      (c.population >= ho.cap - 1 ? '<div class="note">Housing full.</div>' : '');
    if (lv.upkeepPerTick) {
      h += '<div class="label sec">Hub upkeep per tick</div><div class="io">' + upkeepPills(lv.upkeepPerTick) + '</div>' +
        (S.hub.eff < 0.999 ? '<div class="note bad">Upkeep unmet: hub at ' + pct(S.hub.eff) + ', power cut. Short of ' + esc(CFG.resources[S.hub.limiting].name) + '.</div>'
          : '');
    }
    h += '<div class="label sec">Hub upgrade</div>';
    if (!next) h += '<div class="note good">The hub is fully upgraded.</div>';
    else {
      var up = S.orders.filter(function (o) { return o.kind === 'upgrade'; })[0], nl = c.hubLevel + 1;
      h += '<div class="opt" style="cursor:default"><div class="top"><b>Level ' + nl + '</b><small>' + next.upgradeTicks + ' ticks</small></div>' +
        '<div class="io">' + Object.keys(next.upgradeCost).map(function (r) { return pill(r, next.upgradeCost[r], S.resources[r].amount < next.upgradeCost[r] ? 'no' : ''); }).join('') + '</div>' +
        '<div class="dim" style="font-size:11px;margin-top:8px">Unlocks ring ' + nl + ' (' + plotName(nl) + ' plots, ' + CFG.rings[nl] + ' slots) · storage ' + fmt(next.maxStorage) + ' · hub quarters ' + next.baseHousing + ' · base power ' + next.baseEnergy + '</div>' +
        (next.upkeepPerTick ? '<div class="label" style="margin-top:8px">Upkeep after upgrade</div><div class="io" style="margin-top:4px">' + upkeepPills(next.upkeepPerTick) + '</div>' : '') + '</div>';
      h += discountNote() + (up ? upgradeNote(up) : '<div class="actions"><button class="btn primary" data-act="upgrade">' + upgradeLabel(next.upgradeCost) + '</button></div>' + queueNote(next.upgradeCost));
    }
    h += slotsCard();
    var bc = S.buildings.filter(function (b) { return CFG.buildings[b.type].transmit; })[0];
    var bo = S.orders.filter(function (o) { return o.kind === 'build' && CFG.buildings[o.data.type].transmit; })[0];
    h += '<div class="label sec">Mission: the Beacon</div>';
    var prog = Math.min(1, c.progress / CFG.transmitTicks);
    h += '<div class="goal ' + (bc ? 'done' : '') + '"><span class="tick">' + icon('check', 11) + '</span><span>' + (bc ? 'Beacon Array built' : bo ? 'Beacon Array under construction' : 'Build the Beacon Array') + '</span></div>' +
      '<div class="goal ' + (c.won ? 'done' : '') + '"><span class="tick">' + icon('check', 11) + '</span><span>Transmit <span class="dim num">(' + Math.floor(c.won ? CFG.transmitTicks : c.progress) + ' / ' + CFG.transmitTicks + ')</span></span></div>' +
      '<div class="meter" style="margin:4px 0 8px"><i style="width:' + (prog * 100).toFixed(0) + '%;background:var(--good)"></i></div>';
    if (c.won) h += '<div class="note good">The Beacon\'s message got through. Settlements and the Free Port are open.</div>';
    return h;
  }

  // ---- districts -------------------------------------------------------------
  function costPills(cost, have) {
    return Object.keys(cost).map(function (r) { return pill(r, cost[r], have[r].amount < cost[r] ? 'no' : ''); }).join('');
  }
  // Routes, shipments, the exchange and missions only deal with surface districts; the station and territories have their own links.
  function groundDs() { return S.districts.filter(function (d) { return !d.orbital; }); }
  // Which goods the shipment and route forms offer: whatever the source holds, everything the colony has reached, the Free
  // Port's trade goods once it stands, and the orbital goods once there is a station (they come down to the Core by link or
  // express drop and go on from there, for the expansions past level 5).
  function logisticsGood(r, held) {
    var def = CFG.resources[r];
    if (held || !def.showFromHub || def.showFromHub <= S.colony.hubLevel + 1) return true;
    return !!((def.trade && S.freeport) || (def.orbitalTrade && stationId() !== null));
  }
  // (the district of a type: the original one, never a copy Headquarters discovered)
  function districtOf(type) { return S.districts.filter(function (d) { return d.type === type && !d.discovery; })[0]; }
  function shipTime(a, b) {
    var d = function (x) { return x.core ? 0 : x.distance; };
    return Math.max(1, d(a) + d(b));
  }
  // Where the view can go: the surface districts, then the station and any territory a dropship is in. Shown as tabs over
  // the map on a desk and as a list behind the place button on a phone. A place that has something to do pulses.
  var visited = {};
  function placeItems() {
    var out = [], found = readyFlags().found;
    S.districts.filter(function (d) { return !d.orbital; }).forEach(function (d) {
      var t = d.core ? null : CFG.districtTypes[d.type], fresh = !d.core && !visited[d.id];
      out.push({ group: 'Surface', on: d.id === activeId, name: d.core ? 'Core' : d.name.replace(/^The /, ''), full: d.name, small: 'L' + d.level, color: t ? t.color : 'var(--amber)', cls: fresh ? ' new' : '', tag: fresh ? 'NEW' : '',
        note: d.core ? 'The colony itself' : d.buildings + ' structure' + (d.buildings === 1 ? '' : 's'), act: 'data-act="enter" data-id="' + d.id + '"' });
    });
    if (S.districtsUnlocked) out.push({ group: 'Surface', add: true, name: 'Found', full: 'Found a district', color: 'var(--good)', cls: ' add' + (found ? ' pulse' : ''), tag: found ? 'READY' : '', note: 'Start a new district', act: 'data-act="tab" data-tab="districts"' });
    if (stationId() !== null) {
      S.districts.filter(function (d) { return d.orbital; }).forEach(function (d) {
        var t = CFG.orbitalTypes[d.type];
        out.push({ group: 'Orbit', on: d.id === activeId, name: d.type === 'station' ? 'Station' : d.name, full: d.name, small: d.type === 'station' ? 'L' + d.level : '', color: t.color, cls: ' orbit',
          note: d.type === 'station' ? d.name : 'Territory · a dropship is down here', act: 'data-act="enter" data-id="' + d.id + '"' });
      });
      out.push({ group: 'Orbit', add: true, name: 'Deploy', full: 'Send a dropship to a territory', color: '#f2a7ff', cls: ' add', note: 'Send a dropship to a territory', act: 'data-act="tab" data-tab="oterr"' });
    }
    return out;
  }
  // Remembered per player in this browser, so a district is NEW only until it is first looked at (not again after every reload).
  // The first time, everything already founded counts as seen.
  var visitedLoaded = false;
  function renderPlaces() {
    if (!visitedLoaded) {
      visitedLoaded = true;
      var vs = storeGet('visited:' + S.user);
      if (vs === null) { S.districts.forEach(function (x) { visited[x.id] = true; }); storeSet('visited:' + S.user, Object.keys(visited).join(',')); }
      else vs.split(',').forEach(function (id) { if (id) visited[id] = true; });
    }
    if (!visited[activeId]) { visited[activeId] = true; storeSet('visited:' + S.user, Object.keys(visited).join(',')); }
    var d = activeD();
    if (MOBILE) {
      var t = d.core ? null : (CFG.districtTypes[d.type] || CFG.orbitalTypes[d.type]), todo = placeItems().some(function (p) { return p.tag; });
      var bh = '<i style="background:' + (t ? t.color : 'var(--amber)') + '"></i><span class="pb-t"><small>' + (d.type === 'territory' ? 'Territory' : d.orbital ? 'Orbit' : 'Surface') + '</small><b>' + esc(d.core ? 'The Core' : d.name) + '</b></span>' +
        '<span class="pb-l">L' + d.level + '</span>' + (todo ? '<span class="dotb good"></span>' : '') + icon('chev', 14);
      var pb = $('place-btn'); if (pb.dataset.h !== bh) { pb.innerHTML = bh; pb.dataset.h = bh; }
      return;
    }
    // Desk: one place group at a time. With a station there is a Surface / Orbit switch (it moves the view, like the tabs do);
    // the tabs scroll sideways under the hood, and arrows appear only when some of them are out of sight.
    var h = '', items = placeItems(), grp = d.orbital ? 'Orbit' : 'Surface';
    if (S.districtsUnlocked || stationId() !== null) {
      if (stationId() !== null) {
        var other = items.some(function (p) { return p.group !== grp && p.tag; });
        h += '<div class="pswitch" role="group" aria-label="Surface or orbit">' + [['Surface', groundD().id], ['Orbit', stationId()]].map(function (g) {
          var cur = g[0] === grp;
          return '<button class="' + (cur ? 'on' : '') + '" aria-pressed="' + cur + '"' + (cur ? '' : ' data-act="enter" data-id="' + g[1] + '"') + '>' + g[0] + (!cur && other ? '<span class="dotb good"></span>' : '') + '</button>';
        }).join('') + '</div>';
      }
      h += '<div class="pscroll"><button class="parr l" data-pscroll="-1" aria-label="Scroll left" tabindex="-1">' + icon('chev', 14) + '</button><div class="pstrip" role="tablist" aria-label="' + grp + ' places">' +
        items.filter(function (p) { return p.group === grp; }).map(function (p) {
          return '<button class="ptab' + (p.on ? ' on' : '') + p.cls + '" role="tab" aria-selected="' + !!p.on + '" ' + p.act + ' title="' + esc(p.full) + '" style="--c:' + p.color + '"><i></i><span>' + esc(p.name) + '</span>' +
            (p.small ? '<small>' + p.small + '</small>' : '') + (p.tag ? '<em>' + p.tag + '</em>' : '') + '</button>';
        }).join('') + '</div><button class="parr r" data-pscroll="1" aria-label="Scroll right" tabindex="-1">' + icon('chev', 14) + '</button></div>';
    }
    var el = $('places');
    if (el.dataset.h !== h) {
      var st0 = el.querySelector('.pstrip'), left = st0 ? st0.scrollLeft : 0;
      el.innerHTML = h; el.dataset.h = h;
      var strip = el.querySelector('.pstrip');
      if (strip) {
        strip.scrollLeft = left;
        var on = strip.querySelector('.ptab.on'); if (on && strip.scrollWidth > strip.clientWidth) strip.scrollLeft = clamp(on.offsetLeft - (strip.clientWidth - on.offsetWidth) / 2, 0, strip.scrollWidth);
        strip.addEventListener('scroll', placeArrows, { passive: true });
      }
    }
    el.hidden = !h;
    placeArrows();
  }
  // The arrows show only on a side where tabs are hidden.
  function placeArrows() {
    var el = $('places'), strip = el && el.querySelector('.pstrip'); if (!strip) return;
    var max = strip.scrollWidth - strip.clientWidth;
    el.querySelector('.parr.l').classList.toggle('show', strip.scrollLeft > 2);
    el.querySelector('.parr.r').classList.toggle('show', strip.scrollLeft < max - 2);
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-pscroll]'); if (!b) return;
    var strip = $('places').querySelector('.pstrip');
    strip.scrollBy({ left: +b.dataset.pscroll * Math.max(120, strip.clientWidth * 0.7), behavior: 'smooth' });
  });
  window.addEventListener('resize', function () { if (S && !MOBILE) placeArrows(); });
  function districtMap() {
    var h = '<svg class="dmap" viewBox="' + ((S.discoveries || []).length ? '-160 -140 320 290' : '-110 -90 220 180') + '" role="img" aria-label="District map">';
    var nodes = [{ id: S.districts[0].id, core: true, x: 0, y: 0, color: '#ff9f1c', name: 'Core', level: S.colony.hubLevel, on: true }];
    Object.keys(CFG.districtTypes).forEach(function (k) {
      if (!districtOf(k) && !S.foundable[k]) return; // districts that cannot be founded yet stay off the map
      var t = CFG.districtTypes[k], d = districtOf(k), a = t.angle * Math.PI / 180, r = t.radius * 80;
      var f = S.founding.filter(function (x) { return x.type === k && !x.discovery; })[0];
      nodes.push({ id: d ? d.id : null, type: k, x: r * Math.cos(a), y: r * Math.sin(a), color: t.color, name: t.name.replace(/^The /, ''), level: d ? d.level : 0, on: !!d, building: !!f });
    });
    // districts Headquarters discovered sit further out, on a ring of their own
    (S.discoveries || []).forEach(function (x) {
      var t = CFG.districtTypes[x.type], a = x.angle * Math.PI / 180, r = 1.3 * 80, d = x.districtId ? S.districts.filter(function (y) { return y.id === x.districtId; })[0] : null;
      nodes.push({ id: d ? d.id : null, type: x.type, x: r * Math.cos(a), y: r * Math.sin(a), color: t.color, name: x.name.replace(/^The /, ''), level: d ? d.level : 0, on: !!d, building: !!x.founding });
    });
    nodes.slice(1).forEach(function (n) { h += '<line x1="0" y1="0" x2="' + n.x.toFixed(1) + '" y2="' + n.y.toFixed(1) + '" class="dlink' + (n.on ? ' on' : '') + '"/>'; });
    nodes.forEach(function (n) {
      var act = n.on ? ' data-act="enter" data-id="' + n.id + '" tabindex="0" role="button"' : '';
      h += '<g class="dnode' + (n.on ? ' on' : n.building ? ' building' : '') + (n.id === activeId ? ' sel' : '') + '"' + act + ' style="--c:' + n.color + '" transform="translate(' + n.x.toFixed(1) + ' ' + n.y.toFixed(1) + ')">' +
        '<circle r="' + (n.core ? 17 : 14) + '"/><text y="3" class="lv">' + (n.on ? 'L' + n.level : n.building ? '…' : '?') + '</text><text y="' + (n.core ? 30 : 27) + '" class="nm">' + esc(n.name) + '</text></g>';
    });
    return h + '</svg>';
  }
  function districtsTab() {
    if (!S.districtsUnlocked) {
      return '<div class="empty-state">' + icon('lock', 36) + '<div>Districts open at hub level ' + CFG.districtProgression.unlockCoreLevel + '.</div></div>' +
        '<div class="note">Out past the rings there is ground worth holding: satellite bases with their own stockpile and power grid, producing what the Core cannot.</div>';
    }
    var h = districtMap() + howTo('districts', 'Each district has its <b>own stockpile and power grid</b>. People, crew and morale are shared. Founding is paid from the Core; upgrades are paid from the district itself, so goods have to be shipped in.');
    Object.keys(CFG.districtTypes).forEach(function (k) {
      var t = CFG.districtTypes[k], d = districtOf(k), f = S.founding.filter(function (x) { return x.type === k && !x.discovery; })[0];
      h += '<div class="dcard" style="--c:' + t.color + '"><div class="top"><b>' + esc(t.name) + '</b>' + (d ? '<small>Level ' + d.level + ' · ' + d.buildings + ' structure' + (d.buildings === 1 ? '' : 's') + '</small>' : '') + '</div>' +
        '<div class="dim" style="font-size:12px;margin-bottom:8px">' + esc(t.desc) + '</div>';
      if (d) {
        h += '<div class="dim" style="font-size:11px;margin-bottom:6px">Link ' + d.link.load + ' / ' + d.link.capacity + ' per tick · ' + t.distance + ' ticks from the Core</div><div class="actions"><button class="btn' + (d.id === activeId ? '' : ' primary') + '" data-act="enter" data-id="' + d.id + '"' + (d.id === activeId ? ' disabled' : '') + '>' + (d.id === activeId ? 'Viewing' : 'Enter district') + '</button></div>';
      } else if (f) {
        h += '<div class="note">' + (f.queued ? 'Queued in the Core.' : 'Founding: ' + f.remaining + ' t left.') + ' <a href="#" data-act="cancel" data-id="' + f.id + '" style="color:var(--amber)">Cancel</a></div>';
      } else {
        if (!S.foundable[k]) { h += '<div class="note">' + (t.requires && t.requires.beaconBuilt ? 'Opens once the Beacon is built.' : 'Not available yet.') + '</div></div>'; return; }
        h += '<div class="label">Founding cost (from the Core) · ' + t.foundTicks + ' ticks</div><div class="io">' + costPills(t.foundCost, S.coreRes) + '</div>' +
          '<div class="actions"><button class="btn primary" data-act="found" data-type="' + k + '">' + (canAffordCore(t.foundCost) ? 'Found ' : 'Queue founding ') + esc(t.name) + '</button></div>' +
          (canAffordCore(t.foundCost) ? '' : '<div class="dim" style="font-size:11px;margin-top:6px">The Core is short: it will wait in the queue.</div>');
      }
      h += '</div>';
    });
    if ((S.discoveries || []).length) {
      h += '<div class="label sec">Discovered by Headquarters</div>';
      S.discoveries.forEach(function (x) {
        var t = CFG.districtTypes[x.type], d = x.districtId ? S.districts.filter(function (y) { return y.id === x.districtId; })[0] : null, f = x.founding;
        h += '<div class="dcard" style="--c:' + t.color + '"><div class="top"><b>' + esc(x.name) + '</b><small>' + (d ? 'Level ' + d.level + ' · ' : '') + 'a ' + esc(t.name.replace(/^The /, '')) + ' · ' + x.distance + ' ticks from the Core</small></div>';
        if (d) h += '<div class="actions"><button class="btn' + (d.id === activeId ? '' : ' primary') + '" data-act="enter" data-id="' + d.id + '"' + (d.id === activeId ? ' disabled' : '') + '>' + (d.id === activeId ? 'Viewing' : 'Enter district') + '</button></div>';
        else if (f) h += '<div class="note">' + (f.queued ? 'Queued in the Core.' : 'Founding: ' + f.remaining + ' t left.') + ' <a href="#" data-act="cancel" data-id="' + f.id + '" style="color:var(--amber)">Cancel</a></div>';
        else if (!S.foundable[x.type]) h += '<div class="note">' + (t.requires && t.requires.beaconBuilt ? 'Opens once the Beacon is built.' : 'Not available yet.') + '</div>';
        else h += '<div class="label">Founding cost (from the Core) · ' + t.foundTicks + ' ticks</div><div class="io">' + costPills(t.foundCost, S.coreRes) + '</div>' +
          '<div class="actions"><button class="btn primary" data-act="found" data-discovery="' + x.id + '">' + (canAffordCore(t.foundCost) ? 'Found ' : 'Queue founding ') + esc(x.name) + '</button></div>';
        h += '</div>';
      });
    }
    return h;
  }
  function shipmentsBlock() {
    var h = '';
    if (groundDs().length > 1) {
      var ds = groundDs();
      if (!ds.some(function (d) { return d.id === ship.from; })) ship.from = ds[0].id;
      if (!ds.some(function (d) { return d.id === ship.to; }) || ship.to === ship.from) ship.to = ds.filter(function (d) { return d.id !== ship.from; })[0].id;
      var opt = function (cur) { return ds.map(function (d) { return '<option value="' + d.id + '"' + (d.id === cur ? ' selected' : '') + '>' + esc(d.name) + '</option>'; }).join(''); };
      var from = S.views[ship.from], fromD = ds.filter(function (d) { return d.id === ship.from; })[0], toD = ds.filter(function (d) { return d.id === ship.to; })[0];
      var have = Math.floor(from.resources[ship.res].amount), L = CFG.logistics, st = STEP[ship.res] || 10;
      var manualCount = S.shipments.filter(function (x) { return !x.routeId; }).length; // (routes no longer use shipments; this only skips old in-flight ones)
      ship.qty = clamp(ship.qty, 1, Math.max(1, Math.min(L.shipmentMax, have)));
      h += '<div class="label sec">Send a one-off shipment</div><div class="shipform">' +
        '<label>From<select data-sel="from">' + opt(ship.from) + '</select></label><label>To<select data-sel="to">' + opt(ship.to) + '</select></label>' +
        '<label class="wide">Goods<select data-sel="res">' + Object.keys(CFG.resources).map(function (r) {
          var amt = Math.floor(from.resources[r].amount);
          if (!logisticsGood(r, amt >= 1)) return '';
          return '<option value="' + r + '"' + (r === ship.res ? ' selected' : '') + '>' + esc(CFG.resources[r].name) + ' (' + amt + ')</option>';
        }).join('') + '</select></label></div>' +
        '<div class="stepper" style="margin-top:8px"><span class="lab">Qty</span><button data-act="sstep" data-delta="-' + st + '" aria-label="Less">−</button>' + numIn('ship', ship.qty, '') + '<button data-act="sstep" data-delta="' + st + '" aria-label="More">+</button><button data-act="sstep" data-delta="max" style="width:auto;padding:0 8px;font-size:10px">MAX</button></div>' +
        '<div class="dim" style="font-size:11px;margin:8px 0">Arrives in ' + shipTime(fromD, toD) + ' ticks (' + clock(shipTime(fromD, toD) * S.tickMs) + ') · max ' + L.shipmentMax + ' · slots free <b>' + (L.maxInFlight - manualCount) + ' / ' + L.maxInFlight + '</b> · overflow at the destination is lost</div>' +
        '<div class="actions"><button class="btn primary" data-act="shipsend"' + (have < 1 || manualCount >= L.maxInFlight ? ' disabled' : '') + '>' + icon('truck', 12) + ' Dispatch</button></div>';
      var manual = S.shipments.filter(function (x) { return !x.routeId; });
      if (manual.length) {
        h += '<div class="label sec">On the road</div>' + manual.map(function (x) {
          var a = ds.filter(function (d) { return d.id === x.fromDistrict; })[0], b = ds.filter(function (d) { return d.id === x.toDistrict; })[0];
          return '<div class="shiprow"><span>' + x.qty + ' ' + esc(CFG.resources[x.resource].name) + '</span><span class="dim">' + esc(a ? a.name : '?') + ' → ' + esc(b ? b.name : '?') + '</span><span class="num">' + x.ticksLeft + 't</span></div>';
        }).join('');
      }
    }
    return h;
  }

  function routeRows() {
    var ds = groundDs(), nm = function (id) { var d = ds.filter(function (x) { return x.id === id; })[0]; return d ? d.name : '?'; };
    var routes = S.routes.filter(function (r) { return ds.some(function (d) { return d.id === r.fromDistrict; }) && ds.some(function (d) { return d.id === r.toDistrict; }); });
    if (!routes.length) return '<div class="dim" style="font-size:12px">No standing routes yet.</div>';
    return routes.map(function (r) {
      var def = CFG.resources[r.resource], st = STEP[r.resource] || 10;
      return '<div class="route" style="--c:' + def.color + '"><div class="rhead"><b>' + esc(def.name) + '</b><span class="dim">' + esc(nm(r.fromDistrict)) + ' → ' + esc(nm(r.toDistrict)) + '</span>' +
        '<button class="x" data-act="rdel" data-id="' + r.id + '" title="Remove route" aria-label="Remove route">×</button></div>' +
        '<div class="stepper"><span class="lab">Rate</span><button data-act="rstep" data-id="' + r.id + '" data-delta="-5" aria-label="Lower">−</button>' + numIn('rexist', r.rate, 'data-id="' + r.id + '"') + '<span class="unit">/t</span><button data-act="rstep" data-id="' + r.id + '" data-delta="5" aria-label="Raise">+</button></div>' +
        '<div class="stepper" style="margin-top:6px"><span class="lab">Fill to</span>' + numIn('rtarget', r.target || 0, 'data-id="' + r.id + '"') + '<span class="unit">' + (r.target ? 'in ' + esc(nm(r.toDistrict)) : 'no limit') + '</span></div>' +
        '<div class="dim" style="font-size:11px;margin-top:4px">keeps ' + fmt(r.reserve) + ' in ' + esc(nm(r.fromDistrict)) + '</div><div class="flow ' + (r.flow >= r.rate || r.limit === 'target' ? 'good' : r.flow > 0 ? 'warn' : 'bad') + '">' + (r.flow > 0 ? 'Moving ' + r.flow + '/t' : 'Idle') + (r.limit === 'link' ? ' · slowed: the link is carrying more than it can since a settlement\'s help fell away (food and water go first)' : r.limit === 'stock' ? ' · the source is down to its reserve' : r.limit === 'room' ? ' · the destination is full' : r.limit === 'target' ? ' · the destination has what it was to be filled to' : '') + '</div></div>';
    }).join('');
  }
  // Logistics has its own tab: links, standing routes and one-off shipments.
  function logisticsPage() {
    if (!S.districtsUnlocked) return '<div class="empty-state">' + icon('lock', 36) + '<div>Logistics opens with districts, at hub level ' + CFG.districtProgression.unlockCoreLevel + '.</div></div>';
    if (groundDs().length < 2) return '<div class="empty-state">' + icon('route', 36) + '<div>No districts to connect yet.</div></div><div class="actions"><button class="btn primary" data-act="tab" data-tab="districts">Go to Districts</button></div>';
    return logisticsTab();
  }
  function logisticsTab() {
    var ds = groundDs(), L = CFG.logistics;
    var h = howTo('logistics', '<b>Routes</b> move goods between stockpiles every tick, with no delay. Each district has one <b>link</b> to the Core, shared by every route on it. <b>Shipments</b> are one-off and take time on the road.') + '<div class="label sec">Links</div>' +
      (S.districts.some(function (d) { return d.link && d.link.next && d.link.next.upgradeCost.frames; }) ? '<div class="dim" style="font-size:11px;margin:-4px 0 8px">Links past 140/t need Free Port frames and fittings in the Core.</div>' : '');
    ds.filter(function (d) { return !d.core; }).forEach(function (d) {
      var k = d.link, can = k.next && canAffordCore(k.next.upgradeCost);
      h += '<div class="dcard" style="--c:' + CFG.districtTypes[d.type].color + '"><div class="top"><b>' + esc(d.name) + '</b><small class="' + (k.load >= k.capacity ? 'warn' : '') + '">' + k.load + ' / ' + k.capacity + ' per tick · ' + d.distance + ' ticks away</small></div>' +
        '<div class="meter"><i style="width:' + Math.min(100, k.load / k.capacity * 100).toFixed(0) + '%;background:' + (k.load >= k.capacity ? 'var(--warn)' : 'var(--good)') + '"></i></div>' +
         (k.next ? '<div class="label" style="margin-top:8px">Widen the link (from the Core)</div><div class="io">' + costPills(k.next.upgradeCost, S.coreRes) + '<span class="pill out"><i style="background:var(--good)"></i>to ' + k.next.capacity + '/t</span></div><div class="actions"><button class="btn" data-act="linkup" data-id="' + d.id + '"' + (can ? '' : ' disabled') + '>Upgrade link</button></div>' : '<div class="dim" style="font-size:11px;margin-top:6px">Fully upgraded.</div>') + '</div>';
    });
    h += '<div class="label sec">Standing routes · ' + S.routes.filter(function (r) { return ds.some(function (d) { return d.id === r.fromDistrict; }); }).length + ' / ' + (S.maxRoutes || L.maxRoutes) + '</div>' + routeRows();
    if (!ds.some(function (d) { return d.id === route.from; })) route.from = ds[0].id;
    if (!ds.some(function (d) { return d.id === route.to; }) || route.to === route.from) route.to = ds.filter(function (d) { return d.id !== route.from; })[0].id;
    var opt = function (cur) { return ds.map(function (d) { return '<option value="' + d.id + '"' + (d.id === cur ? ' selected' : '') + '>' + esc(d.name) + '</option>'; }).join(''); };
    var rst = 5;
    h += '<div class="label sec">New route</div><div class="shipform"><label>From<select data-sel="r:from">' + opt(route.from) + '</select></label><label>To<select data-sel="r:to">' + opt(route.to) + '</select></label>' +
      '<label class="wide">Goods<select data-sel="r:res">' + Object.keys(CFG.resources).map(function (r) {
        var rv = S.views[route.from], held = !!(rv && rv.resources[r] && rv.resources[r].amount >= 1); // (stock lives in the district's view)
        if (r !== route.res && !logisticsGood(r, held)) return '';
        return '<option value="' + r + '"' + (r === route.res ? ' selected' : '') + '>' + esc(CFG.resources[r].name) + '</option>';
      }).join('') + '</select></label></div>' +
      '<div class="stepper" style="margin-top:8px"><span class="lab">Rate</span><button data-act="rdraft" data-f="rate" data-delta="-' + rst + '">−</button>' + numIn('rdraft', route.rate, 'data-f="rate"') + '<span class="unit">/t</span><button data-act="rdraft" data-f="rate" data-delta="' + rst + '">+</button></div>' +
      '<div class="stepper" style="margin-top:6px"><span class="lab">Keep</span><button data-act="rdraft" data-f="reserve" data-delta="-' + (STEP[route.res] || 10) + '">−</button>' + numIn('rdraft', route.reserve, 'data-f="reserve"') + '<button data-act="rdraft" data-f="reserve" data-delta="' + (STEP[route.res] || 10) + '">+</button></div>' +
      '<div class="stepper" style="margin-top:6px"><span class="lab">Fill to</span><button data-act="rdraft" data-f="target" data-delta="-' + (STEP[route.res] || 10) + '">−</button>' + numIn('rdraft', route.target, 'data-f="target"') + '<button data-act="rdraft" data-f="target" data-delta="' + (STEP[route.res] || 10) + '">+</button></div>' +
      '<div class="dim" style="font-size:11px;margin:8px 0">Keep: floor at the source · Fill to: cap at the target (0 = none)</div>' +
      '<div class="actions"><button class="btn primary" data-act="rsave">Set route</button></div>';
    return h + shipmentsBlock();
  }
  function districtHubTab() {
    var d = activeD(), t = CFG.districtTypes[d.type], lv = GEO().levels[d.level], next = dlevel(GEO().levels[d.level + 1]);
    var slots = function (l) { return Object.keys(l.ringCapacities).reduce(function (a, k) { return a + l.ringCapacities[k]; }, 0); };
    var h = stockSwitch() + '<div class="p-title" style="--c:' + t.color + '">' + icon('hub', 22) + '<h3>' + esc(d.name) + ' · Level ' + d.level + '</h3></div><p class="p-desc">' + esc(t.desc) + '</p>' +
      '<dl class="kv"><dt>Storage per resource</dt><dd>' + fmt(S.hub.maxStorage) + (S.hub.maxStorage > S.hub.baseStorage ? ' <span class="dim">(' + fmt(S.hub.baseStorage) + ' + warehouses)</span>' : '') + '</dd>' +
      '<dt>District power</dt><dd>' + S.hub.power.toFixed(0) + ' base</dd>' +
      '<dt>Rings online</dt><dd>' + Object.keys(lv.ringCapacities).length + ' (' + slots(lv) + ' slots)</dd>' +
      '<dt>Defence</dt><dd>' + S.defense.toFixed(1) + '</dd></dl>' +
      '<div class="label sec">District upgrade</div>';
    if (!next) return h + '<div class="note good">Fully upgraded.</div>' + slotsCard();
    var nl = d.level + 1, up = S.orders.filter(function (o) { return o.kind === 'upgrade'; })[0], gated = nl > S.districtLevelCap;
    var short = Object.keys(next.upgradeCost).filter(function (r) { return S.resources[r].amount < next.upgradeCost[r]; });
    h += '<div class="opt" style="cursor:default"><div class="top"><b>Level ' + nl + '</b><small>' + next.upgradeTicks + ' ticks</small></div><div class="io">' + costPills(next.upgradeCost, S.resources) + '</div>' +
      '<div class="dim" style="font-size:11px;margin-top:8px">Unlocks ring ' + nl + ' (' + plotName(nl) + ' plots, ' + GEO().rings[nl] + ' slots) · storage ' + fmt(next.maxStorage) + ' · base power ' + next.baseEnergy + '</div></div>';
    if (up) h += upgradeNote(up);
    else if (gated) h += '<div class="note warn">Level ' + nl + ' unlocks when ' + esc(S.districtNeeds[nl]) + '.</div>';
    else {
      if (short.length) h += '<div class="note">Paid from <b>this</b> district. Short of ' + short.map(function (r) { return esc(CFG.resources[r].name); }).join(', ') + ': ship it here from another district, or from the Core.</div>';
      h += '<div class="actions"><button class="btn primary" data-act="upgrade">' + upgradeLabel(next.upgradeCost) + '</button>' +
        (short.length ? '<button class="btn" data-act="tab" data-tab="logistics">' + icon('truck', 12) + ' Ship goods</button>' : '') + '</div>' + queueNote(next.upgradeCost);
    }
    return h + slotsCard();
  }


  // ---- settlements: camps that answered the Beacon, and what sponsoring them gives ----------------------------
  // A screen's explanation, folded away: the facts stay on screen and the reasoning is one tap off. Which ones are open
  // survives the panel being redrawn every tick.
  var HOW = {};
  function howTo(key, html) { return '<details class="howto" data-how="' + key + '"' + (HOW[key] ? ' open' : '') + '><summary>How this works</summary><div>' + html + '</div></details>'; }
  document.addEventListener('toggle', function (e) { var d = e.target; if (d && d.dataset && d.dataset.how) HOW[d.dataset.how] = d.open; }, true);
  function settleGives(kind, v) {
    var p1 = function (x) { return (x * 100).toFixed(1).replace(/\.0$/, ''); };
    return kind === 'hands' ? Math.floor(v) + ' commuters' : kind === 'discount' ? p1(v) + '% off upgrades' : '+' + p1(v) + '% link and convoy room';
  }
  // What is worth a look: an appeal the Core can answer, a drive it can finish, a camp that could be sponsored.
  function settleNews() {
    var V = S.settlements, out = [];
    if (!V || !V.unlocked) return out;
    V.active.forEach(function (a) {
      if (a.appeal && S.coreRes[a.appeal.good].amount >= a.appeal.qty) out.push(a.name + ' is appealing for ' + fmt(a.appeal.qty) + ' ' + CFG.resources[a.appeal.good].name);
    });
    if (V.active.length < V.slots && V.offers.length) out.push('A camp can be sponsored');
    return out;
  }
  function settleBasket(basket, frac) {
    return Object.keys(basket).map(function (r) { return pill(r, +(basket[r] * frac).toFixed(1), S.coreRes[r].aid >= basket[r] * frac - 0.01 || !frac ? '' : 'no'); }).join('');
  }
  function settleTab() {
    var V = S.settlements, C = CFG.settlements;
    if (!V || !C) return '';
    if (!V.unlocked) return '<div class="empty-state">' + icon('lock', 36) + '<div>Nobody has answered yet.</div><div class="dim" style="margin-top:8px;font-size:12px">Camps answer once the Beacon has transmitted.</div></div>';
    var e = V.effects, free = V.slots - V.active.length;
    var h = '<div class="p-title">' + icon('camp', 22) + '<h3>Settlements</h3><span class="dim" style="margin-left:auto">' + V.active.length + ' of ' + V.slots + ' sponsored</span></div>' +
      howTo('settle', 'A sponsored camp draws its basket from the Core every tick and gives back in proportion to how well it is supplied. Drives take goods in bulk and move it up a stage. Nothing sent earns credits.') +
      '<dl class="kv"><dt>Upgrade discount</dt><dd class="' + (e.discount ? 'good' : 'dim') + '">' + (e.discount * 100).toFixed(1).replace(/\.0$/, '') + '%</dd>' +
      '<dt>Commuters</dt><dd class="' + (e.hands ? 'good' : 'dim') + '">' + e.hands + ' hands</dd>' +
      '<dt>Link and convoy room</dt><dd class="' + (e.logistics ? 'good' : 'dim') + '">+' + (e.logistics * 100).toFixed(1).replace(/\.0$/, '') + '%</dd>' +
      '<dt>Trade partners</dt><dd class="' + (V.partners ? 'good' : 'dim') + '">' + V.partners + (V.partners ? ' · convoy +' + (e.partner * 100).toFixed(1).replace(/\.0$/, '') + '%' : '') + '</dd></dl>' +
      (V.partners ? '<div class="dim" style="font-size:11px;margin:-2px 0 8px">Includes trade partners.</div>' : '') +
      '<div class="label sec" title="Settlements never draw a good below this share of Core storage">Core holdback</div><div class="seg" style="grid-template-columns:repeat(4,1fr);margin-bottom:6px">' +
      [0, 0.1, 0.25, 0.5].map(function (v) { return '<button data-act="sreserve" data-v="' + v + '" aria-selected="' + (Math.abs(V.reserve - v) < 0.001) + '">' + Math.round(v * 100) + '%</button>'; }).join('') + '</div>';
    V.active.forEach(function (a) {
      var t = C.types[a.type], tr = C.traits[a.trait] || { name: a.trait, desc: '' }, f = CFG.missions.factions[a.faction], frac = [0, 0.5, 1][a.commitment];
      var need = a.drive.need, got = a.drive.got, total = 0, have = 0, can = false;
      Object.keys(need).forEach(function (r) { total += need[r]; have += Math.min(need[r], got[r] || 0); if ((got[r] || 0) < need[r] && S.coreRes[r].amount - V.reserve * S.coreRes[r].cap >= 1) can = true; });
      h += '<div class="mission"><div class="rhead"><b>' + esc(a.name) + '</b><span class="dim num">stage ' + a.stage + ' of ' + a.stages + '</span></div>' +
        '<div class="dim" style="font-size:11px;margin-bottom:6px">' + esc(t.name) + ' · <span title="' + esc(tr.desc) + '">' + esc(tr.name) + '</span> · ' + esc(f ? f.name : a.faction) + '</div>' +
        '<div class="io"><span class="pill out"><i style="background:var(--good)"></i>' + esc(settleGives(a.kind, a.now)) + '</span>' +
        (a.boonLeft ? '<span class="pill" title="Its full benefit again on top, after a drive or an answered appeal"><i style="background:var(--amber)"></i>Giving double · ' + a.boonLeft + 't</span>' : '') + '</div>' +
        '<div class="dim" style="font-size:11px;margin:4px 0 8px">' + esc(settleGives(a.kind, a.benefit)) + ' at full support' + (a.next ? ', ' + esc(settleGives(a.kind, a.next)) + ' at the next stage' : '') + '</div>' +
        '<div class="label">Steady support · supplied ' + Math.round(a.level * 100) + '%</div><div class="meter" style="margin:4px 0 6px"><i style="width:' + clamp(a.level * 100, 0, 100).toFixed(0) + '%;background:' + (a.level > 0.9 ? 'var(--good)' : 'var(--warn)') + '"></i></div>' +
        '<div class="seg" style="grid-template-columns:repeat(3,1fr);margin-bottom:6px">' + ['Off', 'Half', 'Full'].map(function (l, i) { return '<button data-act="scommit" data-id="' + a.id + '" data-l="' + i + '" aria-selected="' + (a.commitment === i) + '">' + l + '</button>'; }).join('') + '</div>' +
        '<div class="io">' + (frac ? settleBasket(a.basket, frac) : '<span class="dim">Nothing is being sent.</span>') + '</div>' +
        (frac ? (function () { var held = Object.keys(a.basket).filter(function (r) { return S.coreRes[r].aid < a.basket[r] * frac - 0.01; }); return '<div class="dim" style="font-size:11px;margin-top:4px">per tick from the Core' + (held.length ? ' · <span class="warn">held back: ' + held.map(function (r) { return esc(CFG.resources[r].name); }).join(', ') + '</span>' : '') + '</div>'; })() : '') +
        '<div class="label sec">' + (a.last ? 'The last drive: it stands on its own' : 'Drive to stage ' + (a.stage + 1)) + ' · ' + Math.floor(have / total * 100) + '%</div>' +
        '<div class="meter" style="margin:4px 0 6px"><i style="width:' + clamp(have / total * 100, 0, 100).toFixed(0) + '%;background:var(--amber)"></i></div>' +
        '<div class="io">' + Object.keys(need).map(function (r) { var left = need[r] - (got[r] || 0); return left > 0 ? pill(r, fmt(left) + ' more', '') : pill(r, 'all the', 'dim'); }).join('') + '</div>' +
        '<div class="dim" style="font-size:11px;margin:4px 0 6px">' + (a.last ? 'Frees the slot · then ' + esc(settleGives(a.kind, a.keeps)) + ' for good' : 'Next stage: more, doubled for ' + C.boonTicks + ' t') + '</div>' +
        '<div class="actions"><button class="btn' + (can ? ' primary' : '') + '" data-act="sgive" data-id="' + a.id + '"' + (can ? '' : ' disabled') + '>Send what the Core can spare</button></div>';
      if (a.appeal) {
        var g = CFG.resources[a.appeal.good], stock = Math.floor(S.coreRes[a.appeal.good].amount), ok = stock >= a.appeal.qty;
        h += '<div class="offer" style="--c:' + g.color + ';margin-top:10px"><div class="want">Appeal: <b class="num">' + fmt(a.appeal.qty) + '</b> ' + esc(g.name) + ' <span class="' + (ok ? 'good' : 'dim') + '" style="font-size:11px">(' + fmt(stock) + ' in the Core) · ' + a.appeal.ticksLeft + 't left</span></div>' +
          '<div class="pay"><span class="pill"><i style="background:var(--amber)"></i>Gives double for ' + C.appeal.boonTicks + 't</span>' +
          '<button class="btn' + (ok ? ' primary' : '') + '" data-act="sanswer" data-id="' + a.id + '"' + (ok ? '' : ' disabled') + '>Answer</button></div></div>';
      }
      h += '<div style="margin-top:8px;text-align:right"><button class="linkbtn" data-act="sdrop" data-id="' + a.id + '" data-key="sdrop' + a.id + '">' + (confirmKey === 'sdrop' + a.id ? 'Confirm: stop sponsoring (its progress is lost)' : 'Stop sponsoring') + '</button></div></div>';
    });
    h += '<div class="label sec">Camps asking for help</div>' + (free > 0 ? '' : '<div class="note">All slots taken' + (V.slots < V.slotNeeds.length ? (V.slots === 1 ? '. Another opens with the Free Port' : orbitKnown() ? '. Another opens with the station' : '. Another may open later (conditions unknown)') : '') + '.</div>');
    V.offers.forEach(function (o) {
      var t = C.types[o.type], tr = C.traits[o.trait] || { name: o.trait, desc: '' };
      h += '<div class="opt" style="cursor:default;margin-bottom:8px"><div class="top"><b>' + esc(o.name) + '</b><small>asking for ' + o.ticksLeft + 't more</small></div>' +
        '<div class="dim" style="font-size:11px;margin-bottom:6px">' + esc(t.name) + ' · ' + esc(tr.name) + ': ' + esc(tr.desc) + '</div><p class="p-desc" style="margin:0 0 6px">' + esc(t.desc) + '</p>' +
        '<div class="io">' + Object.keys(o.basket).map(function (r) { return pill(r, o.basket[r], 'in'); }).join('') + '</div>' +
        '<div class="dim" style="font-size:11px;margin:4px 0 8px">per tick at stage 1 · gives ' + esc(settleGives(o.kind, o.benefit)) + ', rising to ' + esc(settleGives(o.kind, o.benefitTop)) + '</div>' +
        '<div class="actions"><button class="btn' + (free > 0 ? ' primary' : '') + '" data-act="ssponsor" data-id="' + o.id + '"' + (free > 0 ? '' : ' disabled') + '>Sponsor</button></div></div>';
    });
    return h;
  }

  // ---- exchange ----------------------------------------------------------------
  function mp(n) { return n === null || n === undefined ? '–' : (Math.abs(n - Math.round(n)) < 0.005 ? String(Math.round(n)) : n.toFixed(2)); }
  function spark(hist, color) {
    var lo = Math.min.apply(null, hist), hi = Math.max.apply(null, hist), span = Math.max(1e-6, hi - lo), w = 220, h = 44;
    var pts = hist.map(function (v, i) { return (i / (hist.length - 1) * w).toFixed(1) + ',' + (h - 4 - (v - lo) / span * (h - 8)).toFixed(1); }).join(' ');
    return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true"><polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  }
  // What an order at this price would fill right now against the visible book.
  function fillEstimate(x, side, price, qty) {
    var levels = side === 'buy' ? x.asks : x.bids, left = qty, cost = 0, got = 0;
    levels.forEach(function (l) {
      if (left <= 0) return;
      if (side === 'buy' ? l.price <= price + 1e-9 : l.price >= price - 1e-9) { var q = Math.min(left, l.qty - l.mine); if (q > 0) { got += q; cost += q * l.price; left -= q; } }
    });
    return { qty: got, avg: got ? cost / got : 0, total: cost };
  }
  // The soft limit on heavy buying: say where the colony stands, and only make a fuss once it has started to cost.
  function brokerNote() {
    var b = S.economy && S.economy.brokerage;
    if (!b) return '';
    var pctUsed = Math.min(100, b.spent / b.allowance * 100);
    if (b.rate > 0) return '<div class="note warn">Daily allowance used: ' + fmt(b.spent) + ' / ' + fmt(b.allowance) + ' cr. Buys cost +' + Math.round(b.rate * 100) + '% until it eases.</div>';
    if (pctUsed < 50) return '';
    return '<div class="note">Bought today: ' + fmt(b.spent) + ' / ' + fmt(b.allowance) + ' cr before surcharge.</div>';
  }
  function exchangeTab() {
    var E = S.exchange, X = CFG.exchange;
    if (!E.unlocked) return '<div class="empty-state">' + icon('lock', 36) + '<div>The exchange opens at hub level ' + X.unlockCoreLevel + '.</div></div>';
    var x = E.resources[mk.res], r = CFG.resources[mk.res], ds = groundDs();
    if (!ds.some(function (d) { return d.id === mk.district; })) mk.district = ds[0].id;
    if (mk.price === null) mk.price = mk.side === 'buy' ? (x.ask || x.ref) : (x.bid || x.ref);
    var pstep = Math.max(0.01, Math.round(x.ref * 0.01 * 100) / 100), qstep = STEP[mk.res] || 10;
    var dstock = Math.floor(S.views[mk.district].resources[mk.res].amount);
    var maxQ = mk.side === 'sell' ? Math.min(X.maxQty, dstock) : X.maxQty;
    mk.qty = clamp(mk.qty, 1, Math.max(1, maxQ));
    var ev = x.event ? '<span class="chip-ev ' + x.event.kind + '">' + (x.event.kind === 'shortage' ? 'SHORTAGE' : 'GLUT') + ' · ' + x.event.ticksLeft + 't</span>' : '';
    var h = brokerNote() + '<label class="selrow">Market<select data-sel="m:res">' + Object.keys(CFG.resources).filter(function (k) {
      var d = CFG.resources[k]; if (d.trade) return !!S.freeport; return !(d.showFromHub && d.showFromHub > S.colony.hubLevel + 1 && k !== mk.res);
    }).map(function (k) { return '<option value="' + k + '"' + (k === mk.res ? ' selected' : '') + '>' + esc(CFG.resources[k].name) + ' · ' + mp(E.resources[k].ref) + ' cr</option>'; }).join('') + '</select></label>';
    h += '<div class="xg"><div><div class="mk-head" style="--c:' + r.color + '"><div><div class="big num">' + mp(x.ref) + ' <small>cr</small></div><div class="dim" style="font-size:11px">market price' + (Math.abs(x.trend) >= 0.01 ? ' · ' + (x.trend > 0 ? '▲' : '▼') + Math.abs(Math.round(x.trend * 100)) + '%' : '') + '</div></div>' + spark(x.hist, r.color) + ev + '</div>';
    // the book: asks (what you pay) above, bids (what you get) below
    var maxq = Math.max.apply(null, x.asks.concat(x.bids).map(function (l) { return l.qty; }).concat([1]));
    var row = function (l, cls) { return '<div class="bk ' + cls + '" data-act="mkprice" data-price="' + l.price + '"><i style="width:' + (l.qty / maxq * 100).toFixed(0) + '%"></i><span class="num">' + mp(l.price) + '</span><span class="num">' + fmt(l.qty) + (l.mine ? ' <b title="includes your orders">·</b>' : '') + '</span></div>'; };
    h += '<div class="label sec">Order book <span class="dim" style="text-transform:none;letter-spacing:0">· click a price to use it</span></div><div class="book">' +
      x.asks.slice().reverse().map(function (l) { return row(l, 'ask'); }).join('') +
      '<div class="bk spread"><span>spread</span><span class="num">' + (x.ask !== null && x.bid !== null ? mp(x.ask - x.bid) : '–') + '</span></div>' +
      x.bids.map(function (l) { return row(l, 'bid'); }).join('') + '</div>';
    // the order form
    var side = mk.side, est = fillEstimate(x, side, mk.price, mk.qty), total = Math.ceil(mk.price * mk.qty - 1e-9);
    h += '</div><div><div class="label sec">New order</div><div class="seg" role="tablist" style="margin-bottom:10px"><button role="tab" data-act="mkside" data-side="buy" aria-selected="' + (side === 'buy') + '">Buy</button><button role="tab" data-act="mkside" data-side="sell" aria-selected="' + (side === 'sell') + '">Sell</button></div>' +
      '<div class="shipform"><label class="wide">' + (side === 'buy' ? 'Deliver to' : 'Sell from') + '<select data-sel="m:district">' + ds.map(function (d) { return '<option value="' + d.id + '"' + (d.id === mk.district ? ' selected' : '') + '>' + esc(d.name) + ' (' + fmt(S.views[d.id].resources[mk.res].amount) + ')</option>'; }).join('') + '</select></label></div>' +
      '<div class="stepper" style="margin-top:8px"><span class="lab">Qty</span><button data-act="mkqty" data-delta="-' + qstep + '">−</button>' + numIn('mkqty', mk.qty, '') + '<button data-act="mkqty" data-delta="' + qstep + '">+</button>' + (side === 'sell' ? '<button data-act="mkqty" data-delta="max" style="width:auto;padding:0 8px;font-size:10px">MAX</button>' : '') + '</div>' +
      '<div class="stepper" style="margin-top:6px"><span class="lab">Price</span><button data-act="mkprice" data-delta="-' + pstep + '">−</button>' + numIn('mkprice', mp(mk.price), '') + '<button data-act="mkprice" data-delta="' + pstep + '">+</button></div>' +
      '<div class="actions" style="margin-top:6px"><button class="btn" data-act="mkprice" data-price="' + (side === 'buy' ? x.bid : x.ask) + '"' + ((side === 'buy' ? x.bid : x.ask) === null ? ' disabled' : '') + '>Join the queue</button><button class="btn" data-act="mkprice" data-price="' + (side === 'buy' ? x.ask : x.bid) + '"' + ((side === 'buy' ? x.ask : x.bid) === null ? ' disabled' : '') + '>Take the best</button></div>' +
      '<label class="selrow" style="margin-top:8px">Lasts<select data-sel="m:ttl">' + X.ttlOptions.map(function (t) { return '<option value="' + t + '"' + (t === mk.ttl ? ' selected' : '') + '>' + t + ' ticks (' + clock(t * S.tickMs) + ')</option>'; }).join('') + '</select></label>';
    var enough = side === 'buy' ? S.colony.credits >= total : dstock >= mk.qty;
    h += '<div class="note" style="margin-top:10px">' + (side === 'buy'
      ? 'Holds <b>' + fmt(total) + ' cr</b> until it fills.'
      : 'Holds <b>' + mk.qty + ' ' + esc(r.name) + '</b> until it sells; you receive the price minus a <b>' + Math.round(X.feeRate * 100) + '% fee</b>.') +
      (est.qty ? '<br>Would fill <b>' + est.qty + '</b> now at about <b>' + mp(est.avg) + '</b> each' + (est.qty < mk.qty ? ', and rest the other ' + (mk.qty - est.qty) : '') + '.' : '<br>Nothing fills yet: it rests in the book until someone meets the price.') + '</div>' +
      '<div class="actions"><button class="btn primary" data-act="mksubmit"' + (enough ? '' : ' disabled') + '>' + (side === 'buy' ? 'Place buy order' : 'Place sell order') + '</button></div></div></div>';
    // my orders and trades
    h += '<div class="label sec">Your open orders · ' + E.orders.length + ' / ' + X.maxOpenOrders + '</div>';
    h += E.orders.length ? E.orders.map(function (o) {
      var d = ds.filter(function (z) { return z.id === o.district; })[0];
      return '<div class="myord ' + o.side + '"><div class="rhead"><b>' + (o.side === 'buy' ? 'Buy ' : 'Sell ') + fmt(o.qty) + (o.qty < o.total ? ' / ' + fmt(o.total) : '') + ' ' + esc(CFG.resources[o.resource].name) + '</b><span class="dim">@ ' + mp(o.price) + ' · ' + esc(d ? d.name : '?') + '</span><button class="x" data-act="mkcancel" data-id="' + o.id + '" title="Cancel and take it back" aria-label="Cancel order">×</button></div>' +
        '<div class="dim" style="font-size:11px">' + (o.side === 'buy' ? fmt(o.escrow) + ' cr held' : fmt(o.qty) + ' held') + ' · expires in ' + Math.max(0, o.expires - S.tick) + ' ticks</div></div>';
    }).join('') : '<div class="dim" style="font-size:12px">No open orders.</div>';
    if (E.trades.length) h += '<div class="label sec">Recent trades</div>' + E.trades.map(function (t) {
      return '<div class="shiprow"><span>' + (t.side === 'buy' ? 'Bought ' : 'Sold ') + t.qty + ' ' + esc(CFG.resources[t.resource].name) + '</span><span class="dim">@ ' + mp(t.price) + '</span><span class="num dim">#' + t.tick + '</span></div>';
    }).join('');
    return h;
  }

  // ---- missions -----------------------------------------------------------------
  // Requisitions: requests for ordinary goods, delivered from the Core, from an early hub level.
  function reqReady() {
    var Q = S.requisitions;
    return Q && Q.unlocked ? Q.open.filter(function (q) { return S.coreRes[q.good].amount >= q.qty; }) : [];
  }
  function boonPills() {
    var Q = S.requisitions, B = CFG.requisitions ? CFG.requisitions.boons : {};
    return Object.keys(B).filter(function (k) { return Q.boons[k] > 0; }).map(function (k) {
      return '<span class="pill out" title="' + esc(B[k].desc) + '"><i style="background:var(--good)"></i>' + esc(B[k].name) + ' · ' + Q.boons[k] + 't</span>';
    }).join('');
  }
  function requisitionsBlock() {
    var Q = S.requisitions, B = CFG.requisitions ? CFG.requisitions.boons : {};
    if (!Q || !CFG.requisitions) return '';
    if (!Q.unlocked) return '<div class="empty-state">' + icon('lock', 36) + '<div>Requisitions start at hub level ' + Q.unlockHubLevel + '.</div></div>';
    var on = boonPills();
    var h = '<div class="p-title">' + icon('flag', 22) + '<h3>Requisitions</h3><span class="dim" style="margin-left:auto">' + Q.filled + ' filled</span></div>' +
      howTo('reqs', esc((CFG.ui && CFG.ui.requisitionsNote) || 'Requests for ordinary goods, a set amount by a set time. Deliver the full amount from the Core: it pays above the convoy\'s price and lends the colony a hand for a while. One that lapses is simply replaced.')) +
      (on ? '<div class="label sec">In effect</div><div class="io">' + on + '</div>' : '');
    if (!Q.open.length) h += '<div class="dim" style="margin-top:10px">Nothing is being asked for right now. New requisitions arrive soon.</div>';
    Q.open.forEach(function (q) {
      var g = CFG.resources[q.good], have = Math.floor(S.coreRes[q.good].amount), enough = have >= q.qty, b = B[q.boon] || { name: q.boon, desc: '' };
      h += '<div class="mission"><div class="rhead"><b>' + esc(q.title) + '</b><span class="dim num">' + q.ticksLeft + 't left</span></div>' +
        '<div class="offer" style="--c:' + g.color + '"><div class="want"><b class="num">' + fmt(q.qty) + '</b> ' + esc(g.name) + ' <span class="' + (enough ? 'good' : 'dim') + '" style="font-size:11px">(' + fmt(have) + ' in the Core)</span></div>' +
        '<div class="meter" style="margin:2px 0 4px"><i style="width:' + clamp(have / q.qty * 100, 0, 100).toFixed(0) + '%;background:' + (enough ? 'var(--good)' : 'var(--warn)') + '"></i></div>' +
        '<div class="pay"><span class="pill out"><i style="background:var(--good)"></i>' + fmt(q.reward) + ' cr</span><span class="pill" title="' + esc(b.desc) + '"><i style="background:var(--amber)"></i>' + esc(b.name) + '</span>' +
        '<button class="btn' + (enough ? ' primary' : '') + '" data-act="reqfill" data-id="' + q.id + '"' + (enough ? '' : ' disabled') + '>Deliver</button></div>' +
        '<div class="dim" style="font-size:11px">' + esc(b.desc) + '</div></div></div>';
    });
    return h;
  }
  function missionsTab() {
    var req = requisitionsBlock();
    if (!S.freeport) return req + '<div class="sheet-h">Missions</div><div class="note">' + icon('lock', 12) + ' Missions open with the Free Port.</div>';
    return req + '<div class="sheet-h">Missions</div>' + factionMissions();
  }
  function factionMissions() {
    var M = S.missions, F = CFG.missions.factions;
    function rankOf(k, pts) { var r = null; (F[k].ranks || []).forEach(function (x) { if (pts >= x.min) r = x.name; }); return r; }
    if (msrc === null || !S.views[msrc]) msrc = S.districts.filter(function (d) { return d.type === 'freeport'; })[0].id;
    var recog = S.orbital && !S.orbital.unlocked ? '<div class="note" style="margin-bottom:10px">' + esc((CFG.ui && CFG.ui.missionsHint) || ('Reach a total standing of ' + S.orbital.unlockStanding + ' across all factions and your name will be known across the lands.')) + ' <span class="dim">(' + fmt(S.orbital.standing) + ' / ' + S.orbital.unlockStanding + ')</span></div>' : '';
    var h = recog + '<div class="standing"><div class="label">Standing</div><div class="big num">' + fmt(M.total) + '</div><div class="dim" style="font-size:11px">' + M.filled + ' mission' + (M.filled === 1 ? '' : 's') + ' filled</div><div class="facs">' +
      Object.keys(F).map(function (k) { var r = rankOf(k, M.standing[k]); return '<span class="fac"><b>' + fmt(M.standing[k]) + '</b><small>' + esc(F[k].name) + '</small>' + (r ? '<small class="rank">' + esc(r) + '</small>' : '') + '</span>'; }).join('') + '</div></div>' +
      '<label class="selrow" style="margin:10px 0">Supply from<select data-sel="s:src">' + groundDs().map(function (d) { return '<option value="' + d.id + '"' + (d.id === msrc ? ' selected' : '') + '>' + esc(d.name) + '</option>'; }).join('') + '</select></label>' +
      howTo('missions', 'Each mission is offered by every faction, each asking for something different. Fill one and the others lapse. Standing raises your rank with that faction.');
    if (!M.open.length) h += '<div class="dim">No missions open right now. New ones arrive soon.</div>';
    M.open.forEach(function (q) {
      h += '<div class="mission"><div class="rhead"><b>' + esc(q.title) + '</b><span class="dim num">' + q.ticksLeft + 't left</span></div>' +
        q.offers.map(function (o) {
          var have = Math.floor(S.views[msrc].resources[o.good].amount), enough = have >= o.qty, g = CFG.resources[o.good];
          return '<div class="offer" style="--c:' + g.color + '"><div class="who"><b>' + esc(F[o.faction].name) + '</b><span class="dim">wants</span></div>' +
            '<div class="want"><b class="num">' + o.qty + '</b> ' + esc(g.name) + ' <span class="' + (enough ? 'good' : 'dim') + '" style="font-size:11px">(' + fmt(have) + ' here)</span></div>' +
            '<div class="pay"><span class="pill out"><i style="background:var(--good)"></i>' + fmt(o.reward) + ' cr</span><span class="pill"><i style="background:var(--amber)"></i>+' + o.standing + ' standing</span>' +
            '<button class="btn' + (enough ? ' primary' : '') + '" data-act="mfill" data-id="' + q.id + '" data-faction="' + o.faction + '"' + (enough ? '' : ' disabled') + '>Fill</button></div></div>';
        }).join('') + '</div>';
    });
    return h;
  }

  // ---- expansion: building upward ---------------------------------------------------
  function expansionCard(b, d) {
    var E = CFG.expansion, top = S.colony.expandMax || E.maxLevel, lv = b.level || 1, pend = S.orders.filter(function (o) { return o.kind === 'expand' && o.data.ring === b.ring && o.data.slot === b.slot; })[0];
    var dots = '';
    for (var i = 1; i <= top; i++) dots += '<i class="' + (i <= lv ? 'on' : '') + (i > E.maxLevel ? ' orb' : '') + '"></i>';
    var effect = function (k, crew) {
      var what = d.housing ? '+' + (Math.floor(d.housing * plotMultFor(d, b.ring) * k) - Math.floor(d.housing * plotMultFor(d, b.ring) * E.scale[lv])) + ' more homes'
        : d.storageBonus ? 'Storage ×' + k : d.defense ? 'Defence ×' + k : 'Output, inputs and power ×' + k;
      return what + (d.workers ? ' · crew ×' + crew : '');
    };
    var h = '<div class="label sec">Expansion</div><div class="optcard' + (lv > 1 ? ' on' : '') + '"><div class="top"><b>Level ' + lv + ' / ' + top + '</b><span class="dim">' + (lv > 1 ? 'output ×' + E.scale[lv] : 'as built') + '</span></div><div class="lvdots">' + dots + '</div>';
    if (pend && pend.state === 'queued') {
      h += '<div class="note" style="margin:8px 0 0">Expansion to level ' + pend.data.level + ' is in the work queue (number ' + pend.pos + ').' + waitingLine(pend) + '<div class="actions" style="margin-top:8px">' + queueBtns(pend) + '</div></div>';
    } else if (pend) {
      h += '<div class="note" style="margin:8px 0 0">Expanding to level ' + pend.data.level + ': ' + pend.remaining + ' tick' + (pend.remaining === 1 ? '' : 's') + ' left.</div>';
    } else if (b.xnext) {
      var nx = b.xnext, short = Object.keys(nx.cost).filter(function (r) { return S.resources[r].amount < nx.cost[r]; });
      h += '<div class="dim" style="font-size:12px;margin:6px 0">Next level: ' + esc(effect(nx.scale, nx.crew)) + '</div>' +
        '<div class="label" style="margin-top:4px">Level ' + nx.level + ' · ' + nx.ticks + ' ticks</div><div class="io">' + costPills(nx.cost, S.resources) + '</div>' +
        (short.length ? '<div class="note" style="margin:8px 0 0">Paid from <b>' + esc(activeD().name) + '</b>\'s stockpile. Short of ' + short.map(function (r) { return esc(CFG.resources[r].name); }).join(', ') + ': ' + (short.some(function (r) { return CFG.resources[r].orbitalTrade; }) ? 'some of these are made in orbit, so bring them down to the Core by orbital link or express drop, then route or ship them here.' : 'these are made by Trade Workshops at the Free Port, so route or ship them here.') + '</div>' : '') +
        (orderAt(b.ring, b.slot) ? '' : '<div class="actions"><button class="btn primary" data-act="expand" data-ring="' + b.ring + '" data-slot="' + b.slot + '">' + (short.length || !slotFree() ? 'Queue expansion to level ' : 'Expand to level ') + nx.level + '</button></div>');
    } else h += '<div class="dim" style="font-size:12px;margin-top:6px">Fully expanded.</div>';
    return h + '</div>';
  }

  // ---- people: who lives here, what they eat, and where the numbers are heading ----------
  function peopleTab() {
    var P = S.people, c = S.colony, R = S.coreRes, mi = c.moraleInfo, st = c.staffing, ho = c.housing, ex = CFG.exodus, gr = CFG.growth;
    var pf = function (n) { return n >= 10 ? String(Math.round(n)) : n.toFixed(1); };
    var o = P.outlook, why = {
      growing: 'Room, food and good spirits: new people move in every ' + gr.everyTicks + ' ticks.',
      buffer: 'Production only just matches use, but the stockpile is full enough to carry a small shortfall, so people keep moving in. Watch the runway below.',
      housing: 'The homes are full. Build or expand homes to let the colony grow.',
      morale: 'Morale is below ' + gr.minMorale + ', so nobody moves in until it recovers.',
      food: 'The food and water surplus is too small to feed another person, so nobody moves in.',
      hunger: 'There is not enough food or water, so people are leaving (about ' + Math.max(1, Math.ceil(c.population * ex.starvingFraction)) + ' a tick) until the colony can feed those who are left.',
      despair: 'Morale is below ' + ex.lowMoraleBelow + ', so people are slowly leaving.'
    };
    var line = o.state === 'shrinking' ? (o.why === 'housing' ? 'There are more people than homes, so some are leaving.' : why[o.why]) : o.state === 'growing' ? (o.why ? why[o.why] : why.growing) : why[o.why];
    var h = '<div class="p-title">' + icon('users', 22) + '<h3>People</h3></div>' +
      '<div class="popbig"><span class="big num">' + c.population + '</span><span class="dim"> / ' + P.housingCap + ' homes</span><span class="trend ' + (o.state === 'shrinking' ? 'bad' : o.state === 'growing' ? 'good' : 'dim') + '">' + (o.state === 'shrinking' ? '▼ leaving' : o.state === 'growing' ? '▲ growing' : '■ steady') + '</span></div>' +
      '<div class="meter" style="margin:6px 0"><i style="width:' + clamp(c.population / Math.max(1, P.housingCap) * 100, 0, 100).toFixed(0) + '%;background:' + (c.population >= P.housingCap ? 'var(--warn)' : 'var(--good)') + '"></i></div>' +
      '<div class="note ' + (o.state === 'shrinking' ? 'bad' : '') + '">' + esc(line) + '</div>';
    // what they consume
    h += '<div class="label sec">What they use, every tick</div><table class="ptable"><thead><tr><th></th><th>Per person</th><th>All</th><th>Stock</th><th>Net</th></tr></thead><tbody>';
    var rows = [['rations', P.perPerson.rations], ['clean_water', P.perPerson.clean_water]];
    rows.forEach(function (r) {
      var k = r[0], res = R[k], bad = res.net < -0.05, tl = res.ticksLeft;
      h += '<tr><td><i style="background:' + CFG.resources[k].color + '"></i>' + esc(CFG.resources[k].name) + '</td><td class="num">' + pf(r[1] * P.multiplier) + '</td><td class="num">' + pf(P.use[k]) + '</td><td class="num">' + fmt(res.amount) + '</td><td class="num ' + (bad ? 'bad' : 'good') + '">' + rate(res.net) + '</td></tr>' +
        '<tr class="sub"><td colspan="5">' + (bad ? '<span class="bad">Runs out in ' + (tl === null ? '?' : span(Math.ceil(tl))) + '</span>' : 'Enough for <b>' + P.headroom[k] + '</b> more people at the current surplus') + '</td></tr>';
    });
    h += '<tr><td><i style="background:' + CFG.resources.meals.color + '"></i>Prepared Meals <span class="dim">(optional)</span></td><td class="num">' + pf(P.mealsPerPerson) + '</td><td class="num">' + pf(P.meals) + '</td><td class="num">' + fmt(R.meals.amount) + '</td><td class="num ' + (R.meals.net < -0.05 ? 'warn' : 'dim') + '">' + rate(R.meals.net) + '</td></tr></tbody></table>';
    if (P.multiplier > 1.001) h += '<div class="note warn">A hazard is raising consumption ×' + P.multiplier.toFixed(2) + ' for now.</div>';
    // away safety
    var tls = ['rations', 'clean_water'].map(function (k) { return R[k].ticksLeft; }).filter(function (v) { return v !== null; });
    h += '<div class="label sec">If you leave now</div>' + (tls.length
      ? '<div class="note warn">First shortage in <b>' + span(Math.ceil(Math.min.apply(null, tls))) + '</b>, then people leave.</div>'
      : '<div class="note good">Food and water in surplus · each new person +' + pf(P.perPerson.rations + P.perPerson.clean_water) + '/t.</div>');
    // morale
    var sg = function (v) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1); };
    h += '<div class="label sec">Morale</div><dl class="kv"><dt>Now</dt><dd>' + Math.round(c.morale) + ' <span class="dim">→ target ' + Math.round(mi.target) + '</span></dd>' +
      '<dt>Made of</dt><dd class="dim">base ' + mi.base + ' · homes ' + sg(mi.comfort) + ' · meals ' + sg(mi.meals) + '</dd>' +
      '<dt>Output effect</dt><dd class="' + (mi.productivity < 0.999 ? 'bad' : mi.productivity > 1.001 ? 'good' : 'dim') + '">×' + mi.productivity.toFixed(2) + '</dd>' +
      '<dt>Thresholds</dt><dd class="dim">growth stops below ' + gr.minMorale + ' · people leave below ' + ex.lowMoraleBelow + ' · colony is lost at 0</dd></dl>';
    // crew and housing
    h += '<div class="label sec">Crew &amp; housing</div><dl class="kv"><dt>Crew</dt><dd class="' + (st.ratio < 0.999 ? 'warn' : '') + '">' + Math.floor(st.workforce) + ' hands for ' + Math.ceil(st.posts) + ' posts' + (st.commuters ? ' · ' + st.commuters + ' commute in from settlements' : '') + (st.ratio < 0.999 ? ' · output ×' + st.ratio.toFixed(2) : '') + '</dd>' +
      '<dt>Homes</dt><dd>quarters ' + ho.base + (ho.built ? ' + built ' + Math.floor(ho.built) : '') + ' = ' + ho.cap + '</dd>' +
      '<dt>Minimum</dt><dd class="dim">people never leave below ' + P.minPopulation + '</dd></dl>' +
      (st.ratio < 0.999 ? '<div class="note warn">Short of hands: staffed buildings run slower.</div>' : '');
    return h;
  }

  function trendTxt(tr, goodUp) {
    if (Math.abs(tr) < 0.02) return '';
    var up = tr > 0, good = up === goodUp;
    return ' <span class="' + (good ? 'good' : 'bad') + '">' + (up ? '▲' : '▼') + Math.abs(Math.round(tr * 100)) + '%</span>';
  }
  function scheduledTab() {
    var h = (activeD().core ? '' : '<div class="note">Convoys use the <b>Core</b> stockpile.</div>') +
      '<div class="convoy-head"><div class="label">Next convoy in</div><div class="big num" data-f="convoy">–</div><div class="dim" style="font-size:11px" data-f="convoyTicks"></div></div>' +
      (S.requisitions && S.requisitions.boons && S.requisitions.boons.convoy > 0 ? '<div class="note good">' + esc(CFG.requisitions.boons.convoy.name) + ': ' + esc(CFG.requisitions.boons.convoy.desc) + ' ' + S.requisitions.boons.convoy + ' ticks left.</div>' : '') +
      '<p class="p-desc">Standing orders repeat every convoy. Prices are for the <b>next</b> convoy; arrows show the change. Trade limit ×' + (CFG.hubLevels[S.colony.hubLevel].convoyCapMult || 1) + ' (grows with hub level).</p>';
    var net = 0;
    Object.keys(CFG.resources).forEach(function (k) {
      var r = CFG.resources[k], ex = S.contracts.export[k] || 0, im = S.contracts.import[k] || 0, st = STEP[k] || 10;
      if (r.trade) return; // trade goods go through the exchange
      var mp = S.market.prices[k], max = S.market.limits[k];
      if (r.showFromHub && r.showFromHub > S.colony.hubLevel + 1 && !ex && !im && S.coreRes[k].amount < 0.5) return;
      net += ex * mp.sell - im * mp.buy;
      var stepper = function (side, v) {
        return '<div class="stepper"><span class="lab">' + (side === 'export' ? 'Sell' : 'Buy') + '</span><button data-act="contract" data-res="' + k + '" data-side="' + side + '" data-delta="-' + st + '"' + (v <= 0 ? ' disabled' : '') + ' aria-label="Decrease ' + side + '">−</button>' +
          '' + numIn('contract', v, 'data-res="' + k + '" data-side="' + side + '"') + '<button data-act="contract" data-res="' + k + '" data-side="' + side + '" data-delta="' + st + '"' + (v >= max ? ' disabled' : '') + ' aria-label="Increase ' + side + '">+</button></div>';
      };
      h += '<div class="trade" style="--c:' + r.color + '"><div class="nm"><i></i>' + esc(r.name) + '</div>' +
        '<div class="stock">stock <span class="num" data-b="amt:' + k + '"></span> · max ' + max + ' per convoy</div>' + stepper('export', ex) + stepper('import', im) +
        '<div class="sub"><span>sells for ' + mp.sell + ' cr' + trendTxt(mp.trend, true) + '</span><span>buys for ' + mp.buy + ' cr' + trendTxt(mp.trend, false) + '</span></div></div>';
    });
    h += '<div class="note ' + (net >= 0 ? 'good' : '') + '" style="margin-top:12px">Estimated convoy balance at forecast prices: <b>' + (net >= 0 ? '+' : '−') + fmt(Math.abs(net)) + ' cr</b></div>';
    return h;
  }

  function expressTab() {
    var x = S.express, c = S.colony;
    var h = brokerNote() + '<p class="p-desc">' + x.travelTicks + ' t (' + clock(x.travelTicks * S.tickMs) + ') · fee · sells ×' + x.sellMult + ' · buys ×' + x.buyMult + ' · smaller than the convoy</p>';
    if (x.active) {
      var line = function (o, verb) {
        return Object.keys(o).map(function (r) { return verb + ' ' + o[r].qty + ' ' + esc(CFG.resources[r].name); }).join(', ');
      };
      h += '<div class="convoy-head"><div class="label">Express convoy en route</div><div class="big num" data-f="xeta">–</div><div class="dim" style="font-size:11px">' + x.active.ticksLeft + ' tick' + (x.active.ticksLeft === 1 ? '' : 's') + '</div></div>' +
        '<div class="note">' + [line(x.active.buy, 'Fetching'), line(x.active.sell, 'Selling')].filter(Boolean).join('<br>') + '</div>';
      return h;
    }
    if (x.readyIn > 0) h += '<div class="note warn">The convoy is resting: ready again in ' + span(x.readyIn) + '.</div>';
    var spend = 0, income = 0, any = false;
    Object.keys(CFG.resources).forEach(function (k) {
      var r = CFG.resources[k], sellQ = xdraft.sell[k] || 0, buyQ = xdraft.buy[k] || 0, st = STEP[k] || 10;
      if (r.trade) return;
      if (r.showFromHub && r.showFromHub > c.hubLevel + 1 && !sellQ && !buyQ && S.coreRes[k].amount < 0.5) return;
      var pr = x.prices[k], lim = x.limits[k], stock = Math.floor(S.coreRes[k].amount);
      spend += Math.round(buyQ * pr.buy); income += Math.round(sellQ * pr.sell); if (sellQ || buyQ) any = true;
      var stepper = function (side, v, max) {
        return '<div class="stepper"><span class="lab">' + (side === 'sell' ? 'Send' : 'Fetch') + '</span><button data-act="xstep" data-res="' + k + '" data-side="' + side + '" data-delta="-' + st + '"' + (v <= 0 ? ' disabled' : '') + ' aria-label="Decrease ' + side + '">−</button>' +
          '' + numIn('xdraft', v, 'data-res="' + k + '" data-side="' + side + '"') + '<button data-act="xstep" data-res="' + k + '" data-side="' + side + '" data-delta="' + st + '"' + (v >= max ? ' disabled' : '') + ' aria-label="Increase ' + side + '">+</button></div>';
      };
      h += '<div class="trade" style="--c:' + r.color + '"><div class="nm"><i></i>' + esc(r.name) + '</div>' +
        '<div class="stock">stock <span class="num" data-b="amt:' + k + '"></span> · max ' + lim + '</div>' +
        stepper('sell', sellQ, Math.min(lim, stock)) + stepper('buy', buyQ, lim) +
        '<div class="sub"><span>pays ' + pr.sell + ' cr each</span><span>costs ' + pr.buy + ' cr each</span></div></div>';
    });
    var total = spend + x.fee, can = c.credits >= total;
    h += '<div class="note" style="margin-top:12px">Fee <b>' + x.fee + ' cr</b> + goods <b>' + fmt(spend) + ' cr</b> are held now' + (can ? '' : ' <span class="bad">(you have ' + fmt(c.credits) + ')</span>') +
      '. Selling pays <b>' + fmt(income) + ' cr</b> on arrival.</div>' +
      '<div class="actions"><button class="btn" data-act="xclear"' + (any ? '' : ' disabled') + '>Clear</button>' +
      '<button class="btn primary" data-act="xdispatch"' + (!any || !can || x.readyIn > 0 ? ' disabled' : '') + '>Dispatch express</button></div>';
    return h;
  }

  function convoyTab() {
    var seg = '<div class="seg" role="tablist" style="margin-bottom:12px">' +
      '<button role="tab" data-act="cmode" data-mode="scheduled" aria-selected="' + (convoyMode === 'scheduled') + '">Scheduled</button>' +
      '<button role="tab" data-act="cmode" data-mode="express" aria-selected="' + (convoyMode === 'express') + '">Express' + (S.express.active ? ' · en route' : '') + '</button></div>';
    return seg + (convoyMode === 'express' ? expressTab() : scheduledTab());
  }

  function logTab() {
    if (!S.events.length) return '<div class="empty-state">No events yet.</div>';
    return '<ul class="log">' + S.events.map(function (e) {
      return '<li class="' + e.kind + '" data-id="' + e.id + '">' + esc(e.message) + '<small>tick #' + e.tick + '</small></li>';
    }).join('') + '</ul>';
  }

  var lastPanel = '';
  var panelDeferred = false;
  function numFocused(el) { var ae = document.activeElement; return !!(ae && ae.classList && ae.classList.contains('numin') && el.contains(ae)); }
  // The right pane follows the selection; the workspace over the map is whatever the dock opened.
  function renderPanel() {
    if (numFocused($('panel')) || numFocused($('sheet'))) { panelDeferred = true; return; }
    panelDeferred = false;
    renderSheet();
    var h = rightPane();
    if (h === lastPanel) return;
    lastPanel = h;
    var p = $('panel'), top = p.scrollTop;
    p.innerHTML = h;
    p.scrollTop = top;
    framePanel();
  }
  function framePanel() {
    var now = nowT();
    document.querySelectorAll('#panel [data-b], #sheet [data-b]').forEach(function (el) {
      var k = el.dataset.b.split(':');
      if (k[0] === 'amt') { var r = S.coreRes[k[1]]; el.textContent = fmt(clamp(r.amount + r.net * frac(), 0, r.cap)); }
    });
    var xe = document.querySelector('#panel [data-f=xeta], #sheet [data-f=xeta]');
    if (xe && S.express.active) xe.textContent = clock(S.express.active.arrivesAt - now);
    var cv = document.querySelector('#panel [data-f=convoy], #sheet [data-f=convoy]');
    if (cv) {
      cv.textContent = clock(S.convoy.arrivesAt - now);
      document.querySelector('#panel [data-f=convoyTicks], #sheet [data-f=convoyTicks]').textContent = S.convoy.ticksLeft + ' tick' + (S.convoy.ticksLeft === 1 ? '' : 's');
    }
  }
  function clock(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  // ------------------------------------------------------------------ queue bar
  var lastQueue = '';
  // Every place's orders, place by place: the one under way with its progress, then the ones waiting, in order.
  function queueHtml(bare) {
    var h = '', last = null;
    S.allOrders.forEach(function (o) {
      var place = o.dname ? o.dname.replace(/^The /, '') : 'Core';
      if (o.did !== last) {
        last = o.did;
        var qd = S.districts.filter(function (x) { return x.id === o.did; })[0];
        h += '<span class="q-place"' + (qd && qd.slots > 1 ? ' title="' + qd.slots + ' build slots: that many orders are carried out at once"' : '') + '>' + esc(place) + (qd && qd.slots > 1 ? ' ×' + qd.slots : '') + '</span>';
      }
      var where = o.data.ring !== undefined ? 'R' + o.data.ring + '·' + (o.data.slot + 1) : '';
      if (o.state === 'queued') {
        var short = o.waiting ? Object.keys(o.waiting.short) : [];
        var why = short.length ? 'needs ' + short.map(function (r) { return fmt(o.waiting.short[r]) + ' ' + CFG.resources[r].name; }).join(', ') : o.waiting && o.waiting.why ? o.waiting.why : o.waiting ? 'starts next tick' : 'waiting its turn';
        h += '<div class="order wait' + (short.length ? ' short' : '') + '" data-qid="' + o.id + '"><button class="x" data-act="cancel" data-id="' + o.id + '" title="Remove from the queue (nothing has been paid)" aria-label="Remove from the queue">×</button>' +
          '<div class="row"><span>' + esc(orderName(o)) + '</span><small class="num">' + (where ? where + ' · ' : '') + '#' + o.pos + '</small></div>' +
          '<div class="why">' + esc(why) + (o.pos > 1 ? ' <button class="linkbtn" data-act="qmove" data-id="' + o.id + '" data-to="top" title="Build this next">first</button>' : '') + '</div></div>';
        return;
      }
      h += '<div class="order" data-id="' + o.id + '"><button class="x" data-act="cancel" data-id="' + o.id + '" title="Cancel & refund" aria-label="Cancel order">×</button>' +
        '<div class="row"><span>' + esc(orderName(o)) + '</span><small class="num">' + (where ? where + ' · ' : '') + o.remaining + 't</small></div><div class="bar"><i></i></div>' + (o.rush ? '<div style="margin-top:6px">' + rushBtn(o, 'rushq') + '</div>' : '') + '</div>';
    });
    var chips = pending.map(function (p) {
      return '<div class="pend" data-id="' + p.id + '"><span>' + esc(p.label) + '</span><button class="x" data-act="pcancel" data-id="' + p.id + '" title="Discard (not sent yet)" aria-label="Discard queued action">×</button></div>';
    }).join('');
    if (bare) return (chips ? '<div class="label" style="color:var(--warn)">' + (flushing ? 'Sending…' : connected ? 'Not sent yet' : 'Offline · waiting to send') + '</div>' + chips : '') + h;
    var crews = S.requisitions && S.requisitions.boons && S.requisitions.boons.crews > 0 ? '<span class="q-boon" title="' + esc(CFG.requisitions.boons.crews.desc) + '">' + esc(CFG.requisitions.boons.crews.name) + ' · ' + S.requisitions.boons.crews + 't</span>' : '';
    h = '<span class="label">Work queue</span>' + crews + (S.allOrders.length ? h : '<span class="queue-empty">Nothing queued.</span>');
    if (chips) h = '<span class="label" style="color:var(--warn)">' + (flushing ? 'Sending…' : connected ? 'Not sent yet' : 'Offline · waiting to send') + '</span>' + chips + '<span class="queue-sep"></span>' + h;
    return h;
  }
  function renderQueue() {
    var el = $('queue');
    if (!el) { if (S) renderPanel(); return; } // phone: the queue is part of the overview
    var h = queueHtml(false);
    if (h !== lastQueue) { el.innerHTML = h; lastQueue = h; }
  }
  function frameQueue(f) {
    document.querySelectorAll('.order[data-id]').forEach(function (el) {
      var o = S.allOrders.filter(function (x) { return String(x.id) === el.dataset.id; })[0];
      if (o) el.querySelector('.bar i').style.width = (clamp((o.total - o.remaining + f) / o.total, 0, 1) * 100).toFixed(1) + '%';
    });
  }

  // ------------------------------------------------------------------ notifications and messages
  var popOpen = false, popFrom = 0;
  function popHtml() {
    var w = window.Story.waitingHtml();
    var ev = S.events.slice(0, 8);
    return '<div class="pop-sec">Incoming</div>' + (w || '<div class="dim" style="font-size:12px">No calls waiting.</div>') +
      '<div class="pop-sec">Just happened</div>' + (ev.length ? '<ul class="log">' + ev.map(function (e) {
        return '<li class="' + e.kind + (e.id > popFrom ? ' new' : '') + '">' + esc(e.message) + '<small>tick #' + e.tick + '</small></li>';
      }).join('') + '</ul>' : '<div class="dim" style="font-size:12px">Nothing yet.</div>') +
      '<button class="btn pop-link" data-act="msgs" data-t="history">Open the full history</button>';
  }
  function renderPop() {
    if (!popOpen || !S) return;
    var h = popHtml();
    if ($('pop').dataset.h !== h) { $('pop').innerHTML = h; $('pop').dataset.h = h; }
  }
  function closePop() { popOpen = false; $('pop').hidden = true; }
  function togglePop() {
    if (popOpen) { closePop(); return; }
    if (!S) return;
    popOpen = true; popFrom = bellSeen; $('pop').hidden = false; $('pop').dataset.h = ''; renderPop();
    bellSeen = S.events.length ? Math.max(bellSeen, S.events[0].id) : bellSeen;
    storeSet('bell:' + S.user, String(bellSeen));
    renderTop();
  }
  var msgDone = '';
  function messages(t) {
    if (t) msgTab = t;
    closePop();
    if (!document.querySelector('.modal.messages')) modal('<nav class="nav" id="msg-nav"></nav><div class="list"><div class="lh" id="msg-lh"></div><div class="lscroll" id="msg-list"></div></div><div class="read" id="msg-read"></div>', 'messages');
    if (MOBILE) msgSel = {}; // a phone opens on the list; nothing is marked read until it is opened
    msgDone = '';
    renderMessages();
  }
  function renderMessages() {
    var nav = $('msg-nav');
    if (!nav || !S) return;
    var cnt = window.Story.counts(), hist = msgTab === 'history';
    var navH = '<h3>Messages</h3>' + [['mail', 'Mail', 'mail', cnt.mail], ['calls', 'Calls', 'play', cnt.calls], ['history', 'History', 'list', 0]].map(function (t) {
      return '<button class="ni' + (msgTab === t[0] ? ' on' : '') + '" data-act="mtab" data-t="' + t[0] + '">' + icon(t[2], 16) + t[1] + (t[3] ? '<em>' + t[3] + '</em>' : '') + '</button>';
    }).join('') + '<div style="flex:1"></div>';
    var lh, list, rd = '';
    if (hist) { lh = 'History · ' + S.events.length + ' events'; list = S.events.length ? '<ul class="log" style="padding:12px 16px">' + S.events.map(function (e) { return '<li class="' + e.kind + '">' + esc(e.message) + '<small>tick #' + e.tick + '</small></li>'; }).join('') + '</ul>' : '<div class="empty-state">No events yet.</div>'; }
    else {
      var v = window.Story.msgView(msgTab, msgSel[msgTab], MOBILE);
      msgSel[msgTab] = v.sel; lh = (msgTab === 'mail' ? 'Mail' : 'Calls') + ' · ' + v.n + (v.n === 1 ? ' item' : ' items'); list = v.list; rd = v.reader;
    }
    var sig = navH + lh + list + rd;
    if (msgDone === sig) return;
    msgDone = sig;
    var md = document.querySelector('.modal.messages'); md.classList.toggle('solo', hist); md.classList.toggle('reading', MOBILE && !hist && !!msgSel[msgTab]);
    nav.innerHTML = navH; $('msg-lh').innerHTML = '<span class="label">' + esc(lh) + '</span>' + (hist || MOBILE ? '<button class="x" data-m="close" aria-label="Close" style="margin-left:auto">&times;</button>' : '');
    renderTop();
    var ls = $('msg-list'), top = ls.scrollTop; ls.innerHTML = list; ls.scrollTop = top;
    $('msg-read').innerHTML = hist ? '' : '<div class="rh">' + (MOBILE ? '<button class="x" data-act="mback" aria-label="Back to the list" style="margin-right:10px">' + icon('back', 16) + '</button>' : '') + '<span class="label">' + (msgTab === 'mail' ? 'Message' : 'Call') + '</span><button class="x" data-m="close" aria-label="Close" style="margin-left:auto">&times;</button></div><div class="rb">' + rd + '</div>';
  }
  // answering a call or reading a message hands the screen to the story overlay
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-story]')) { closePop(); var m = document.querySelector('.modal.messages'); if (m) m.closest('.modal-bg').remove(); return; }
    if (popOpen && !e.target.closest('#pop, #bell-btn')) closePop();
  });

  // ------------------------------------------------------------------ modals
  function modal(html, cls) {
    var bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = '<div class="modal ' + (cls || '') + '" role="dialog" aria-modal="true">' + html + '</div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', function (e) {
      var a = e.target.closest('[data-m]');
      if (a) { var fn = a.dataset.m; bg.remove(); if (MODALS[fn]) MODALS[fn](); }
      else if (e.target === bg && !bg.querySelector('[data-lock]')) bg.remove();
    });
    var first = bg.querySelector('.btn.primary, .btn'); if (first) first.focus();
    return bg;
  }
  var MODALS = {
    restart: function () {
      restarting = true; storeSet('won:' + S.user, '');
      act('restart', {}).then(function () { restarting = false; sel = null; renderAll(); });
    },
    reset: function () {
      storeSet('won:' + S.user, '');
      act('reset', {}).then(function () { sel = null; renderAll(); });
    },
    ack: function () { acking = true; act('ack', {}).then(function () { acking = false; }); },
    logout: function () { api('logout', {}).then(function () { location.href = '/'; }); },
    awayAck: function () { awayBusy = true; api('away-ack', {}).then(function (r) { awayBusy = false; if (r && r.state) setState(r.state); }, function () { awayBusy = false; }); },
    retake: function () { awayCall('retake'); },
    startOver: function () {
      var t = awayText('parked');
      modal('<h2>' + esc(t.confirmTitle) + '</h2><p>' + esc(t.confirmText) + '</p><div class="actions" data-lock><button class="btn" data-m="parkedAgain">Back</button><button class="btn danger" data-m="startOver2">' + esc(t.confirmButton) + '</button></div>', 'parked');
    },
    startOver2: function () { awayCall('start-over'); },
    parkedAgain: function () { if (lostView) showLost(lostView); else checkModals(); },
    mobileLayout: function () { setLayout('mobile'); },
    account: function () { if (window.Account) window.Account.open(); },
    close: function () {}
  };
  function menu() {
    var keys = [['M', 'Map']];
    navGroups().forEach(function (g) { g.tabs.forEach(function (t) { if (t[3]) keys.push([t[3].toUpperCase(), tabLabel(t)]); }); });
    modal('<h2>Command menu</h2><p>Signed in as <b>' + esc(S.user) + '</b>.</p><div class="stack">' +
      '<button class="btn block" data-m="mobileLayout">' + icon('phone', 14) + ' Use the phone layout</button>' +
      '<button class="btn block" data-m="account">' + icon('lock', 14) + ' Account</button>' +
      '<button class="btn block" data-m="logout">Sign out</button>' +
      '<button class="btn block danger" data-m="confirmReset">Abandon colony &amp; start over</button><button class="btn block" data-m="close">Close</button></div>' +
      '<div class="label sec">Keys</div><div class="keys">' + keys.map(function (k) { return '<span><kbd>' + k[0] + '</kbd>' + esc(k[1]) + '</span>'; }).join('') +
      '<span><kbd>Esc</kbd>Back</span><span><kbd>+</kbd><kbd>−</kbd><kbd>0</kbd>Zoom, fit</span></div>');
  }
  // A healthy colony (no collapse countdown, not shut down or collapsed) is handed on rather than erased: the server
  // parks it under another commander's name, where it may be picked up and run on. The server makes the same check.
  function healthyColony() { return S.colony.status === 'active' && !S.doom; }
  MODALS.confirmReset = function () {
    var text = healthyColony()
      ? 'The colony is stable, so it passes to another commander instead of being erased. You start over from the beginning, story included.'
      : 'All structures, stockpiles and credits are lost, and your progress resets to the very beginning. Story messages you have received start over too.';
    modal('<h2>Abandon this colony?</h2><p>' + text + '</p>' +
      '<div class="actions"><button class="btn" data-m="close">Keep playing</button><button class="btn danger" data-m="confirmReset2">Continue</button></div>');
  };
  MODALS.confirmReset2 = function () {
    var ok = healthyColony();
    modal('<h2>Are you sure?</h2><p>' + (ok ? '<b>You can\'t take it back.</b> If you only want a break, it waits for you while you\'re away.' : '<b>This erases everything and cannot be undone.</b> There is no way to get this colony back. If it is only struggling, you can keep playing and rebuild instead.') + '</p>' +
      '<div class="actions"><button class="btn primary" data-m="close">Keep playing</button><button class="btn danger" data-m="reset">' + (ok ? 'Yes, give it up and start over' : 'Yes, erase it and start over') + '</button></div>');
  };
  // ---- absence (see src/absence.js): the notice after a long time away, a parked colony, and one claimed by someone else
  var awayBusy = false, lostView = null;
  var AWAY_DEFAULT = {
    stewarded: { title: 'The colony was held for you', text: 'You were away {away}. After {hold} without word, the colony administration took over: it kept things running and sent the surplus, goods and credits alike, on to support the wider settlement effort. The colony is as it stood when the administration stepped in, and it is yours again.', button: 'Resume command' },
    parked: { title: 'The colony has been reassigned', text: 'You were away {away}. The colony has been transferred to another commander for management and parked: nothing is running. Its file is still open, so you can retake command or start a new colony.', retake: 'Retake command', fresh: 'Start a new colony', logout: 'Log out',
      confirmTitle: 'Start a new colony?', confirmText: 'The old colony stays parked under another commander, with its station renamed. You will not be able to get it back.', confirmButton: 'Start a new colony' },
    claimed: { title: 'The colony has a new commander', text: 'While you were away, another commander took over your colony for good. A new assignment is waiting.', fresh: 'Start a new colony', logout: 'Log out' }
  };
  function awayText(kind) { var ui = (CFG && CFG.ui && CFG.ui.away) || {}; return Object.assign({}, AWAY_DEFAULT[kind], ui[kind] || {}); }
  function span(ms) {
    var h = Math.max(0, ms) / 3600000;
    return h < 48 ? Math.round(h) + ' hours' : Math.round(h / 24) + ' days';
  }
  function fill(str, vals) { return String(str).replace(/\{(\w+)\}/g, function (m, k) { return vals[k] !== undefined ? vals[k] : m; }); }
  function awayCall(path) {
    awayBusy = true;
    api(path, {}).then(function (r) {
      awayBusy = false;
      if (!r || !r.ok) { toast((r && r.error) || 'That did not work.'); if (lostView) showLost(lostView); else checkModals(); return; }
      if (path === 'start-over') { location.reload(); return; } // a new colony: start the page clean
      lostView = null; setState(r.state);
    }, function () { awayBusy = false; toast('No connection. Try again.'); if (lostView) showLost(lostView); else checkModals(); });
  }
  function absenceModal() {
    var a = S.absence;
    if (!a || awayBusy || document.querySelector('.modal.parked, .modal.away')) return;
    var holdMs = (CFG.absence ? CFG.absence.simulateHours : 96) * 3600000;
    if (a.phase === 'parked') {
      var t = awayText('parked');
      document.querySelectorAll('.modal-bg').forEach(function (m) { m.remove(); });
      modal('<h2>' + esc(t.title) + '</h2><p>' + esc(fill(t.text, { away: span(Date.now() + offset - a.lastActive), hold: span(holdMs) })) + '</p>' +
        '<div class="stack" data-lock><button class="btn primary block" data-m="retake">' + esc(t.retake) + '</button><button class="btn block" data-m="startOver">' + esc(t.fresh) + '</button><button class="btn block" data-m="logout">' + esc(t.logout) + '</button></div>', 'parked');
    } else if (a.notice && a.notice.kind === 'stewarded') {
      var s2 = awayText('stewarded'), n = a.notice;
      modal('<h2>' + esc(s2.title) + '</h2><p>' + esc(fill(s2.text, { away: span(Date.now() + offset - n.lastActive), hold: span(holdMs) })) + '</p>' +
        '<div class="actions" data-lock><button class="btn primary" data-m="awayAck">' + esc(s2.button) + '</button></div>', 'away');
    }
  }
  // No colony: it was claimed while parked. Nothing else of the game is shown.
  function showLost(v) {
    lostView = v;
    if (document.querySelector('.modal.lost')) return;
    var t = awayText('claimed');
    modal('<h2>' + esc(t.title) + '</h2><p>' + esc(t.text) + '</p><div class="stack" data-lock><button class="btn primary block" data-m="startOver2">' + esc(t.fresh) + '</button><button class="btn block" data-m="logout">' + esc(t.logout) + '</button></div>', 'lost');
  }
  // Being at the screen keeps the colony simulated. The live stream does not count (a tab can be left open for a week),
  // so input does, a few times an hour at most.
  var hereAt = Date.now();
  function imHere() { if (Date.now() - hereAt < 300000) return; hereAt = Date.now(); api('here', {}).catch(function () { hereAt = 0; }); }
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, imHere, { capture: true, passive: true }); });

  function checkModals() {
    absenceModal();
    if (S.absence && S.absence.phase === 'parked') return;
    if (S.colony.shutdown && !document.querySelector('.modal') && !storeGet('shut:' + S.user + ':' + S.colony.shutdown.since)) {
      storeSet('shut:' + S.user + ':' + S.colony.shutdown.since, '1');
      var sh = (CFG.ui && CFG.ui.shutdown) || {};
      modal('<h2>' + esc(sh.title || 'Colony shut down') + '</h2><p>' + esc(sh.text || 'Hope has run out. The colony has shut down instead of collapsing: only the essential buildings are running and everything else has been parked. Rebuild from here at your own pace.') + '</p>' +
        '<p class="dim">' + esc(sh.hint || 'If you would rather begin again, Abandon colony is in the command menu.') + '</p>' +
        '<div class="actions"><button class="btn primary" data-m="close">' + esc(sh.button || 'Understood') + '</button></div>', 'report');
    }
    if (S.colony.status === 'failed' && !restarting && !document.querySelector('.modal.fail')) {
      var fl = (CFG.ui && CFG.ui.failed) || {};
      var cr = fmt(S.colony.restartCredits);
      modal('<h2>' + esc(fl.title || 'Colony abandoned') + '</h2><p>' + esc(fl.text || 'The population lost all hope and walked into the wastes. Your structures are gone.') + ' ' +
        esc((fl.carry || 'The convoy will carry {credits} credits to your next attempt.').replace('{credits}', cr)) +
        (S.colony.failures ? ' ' + esc((fl.count || 'Colonies lost so far: {n}.').replace('{n}', S.colony.failures)) : '') + '</p>' +
        '<div class="actions" data-lock><button class="btn primary" data-m="restart" data-lock>' + esc(fl.button || 'Found a new colony') + '</button></div>', 'fail');
    }
    if (S.report.length && !acking && !restarting && !document.querySelector('.modal.report')) {
      modal('<h2>While you were away</h2><p>The colony faced trouble and did what it could with what it had.</p><ul class="log">' +
        S.report.map(function (e) { return '<li class="' + e.kind + '">' + esc(e.message) + '<small>tick #' + e.tick + '</small></li>'; }).join('') +
        '</ul><div class="actions"><button class="btn primary" data-m="ack">Understood</button></div>', 'report');
    }
    if (S.colony.won && !shown.won && !storeGet('won:' + S.user)) {
      shown.won = true; storeSet('won:' + S.user, '1');
      var won = (CFG.ui && CFG.ui.won) || {};
      modal('<h2>' + esc(won.title || 'The beacon reached the world') + '</h2><p>' + esc(won.text || 'Transmission complete. Somewhere out there, something heard you, Commander. You kept your people alive and built something that outlasts the wastes. Camps are gathering on the road, and a harbour has lit its lamps.') + '</p>' +
        '<div class="actions"><button class="btn primary" data-m="close">' + esc(won.button || 'Keep building') + '</button></div>', 'win');
    }
  }
  // The layout is the player's to choose: the choice is kept in a cookie, which the server reads when it sends the page.
  function setLayout(ui) { document.cookie = 'ft_ui=' + (ui === 'mobile' ? 'mobile' : 'desktop') + '; path=/; max-age=31536000; samesite=lax'; location.href = '/game'; }
  function storeGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  // ------------------------------------------------------------------ input
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) { var chip = MOBILE && e.target.closest('.chip'); if (chip && chip.title) toast(chip.title, 'info'); } // a phone has no hover: a tap says what the number is
    if (!el || el.disabled) return;
    var a = el.dataset.act;
    var sh = e.shiftKey ? 10 : 1; // hold Shift for bigger steps
    if (a === 'tab') { e.preventDefault(); if (el.dataset.tab === ws && el.classList.contains('nv') && !MOBILE) { ws = null; renderAll(); } else go(el.dataset.tab); }
    else if (a === 'drawer') { drawer = drawer === el.dataset.d ? null : (el.dataset.d || null); closePop(); renderNav(); renderDrawer(); }
    else if (a === 'cat') { buildCat = el.dataset.cat; renderPanel(); var pc = $('panel'); if (pc) pc.scrollTop = 0; }
    else if (a === 'zoom') { if (el.dataset.z === 'fit') fitView(); else zoomBy(el.dataset.z === 'in' ? 0.75 : 1 / 0.75); }
    else if (a === 'grab') document.body.classList.toggle('panel-full');
    else if (a === 'layout') setLayout(el.dataset.ui);
    else if (a === 'menu') { drawer = null; renderNav(); renderDrawer(); if (MODALS[el.dataset.m]) MODALS[el.dataset.m](); }
    else if (a === 'mback') { delete msgSel[msgTab]; renderMessages(); }
    else if (a === 'rush') {
      var rkey = 'rush:' + el.dataset.id;
      if (confirmKey === rkey) {
        if (Date.now() - confirmAt < CONFIRM_DELAY) return; // a double click only arms it
        confirmKey = null; act('rush', { orderId: +el.dataset.id }, 'Rushed.');
      } else { confirmKey = rkey; confirmAt = Date.now(); clearTimeout(confirmTimer); confirmTimer = setTimeout(function () { confirmKey = null; renderPanel(); renderQueue(); }, 4000); renderPanel(); renderQueue(); }
    }
    else if (a === 'desel') { sel = null; replaceAt = null; document.body.classList.remove('panel-full'); renderAll(); }
    else if (a === 'pin') togglePin(el.dataset.res)
    else if (a === 'dataunlock') act('data-unlock', { packet: el.dataset.packet }, 'Data packet unlocked.')
    else if (a === 'hqgive') act('hq-give', el.dataset.res ? { resource: el.dataset.res } : {}).then(function (d) { if (d && d.ok) toast(d.completed ? 'Delivered in full. The work is under way.' : 'Delivered to Headquarters.', true); });
    else if (a === 'hqpick') { hqPick = el.dataset.cat ? { category: el.dataset.cat, option: el.dataset.opt, ship: null } : null; renderPanel(); }
    else if (a === 'hqstart') {
      var free = el.dataset.free === '1', pk = hqPick;
      act('hq-start', { category: pk.category, option: pk.option, ship: pk.ship, free: free }, free ? 'Done: it applies at once.' : 'Committed. The bill is shown.').then(function (d) { if (d && d.ok) { hqPick = null; renderPanel(); } });
    } else if (a === 'hqabort') {
      if (confirmKey === el.dataset.key) { if (Date.now() - confirmAt < CONFIRM_DELAY) return; confirmKey = null; act('hq-abort', {}); }
      else { confirmKey = el.dataset.key; confirmAt = Date.now(); clearTimeout(confirmTimer); confirmTimer = setTimeout(function () { confirmKey = null; renderPanel(); }, 3000); renderPanel(); }
    }
    else if (a === 'msel') { msgSel[msgTab] = el.dataset.id; renderMessages(); }
    else if (a === 'wsclose') { ws = null; renderAll(); }
    else if (a === 'msgs') { closePop(); drawer = null; renderNav(); renderDrawer(); messages(el.dataset.t || 'mail'); }
    else if (a === 'mtab') { msgTab = el.dataset.t; renderMessages(); }
    else if (a === 'resumeOps') act('resume', {});
    else if (a === 'build' && sel && sel.ring) act('build', { ring: sel.ring, slot: sel.slot, type: el.dataset.type, district: activeId }).then(function (d) { if (d && d.ok && d.queued) toast('Added to the work queue. It starts when its turn comes.', 'info'); });
    else if (a === 'replace' && sel && sel.ring) act('replace', { ring: sel.ring, slot: sel.slot, type: el.dataset.type, district: activeId }).then(function (d) {
      if (!d || !d.ok) return;
      replaceAt = null; renderPanel();
      toast(d.queued ? 'Replacement added to the work queue.' : 'Replacement started.', d.queued ? 'info' : true);
    });
    else if (a === 'replacemode') { replaceAt = replaceAt ? null : { ring: sel.ring, slot: sel.slot }; renderPanel(); var rp = $('panel'); if (rp) rp.scrollTop = 0; }
    else if (a === 'qmove') act('queue-move', { orderId: +el.dataset.id, to: el.dataset.to });
    else if (a === 'toggle') {
      var tb = buildingAt(+el.dataset.ring, +el.dataset.slot);
      act('toggle', { ring: +el.dataset.ring, slot: +el.dataset.slot, paused: tb ? !tb.paused : undefined, district: activeId }); // explicit state: safe to resend
    }
    else if (a === 'boost') {
      var bt = buildingAt(+el.dataset.ring, +el.dataset.slot);
      var ok = el.dataset.opt, cur = bt && (ok ? (bt.boosts || {})[ok] : bt.boost);
      act('boost', { ring: +el.dataset.ring, slot: +el.dataset.slot, enabled: !cur, option: ok || undefined, district: activeId });
    }
    else if (a === 'pcancel') { var pid = +el.dataset.id; pending = pending.filter(function (p) { return p.id !== pid; }); renderQueue(); renderRadar(); renderAlerts(); renderPanel(); }
    else if (a === 'demolish') {
      if (confirmKey === el.dataset.key) {
        if (Date.now() - confirmAt < CONFIRM_DELAY) return; // a double click: ignore it, stay armed
        confirmKey = null; act('demolish', { ring: +el.dataset.ring, slot: +el.dataset.slot, district: activeId });
      }
      else { confirmKey = el.dataset.key; confirmAt = Date.now(); clearTimeout(confirmTimer); confirmTimer = setTimeout(function () { confirmKey = null; renderPanel(); }, 3000); renderPanel(); }
    }
    else if (a === 'bslot') {
      if (confirmKey === 'bslot') {
        if (Date.now() - confirmAt < CONFIRM_DELAY) return;
        confirmKey = null; act('build-slot', { district: activeId }); // (the colony log announces it)
      }
      else { confirmKey = 'bslot'; confirmAt = Date.now(); clearTimeout(confirmTimer); confirmTimer = setTimeout(function () { confirmKey = null; renderPanel(); }, 3000); renderPanel(); }
    }
    else if (a === 'cancel') { e.preventDefault(); act('cancel', { orderId: +el.dataset.id }); }
    else if (a === 'upgrade') act('upgrade', { district: activeId }).then(function (d) { if (d && d.ok) toast(d.queued ? 'Upgrade added to the work queue.' : (activeD().core ? 'Hub upgrade started.' : activeD().name + ' upgrade started.'), d.queued ? 'info' : true); });
    else if (a === 'dmode') { dmode = el.dataset.mode; renderPanel(); }
    else if (a === 'linkup') act('link', { district: +el.dataset.id }, 'Link upgraded.');
    else if (a === 'rdel') { var rr = S.routes.filter(function (x) { return x.id === +el.dataset.id; })[0]; if (rr) act('route', { from: rr.fromDistrict, to: rr.toDistrict, resource: rr.resource, rate: 0 }); }
    else if (a === 'rstep') {
      var rt = S.routes.filter(function (x) { return x.id === +el.dataset.id; })[0];
      if (rt) act('route', { from: rt.fromDistrict, to: rt.toDistrict, resource: rt.resource, rate: Math.max(0, rt.rate + (+el.dataset.delta * sh)), reserve: rt.reserve });
    }
    else if (a === 'rdraft') { route[el.dataset.f] = Math.max(el.dataset.f === 'rate' ? 1 : 0, (route[el.dataset.f] || 0) + (+el.dataset.delta * sh)); renderPanel(); }
    else if (a === 'rsave') act('route', { from: route.from, to: route.to, resource: route.res, rate: route.rate, reserve: route.reserve, target: route.target }, 'Route set.');
    else if (a === 'enter') { e.preventDefault(); enter(+el.dataset.id); }
    else if (a === 'sdist') { var sid = +el.dataset.id; if (RAW.views[sid] && sid !== activeId) { activeId = sid; sel = null; confirmKey = null; S = merge(RAW); renderAll(); } }
    else if (a === 'orbit') { e.preventDefault(); enterOrbit(); }
    else if (a === 'found') act('found', el.dataset.discovery ? { discovery: +el.dataset.discovery } : { type: el.dataset.type }).then(function (d) { if (d && d.ok) toast(d.queued ? 'Founding added to the Core\'s work queue.' : 'Founding started.', d.queued ? 'info' : true); });
    else if (a === 'sstep') {
      var have = Math.floor(S.views[ship.from].resources[ship.res].amount), cap = Math.max(1, Math.min(CFG.logistics.shipmentMax, have));
      ship.qty = clamp(el.dataset.delta === 'max' ? cap : ship.qty + (+el.dataset.delta * sh), 1, cap); renderPanel();
    }
    else if (a === 'shipsend') {
      act('shipment', { from: ship.from, to: ship.to, resource: ship.res, qty: ship.qty }, 'Shipment dispatched.');
    }
    else if (a === 'expand') act('expand', { ring: +el.dataset.ring, slot: +el.dataset.slot, district: activeId }).then(function (d) { if (d && d.ok) toast(d.queued ? 'Expansion added to the work queue.' : 'Expansion started.', d.queued ? 'info' : true); });
    else if (a === 'recpick') { recipePick = recipePick === el.dataset.rec ? null : el.dataset.rec; renderPanel(); }
    else if (a === 'procset') { recipePick = null; act('recipe', { ring: +el.dataset.ring, slot: +el.dataset.slot, recipe: el.dataset.rec || null, district: activeId }, 'Retooling started.'); }
    else if (a === 'recset') { var rcp = el.dataset.rec; recipePick = null; act('recipe', { ring: +el.dataset.ring, slot: +el.dataset.slot, recipe: rcp, district: activeId }, 'Recipe set.'); }
    else if (a === 'shield') act('shield', { enabled: !(S.hazard && S.hazard.shield && S.hazard.shield.enabled) });
    else if (a === 'reqfill') act('requisition', { id: +el.dataset.id }, 'Requisition delivered.');
    else if (a === 'ssponsor') act('settle-sponsor', { id: +el.dataset.id });
    else if (a === 'scommit') act('settle-commit', { id: +el.dataset.id, level: +el.dataset.l });
    else if (a === 'sgive') act('settle-give', { id: +el.dataset.id }).then(function (d) { if (d && d.ok && !d.completed) toast('Sent to the drive.', true); });
    else if (a === 'sanswer') act('settle-answer', { id: +el.dataset.id });
    else if (a === 'sreserve') act('settle-reserve', { reserve: +el.dataset.v });
    else if (a === 'sdrop') {
      if (confirmKey === el.dataset.key) { if (Date.now() - confirmAt < CONFIRM_DELAY) return; confirmKey = null; act('settle-drop', { id: +el.dataset.id }); }
      else { confirmKey = el.dataset.key; confirmAt = Date.now(); clearTimeout(confirmTimer); confirmTimer = setTimeout(function () { confirmKey = null; renderPanel(); }, 3000); renderPanel(); }
    }
    else if (a === 'mfill') act('mission', { id: +el.dataset.id, faction: el.dataset.faction, district: msrc || activeId }, 'Mission filled.');
    else if (a === 'mkside') { mk.side = el.dataset.side; mk.price = null; renderPanel(); }
    else if (a === 'mkqty') {
      var dst = Math.floor(S.views[mk.district].resources[mk.res].amount), mq = mk.side === 'sell' ? Math.min(CFG.exchange.maxQty, dst) : CFG.exchange.maxQty;
      mk.qty = clamp(el.dataset.delta === 'max' ? mq : mk.qty + (+el.dataset.delta * sh), 1, Math.max(1, mq)); renderPanel();
    }
    else if (a === 'mkprice') {
      var xr = S.exchange.resources[mk.res];
      if (el.dataset.price !== undefined) mk.price = +el.dataset.price;
      else mk.price = Math.max(0.01, Math.round((mk.price + (+el.dataset.delta * sh)) * 100) / 100);
      mk.price = clamp(mk.price, Math.round(xr.ref * 0.2 * 100) / 100, Math.round(xr.ref * 5 * 100) / 100); renderPanel();
    }
    else if (a === 'mksubmit') {
      var o = { side: mk.side, resource: mk.res, price: mk.price, qty: mk.qty, district: mk.district, ttl: mk.ttl };
      act('market', o).then(function (d) {
        if (d && d.ok && d.filled < o.qty) toast(d.filled ? 'Part filled (' + d.filled + ' of ' + o.qty + '); the rest is waiting in the book.' : 'Order placed. It rests in the book until someone meets your price.', true);
      });
    }
    else if (a === 'mkcancel') act('market-cancel', { orderId: +el.dataset.id }, 'Order cancelled.');
    else if (a === 'cmode') { convoyMode = el.dataset.mode; renderPanel(); }
    else if (a === 'xstep') {
      var xs = el.dataset.side, xr = el.dataset.res, bag = xdraft[xs];
      var maxv = xs === 'sell' ? Math.min(S.express.limits[xr], Math.floor(S.coreRes[xr].amount)) : S.express.limits[xr];
      var nv = clamp((bag[xr] || 0) + (+el.dataset.delta * sh), 0, maxv);
      if (nv) bag[xr] = nv; else delete bag[xr];
      renderPanel();
    }
    else if (a === 'xclear') { xdraft = { sell: {}, buy: {} }; renderPanel(); }
    else if (a === 'xprefill') {
      xdraft = { sell: {}, buy: {} };
      shortfalls(S.hazard).forEach(function (r) { xdraft.buy[r.resource] = Math.min(S.express.limits[r.resource], Math.ceil(r.need - r.have)); });
      convoyMode = 'express'; go('convoy');
    }
    else if (a === 'xdispatch') {
      act('express', { sell: xdraft.sell, buy: xdraft.buy }, 'Express convoy dispatched.').then(function (d) {
        if (d && d.ok) { xdraft = { sell: {}, buy: {} }; renderPanel(); }
      });
    }
    else if (a === 'contract') {
      var side = el.dataset.side, res = el.dataset.res;
      var cur = S.contracts[side][res] || 0, v = clamp(cur + (+el.dataset.delta * sh), 0, S.market.limits[res]);
      S.contracts[side][res] = v; if (!v) delete S.contracts[side][res];
      renderPanel();
      act('contract', { resource: res, side: side, amount: v });
    }
  });
  document.addEventListener('focusin', function (e) { if (e.target.classList && e.target.classList.contains('numin')) e.target.select(); });
  document.addEventListener('focusout', function (e) { if (e.target.classList && e.target.classList.contains('numin') && panelDeferred) setTimeout(renderPanel, 0); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('numin')) e.target.blur(); });
  function commitNum(el) {
    var kind = el.dataset.num, raw = String(el.value).replace(',', '.').trim(), v = parseFloat(raw);
    if (raw === '' || !isFinite(v)) { renderPanel(); return; }
    var n = Math.round(v);
    if (kind === 'ship') {
      var have = Math.floor(S.views[ship.from].resources[ship.res].amount);
      ship.qty = clamp(n, 1, Math.max(1, Math.min(CFG.logistics.shipmentMax, have)));
    } else if (kind === 'rdraft') {
      route[el.dataset.f] = Math.max(el.dataset.f === 'rate' ? 1 : 0, n);
    } else if (kind === 'rtarget') {
      var rg = S.routes.filter(function (x) { return x.id === +el.dataset.id; })[0];
      if (rg) act('route', { from: rg.fromDistrict, to: rg.toDistrict, resource: rg.resource, rate: rg.rate, reserve: rg.reserve, target: Math.max(0, n) });
    } else if (kind === 'rexist') {
      var rt = S.routes.filter(function (x) { return x.id === +el.dataset.id; })[0];
      if (rt) act('route', { from: rt.fromDistrict, to: rt.toDistrict, resource: rt.resource, rate: Math.max(0, n), reserve: rt.reserve });
    } else if (kind === 'mkqty') {
      var dst = Math.floor(S.views[mk.district].resources[mk.res].amount), mq = mk.side === 'sell' ? Math.min(CFG.exchange.maxQty, dst) : CFG.exchange.maxQty;
      mk.qty = clamp(n, 1, Math.max(1, mq));
    } else if (kind === 'mkprice') {
      var xr = S.exchange.resources[mk.res];
      mk.price = clamp(Math.round(v * 100) / 100, Math.round(xr.ref * 0.2 * 100) / 100, Math.round(xr.ref * 5 * 100) / 100);
    } else if (kind === 'contract') {
      var res = el.dataset.res, side = el.dataset.side, cv = clamp(n, 0, S.market.limits[res]);
      S.contracts[side][res] = cv; if (!cv) delete S.contracts[side][res];
      act('contract', { resource: res, side: side, amount: cv });
    } else if (kind === 'xdraft') {
      var xs = el.dataset.side, xrs = el.dataset.res, bag = xdraft[xs];
      var maxv = xs === 'sell' ? Math.min(S.express.limits[xrs], Math.floor(S.coreRes[xrs].amount)) : S.express.limits[xrs];
      var nv = clamp(n, 0, maxv);
      if (nv) bag[xrs] = nv; else delete bag[xrs];
    }
    renderPanel();
  }
  document.addEventListener('change', function (e) {
    if (e.target.classList && e.target.classList.contains('onum')) return; // orbit.js handles its own fields
    if (e.target.classList && e.target.classList.contains('numin')) { commitNum(e.target); return; }
    var el = e.target.closest('[data-sel]');
    if (!el) return;
    var k = el.dataset.sel;
    if (k.indexOf('s:') === 0) { msrc = +el.value; renderPanel(); return; }
    if (k === 'hq:ship') { if (hqPick) hqPick.ship = +el.value; return; }
    if (k.indexOf('m:') === 0) { var mkk = k.slice(2); if (mkk === 'res') { mk.res = el.value; mk.price = null; mk.qty = 50; } else mk[mkk] = mkk === 'ttl' || mkk === 'district' ? +el.value : el.value; if (mkk === 'district') mk.qty = Math.max(1, mk.qty); renderPanel(); return; }
    if (k.indexOf('r:') === 0) { var rk = k.slice(2); if (rk === 'res') route.res = el.value; else route[rk] = +el.value; }
    else if (k === 'res') ship.res = el.value; else ship[k] = +el.value;
    renderPanel();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (popOpen) { closePop(); return; }
      if (drawer) { drawer = null; renderNav(); renderDrawer(); return; }
      var m = document.querySelector('.modal-bg'); if (m && !m.querySelector('[data-lock]')) { m.remove(); return; }
      if (ws) { ws = null; renderAll(); return; }
      if (sel) { sel = null; document.body.classList.remove('panel-full'); renderAll(); }
      return;
    }
    // One key per screen, as long as nothing is being typed and nothing else has the screen.
    if (!S || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    var tg = e.target, tag = tg && tg.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (tg && tg.isContentEditable)) return;
    if (document.querySelector('.modal-bg, #vn:not([style*="none"]), #mailv')) return;
    if ((e.key === 'Enter' || e.key === ' ') && tg && tg.dataset && tg.dataset.act === 'tab' && tag !== 'BUTTON') { e.preventDefault(); tg.click(); return; }
    var k = e.key.toLowerCase();
    if (k === 'm') { go('map'); return; }
    if (k === '+' || k === '=') { zoomBy(0.75); return; }
    if (k === '-' || k === '_') { zoomBy(1 / 0.75); return; }
    if (k === '0') { fitView(); return; }
    var hit = null;
    navGroups().forEach(function (g) { g.tabs.forEach(function (t) { if (t[3] === k) hit = t[0]; }); });
    if (hit) { e.preventDefault(); if (hit === ws) { ws = null; renderAll(); } else go(hit); }
  });
  $('bell-btn').innerHTML = icon('bell', 18) + '<span class="dotc" id="bell-n" hidden></span>';
  $('mail-btn').innerHTML = icon('mail', 18) + '<span class="dotc" id="mail-n" hidden></span>';
  $('bell-btn').addEventListener('click', togglePop);
  $('mail-btn').addEventListener('click', function () { messages(); });
  if ($('menu-btn')) $('menu-btn').addEventListener('click', menu);
  $('sheet-close').addEventListener('click', function () { ws = null; renderAll(); });
  if (MOBILE) $('sheet-close').innerHTML = icon('back', 18);
  if ($('places')) $('places').addEventListener('wheel', function (e) { if (this.scrollWidth > this.clientWidth && !e.shiftKey) { this.scrollLeft += e.deltaY || e.deltaX; e.preventDefault(); } }, { passive: false });
  if ($('drawer')) $('drawer').addEventListener('click', function (e) { if (e.target === $('drawer')) { drawer = null; renderNav(); renderDrawer(); } });
  // The map: wheel to zoom, drag to pan, pinch on a touch screen. A drag is not a click, so the tap that ends one is ignored.
  (function () {
    var svg = $('radar'), pts = {}, start = null, moved = false, gap = 0, mid = null;
    function two() { var k = Object.keys(pts); if (k.length < 2) return null; var a = pts[k[0]], b = pts[k[1]]; return { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 }; }
    svg.addEventListener('wheel', function (e) { if (!S) return; e.preventDefault(); zoomBy(Math.exp(clamp(e.deltaY, -160, 160) * 0.002), e.clientX, e.clientY); }, { passive: false });
    svg.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pts[e.pointerId] = [e.clientX, e.clientY];
      var n = Object.keys(pts).length;
      if (n === 1) { start = [e.clientX, e.clientY]; moved = false; }
      else if (n === 2) { var t = two(); gap = t.d; mid = [t.x, t.y]; moved = true; }
    });
    svg.addEventListener('pointermove', function (e) {
      var p = pts[e.pointerId]; if (!p) return;
      var n = Object.keys(pts).length, dx = e.clientX - p[0], dy = e.clientY - p[1];
      if (n === 1) {
        if (!moved && Math.hypot(e.clientX - start[0], e.clientY - start[1]) < 8) return;
        if (!moved) { moved = true; try { svg.setPointerCapture(e.pointerId); } catch (x) { /* not capturable */ } svg.classList.add('panning'); }
        pts[e.pointerId] = [e.clientX, e.clientY]; panBy(dx, dy);
      } else if (n === 2) {
        pts[e.pointerId] = [e.clientX, e.clientY];
        var t = two(); zoomBy(gap / t.d, t.x, t.y); panBy(t.x - mid[0], t.y - mid[1]); gap = t.d; mid = [t.x, t.y];
      }
    });
    function up(e) {
      if (!pts[e.pointerId]) return;
      delete pts[e.pointerId];
      if (moved) dragEndAt = Date.now();
      if (!Object.keys(pts).length) { moved = false; svg.classList.remove('panning'); }
    }
    svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
  })();
  if ($('legend')) $('legend').innerHTML = '<span>' + icon('lock', 11) + ' locked</span><span>- - dashed: being built</span><span>#n: place in the work queue</span><span>! hazard</span><span>OFF / DOWN: not running</span><span>▲n: level</span>';

  // ------------------------------------------------------------------ state flow
  function renderAll() {
    if (!S) return;
    if (radarFor !== activeId) { radarFor = activeId; viewR = 0; buildRadar(); }
    if (!activeD().orbital) groundId = activeId;
    var picked = !!(sel && sel.ring);
    document.body.classList.toggle('orbit-mode', inOrbit());
    document.body.classList.toggle('has-sel', picked);
    renderPlaces();
    renderTop(); renderStockbar(); renderRadar(); renderNav(); renderDrawer(); renderPanel(); renderQueue(); renderNet(); renderPop(); renderMessages(); checkModals();
    window.Story.refresh();
  }

  function merge(ns) {
    var v = ns.views[activeId];
    return Object.assign({}, ns, {
      buildings: v.buildings, orders: v.orders, queueMax: v.queueMax, slots: v.slots || { count: 1, max: 1, next: null }, locks: v.locks || [], resources: v.resources, hub: v.hub, energy: v.energy, defense: v.defense,
      coreRes: ns.resources, coreBuildings: ns.buildings,
      allOrders: Object.keys(ns.views).reduce(function (a, k) {
        return a.concat(ns.views[k].orders.map(function (o) { return Object.assign({ dname: ns.views[k].core ? '' : ns.views[k].name, did: ns.views[k].id }, o); }));
      }, [])
    });
  }
  // Look at another place. `enter` also goes back to the map; `look` leaves whatever screen is open where it is.
  function look(id) {
    if (!RAW || id === null || !RAW.views[id]) return;
    activeId = id; sel = null; confirmKey = null;
    S = merge(RAW);
  }
  function enter(id) {
    if (!RAW || !RAW.views[id]) return;
    look(id); ws = null; drawer = null; renderAll();
  }
  function setState(ns) {
    if (ns && ns.lost) { showLost(ns.lost); return; }
    var first = !S;
    RAW = ns;
    if (activeId === null || !ns.views[activeId]) activeId = ns.districts.filter(function (d) { return d.core; })[0].id;
    S = merge(ns);
    window.Story.setView(ns.story);
    offset = ns.serverNow - Date.now();
    // surface notable new events as toasts
    var top = ns.events.length ? ns.events[0].id : 0;
    if (!first && lastEventId !== null) {
      ns.events.filter(function (e) { return e.id > lastEventId && e.kind !== 'info'; }).reverse().slice(-3).forEach(function (e) {
        toast(e.message, e.kind === 'good');
      });
    }
    lastEventId = Math.max(lastEventId || 0, top);
    if (first) { var pv0 = storeGet('pins:' + ns.user); pins = pv0 === null ? null : pv0 ? pv0.split(',') : []; }
    if (first) bellSeen = +(storeGet('bell:' + ns.user) || 0) || top;
    renderAll();
  }

  var lastFrame = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    if (!S || t - lastFrame < 70) return;
    if (window.Mini && window.Mini.isOpen()) return; // hidden behind the puzzle: redrawing it only costs the GPU
    lastFrame = t;
    var f = frac();
    frameStock(f); frameQueue(f); frameRadar(f);
    if (!userView) { goalR = targetR; goalC = [0, 0]; }
    var off = Math.abs(viewC[0] - goalC[0]) + Math.abs(viewC[1] - goalC[1]);
    if (Math.abs(viewR - goalR) > 0.5 || off > 0.5) { viewR += (goalR - viewR) * 0.16; viewC[0] += (goalC[0] - viewC[0]) * 0.16; viewC[1] += (goalC[1] - viewC[1]) * 0.16; setView(viewR); }
    else if (viewR !== goalR || off) { viewR = goalR; viewC = goalC.slice(); setView(viewR); }
    var now = Date.now() + offset;
    var cvEl = $('c-convoy'); if (cvEl) cvEl.innerHTML = convoyHtml();
    framePanel();
  }

  function connect() {
    if (es) { try { es.close(); } catch (e) { /* already closed */ } }
    es = new EventSource('/api/stream');
    es.onmessage = function (e) {
      lastMsgAt = Date.now();
      var was = connected;
      if (!apiDown) connected = true; // a live stream isn't proof that sending works
      setState(JSON.parse(e.data));
      if ((!was || pending.length) && connected) flush();
    };
    es.addEventListener('idle', function () { lastMsgAt = Date.now(); }); // the colony is not being simulated, so nothing changed
    es.onerror = function () {
      goOffline();
      // The browser retries on its own unless the stream was closed outright (e.g. a restart).
      if (es && es.readyState === 2) setTimeout(connect, 3000);
      api('state').catch(function () { /* still offline */ });
    };
  }
  // Watchdog: a connection can die silently (laptop sleep, flaky wifi). If the live stream goes
  // quiet for several ticks, treat it as lost and reconnect, so queued clicks are not left hanging.
  setInterval(function () {
    if (!S) return;
    if (connected && Date.now() - lastMsgAt > Math.max(45000, S.tickMs * 3)) { goOffline(); connect(); }
  }, 5000);
  // While offline (or while sends fail) keep checking whether the server is reachable again.
  function probe() {
    if (!S || !(apiDown || !connected)) return;
    api('state').then(function (d) {
      if (!d || !d.user) return;
      apiDown = false; connected = true; lastMsgAt = Date.now();
      setState(d);
      if (!es || es.readyState !== 1) connect();
      flush();
    }).catch(function () { /* still offline */ });
  }
  setInterval(probe, 4000);
  window.addEventListener('online', function () { if (!connected) connect(); probe(); });
  window.addEventListener('offline', function () { goOffline(); });
  window.addEventListener('beforeunload', function (e) { if (pending.length) { e.preventDefault(); e.returnValue = ''; } });

  function applyTheme() {
    var ui = CFG.ui || {};
    if (ui.title) document.title = ui.title;
    var br = document.querySelector('.brand');
    if (ui.brand && br) br.textContent = ui.brand;
    if (window.Terms) window.Terms.init(ui.terms);
  }
  window.Orbit.init({
    S: function () { return S; }, CFG: function () { return CFG; }, act: act, esc: esc, fmt: fmt, icon: icon, pill: pill, toast: toast,
    brokerage: brokerNote, enter: function (id) { enter(id); }, enterOrbit: enterOrbit, activeD: activeD, redraw: function () { if (S) { lastPanel = ''; lastSheet = ''; renderPanel(); } }
  });
  if (window.Mini) window.Mini.init({ S: function () { return S; }, act: act, esc: esc, icon: icon, toast: toast, now: function () { return Date.now() + offset; } });
  window.Story.init({ api: api, esc: esc, icon: icon, toast: toast, compact: function () { return MOBILE || !!ws; }, changed: function () { if (S) { renderTop(); renderPanel(); renderPop(); renderMessages(); renderDrawer(); } } });
  // The server guesses the layout from what the browser says it is. If the real screen disagrees and the player has not
  // chosen for themselves, switch once (a narrow window gets the phone layout, a wide one with a mouse the desk layout).
  (function () {
    var q = location.search;
    if (/[?&]auto=1/.test(q)) { try { history.replaceState(null, '', '/game'); } catch (e) { /* the address stays as it is */ } return; } // sent here by the check below: a reload checks again
    if (/[?&]ui=/.test(q) || /(?:^|;\s*)ft_ui=/.test(document.cookie)) return;
    var w = window.innerWidth, coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    if (!MOBILE && w && (w < 760 || (coarse && Math.min(screen.width, screen.height) < 600))) location.replace('/game?ui=mobile&auto=1');
    else if (MOBILE && w >= 1000 && !coarse) location.replace('/game?ui=desktop&auto=1');
  })();
  api('config').then(function (cfg) {
    CFG = cfg;
    applyTheme();
    return api('state');
  }).then(function (st) {
    setState(st);
    requestAnimationFrame(frame);
    connect();
  });
})();
