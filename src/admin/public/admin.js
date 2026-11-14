// The admin panel's client: one page, hash routes (#/users/12), every view drawn from the panel's JSON API. Clicks on
// [data-act] and submits of form[data-form] are handled in one place each (the page's CSP allows no inline handlers).
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return s === null || s === undefined ? '' : String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var me = null;
  var ACT = {};
  var FORM = {};
  var state = { users: { q: '', kind: 'player', filter: '', page: 0 }, colonies: { phase: 'parked', q: '' }, market: { kind: 'ground', resource: '' }, logs: { tab: 'server', level: '', category: '', q: '', userId: '' }, tele: { days: 7, bot: '', ev: '' } };

  // ---------------------------------------------------------------- helpers
  function api(method, path, body) {
    return fetch('/api' + path, { method: method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'Bad answer (' + r.status + ').' }; }).then(function (d) {
          if (r.status === 401 && path !== '/login') { showLogin(); }
          if (!d.ok) { var e = new Error(d.error || 'Failed.'); e.data = d; e.status = r.status; throw e; }
          return d;
        });
      });
  }
  var get = function (p) { return api('GET', p); };
  var post = function (p, b) { return api('POST', p, b || {}); };
  var toastTimer = null;
  function toast(msg, bad) {
    var t = $('toast');
    t.textContent = msg; t.className = 'toast on' + (bad ? ' bad' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = 'toast'; }, bad ? 6000 : 3000);
  }
  var fail = function (e) { toast(e.message || 'Failed.', true); };
  var pad = function (n) { return n < 10 ? '0' + n : String(n); };
  function date(ms) { if (!ms) return '—'; var d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function ago(ms) {
    if (!ms) return '—';
    var s = Math.round((Date.now() - ms) / 1000), f = s < 0 ? 'in ' : '', a = Math.abs(s);
    var t = a < 90 ? a + 's' : a < 5400 ? Math.round(a / 60) + 'm' : a < 172800 ? Math.round(a / 3600) + 'h' : Math.round(a / 86400) + 'd';
    return s < 0 ? f + t : t + ' ago';
  }
  function dur(ms) { var h = Math.floor(ms / 3600000); return h >= 48 ? Math.floor(h / 24) + 'd ' + (h % 24) + 'h' : h + 'h ' + Math.floor(ms / 60000) % 60 + 'm'; }
  function bytes(n) { return n > 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' kB'; }
  function num(x) { return x === null || x === undefined ? '—' : Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
  function pill(text, kind) { return '<span class="pill ' + (kind || '') + '">' + esc(text) + '</span>'; }
  function stat(k, v, s) { return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div>' + (s ? '<div class="s">' + s + '</div>' : '') + '</div>'; }
  function table(cols, rows, opts) {
    opts = opts || {};
    if (!rows.length) return '<p class="dim">' + esc(opts.empty || 'Nothing.') + '</p>';
    return '<div class="tablewrap"><table><thead><tr>' + cols.map(function (c) { return '<th' + (c.num ? ' class="num"' : '') + '>' + esc(c.h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr' + (opts.click ? ' class="click" data-act="' + opts.click + '" data-id="' + esc(r.id) + '"' : '') + '>' + cols.map(function (c) { return '<td' + (c.num ? ' class="num"' : c.wrap ? ' class="wrap"' : '') + '>' + c.v(r) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
  }
  function formData(form) {
    var o = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name) return;
      if (el.type === 'checkbox') { if (el.dataset.multi) { o[el.name] = o[el.name] || []; if (el.checked) o[el.name].push(el.value); } else o[el.name] = el.checked; } else o[el.name] = el.value;
    });
    return o;
  }
  var can = function () { return me && me.role === 'admin'; };
  var dis = function () { return can() ? '' : ' disabled'; };
  var qs = function (o) { return Object.keys(o).filter(function (k) { return o[k] !== '' && o[k] !== null && o[k] !== undefined; }).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&'); };
  function main(html) { $('main').innerHTML = html; }

  // ---------------------------------------------------------------- sign-in
  function showLogin() { $('app').hidden = true; $('login').hidden = false; }
  function showApp() {
    $('login').hidden = true; $('app').hidden = false;
    $('me').innerHTML = esc(me.username) + ' · ' + esc(me.role) + (me.totp ? '' : ' · <span class="warn">no 2FA</span>') + '<br><a href="#" data-act="logout">Sign out</a>';
    route();
  }
  $('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var d = formData(e.target);
    $('login-err').textContent = '';
    post('/login', d).then(function (r) { me = r.me; e.target.reset(); $('totp-field').hidden = true; showApp(); if (r.totpMissing) toast('No authenticator code is set up for this account. Account → Two-factor.', true); })
      .catch(function (err) { if (err.data && err.data.totp) { $('totp-field').hidden = false; $('totp-field').querySelector('input').focus(); } $('login-err').textContent = err.message; });
  });
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el || !ACT[el.dataset.act]) return;
    if (el.tagName === 'A' || el.tagName === 'TR' || el.tagName === 'BUTTON') e.preventDefault();
    try { var p = ACT[el.dataset.act](el, e); if (p && p.catch) p.catch(fail); } catch (err) { fail(err); }
  });
  document.addEventListener('submit', function (e) {
    var f = e.target.closest('form[data-form]');
    if (!f || !FORM[f.dataset.form]) return;
    e.preventDefault();
    var p = FORM[f.dataset.form](formData(f), f);
    if (p && p.catch) p.catch(fail);
  });
  document.addEventListener('change', function (e) {
    var el = e.target.closest('[data-change]');
    if (el && ACT[el.dataset.change]) { var p = ACT[el.dataset.change](el, e); if (p && p.catch) p.catch(fail); }
  });
  ACT.logout = function () { return post('/logout').then(function () { me = null; showLogin(); }); };

  // ---------------------------------------------------------------- routing
  var VIEWS = {};
  function route() {
    if (!me) return;
    var parts = (location.hash.replace(/^#\/?/, '') || 'overview').split('/');
    var v = VIEWS[parts[0]] ? parts[0] : 'overview';
    Array.prototype.forEach.call(document.querySelectorAll('.side a'), function (a) { a.classList.toggle('on', a.dataset.r === v); });
    main('<p class="dim">Loading…</p>');
    Promise.resolve(VIEWS[v](parts.slice(1))).catch(function (e) { main('<div class="banner bad">' + esc(e.message) + '</div>'); });
  }
  window.addEventListener('hashchange', route);
  var reload = function () { route(); };
  ACT.reload = reload;

  // ---------------------------------------------------------------- overview
  VIEWS.overview = function () {
    return get('/overview').then(function (d) {
      var s = d.server, p = d.players, c = d.colonies, b = d.bots, m = d.market, bk = d.backups;
      var banners = '';
      if (s.maintenance) banners += '<div class="banner">Maintenance mode is on' + (s.maintenance.message ? ': ' + esc(s.maintenance.message) : '') + '.</div>';
      if (s.hold) banners += '<div class="banner">' + (s.hold.reason === 'admin' ? 'The simulation is paused by an admin; players cannot act.' : 'The simulation is idle: no player is active, so nothing ticks and the bots wait.') + ' Since ' + date(s.hold.since) + '.</div>';
      if (bk.pendingRestore) banners += '<div class="banner bad">A full restore is waiting for the next start: ' + esc(bk.pendingRestore.from) + '</div>';
      if (m.frozen.ground || m.frozen.orbit) banners += '<div class="banner">Frozen: ' + [m.frozen.ground ? 'exchange' : '', m.frozen.orbit ? 'orbital market' : ''].filter(Boolean).join(', ') + '.</div>';
      var maxS = Math.max.apply(null, [1].concat(d.signups.map(function (x) { return x.n; })));
      main('<h1>Overview</h1>' + banners +
        '<div class="grid">' +
        stat('Tick', num(s.tick), (s.tickMs / 1000) + ' s per tick · last ' + ago(s.lastTickAt)) +
        stat('Connected', num(s.playersConnected || 0), num(s.streams || 0) + ' live streams') +
        stat('Players', num(p.total), num(p.verified) + ' verified · ' + num(p.unverified) + ' not') +
        stat('Active 24 h', num(p.active24h), num(p.signedIn24h) + ' signed in') +
        stat('New 7 d', num(p.new7d), num(p.banned) + ' suspended') +
        stat('Colonies', num(c.total), c.live + ' live · ' + c.stewarded + ' stewarded · ' + c.parked + ' parked') +
        stat('Stations', num(c.stations), 'shut down: ' + c.shutdown) +
        stat('Bots', num(b.accounts), !b.api ? 'API off' : b.paused ? '<span class="warn">paused</span>' : b.runnerSeen ? 'runner ' + ago(b.runnerSeen) + (b.waiting !== null ? ' · ' + b.waiting + ' slots free' : '') : '<span class="warn">runner not seen</span>') +
        stat('Trades 24 h', num(m.groundTrades24h + m.orbitTrades24h), m.groundTrades24h + ' ground · ' + m.orbitTrades24h + ' orbit') +
        stat('Last backup', bk.lastAuto ? ago(bk.lastAuto) : '<span class="warn">none</span>', bk.count + ' on disk · every ' + bk.settings.hours + ' h') +
        stat('Database', bytes(s.dbSize), 'up ' + dur(s.uptime) + ' · ' + esc(s.node)) +
        '</div>' +
        '<div class="cols"><div class="card"><h2>Sign-ups, 30 days</h2>' + (d.signups.length ? '<div class="bars">' + d.signups.map(function (x) { return '<i title="' + esc(x.day + ': ' + x.n) + '" style="height:' + Math.max(4, Math.round(x.n / maxS * 100)) + '%"></i>'; }).join('') + '</div>' : '<p class="dim">None.</p>') + '</div>' +
        '<div class="card"><h2>Recent errors</h2>' + table([{ h: 'When', v: function (r) { return ago(r.at); } }, { h: 'Where', v: function (r) { return esc(r.category); } }, { h: 'Message', wrap: 1, v: function (r) { return esc(r.message); } }], d.recentErrors, { empty: 'No errors.' }) + '</div></div>');
    });
  };

  // ---------------------------------------------------------------- users
  function userFlags(u) {
    var f = [];
    if (u.kind !== 'player') f.push(pill(u.kind === 'bot' ? 'bot · ' + u.profile : 'generated', 'accent'));
    if (u.banned) f.push(pill('suspended', 'bad'));
    if (u.kind === 'player' && !u.verified) f.push(pill(u.email ? 'unverified' : 'no email', 'warn'));
    if (u.totp) f.push(pill('2FA', 'good'));
    return f.join(' ');
  }
  function colonyCell(c) { return c ? 'hub ' + c.hub + ' · pop ' + c.population + ' · ' + pill(c.phase, c.phase === 'live' ? 'good' : c.phase === 'parked' ? 'warn' : '') + (c.shutdown ? ' ' + pill('shut down', 'bad') : '') : '<span class="faint">none</span>'; }
  VIEWS.users = function (rest) {
    if (rest[0]) return userDetail(Number(rest[0]));
    var s = state.users;
    return get('/users?' + qs({ q: s.q, kind: s.kind, filter: s.filter, page: s.page })).then(function (d) {
      main('<h1>Users</h1><div class="card"><form class="row" data-form="usersearch">' +
        '<input class="grow" name="q" placeholder="Callsign, email, address or #id" value="' + esc(s.q) + '">' +
        '<select name="kind">' + ['player', 'bot', 'generated', 'all'].map(function (k) { return '<option' + (s.kind === k ? ' selected' : '') + '>' + k + '</option>'; }).join('') + '</select>' +
        '<select name="filter"><option value="">any</option>' + ['banned', 'unverified', 'recent'].map(function (k) { return '<option' + (s.filter === k ? ' selected' : '') + '>' + k + '</option>'; }).join('') + '</select>' +
        '<button class="btn primary">Search</button></form></div>' +
        '<div class="card"><div class="row" style="justify-content:space-between"><h2>' + num(d.total) + ' accounts</h2><span class="row">' +
        (s.page > 0 ? '<button class="btn small" data-act="upage" data-d="-1">‹ Newer</button>' : '') + ((s.page + 1) * 50 < d.total ? '<button class="btn small" data-act="upage" data-d="1">Older ›</button>' : '') + '</span></div>' +
        table([
          { h: '#', v: function (u) { return u.id; } },
          { h: 'Callsign', v: function (u) { return esc(u.username) + ' ' + userFlags(u); } },
          { h: 'Email', v: function (u) { return esc(u.email || ''); } },
          { h: 'Colony', v: function (u) { return colonyCell(u.colony); } },
          { h: 'Joined', v: function (u) { return date(u.createdAt); } },
          { h: 'Last sign-in', v: function (u) { return ago(u.lastLoginAt) + (u.lastIp ? ' <span class="faint">' + esc(u.lastIp) + '</span>' : ''); } },
        ], d.users, { click: 'openuser', empty: 'No accounts match.' }) + '</div>' +
        (can() ? '<div class="card"><h2>New account</h2><form class="row" data-form="usercreate"><input name="username" placeholder="Callsign" required><input name="email" placeholder="Email (optional)"><input name="password" type="password" placeholder="Passcode" required autocomplete="new-password"><label><input type="checkbox" name="verified" checked> verified</label><button class="btn">Create</button></form></div>' : ''));
    });
  };
  FORM.usersearch = function (d) { Object.assign(state.users, { q: d.q, kind: d.kind, filter: d.filter, page: 0 }); reload(); };
  ACT.upage = function (el) { state.users.page = Math.max(0, state.users.page + Number(el.dataset.d)); reload(); };
  ACT.openuser = function (el) { location.hash = '#/users/' + el.dataset.id; };
  FORM.usercreate = function (d) { return post('/users', d).then(function (r) { toast('Created.'); location.hash = '#/users/' + r.id; }); };

  var current = null; // the user on screen
  function userDetail(id) {
    return Promise.all([get('/users/' + id), get('/backups').catch(function () { return { backups: [] }; })]).then(function (all) {
      var d = all[0], u = d.user, c = d.colony;
      current = d;
      var acts = can() ? '<div class="row">' +
        (u.kind === 'player' && !u.verified ? '<button class="btn" data-act="uverify">Mark verified</button>' : '') +
        (u.banned ? '<button class="btn" data-act="uunban">Lift suspension</button>' : '') +
        '<button class="btn" data-act="ulogout">Sign out everywhere</button>' +
        (u.email && u.verified ? '<button class="btn" data-act="ureset">Email a reset</button>' : '') +
        (u.totp ? '<button class="btn" data-act="utotpoff">Turn off 2FA</button>' : '') +
        '<button class="btn danger" data-act="udelete">Delete account</button></div>' : '';
      var html = '<h1><a href="#/users">Users</a> / ' + esc(u.username) + ' ' + userFlags(u) + '</h1>' +
        (u.banned ? '<div class="banner bad">Suspended ' + date(u.bannedAt) + (u.banUntil ? ' until ' + date(u.banUntil) : ', no end date') + (u.banReason ? ': ' + esc(u.banReason) : '') + '</div>' : '') +
        '<div class="cols"><div class="card"><h2>Account</h2><div class="kv">' +
        '<div>id</div><div>' + u.id + '</div><div>joined</div><div>' + date(u.createdAt) + (u.createdIp ? ' from ' + esc(u.createdIp) : '') + '</div>' +
        '<div>last sign-in</div><div>' + date(u.lastLoginAt) + (u.lastIp ? ' from ' + esc(u.lastIp) : '') + '</div>' +
        '<div>same address</div><div>' + (d.sameIp.length ? d.sameIp.map(function (x) { return '<a href="#/users/' + x.id + '">' + esc(x.username) + '</a>'; }).join(', ') : '—') + '</div></div>' +
        (can() ? '<form data-form="uupdate" style="margin-top:14px"><label class="field"><span>Callsign</span><input name="username" value="' + esc(u.username) + '"></label>' +
          '<label class="field"><span>Email</span><input name="email" value="' + esc(u.email || '') + '"></label>' +
          '<div class="row" style="margin-bottom:12px"><label><input type="checkbox" name="verified"' + (u.verified ? ' checked' : '') + '> email verified</label></div>' +
          '<label class="field"><span>Admin note</span><textarea name="note">' + esc(u.note || '') + '</textarea></label><button class="btn primary">Save</button></form>' : '') +
        '</div><div class="card"><h2>Actions</h2>' + acts +
        (can() && !u.banned ? '<h3>Suspend</h3><form class="row" data-form="uban"><input class="grow" name="reason" placeholder="Reason (shown to them)"><input name="hours" type="number" min="0" placeholder="Hours (blank: no end)" style="width:170px"><button class="btn danger">Suspend</button></form>' : '') +
        (can() ? '<h3>Passcode</h3><form class="row" data-form="upass"><input class="grow" type="password" name="password" placeholder="New passcode" autocomplete="new-password"><button class="btn">Set</button></form>' : '') + '</div></div>';
      html += '<div class="card"><h2>Colony</h2>' + (c ? '<div class="kv"><div>colony</div><div>#' + c.id + (c.station ? ' · station ' + esc(c.station) : '') + '</div><div>state</div><div>' + colonyCell(c) + (c.noBots ? ' ' + pill('no bots') : '') + '</div>' +
        '<div>credits</div><div>' + num(c.credits) + '</div><div>morale · age</div><div>' + c.morale + ' · ' + num(c.age) + ' ticks</div><div>last active</div><div>' + ago(c.lastActive) + '</div></div>' +
        (can() ? '<h3>Credits</h3><form class="row" data-form="ucredits"><input name="delta" type="number" placeholder="+/- amount" required><input class="grow" name="reason" placeholder="Reason (in their log)"><button class="btn">Apply</button></form>' +
          '<h3>Stock</h3><form class="row" data-form="ustock"><select name="district">' + d.districts.map(function (x) { return '<option value="' + x.id + '">' + esc(x.name) + '</option>'; }).join('') + '</select>' +
          '<input name="resource" placeholder="resource id (e.g. scrap)" required><input name="amount" type="number" min="0" step="any" placeholder="new amount" required><button class="btn">Set</button> <button class="btn small" type="button" data-act="ustockview">Show stock</button></form><div id="stockview"></div>' : '')
        : '<p class="dim">No colony.</p>') +
        (can() ? '<h3>Roll back</h3><div id="rollback"><button class="btn" data-act="ubackups">Find this colony in backups</button></div>' : '') + '</div>';
      html += '<div class="cols"><div class="card"><h2>Colony events</h2>' + table([{ h: 'Tick', num: 1, v: function (e) { return num(e.tick); } }, { h: '', v: function (e) { return pill(e.kind, e.kind === 'bad' ? 'bad' : e.kind === 'warn' ? 'warn' : e.kind === 'good' ? 'good' : ''); } }, { h: 'Message', wrap: 1, v: function (e) { return esc(e.message); } }], d.events, { empty: 'No events.' }) + '</div>' +
        '<div class="card"><h2>Server log</h2>' + table([{ h: 'When', v: function (e) { return date(e.at); } }, { h: '', v: function (e) { return pill(e.category, e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warn' : ''); } }, { h: 'Message', wrap: 1, v: function (e) { return esc(e.message) + (e.ip ? ' <span class="faint">' + esc(e.ip) + '</span>' : ''); } }], d.log, { empty: 'Nothing logged.' }) + '</div></div>';
      main(html);
    });
  }
  var uid = function () { return current.user.id; };
  FORM.uupdate = function (d) { return post('/users/' + uid() + '/update', d).then(function () { toast('Saved.'); reload(); }); };
  FORM.uban = function (d) { return post('/users/' + uid() + '/ban', d).then(function () { toast('Suspended.'); reload(); }); };
  FORM.upass = function (d, f) { return post('/users/' + uid() + '/password', d).then(function (r) { f.reset(); toast('Passcode set; ' + r.sessionsEnded + ' session(s) ended.'); }); };
  FORM.ucredits = function (d) { return post('/colonies/' + current.colony.id + '/credits', d).then(function (r) { toast('Credits now ' + num(r.credits) + '.'); reload(); }); };
  FORM.ustock = function (d) { return post('/colonies/' + current.colony.id + '/stock', d).then(function () { toast('Stock set.'); ACT.ustockview(); }); };
  ACT.ustockview = function () {
    return get('/colonies/' + current.colony.id + '/stock').then(function (r) {
      $('stockview').innerHTML = r.districts.map(function (x) { var inv = Object.keys(x.inventory).filter(function (k) { return x.inventory[k] >= 0.5; }); return '<h3>' + esc(x.name) + '</h3><p class="small">' + (inv.length ? inv.map(function (k) { return esc(k) + ' <b>' + num(Math.floor(x.inventory[k])) + '</b>'; }).join(' · ') : '<span class="faint">empty</span>') + '</p>'; }).join('');
    });
  };
  ACT.uverify = function () { return post('/users/' + uid() + '/verify').then(function () { toast('Verified.'); reload(); }); };
  ACT.utotpoff = function () { if (!confirm('Turn off this player\'s authenticator code?')) return; return post('/users/' + uid() + '/totp-off').then(function () { toast('2FA off.'); reload(); }); };
  ACT.uunban = function () { return post('/users/' + uid() + '/unban').then(function () { toast('Suspension lifted.'); reload(); }); };
  ACT.ulogout = function () { return post('/users/' + uid() + '/logout').then(function (r) { toast(r.sessionsEnded + ' session(s) ended.'); }); };
  ACT.ureset = function () { return post('/users/' + uid() + '/password', { sendReset: true }).then(function (r) { toast('Reset sent to ' + r.sentTo + '.'); }); };
  ACT.udelete = function () {
    var u = current.user, colony = null;
    if (current.colony) {
      colony = prompt('What happens to colony #' + current.colony.id + '? Type "park" (handed to a generated account, bots may take it) or "wipe".', 'park');
      if (colony === null) return;
      if (colony !== 'park' && colony !== 'wipe') return toast('Type park or wipe.', true);
    }
    var c = prompt('Delete ' + u.username + ' for good? Type the callsign to confirm.');
    if (c === null) return;
    return post('/users/' + u.id + '/delete', { confirm: c, colony: colony }).then(function () { toast('Deleted.'); location.hash = '#/users'; });
  };
  ACT.ubackups = function () {
    $('rollback').innerHTML = '<p class="dim">Looking…</p>';
    return get('/users/' + uid() + '/backups').then(function (r) {
      var rows = [];
      r.backups.forEach(function (b) { b.colonies.forEach(function (c) { rows.push({ id: b.backup + '|' + c.id, b: b, c: c }); }); });
      $('rollback').innerHTML = table([
        { h: 'Backup', v: function (x) { return esc(x.b.backup) + ' ' + pill(x.b.kind); } }, { h: 'Taken', v: function (x) { return date(x.b.at); } }, { h: 'Tick', num: 1, v: function (x) { return num(x.b.tick); } },
        { h: 'Colony', v: function (x) { return '#' + x.c.id + ' · hub ' + x.c.hub + ' · pop ' + x.c.population + ' · ' + num(x.c.credits) + ' cr · age ' + num(x.c.age) + (x.c.id !== r.current && r.current ? ' <span class="warn">(not the current colony)</span>' : ''); } },
        { h: '', v: function (x) { return '<button class="btn small danger" data-act="urestore" data-backup="' + esc(x.b.backup) + '" data-colony="' + x.c.id + '">Restore</button>'; } },
      ], rows, { empty: 'No backup holds a colony of this account.' });
    });
  };
  ACT.urestore = function (el) {
    var colony = Number(el.dataset.colony), current_ = current.colony ? current.colony.id : null, other = null;
    if (current_ && current_ !== colony) {
      other = prompt('The account runs colony #' + current_ + ' now. Type "park" to hand it to a generated account, or "wipe" to delete it.', 'park');
      if (other === null) return;
    }
    if (!confirm('Roll colony #' + colony + ' back to ' + el.dataset.backup + '? Everything it did since is lost.')) return;
    return post('/colonies/' + colony + '/restore', { backup: el.dataset.backup, toUserId: uid(), current: other }).then(function (r) {
      toast('Restored (tick ' + r.backupTick + ')' + (r.docked ? ', ' + r.docked + ' dropship(s) docked' : '') + (r.refundCredits ? ', ' + r.refundCredits + ' cr refunded' : '') + '.');
      reload();
    });
  };

  // ---------------------------------------------------------------- colonies
  VIEWS.colonies = function () {
    var s = state.colonies;
    return get('/colonies?' + qs({ phase: s.phase, q: s.q })).then(function (d) {
      main('<h1>Colonies</h1><div class="tabs">' + ['parked', 'stewarded', 'live', 'all'].map(function (p) { return '<button data-act="cphase" data-p="' + p + '" class="' + (s.phase === p ? 'on' : '') + '">' + p + '</button>'; }).join('') + '</div>' +
        '<div class="card"><form class="row" data-form="csearch"><input class="grow" name="q" placeholder="Holder, station or colony #" value="' + esc(s.q) + '"><button class="btn">Search</button></form></div>' +
        '<div class="card"><h2>' + d.colonies.length + ' ' + esc(d.phase) + '</h2>' + table([
          { h: '#', v: function (c) { return c.id; } },
          { h: 'Holder', v: function (c) { return '<a href="#/users/' + c.holderId + '">' + esc(c.holder) + '</a> ' + (c.kind !== 'player' ? pill(c.kind === 'bot' ? 'bot · ' + c.profile : 'generated', 'accent') : '') + (c.noBots ? ' ' + pill('no bots') : ''); } },
          { h: 'State', v: function (c) { return 'hub ' + c.hub + ' · pop ' + c.population + ' · ' + num(c.credits) + ' cr' + (c.shutdown ? ' ' + pill('shut down', 'bad') : '') + (c.station ? ' · ' + esc(c.station) : ''); } },
          { h: 'Phase', v: function (c) { return pill(c.phase, c.phase === 'live' ? 'good' : c.phase === 'parked' ? 'warn' : '') + ' ' + (c.parkedAt ? 'parked ' + ago(c.parkedAt) : 'active ' + ago(c.lastActive)); } },
          { h: '', v: function (c) {
            if (!can()) return '';
            var b = [];
            if (c.phase === 'parked') { b.push('<button class="btn small" data-act="cdo" data-do="unpark" data-id="' + c.id + '">Unpark</button>'); if (c.kind === 'player') b.push('<button class="btn small" data-act="cdo" data-do="handover" data-id="' + c.id + '">To bots</button>'); }
            else if (c.kind !== 'bot') b.push('<button class="btn small" data-act="cdo" data-do="park" data-id="' + c.id + '">Park</button>');
            b.push('<button class="btn small" data-act="cnobots" data-id="' + c.id + '" data-on="' + (c.noBots ? '0' : '1') + '">' + (c.noBots ? 'Allow bots' : 'No bots') + '</button>');
            if (c.kind !== 'player') b.push('<button class="btn small" data-act="cassign" data-id="' + c.id + '">Assign</button>');
            b.push('<button class="btn small danger" data-act="cwipe" data-id="' + c.id + '">Wipe</button>');
            return '<span class="row">' + b.join('') + '</span>';
          } },
        ], d.colonies, { empty: 'None.' }) + '</div>');
    });
  };
  ACT.cphase = function (el) { state.colonies.phase = el.dataset.p; reload(); };
  FORM.csearch = function (d) { state.colonies.q = d.q; reload(); };
  ACT.cdo = function (el) { return post('/colonies/' + el.dataset.id + '/' + el.dataset.do).then(function () { toast('Done.'); reload(); }); };
  ACT.cnobots = function (el) { return post('/colonies/' + el.dataset.id + '/nobots', { on: el.dataset.on === '1' }).then(reload); };
  ACT.cassign = function (el) { var u = prompt('Account id to give colony #' + el.dataset.id + ' to (it must have no colony):'); if (!u) return; return post('/colonies/' + el.dataset.id + '/assign', { userId: Number(u) }).then(function () { toast('Assigned.'); reload(); }); };
  ACT.cwipe = function (el) { var c = prompt('Wipe colony #' + el.dataset.id + ' for good? Type its number to confirm.'); if (c === null) return; return post('/colonies/' + el.dataset.id + '/wipe', { confirm: Number(c) }).then(function () { toast('Wiped.'); reload(); }); };

  // ---------------------------------------------------------------- market
  VIEWS.market = function () {
    var s = state.market;
    return Promise.all([get('/market'), get('/market/orders?' + qs({ kind: s.kind, resource: s.resource })), get('/market/trades?' + qs({ kind: s.kind, resource: s.resource })), get('/market/flags')]).then(function (all) {
      var m = all[0], o = all[1], t = all[2], f = all[3];
      var goods = m.goods.filter(function (g) { return g.ground || g.orbit; });
      var vol = function (v) { return v ? num(v.q) + ' <span class="faint">(' + v.n + ')</span>' : '—'; };
      main('<h1>Market</h1>' +
        '<div class="card"><div class="row">' +
        '<span>Exchange: ' + (m.frozen.ground ? pill('frozen', 'bad') : pill('open', 'good')) + '</span><button class="btn small" data-act="mfreeze" data-k="ground" data-on="' + (m.frozen.ground ? '0' : '1') + '"' + dis() + '>' + (m.frozen.ground ? 'Reopen' : 'Freeze') + '</button>' +
        '<span style="margin-left:16px">Orbital market: ' + (m.frozen.orbit ? pill('frozen', 'bad') : pill('open', 'good')) + '</span><button class="btn small" data-act="mfreeze" data-k="orbit" data-on="' + (m.frozen.orbit ? '0' : '1') + '"' + dis() + '>' + (m.frozen.orbit ? 'Reopen' : 'Freeze') + '</button>' +
        '<span class="dim" style="margin-left:auto">tick ' + num(m.tick) + ' · fees ' + Math.round(m.feeRate.ground * 100) + '% / ' + Math.round(m.feeRate.orbit * 100) + '%</span></div></div>' +
        '<div class="card"><h2>Goods</h2>' + table([
          { h: 'Good', v: function (g) { return esc(g.name) + ' <span class="faint">' + esc(g.resource) + '</span>' + (g.event ? ' ' + pill(g.event, g.event === 'shortage' ? 'warn' : 'accent') : ''); } },
          { h: 'Ref', num: 1, v: function (g) { return num(g.ref); } },
          { h: 'Adjust', v: function (g) { return can() ? '<form class="row" data-form="madjust"><input type="hidden" name="resource" value="' + esc(g.resource) + '"><input name="mult" type="number" step="0.01" min="0.1" max="10" value="' + g.adjust + '" style="width:76px"><button class="btn small">Set</button></form>' : '×' + g.adjust; } },
          { h: 'Ground bid / ask', num: 1, v: function (g) { return g.ground ? num(g.groundBid) + ' / ' + num(g.groundAsk) : '—'; } },
          { h: 'Open', num: 1, v: function (g) { return g.ground ? g.groundOpen : '—'; } },
          { h: '24 h', num: 1, v: function (g) { return vol(g.groundVol); } },
          { h: 'Orbit bid / ask', num: 1, v: function (g) { return g.orbit ? num(g.orbitBid) + ' / ' + num(g.orbitAsk) : '—'; } },
          { h: 'Open', num: 1, v: function (g) { return g.orbit ? g.orbitOpen : '—'; } },
          { h: '24 h', num: 1, v: function (g) { return vol(g.orbitVol); } },
        ], goods) + '</div>' +
        '<div class="card"><div class="row" style="justify-content:space-between"><div class="tabs">' + ['ground', 'orbit'].map(function (k) { return '<button data-act="mkind" data-k="' + k + '" class="' + (s.kind === k ? 'on' : '') + '">' + (k === 'ground' ? 'Exchange' : 'Orbital market') + '</button>'; }).join('') + '</div>' +
        '<select data-change="mres"><option value="">every good</option>' + goods.map(function (g) { return '<option value="' + esc(g.resource) + '"' + (s.resource === g.resource ? ' selected' : '') + '>' + esc(g.name) + '</option>'; }).join('') + '</select></div>' +
        '<h2>Open player orders (' + o.orders.length + ')</h2>' + table([
          { h: '', v: function (x) { return can() ? '<input type="checkbox" class="ocheck" value="' + x.id + '">' : ''; } },
          { h: '#', v: function (x) { return x.id; } }, { h: 'Who', v: function (x) { return esc(x.username || '?') + ' <span class="faint">#' + x.colony + '</span>'; } },
          { h: 'Side', v: function (x) { return pill(x.side, x.side === 'buy' ? 'good' : 'warn'); } }, { h: 'Good', v: function (x) { return esc(x.name); } },
          { h: 'Price', num: 1, v: function (x) { return num(x.price); } }, { h: 'Qty', num: 1, v: function (x) { return num(x.qty) + ' / ' + num(x.total); } }, { h: 'Ends', num: 1, v: function (x) { return x.ticksLeft + ' t'; } },
        ], o.orders, { empty: 'No open player orders.' }) + (can() && o.orders.length ? '<div class="row" style="margin-top:8px"><button class="btn small" data-act="mselall">Select all</button><button class="btn danger small" data-act="mcancel">Cancel selected</button></div>' : '') +
        '<h2 style="margin-top:18px">Recent trades</h2>' + table([
          { h: 'Tick', num: 1, v: function (x) { return num(x.tick); } }, { h: 'Good', v: function (x) { return esc(x.name); } }, { h: 'Price', num: 1, v: function (x) { return num(x.price); } }, { h: 'Qty', num: 1, v: function (x) { return num(x.qty); } },
          { h: 'Buyer', v: function (x) { return esc(x.buyerName || (x.buyer ? '#' + x.buyer : 'market maker')); } }, { h: 'Seller', v: function (x) { return esc(x.sellerName || (x.seller ? '#' + x.seller : 'market maker')); } },
        ], t.trades.slice(0, 120), { empty: 'No trades.' }) + '</div>' +
        '<div class="cols"><div class="card"><h2>Worth a look (3 days)</h2>' + table([
          { h: 'Why', v: function (x) { return pill(x.kind, x.kind === 'same-address' ? 'bad' : 'warn') + (x.address ? ' <span class="faint">' + esc(x.address) + '</span>' : ''); } },
          { h: 'Buyer → seller', v: function (x) { return esc(x.buyerName) + ' → ' + esc(x.sellerName); } }, { h: 'Trades', num: 1, v: function (x) { return x.trades; } }, { h: 'Value', num: 1, v: function (x) { return num(Math.round(x.value)); } },
        ], f.pairs, { empty: 'Nothing flagged.' }) +
        '<h3>Prices far from the reference</h3>' + table([{ h: 'Tick', num: 1, v: function (x) { return num(x.tick); } }, { h: 'Good', v: function (x) { return esc(x.name); } }, { h: 'Price / ref', num: 1, v: function (x) { return num(x.price) + ' / ' + num(x.ref) + ' (×' + x.ratio + ')'; } }, { h: 'Colonies', v: function (x) { return '#' + x.buyer + ' ← #' + x.seller; } }], f.oddPrices, { empty: 'None.' }) + '</div>' +
        '<div class="card"><h2>Top traders, exchange 24 h</h2>' + table([{ h: 'Colony', v: function (x) { return esc(x.username || '?') + ' <span class="faint">#' + x.colony + '</span>'; } }, { h: 'Trades', num: 1, v: function (x) { return x.trades; } }, { h: 'Value', num: 1, v: function (x) { return num(Math.round(x.value)); } }], m.topTraders, { empty: 'No trades.' }) + '</div></div>');
    });
  };
  ACT.mfreeze = function (el) { return post('/market/freeze', { kind: el.dataset.k, on: el.dataset.on === '1' }).then(reload); };
  FORM.madjust = function (d) { return post('/market/adjust', { resource: d.resource, mult: d.mult === '' ? null : Number(d.mult) }).then(function () { toast('Price adjusted.'); reload(); }); };
  ACT.mkind = function (el) { state.market.kind = el.dataset.k; reload(); };
  ACT.mres = function (el) { state.market.resource = el.value; reload(); };
  ACT.mselall = function () { Array.prototype.forEach.call(document.querySelectorAll('.ocheck'), function (c) { c.checked = true; }); };
  ACT.mcancel = function () {
    var ids = Array.prototype.filter.call(document.querySelectorAll('.ocheck'), function (c) { return c.checked; }).map(function (c) { return Number(c.value); });
    if (!ids.length) return toast('Select orders first.', true);
    if (!confirm('Cancel ' + ids.length + ' order(s)? What they hold goes back to their owners.')) return;
    return post('/market/orders/cancel', { kind: state.market.kind, ids: ids }).then(function (r) { toast(r.cancelled + ' cancelled.'); reload(); });
  };

  // ---------------------------------------------------------------- bots
  VIEWS.bots = function () {
    var s = state.tele;
    return Promise.all([get('/bots'), get('/bots/telemetry?' + qs(s))]).then(function (all) {
      var b = all[0], t = all[1], r = b.runner, ctl = b.control;
      var fresh = r && Date.now() - r.at < 10 * 60000;
      main('<h1>Bots</h1>' +
        (!b.api.enabled ? '<div class="banner">The bot API is off' + (b.api.key ? ' (switched off here).' : ': no key is set (BOT_API_KEY, or issue one below).') + '</div>' : '') +
        (ctl.paused ? '<div class="banner">Bots are paused' + ({ bots: '.', 'simulation-paused': ': the simulation is paused.', 'no-active-players': ': no player is active.' }[ctl.why] || '.') + '</div>' : '') +
        '<div class="grid">' +
        stat('Runner', r ? (fresh ? '<span class="good">up</span>' : '<span class="warn">quiet</span>') : '<span class="faint">never seen</span>', r ? 'seen ' + ago(r.at) + (r.ip ? ' from ' + esc(r.ip) : '') : '') +
        stat('Running', b.bots.length + (r && r.limit !== undefined ? ' / ' + r.limit : ''), r ? (r.waiting || 0) + ' slot(s) waiting for a colony' : '') +
        stat('Candidates', num(b.candidates), 'parked, recent, bots allowed · ' + b.excluded + ' kept from bots') +
        stat('Turned down', r ? num(r.rejectedCount || 0) : '—', r ? num(r.blockedCount || 0) + ' blacklisted' : '') +
        stat('Key', esc(b.api.key || 'none'), b.api.keyFile ? 'file ' + esc(b.api.keyFile) : 'no key file') +
        '</div>' +
        '<div class="cols"><div class="card"><h2>Control</h2><div class="row">' +
        '<button class="btn' + (ctl.why === 'bots' ? ' primary' : '') + '" data-act="bpause" data-on="' + (ctl.why === 'bots' ? '0' : '1') + '"' + dis() + '>' + (ctl.why === 'bots' ? 'Resume bots' : 'Pause bots') + '</button>' +
        '<button class="btn" data-act="bapi" data-on="' + (b.api.off ? '1' : '0') + '"' + dis() + '>' + (b.api.off ? 'Bot API on' : 'Bot API off') + '</button>' +
        '<button class="btn danger" data-act="bkey"' + dis() + '>New key</button></div><div id="newkey"></div>' +
        '<h3>Overrides</h3><form data-form="boverride"><div class="row" style="margin-bottom:10px"><label>Limit <input name="limit" type="number" min="0" max="200" style="width:80px" value="' + (ctl.limit === null ? '' : ctl.limit) + '" placeholder="' + (r && r.settings && r.settings.limit !== undefined ? r.settings.limit : 'runner') + '"></label>' +
        '<label>Claim <select name="claim"><option value="">runner\'s</option><option value="all"' + (ctl.claim === 'all' ? ' selected' : '') + '>all parked</option><option value="given_up"' + (ctl.claim === 'given_up' ? ' selected' : '') + '>given up only</option></select></label></div>' +
        '<div class="row" style="margin-bottom:10px">' + b.profiles.map(function (p) { return '<label title="' + esc(p.blurb) + '"><input type="checkbox" name="profiles" data-multi="1" value="' + p.id + '"' + (ctl.profiles && ctl.profiles.indexOf(p.id) >= 0 ? ' checked' : '') + '> ' + esc(p.name) + '</label>'; }).join('') + '</div>' +
        '<span class="faint small">Blank or none ticked: the runner\'s own settings.</span><br><button class="btn" style="margin-top:8px"' + dis() + '>Save overrides</button></form></div>' +
        '<div class="card"><h2>Runner settings</h2>' + (r && r.settings ? '<div class="kv">' + Object.keys(r.settings).map(function (k) { return '<div>' + esc(k) + '</div><div>' + esc(JSON.stringify(r.settings[k])) + '</div>'; }).join('') + '<div>pid</div><div>' + esc(r.pid) + '</div><div>last poll</div><div>' + ago(r.lastPoll) + '</div></div>' : '<p class="dim">No report yet.</p>') + '</div></div>' +
        '<div class="card"><h2>Bots</h2>' + table([
          { h: 'Bot', v: function (x) { return '<a href="#/users/' + x.userId + '">' + esc(x.username) + '</a>'; } },
          { h: 'Profile', v: function (x) { return can() ? '<select data-change="bprofile" data-id="' + x.userId + '">' + b.profiles.map(function (p) { return '<option value="' + p.id + '"' + (p.id === x.profile ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</select>' : esc(x.profile); } },
          { h: 'Colony', v: function (x) { return x.colonyId ? '#' + x.colonyId + ' · hub ' + x.hub + ' · pop ' + x.population + ' · ' + num(x.credits) + ' cr' + (x.station ? ' · ' + esc(x.station) : '') + (x.shutdown ? ' ' + pill('shut down', 'bad') : '') : '<span class="faint">none</span>'; } },
          { h: 'Last turn', v: function (x) { return x.last ? ago(x.last.at) + (x.last.saving ? ' · saving ' + esc(x.last.saving) : '') : '—'; } },
          { h: 'Errors', num: 1, v: function (x) { return x.errors === null ? '—' : x.errors; } },
          { h: '', v: function (x) { return can() ? '<button class="btn small" data-act="brelease" data-id="' + x.userId + '">Release</button>' : ''; } },
        ], b.bots, { empty: 'No bots are running colonies.' }) + '</div>' +
        '<div class="card"><h2>Telemetry</h2><form class="row" data-form="tfilter"><label>Days <input name="days" type="number" min="0" max="365" value="' + esc(s.days) + '" style="width:70px"></label><input name="bot" placeholder="bot" value="' + esc(s.bot) + '"><input name="ev" placeholder="entry kind (e.g. give_up)" value="' + esc(s.ev) + '"><button class="btn">Show</button>' +
        '<a class="btn" href="/api/bots/telemetry/export?' + qs(s) + '">Export JSONL</a></form>' +
        '<p class="dim small">' + num(t.total) + ' entries · ' + Object.keys(t.byEv).map(function (k) { return esc(k) + ' ' + t.byEv[k]; }).join(' · ') + '</p>' +
        '<div class="cols"><div><h3>Issues flagged</h3>' + table([{ h: 'Code', v: function (x) { return esc(x[0]); } }, { h: 'Times', num: 1, v: function (x) { return x[1]; } }], t.issues.map(function (x) { return x; }), { empty: 'None.' }) + '</div>' +
        '<div><h3>Give-ups</h3>' + table([{ h: 'Reason', v: function (x) { return esc(x[0]); } }, { h: 'Times', num: 1, v: function (x) { return x[1]; } }], t.giveUps, { empty: 'None.' }) + '</div>' +
        '<div><h3>Repeated refusals</h3>' + table([{ h: 'Refusal', wrap: 1, v: function (x) { return esc(x[0]); } }, { h: 'Times', num: 1, v: function (x) { return x[1]; } }], t.refusals, { empty: 'None.' }) + '</div></div>' +
        '<h3>Per bot</h3>' + table([{ h: 'Bot', v: function (x) { return esc(x.bot); } }, { h: 'Profile', v: function (x) { return esc(x.profile || ''); } }, { h: 'Entries', num: 1, v: function (x) { return x.entries; } }, { h: 'Issues', num: 1, v: function (x) { return x.issues; } }, { h: 'Errors', num: 1, v: function (x) { return x.errors; } }, { h: 'Milestones', wrap: 1, v: function (x) { return esc(x.milestones.join(', ')); } }, { h: 'Gave up', v: function (x) { return esc(x.gaveUp || ''); } }], t.perBot, { empty: 'No entries.' }) +
        '<details><summary>Latest entries</summary>' + table([{ h: 'When', v: function (x) { return date(x.at); } }, { h: 'Kind', v: function (x) { return esc(x.ev); } }, { h: 'Bot', v: function (x) { return esc(x.bot || ''); } }, { h: 'Data', wrap: 1, v: function (x) { var d = Object.assign({}, x.data); delete d.at; delete d.ev; delete d.bot; delete d.profile; delete d.colony; return '<span class="small faint">' + esc(JSON.stringify(d).slice(0, 300)) + '</span>'; } }], t.recent) + '</details></div>');
    });
  };
  ACT.bpause = function (el) { return post('/bots/pause', { on: el.dataset.on === '1' }).then(reload); };
  ACT.bapi = function (el) { return post('/bots/api', { on: el.dataset.on === '1' }).then(reload); };
  ACT.bkey = function () {
    if (!confirm('Issue a new bot API key? The current one stops working at once.')) return;
    return post('/bots/key').then(function (r) {
      $('newkey').innerHTML = '<h3>New key (shown once)</h3><div class="key">' + esc(r.key) + '</div><p class="small ' + (r.wrote ? 'good' : 'warn') + '">' + (r.wrote ? 'Written to ' + esc(r.file) + '.' : r.file ? 'Could not write ' + esc(r.file) + '.' : 'No key file: the runner needs this key in BOT_API_KEY and a restart.') + '</p>';
    });
  };
  FORM.boverride = function (d) { return post('/bots/overrides', { limit: d.limit === '' ? null : Number(d.limit), claim: d.claim || null, profiles: d.profiles && d.profiles.length ? d.profiles : null }).then(function () { toast('Saved; the runner applies it on its next loop.'); reload(); }); };
  ACT.bprofile = function (el) { return post('/bots/' + el.dataset.id + '/profile', { profile: el.value }).then(function () { toast('Profile changed.'); }); };
  ACT.brelease = function (el) {
    var keep = confirm('Keep the colony away from the bots after it is released? (OK: keep away; Cancel: another bot may claim it)');
    if (!confirm('Release this bot\'s colony? It parks under a generated account.')) return;
    return post('/bots/' + el.dataset.id + '/release', { noBots: keep }).then(function () { toast('Released.'); reload(); });
  };
  FORM.tfilter = function (d) { state.tele = { days: d.days, bot: d.bot, ev: d.ev }; reload(); };

  // ---------------------------------------------------------------- backups
  VIEWS.backups = function () {
    return get('/backups').then(function (d) {
      var st = d.settings;
      main('<h1>Backups</h1>' + (d.pendingRestore ? '<div class="banner bad">A full restore from ' + esc(d.pendingRestore.from) + ' happens at the next start. <button class="btn small" data-act="bkcancel">Cancel it</button></div>' : '') +
        '<div class="card"><div class="row"><button class="btn primary" data-act="bknow"' + dis() + '>Back up now</button>' +
        '<form class="row" data-form="bksnap"><input name="label" placeholder="snapshot label"><button class="btn"' + dis() + '>Take snapshot</button></form>' +
        '<span class="dim small" style="margin-left:auto">automatic every ' + st.hours + ' h, keeping ' + st.keep + ' · ' + esc(st.dir) + '</span></div>' +
        '<p class="faint small">Snapshots and pre-restore copies are never pruned. A full restore restarts the server and keeps the current database as a pre-restore copy.</p></div>' +
        '<div class="card">' + table([
          { h: 'File', v: function (b) { return esc(b.name) + ' ' + pill(b.kind, b.kind === 'snapshot' ? 'accent' : b.kind === 'pre-restore' ? 'warn' : ''); } },
          { h: 'Taken', v: function (b) { return date(b.at) + ' <span class="faint">' + ago(b.at) + '</span>'; } },
          { h: 'Size', num: 1, v: function (b) { return bytes(b.size); } },
          { h: '', v: function (b) {
            return '<span class="row"><button class="btn small" data-act="bkpeek" data-n="' + esc(b.name) + '">Inside</button>' +
              (can() ? '<a class="btn small" href="/api/backups/' + encodeURIComponent(b.name) + '/download">Download</a>' + (b.kind === 'auto' ? '<button class="btn small" data-act="bkkeep" data-n="' + esc(b.name) + '">Keep</button>' : '') +
              '<button class="btn small danger" data-act="bkrestore" data-n="' + esc(b.name) + '">Restore all</button><button class="btn small danger" data-act="bkdel" data-n="' + esc(b.name) + '">Delete</button>' : '') + '</span>';
          } },
        ], d.backups, { empty: 'No backups yet.' }) + '<div id="peek"></div></div>');
    });
  };
  ACT.bknow = function () { return post('/backups', { kind: 'backup' }).then(function (r) { toast('Written: ' + r.name); reload(); }); };
  FORM.bksnap = function (d) { return post('/backups', { kind: 'snapshot', label: d.label }).then(function (r) { toast('Snapshot: ' + r.name); reload(); }); };
  ACT.bkkeep = function (el) { var l = prompt('Label for the kept copy (optional):', ''); if (l === null) return; return post('/backups/' + encodeURIComponent(el.dataset.n) + '/keep', { label: l }).then(function () { toast('Kept as a snapshot.'); reload(); }); };
  ACT.bkdel = function (el) { var c = prompt('Delete ' + el.dataset.n + '? Type the file name to confirm.'); if (c === null) return; return post('/backups/' + encodeURIComponent(el.dataset.n) + '/delete', { confirm: c }).then(function () { toast('Deleted.'); reload(); }); };
  ACT.bkrestore = function (el) {
    var c = prompt('Restore the WHOLE game to ' + el.dataset.n + '? Everything since is lost for every player; the server restarts. Type the file name to confirm.');
    if (c === null) return;
    return post('/backups/' + encodeURIComponent(el.dataset.n) + '/restore', { confirm: c }).then(function (r) { toast(r.restarting ? (r.supervised ? 'Restarting into the backup…' : 'Stopping: start the server again to finish the restore.') : 'Restore set for the next start; restart the server.'); setTimeout(reload, 6000); });
  };
  ACT.bkcancel = function () { return post('/backups/restore/cancel').then(reload); };
  ACT.bkpeek = function (el) {
    return get('/backups/' + encodeURIComponent(el.dataset.n) + '/colonies').then(function (p) {
      $('peek').innerHTML = '<h3>' + esc(el.dataset.n) + ' · tick ' + num(p.tick) + ' · schema v' + p.version + ' · ' + p.colonies.length + ' colonies</h3>' + table([
        { h: '#', v: function (c) { return c.id; } }, { h: 'Holder', v: function (c) { return esc(c.username || '?') + ' <span class="faint">user ' + c.userId + '</span>'; } },
        { h: 'State', v: function (c) { return 'hub ' + c.hub + ' · pop ' + c.population + ' · ' + num(c.credits) + ' cr · age ' + num(c.age) + (c.station ? ' · ' + esc(c.station) : ''); } },
        { h: '', v: function (c) { return can() ? '<button class="btn small danger" data-act="bkcol" data-n="' + esc(el.dataset.n) + '" data-id="' + c.id + '">Restore this colony</button>' : ''; } },
      ], p.colonies);
    });
  };
  ACT.bkcol = function (el) {
    if (!confirm('Roll colony #' + el.dataset.id + ' back to ' + el.dataset.n + '? It goes to whoever holds it now (or its holder then).')) return;
    return post('/colonies/' + el.dataset.id + '/restore', { backup: el.dataset.n }).catch(function (e) {
      if (!e.data || !e.data.otherColony) throw e;
      var how = prompt(e.message + ' Type "park" or "wipe" for colony #' + e.data.otherColony + '.', 'park');
      if (!how) return null;
      return post('/colonies/' + el.dataset.id + '/restore', { backup: el.dataset.n, current: how });
    }).then(function (r) { if (r) toast('Colony #' + r.colonyId + ' restored.'); });
  };

  // ---------------------------------------------------------------- logs
  VIEWS.logs = function () {
    var s = state.logs;
    if (s.tab === 'audit') {
      return get('/audit?' + qs({ q: s.q })).then(function (d) {
        main(logTabs() + '<div class="card"><form class="row" data-form="lfilter"><input class="grow" name="q" placeholder="Admin, action, target" value="' + esc(s.q) + '"><button class="btn">Filter</button></form></div><div class="card">' +
          table([{ h: 'When', v: function (x) { return date(x.at); } }, { h: 'Admin', v: function (x) { return esc(x.admin); } }, { h: 'Action', v: function (x) { return pill(x.action, /delete|wipe|restore|ban|key|force/.test(x.action) ? 'warn' : ''); } }, { h: 'Target', v: function (x) { return esc(x.target || ''); } }, { h: 'Detail', wrap: 1, v: function (x) { return x.detail ? '<span class="small faint">' + esc(JSON.stringify(x.detail).slice(0, 400)) + '</span>' : ''; } }, { h: 'From', v: function (x) { return esc(x.ip || ''); } }], d.audit) + '</div>');
      });
    }
    var f = { level: s.level, category: s.category, q: s.q, userId: s.userId, before: s.before };
    return get('/logs?' + qs(f)).then(function (d) {
      var last = d.logs.length ? d.logs[d.logs.length - 1].id : null;
      main(logTabs() + '<div class="card"><form class="row" data-form="lfilter"><select name="level"><option value="">any level</option>' + ['info', 'warn', 'error'].map(function (l) { return '<option' + (s.level === l ? ' selected' : '') + '>' + l + '</option>'; }).join('') + '</select>' +
        '<select name="category"><option value="">any category</option>' + d.categories.map(function (c) { return '<option' + (s.category === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select>' +
        '<input name="userId" placeholder="user id" style="width:90px" value="' + esc(s.userId) + '"><input class="grow" name="q" placeholder="text, address" value="' + esc(s.q) + '"><button class="btn">Filter</button>' +
        '<a class="btn" href="/api/logs/export?' + qs(Object.assign({}, f, { before: '', format: 'csv' })) + '">CSV</a><a class="btn" href="/api/logs/export?' + qs(Object.assign({}, f, { before: '' })) + '">JSONL</a></form></div>' +
        '<div class="card">' + table([
          { h: 'When', v: function (x) { return date(x.at); } }, { h: 'Level', v: function (x) { return pill(x.level, x.level === 'error' ? 'bad' : x.level === 'warn' ? 'warn' : ''); } }, { h: 'Category', v: function (x) { return esc(x.category); } },
          { h: 'Message', wrap: 1, v: function (x) { return esc(x.message) + (x.data ? ' <details><summary class="small">data</summary><pre class="log">' + esc(JSON.stringify(x.data, null, 1)) + '</pre></details>' : ''); } },
          { h: 'Account', v: function (x) { return x.userId ? '<a href="#/users/' + x.userId + '">' + esc(x.username || '#' + x.userId) + '</a>' : ''; } }, { h: 'From', v: function (x) { return esc(x.ip || ''); } },
        ], d.logs, { empty: 'Nothing logged.' }) + '<div class="row" style="margin-top:8px">' + (s.before ? '<button class="btn small" data-act="lnewest">Newest</button>' : '') + (d.logs.length === 200 ? '<button class="btn small" data-act="lolder" data-b="' + last + '">Older ›</button>' : '') + '</div></div>');
    });
  };
  function logTabs() { return '<h1>Logs</h1><div class="tabs">' + [['server', 'Server log'], ['audit', 'Admin audit']].map(function (t) { return '<button data-act="ltab" data-t="' + t[0] + '" class="' + (state.logs.tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>'; }).join('') + '</div>'; }
  ACT.ltab = function (el) { state.logs.tab = el.dataset.t; state.logs.before = null; reload(); };
  FORM.lfilter = function (d) { Object.assign(state.logs, d, { before: null }); reload(); };
  ACT.lolder = function (el) { state.logs.before = el.dataset.b; reload(); };
  ACT.lnewest = function () { state.logs.before = null; reload(); };

  // ---------------------------------------------------------------- maintenance
  var jobTimer = null;
  VIEWS.maintenance = function () {
    return get('/maintenance').then(function (d) {
      var c = d.code, u = d.update;
      main('<h1>Maintenance</h1>' +
        (!d.supervised ? '<div class="banner">No process supervisor detected: a restart (after an update or a full restore) stops the server, and it must be started again by hand.</div>' : '') +
        '<div class="cols"><div class="card"><h2>Code</h2>' + (c.git ? '<div class="kv"><div>version</div><div>' + esc(c.version) + '</div><div>commit</div><div><code>' + esc(c.short) + '</code> ' + esc(c.subject) + '</div><div>date</div><div>' + esc((c.date || '').slice(0, 16).replace('T', ' ')) + '</div><div>branch</div><div>' + esc(c.branch) + '</div><div>local changes</div><div>' + (c.dirty.length ? '<span class="warn">' + esc(c.dirty.join(', ')) + '</span>' : 'none') + '</div></div>' : '<p class="warn">' + esc(c.gitError) + '</p>') +
        '<h3>Update from</h3><form data-form="usettings"><label class="field"><span>Repository</span><input name="repo" value="' + esc(u.repo) + '" placeholder="' + esc(u.defaults.repo) + '"></label><label class="field"><span>Branch</span><input name="branch" value="' + esc(u.branch) + '"></label>' +
        '<div class="row"><button class="btn"' + dis() + '>Save</button><button class="btn" type="button" data-act="ucheck"' + dis() + '>Check for updates</button><button class="btn primary" type="button" data-act="uapply"' + dis() + '>Update and restart</button><button class="btn danger" type="button" data-act="uapply" data-force="1"' + dis() + '>Force (reset to remote)</button></div></form><div id="job"></div></div>' +
        '<div class="card"><h2>Players</h2>' +
        '<form data-form="mmode"><label class="field"><span>Maintenance mode</span><input name="message" placeholder="Message on the sign-in page" value="' + esc(d.maintenance ? d.maintenance.message : '') + '"></label><div class="row"><label><input type="checkbox" name="on"' + (d.maintenance ? ' checked' : '') + '> on</label><label><input type="checkbox" name="signOut"> sign everyone out</label><button class="btn"' + dis() + '>Apply</button></div></form>' +
        '<form data-form="mnotice" style="margin-top:16px"><label class="field"><span>Banner in the game</span><input name="text" value="' + esc(d.notice ? d.notice.text : '') + '" placeholder="(none)"></label><div class="row"><select name="level">' + ['info', 'warn', 'bad'].map(function (l) { return '<option' + (d.notice && d.notice.level === l ? ' selected' : '') + '>' + l + '</option>'; }).join('') + '</select><input name="hours" type="number" min="0" placeholder="hours (blank: until cleared)" style="width:200px"><button class="btn"' + dis() + '>Set</button></div></form>' +
        '<h3>Simulation</h3><div class="row">' + (d.clockPaused ? pill('paused', 'warn') + '<button class="btn" data-act="mclock" data-p="0"' + dis() + '>Resume</button>' : (d.hold && d.hold.reason === 'idle' ? pill('idle: no active players', 'accent') : pill('running', 'good')) + '<button class="btn" data-act="mclock" data-p="1"' + dis() + '>Pause</button>') + (d.idlePause ? '' : ' <span class="faint small">idle pause off</span>') + '</div>' +
        '<h3>Server</h3><div class="row"><button class="btn" data-act="msessions"' + dis() + '>Sign out every player</button><button class="btn danger" data-act="mrestart"' + dis() + '>Restart server</button></div></div></div>' +
        '<div class="cols"><div class="card"><h2>Sign-up and email</h2><div class="kv"><div>email verification</div><div>' + (d.emailVerification ? 'required' : 'off') + '</div><div>mail transport</div><div>' + esc(d.mail.transport) + (d.mail.transport === 'log' ? ' <span class="warn">(nothing is sent)</span>' : '') + '</div><div>from</div><div>' + esc(d.mail.from) + '</div><div>links to</div><div>' + esc(d.mail.publicUrl || '(PUBLIC_URL not set: codes only)') + '</div><div>Turnstile</div><div>' + (d.turnstile ? 'on' : '<span class="warn">off</span>') + '</div></div>' +
        '<form class="row" data-form="msupport" style="margin-top:12px"><input class="grow" name="url" value="' + esc(d.support.custom ? d.support.url : '') + '" placeholder="Support link: ' + esc(d.support.url || 'none') + ' (code repository)"><button class="btn"' + dis() + '>Set</button></form>' +
        '<form class="row" data-form="mtest" style="margin-top:12px"><input class="grow" name="to" placeholder="address for a test email"><button class="btn"' + dis() + '>Send test</button></form></div>' +
        '<div class="card"><h2>Database</h2><div class="kv"><div>file</div><div>' + esc(d.dbPath) + ' (' + bytes(d.dbBytes) + ')</div>' + Object.keys(d.counts).map(function (k) { return '<div>' + esc(k) + '</div><div>' + num(d.counts[k]) + '</div>'; }).join('') + '</div>' +
        '<div class="row" style="margin-top:12px"><button class="btn" data-act="mdbcheck"' + dis() + '>Integrity check</button><button class="btn" data-act="mdbopt"' + dis() + '>Compact</button></div><div id="dbout"></div></div></div>' +
        '<div class="card"><h2>Environment</h2><div class="kv">' + Object.keys(d.env).map(function (k) { return '<div>' + esc(k) + '</div><div>' + esc(d.env[k]) + '</div>'; }).join('') + '</div></div>');
    });
  };
  FORM.usettings = function (d) { return post('/update/settings', d).then(function () { toast('Saved.'); }); };
  function watchJob(id) {
    clearTimeout(jobTimer);
    var tick = function () {
      get('/jobs/' + id).then(function (r) {
        var j = r.job, el = $('job');
        if (!el) return;
        var res = j.result || {};
        var html = '<pre class="log">' + esc(j.lines.join('\n')) + '</pre>';
        if (j.status !== 'running') {
          if (res.ok === false) html = '<p class="bad">' + esc(res.error) + '</p>' + html;
          if (res.commits) html = '<p>' + (res.ahead ? res.ahead + ' new commit(s)' + (res.fastForward ? '' : ' <span class="warn">(history differs from yours: only a forced update applies it)</span>') + (res.depsChanged ? ' · dependencies change' : '') : 'Up to date.') + '</p>' +
            table([{ h: 'Commit', v: function (x) { return '<code>' + esc(x.hash) + '</code>'; } }, { h: 'Date', v: function (x) { return esc(x.date); } }, { h: 'Author', v: function (x) { return esc(x.author); } }, { h: 'Subject', wrap: 1, v: function (x) { return esc(x.subject); } }], res.commits.map(function (x, i) { x.id = i; return x; }), { empty: '' }) + html;
          if (res.restarting) { html = '<p class="good">Updated to ' + esc((res.to || '').slice(0, 8)) + '; restarting…</p>' + html; setTimeout(function () { location.reload(); }, 8000); }
        }
        el.innerHTML = html;
        if (j.status === 'running') jobTimer = setTimeout(tick, 1000);
      }).catch(fail);
    };
    tick();
  }
  ACT.ucheck = function () { return post('/update/check').then(function (r) { watchJob(r.job); }); };
  ACT.uapply = function (el) {
    var force = el.dataset.force === '1';
    if (!confirm(force ? 'Reset the code to the remote branch (discarding local commits), install, and restart?' : 'Update to the remote branch and restart? A database snapshot is taken first.')) return;
    return post('/update/apply', { force: force }).then(function (r) { watchJob(r.job); });
  };
  FORM.mmode = function (d) { return post('/maintenance/mode', d).then(function (r) { toast('Maintenance ' + (d.on ? 'on' : 'off') + (r.sessionsEnded ? '; ' + r.sessionsEnded + ' signed out' : '') + '.'); reload(); }); };
  FORM.mnotice = function (d) { return post('/maintenance/notice', d).then(function () { toast(d.text ? 'Banner set.' : 'Banner cleared.'); reload(); }); };
  ACT.mclock = function (el) { return post('/clock', { paused: el.dataset.p === '1' }).then(reload); };
  ACT.msessions = function () { if (!confirm('Sign every player out?')) return; return post('/maintenance/sessions').then(function (r) { toast(r.ended + ' session(s) ended.'); }); };
  ACT.mrestart = function () { if (!confirm('Restart the server now?')) return; return post('/maintenance/restart').then(function (r) { toast(r.supervised ? 'Restarting…' : 'Stopping: start it again by hand.'); setTimeout(function () { location.reload(); }, 8000); }); };
  FORM.msupport = function (d) { return post('/maintenance/support', d).then(function (r) { toast('Support link: ' + (r.support || 'none')); reload(); }); };
  FORM.mtest = function (d) { return post('/maintenance/test-email', d).then(function (r) { toast('Sent via ' + r.transport + '.'); }); };
  ACT.mdbcheck = function () { return post('/maintenance/db/check').then(function (r) { $('dbout').innerHTML = '<pre class="log">' + esc(r.result.join('\n')) + '\nforeign key problems: ' + r.foreignKeyProblems + '</pre>'; }); };
  ACT.mdbopt = function () { if (!confirm('Compact the database? Writes wait while it runs.')) return; return post('/maintenance/db/optimize').then(function (r) { $('dbout').innerHTML = '<p>' + bytes(r.before) + ' → ' + bytes(r.after) + '</p>'; }); };

  // ---------------------------------------------------------------- admins and account
  VIEWS.admins = function () {
    return get('/admins').then(function (d) {
      main('<h1>Admins</h1><div class="card">' + table([
        { h: 'Name', v: function (a) { return esc(a.username) + (a.id === me.id ? ' <span class="faint">(you)</span>' : ''); } },
        { h: 'Role', v: function (a) { return pill(a.role, a.role === 'admin' ? 'accent' : ''); } },
        { h: '2FA', v: function (a) { return a.totp ? pill('on', 'good') : pill('off', 'warn'); } },
        { h: 'Last sign-in', v: function (a) { return ago(a.lastLoginAt); } },
        { h: '', v: function (a) { return can() && a.id !== me.id ? '<span class="row"><button class="btn small" data-act="adrole" data-id="' + a.id + '" data-r="' + (a.role === 'admin' ? 'viewer' : 'admin') + '">Make ' + (a.role === 'admin' ? 'viewer' : 'admin') + '</button><button class="btn small" data-act="adpass" data-id="' + a.id + '">Passcode</button>' + (a.totp ? '<button class="btn small" data-act="adtotp" data-id="' + a.id + '">2FA off</button>' : '') + '<button class="btn small' + (a.disabled ? '' : ' danger') + '" data-act="addis" data-id="' + a.id + '" data-on="' + (a.disabled ? '0' : '1') + '">' + (a.disabled ? 'Enable' : 'Disable') + '</button></span>' : (a.disabled ? pill('disabled', 'bad') : ''); } },
      ], d.admins) + '</div>' + (can() ? '<div class="card"><h2>New admin</h2><form class="row" data-form="adcreate"><input name="username" placeholder="Name" required><input name="password" type="password" placeholder="Passcode (10+)" required autocomplete="new-password"><select name="role"><option>admin</option><option>viewer</option></select><button class="btn">Create</button></form></div>' : ''));
    });
  };
  FORM.adcreate = function (d) { return post('/admins', d).then(function () { toast('Created.'); reload(); }); };
  ACT.adrole = function (el) { return post('/admins/' + el.dataset.id, { role: el.dataset.r }).then(reload); };
  ACT.addis = function (el) { return post('/admins/' + el.dataset.id, { disabled: el.dataset.on === '1' }).then(reload); };
  ACT.adtotp = function (el) { if (!confirm('Turn off this admin\'s authenticator code?')) return; return post('/admins/' + el.dataset.id, { totpOff: true }).then(reload); };
  ACT.adpass = function (el) { var p = prompt('New passcode (10+ characters):'); if (!p) return; return post('/admins/' + el.dataset.id, { password: p }).then(function () { toast('Passcode set.'); }); };

  VIEWS.account = function () {
    main('<h1>Account</h1><div class="cols"><div class="card"><h2>Passcode</h2><form data-form="mypass"><label class="field"><span>Current</span><input name="current" type="password" autocomplete="current-password" required></label><label class="field"><span>New (10+)</span><input name="password" type="password" autocomplete="new-password" required></label><button class="btn primary">Change</button></form></div>' +
      '<div class="card"><h2>Two-factor</h2>' + (me.totp ? '<p class="good">An authenticator code is required at sign-in.</p><form class="row" data-form="totpoff"><input name="code" inputmode="numeric" maxlength="6" placeholder="current code" required><button class="btn danger">Turn off</button></form>'
        : '<p class="warn">Off.</p><button class="btn primary" data-act="totpsetup">Set up</button><div id="totp"></div>') + '</div></div>');
  };
  FORM.mypass = function (d, f) { return post('/me/password', d).then(function () { f.reset(); toast('Passcode changed.'); }); };
  ACT.totpsetup = function () {
    return post('/me/totp/setup').then(function (r) {
      $('totp').innerHTML = '<img class="qr" alt="QR code" src="' + esc(r.qr) + '"><div class="key">' + esc(r.secret.replace(/(.{4})/g, '$1 ').trim()) + '</div><p class="small faint" style="word-break:break-all">' + esc(r.uri) + '</p>' +
        '<form class="row" data-form="totpon"><input name="code" inputmode="numeric" maxlength="6" placeholder="6-digit code" required><button class="btn primary">Turn on</button></form>';
    });
  };
  FORM.totpon = function (d) { return post('/me/totp/enable', d).then(function () { me.totp = true; toast('Two-factor on.'); showApp(); }); };
  FORM.totpoff = function (d) { return post('/me/totp/disable', d).then(function () { me.totp = false; toast('Two-factor off.'); showApp(); }); };

  // ---------------------------------------------------------------- start
  get('/me').then(function (r) { me = r.me; showApp(); }).catch(function () { showLogin(); });
})();
