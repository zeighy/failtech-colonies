// The sign-in page. Steps: sign in, sign up, confirm the email address (a code, or the link from the email), give an address
// (an older account without one), forgotten passcode, choose a new passcode. Cloudflare Turnstile is shown on sign-in,
// sign-up and reset requests when the server has it on (/api/theme says so).
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var mode = 'login';
  var auth = { turnstile: null, email: true, maintenance: null };
  var L = { enter: 'Enter command', found: 'Found colony', callsign: 'Callsign' };
  var link = { verify: params.get('verify'), reset: params.get('reset') };
  var sentTo = '';
  var tsToken = '', tsWidget = null;

  var BUTTON = { login: function () { return L.enter; }, register: function () { return L.found; }, verify: function () { return 'Confirm'; }, email: function () { return 'Send code'; }, change: function () { return 'Send code'; },
    forgot: function () { return 'Send reset code'; }, reset: function () { return 'Set passcode'; }, linkverify: function () { return 'Confirm email'; }, totp: function () { return 'Sign in'; } };
  var STEP = { verify: function () { return 'Confirm email' + (sentTo ? ' · code sent to ' + sentTo : ''); }, email: function () { return 'Email address required'; }, change: function () { return 'Change email'; },
    forgot: function () { return 'Passcode reset'; }, reset: function () { return link.reset ? 'New passcode' : 'Code and new passcode'; }, linkverify: function () { return 'Confirm email'; }, totp: function () { return 'Authenticator code'; } };

  function setMode(m) {
    mode = m;
    var tabbed = m === 'login' || m === 'register';
    $('tabs').hidden = !tabbed;
    $('t-login').setAttribute('aria-selected', m === 'login');
    $('t-reg').setAttribute('aria-selected', m === 'register');
    $('step').hidden = tabbed;
    $('step').textContent = STEP[m] ? STEP[m]() : '';
    document.querySelectorAll('[data-in]').forEach(function (el) {
      var on = el.dataset.in.split(' ').indexOf(m) >= 0;
      if (el.id === 'ts') on = on && !!auth.turnstile;
      if (m === 'reset' && link.reset && el.querySelector && el.querySelector('#code')) on = false;
      el.hidden = !on;
    });
    $('l-user').textContent = m === 'register' ? L.callsign : L.callsign + ' or email';
    $('l-pass').textContent = m === 'reset' ? 'New passcode' : m === 'change' ? 'Current passcode' : 'Passcode';
    $('password').autocomplete = m === 'login' || m === 'change' ? 'current-password' : 'new-password';
    $('email').placeholder = m === 'register' && !auth.email ? 'optional' : '';
    $('submit').textContent = BUTTON[m]();
    $('error').textContent = '';
    links();
    if (!$('ts').hidden) turnstile();
  }
  function links() {
    var h = [];
    if (mode === 'login') h.push(['forgot', 'Forgotten passcode']);
    if (mode === 'verify') { h.push(['resend', 'Send again']); h.push(['change', 'Different address']); h.push(['logout', 'Sign out']); }
    if (mode === 'email' || mode === 'change') h.push(['logout', 'Sign out']);
    if (mode === 'forgot') h.push(['havecode', 'I have a code']);
    if (mode === 'forgot' || mode === 'reset' || mode === 'linkverify' || mode === 'totp') h.push(['back', 'Back to sign in']);
    $('links').innerHTML = h.map(function (x) { return '<button type="button" class="linkbtn" data-l="' + x[0] + '">' + x[1] + '</button>'; }).join('');
  }
  var say = function (msg, ok) { $(ok ? 'info' : 'error').textContent = msg || ''; if (ok) $('error').textContent = ''; else $('info').textContent = ''; };

  // ---- Turnstile ----
  function turnstile() {
    if (!auth.turnstile) return;
    if (window.turnstile) { draw(); return; }
    if (document.getElementById('cf-ts')) return;
    var s = document.createElement('script');
    s.id = 'cf-ts';
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = draw;
    document.head.appendChild(s);
  }
  function draw() {
    if (tsWidget !== null) { window.turnstile.reset(tsWidget); tsToken = ''; return; }
    tsWidget = window.turnstile.render('#ts', { sitekey: auth.turnstile, theme: 'dark', callback: function (t) { tsToken = t; }, 'expired-callback': function () { tsToken = ''; }, 'error-callback': function () { tsToken = ''; } });
  }
  function resetTs() { if (window.turnstile && tsWidget !== null) { window.turnstile.reset(tsWidget); tsToken = ''; } }

  // ---- talking to the server ----
  function send(path, body) {
    return fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Something went wrong.' }; }); });
  }
  function next(d) {
    if (d.next === 'game' || !d.next) { location.href = '/game'; return; }
    if (d.next === 'totp') { $('code').value = ''; setMode('totp'); $('code').focus(); return; }
    if (d.next === 'login') { setMode('login'); say('Email confirmed. Sign in.', true); return; }
    if (d.sentTo) sentTo = d.sentTo;
    setMode(d.next === 'email' ? 'email' : 'verify');
    if (d.mailError) say(d.mailError);
    else if (d.next === 'verify') say(sentTo ? 'Code sent.' : 'Enter the code from the email.', true);
  }
  var v = function (id) { return $(id).value; };
  var SUBMIT = {
    login: function () { return send('login', { login: v('username').trim(), password: v('password'), turnstile: tsToken }).then(function (d) { if (d.ok) return next(d); if (d.challenge || auth.turnstile) resetTs(); say(d.error); }); },
    register: function () { return send('register', { username: v('username').trim(), email: v('email').trim(), password: v('password'), turnstile: tsToken }).then(function (d) { if (d.ok) return next(d); resetTs(); say(d.error); }); },
    verify: function () { return send('verify', { code: v('code').trim() }).then(function (d) { if (d.ok) return next(d); say(d.error); }); },
    email: function () { return send('account/email', { email: v('email').trim() }).then(function (d) { if (d.ok) { sentTo = d.sentTo; setMode('verify'); say('Code sent.', true); } else say(d.error); }); },
    change: function () { return send('account/email', { email: v('email').trim(), password: v('password') }).then(function (d) { if (d.ok) { sentTo = d.sentTo; setMode('verify'); say('Code sent.', true); } else say(d.error); }); },
    forgot: function () { return send('password-reset/request', { login: v('username').trim(), turnstile: tsToken }).then(function (d) { resetTs(); if (!d.ok) return say(d.error); setMode('reset'); say('If the account has a confirmed address, a code is on its way.', true); }); },
    reset: function () {
      var body = link.reset ? { token: link.reset, password: v('password') } : { login: v('username').trim(), code: v('code').trim(), password: v('password') };
      return send('password-reset', body).then(function (d) { if (!d.ok) return say(d.error); link.reset = null; history.replaceState(null, '', '/'); setMode('login'); say('Passcode changed. Sign in.', true); });
    },
    totp: function () { return send('login/totp', { code: v('code').trim() }).then(function (d) { if (d.ok) return next(d); if (d.restart) setMode('login'); say(d.error); }); },
    linkverify: function () { return send('verify', { token: link.verify }).then(function (d) { if (d.ok) { history.replaceState(null, '', '/'); return next(d); } say(d.error); }); },
  };
  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('submit');
    btn.disabled = true;
    say('');
    Promise.resolve(SUBMIT[mode]()).catch(function () { say('Cannot reach the server.'); }).then(function () { btn.disabled = false; });
  });
  $('links').addEventListener('click', function (e) {
    var b = e.target.closest('[data-l]');
    if (!b) return;
    var l = b.dataset.l;
    if (l === 'forgot') setMode('forgot');
    else if (l === 'havecode') setMode('reset');
    else if (l === 'back') { link = { verify: null, reset: null }; history.replaceState(null, '', '/'); setMode('login'); }
    else if (l === 'change') setMode('change');
    else if (l === 'logout') send('logout', {}).then(function () { setMode('login'); });
    else if (l === 'resend') send('verify/resend', {}).then(function (d) { if (d.ok) { sentTo = d.sentTo || sentTo; setMode('verify'); say('Sent again.', true); } else say(d.error); });
  });
  $('t-login').onclick = function () { setMode('login'); };
  $('t-reg').onclick = function () { setMode('register'); };

  // ---- start: the theme's wording, what the server asks for, and where this visit begins ----
  fetch('/api/theme').then(function (r) { return r.json(); }).then(function (d) {
    var ui = d.ui || {};
    auth = d.auth || auth;
    if (ui.brand) document.querySelector('.brand').textContent = ui.brand;
    if (ui.subtitle) document.querySelector('.brand-sub').textContent = ui.subtitle;
    if (ui.loginNote) document.querySelector('.login-foot').textContent = ui.loginNote;
    if (ui.title) document.title = ui.title;
    var l = ui.login || {};
    L = { enter: l.enter || L.enter, found: l.found || L.found, callsign: l.callsign || L.callsign };
    if (l.signIn) $('t-login').textContent = l.signIn;
    if (l.register) $('t-reg').textContent = l.register;
    if (auth.maintenance) { $('notice').hidden = false; $('notice').textContent = auth.maintenance; }
  }).catch(function () { /* keep the built-in wording */ }).then(function () {
    if (link.verify) return setMode('linkverify');
    if (link.reset) return setMode('reset');
    return fetch('/api/account').then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok && d.next && d.next !== 'game') { sentTo = d.email || ''; setMode(d.next === 'email' ? 'email' : d.next === 'banned' ? 'login' : 'verify'); if (d.next === 'banned') say('This account is suspended.'); }
      else setMode(mode);
    }).catch(function () { setMode(mode); });
  });
})();
