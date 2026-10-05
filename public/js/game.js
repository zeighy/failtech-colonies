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
  var S = null;            // latest server view
  var sel = null;          // { ring, slot } | { hub: true } | null
  var tab = 'brief';
  var offset = 0;          // server clock - client clock
  var lastEventId = null;
  var shown = {};          // modals already shown (per page load)
  var connected = true;
  var confirmKey = null, confirmTimer = null;
  var restarting = false;  // suppresses the collapse modal while a restart is in flight
  var slotEls = {};        // "r:s" -> {g, cell, ...}
  var ringLabels = {};     // ring -> svg text shown while the ring is locked
  var hubEl = null;
  var STEP = { scrap: 50, unpurified_water: 25, clean_water: 10, rations: 10, machined_parts: 5, building_materials: 5 };
  var TABS = [['brief', 'Brief', 'list'], ['site', 'Site', 'site'], ['hub', 'Hub', 'hub'], ['convoy', 'Convoy', 'truck'], ['log', 'Log', 'list']];

  // ------------------------------------------------------------------ api
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
  function act(path, body, okMsg) {
    return api(path, body).then(function (d) {
      if (!d.ok) { toast(d.error || 'Action failed.'); return d; }
      if (d.state) setState(d.state);
      if (okMsg) toast(okMsg, true);
      return d;
    }).catch(function () { toast('Cannot reach the server.'); });
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
  var HUB_R = 62, RING_GAP = 8, RING_W = 58, SLOT_GAP = 5;
  function ringInner(r) { return HUB_R + 22 + (r - 1) * (RING_W + RING_GAP); }
  function polar(r, a) { return [r * Math.cos(a), r * Math.sin(a)]; }
  function sectorPath(ring, i, cap) {
    var r0 = ringInner(ring), r1 = r0 + RING_W;
    var a0 = -Math.PI / 2 + (i / cap) * 2 * Math.PI, a1 = -Math.PI / 2 + ((i + 1) / cap) * 2 * Math.PI;
    var o0 = a0 + SLOT_GAP / (2 * r1), o1 = a1 - SLOT_GAP / (2 * r1);
    var i0 = a0 + SLOT_GAP / (2 * r0), i1 = a1 - SLOT_GAP / (2 * r0);
    var large = (o1 - o0) > Math.PI ? 1 : 0;
    var p = function (pt) { return pt[0].toFixed(2) + ' ' + pt[1].toFixed(2); };
    return 'M' + p(polar(r1, o0)) + ' A' + r1 + ' ' + r1 + ' 0 ' + large + ' 1 ' + p(polar(r1, o1)) +
      ' L' + p(polar(r0, i1)) + ' A' + r0 + ' ' + r0 + ' 0 ' + large + ' 0 ' + p(polar(r0, i0)) + ' Z';
  }
  function slotCenter(ring, i, cap) {
    var rm = ringInner(ring) + RING_W / 2;
    return polar(rm, -Math.PI / 2 + ((i + 0.5) / cap) * 2 * Math.PI);
  }

  // ------------------------------------------------------------------ derived lookups
  function buildingAt(r, s) { return S.buildings.filter(function (b) { return b.ring === r && b.slot === s; })[0]; }
  function orderAt(r, s) { return S.orders.filter(function (o) { return o.kind === 'build' && o.data.ring === r && o.data.slot === s; })[0]; }
  function slotUnlocked(r, s) { var cap = S.hub.rings[r]; return !!cap && s < cap; }
  function neighborsOf(r, s) { return CFG.neighbors[r + ':' + s] || []; }
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
    svg.setAttribute('viewBox', '-290 -290 580 580');
    var defs = svgEl('defs', {}, svg);
    var grad = svgEl('radialGradient', { id: 'sweepfade', cx: '0', cy: '0', r: '1', gradientUnits: 'objectBoundingBox' }, defs);
    svgEl('stop', { offset: '0', 'stop-color': '#ff9f1c', 'stop-opacity': '0' }, grad);
    var maxR = 0;
    Object.keys(CFG.rings).forEach(function (r) { maxR = Math.max(maxR, ringInner(+r) + RING_W); });
    var bg = svgEl('g', {}, svg);
    // faint concentric guides + bearing ticks
    [HUB_R + 10].concat(Object.keys(CFG.rings).map(function (r) { return ringInner(+r) + RING_W + 4; })).forEach(function (r) {
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
    Object.keys(CFG.rings).forEach(function (rs) {
      var ring = +rs, cap = CFG.rings[rs];
      for (var i = 0; i < cap; i++) {
        var g = svgEl('g', { 'class': 'slot empty', tabindex: 0, role: 'button' }, slotsG);
        var title = svgEl('title', {}, g);
        var cell = svgEl('path', { d: sectorPath(ring, i, cap), 'class': 'cell' }, g);
        var c = slotCenter(ring, i, cap);
        var inner = svgEl('g', { transform: 'translate(' + c[0].toFixed(1) + ' ' + c[1].toFixed(1) + ')', 'pointer-events': 'none' }, g);
        var plus = svgEl('path', { d: 'M-6 0H6M0 -6V6', 'class': 'plus' }, inner);
        var ico = svgEl('svg', { x: -13, y: -15, width: 26, height: 26, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'class': 'ico' }, inner);
        var tag = svgEl('text', { x: 0, y: 22, 'class': 'tag' }, inner);
        var pbg = svgEl('rect', { x: -16, y: 17, width: 32, height: 3, rx: 1.5, 'class': 'pbar-bg' }, inner);
        var pb = svgEl('rect', { x: -16, y: 17, width: 0, height: 3, rx: 1.5, 'class': 'pbar' }, inner);
        (function (ring, i) {
          g.addEventListener('click', function () { onSlot(ring, i); });
          g.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSlot(ring, i); } });
        })(ring, i);
        slotEls[ring + ':' + i] = { g: g, title: title, ico: ico, tag: tag, plus: plus, pbg: pbg, pb: pb, sig: '' };
      }
    });

    Object.keys(CFG.rings).forEach(function (rs) {
      if (+rs < 2) return;
      var lab = svgEl('text', { x: 0, y: -(ringInner(+rs) + RING_W / 2) + 3, 'class': 'ring-label' }, svg);
      lab.textContent = 'RING ' + rs + ' · LOCKED · HUB LV ' + rs;
      ringLabels[rs] = lab;
    });

    // hub
    var hub = svgEl('g', { 'class': 'hub-core', tabindex: 0, role: 'button' }, svg);
    svgEl('title', {}, hub).textContent = 'Hub: open upgrade panel';
    svgEl('circle', { cx: 0, cy: 0, r: HUB_R, 'class': 'hub-pulse' }, hub);
    svgEl('circle', { cx: 0, cy: 0, r: HUB_R, 'class': 'disc' }, hub);
    svgEl('circle', { cx: 0, cy: 0, r: HUB_R - 8, fill: 'none', stroke: 'rgba(255,159,28,.25)', 'stroke-dasharray': '2 5' }, hub);
    var t1 = svgEl('text', { x: 0, y: -3, 'font-size': 15 }, hub); t1.textContent = 'HUB';
    var t2 = svgEl('text', { x: 0, y: 15, 'font-size': 10, 'letter-spacing': '.12em' }, hub);
    hub.addEventListener('click', function () { sel = { hub: true }; tab = 'hub'; renderAll(); });
    hub.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hub.dispatchEvent(new Event('click')); } });
    hubEl = { g: hub, sub: t2 };
    svg.addEventListener('click', function (e) { if (e.target === svg) { sel = null; renderAll(); } });
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
      var b = unlocked && buildingAt(r, s), o = unlocked && !b && orderAt(r, s);
      var cls = 'slot', name = 'Ring ' + r + ' · Slot ' + (s + 1);
      var c = null, icoName = null, tag = '';
      if (!unlocked) { cls += ' locked'; name += ' (locked)'; }
      else if (b) {
        var def = CFG.buildings[b.type]; c = def.color; icoName = b.type;
        cls += ' built' + (b.paused ? ' paused' : '');
        if (!b.paused && b.status && b.status !== 'running') cls += (b.eff < 0.01 ? ' stalled' : ' low');
        tag = b.paused ? 'OFF' : (b.eff < 0.995 ? pct(b.eff) : '');
        name = def.name + ' (' + name + ')';
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
      el.plus.style.display = (!b && !o && unlocked) ? '' : 'none';
      el.pbg.style.display = o ? '' : 'none';
      el.pb.style.display = o ? '' : 'none';
      el.ico.setAttribute('y', o || tag ? -17 : -13);
    });
    Object.keys(ringLabels).forEach(function (r) { ringLabels[r].style.display = S.hub.rings[r] ? 'none' : ''; });
    hubEl.g.classList.toggle('sel', !!(sel && sel.hub));
    hubEl.sub.textContent = S.hub.upgrading ? 'UPGRADING' : 'LEVEL ' + S.colony.hubLevel;
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
    var m = clamp(c.morale, 0, 100);
    $('c-morale').innerHTML = Math.round(m) + '<small>%</small>';
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
      h += '<div class="res" data-res="' + k + '"><div class="row"><span class="dot" style="background:' + r.color + '"></span>' +
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
      note.textContent = txt; note.className = cls;
      row.classList.toggle('crit', crit);
      row.querySelector('[data-f=bar]').style.width = (shownAmt / r.cap * 100).toFixed(1) + '%';
    });
  }

  // ------------------------------------------------------------------ alerts + legend
  function renderAlerts() {
    var h = '', c = S.colony;
    if (!connected) h += '<div class="alert warn">' + icon('warn', 14) + 'Connection lost. Retrying…</div>';
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
    if ($('alerts').dataset.h !== h) { $('alerts').innerHTML = h; $('alerts').dataset.h = h; }
  }
  function renderLegend() {
    $('legend').innerHTML = Object.keys(CFG.buildings).map(function (k) {
      return '<span style="--c:' + CFG.buildings[k].color + '">' + esc(CFG.buildings[k].name) + '</span>';
    }).join('');
  }

  // ------------------------------------------------------------------ right panel
  function renderTabs() {
    var next = CFG.hubLevels[S.colony.hubLevel + 1];
    var dot = next && !S.hub.upgrading && canAfford(next.upgradeCost);
    var h = TABS.map(function (t) {
      return '<button class="tab" role="tab" data-act="tab" data-tab="' + t[0] + '" aria-selected="' + (tab === t[0]) + '">' + t[1] +
        (t[0] === 'hub' && dot ? '<span class="badge" style="background:var(--good)"></span>' : '') +
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
    var r = sel.ring, s = sel.slot, head = 'Ring ' + r + ' &middot; Slot ' + (s + 1);
    if (!slotUnlocked(r, s)) {
      return '<div class="p-title">' + icon('lock', 22) + '<h3>' + head + '</h3></div><div class="note">Ring ' + r + ' unlocks at hub level ' + r + '.</div>' +
        '<div class="actions"><button class="btn primary" data-act="tab" data-tab="hub">View hub upgrade</button></div>';
    }
    var b = buildingAt(r, s), o = orderAt(r, s);
    if (o) {
      var d = CFG.buildings[o.data.type];
      return '<div class="p-title" style="--c:' + d.color + '">' + icon(o.data.type, 22) + '<h3>' + esc(d.name) + '</h3></div><div class="label">' + head + ' · under construction</div>' +
        '<p class="p-desc">' + o.remaining + ' tick' + (o.remaining === 1 ? '' : 's') + ' remaining.</p>' +
        '<div class="actions"><button class="btn danger" data-act="cancel" data-id="' + o.id + '">Cancel &amp; refund</button></div>';
    }
    if (b) return builtPanel(b, head);
    return buildMenu(r, s, head);
  }

  var STATUS = {
    running: ['Running', 'good'], paused: ['Paused', 'dim'], no_power: ['No power', 'bad'], low_power: ['Low power', 'warn'],
    starved: ['Missing inputs', 'bad'], low_input: ['Short on inputs', 'warn']
  };
  function builtPanel(b, head) {
    var d = CFG.buildings[b.type], st = STATUS[b.paused ? 'paused' : b.status] || STATUS.running;
    var why = (!b.paused && b.limiting) ? ' <span class="dim">(' + esc(CFG.resources[b.limiting].name) + ')</span>' : '';
    var h = '<div class="p-title" style="--c:' + d.color + '">' + icon(b.type, 22) + '<h3>' + esc(d.name) + '</h3></div>' +
      '<div class="label">' + head + '</div><p class="p-desc">' + esc(d.desc) + '</p>' +
      '<dl class="kv"><dt>Status</dt><dd class="' + st[1] + '">' + st[0] + why + '</dd>' +
      '<dt>Efficiency</dt><dd>' + pct(b.paused ? 0 : b.eff) + '</dd>' +
      '<dt>Adjacency</dt><dd class="' + (b.mult > 1.001 ? 'good' : b.mult < 0.999 ? 'bad' : 'dim') + '">' + (Math.abs(b.mult - 1) < 0.001 ? 'none' : '×' + b.mult.toFixed(2)) + '</dd></dl>' +
      '<div class="label sec">Per tick at current efficiency</div><div class="io">' + ioPills(d, b.paused ? 0 : b.eff, b.mult) + '</div>';
    var nts = neighborTypes(b.ring, b.slot);
    h += '<div class="label sec">Neighbours</div>';
    h += nts.length ? '<div class="io">' + nts.map(function (t) {
      var rule = CFG.adjacencyRules.filter(function (x) { return x.targetBuilding === b.type && x.adjacentBuilding === t; })[0];
      return '<span class="pill ' + (rule ? (rule.outputMultiplier > 1 ? 'out' : 'no') : '') + '" style="--c:' + CFG.buildings[t].color + '">' + esc(CFG.buildings[t].name) + (rule ? ' ×' + rule.outputMultiplier : '') + '</span>';
    }).join('') + '</div>' : '<div class="dim" style="font-size:12px">No adjacent structures.</div>';
    var key = 'dem:' + b.id, refund = Math.round(CFG.demolishRefund * 100);
    h += '<div class="actions"><button class="btn" data-act="toggle" data-ring="' + b.ring + '" data-slot="' + b.slot + '">' + icon(b.paused ? 'play' : 'pause', 12) + ' ' + (b.paused ? 'Resume' : 'Pause') + '</button>' +
      '<button class="btn danger" data-act="demolish" data-ring="' + b.ring + '" data-slot="' + b.slot + '" data-key="' + key + '">' +
      (confirmKey === key ? 'Confirm?' : 'Demolish') + '</button></div>' +
      '<div class="dim" style="font-size:11px;margin-top:8px">Demolishing refunds ' + refund + '% of the build cost.</div>';
    return h;
  }

  function buildMenu(r, s, head) {
    var h = '<div class="label">' + head + ' · empty</div><h3 style="margin:4px 0 12px;font-size:15px">Construct</h3><div class="stack">';
    Object.keys(CFG.buildings).forEach(function (k) {
      var d = CFG.buildings[k];
      var locked = d.minHubLevel && S.colony.hubLevel < d.minHubLevel;
      var afford = canAfford(d.cost);
      var pv = previewMult(k, r, s);
      var bonus = '';
      if (pv.parts.length) {
        bonus = '<div class="bonus ' + (pv.mult > 1 ? 'good' : 'bad') + '">Adjacency ×' + pv.mult.toFixed(2) + ' · ' +
          pv.parts.map(function (p) { return esc(CFG.buildings[p.type].name); }).join(', ') + '</div>';
      }
      h += '<button class="opt" data-act="build" data-type="' + k + '"' + (locked || !afford ? ' disabled' : '') + ' style="--c:' + d.color + '">' +
        '<div class="top">' + icon(k, 20) + '<b>' + esc(d.name) + '</b><small>' + d.constructionTicks + ' ticks</small></div>' +
        (locked ? '<div class="warn" style="font-size:11px">Requires hub level ' + d.minHubLevel + '</div>' :
          '<div class="io">' + Object.keys(d.cost).map(function (c) { return pill(c, d.cost[c], S.resources[c].amount < d.cost[c] ? 'no' : ''); }).join('') + '</div>') +
        '<div class="io" style="margin-top:6px;opacity:.85">' + ioPills(d, 1, pv.mult) + '</div>' + bonus + '</button>';
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
  function briefTab() {
    var ds = S.brief.directives, done = ds.filter(function (d) { return d.done; }).length;
    var h = doomCard() + '<div class="p-title" style="margin-top:16px"><h3>Directives</h3><span class="dim num" style="margin-left:auto">' + done + ' / ' + ds.length + '</span></div>' +
      '<div class="meter" style="margin:4px 0 10px"><i style="width:' + (done / ds.length * 100).toFixed(0) + '%;background:var(--amber)"></i></div>';
    ds.forEach(function (d) {
      h += '<div class="dir' + (d.done ? ' done' : '') + (d.current ? ' current' : '') + '"><span class="tick">' + icon('check', 11) + '</span><div class="body"><b>' + esc(d.title) + '</b>';
      if (!d.done) {
        h += '<div class="hint">' + esc(d.hint) + '</div>' + timingLine(d.timing);
        if (d.progress) h += '<div class="meter" style="margin-top:6px"><i style="width:' + (d.progress.value / d.progress.max * 100).toFixed(0) + '%;background:var(--good)"></i></div><div class="tm num">' + d.progress.value + ' / ' + d.progress.max + ' ticks held</div>';
      }
      h += '</div></div>';
    });
    return h + '<div class="note" style="margin-top:14px">Directives only point at what is missing. Working out how is the game.</div>';
  }

  function hubTab() {
    var c = S.colony, lv = CFG.hubLevels[c.hubLevel], next = CFG.hubLevels[c.hubLevel + 1];
    var max = Math.max.apply(null, Object.keys(CFG.hubLevels).map(Number));
    var h = '<div class="p-title">' + icon('hub', 22) + '<h3>Command Hub · Level ' + c.hubLevel + '</h3></div>' +
      '<dl class="kv"><dt>Storage per resource</dt><dd>' + fmt(lv.maxStorage) + '</dd><dt>Max population</dt><dd>' + lv.maxPopulation +
      '</dd><dt>Base power</dt><dd>' + lv.baseEnergy + '</dd><dt>Rings online</dt><dd>' + Object.keys(lv.ringCapacities).length + ' (' +
      Object.keys(lv.ringCapacities).reduce(function (a, k) { return a + lv.ringCapacities[k]; }, 0) + ' slots)</dd></dl>';
    h += '<div class="label sec">Hub upgrade</div>';
    if (!next) h += '<div class="note good">The hub is fully upgraded.</div>';
    else {
      var up = S.orders.filter(function (o) { return o.kind === 'upgrade'; })[0];
      h += '<div class="opt" style="cursor:default"><div class="top"><b>Level ' + (c.hubLevel + 1) + '</b><small>' + next.upgradeTicks + ' ticks</small></div>' +
        '<div class="io">' + Object.keys(next.upgradeCost).map(function (r) { return pill(r, next.upgradeCost[r], S.resources[r].amount < next.upgradeCost[r] ? 'no' : ''); }).join('') + '</div>' +
        '<div class="dim" style="font-size:11px;margin-top:8px">Unlocks ring ' + (c.hubLevel + 1) + ' · storage ' + fmt(next.maxStorage) + ' · population ' + next.maxPopulation + ' · base power ' + next.baseEnergy + '</div></div>';
      h += up ? '<div class="note">Upgrade in progress: ' + up.remaining + ' ticks remaining. <a href="#" data-act="cancel" data-id="' + up.id + '" style="color:var(--amber)">Cancel</a></div>'
        : '<div class="actions"><button class="btn primary" data-act="upgrade"' + (canAfford(next.upgradeCost) ? '' : ' disabled') + '>Begin upgrade</button></div>';
    }
    h += '<div class="label sec">Mission: self-sustaining colony</div>';
    var wn = S.resources.clean_water.net > 0, rn = S.resources.rations.net > 0, pw = S.energy.satisfaction >= 0.999;
    var goals = [[c.hubLevel >= max, 'Hub at level ' + max], [pw, 'Power grid covers demand'], [wn, 'Clean water production exceeds use'], [rn, 'Ration production exceeds use']];
    goals.forEach(function (g) { h += '<div class="goal ' + (g[0] ? 'done' : '') + '"><span class="tick">' + icon('check', 11) + '</span><span>' + g[1] + '</span></div>'; });
    h += '<div class="goal ' + (c.won ? 'done' : '') + '"><span class="tick">' + icon('check', 11) + '</span><span>Hold it for ' + CFG.goalSustainTicks + ' ticks <span class="dim">(' + (c.won ? CFG.goalSustainTicks : c.goalTicks) + '/' + CFG.goalSustainTicks + ')</span></span></div>';
    if (c.won) h += '<div class="note good">Mission accomplished. Keep building if you like.</div>';
    return h;
  }

  function convoyTab() {
    var h = '<div class="convoy-head"><div class="label">Next convoy in</div><div class="big num" data-f="convoy">–</div><div class="dim" style="font-size:11px" data-f="convoyTicks"></div></div>' +
      '<p class="p-desc">Standing orders repeat every convoy. Exports sell your surplus at the convoy price; imports are bought with credits. Max ' + CFG.convoyMax + ' per resource.</p>';
    var net = 0;
    Object.keys(CFG.resources).forEach(function (k) {
      var r = CFG.resources[k], ex = S.contracts.export[k] || 0, im = S.contracts.import[k] || 0, st = STEP[k] || 10;
      net += ex * r.sell - im * r.buy;
      var stepper = function (side, v) {
        return '<div class="stepper"><span class="lab">' + (side === 'export' ? 'Sell' : 'Buy') + '</span><button data-act="contract" data-res="' + k + '" data-side="' + side + '" data-delta="-' + st + '"' + (v <= 0 ? ' disabled' : '') + ' aria-label="Decrease ' + side + '">−</button>' +
          '<span class="val num">' + v + '</span><button data-act="contract" data-res="' + k + '" data-side="' + side + '" data-delta="' + st + '"' + (v >= CFG.convoyMax ? ' disabled' : '') + ' aria-label="Increase ' + side + '">+</button></div>';
      };
      h += '<div class="trade" style="--c:' + r.color + '"><div class="nm"><i></i>' + esc(r.name) + '</div>' +
        '<div class="stock">stock <span class="num" data-b="amt:' + k + '"></span></div>' + stepper('export', ex) + stepper('import', im) +
        '<div class="sub"><span>sells for ' + r.sell + ' cr</span><span>buys for ' + r.buy + ' cr</span></div></div>';
    });
    h += '<div class="note ' + (net >= 0 ? 'good' : '') + '" style="margin-top:12px">Estimated convoy balance: <b>' + (net >= 0 ? '+' : '−') + fmt(Math.abs(net)) + ' cr</b></div>';
    return h;
  }

  function logTab() {
    if (!S.events.length) return '<div class="empty-state">No events yet.</div>';
    return '<ul class="log">' + S.events.map(function (e) {
      return '<li class="' + e.kind + '" data-id="' + e.id + '">' + esc(e.message) + '<small>tick #' + e.tick + '</small></li>';
    }).join('') + '</ul>';
  }

  var lastPanel = '';
  function renderPanel() {
    var h = tab === 'hub' ? hubTab() : tab === 'convoy' ? convoyTab() : tab === 'log' ? logTab() : tab === 'brief' ? briefTab() : siteTab();
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
      if (k[0] === 'amt') { var r = S.resources[k[1]]; el.textContent = fmt(clamp(r.amount + r.net * frac(), 0, r.cap)); }
    });
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
    if (!S.orders.length) h += '<span class="queue-empty">No active work orders.</span>';
    S.orders.forEach(function (o) {
      var name = o.kind === 'build' ? 'Build ' + CFG.buildings[o.data.type].name : 'Hub upgrade → L' + o.data.level;
      var where = o.kind === 'build' ? 'R' + o.data.ring + '·' + (o.data.slot + 1) : '';
      h += '<div class="order" data-id="' + o.id + '"><button class="x" data-act="cancel" data-id="' + o.id + '" title="Cancel & refund" aria-label="Cancel order">×</button>' +
        '<div class="row"><span>' + esc(name) + '</span><small class="num">' + (where ? where + ' · ' : '') + o.remaining + 't</small></div><div class="bar"><i></i></div></div>';
    });
    if (h !== lastQueue) { $('queue').innerHTML = h; lastQueue = h; }
  }
  function frameQueue(f) {
    var bars = document.querySelectorAll('#queue .order');
    bars.forEach(function (el) {
      var o = S.orders.filter(function (x) { return String(x.id) === el.dataset.id; })[0];
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
    if (S.colony.won && !shown.won && !storeGet('won:' + S.user)) {
      shown.won = true; storeSet('won:' + S.user, '1');
      modal('<h2>Colony self-sustaining</h2><p>Hub at maximum level with a stable power and supply loop. You have kept your people alive in the wastes, Commander.</p>' +
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
    if (a === 'tab') { e.preventDefault(); tab = el.dataset.tab; renderAll(); }
    else if (a === 'build' && sel && sel.ring) act('build', { ring: sel.ring, slot: sel.slot, type: el.dataset.type });
    else if (a === 'toggle') act('toggle', { ring: +el.dataset.ring, slot: +el.dataset.slot });
    else if (a === 'demolish') {
      if (confirmKey === el.dataset.key) { confirmKey = null; act('demolish', { ring: +el.dataset.ring, slot: +el.dataset.slot }); }
      else { confirmKey = el.dataset.key; clearTimeout(confirmTimer); confirmTimer = setTimeout(function () { confirmKey = null; renderPanel(); }, 3000); renderPanel(); }
    }
    else if (a === 'cancel') { e.preventDefault(); act('cancel', { orderId: +el.dataset.id }); }
    else if (a === 'upgrade') act('upgrade', {}, 'Hub upgrade started.');
    else if (a === 'contract') {
      var side = el.dataset.side, res = el.dataset.res;
      var cur = S.contracts[side][res] || 0, v = clamp(cur + (+el.dataset.delta), 0, CFG.convoyMax);
      S.contracts[side][res] = v; if (!v) delete S.contracts[side][res];
      renderPanel();
      act('contract', { resource: res, side: side, amount: v });
    }
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
    renderTop(); renderRadar(); renderTabs(); renderPanel(); renderQueue(); renderAlerts(); checkModals();
  }

  function setState(ns) {
    var first = !S;
    S = ns;
    offset = ns.serverNow - Date.now();
    // surface notable new events as toasts
    var top = ns.events.length ? ns.events[0].id : 0;
    if (!first && lastEventId !== null) {
      ns.events.filter(function (e) { return e.id > lastEventId && e.kind !== 'info'; }).reverse().slice(-3).forEach(function (e) {
        toast(e.message, e.kind === 'good');
      });
    }
    lastEventId = Math.max(lastEventId || 0, top);
    if (first) { buildRadar(); buildResources(); renderLegend(); }
    renderAll();
  }

  var lastFrame = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    if (!S || t - lastFrame < 70) return;
    lastFrame = t;
    var f = frac();
    frameResources(f); frameQueue(f); frameRadar(f);
    var now = Date.now() + offset;
    $('c-convoy').innerHTML = clock(S.convoy.arrivesAt - now) + ' <small>' + S.convoy.ticksLeft + 't</small>';
    framePanel();
  }

  function connect() {
    var es = new EventSource('/api/stream');
    es.onmessage = function (e) {
      if (!connected) { connected = true; }
      setState(JSON.parse(e.data));
    };
    es.onerror = function () {
      connected = false;
      if (S) renderAlerts();
      api('state').then(function (d) { if (d && d.user) { /* still signed in, EventSource retries */ } });
    };
  }

  api('config').then(function (cfg) {
    CFG = cfg;
    return api('state');
  }).then(function (st) {
    setState(st);
    requestAnimationFrame(frame);
    connect();
  });
})();
