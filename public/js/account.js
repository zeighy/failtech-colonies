// The commander's account, from the game's menu: passcode, email address, and an authenticator code they can opt into.
// It talks to /api/account/* directly (not through the game's api(), which treats a 401 as signed out).
(function () {
  var esc = function (s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function send(path, body) {
    return fetch('/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Something went wrong.' }; }); });
  }
  var field = function (label, name, type, extra) { return '<label class="acc-f"><span class="label">' + label + '</span><input name="' + name + '" type="' + (type || 'text') + '" ' + (extra || '') + '></label>'; };
  var codeIn = function () { return field('Code', 'code', 'text', 'inputmode="numeric" autocomplete="one-time-code" maxlength="6"'); };

  function open() {
    var bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = '<div class="modal account" role="dialog" aria-modal="true"><h2>Account</h2><div id="acc-body" class="dim">…</div><div class="actions"><button class="btn" data-x>Close</button></div></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', function (e) { if (e.target === bg || e.target.closest('[data-x]')) bg.remove(); });
    var body = bg.querySelector('#acc-body');
    var msg = function (form, text, ok) { var m = form.querySelector('.acc-msg'); m.className = 'acc-msg ' + (ok ? 'good' : 'bad'); m.textContent = text || ''; };

    function draw() {
      send('account').then(function (a) {
        if (!a.ok) { body.textContent = a.error || 'Unavailable.'; return; }
        body.className = '';
        body.innerHTML =
          '<div class="acc-row"><span class="label">Callsign</span><b>' + esc(a.username) + '</b></div>' +
          '<div class="acc-row"><span class="label">Email</span><b>' + esc(a.email || '—') + '</b>' + (a.email ? (a.verified ? ' <span class="good">confirmed</span>' : ' <span class="warn">unconfirmed</span>') : '') + '</div>' +
          '<form data-f="pass"><div class="label sec">Passcode</div>' + field('Current', 'password', 'password', 'autocomplete="current-password"') + field('New', 'newPassword', 'password', 'autocomplete="new-password"') +
            '<div class="acc-msg"></div><button class="btn">Change</button></form>' +
          '<form data-f="email"><div class="label sec">Email</div>' + field('New address', 'email', 'email', 'autocomplete="email"') + field('Passcode', 'password', 'password', 'autocomplete="current-password"') +
            '<div class="acc-code" hidden>' + codeIn() + '</div><div class="acc-msg"></div><button class="btn">Send code</button></form>' +
          '<form data-f="totp"><div class="label sec">Authenticator code ' + (a.totp ? '<span class="good">on</span>' : '<span class="dim">off</span>') + '</div>' +
            (a.totp ? codeIn() + field('Passcode', 'password', 'password', 'autocomplete="current-password"') + '<div class="acc-msg"></div><button class="btn danger">Turn off</button>'
              : '<div class="acc-setup"></div>' + field('Passcode', 'password', 'password', 'autocomplete="current-password"') + '<div class="acc-msg"></div><button class="btn">Set up</button>') + '</form>';
        bg.querySelectorAll('form').forEach(function (f) { f.addEventListener('submit', function (e) { e.preventDefault(); submit(f, a); }); });
      });
    }
    function val(f, n) { var el = f.querySelector('[name=' + n + ']'); return el ? el.value : ''; }
    function submit(f, a) {
      var btn = f.querySelector('button'); btn.disabled = true;
      var done = function () { btn.disabled = false; };
      var kind = f.dataset.f;
      if (kind === 'pass') {
        send('account/password', { password: val(f, 'password'), newPassword: val(f, 'newPassword') }).then(function (d) { done(); if (d.ok) { f.reset(); msg(f, 'Changed', true); } else msg(f, d.error); });
      } else if (kind === 'email') {
        if (f.dataset.step === 'code') {
          send('verify', { code: val(f, 'code').trim() }).then(function (d) { done(); if (d.ok) draw(); else msg(f, d.error); });
        } else {
          send('account/email', { email: val(f, 'email').trim(), password: val(f, 'password') }).then(function (d) {
            done();
            if (!d.ok) return msg(f, d.error);
            f.dataset.step = 'code'; f.querySelector('.acc-code').hidden = false; btn.textContent = 'Confirm';
            msg(f, 'Code sent to ' + d.sentTo, true);
          });
        }
      } else if (kind === 'totp' && a.totp) {
        send('account/totp/disable', { code: val(f, 'code').trim(), password: val(f, 'password') }).then(function (d) { done(); if (d.ok) draw(); else msg(f, d.error); });
      } else if (kind === 'totp') {
        if (f.dataset.step === 'code') {
          send('account/totp/enable', { code: val(f, 'code').trim() }).then(function (d) { done(); if (d.ok) draw(); else msg(f, d.error); });
        } else {
          send('account/totp/setup', { password: val(f, 'password') }).then(function (d) {
            done();
            if (!d.ok) return msg(f, d.error);
            f.dataset.step = 'code';
            f.querySelector('.acc-setup').innerHTML = '<img class="acc-qr" alt="QR code" src="' + esc(d.qr) + '"><div class="acc-key">' + esc(d.secret.replace(/(.{4})/g, '$1 ').trim()) + '</div><div class="acc-uri">' + esc(d.uri) + '</div>' + codeIn();
            f.querySelector('[name=password]').closest('label').hidden = true;
            btn.textContent = 'Turn on';
            msg(f, '');
          });
        }
      }
    }
    draw();
  }
  window.Account = { open: open };
})();
