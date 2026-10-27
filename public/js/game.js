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
  var route = { from: null, to: null, res: 'scrap', rate: 10, reserve: 0 }; // route being composed
  var ship = { from: null, to: null, res: 'scrap', qty: 100 }; // shipment being composed
  var sel = null;          // { ring, slot } | { hub: true } | null
  var tab = 'brief';
  var offset = 0;          // server clock - client clock
  var lastEventId = null;
  var shown = {};          // modals already shown (per page load)
  var connected = true;
  var confirmKey = null, confirmTimer = null;
  var restarting = false;  // suppresses the collapse modal while a restart is in flight
  var slotEls = {};        // "r:s" -> {g, cell, ...}
  var ringLabels = {};     // ring -> svg text (plot size / locked notice)
  var viewR = 0, targetR = 0; // radar zoom: current / target visible radius
  var acking = false;      // away report acknowledgement in flight
  var pending = [];        // actions clicked while offline, waiting to be sent
  var pendingSeq = 0, flushing = false, lastMsgAt = Date.now(), es = null;
  var apiDown = false;     // sends are failing even if the live stream still looks alive
  var convoyMode = 'scheduled'; // 'scheduled' | 'express'
  var xdraft = { sell: {}, buy: {} }; // express order being composed
  var hubEl = null;
  var STEP = {}; // every stepper moves by 10 (hold Shift for 100); type a value for anything else
  var TABS = [['brief', 'Brief', 'check'], ['site', 'Site', 'site'], ['hub', 'Hub', 'hub'], ['people', 'People', 'users'], ['districts', 'Districts', 'map'], ['logistics', 'Logistics', 'route'], ['convoy', 'Convoy', 'truck'], ['exchange', 'Exchange', 'scale'], ['missions', 'Missions', 'flag'], ['log', 'Log', 'list']];

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
      if (r.status === 401) { location.href = '/'; return new Promise(function () {}); }
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
    if (path === 'boost') { var bb = S && buildingAt(body.ring, body.slot), opt = bb && CFG.buildings[bb.type].optional; return (body.enabled ? 'Switch on ' : 'Switch off ') + (opt ? opt.label : 'optional input') + ' (' + where(body.ring, body.slot) + ')'; }
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
    return Promise.resolve({ ok: true, queued: true });
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
    el.className = 'toast' + (ok ? ' ok' : '');
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
    var t = CFG.districtTypes[d.type];
    return { rings: t.rings, ringPlotSize: t.ringPlotSize, neighbors: t.neighbors, levels: t.levels, rotation: t.ringRotation };
  }
  function plotName(ring) { return CFG.plotSizes[GEO().ringPlotSize[ring]].name; }
  function plotMultFor(def, ring) {
    var deficit = Math.max(0, def.minPlotSize - GEO().ringPlotSize[ring]);
    return Math.pow(CFG.plotPenalty, deficit);
  }
  function setView(R) { $('radar').setAttribute('viewBox', (-R).toFixed(1) + ' ' + (-R).toFixed(1) + ' ' + (2 * R).toFixed(1) + ' ' + (2 * R).toFixed(1)); }
  // Zoom the radar to fit the unlocked rings plus a peek at the next one.
  function zoomTarget() {
    var unlocked = Object.keys(S.hub.rings).length, total = Object.keys(GEO().rings).length;
    return ringOuter(Math.min(unlocked + 1, total)) + 30;
  }

  // ------------------------------------------------------------------ derived lookups
  function buildingAt(r, s) { return S.buildings.filter(function (b) { return b.ring === r && b.slot === s; })[0]; }
  function orderAt(r, s) { return S.orders.filter(function (o) { return o.kind === 'build' && o.data.ring === r && o.data.slot === s; })[0]; }
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
  function frac() {
    if (!S) return 0;
    return clamp(1 - (S.nextTickAt - (Date.now() + offset)) / S.tickMs, 0, 1);
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
        var g = svgEl('g', { 'class': 'slot empty', tabindex: 0, role: 'button' }, slotsG);
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
    var t1 = svgEl('text', { x: 0, y: -3, 'font-size': activeD().core ? 15 : 12 }, hub); t1.textContent = activeD().core ? 'HUB' : activeD().name.replace(/^The /, '').toUpperCase();
    var t2 = svgEl('text', { x: 0, y: 15, 'font-size': 10, 'letter-spacing': '.12em' }, hub);
    hub.addEventListener('click', function () { sel = { hub: true }; tab = 'hub'; renderAll(); });
    hub.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hub.dispatchEvent(new Event('click')); } });
    hubEl = { g: hub, sub: t2 };
    svg.onclick = function (e) { if (e.target === svg) { sel = null; renderAll(); } };
  }

  function onSlot(ring, slot) {
    if (!slotUnlocked(ring, slot)) { sel = { ring: ring, slot: slot }; tab = 'site'; renderAll(); return; }
    sel = { ring: ring, slot: slot };
    tab = 'site';
    confirmKey = null;
    renderAll();
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
        if (!b.paused && b.status && b.status !== 'running') cls += (b.eff < 0.01 ? ' stalled' : ' low');
        if (b.plot < 0.999) cls += ' cramped';
        tag = b.paused ? 'OFF' : b.status === 'no_recipe' ? 'SET?' : b.status === 'resetting' ? 'RESET' : b.status === 'damaged' ? 'DOWN' : (b.eff < 0.995 ? pct(b.eff) : (b.plot < 0.999 ? '×' + b.plot.toFixed(2) : ''));
        name = def.name + ' (' + name + ')' + (b.plot < 0.999 ? ' · cramped plot' : '');
        if (b.mark) { cls += ' hz-' + b.mark; name += ' · ' + MARK_TXT[b.mark]; }
        if (!tag && b.level > 1) tag = '▲' + b.level;
        if (!tag && def.housing && b.comfort) { tag = (b.comfort > 0 ? '+' : '−') + Math.abs(b.comfort); cls += b.comfort > 0 ? ' cmf-good' : ' cmf-bad'; }
      } else if (q) {
        cls += ' queued'; c = CFG.buildings[q.body.type].color; icoName = q.body.type; tag = 'QUEUED';
        name = 'Queued while offline: ' + CFG.buildings[q.body.type].name;
      } else if (o) {
        cls += ' building'; c = CFG.buildings[o.data.type].color; icoName = o.data.type;
        name = 'Building ' + CFG.buildings[o.data.type].name;
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
      el.plus.style.display = (!b && !o && !q && unlocked) ? '' : 'none';
      el.pbg.style.display = o ? '' : 'none';
      el.pb.style.display = o ? '' : 'none';
      el.ico.setAttribute('y', o || tag ? -el.isz / 2 - 4 : -el.isz / 2);
    });
    Object.keys(ringLabels).forEach(function (r) {
      var open = !!S.hub.rings[r];
      ringLabels[r].textContent = open ? plotName(r).toUpperCase() + ' PLOTS' : 'RING ' + r + ' · ' + plotName(r).toUpperCase() + ' PLOTS · LOCKED · ' + (activeD().core ? 'HUB' : 'DISTRICT') + ' LV ' + r;
      ringLabels[r].setAttribute('class', 'ring-label' + (open ? ' open' : ''));
    });
    targetR = zoomTarget();
    if (!viewR) { viewR = targetR; setView(viewR); }
    hubEl.g.classList.toggle('sel', !!(sel && sel.hub));
    hubEl.sub.textContent = S.hub.upgrading ? 'UPGRADING' : 'LEVEL ' + activeD().level;
  }

  // construction progress bars on the map update every frame
  function frameRadar(f) {
    S.orders.forEach(function (o) {
      if (o.kind !== 'build') return;
      var el = slotEls[o.data.ring + ':' + o.data.slot];
      if (el) el.pb.setAttribute('width', (32 * clamp((o.total - o.remaining + f) / o.total, 0, 1)).toFixed(1));
    });
  }

  // ------------------------------------------------------------------ top bar & resources
  function renderTop() {
    var c = S.colony;
    $('c-credits').innerHTML = fmt(c.credits) + ' <small>cr</small>';
    $('c-pop').innerHTML = c.population + ' <small>/ ' + c.maxPopulation + '</small>';
    $('c-pop').title = 'Housing: hub quarters ' + c.housing.base + (c.housing.built ? ' + homes ' + Math.floor(c.housing.built) : '');
    $('c-crew').innerHTML = '<span class="' + (c.staffing.ratio < 0.999 ? 'warn' : '') + '">' + pct(c.staffing.ratio) + '</span>';
    $('c-crew').title = Math.floor(c.staffing.workforce) + ' hands for ' + c.staffing.posts + ' posts';
    var m = clamp(c.morale, 0, 100);
    $('c-morale').innerHTML = Math.round(m) + '<small>%</small>';
    $('c-morale').title = 'Target ' + Math.round(c.moraleInfo.target) + ' (base ' + c.moraleInfo.base + ', homes ' + (c.moraleInfo.comfort >= 0 ? '+' : '') + c.moraleInfo.comfort.toFixed(1) + ', meals +' + c.moraleInfo.meals.toFixed(0) + ') · output ×' + c.moraleInfo.productivity.toFixed(2);
    var mb = $('c-morale-bar'); mb.style.width = m + '%'; mb.style.background = m > 60 ? 'var(--good)' : m > 30 ? 'var(--warn)' : 'var(--bad)';
    var e = S.energy;
    var ok = e.satisfaction >= 0.999;
    $('c-energy').innerHTML = '<span class="' + (ok ? '' : 'bad') + '">' + Math.floor(e.supply) + '</span><small>/ ' + Math.ceil(e.demand) + ' used</small>';
    var eb = $('c-energy-bar'); eb.style.width = (e.demand ? clamp(e.supply / e.demand, 0, 1) * 100 : 100) + '%';
    eb.style.background = ok ? 'var(--energy)' : e.satisfaction > 0.5 ? 'var(--warn)' : 'var(--bad)';
    var d = S.doom, dc = $('c-doom');
    if (!d) { dc.innerHTML = '<span class="good">Stable</span>'; dc.title = 'No critical supply is draining at current rates.'; }
    else {
      var urgent = d.phase === 'starving' || d.ticks <= 20;
      dc.innerHTML = '<span class="' + (urgent ? 'bad' : d.ticks <= 40 ? 'warn' : '') + '">' + d.ticks + 't</span><small>' + clock(d.ticks * S.tickMs) + '</small>';
      dc.title = d.phase === 'starving' ? 'Collapse in ' + d.ticks + ' ticks unless supplies are restored.'
        : 'If nothing changes, ' + d.resources.map(function (r) { return CFG.resources[r].name; }).join(' & ') + ' runs short in ' + d.untilShortage + ' ticks and the colony collapses ' + d.ticks + ' ticks from now.';
    }
    $('c-tick').textContent = '#' + S.tick;
    $('c-user').textContent = S.user;
  }

  var resBuilt = false;
  function buildResources() {
    var h = '';
    Object.keys(CFG.resources).forEach(function (k) {
      var r = CFG.resources[k];
      h += '<div class="res" data-res="' + k + '" title="Tier ' + r.tier + '"><div class="row"><span class="dot" style="background:' + r.color + '"></span>' +
        '<span class="nm">' + esc(r.name) + '</span><span class="amt num" data-f="amt">0</span></div>' +
        '<div class="sub"><span data-f="net" class="num"></span><span data-f="note"></span></div>' +
        '<div class="bar"><i data-f="bar" style="background:' + r.color + '"></i></div></div>';
    });
    $('resources').innerHTML = h;
    resBuilt = true;
  }
  function frameResources(f) {
    Object.keys(CFG.resources).forEach(function (k) {
      var row = document.querySelector('.res[data-res="' + k + '"]');
      if (!row) return;
      var r = S.resources[k];
      var def = CFG.resources[k];
      row.classList.toggle('hidden', !!(def.showFromHub && def.showFromHub > S.colony.hubLevel && r.amount < 0.5 && r.produced <= 0 && r.consumed <= 0));
      var shownAmt = clamp(r.amount + r.net * f, 0, r.cap);
      row.querySelector('[data-f=amt]').textContent = fmt(shownAmt);
      var net = row.querySelector('[data-f=net]');
      net.textContent = rate(r.net) + '/t';
      net.className = 'num ' + (r.net > 0.05 ? 'good' : r.net < -0.05 ? 'bad' : '');
      var note = row.querySelector('[data-f=note]');
      var crit = !!(CFG.resources[k].critical && r.amount < 0.5 && r.net < 0);
      var txt = '', cls = '';
      if (r.ticksLeft !== null && r.ticksLeft < 40) { txt = r.amount < 0.5 ? 'EMPTY' : 'empty in ' + Math.ceil(r.ticksLeft) + 't'; cls = r.ticksLeft < 15 ? 'bad' : 'warn'; }
      else if (r.amount >= r.cap - 0.5 && r.net > 0) { txt = 'FULL · wasting'; cls = 'warn'; }
      else txt = 'cap ' + fmt(r.cap);
      if (cls === '' && (r.routeIn || r.routeOut)) { txt = (r.routeIn ? '↘ +' + fmt(r.routeIn) + ' routed in' : '') + (r.routeIn && r.routeOut ? ' · ' : '') + (r.routeOut ? '↗ −' + fmt(r.routeOut) + ' routed out' : ''); cls = 'dim'; }
      note.textContent = txt; note.className = cls;
      row.classList.toggle('crit', crit);
      row.querySelector('[data-f=bar]').style.width = (shownAmt / r.cap * 100).toFixed(1) + '%';
    });
  }

  // ------------------------------------------------------------------ alerts + legend
  function renderAlerts() {
    var h = '', c = S.colony;
    if (!connected) h += '<div class="alert warn">' + icon('warn', 14) + (pending.length ? 'Offline: ' + pending.length + ' action' + (pending.length === 1 ? '' : 's') + ' waiting to be sent' : 'Connection lost. Retrying…') + '</div>';
    else if (flushing) h += '<div class="alert warn">' + icon('truck', 14) + 'Reconnected: sending ' + pending.length + ' queued action' + (pending.length === 1 ? '' : 's') + '…</div>';
    if (c.starving.length) {
      var left = Math.ceil(c.morale / (100 / CFG.failureThresholdTicks));
      h += '<div class="alert">' + icon('warn', 14) + 'Shortage of ' + c.starving.map(function (r) { return CFG.resources[r].name; }).join(' & ') + ' · collapse in ' + left + ' ticks</div>';
    } else {
      ['clean_water', 'rations'].forEach(function (k) {
        var r = S.resources[k];
        if (r.ticksLeft !== null && r.ticksLeft < 12) h += '<div class="alert warn">' + icon('warn', 14) + CFG.resources[k].name + ' runs out in ' + Math.ceil(r.ticksLeft) + ' ticks</div>';
      });
    }
    if (S.energy.satisfaction < 0.999) h += '<div class="alert warn">' + icon('bolt', 14) + 'Brownout · production at ' + pct(S.energy.satisfaction) + '</div>';
    if (S.hub.eff < 0.999) h += '<div class="alert warn">' + icon('hub', 14) + 'Hub under-maintained: short of ' + esc(CFG.resources[S.hub.limiting].name) + ' · hub power output cut</div>';
    var hz = S.hazard;
    if (hz && hz.state === 'forecast') {
      var risky = hz.prep < 0.5 && hz.ticksUntil <= 12;
      h += '<div class="alert ' + (risky ? '' : 'warn') + '" style="pointer-events:auto;cursor:pointer" data-act="tab" data-tab="brief">' + icon('warn', 14) + esc(hz.name) + ' in ' + hz.ticksUntil + 't (' + clock(hz.ticksUntil * S.tickMs) + ') · ' + Math.round(hz.prep * 100) + '% prepared</div>';
    } else if (hz) {
      var first = hz.penalty.concat(hz.cost)[0] || '';
      h += '<div class="alert' + (hz.severity > 0.02 ? '' : ' warn') + '" style="pointer-events:auto;cursor:pointer" data-act="tab" data-tab="brief">' + icon('warn', 14) + esc(hz.name) + (hz.severity > 0.02 ? ' in effect' : ' being weathered') + (first ? ' · ' + esc(first) : '') + ' · ' + hz.ticksLeft + 't left</div>';
    }
    if ($('alerts').dataset.h !== h) { $('alerts').innerHTML = h; $('alerts').dataset.h = h; }
  }
  // ------------------------------------------------------------------ right panel
  function renderTabs() {
    var next = GEO().levels[activeD().level + 1];
    var dot = next && !S.hub.upgrading && canAfford(next.upgradeCost) && (activeD().core || activeD().level + 1 <= S.districtLevelCap);
    var ddot = S.districtsUnlocked && Object.keys(CFG.districtTypes).some(function (k) {
      return S.foundable[k] && !S.districts.some(function (d) { return d.type === k; }) && !S.founding.some(function (f) { return f.type === k; }) && canAffordCore(CFG.districtTypes[k].foundCost);
    });
    var h = TABS.map(function (t) {
      return '<button class="tab" role="tab" data-act="tab" data-tab="' + t[0] + '" aria-selected="' + (tab === t[0]) + '" title="' + t[1] + '" aria-label="' + t[1] + '">' + icon(t[2], 20) + '<span>' + t[1] + '</span>' +
        ((t[0] === 'hub' && dot) || (t[0] === 'districts' && ddot) ? '<span class="badge" style="background:var(--good)"></span>' : '') +
        (t[0] === 'brief' && S.brief.remaining ? '<span class="count">' + S.brief.remaining + '</span>' : '') + '</button>';
    }).join('');
    if ($('tabs').dataset.h !== h) { $('tabs').innerHTML = h; $('tabs').dataset.h = h; }
  }

  function siteTab() {
    if (!sel || sel.hub) {
      var n = S.buildings.length;
      return '<div class="empty-state">' + icon('site', 36) + '<div>Select a slot on the radar.</div>' +
        '<div class="dim" style="margin-top:8px;font-size:12px">' + n + ' structure' + (n === 1 ? '' : 's') + ' online · ' + S.orders.length + ' under construction</div></div>' +
        '<div class="note">Place producers next to the buildings they pair with. Neighbours in the same ring and touching slots in adjacent rings count for adjacency bonuses.</div>';
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
        '<div class="note warn">This order has not reached the server. It will be sent when you reconnect, and may be rejected if things have changed.</div>' +
        '<div class="actions"><button class="btn danger" data-act="pcancel" data-id="' + qd.id + '">Discard queued order</button></div>';
    }
    if (o) {
      var d = CFG.buildings[o.data.type];
      return '<div class="p-title" style="--c:' + d.color + '">' + icon(o.data.type, 22) + '<h3>' + esc(d.name) + '</h3></div><div class="label">' + head + ' · under construction</div>' +
        '<p class="p-desc">' + o.remaining + ' tick' + (o.remaining === 1 ? '' : 's') + ' remaining.</p>' +
        '<div class="actions"><button class="btn danger" data-act="cancel" data-id="' + o.id + '">Cancel &amp; refund</button></div>';
    }
    if (b) return builtPanel(b, head);
    return buildMenu(r, s, head);
  }

  var MARK_TXT = { hit: 'Hurt by the current hazard', upkeep: 'Paying the hazard\'s maintenance cost', risk: 'In the forecast hazard\'s path' };
  var STATUS = {
    running: ['Running', 'good'], paused: ['Paused', 'dim'], no_power: ['No power', 'bad'], low_power: ['Low power', 'warn'],
    starved: ['Missing inputs', 'bad'], low_input: ['Short on inputs', 'warn'], damaged: ['Damaged: awaiting repairs', 'bad'], understaffed: ['Short-staffed', 'warn'],
    no_recipe: ['No recipe chosen', 'warn'], resetting: ['Resetting', 'warn']
  };
  function plotName2(size) { return CFG.plotSizes[size].name; }
  function builtPanel(b, head) {
    var d = CFG.buildings[b.type], st = STATUS[b.paused ? 'paused' : b.status] || STATUS.running;
    var why = (!b.paused && b.limiting) ? ' <span class="dim">(' + esc(CFG.resources[b.limiting].name) + ')</span>' : '';
    var h = '<div class="p-title" style="--c:' + d.color + '">' + icon(b.type, 22) + '<h3>' + esc(d.name) + '</h3></div>' +
      '<div class="label">' + head + '</div><p class="p-desc">' + esc(d.desc) + '</p>' +
      '<dl class="kv"><dt>Status</dt><dd class="' + st[1] + '">' + st[0] + why + '</dd>' +
      '<dt>Efficiency</dt><dd>' + pct(b.paused ? 0 : b.eff) + '</dd>' +
      '<dt>Adjacency</dt><dd class="' + (b.adj > 1.001 ? 'good' : b.adj < 0.999 ? 'bad' : 'dim') + '">' + (Math.abs(b.adj - 1) < 0.001 ? 'none' : '×' + b.adj.toFixed(2)) + '</dd>' +
      '<dt>Plot</dt><dd class="' + (b.plot < 0.999 ? 'bad' : 'good') + '">' + plotName(b.ring) + (b.plot < 0.999 ? ' · too small for ' + plotName2(d.minPlotSize) + ' · ×' + b.plot.toFixed(2) : (d.minPlotSize > 1 ? ' · fits' : '')) + '</dd>' +
      (d.workers ? '<dt>Crew</dt><dd class="' + (S.colony.staffing.ratio < 0.999 ? 'warn' : '') + '">' + d.workers + ' needed' + (S.colony.staffing.ratio < 0.999 ? ' · colony at ' + pct(S.colony.staffing.ratio) + ' staffed' : '') + '</dd>' : '') +
      (d.housing ? '<dt>Homes</dt><dd>+' + Math.floor(d.housing * b.plot) + ' people</dd><dt>Comfort</dt><dd class="' + (b.comfort > 0 ? 'good' : b.comfort < 0 ? 'bad' : 'dim') + '">' + (b.comfort > 0 ? '+' : '') + (b.comfort || 0) + '</dd>' : '') +
      (b.mark ? '<dt>Hazard</dt><dd class="' + (b.mark === 'hit' ? 'bad' : 'warn') + '">' + MARK_TXT[b.mark] + (b.haz < 0.999 ? ' · ×' + b.haz.toFixed(2) : '') + '</dd>' : '') + '</dl>' +
      '<div class="label sec">Per tick at current efficiency</div><div class="io">' + ioPills(d, b.paused ? 0 : b.eff, b.mult * b.haz) + '</div>' +
      (d.storageBonus ? '<div class="io" style="margin-top:6px">' + pill('scrap', '+' + fmt(d.storageBonus * b.mult) + ' storage each') + '</div>' : '') +
      (d.defense ? '<div class="io" style="margin-top:6px"><span class="pill out"><i style="background:var(--bad)"></i>Defence ' + (d.defense * b.eff * b.mult).toFixed(1) + '</span></div>' : '') +
      (d.transmit ? '<div class="io" style="margin-top:6px"><span class="pill out"><i style="background:#fff"></i>Signal ' + (b.eff * b.mult).toFixed(2) + ' / tick</span></div>' : '');
    if (d.expand) h += expansionCard(b, d);
    if (d.recipeBuilding) h += recipeCard(b);
    if (d.optional) h += optionalCard(d, b);
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
    var key = 'dem:' + b.id, refund = Math.round(CFG.demolishRefund * 100);
    h += '<div class="actions"><button class="btn" data-act="toggle" data-ring="' + b.ring + '" data-slot="' + b.slot + '">' + icon(b.paused ? 'play' : 'pause', 12) + ' ' + (b.paused ? 'Resume' : 'Pause') + '</button>' +
      '<button class="btn danger" data-act="demolish" data-ring="' + b.ring + '" data-slot="' + b.slot + '" data-key="' + key + '">' +
      (confirmKey === key ? 'Confirm?' : 'Demolish') + '</button></div>' +
      '<div class="dim" style="font-size:11px;margin-top:8px">Demolishing refunds ' + refund + '% of the build cost.</div>';
    return h;
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
    var rec = b.recipe ? CFG.recipes[b.recipe] : null, batch = CFG.tradeWorks.batchByPlot[GEO().ringPlotSize[b.ring]] || 1;
    var h = '<div class="label sec">Recipe</div>';
    if (rec) {
      var adjn = Object.keys(rec.adjacent || {}).map(function (r) { return CFG.recipes[r] ? esc(CFG.recipes[r].name) + ' ×' + rec.adjacent[r] : ''; }).filter(Boolean);
      h += '<div class="optcard on"><div class="top"><b>' + esc(rec.name) + '</b><span class="dim">Tier ' + rec.tier + '</span></div>' + recipeLines(rec, b).html +
        '<div class="dim" style="font-size:11px;margin-top:6px">Batch ×' + batch + ' on a ' + plotName(b.ring) + ' plot: more goes in and more comes out, at the same ratio. Crew and power scale with it.</div>' +
        (adjn.length ? '<div class="dim" style="font-size:11px;margin-top:4px">Runs better beside: ' + adjn.join(', ') + '</div>' : '') + '</div>';
      if (b.resetting) h += '<div class="note warn">Resetting: idle for ' + b.resetting + ' more ticks.</div>';
    } else h += '<div class="note warn">No recipe chosen. The first choice is free, but it locks in: changing it later costs credits and idles the workshop.</div>';
    var changing = !!rec;
    if (!b.resetting) {
      h += '<div class="dim" style="font-size:11px;margin:8px 0 4px">' + (changing ? 'Change recipe · costs <b>' + fmt(b.resetFee) + ' cr</b> and ' + CFG.tradeWorks.reset.delayTicks + ' idle ticks' : 'Choose a recipe') + '</div>' +
        Object.keys(CFG.recipes).filter(function (k) { return k !== b.recipe; }).map(function (k) {
          var r = CFG.recipes[k], on = recipePick === k;
          return '<div class="recipe' + (on ? ' sel' : '') + '"><button class="rname" data-act="recpick" data-rec="' + k + '"><b>' + esc(r.name) + '</b><small>T' + r.tier + ' · ' + Object.keys(r.outputsPerTick).map(function (o) { return mp(r.outputsPerTick[o] * batch) + ' ' + esc(CFG.resources[o].name); }).join(', ') + '/t</small></button>' +
            (on ? recipeLines(r, b).html + '<div class="actions"><button class="btn primary" data-act="recset" data-ring="' + b.ring + '" data-slot="' + b.slot + '" data-rec="' + k + '"' + (changing && S.colony.credits < b.resetFee ? ' disabled' : '') + '>' + (changing ? 'Change for ' + fmt(b.resetFee) + ' cr' : 'Lock in this recipe') + '</button></div>' : '') + '</div>';
        }).join('');
    }
    return h;
  }
  // Optional input: off by default; while on and in stock it costs a fixed amount per tick for a bonus.
  function optionalCard(d, b) {
    var o = d.optional, on = !!b.boost, working = b.boost === 'on';
    var effect = (o.outputMult ? 'Output ×' + o.outputMult : '') + (o.comfort ? 'Comfort +' + o.comfort + ' for these homes' : '');
    var short = Object.keys(o.inputsPerTick).filter(function (r) { return S.resources[r] && S.resources[r].amount < o.inputsPerTick[r]; });
    return '<div class="label sec">Optional input</div><div class="optcard' + (working ? ' on' : '') + '"><div class="top"><b>' + esc(o.label) + '</b><span class="' + (working ? 'good' : on ? 'warn' : 'dim') + '">' + (working ? 'Active' : on ? 'Waiting for stock' : 'Off') + '</span></div>' +
      '<div class="dim" style="font-size:12px;margin-bottom:6px">' + esc(o.desc) + '</div>' +
      '<div class="io">' + ioPills({ inputsPerTick: o.inputsPerTick, outputsPerTick: {} }, 1, 1) + '<span class="pill out"><i style="background:var(--good)"></i>' + esc(effect) + '</span></div>' +
      (on && !working ? '<div class="note warn" style="margin:8px 0 0">' + (short.length ? 'Not enough ' + short.map(function (r) { return esc(CFG.resources[r].name); }).join(', ') + ' in this district\'s stockpile. Route or ship some in.' : 'Waiting for the building to run.') + '</div>' : '') +
      '<div class="actions"><button class="btn' + (on ? '' : ' primary') + '" data-act="boost" data-ring="' + b.ring + '" data-slot="' + b.slot + '">' + (on ? 'Switch off' : 'Switch on') + '</button></div></div>';
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
  function buildMenu(r, s, head) {
    var h = '<div class="label">' + head + ' · empty</div><h3 style="margin:4px 0 12px;font-size:15px">Construct</h3><div class="stack">';
    var dtype = activeD().type;
    Object.keys(CFG.buildings).forEach(function (k) {
      var d = CFG.buildings[k];
      if ((CFG.buildableIn[dtype] || []).indexOf(k) < 0) return;
      var afford = canAfford(d.cost);
      var owned = S.buildings.filter(function (b) { return b.type === k; }).length + S.orders.filter(function (o) { return o.kind === 'build' && o.data.type === k; }).length;
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
      h += '<button class="opt" data-act="build" data-type="' + k + '"' + (capped || !afford ? ' disabled' : '') + ' style="--c:' + d.color + '">' +
        '<div class="top">' + icon(k, 20) + '<b>' + esc(d.name) + '</b><small>' + d.constructionTicks + ' ticks</small></div>' +
        (capped ? '<div class="warn" style="font-size:11px">Already built: only ' + d.maxCount + ' allowed</div>' :
          '<div class="io">' + Object.keys(d.cost).map(function (c) { return pill(c, d.cost[c], S.resources[c].amount < d.cost[c] ? 'no' : ''); }).join('') + '</div>') +
        '<div class="io" style="margin-top:6px;opacity:.85">' + ioPills(d, 1, pv.mult * plot) +
        (d.workers ? '<span class="pill"><i style="background:#a3b8cc"></i>Crew ' + d.workers + '</span>' : '') +
        (d.housing ? '<span class="pill out"><i style="background:#a3b8cc"></i>' + Math.floor(d.housing * plot) + ' homes</span>' : '') +
        (d.storageBonus ? pill('scrap', '+' + fmt(d.storageBonus * plot) + ' storage') : '') +
        (d.defense ? '<span class="pill out"><i style="background:var(--bad)"></i>Defence ' + (d.defense * plot).toFixed(1) + '</span>' : '') +
        (d.transmit ? '<span class="pill out"><i style="background:#fff"></i>Signal ' + plot.toFixed(2) + ' / tick</span>' : '') + '</div>' + notes + '</button>';
    });
    return h + '</div>';
  }

  // ---- Brief: doom clock + directives ----------------------------------------
  function span(n) { return n + ' tick' + (n === 1 ? '' : 's') + ' <span class="dim">(' + clock(n * S.tickMs) + ')</span>'; }
  function names(list) { return list.map(function (r) { return CFG.resources[r].name; }).join(', '); }
  function doomCard() {
    var d = S.doom;
    if (!d) {
      return '<div class="doom ok"><div class="label">Collapse clock</div><div class="big good">STABLE</div>' +
        '<div class="dim">Nothing critical is draining at current rates. Growth or losses can change that.</div></div>';
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
    h += '<div style="margin-top:8px"><b>' + Math.round(z.prep * 100) + '% prepared.</b> ' + (ready ? 'Fully covered, but weathering it still costs:' : 'If it struck now:') + '</div>' + effectBlock(z);
    if (z.shield) {
      var sh = z.shield, short = sh.have < sh.need;
      h += '<div class="shield' + (sh.enabled ? ' on' : '') + '"><div><b>Deploy ' + sh.need + ' ' + esc(CFG.resources[sh.resource].name) + '</b><div class="dim" style="font-size:11px">Prevents every consequence of this hazard. Spent when it lands. In the Core: ' + sh.have + (short ? ' <span class="warn">(not enough yet)</span>' : '') + '</div></div>' +
        '<button class="btn' + (sh.enabled ? '' : ' primary') + '" data-act="shield">' + (sh.enabled ? 'Stand down' : 'Deploy') + '</button></div>';
    }
    var sf = shortfalls(z);
    if (sf.length) h += '<div class="actions" style="margin-top:10px"><button class="btn" data-act="xprefill">' + icon('truck', 12) + ' Order express resupply</button></div>';
    if (marked) h += '<div class="dim" style="margin-top:6px">' + marked + ' structure' + (marked === 1 ? ' is' : 's are') + ' in its path (dashed marker on the map).</div>';
    return h + '<div class="dim" style="margin-top:8px;font-size:11px">Reserves are spent automatically when it lands, whether or not you are here. Even a fully prepared colony pays a running cost for the duration.</div></div>';
  }

  function briefTab() {
    var ds = S.brief.directives, done = ds.filter(function (d) { return d.done; }).length;
    if (!S.brief.remaining) return threatCard() + doomCard() + '<div class="note good" style="margin-top:16px">All ' + ds.length + ' directives complete. Nothing left to hint at: the rest is yours.</div>';
    var h = threatCard() + doomCard() + '<div class="p-title" style="margin-top:16px"><h3>Directives</h3><span class="dim num" style="margin-left:auto">' + done + ' / ' + ds.length + '</span></div>' +
      '<div class="meter" style="margin:4px 0 10px"><i style="width:' + (done / ds.length * 100).toFixed(0) + '%;background:var(--amber)"></i></div>';
    ds.forEach(function (d) {
      h += '<div class="dir' + (d.done ? ' done' : '') + (d.current ? ' current' : '') + '"><span class="tick">' + icon('check', 11) + '</span><div class="body"><b>' + esc(d.title) + '</b>';
      if (!d.done) {
        h += '<div class="hint">' + esc(d.hint) + '</div>' + timingLine(d.timing);
        if (d.progress) h += '<div class="meter" style="margin-top:6px"><i style="width:' + (d.progress.value / d.progress.max * 100).toFixed(0) + '%;background:var(--good)"></i></div><div class="tm num">' + d.progress.value + ' / ' + d.progress.max + '</div>';
      }
      h += '</div></div>';
    });
    return h + '<div class="note" style="margin-top:14px">Directives only point at what is missing. Working out how is the game.</div>';
  }

  function upkeepPills(up) {
    var h = '';
    Object.keys(up || {}).forEach(function (r) { h += pill(r, up[r], 'in'); });
    return h || '<span class="dim">None</span>';
  }
  function hubTab() {
    var c = S.colony, lv = CFG.hubLevels[c.hubLevel], next = CFG.hubLevels[c.hubLevel + 1];
    var slots = function (l) { return Object.keys(l.ringCapacities).reduce(function (a, k) { return a + l.ringCapacities[k]; }, 0); };
    var h = '<div class="p-title">' + icon('hub', 22) + '<h3>Command Hub · Level ' + c.hubLevel + '</h3></div>' +
      '<dl class="kv"><dt>Storage per resource</dt><dd>' + fmt(S.hub.maxStorage) + (S.hub.maxStorage > S.hub.baseStorage ? ' <span class="dim">(' + fmt(S.hub.baseStorage) + ' + warehouses)</span>' : '') + '</dd>' +
      '<dt>Hub quarters</dt><dd>' + lv.baseHousing + ' people</dd>' +
      '<dt>Hub power</dt><dd class="' + (S.hub.eff < 0.999 ? 'bad' : '') + '">' + S.hub.power.toFixed(0) + (lv.upkeepPerTick && lv.upkeepPerTick.energy ? ' <span class="dim">(' + lv.baseEnergy + ' base − ' + lv.upkeepPerTick.energy + ' upkeep)</span>' : '') + '</dd>' +
      '<dt>Rings online</dt><dd>' + Object.keys(lv.ringCapacities).length + ' (' + slots(lv) + ' slots)</dd>' +
      '<dt>Defence</dt><dd>' + S.defense.toFixed(1) + '</dd></dl>';
    var st = c.staffing, ho = c.housing, mi = c.moraleInfo, sg = function (v) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1); };
    h += '<div class="label sec">Population &amp; morale</div><dl class="kv">' +
      '<dt>People</dt><dd>' + c.population + ' / ' + ho.cap + ' <span class="dim">(quarters ' + ho.base + (ho.built ? ' + homes ' + Math.floor(ho.built) : '') + ')</span></dd>' +
      '<dt>Crew</dt><dd class="' + (st.ratio < 0.999 ? 'warn' : '') + '">' + Math.floor(st.workforce) + ' hands for ' + st.posts + ' posts' + (st.ratio < 0.999 ? ' · ×' + st.ratio.toFixed(2) + ' output' : '') + '</dd>' +
      '<dt>Morale</dt><dd>' + Math.round(c.morale) + ' <span class="dim">→ target ' + Math.round(mi.target) + '</span></dd>' +
      '<dt>Target is</dt><dd class="dim">base ' + mi.base + ' · homes ' + sg(mi.comfort) + ' · meals ' + sg(mi.meals) + '</dd>' +
      '<dt>Fed meals</dt><dd>' + pct(mi.mealCoverage) + ' of people</dd>' +
      '<dt>Output effect</dt><dd class="' + (mi.productivity < 0.999 ? 'bad' : mi.productivity > 1.001 ? 'good' : 'dim') + '">×' + mi.productivity.toFixed(2) + '</dd></dl>' +
      (st.ratio < 0.999 ? '<div class="note warn">There are fewer hands than posts. Every staffed building is slowed until the colony has more people.</div>' : '') +
      (c.population >= ho.cap - 1 ? '<div class="note">The colony has filled its housing. It cannot grow further without more homes.</div>' : '');
    if (lv.upkeepPerTick) {
      h += '<div class="label sec">Hub upkeep per tick</div><div class="io">' + upkeepPills(lv.upkeepPerTick) + '</div>' +
        (S.hub.eff < 0.999 ? '<div class="note bad">Upkeep unmet: the hub is running at ' + pct(S.hub.eff) + ' and its power output is cut. Short of ' + esc(CFG.resources[S.hub.limiting].name) + '.</div>'
          : '<div class="dim" style="font-size:11px;margin-top:6px">A larger hub costs more to keep standing. Keep these supplied.</div>');
    }
    h += '<div class="label sec">Hub upgrade</div>';
    if (!next) h += '<div class="note good">The hub is fully upgraded.</div>';
    else {
      var up = S.orders.filter(function (o) { return o.kind === 'upgrade'; })[0], nl = c.hubLevel + 1;
      h += '<div class="opt" style="cursor:default"><div class="top"><b>Level ' + nl + '</b><small>' + next.upgradeTicks + ' ticks</small></div>' +
        '<div class="io">' + Object.keys(next.upgradeCost).map(function (r) { return pill(r, next.upgradeCost[r], S.resources[r].amount < next.upgradeCost[r] ? 'no' : ''); }).join('') + '</div>' +
        '<div class="dim" style="font-size:11px;margin-top:8px">Unlocks ring ' + nl + ' (' + plotName(nl) + ' plots, ' + CFG.rings[nl] + ' slots) · storage ' + fmt(next.maxStorage) + ' · hub quarters ' + next.baseHousing + ' · base power ' + next.baseEnergy + '</div>' +
        (next.upkeepPerTick ? '<div class="label" style="margin-top:8px">Upkeep after upgrade</div><div class="io" style="margin-top:4px">' + upkeepPills(next.upkeepPerTick) + '</div>' : '') + '</div>';
      h += up ? '<div class="note">Upgrade in progress: ' + up.remaining + ' ticks remaining. <a href="#" data-act="cancel" data-id="' + up.id + '" style="color:var(--amber)">Cancel</a></div>'
        : '<div class="actions"><button class="btn primary" data-act="upgrade"' + (canAfford(next.upgradeCost) ? '' : ' disabled') + '>Begin upgrade</button></div>';
    }
    var bc = S.buildings.filter(function (b) { return CFG.buildings[b.type].transmit; })[0];
    var bo = S.orders.filter(function (o) { return o.kind === 'build' && CFG.buildings[o.data.type].transmit; })[0];
    h += '<div class="label sec">Mission: the Beacon</div>';
    var prog = Math.min(1, c.progress / CFG.transmitTicks);
    h += '<div class="goal ' + (bc ? 'done' : '') + '"><span class="tick">' + icon('check', 11) + '</span><span>' + (bc ? 'Beacon Array built' : bo ? 'Beacon Array under construction' : 'Build the Beacon Array') + '</span></div>' +
      '<div class="goal ' + (c.won ? 'done' : '') + '"><span class="tick">' + icon('check', 11) + '</span><span>Transmit <span class="dim num">(' + Math.floor(c.won ? CFG.transmitTicks : c.progress) + ' / ' + CFG.transmitTicks + ')</span></span></div>' +
      '<div class="meter" style="margin:4px 0 8px"><i style="width:' + (prog * 100).toFixed(0) + '%;background:var(--good)"></i></div>';
    if (c.won) h += '<div class="note good">The message got through. Mission accomplished. Keep building if you like.</div>';
    return h;
  }

  // ---- districts -------------------------------------------------------------
  function costPills(cost, have) {
    return Object.keys(cost).map(function (r) { return pill(r, cost[r], have[r].amount < cost[r] ? 'no' : ''); }).join('');
  }
  function districtOf(type) { return S.districts.filter(function (d) { return d.type === type; })[0]; }
  function shipTime(a, b) {
    var d = function (x) { return x.core ? 0 : CFG.districtTypes[x.type].distance; };
    return Math.max(1, d(a) + d(b));
  }
  // The district switcher: always there once districts are open. Pulses while there is something to do
  // (a district can be founded, or one has been founded and not visited yet).
  var visited = {};
  function renderSwitch() {
    var el = $('dswitch'), h = '';
    visited[activeId] = true;
    if (S.districtsUnlocked) {
      var canFound = Object.keys(CFG.districtTypes).some(function (k) {
        return S.foundable[k] && !S.districts.some(function (d) { return d.type === k; }) && !S.founding.some(function (f) { return f.type === k; }) && canAffordCore(CFG.districtTypes[k].foundCost);
      });
      h = S.districts.map(function (d) {
        var t = d.core ? null : CFG.districtTypes[d.type], fresh = !d.core && !visited[d.id];
        return '<button class="dchip' + (d.id === activeId ? ' on' : '') + (fresh ? ' new' : '') + '" data-act="enter" data-id="' + d.id + '" style="--c:' + (t ? t.color : 'var(--amber)') + '"><i></i><span>' + esc(d.core ? 'Core' : d.name) + '</span><small>L' + d.level + '</small>' + (fresh ? '<em>NEW</em>' : '') + '</button>';
      }).join('') + '<button class="dchip add' + (canFound ? ' pulse' : '') + '" data-act="tab" data-tab="districts" style="--c:var(--good)"><i></i><span>' + (S.districts.length > 1 ? 'Districts' : 'Found a district') + '</span>' + (canFound ? '<em>READY</em>' : '') + '</button>';
    }
    if (el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; }
  }
  function districtMap() {
    var h = '<svg class="dmap" viewBox="-110 -90 220 180" role="img" aria-label="District map">';
    var nodes = [{ id: S.districts[0].id, core: true, x: 0, y: 0, color: '#ff9f1c', name: 'Core', level: S.colony.hubLevel, on: true }];
    Object.keys(CFG.districtTypes).forEach(function (k) {
      if (!districtOf(k) && !S.foundable[k]) return; // districts that cannot be founded yet stay off the map
      var t = CFG.districtTypes[k], d = districtOf(k), a = t.angle * Math.PI / 180, r = t.radius * 80;
      var f = S.founding.filter(function (x) { return x.type === k; })[0];
      nodes.push({ id: d ? d.id : null, type: k, x: r * Math.cos(a), y: r * Math.sin(a), color: t.color, name: t.name.replace(/^The /, ''), level: d ? d.level : 0, on: !!d, building: !!f });
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
        '<div class="note">Out past the rings there is ground worth holding: satellite bases with their own stockpile and power grid, producing what the Core cannot. Grow the hub first.</div>';
    }
    var h = districtMap() + '<div class="note">Each district keeps its <b>own stockpile and power grid</b>. People, crew and morale are shared across the colony. Founding is paid from the Core; upgrades are paid from the district itself, so goods have to be shipped in.</div>';
    Object.keys(CFG.districtTypes).forEach(function (k) {
      var t = CFG.districtTypes[k], d = districtOf(k), f = S.founding.filter(function (x) { return x.type === k; })[0];
      h += '<div class="dcard" style="--c:' + t.color + '"><div class="top"><b>' + esc(t.name) + '</b>' + (d ? '<small>Level ' + d.level + ' · ' + d.buildings + ' structure' + (d.buildings === 1 ? '' : 's') + '</small>' : '') + '</div>' +
        '<div class="dim" style="font-size:12px;margin-bottom:8px">' + esc(t.desc) + '</div>';
      if (d) {
        h += '<div class="dim" style="font-size:11px;margin-bottom:6px">Link ' + d.link.load + ' / ' + d.link.capacity + ' per tick · ' + t.distance + ' ticks from the Core</div><div class="actions"><button class="btn' + (d.id === activeId ? '' : ' primary') + '" data-act="enter" data-id="' + d.id + '"' + (d.id === activeId ? ' disabled' : '') + '>' + (d.id === activeId ? 'Viewing' : 'Enter district') + '</button></div>';
      } else if (f) {
        h += '<div class="note">Being founded: ' + f.remaining + ' tick' + (f.remaining === 1 ? '' : 's') + ' remaining. <a href="#" data-act="cancel" data-id="' + f.id + '" style="color:var(--amber)">Cancel</a></div>';
      } else {
        if (!S.foundable[k]) { h += '<div class="note">' + (t.requires && t.requires.beaconBuilt ? 'Opens once the Beacon is built.' : 'Not available yet.') + '</div></div>'; return; }
        h += '<div class="label">Founding cost (from the Core) · ' + t.foundTicks + ' ticks</div><div class="io">' + costPills(t.foundCost, S.coreRes) + '</div>' +
          '<div class="actions"><button class="btn primary" data-act="found" data-type="' + k + '"' + (canAffordCore(t.foundCost) ? '' : ' disabled') + '>Found ' + esc(t.name) + '</button></div>';
      }
      h += '</div>';
    });
    return h;
  }
  function shipmentsBlock() {
    var h = '';
    if (S.districts.length > 1) {
      var ds = S.districts;
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
          if (CFG.resources[r].showFromHub && CFG.resources[r].showFromHub > S.colony.hubLevel + 1 && amt < 1) return '';
          return '<option value="' + r + '"' + (r === ship.res ? ' selected' : '') + '>' + esc(CFG.resources[r].name) + ' (' + amt + ')</option>';
        }).join('') + '</select></label></div>' +
        '<div class="stepper" style="margin-top:8px"><span class="lab">Qty</span><button data-act="sstep" data-delta="-' + st + '" aria-label="Less">−</button>' + numIn('ship', ship.qty, '') + '<button data-act="sstep" data-delta="' + st + '" aria-label="More">+</button><button data-act="sstep" data-delta="max" style="width:auto;padding:0 8px;font-size:10px">MAX</button></div>' +
        '<div class="dim" style="font-size:11px;margin:8px 0">Stock leaves now and arrives in ' + shipTime(fromD, toD) + ' ticks (' + clock(shipTime(fromD, toD) * S.tickMs) + '). Up to ' + L.shipmentMax + ' per shipment. Slots free: <b>' + (L.maxInFlight - manualCount) + ' / ' + L.maxInFlight + '</b>. Anything over the destination\'s storage is lost.</div>' +
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
    var ds = S.districts, nm = function (id) { var d = ds.filter(function (x) { return x.id === id; })[0]; return d ? d.name : '?'; };
    if (!S.routes.length) return '<div class="dim" style="font-size:12px">No standing routes yet.</div>';
    return S.routes.map(function (r) {
      var def = CFG.resources[r.resource], st = STEP[r.resource] || 10;
      return '<div class="route" style="--c:' + def.color + '"><div class="rhead"><b>' + esc(def.name) + '</b><span class="dim">' + esc(nm(r.fromDistrict)) + ' → ' + esc(nm(r.toDistrict)) + '</span>' +
        '<button class="x" data-act="rdel" data-id="' + r.id + '" title="Remove route" aria-label="Remove route">×</button></div>' +
        '<div class="stepper"><span class="lab">Rate</span><button data-act="rstep" data-id="' + r.id + '" data-delta="-5" aria-label="Lower">−</button>' + numIn('rexist', r.rate, 'data-id="' + r.id + '"') + '<span class="unit">/t</span><button data-act="rstep" data-id="' + r.id + '" data-delta="5" aria-label="Raise">+</button></div>' +
        '<div class="dim" style="font-size:11px;margin-top:4px">keeps ' + fmt(r.reserve) + ' in ' + esc(nm(r.fromDistrict)) + '</div><div class="flow ' + (r.flow >= r.rate ? 'good' : r.flow > 0 ? 'warn' : 'bad') + '">' + (r.flow > 0 ? 'Moving ' + r.flow + '/t' : 'Idle') + (r.limit === 'stock' ? ' · the source is down to its reserve' : r.limit === 'room' ? ' · the destination is full' : '') + '</div></div>';
    }).join('');
  }
  // Logistics has its own tab: links, standing routes and one-off shipments.
  function logisticsPage() {
    if (!S.districtsUnlocked) return '<div class="empty-state">' + icon('lock', 36) + '<div>Logistics opens with districts, at hub level ' + CFG.districtProgression.unlockCoreLevel + '.</div></div>';
    if (S.districts.length < 2) return '<div class="empty-state">' + icon('route', 36) + '<div>No districts to connect yet.</div></div><div class="note">Found a district in the Districts tab. Then this is where you set up the routes and links between them, and send one-off shipments.</div><div class="actions"><button class="btn primary" data-act="tab" data-tab="districts">Go to Districts</button></div>';
    return logisticsTab();
  }
  function logisticsTab() {
    var ds = S.districts, L = CFG.logistics;
    var h = '<div class="note"><b>Routes</b> move goods straight between stockpiles every tick: the source\'s rate drops and the destination\'s rises by the same amount, with no delay. Every satellite has one <b>link</b> to the Core; its capacity is shared by every route touching it. <b>One-off shipments</b> are separate and take time on the road.</div><div class="label sec">Links</div>';
    ds.filter(function (d) { return !d.core; }).forEach(function (d) {
      var k = d.link, can = k.next && canAffordCore(k.next.upgradeCost);
      h += '<div class="dcard" style="--c:' + CFG.districtTypes[d.type].color + '"><div class="top"><b>' + esc(d.name) + '</b><small class="' + (k.load >= k.capacity ? 'warn' : '') + '">' + k.load + ' / ' + k.capacity + ' per tick · ' + CFG.districtTypes[d.type].distance + ' ticks away</small></div>' +
        '<div class="meter"><i style="width:' + Math.min(100, k.load / k.capacity * 100).toFixed(0) + '%;background:' + (k.load >= k.capacity ? 'var(--warn)' : 'var(--good)') + '"></i></div>' +
        (k.next && k.next.upgradeCost.frames ? '<div class="dim" style="font-size:11px;margin-top:8px">Beyond 140 per tick the link needs Free Port goods (frames, fittings) in the <b>Core</b> stockpile: route them in from the Free Port.</div>' : '') + (k.next ? '<div class="label" style="margin-top:8px">Widen the link (from the Core)</div><div class="io">' + costPills(k.next.upgradeCost, S.coreRes) + '<span class="pill out"><i style="background:var(--good)"></i>to ' + k.next.capacity + '/t</span></div><div class="actions"><button class="btn" data-act="linkup" data-id="' + d.id + '"' + (can ? '' : ' disabled') + '>Upgrade link</button></div>' : '<div class="dim" style="font-size:11px;margin-top:6px">Fully upgraded.</div>') + '</div>';
    });
    h += '<div class="label sec">Standing routes · ' + S.routes.length + ' / ' + L.maxRoutes + '</div>' + routeRows();
    if (!ds.some(function (d) { return d.id === route.from; })) route.from = ds[0].id;
    if (!ds.some(function (d) { return d.id === route.to; }) || route.to === route.from) route.to = ds.filter(function (d) { return d.id !== route.from; })[0].id;
    var opt = function (cur) { return ds.map(function (d) { return '<option value="' + d.id + '"' + (d.id === cur ? ' selected' : '') + '>' + esc(d.name) + '</option>'; }).join(''); };
    var rst = 5;
    h += '<div class="label sec">New route</div><div class="shipform"><label>From<select data-sel="r:from">' + opt(route.from) + '</select></label><label>To<select data-sel="r:to">' + opt(route.to) + '</select></label>' +
      '<label class="wide">Goods<select data-sel="r:res">' + Object.keys(CFG.resources).map(function (r) {
        if (CFG.resources[r].showFromHub && CFG.resources[r].showFromHub > S.colony.hubLevel + 1) return '';
        return '<option value="' + r + '"' + (r === route.res ? ' selected' : '') + '>' + esc(CFG.resources[r].name) + '</option>';
      }).join('') + '</select></label></div>' +
      '<div class="stepper" style="margin-top:8px"><span class="lab">Rate</span><button data-act="rdraft" data-f="rate" data-delta="-' + rst + '">−</button>' + numIn('rdraft', route.rate, 'data-f="rate"') + '<span class="unit">/t</span><button data-act="rdraft" data-f="rate" data-delta="' + rst + '">+</button></div>' +
      '<div class="stepper" style="margin-top:6px"><span class="lab">Keep</span><button data-act="rdraft" data-f="reserve" data-delta="-' + (STEP[route.res] || 10) + '">−</button>' + numIn('rdraft', route.reserve, 'data-f="reserve"') + '<button data-act="rdraft" data-f="reserve" data-delta="' + (STEP[route.res] || 10) + '">+</button></div>' +
      '<div class="dim" style="font-size:11px;margin:8px 0">Sends up to the rate every tick, but never takes the source below the amount it keeps.</div>' +
      '<div class="actions"><button class="btn primary" data-act="rsave">Set route</button></div>';
    return h + shipmentsBlock();
  }
  function districtHubTab() {
    var d = activeD(), t = CFG.districtTypes[d.type], lv = GEO().levels[d.level], next = GEO().levels[d.level + 1];
    var slots = function (l) { return Object.keys(l.ringCapacities).reduce(function (a, k) { return a + l.ringCapacities[k]; }, 0); };
    var h = '<div class="p-title" style="--c:' + t.color + '">' + icon('hub', 22) + '<h3>' + esc(d.name) + ' · Level ' + d.level + '</h3></div><p class="p-desc">' + esc(t.desc) + '</p>' +
      '<dl class="kv"><dt>Storage per resource</dt><dd>' + fmt(S.hub.maxStorage) + (S.hub.maxStorage > S.hub.baseStorage ? ' <span class="dim">(' + fmt(S.hub.baseStorage) + ' + warehouses)</span>' : '') + '</dd>' +
      '<dt>District power</dt><dd>' + S.hub.power.toFixed(0) + ' base</dd>' +
      '<dt>Rings online</dt><dd>' + Object.keys(lv.ringCapacities).length + ' (' + slots(lv) + ' slots)</dd>' +
      '<dt>Defence</dt><dd>' + S.defense.toFixed(1) + '</dd></dl>' +
      '<div class="note">This district has its own stockpile and power grid. Crew, homes and morale are shared with the whole colony.</div><div class="label sec">District upgrade</div>';
    if (!next) return h + '<div class="note good">Fully upgraded.</div>';
    var nl = d.level + 1, up = S.orders.filter(function (o) { return o.kind === 'upgrade'; })[0], gated = nl > S.districtLevelCap;
    var short = Object.keys(next.upgradeCost).filter(function (r) { return S.resources[r].amount < next.upgradeCost[r]; });
    h += '<div class="opt" style="cursor:default"><div class="top"><b>Level ' + nl + '</b><small>' + next.upgradeTicks + ' ticks</small></div><div class="io">' + costPills(next.upgradeCost, S.resources) + '</div>' +
      '<div class="dim" style="font-size:11px;margin-top:8px">Unlocks ring ' + nl + ' (' + plotName(nl) + ' plots, ' + GEO().rings[nl] + ' slots) · storage ' + fmt(next.maxStorage) + ' · base power ' + next.baseEnergy + '</div></div>';
    if (up) h += '<div class="note">Upgrade in progress: ' + up.remaining + ' ticks remaining. <a href="#" data-act="cancel" data-id="' + up.id + '" style="color:var(--amber)">Cancel</a></div>';
    else if (gated) h += '<div class="note warn">Level ' + nl + ' unlocks when ' + esc(S.districtNeeds[nl]) + '.</div>';
    else {
      if (short.length) h += '<div class="note">Upgrades are paid from <b>this</b> district\'s stockpile. Short of ' + short.map(function (r) { return esc(CFG.resources[r].name); }).join(', ') + ': ship it here from another district, or from the Core.</div>';
      h += '<div class="actions"><button class="btn primary" data-act="upgrade"' + (canAfford(next.upgradeCost) ? '' : ' disabled') + '>Begin upgrade</button>' +
        (short.length ? '<button class="btn" data-act="tab" data-tab="districts">' + icon('truck', 12) + ' Ship goods</button>' : '') + '</div>';
    }
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
  function exchangeTab() {
    var E = S.exchange, X = CFG.exchange;
    if (!E.unlocked) return '<div class="empty-state">' + icon('lock', 36) + '<div>The exchange opens at hub level ' + X.unlockCoreLevel + '.</div></div><div class="note">A place to name your own price: post buy and sell orders against traders, and against anyone else who turns up. Grow the hub first.</div>';
    var x = E.resources[mk.res], r = CFG.resources[mk.res], ds = S.districts;
    if (!ds.some(function (d) { return d.id === mk.district; })) mk.district = ds[0].id;
    if (mk.price === null) mk.price = mk.side === 'buy' ? (x.ask || x.ref) : (x.bid || x.ref);
    var pstep = Math.max(0.01, Math.round(x.ref * 0.01 * 100) / 100), qstep = STEP[mk.res] || 10;
    var dstock = Math.floor(S.views[mk.district].resources[mk.res].amount);
    var maxQ = mk.side === 'sell' ? Math.min(X.maxQty, dstock) : X.maxQty;
    mk.qty = clamp(mk.qty, 1, Math.max(1, maxQ));
    var ev = x.event ? '<span class="chip-ev ' + x.event.kind + '">' + (x.event.kind === 'shortage' ? 'SHORTAGE' : 'GLUT') + ' · ' + x.event.ticksLeft + 't</span>' : '';
    var h = '<label class="selrow">Market<select data-sel="m:res">' + Object.keys(CFG.resources).filter(function (k) {
      var d = CFG.resources[k]; if (d.trade) return !!S.freeport; return !(d.showFromHub && d.showFromHub > S.colony.hubLevel + 1 && k !== mk.res);
    }).map(function (k) { return '<option value="' + k + '"' + (k === mk.res ? ' selected' : '') + '>' + esc(CFG.resources[k].name) + ' · ' + mp(E.resources[k].ref) + ' cr</option>'; }).join('') + '</select></label>';
    h += '<div class="mk-head" style="--c:' + r.color + '"><div><div class="big num">' + mp(x.ref) + ' <small>cr</small></div><div class="dim" style="font-size:11px">market price' + (Math.abs(x.trend) >= 0.01 ? ' · ' + (x.trend > 0 ? '▲' : '▼') + Math.abs(Math.round(x.trend * 100)) + '%' : '') + '</div></div>' + spark(x.hist, r.color) + ev + '</div>';
    // the book: asks (what you pay) above, bids (what you get) below
    var maxq = Math.max.apply(null, x.asks.concat(x.bids).map(function (l) { return l.qty; }).concat([1]));
    var row = function (l, cls) { return '<div class="bk ' + cls + '" data-act="mkprice" data-price="' + l.price + '"><i style="width:' + (l.qty / maxq * 100).toFixed(0) + '%"></i><span class="num">' + mp(l.price) + '</span><span class="num">' + fmt(l.qty) + (l.mine ? ' <b title="includes your orders">·</b>' : '') + '</span></div>'; };
    h += '<div class="label sec">Order book <span class="dim" style="text-transform:none;letter-spacing:0">· click a price to use it</span></div><div class="book">' +
      x.asks.slice().reverse().map(function (l) { return row(l, 'ask'); }).join('') +
      '<div class="bk spread"><span>spread</span><span class="num">' + (x.ask !== null && x.bid !== null ? mp(x.ask - x.bid) : '–') + '</span></div>' +
      x.bids.map(function (l) { return row(l, 'bid'); }).join('') + '</div>';
    // the order form
    var side = mk.side, est = fillEstimate(x, side, mk.price, mk.qty), total = Math.ceil(mk.price * mk.qty - 1e-9);
    h += '<div class="label sec">New order</div><div class="seg" role="tablist" style="margin-bottom:10px"><button role="tab" data-act="mkside" data-side="buy" aria-selected="' + (side === 'buy') + '">Buy</button><button role="tab" data-act="mkside" data-side="sell" aria-selected="' + (side === 'sell') + '">Sell</button></div>' +
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
      '<div class="actions"><button class="btn primary" data-act="mksubmit"' + (enough ? '' : ' disabled') + '>' + (side === 'buy' ? 'Place buy order' : 'Place sell order') + '</button></div>';
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
  function missionsTab() {
    if (!S.freeport) return '<div class="empty-state">' + icon('lock', 36) + '<div>Missions come from the Free Port.</div></div><div class="note">Once the Beacon is built and the Free Port founded, factions start posting requests for trade goods. Filling them pays above market and builds your standing.</div>';
    var M = S.missions, F = CFG.missions.factions;
    if (msrc === null || !S.views[msrc]) msrc = S.districts.filter(function (d) { return d.type === 'freeport'; })[0].id;
    var h = '<div class="standing"><div class="label">Standing</div><div class="big num">' + fmt(M.total) + '</div><div class="dim" style="font-size:11px">' + M.filled + ' mission' + (M.filled === 1 ? '' : 's') + ' filled</div><div class="facs">' +
      Object.keys(F).map(function (k) { return '<span class="fac"><b>' + fmt(M.standing[k]) + '</b><small>' + esc(F[k].name) + '</small></span>'; }).join('') + '</div></div>' +
      '<label class="selrow" style="margin:10px 0">Supply from<select data-sel="s:src">' + S.districts.map(function (d) { return '<option value="' + d.id + '"' + (d.id === msrc ? ' selected' : '') + '>' + esc(d.name) + '</option>'; }).join('') + '</select></label>' +
      '<div class="note">Each mission is offered in the name of every faction, each asking for something different. Fill one and the others lapse. Standing does nothing yet except keep score.</div>';
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
    var E = CFG.expansion, lv = b.level || 1, pend = S.orders.filter(function (o) { return o.kind === 'expand' && o.data.ring === b.ring && o.data.slot === b.slot; })[0];
    var dots = '';
    for (var i = 1; i <= E.maxLevel; i++) dots += '<i class="' + (i <= lv ? 'on' : '') + '"></i>';
    var effect = function (k, crew) {
      var what = d.housing ? '+' + (Math.floor(d.housing * plotMultFor(d, b.ring) * k) - Math.floor(d.housing * plotMultFor(d, b.ring) * E.scale[lv])) + ' more homes'
        : d.storageBonus ? 'Storage ×' + k : d.defense ? 'Defence ×' + k : 'Output, inputs and power ×' + k;
      return what + (d.workers ? ' · crew ×' + crew : '');
    };
    var h = '<div class="label sec">Expansion</div><div class="optcard' + (lv > 1 ? ' on' : '') + '"><div class="top"><b>Level ' + lv + ' / ' + E.maxLevel + '</b><span class="dim">' + (lv > 1 ? 'output ×' + E.scale[lv] : 'as built') + '</span></div><div class="lvdots">' + dots + '</div>';
    if (pend) {
      h += '<div class="note" style="margin:8px 0 0">Expanding to level ' + pend.data.level + ': ' + pend.remaining + ' tick' + (pend.remaining === 1 ? '' : 's') + ' left.</div>';
    } else if (b.xnext) {
      var nx = b.xnext, short = Object.keys(nx.cost).filter(function (r) { return S.resources[r].amount < nx.cost[r]; });
      h += '<div class="dim" style="font-size:12px;margin:6px 0">Build it upward in the same plot: the whole line gets bigger, not better. ' + esc(effect(nx.scale, nx.crew)) + '.</div>' +
        '<div class="label" style="margin-top:4px">Level ' + nx.level + ' · ' + nx.ticks + ' ticks</div><div class="io">' + costPills(nx.cost, S.resources) + '</div>' +
        (short.length ? '<div class="note" style="margin:8px 0 0">Paid from <b>' + esc(activeD().name) + '</b>\'s stockpile. Short of ' + short.map(function (r) { return esc(CFG.resources[r].name); }).join(', ') + ': these are made by Trade Workshops at the Free Port, so route or ship them here.</div>' : '') +
        '<div class="actions"><button class="btn primary" data-act="expand" data-ring="' + b.ring + '" data-slot="' + b.slot + '"' + (short.length ? ' disabled' : '') + '>Expand to level ' + nx.level + '</button></div>';
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
      ? '<div class="note warn">The first shortage is in <b>' + span(Math.ceil(Math.min.apply(null, tls))) + '</b>. After that people start leaving and morale falls. The colony shrinks to what it can feed rather than collapsing, but it is better to fix it first: add food and water, or stop growing.</div>'
      : '<div class="note good">Food and water are in surplus at today\'s size, so nothing runs out while you are away. Careful: every new home that fills adds ' + pf(P.perPerson.rations + P.perPerson.clean_water) + ' use per person per tick.</div>');
    // morale
    var sg = function (v) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1); };
    h += '<div class="label sec">Morale</div><dl class="kv"><dt>Now</dt><dd>' + Math.round(c.morale) + ' <span class="dim">→ target ' + Math.round(mi.target) + '</span></dd>' +
      '<dt>Made of</dt><dd class="dim">base ' + mi.base + ' · homes ' + sg(mi.comfort) + ' · meals ' + sg(mi.meals) + '</dd>' +
      '<dt>Output effect</dt><dd class="' + (mi.productivity < 0.999 ? 'bad' : mi.productivity > 1.001 ? 'good' : 'dim') + '">×' + mi.productivity.toFixed(2) + '</dd>' +
      '<dt>Thresholds</dt><dd class="dim">growth stops below ' + gr.minMorale + ' · people leave below ' + ex.lowMoraleBelow + ' · colony is lost at 0</dd></dl>';
    // crew and housing
    h += '<div class="label sec">Crew &amp; housing</div><dl class="kv"><dt>Crew</dt><dd class="' + (st.ratio < 0.999 ? 'warn' : '') + '">' + Math.floor(st.workforce) + ' hands for ' + Math.ceil(st.posts) + ' posts' + (st.ratio < 0.999 ? ' · output ×' + st.ratio.toFixed(2) : '') + '</dd>' +
      '<dt>Homes</dt><dd>quarters ' + ho.base + (ho.built ? ' + built ' + Math.floor(ho.built) : '') + ' = ' + ho.cap + '</dd>' +
      '<dt>Minimum</dt><dd class="dim">people never leave below ' + P.minPopulation + '</dd></dl>' +
      (st.ratio < 0.999 ? '<div class="note warn">Not enough hands for every post, so staffed buildings are slowed. More homes, or expanding the homes you have, brings more people (if they can be fed).</div>' : '');
    return h;
  }

  function trendTxt(tr, goodUp) {
    if (Math.abs(tr) < 0.02) return '';
    var up = tr > 0, good = up === goodUp;
    return ' <span class="' + (good ? 'good' : 'bad') + '">' + (up ? '▲' : '▼') + Math.abs(Math.round(tr * 100)) + '%</span>';
  }
  function scheduledTab() {
    var h = (activeD().core ? '' : '<div class="note">Convoys and express trips deal with the <b>Core</b> stockpile. Ship goods there from this district in the Districts tab.</div>') +
      '<div class="convoy-head"><div class="label">Next convoy in</div><div class="big num" data-f="convoy">–</div><div class="dim" style="font-size:11px" data-f="convoyTicks"></div></div>' +
      '<p class="p-desc">Standing orders repeat every convoy at that convoy\'s prices. The trade limit per resource grows with your hub level (currently ×' + (CFG.hubLevels[S.colony.hubLevel].convoyCapMult || 1) + '). Prices drift from convoy to convoy; the figures below are what the <b>next</b> convoy will pay and charge, and the arrows show the change from the last one.</p>';
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
    var h = '<p class="p-desc">A special trip you dispatch yourself. It arrives in ' + x.travelTicks + ' ticks (' + clock(x.travelTicks * S.tickMs) + '), but costs a fee, pays ×' + x.sellMult + ' when buying your goods, charges ×' + x.buyMult + ' when selling to you, and carries less than the scheduled convoy. Goods and credits are held until it arrives.</p>';
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
  function renderPanel() {
    var ae = document.activeElement;
    if (ae && ae.classList && ae.classList.contains('numin') && $('panel').contains(ae)) { panelDeferred = true; return; }
    panelDeferred = false;
    var h = tab === 'hub' ? (activeD().core ? hubTab() : districtHubTab()) : tab === 'people' ? peopleTab() : tab === 'districts' ? districtsTab() : tab === 'logistics' ? logisticsPage() : tab === 'convoy' ? convoyTab() : tab === 'exchange' ? exchangeTab() : tab === 'missions' ? missionsTab() : tab === 'log' ? logTab() : tab === 'brief' ? briefTab() : siteTab();
    if (h === lastPanel) return;
    lastPanel = h;
    var p = $('panel'), top = p.scrollTop;
    p.innerHTML = h;
    p.scrollTop = top;
    framePanel();
  }
  function framePanel() {
    var now = Date.now() + offset;
    document.querySelectorAll('#panel [data-b]').forEach(function (el) {
      var k = el.dataset.b.split(':');
      if (k[0] === 'amt') { var r = S.coreRes[k[1]]; el.textContent = fmt(clamp(r.amount + r.net * frac(), 0, r.cap)); }
    });
    var xe = document.querySelector('#panel [data-f=xeta]');
    if (xe && S.express.active) xe.textContent = clock(S.express.active.arrivesAt - now);
    var cv = document.querySelector('#panel [data-f=convoy]');
    if (cv) {
      cv.textContent = clock(S.convoy.arrivesAt - now);
      document.querySelector('#panel [data-f=convoyTicks]').textContent = S.convoy.ticksLeft + ' tick' + (S.convoy.ticksLeft === 1 ? '' : 's');
    }
  }
  function clock(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  // ------------------------------------------------------------------ queue bar
  var lastQueue = '';
  function renderQueue() {
    var h = '<span class="label">Work queue</span>';
    if (!S.allOrders.length) h += '<span class="queue-empty">No active work orders.</span>';
    S.allOrders.forEach(function (o) {
      var tag = o.dname ? o.dname.replace(/^The /, '') + ': ' : '';
      var name = o.kind === 'build' ? tag + 'Build ' + CFG.buildings[o.data.type].name : o.kind === 'found' ? 'Found ' + CFG.districtTypes[o.data.type].name : o.kind === 'expand' ? tag + 'Expand ' + CFG.buildings[o.data.type].name + ' → ' + o.data.level : (o.dname || 'Hub') + ' upgrade → L' + o.data.level;
      var where = o.kind === 'build' || o.kind === 'expand' ? 'R' + o.data.ring + '·' + (o.data.slot + 1) : '';
      h += '<div class="order" data-id="' + o.id + '"><button class="x" data-act="cancel" data-id="' + o.id + '" title="Cancel & refund" aria-label="Cancel order">×</button>' +
        '<div class="row"><span>' + esc(name) + '</span><small class="num">' + (where ? where + ' · ' : '') + o.remaining + 't</small></div><div class="bar"><i></i></div></div>';
    });
    if (pending.length) {
      var chips = pending.map(function (p) {
        return '<div class="pend" data-id="' + p.id + '"><span>' + esc(p.label) + '</span><button class="x" data-act="pcancel" data-id="' + p.id + '" title="Discard (not sent yet)" aria-label="Discard queued action">×</button></div>';
      }).join('');
      h = '<span class="label" style="color:var(--warn)">' + (flushing ? 'Sending…' : connected ? 'Queued' : 'Offline · waiting to send') + '</span>' + chips + '<span class="queue-sep"></span>' + h;
    }
    if (h !== lastQueue) { $('queue').innerHTML = h; lastQueue = h; }
  }
  function frameQueue(f) {
    var bars = document.querySelectorAll('#queue .order');
    bars.forEach(function (el) {
      var o = S.allOrders.filter(function (x) { return String(x.id) === el.dataset.id; })[0];
      if (o) el.querySelector('.bar i').style.width = (clamp((o.total - o.remaining + f) / o.total, 0, 1) * 100).toFixed(1) + '%';
    });
  }

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
    close: function () {}
  };
  function menu() {
    modal('<h2>Command menu</h2><p>Signed in as <b>' + esc(S.user) + '</b>.</p><div class="stack">' +
      '<button class="btn block danger" data-m="confirmReset">Abandon colony &amp; start over</button>' +
      '<button class="btn block" data-m="logout">Sign out</button><button class="btn block" data-m="close">Close</button></div>');
  }
  MODALS.confirmReset = function () {
    modal('<h2>Abandon this colony?</h2><p>All structures, stockpiles and credits are lost and you restart from the beginning. This cannot be undone.</p>' +
      '<div class="actions"><button class="btn" data-m="close">Keep playing</button><button class="btn danger" data-m="reset">Abandon colony</button></div>');
  };
  function checkModals() {
    if (S.colony.status === 'failed' && !restarting && !document.querySelector('.modal.fail')) {
      modal('<h2>Colony abandoned</h2><p>The population lost all hope and walked into the wastes. Your structures are gone, but the convoy will carry <b>' + fmt(S.colony.restartCredits) + ' credits</b> to your next attempt.' +
        (S.colony.failures ? ' Colonies lost so far: ' + S.colony.failures + '.' : '') + '</p>' +
        '<div class="actions" data-lock><button class="btn primary" data-m="restart" data-lock>Found a new colony</button></div>', 'fail');
    }
    if (S.report.length && !acking && !restarting && !document.querySelector('.modal.report')) {
      modal('<h2>While you were away</h2><p>The colony faced trouble and did what it could with what it had.</p><ul class="log">' +
        S.report.map(function (e) { return '<li class="' + e.kind + '">' + esc(e.message) + '<small>tick #' + e.tick + '</small></li>'; }).join('') +
        '</ul><div class="actions"><button class="btn primary" data-m="ack">Understood</button></div>', 'report');
    }
    if (S.colony.won && !shown.won && !storeGet('won:' + S.user)) {
      shown.won = true; storeSet('won:' + S.user, '1');
      modal('<h2>The beacon reached the world</h2><p>Transmission complete. Somewhere out there, something heard you, Commander. You kept your people alive and built something that outlasts the wastes.</p>' +
        '<div class="actions"><button class="btn primary" data-m="close">Keep building</button></div>', 'win');
    }
  }
  function storeGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  // ------------------------------------------------------------------ input
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    var a = el.dataset.act;
    var sh = e.shiftKey ? 10 : 1; // hold Shift for bigger steps
    if (a === 'tab') { e.preventDefault(); tab = el.dataset.tab; renderAll(); }
    else if (a === 'build' && sel && sel.ring) act('build', { ring: sel.ring, slot: sel.slot, type: el.dataset.type, district: activeId });
    else if (a === 'toggle') {
      var tb = buildingAt(+el.dataset.ring, +el.dataset.slot);
      act('toggle', { ring: +el.dataset.ring, slot: +el.dataset.slot, paused: tb ? !tb.paused : undefined, district: activeId }); // explicit state: safe to resend
    }
    else if (a === 'boost') {
      var bt = buildingAt(+el.dataset.ring, +el.dataset.slot);
      act('boost', { ring: +el.dataset.ring, slot: +el.dataset.slot, enabled: bt ? !bt.boost : true, district: activeId });
    }
    else if (a === 'pcancel') { var pid = +el.dataset.id; pending = pending.filter(function (p) { return p.id !== pid; }); renderQueue(); renderRadar(); renderAlerts(); renderPanel(); }
    else if (a === 'demolish') {
      if (confirmKey === el.dataset.key) { confirmKey = null; act('demolish', { ring: +el.dataset.ring, slot: +el.dataset.slot, district: activeId }); }
      else { confirmKey = el.dataset.key; clearTimeout(confirmTimer); confirmTimer = setTimeout(function () { confirmKey = null; renderPanel(); }, 3000); renderPanel(); }
    }
    else if (a === 'cancel') { e.preventDefault(); act('cancel', { orderId: +el.dataset.id }); }
    else if (a === 'upgrade') act('upgrade', { district: activeId }, activeD().core ? 'Hub upgrade started.' : activeD().name + ' upgrade started.');
    else if (a === 'dmode') { dmode = el.dataset.mode; renderPanel(); }
    else if (a === 'linkup') act('link', { district: +el.dataset.id }, 'Link upgraded.');
    else if (a === 'rdel') { var rr = S.routes.filter(function (x) { return x.id === +el.dataset.id; })[0]; if (rr) act('route', { from: rr.fromDistrict, to: rr.toDistrict, resource: rr.resource, rate: 0 }); }
    else if (a === 'rstep') {
      var rt = S.routes.filter(function (x) { return x.id === +el.dataset.id; })[0];
      if (rt) act('route', { from: rt.fromDistrict, to: rt.toDistrict, resource: rt.resource, rate: Math.max(0, rt.rate + (+el.dataset.delta * sh)), reserve: rt.reserve });
    }
    else if (a === 'rdraft') { route[el.dataset.f] = Math.max(el.dataset.f === 'rate' ? 1 : 0, route[el.dataset.f] + (+el.dataset.delta * sh)); renderPanel(); }
    else if (a === 'rsave') act('route', { from: route.from, to: route.to, resource: route.res, rate: route.rate, reserve: route.reserve }, 'Route set.');
    else if (a === 'enter') { e.preventDefault(); enter(+el.dataset.id); }
    else if (a === 'found') act('found', { type: el.dataset.type }, 'Founding started.');
    else if (a === 'sstep') {
      var have = Math.floor(S.views[ship.from].resources[ship.res].amount), cap = Math.max(1, Math.min(CFG.logistics.shipmentMax, have));
      ship.qty = clamp(el.dataset.delta === 'max' ? cap : ship.qty + (+el.dataset.delta * sh), 1, cap); renderPanel();
    }
    else if (a === 'shipsend') {
      act('shipment', { from: ship.from, to: ship.to, resource: ship.res, qty: ship.qty }, 'Shipment dispatched.');
    }
    else if (a === 'expand') act('expand', { ring: +el.dataset.ring, slot: +el.dataset.slot, district: activeId }, 'Expansion started.');
    else if (a === 'recpick') { recipePick = recipePick === el.dataset.rec ? null : el.dataset.rec; renderPanel(); }
    else if (a === 'recset') { var rcp = el.dataset.rec; recipePick = null; act('recipe', { ring: +el.dataset.ring, slot: +el.dataset.slot, recipe: rcp, district: activeId }, 'Recipe set.'); }
    else if (a === 'shield') act('shield', { enabled: !(S.hazard && S.hazard.shield && S.hazard.shield.enabled) });
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
      convoyMode = 'express'; tab = 'convoy'; renderAll();
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
    if (e.target.classList && e.target.classList.contains('numin')) { commitNum(e.target); return; }
    var el = e.target.closest('[data-sel]');
    if (!el) return;
    var k = el.dataset.sel;
    if (k.indexOf('s:') === 0) { msrc = +el.value; renderPanel(); return; }
    if (k.indexOf('m:') === 0) { var mkk = k.slice(2); if (mkk === 'res') { mk.res = el.value; mk.price = null; mk.qty = 50; } else mk[mkk] = mkk === 'ttl' || mkk === 'district' ? +el.value : el.value; if (mkk === 'district') mk.qty = Math.max(1, mk.qty); renderPanel(); return; }
    if (k.indexOf('r:') === 0) { var rk = k.slice(2); if (rk === 'res') route.res = el.value; else route[rk] = +el.value; }
    else if (k === 'res') ship.res = el.value; else ship[k] = +el.value;
    renderPanel();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var m = document.querySelector('.modal-bg'); if (m && !m.querySelector('[data-lock]')) { m.remove(); return; }
      if (sel) { sel = null; renderAll(); }
    }
  });
  $('menu-btn').innerHTML = icon('menu', 18);
  $('menu-btn').addEventListener('click', menu);

  // ------------------------------------------------------------------ state flow
  function renderAll() {
    if (!S) return;
    if (radarFor !== activeId) { radarFor = activeId; viewR = 0; buildRadar(); }
    renderSwitch();
    renderTop(); renderRadar(); renderTabs(); renderPanel(); renderQueue(); renderAlerts(); checkModals();
  }

  function merge(ns) {
    var v = ns.views[activeId];
    return Object.assign({}, ns, {
      buildings: v.buildings, orders: v.orders, resources: v.resources, hub: v.hub, energy: v.energy, defense: v.defense,
      coreRes: ns.resources, coreBuildings: ns.buildings,
      allOrders: Object.keys(ns.views).reduce(function (a, k) {
        return a.concat(ns.views[k].orders.map(function (o) { return Object.assign({ dname: ns.views[k].core ? '' : ns.views[k].name }, o); }));
      }, [])
    });
  }
  function enter(id) {
    if (!RAW || !RAW.views[id]) return;
    activeId = id; sel = null; confirmKey = null;
    S = merge(RAW); renderAll();
  }
  function setState(ns) {
    var first = !S;
    RAW = ns;
    if (activeId === null || !ns.views[activeId]) activeId = ns.districts.filter(function (d) { return d.core; })[0].id;
    S = merge(ns);
    offset = ns.serverNow - Date.now();
    // surface notable new events as toasts
    var top = ns.events.length ? ns.events[0].id : 0;
    if (!first && lastEventId !== null) {
      ns.events.filter(function (e) { return e.id > lastEventId && e.kind !== 'info'; }).reverse().slice(-3).forEach(function (e) {
        toast(e.message, e.kind === 'good');
      });
    }
    lastEventId = Math.max(lastEventId || 0, top);
    if (first) buildResources();
    renderAll();
  }

  var lastFrame = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    if (!S || t - lastFrame < 70) return;
    lastFrame = t;
    var f = frac();
    frameResources(f); frameQueue(f); frameRadar(f);
    if (Math.abs(viewR - targetR) > 0.5) { viewR += (targetR - viewR) * 0.12; setView(viewR); } else if (viewR !== targetR) { viewR = targetR; setView(viewR); }
    var now = Date.now() + offset;
    $('c-convoy').innerHTML = clock(S.convoy.arrivesAt - now) + ' <small>' + S.convoy.ticksLeft + 't</small>';
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

  api('config').then(function (cfg) {
    CFG = cfg;
    return api('state');
  }).then(function (st) {
    setState(st);
    requestAnimationFrame(frame);
    connect();
  });
})();
