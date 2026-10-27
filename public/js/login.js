(function () {
  var mode = 'login';
  var L = { enter: 'Enter command', found: 'Found colony' };
  var $ = function (id) { return document.getElementById(id); };
  function setMode(m) {
    mode = m;
    $('t-login').setAttribute('aria-selected', m === 'login');
    $('t-reg').setAttribute('aria-selected', m === 'register');
    $('submit').textContent = m === 'login' ? L.enter : L.found;
    $('password').autocomplete = m === 'login' ? 'current-password' : 'new-password';
    $('error').textContent = '';
  }
  fetch('/api/theme').then(function (r) { return r.json(); }).then(function (d) {
    var ui = d.ui || {};
    if (ui.brand) document.querySelector('.brand').textContent = ui.brand;
    if (ui.subtitle) document.querySelector('.brand-sub').textContent = ui.subtitle;
    if (ui.loginNote) document.querySelector('.login-foot').textContent = ui.loginNote;
    if (ui.title) document.title = ui.title;
    var l = ui.login || {};
    L = { enter: l.enter || L.enter, found: l.found || L.found };
    if (l.signIn) $('t-login').textContent = l.signIn;
    if (l.register) $('t-reg').textContent = l.register;
    var labels = document.querySelectorAll('.field .label');
    if (l.callsign && labels[0]) labels[0].textContent = l.callsign;
    if (l.passcode && labels[1]) labels[1].textContent = l.passcode;
    setMode(mode);
  }).catch(function () { /* keep the built-in wording */ });
  $('t-login').onclick = function () { setMode('login'); };
  $('t-reg').onclick = function () { setMode('register'); };
  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('submit');
    btn.disabled = true;
    $('error').textContent = '';
    fetch('/api/' + (mode === 'login' ? 'login' : 'register'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('username').value, password: $('password').value })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) { location.href = '/game'; return; }
      $('error').textContent = d.error || 'Something went wrong.';
      btn.disabled = false;
    }).catch(function () { $('error').textContent = 'Cannot reach the server.'; btn.disabled = false; });
  });
})();
