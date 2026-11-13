// Orbital Command: the view of everything in orbit, and the launch controls on the ground.
// Purely presentational: it reads state.orbital and the station/territory district views, and sends intents.
(function () {
  var H = null; // host: { S(), CFG(), act(path, body, okMsg), esc, fmt, icon, pill, modal, enter(id), tab(t), redraw(), activeD() }
  var draft = {
    link: { dir: 'up', res: 'frames', rate: 10 },
    express: { res: 'frames', qty: 100, dir: 'up' },
    market: { res: null, side: 'buy', price: null, qty: 10, ttl: 300 },
    deploy: null,   // { ship, territory, preload: {res: qty}, stabilize, links }
    contrib: null,  // { ship, cargo: {res: qty} }
    name: ''
  };
  // Two-step buttons: the first click arms the button, and only a second, separate click a moment later confirms it.
  // A second click that lands straight away (a double click) is ignored and leaves the button armed.
  var armed = null, ARM_DELAY = 700, ARM_LIFE = 4000;
  function isArmed(key) { return !!armed && armed.key === key && Date.now() - armed.at <= ARM_LIFE; }
  function confirmClick(key) {
    var now = Date.now();
    if (isArmed(key)) {
      if (now - armed.at < ARM_DELAY) return false;
      armed = null; return true;
    }
    armed = { key: key, at: now };
    H.redraw();
    setTimeout(function () { if (armed && armed.key === key && Date.now() - armed.at >= ARM_LIFE) { armed = null; H.redraw(); } }, ARM_LIFE + 50);
    return false;
  }

  function init(host) { H = host; document.addEventListener('click', onClick); document.addEventListener('change', onChange); }
  var S = function () { return H.S(); };
  var C = function () { return H.CFG(); };
  var O = function () { return S().orbital; };
  var esc = function (s) { return H.esc(s); };
  var fmt = function (n) { return H.fmt(n); };
  var rn = function (r) { return (C().resources[r] || { name: r }).name; };
  function costLine(cost, have) {
    // credits are paid from the treasury, not from orbital storage
    return '<div class="io">' + Object.keys(cost || {}).map(function (r) {
      if (r === 'credits') return '<span class="pill ' + (S().colony.credits < cost[r] ? 'no' : '') + '" style="--c:var(--amber)"><i></i>' + fmt(cost[r]) + ' cr</span>';
      return H.pill(r, cost[r], have && (have[r] || 0) < cost[r] ? 'no' : '');
    }).join('') + '</div>';
  }
  function bar(v, max, cls) { return '<div class="meter wide"><i class="' + (cls || '') + '" style="width:' + Math.max(0, Math.min(100, max ? v / max * 100 : 0)).toFixed(1) + '%"></i></div>'; }
  function num(kind, val, extra) { return '<input class="numin onum" type="text" inputmode="decimal" autocomplete="off" data-onum="' + kind + '" ' + (extra || '') + ' value="' + esc(String(val)) + '" aria-label="Amount">'; }
  function sel(kind, opts, cur, extra) {
    return '<select data-osel="' + kind + '" ' + (extra || '') + '>' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
  }
  function ticks(n) { return n + ' tick' + (n === 1 ? '' : 's'); }
  function stationInv() { var st = O().station; return st ? S().views[st.districtId].resources : {}; }
  function stationAmounts() { var r = stationInv(), o = {}; Object.keys(r).forEach(function (k) { o[k] = r[k].amount; }); return o; }

  // ---------------------------------------------------------------- ground side: launch controls
  // Rendered inside the Site pane for the staging platform, the catapult and the command center.
  function launchCard(b, def) {
    var o = O(), L = o.launch, cyc = C().orbital.launch.cycles, h = '';
    var label = function (k) { return k === 'station' ? 'Orbital station' : k === 'ring2' ? 'Station ring 2' : k === 'ring3' ? 'Station ring 3' : k; };
    var chain = '<div class="io">' + [['staging', 'Staging platform'], ['catapult', 'Catapult'], ['command', 'Orbital Command Center']].map(function (x) {
      return '<span class="pill ' + (o.site[x[0]] ? 'out' : 'no') + '"><i></i>' + x[1] + (o.site[x[0]] ? '' : ' (needed)') + '</span>';
    }).join('') + '</div>';
    if (def.launchPad) {
      h += '<div class="label sec">Launch cycle</div>' + chain;
      if (L.ready) h += '<div class="note good">' + esc(label(L.ready)) + ' payload complete. Launch it from the catapult.</div>';
      else if (L.loaded) {
        var c = cyc[L.loaded];
        h += '<div class="optcard on"><div class="top"><b>' + esc(label(L.loaded)) + '</b><span>' + fmt(L.progress) + ' / ' + fmt(L.ticks) + '</span></div>' + bar(L.progress, L.ticks) +
          '<div class="dim" style="font-size:11px;margin:6px 0">Draws every tick, from the Core:</div>' + costLine(c.perTick) +
          '<div class="actions"><button class="btn" data-orbit="cycle" data-cycle="">Abandon this cycle</button></div></div>';
      } else if (L.next) {
        var n = cyc[L.next], ready = o.site.staging && o.site.catapult && o.site.command;
        h += '<div class="optcard"><div class="top"><b>Next: ' + esc(label(L.next)) + '</b><span class="dim">' + fmt(n.ticks) + ' ticks</span></div>' +
          '<div class="dim" style="font-size:11px;margin-bottom:6px">Per tick, while loaded:</div>' + costLine(n.perTick) +
          (n.orbitalCost ? '<div class="dim" style="font-size:11px;margin:6px 0">And at launch, from orbital storage:</div>' + costLine(n.orbitalCost) : '') +
          '<div class="actions"><button class="btn primary" data-orbit="cycle" data-cycle="' + L.next + '"' + (ready ? '' : ' disabled') + '>Load this launch cycle</button></div></div>';
        if (!ready) h += '<div class="dim" style="font-size:11px">Every part of the launch chain has to be built first.</div>';
      } else h += '<div class="note">Nothing left to launch.</div>';
    }
    if (def.catapult) {
      h += '<div class="label sec">Launch</div>' + chain;
      if (L.ready) {
        var first = L.ready === 'station';
        h += '<div class="optcard on"><div class="top"><b>' + esc(label(L.ready)) + '</b><span class="good">Ready</span></div>' +
          (first ? '<label class="field"><span class="label">Station name</span><input id="station-name" maxlength="24" value="' + esc(draft.name) + '" placeholder="3 to 24 characters"></label>' +
            '<div class="dim" style="font-size:11px;margin:4px 0 8px">Shown to other players. Not your callsign.</div>' : '') +
          '<div class="actions"><button class="btn primary" data-orbit="launch">' + H.icon('orbit', 12) + ' Launch</button></div></div>';
      } else h += '<div class="dim" style="font-size:12px">Nothing is on the catapult.</div>';
      if (o.station) h += expressCard();
    }
    if (def.commandCenter) {
      h += '<div class="label sec">Orbital Command</div>' + chain +
        (o.station ? '<div class="actions"><button class="btn primary" data-orbit="enter-orbit">' + H.icon('orbit', 12) + ' Open Orbital Command</button></div>'
          : '<div class="dim" style="font-size:12px">Must be running for the first launch.</div>');
    }
    return h;
  }

  function expressCard() {
    var x = O().station.express, d = draft.express, core = S().coreRes, down = d.dir === 'down';
    var held = {}; O().station.storage.slots.forEach(function (sl) { if (sl.resource) held[sl.resource] = sl.amount; });
    var src = down ? held : Object.keys(core).reduce(function (m, r) { m[r] = core[r].amount; return m; }, {});
    var res = Object.keys(C().resources).filter(function (r) { return !C().resources[r].rare && src[r] >= 1; });
    if (res.indexOf(d.res) < 0 && res.length) d.res = res[0];
    var fuel = Math.ceil(x.fuelBase + d.qty * x.fuelPerUnit);
    var h = '<div class="label sec">Express launch and drop</div>';
    if (x.inFlight.length) h += x.inFlight.map(function (s) { return '<div class="dim" style="font-size:12px">' + fmt(s.qty) + ' ' + esc(rn(s.resource)) + (s.dir === 'down' ? ' landing at the Core in ' : ' arriving in orbit in ') + ticks(s.ticksLeft) + '</div>'; }).join('');
    if (x.readyIn > 0) return h + '<div class="dim" style="font-size:12px">The express slot is cooling down: ready in ' + ticks(x.readyIn) + '.</div>';
    var capsule = Object.keys(x.drop.cost).map(function (r) { return fmt(x.drop.cost[r]) + ' ' + esc(rn(r)); }).join(', ');
    return h + '<div class="dim" style="font-size:11px;margin-bottom:6px">' + (down
        ? 'One capsule from orbital storage down to the Core, up to ' + x.maxQty + '. Gravity does the work: it costs only the capsule (' + capsule + ' from orbital storage).'
        : 'One payload straight from the Core to orbital storage, up to ' + x.maxQty + ', for fuel.') + ' Then the slot rests for ' + ticks(x.cooldownTicks) + '.</div>' +
      '<div class="orow">' + sel('express-dir', [['up', 'Core → orbit'], ['down', 'Orbit → Core']], d.dir) + '</div>' +
      (res.length ? '<div class="orow">' + sel('express-res', res.map(function (r) { return [r, rn(r) + ' (' + fmt(src[r]) + ')']; }), d.res) + num('express-qty', d.qty) + '</div>' +
        (down ? '<div class="dim" style="font-size:12px;margin:6px 0">Capsule: <b>' + capsule + '</b> (you have ' + fmt(held.fittings || 0) + ' ' + esc(rn('fittings')) + ') · lands in ' + ticks(x.drop.travelTicks) + '</div>'
          : '<div class="dim" style="font-size:12px;margin:6px 0">Fuel: <b>' + fmt(fuel) + '</b> (you have ' + fmt(core.fuel ? core.fuel.amount : 0) + ') · arrives in ' + ticks(x.travelTicks) + '</div>') +
        '<div class="actions"><button class="btn primary" data-orbit="express">' + (down ? 'Express drop' : 'Express launch') + '</button></div>'
        : '<div class="dim" style="font-size:12px;margin-top:6px">Nothing to send that way yet.</div>');
  }

  // ---------------------------------------------------------------- the panes
  function placePane() {
    var d = H.activeD();
    if (d.type === 'territory') return territoryPane(d);
    var st = O().station, v = S().views[st.districtId], cyc = C().orbital.launch.cycles;
    var nextKey = O().launch.next, n = nextKey ? cyc[nextKey] : null;
    var h = '<div class="p-title" style="--c:#90e0ef">' + H.icon('orbit', 22) + '<h3>' + esc(st.name) + '</h3>' + (st.badge ? '<span class="hqbadge" title="Independent charter">' + esc(st.badge) + ' Chartered</span>' : '') + '</div>' +
      '<dl class="kv"><dt>Rings</dt><dd>' + st.level + ' of 3</dd><dt>Power</dt><dd>' + Math.floor(v.energy.supply) + ' supply · ' + Math.ceil(v.energy.demand) + ' demand</dd>' +
      '<dt>Storage</dt><dd>' + st.storage.slots.filter(function (s) { return s.resource; }).length + ' / ' + st.storage.slots.length + ' slots · ' + fmt(st.storage.cap) + ' each' + (st.storage.slots.some(function (s) { return s.kind === 'hc'; }) ? ' (' + fmt(st.storage.hcCap) + ' high-capacity)' : '') + '</dd>' +
      '<dt>Links to the Core</dt><dd>' + st.links.list.length + ' / ' + st.links.count + '</dd><dt>Dropships</dt><dd>' + (O().ships ? O().ships.ships.length + ' / ' + O().ships.max : '0') + '</dd></dl>';
    if (n) {
      h += '<div class="label sec">Next ring</div><div class="optcard"><div class="top"><b>Ring ' + n.stationLevel + '</b><span class="dim">launched from the colony</span></div>' +
        '<div class="dim" style="font-size:11px;margin-bottom:6px">A launch cycle at the staging platform (' + fmt(n.ticks) + ' ticks), drawing per tick:</div>' + costLine(n.perTick) +
        (n.orbitalCost ? '<div class="dim" style="font-size:11px;margin:6px 0">and at launch, from orbital storage:</div>' + costLine(n.orbitalCost, stationAmounts()) : '') + '</div>';
    }
    return h;
  }

  function storePane() {
    var st = O().station, s = st.storage, inv = stationInv(), core = S().coreRes, have = stationAmounts();
    var normal = s.slots.filter(function (x) { return x.kind !== 'hc'; }), high = s.slots.filter(function (x) { return x.kind === 'hc'; });
    var freeOf = function (list) { return list.some(function (x) { return !x.resource && x.state === 'open'; }); };
    var h = '<div class="label sec">Orbital storage · ' + normal.filter(function (x) { return x.resource; }).length + ' of ' + normal.length + ' slots</div>';
    h += normal.map(function (slot) {
      if (slot.state === 'jettisoned') {
        return '<div class="oslot gone"><span class="dim">Slot ' + (slot.idx + 1) + ' · jettisoned</span><button class="btn" data-orbit="rebuild" data-slot="' + slot.idx + '">Rebuild</button></div>';
      }
      if (!slot.resource) return '<div class="oslot empty"><span class="dim">Slot ' + (slot.idx + 1) + ' · empty</span></div>';
      var r = inv[slot.resource] || { amount: 0, net: 0 };
      var key = 'j' + slot.idx;
      return '<div class="oslot" style="--c:' + (C().resources[slot.resource] || {}).color + '"><i></i><b>' + esc(rn(slot.resource)) + '</b><span class="num">' + fmt(r.amount) + ' <small>/ ' + fmt(s.cap) + '</small></span>' +
        '<small class="' + (r.net > 0.05 ? 'good' : r.net < -0.05 ? 'bad' : 'dim') + '">' + (Math.abs(r.net) < 0.05 ? '±0' : (r.net > 0 ? '+' : '−') + Math.abs(r.net).toFixed(1)) + '/t</small>' +
        (high.length && freeOf(high) ? '<button class="btn" data-orbit="slot-move" data-res="' + slot.resource + '" data-to="hc" title="Move to a high-capacity slot">To high-cap</button>' : '') +
        '<button class="btn danger" data-orbit="jettison" data-slot="' + slot.idx + '">' + (isArmed('j' + slot.idx) ? 'Confirm?' : 'Jettison') + '</button></div>';
    }).join('');
    if (high.length) {
      h += '<div class="label sec">High-capacity slots · ' + fmt(s.hcCap) + ' each</div>' + high.map(function (slot, i) {
        if (!slot.resource) return '<div class="oslot empty hc"><span class="dim">High-capacity slot ' + (i + 1) + ' · empty</span></div>';
        var r = inv[slot.resource] || { amount: 0, net: 0 };
        return '<div class="oslot hc" style="--c:' + (C().resources[slot.resource] || {}).color + '"><i></i><b>' + esc(rn(slot.resource)) + '</b><span class="num">' + fmt(r.amount) + ' <small>/ ' + fmt(s.hcCap) + '</small></span>' +
          '<small class="' + (r.net > 0.05 ? 'good' : r.net < -0.05 ? 'bad' : 'dim') + '">' + (Math.abs(r.net) < 0.05 ? '±0' : (r.net > 0 ? '+' : '−') + Math.abs(r.net).toFixed(1)) + '/t</small>' +
          (freeOf(normal) && r.amount <= s.cap ? '<button class="btn" data-orbit="slot-move" data-res="' + slot.resource + '" data-to="normal">To ordinary</button>' : '') +
          (r.amount < 1 ? '<button class="btn" data-orbit="slot-release" data-slot="' + slot.idx + '">Free it</button>' : '') + '</div>';
      }).join('');
    }
    h += '<div class="dim" style="font-size:11px;margin-top:6px">One resource per slot · no slot, goods lost · rebuild after jettison: ' + Object.keys(C().orbital.storage.rebuildCost).map(function (r) { return C().orbital.storage.rebuildCost[r] + ' ' + rn(r); }).join(', ') + '</div>';
    if (s.next) h += '<div class="optcard" style="margin-top:8px"><div class="top"><b>Expand storage</b><span class="dim">' + s.next.slots + ' slots · ' + fmt(s.next.cap) + ' each</span></div>' + costLine(s.next.cost, have) + '<div class="actions"><button class="btn" data-orbit="storage-up">Expand</button></div></div>';
    // links
    var L = st.links;
    h += '<div class="label sec">Orbital links · ' + L.list.length + ' of ' + L.count + '</div>';
    h += L.list.length ? L.list.map(function (l) {
      return '<div class="oslot link"><span>' + (l.dir === 'up' ? '↑ up' : '↓ down') + '</span><b>' + esc(rn(l.resource)) + '</b><span class="num">' + num('link-rate', l.rate, 'data-id="' + l.id + '" data-res="' + l.resource + '" data-dir="' + l.dir + '"') + '<small>/t · moving ' + fmt(l.flow) + '</small></span>' +
        '<button class="btn" data-orbit="link-off" data-res="' + l.resource + '" data-dir="' + l.dir + '">Remove</button></div>';
    }).join('') : '<div class="dim" style="font-size:12px">No links yet.</div>';
    if (L.list.length < L.count) {
      var d = draft.link, src = d.dir === 'up' ? core : inv;
      var opts = Object.keys(C().resources).filter(function (r) { return !C().resources[r].rare && src[r] && (src[r].amount >= 1 || (d.dir === 'up' && C().resources[r].showFromHub !== 99)); });
      if (opts.indexOf(d.res) < 0 && opts.length) d.res = opts[0];
      h += '<div class="orow" style="margin-top:8px">' + sel('link-dir', [['up', 'Core → orbit'], ['down', 'Orbit → Core']], d.dir) + sel('link-res', opts.map(function (r) { return [r, rn(r)]; }), d.res) + num('link-new', d.rate) + '</div>' +
        '<div class="actions"><button class="btn primary" data-orbit="link-add">Add link (max ' + L.rate + '/t)</button></div>';
    }
    h += '<div class="dim" style="font-size:11px;margin-top:6px">Core ↔ station · rare resources can\'t use links</div>';
    if (L.next) h += '<div class="optcard" style="margin-top:8px"><div class="top"><b>More links</b><span class="dim">' + L.next.count + ' links · ' + L.next.rate + '/t each</span></div>' + costLine(L.next.cost, have) + '<div class="actions"><button class="btn" data-orbit="links-up">Upgrade</button></div></div>';
    if (S().coreRes) h += expressCard();
    return h;
  }

  function shipCard(s, terrs) {
    var stateTxt = { docked: 'Docked', building: 'Being built', deploying: 'Descending', deployed: 'Deployed', returning: 'Returning', contributing: 'On a project run' }[s.state] || s.state;
    var h = '<div class="optcard' + (s.state === 'deployed' ? ' on' : '') + '"><div class="top"><b>' + H.icon('ship', 14) + ' Dropship ' + s.num + ' · L' + s.level + '</b><span>' + stateTxt + (s.ticksLeft ? ' · ' + ticks(s.ticksLeft) : '') + '</span></div>' +
      '<div class="dim" style="font-size:11px">Integrity ' + s.integrity + '%' + (s.unbreakable ? ' · indestructible' : s.savedOnce ? ' · already escaped destruction once' : '') + ' · hold ' + fmt(s.hold) + ' · power ' + s.power + ' · links ' + s.linkRate + '/t' +
        (s.stabilizer ? ' · carrying a stabilizer' : '') + (s.extraLinks ? ' · ' + s.extraLinks + ' link kit' + (s.extraLinks === 1 ? '' : 's') : '') + '</div>' + bar(s.integrity, 100, s.integrity < 30 ? 'bad' : s.integrity < 60 ? 'warn' : '');
    if (s.state === 'deployed' && s.territory) {
      h += '<div class="dim" style="font-size:12px;margin-top:6px">In <b>' + esc(s.territory.name) + '</b> · ' + esc(s.territory.anomaly.name) + ' closes in ' + ticks(s.territory.ticksLeft) + '</div>' +
        '<div class="actions"><button class="btn primary" data-orbit="view" data-id="' + s.districtId + '">View territory</button><button class="btn" data-orbit="recall" data-ship="' + s.id + '">' + (isArmed('r' + s.id) ? 'Confirm: fly back?' : 'Fly back now') + '</button></div>';
    }
    if (Object.keys(s.cargo || {}).length) h += '<div class="io" style="margin-top:6px">' + Object.keys(s.cargo).map(function (r) { return H.pill(r, s.cargo[r]); }).join('') + '</div>';
    if (s.state === 'docked') {
      var have = stationAmounts();
      h += '<div class="actions">' + (s.integrity > 0 ? '<button class="btn primary" data-orbit="deploy-start" data-ship="' + s.id + '">Deploy…</button>' : '') +
        (s.repairCost ? '<button class="btn" data-orbit="repair" data-ship="' + s.id + '" title="' + esc(Object.keys(s.repairCost).map(function (r) { return s.repairCost[r] + ' ' + rn(r); }).join(', ')) + '">Repair</button>' : '') +
        (s.next ? '<button class="btn" data-orbit="ship-up" data-ship="' + s.id + '" title="' + esc(Object.keys(s.next.cost).map(function (r) { return s.next.cost[r] + ' ' + rn(r); }).join(', ')) + '">Upgrade</button>' : '') +
        (s.level === 3 && O().ships.l4Banked > 0 ? '<button class="btn primary" data-orbit="ship-refit" data-ship="' + s.id + '">Refit to level 4</button>' : '') + '</div>';
      if (s.repairCost) h += '<div class="dim" style="font-size:11px">Repair: ' + costLine(s.repairCost, have) + '</div>';
    }
    return h + '</div>';
  }

  function deployForm() {
    var d = draft.deploy, sh = O().ships, s = sh.ships.filter(function (x) { return x.id === d.ship; })[0];
    if (!s || s.state !== 'docked') { draft.deploy = null; return ''; }
    var open = sh.territories.filter(function (t) { return t.open && t.ticksLeft > sh.deployTicks; });
    if (!open.some(function (t) { return t.id === d.territory; })) d.territory = open.length ? open[0].id : null;
    var inv = stationInv(), used = Object.keys(d.preload).reduce(function (n, r) { return n + d.preload[r]; }, 0);
    var h = '<div class="optcard on"><div class="top"><b>Deploy dropship ' + s.num + '</b><span class="dim">hold ' + fmt(used) + ' / ' + fmt(s.hold) + '</span></div>';
    if (!d.territory) return h + '<div class="dim">No territory is open right now.</div><div class="actions"><button class="btn" data-orbit="deploy-cancel">Cancel</button></div></div>';
    h += '<div class="orow">' + sel('deploy-terr', open.map(function (t) { return [t.id, t.name + (t.private ? ' · yours' : t.stabilized ? ' · stabilised' : '') + (t.dataSite ? ' · data site' : '') + ' · ' + t.anomaly.name + ' · ' + t.ticksLeft + 't']; }), d.territory) + '</div>' +
      '<div class="dim" style="font-size:11px;margin:6px 0">Lands in ' + ticks(sh.deployTicks) + ' · kit (' + Object.keys(sh.starterKit).map(function (r) { return sh.starterKit[r] + ' ' + rn(r); }).join(', ') + ') · preload:</div>';
    h += Object.keys(inv).filter(function (r) { return inv[r].amount >= 1; }).map(function (r) {
      return '<div class="orow"><span style="flex:1">' + esc(rn(r)) + ' <small class="dim">(' + fmt(inv[r].amount) + ')</small></span>' + num('preload', d.preload[r] || 0, 'data-res="' + r + '"') + '</div>';
    }).join('');
    // Headquarters equipment: a stabilizer (one ready, for a territory that is neither stabilised nor private) and link kits
    var tt = open.filter(function (t) { return t.id === d.territory; })[0], stab = sh.stabilizers || [], ready = stab.some(function (x) { return x <= 0; });
    if (stab.length) {
      var canStab = ready && tt && !tt.stabilized && !tt.private;
      if (!canStab) d.stabilize = false;
      h += '<label class="orow"><input type="checkbox" data-osel="deploy-stab"' + (d.stabilize ? ' checked' : '') + (canStab ? '' : ' disabled') + '> <span style="flex:1">Take a territory stabilizer' +
        (!ready ? ' <small class="dim">(ready in ' + ticks(Math.min.apply(null, stab)) + ')</small>' : tt && (tt.stabilized || tt.private) ? ' <small class="dim">(not needed here)</small>' : '') + '</span></label>';
      if (d.stabilize) h += '<div class="note warn" style="font-size:11px">Can\'t be recalled. Cooldown ' + ticks(sh.stabilizerCooldown) + '.</div>';
    }
    if (sh.linkKits) {
      d.links = Math.max(0, Math.min(d.links || 0, sh.linkKitsFree));
      h += '<div class="orow"><span style="flex:1">Territory link kits <small class="dim">(' + sh.linkKitsFree + ' of ' + sh.linkKits + ' free)</small></span>' + num('deploy-links', d.links || 0) + '</div>';
    }
    return h + '<div class="actions"><button class="btn primary" data-orbit="deploy-go">Launch dropship</button><button class="btn" data-orbit="deploy-cancel">Cancel</button></div></div>';
  }

  function territoryRow(t) {
    var a = t.anomaly, r = t.resources;
    return '<div class="terr' + (t.taken && !t.open ? ' taken' : '') + (t.private ? ' private' : t.stabilized ? ' stabilized' : '') + '"><div class="top"><b>' + esc(t.name) + '</b><span class="' + (t.ticksLeft < 300 ? 'warn' : 'dim') + '">' + ticks(t.ticksLeft) + (t.destabilized ? ' · destabilised' : '') + '</span></div>' +
      (t.private ? '<div class="data-tag">' + H.icon('check', 12) + ' Private</div>' : t.stabilized ? '<div class="data-tag">' + H.icon('check', 12) + ' Stabilised</div>' : '') +
      '<div class="dim" style="font-size:11px"><b>' + esc(a.name) + '</b>: ' + esc(a.desc) + '</div>' +
      '<div class="io" style="margin-top:4px">' + H.pill(r.common1, 'common') + H.pill(r.common2, 'common') + H.pill(r.district, 'district') + H.pill(r.rare, 'rare', 'out') + '</div>' + (t.dataSite ? '<div class="data-tag">' + H.icon('t_data', 12) + ' Data site: Data Recovery can be built here</div>' : '') +
      '<div class="dim" style="font-size:11px;margin-top:4px">Rare yield ×' + a.rareMult + (a.powerMult && a.powerMult < 1 ? ' · ship power ×' + a.powerMult : '') + ' · leaving late ' + a.lateDamage + '% damage' + (a.damagePerTick ? ' · ' + a.damagePerTick + '% damage every tick on the ground' : '') + '</div>' +
      (t.taken ? '<div class="' + (t.taken.mine ? 'good' : t.open ? 'dim' : 'warn') + '" style="font-size:12px;margin-top:4px">' + (t.taken.mine ? 'Your dropship is here' : esc(t.taken.station || 'Another station') + ' is down there' + (t.open ? ', and there is room for you too' : '')) + '</div>' : '') + '</div>';
  }

  function territoriesPane() {
    var sh = O().ships, h = '';
    h += '<div class="label sec">Dropships · ' + sh.ships.length + ' of ' + sh.max + '</div>';
    if (draft.deploy) h += deployForm();
    h += sh.ships.map(function (s) { return shipCard(s, sh.territories); }).join('');
    if (sh.ships.length < sh.max) h += '<div class="optcard"><div class="top"><b>Build a dropship</b><span class="dim">' + ticks(sh.buildTicks) + '</span></div>' + costLine(sh.buildCost, stationAmounts()) + '<div class="actions"><button class="btn" data-orbit="ship-build">Build</button></div></div>';
    h += '<div class="label sec">Anomalous territories</div><div class="dim" style="font-size:11px;margin-bottom:6px">Shared by every station. Leaving early shortens it for the next visitor.</div>';
    h += sh.territories.map(territoryRow).join('') || '<div class="dim">None open.</div>';
    return h;
  }

  function territoryPane(d) {
    var sh = O().ships, s = sh.ships.filter(function (x) { return x.districtId === d.id; })[0];
    if (!s) return '<div class="empty-state">This territory has been left.</div>';
    var t = s.territory, inv = S().views[d.id].resources, st = O().station;
    var h = '<div class="p-title" style="--c:#f2a7ff">' + H.icon('ship', 22) + '<h3>' + esc(t.name) + '</h3></div>' + territoryRow(t) +
      '<dl class="kv"><dt>Dropship</dt><dd>' + s.num + ' · L' + s.level + ' · integrity ' + s.integrity + '%</dd><dt>Power</dt><dd>' + s.power + ' from the dropship</dd><dt>Hold</dt><dd>' + fmt(s.hold) + ' in all</dd></dl>';
    h += '<div class="label sec">Bring back</div><div class="dim" style="font-size:11px;margin-bottom:6px">Ticked goods come home, rare first, up to the hold · ' + ticks(sh.returnTicks) + '</div>';
    h += Object.keys(inv).filter(function (r) { return inv[r].amount >= 1 || r === t.resources.rare || r === t.resources.district; }).map(function (r) {
      var on = !!(s.plan && s.plan[r]);
      return '<label class="orow"><input type="checkbox" data-osel="plan" data-res="' + r + '"' + (on ? ' checked' : '') + '> <span style="flex:1">' + esc(rn(r)) + '</span><span class="num">' + fmt(inv[r].amount) + '</span></label>';
    }).join('');
    h += '<div class="actions"><button class="btn primary" data-orbit="recall" data-ship="' + s.id + '">' + (isArmed('r' + s.id) ? 'Confirm: fly back?' : 'Fly back now') + '</button></div>';
    // links to the station
    var links = S().routes.filter(function (r) { return r.fromDistrict === d.id || r.toDistrict === d.id; });
    h += '<div class="label sec">Links to the station · ' + links.length + ' of ' + s.maxLinks + '</div>';
    h += links.map(function (l) {
      var up = l.toDistrict === st.districtId;
      return '<div class="oslot link"><span>' + (up ? '↑ up' : '↓ down') + '</span><b>' + esc(rn(l.resource)) + '</b><span class="num">' + l.rate + '<small>/t</small></span><button class="btn" data-orbit="tlink-off" data-from="' + l.fromDistrict + '" data-to="' + l.toDistrict + '" data-res="' + l.resource + '">Remove</button></div>';
    }).join('');
    if (links.length < s.maxLinks) {
      var tl = draft.tlink || (draft.tlink = { dir: 'up', res: t.resources.district, rate: Math.min(10, s.linkRate) });
      var from = tl.dir === 'up' ? inv : stationInv();
      var opts = Object.keys(C().resources).filter(function (r) { return !C().resources[r].rare && from[r] && from[r].amount >= 1; });
      if (opts.indexOf(tl.res) < 0) tl.res = opts[0];
      if (opts.length) {
        h += '<div class="orow">' + sel('tlink-dir', [['up', 'Territory → station'], ['down', 'Station → territory']], tl.dir) + sel('tlink-res', opts.map(function (r) { return [r, rn(r)]; }), tl.res) + num('tlink-rate', tl.rate) + '</div>' +
          '<div class="actions"><button class="btn" data-orbit="tlink-add" data-terr="' + d.id + '">Add link (max ' + s.linkRate + '/t)</button></div>';
      }
    }
    return h;
  }

  function marketPane() {
    var m = O().market, d = draft.market;
    if (!d.res || !m.goods.some(function (g) { return g.resource === d.res; })) d.res = m.goods[0].resource;
    var g = m.goods.filter(function (x) { return x.resource === d.res; })[0];
    if (d.price === null) d.price = g.reference;
    var inv = stationInv();
    var row = function (o) { return '<tr class="' + (o.mine ? 'mine' : '') + '"><td>' + esc(o.maker ? 'Market maker' : o.station) + '</td><td class="num">' + o.price.toFixed(2) + '</td><td class="num">' + fmt(o.qty) + '</td></tr>'; };
    var h = H.brokerage() + '<div class="label sec">Orbital market</div><div class="dim" style="font-size:11px;margin-bottom:6px">Trade goods from orbital storage · makers refresh in ' + ticks(m.nextRefresh) + ' · ' + Math.round(m.feeRate * 100) + '% seller fee</div>' +
      '<div class="orow">' + sel('mkt-res', m.goods.map(function (x) { return [x.resource, rn(x.resource) + (x.orbitalOnly ? ' ✦' : '')]; }), d.res) + '</div>' +
      '<dl class="kv"><dt>Reference</dt><dd>' + g.reference.toFixed(2) + ' cr</dd><dt>Accepted range</dt><dd>' + g.band[0].toFixed(2) + ' to ' + g.band[1].toFixed(2) + ' cr</dd><dt>In storage</dt><dd>' + fmt(inv[d.res] ? inv[d.res].amount : 0) + '</dd></dl>' +
      '<div class="obook"><div><div class="label">Bids</div><table>' + (g.bids.map(row).join('') || '<tr><td class="dim">none</td></tr>') + '</table></div>' +
      '<div><div class="label">Asks</div><table>' + (g.asks.map(row).join('') || '<tr><td class="dim">none</td></tr>') + '</table></div></div>' +
      '<div class="label sec">Post an order</div><div class="orow">' + sel('mkt-side', [['buy', 'Buy'], ['sell', 'Sell']], d.side) + num('mkt-qty', d.qty) + '<span class="dim">at</span>' + num('mkt-price', d.price) + '<span class="dim">cr</span></div>' +
      '<div class="orow">' + sel('mkt-ttl', m.ttlOptions.map(function (t) { return [t, 'Lasts ' + t + ' ticks']; }), d.ttl) + '</div>' +
      '<div class="actions"><button class="btn primary" data-orbit="mkt-post">' + (d.side === 'buy' ? 'Buy' : 'Sell') + ' ' + fmt(d.qty) + ' for ' + fmt(d.qty * d.price) + ' cr</button></div>';
    if (m.orders.length) {
      h += '<div class="label sec">Your orders</div>' + m.orders.map(function (o) {
        return '<div class="oslot"><span>' + o.side + '</span><b>' + esc(rn(o.resource)) + '</b><span class="num">' + fmt(o.remaining) + ' / ' + fmt(o.qty) + ' @ ' + o.price.toFixed(2) + '<small> · ' + o.ticksLeft + 't</small></span><button class="btn" data-orbit="mkt-cancel" data-id="' + o.id + '">Cancel</button></div>';
      }).join('');
    }
    if (m.trades.length) {
      h += '<div class="label sec">Recent trades</div><table class="trades">' + m.trades.slice(0, 10).map(function (t) {
        return '<tr><td>#' + t.tick + '</td><td>' + esc(rn(t.resource)) + '</td><td class="num">' + fmt(t.qty) + ' @ ' + t.price.toFixed(2) + '</td><td class="dim">' + esc(t.seller) + ' → ' + esc(t.buyer) + '</td></tr>';
      }).join('') + '</table>';
    }
    return h;
  }

  function projectPane() {
    var p = O().project;
    if (!p) return '<div class="empty-state">No global project yet.</div>';
    var faction = p.faction && C().missions.factions[p.faction] ? C().missions.factions[p.faction].name : null;
    var phase = { announced: 'Announced', active: 'Taking contributions', bonus: 'Complete: bonus running', done: 'Finished', failed: 'Closed unfinished' }[p.status];
    var timer = p.status === 'announced' ? 'Opens in ' + ticks(p.startsIn) : p.status === 'active' ? 'Closes in ' + ticks(p.endsIn) : p.status === 'bonus' ? 'Bonus for ' + ticks(p.bonusLeft) + ' more' : '';
    var h = '<div class="p-title" style="--c:#9ff0d0">' + H.icon('globe', 22) + '<h3>' + esc(p.name) + '</h3></div><p class="p-desc">' + esc(p.desc) + '</p>' +
      '<dl class="kv"><dt>Status</dt><dd>' + phase + '</dd>' + (timer ? '<dt>Time</dt><dd>' + timer + '</dd>' : '') +
      '<dt>Reward</dt><dd>' + esc(p.bonus.label) + (p.drip ? ' (' + esc(rn(p.drip)) + ')' : '') + (faction ? ' · +' + p.standingReward + ' standing with the ' + esc(faction) + ' for everyone' : '') + '</dd>' +
      (p.status !== 'announced' ? '<dt>Stations counted</dt><dd>' + p.players + '</dd>' : '') + '</dl>';
    h += '<div class="label sec">' + (p.status === 'announced' ? 'Each station\'s share' : 'Needs') + '</div>' + Object.keys(p.needs).map(function (r) {
      var got = p.contributed[r] || 0, need = p.needs[r];
      return '<div class="need"><div class="top"><b>' + esc(rn(r)) + '</b><span class="num">' + fmt(got) + ' / ' + fmt(need) + (p.mine[r] ? ' <small class="good">(you ' + fmt(p.mine[r]) + ')</small>' : '') + '</span></div>' + bar(got, need, got >= need ? 'good' : '') + '</div>';
    }).join('');
    if (p.status === 'active') {
      var docked = O().ships.ships.filter(function (s) { return s.state === 'docked' && s.integrity > 0; });
      var inv = stationInv();
      if (!draft.contrib || !docked.some(function (s) { return s.id === draft.contrib.ship; })) draft.contrib = docked.length ? { ship: docked[0].id, cargo: {} } : null;
      if (draft.contrib) {
        var c = draft.contrib, s = docked.filter(function (x) { return x.id === c.ship; })[0];
        h += '<div class="label sec">Contribute</div><div class="dim" style="font-size:11px;margin-bottom:6px">By dropship from orbital storage · ' + ticks(O().ships.contributeTicks) + ' · delivered halfway</div>' +
          '<div class="orow">' + sel('contrib-ship', docked.map(function (x) { return [x.id, 'Dropship ' + x.num + ' (hold ' + x.hold + ')']; }), c.ship) + '</div>' +
          Object.keys(p.needs).map(function (r) {
            return '<div class="orow"><span style="flex:1">' + esc(rn(r)) + ' <small class="dim">(' + fmt(inv[r] ? inv[r].amount : 0) + ' in storage)</small></span>' + num('contrib', c.cargo[r] || 0, 'data-res="' + r + '"') + '</div>';
          }).join('') + '<div class="actions"><button class="btn primary" data-orbit="contrib-go">Send dropship ' + s.num + '</button></div>';
      } else h += '<div class="dim" style="font-size:12px;margin-top:8px">No dropship is docked and ready to carry a contribution.</div>';
    }
    if (p.next && p.status !== 'announced') h += '<div class="dim" style="font-size:11px;margin-top:10px">Next in the rotation: ' + esc(p.next.name) + '.</div>';
    return h;
  }

  // ---------------------------------------------------------------- left pane in orbit
  function sideHtml() {
    var d = H.activeD(), v = S().views[d.id];
    if (d.type === 'station') {
      var st = O().station;
      return '<h2 class="label">Orbital storage</h2>' + st.storage.slots.map(function (s) {
        if (!s.resource) return '<div class="res"><div class="row"><span class="nm dim">' + (s.state === 'jettisoned' ? 'Jettisoned slot' : 'Empty slot') + '</span></div></div>';
        var r = v.resources[s.resource], def = C().resources[s.resource];
        return '<div class="res"><div class="row"><span class="dot" style="background:' + def.color + '"></span><span class="nm">' + esc(def.name) + '</span><span class="amt num">' + fmt(r.amount) + '</span></div>' +
          '<div class="sub"><span class="num ' + (r.net > 0.05 ? 'good' : r.net < -0.05 ? 'bad' : '') + '">' + (Math.abs(r.net) < 0.05 ? '±0' : (r.net > 0 ? '+' : '−') + Math.abs(r.net).toFixed(1)) + '/t</span><span class="dim">cap ' + fmt(s.kind === 'hc' ? st.storage.hcCap : st.storage.cap) + '</span></div>' +
          '<div class="bar"><i style="width:' + Math.min(100, r.amount / (s.kind === 'hc' ? st.storage.hcCap : st.storage.cap) * 100).toFixed(1) + '%;background:' + def.color + '"></i></div></div>';
      }).join('');
    }
    var h = '<h2 class="label">Territory stock</h2>';
    Object.keys(v.resources).forEach(function (k) {
      var r = v.resources[k], def = C().resources[k];
      if (r.amount < 0.5 && r.produced <= 0 && r.consumed <= 0) return;
      h += '<div class="res"><div class="row"><span class="dot" style="background:' + def.color + '"></span><span class="nm">' + esc(def.name) + '</span><span class="amt num">' + fmt(r.amount) + '</span></div>' +
        '<div class="sub"><span class="num ' + (r.net > 0.05 ? 'good' : r.net < -0.05 ? 'bad' : '') + '">' + (Math.abs(r.net) < 0.05 ? '±0' : (r.net > 0 ? '+' : '−') + Math.abs(r.net).toFixed(1)) + '/t</span><span class="dim">cap ' + fmt(r.cap) + '</span></div></div>';
    });
    return h;
  }

  // ---------------------------------------------------------------- input
  function onClick(e) {
    var el = e.target.closest && e.target.closest('[data-orbit]');
    if (!el || el.disabled) return;
    var a = el.dataset.orbit, act = H.act;
    if (a === 'cycle') act('launch-cycle', { cycle: el.dataset.cycle || null });
    else if (a === 'launch') {
      var nm = document.getElementById('station-name');
      if (nm) draft.name = nm.value;
      act('launch', { name: draft.name }).then(function (d) { if (d && d.ok) H.toast('Launch!', true); });
    } else if (a === 'enter-orbit') H.enterOrbit();
    else if (a === 'express') act('express-launch', { resource: draft.express.res, qty: draft.express.qty, dir: draft.express.dir }, draft.express.dir === 'down' ? 'Capsule away.' : 'Express launch away.');
    else if (a === 'jettison') {
      if (confirmClick('j' + el.dataset.slot)) act('jettison', { slot: +el.dataset.slot });
    } else if (a === 'rebuild') act('rebuild-slot', { slot: +el.dataset.slot });
    else if (a === 'slot-move') act('orbit-slot-move', { resource: el.dataset.res, to: el.dataset.to });
    else if (a === 'slot-release') act('orbit-slot-release', { slot: +el.dataset.slot });
    else if (a === 'ship-refit') act('hq-refit', { ship: +el.dataset.ship }, 'Refitted to level 4.');
    else if (a === 'storage-up') act('orbit-storage', {});
    else if (a === 'links-up') act('orbit-links', {});
    else if (a === 'link-add') {
      var st = O().station, core = S().districts.filter(function (x) { return x.core; })[0].id;
      act('route', { from: draft.link.dir === 'up' ? core : st.districtId, to: draft.link.dir === 'up' ? st.districtId : core, resource: draft.link.res, rate: draft.link.rate, reserve: 0 });
    } else if (a === 'link-off') {
      var st2 = O().station, core2 = S().districts.filter(function (x) { return x.core; })[0].id, up = el.dataset.dir === 'up';
      act('route', { from: up ? core2 : st2.districtId, to: up ? st2.districtId : core2, resource: el.dataset.res, rate: 0 });
    } else if (a === 'tlink-add') {
      var tid = +el.dataset.terr, sid = O().station.districtId, tl = draft.tlink;
      act('route', { from: tl.dir === 'up' ? tid : sid, to: tl.dir === 'up' ? sid : tid, resource: tl.res, rate: tl.rate, reserve: 0 });
    } else if (a === 'tlink-off') act('route', { from: +el.dataset.from, to: +el.dataset.to, resource: el.dataset.res, rate: 0 });
    else if (a === 'ship-build') act('ship-build', {}, 'Dropship under construction.');
    else if (a === 'ship-up') act('ship-upgrade', { ship: +el.dataset.ship });
    else if (a === 'repair') act('ship-repair', { ship: +el.dataset.ship });
    else if (a === 'deploy-start') { draft.deploy = { ship: +el.dataset.ship, territory: null, preload: {}, stabilize: false, links: 0 }; H.redraw(); }
    else if (a === 'deploy-cancel') { draft.deploy = null; H.redraw(); }
    else if (a === 'deploy-go') {
      var dp = draft.deploy;
      act('ship-deploy', { ship: dp.ship, territory: dp.territory, preload: dp.preload, stabilize: !!dp.stabilize, links: dp.links || 0 }, 'Dropship away.').then(function (d) { if (d && d.ok) { draft.deploy = null; H.redraw(); } });
    } else if (a === 'recall') { if (confirmClick('r' + el.dataset.ship)) act('ship-return', { ship: +el.dataset.ship }, 'The dropship is flying home.'); }
    else if (a === 'view') H.enter(+el.dataset.id);
    else if (a === 'mkt-post') { var m = draft.market; act('orbit-market', { resource: m.res, side: m.side, price: m.price, qty: m.qty, ttl: m.ttl }); }
    else if (a === 'mkt-cancel') act('orbit-market-cancel', { orderId: +el.dataset.id });
    else if (a === 'contrib-go') act('project-contribute', { ship: draft.contrib.ship, cargo: draft.contrib.cargo }, 'Contribution on its way.').then(function (d) { if (d && d.ok) { draft.contrib = null; H.redraw(); } });
  }
  function onChange(e) {
    var t = e.target, v;
    if (t.dataset && t.dataset.onum) {
      v = parseFloat(String(t.value).replace(',', '.'));
      if (!isFinite(v)) { H.redraw(); return; }
      var k = t.dataset.onum, n = Math.max(0, Math.round(v));
      if (k === 'express-qty') draft.express.qty = Math.max(1, Math.min(O().station.express.maxQty, n));
      else if (k === 'link-new') draft.link.rate = Math.max(1, n);
      else if (k === 'link-rate') {
        var st = O().station, core = S().districts.filter(function (x) { return x.core; })[0].id, up = t.dataset.dir === 'up';
        H.act('route', { from: up ? core : st.districtId, to: up ? st.districtId : core, resource: t.dataset.res, rate: n, reserve: 0 });
      } else if (k === 'tlink-rate') draft.tlink.rate = Math.max(1, n);
      else if (k === 'deploy-links') draft.deploy.links = n;
      else if (k === 'preload') { if (n) draft.deploy.preload[t.dataset.res] = n; else delete draft.deploy.preload[t.dataset.res]; }
      else if (k === 'mkt-qty') draft.market.qty = Math.max(1, n);
      else if (k === 'mkt-price') draft.market.price = Math.max(0.01, Math.round(v * 100) / 100);
      else if (k === 'contrib') { if (n) draft.contrib.cargo[t.dataset.res] = n; else delete draft.contrib.cargo[t.dataset.res]; }
      H.redraw();
      return;
    }
    var s = t.closest && t.closest('[data-osel]');
    if (!s) return;
    var key = s.dataset.osel;
    if (key === 'express-res') draft.express.res = s.value;
    else if (key === 'express-dir') draft.express.dir = s.value === 'down' ? 'down' : 'up';
    else if (key === 'link-dir') draft.link.dir = s.value;
    else if (key === 'link-res') draft.link.res = s.value;
    else if (key === 'tlink-dir') draft.tlink.dir = s.value;
    else if (key === 'tlink-res') draft.tlink.res = s.value;
    else if (key === 'deploy-terr') draft.deploy.territory = +s.value;
    else if (key === 'deploy-stab') draft.deploy.stabilize = !!s.checked;
    else if (key === 'mkt-res') { draft.market.res = s.value; draft.market.price = null; }
    else if (key === 'mkt-side') draft.market.side = s.value;
    else if (key === 'mkt-ttl') draft.market.ttl = +s.value;
    else if (key === 'contrib-ship') draft.contrib = { ship: +s.value, cargo: {} };
    else if (key === 'plan') {
      var d = H.activeD(), ship = O().ships.ships.filter(function (x) { return x.districtId === d.id; })[0];
      var plan = Object.assign({}, ship.plan || {});
      if (s.checked) plan[s.dataset.res] = true; else delete plan[s.dataset.res];
      H.act('ship-plan', { ship: ship.id, plan: plan });
      return;
    }
    H.redraw();
  }

  window.Orbit = {
    init: init, launchCard: launchCard, panes: { oplace: placePane, ostore: storePane, oterr: territoriesPane, omarket: marketPane, oproject: projectPane }, sideHtml: sideHtml,
    drafts: draft
  };
})();
