// Story delivery: dialogue arrives as a "call" in a dock at the bottom right that the player answers when convenient;
// answering opens a visual-novel style scene that can be minimized back into the dock. Plus the Comms tab (inbox + archive).
// Purely presentational: it reads what the server has delivered (state.story + /api/story) and tells the server when a
// message was played or read. Nothing here affects the simulation.
(function () {
  var host = null;           // { api, esc, icon, toast, changed }
  var view = null;           // state.story: { items, pending, unreadMail, rev }
  var content = null;        // /api/story: { characters, beats, scenes }
  var fetchedRev = -1, fetching = false;
  var known = null;          // ids seen in the previous view (to announce new mail)
  var ringMin = false;       // the incoming-call card is collapsed to a pill
  var knownPending = {};     // calls already seen ringing, so a brand-new call can expand the card again
  var mailSel = null;
  var p = null;              // the scene being played: { beat, scene, node, i, replay, timer, full, min, last: {left,right} }

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var esc = function (s) { return host.esc(s); };

  function init(h) { host = h; document.addEventListener('keydown', onKey, true); document.addEventListener('click', onClick); }

  function setView(v) {
    var first = known === null;
    view = v;
    if (!first) {
      v.items.filter(function (i) { return i.kind === 'mail' && !known[i.id]; }).forEach(function (i) {
        host.toast('New message' + (nameOf(i.from) ? ' from ' + nameOf(i.from) : '') + ': ' + i.title, true);
      });
    }
    known = {};
    v.items.forEach(function (i) { known[i.id] = true; });
    v.pending.forEach(function (b) { if (!knownPending[b]) { knownPending[b] = true; ringMin = false; } });
    if (v.rev !== fetchedRev && !fetching) load();
    renderDock();
  }

  function load() {
    fetching = true;
    var rev = view.rev;
    fetch('/api/story', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (c) {
      content = c; fetchedRev = rev; fetching = false;
      if (view && view.rev !== fetchedRev) load();
      renderDock(); host.changed();
    }).catch(function () { fetching = false; });
  }

  function nameOf(id) { return content && content.characters[id] ? content.characters[id].name : ''; }
  function unread() { return view ? view.unreadMail + view.pending.length : 0; }

  // ---------------------------------------------------------------- dialogue overlay
  // ---------------------------------------------------------------- the call dock
  function callerOf(beatId) {
    var b = content && content.beats[beatId], sc = b && content.scenes[b.scene];
    var who = sc && sc.nodes[sc.start] && sc.nodes[sc.start].who;
    return who && content.characters[who] ? content.characters[who] : null;
  }
  function avatar(ch) {
    if (ch && ch.portrait) return '<img alt="" src="/theme-assets/' + encodeURIComponent(ch.portrait) + '">';
    return '<span style="--c:' + esc((ch && ch.color) || '#888') + '">' + esc(ch ? ch.name.split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join('') : '?') + '</span>';
  }
  function titleOf(beatId) { var i = view.items.filter(function (x) { return x.id === beatId; })[0]; return i ? i.title : ''; }

  function renderDock() {
    var el = document.getElementById('call');
    var ringing = (view && content) ? view.pending.filter(function (b) { return content.beats[b]; }) : [];
    var html = '', cls = '';
    if (p && p.min) {
      var pc = callerOf(p.beat);
      cls = 'call live';
      html = '<span class="pulse live"></span><span class="call-who">' + (p.replay ? 'Replay' : 'On call') + ' &middot; <b>' + esc(pc ? pc.name : p.scene.title || 'Transmission') + '</b></span>' +
        '<button class="btn primary" data-story="resume">Resume</button><button class="btn" data-story="hangup" title="' + (p.replay ? 'Close' : 'Hang up (it stays in Comms)') + '">' + host.icon('x', 12) + '</button>';
    } else if (!p && ringing.length) {
      var ch = callerOf(ringing[0]);
      if (ringMin) {
        cls = 'call ring min';
        html = '<button class="call-pill" data-story="dockexp"><span class="pulse"></span>' + esc(ch ? ch.name : 'Incoming') + ' is calling' + (ringing.length > 1 ? ' <em>+' + (ringing.length - 1) + '</em>' : '') + '</button>';
      } else {
        cls = 'call ring';
        html = '<div class="call-av" style="--c:' + esc((ch && ch.color) || '#888') + '">' + avatar(ch) + '</div>' +
          '<div class="call-info"><div class="call-label"><span class="pulse"></span>Incoming transmission</div><b>' + esc(ch ? ch.name : 'Unknown') + '</b>' +
          '<small>' + esc(titleOf(ringing[0])) + (ringing.length > 1 ? ' &middot; ' + (ringing.length - 1) + ' more waiting' : '') + '</small></div>' +
          '<div class="call-btns"><button class="btn primary" data-story="answer" data-beat="' + esc(ringing[0]) + '">Answer</button>' +
          '<button class="btn" data-story="dockmin" title="Minimize" aria-label="Minimize">&minus;</button></div>' +
          '<div class="call-skip"><button class="link" data-story="skip" data-beat="' + esc(ringing[0]) + '">Skip</button>' + (ringing.length > 1 ? '<button class="link" data-story="skipall">Skip all</button>' : '') + '</div>';
      }
    }
    if (!html) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'call'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    if (el.dataset.h !== cls + html) { el.className = cls; el.innerHTML = html; el.dataset.h = cls + html; }
  }

  function play(beatId, replay) {
    var b = content && content.beats[beatId];
    var sceneId = b && b.scene;
    var scene = sceneId && content.scenes[sceneId];
    if (!scene || p) return;
    p = { beat: beatId, scene: scene, node: scene.start, i: 0, replay: replay, full: false, last: { left: null, right: null } };
    var el = document.createElement('div');
    el.id = 'vn'; el.className = 'vn'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
    document.body.appendChild(el);
    draw();
    renderDock();
  }

  function cur() { return p.scene.nodes[p.node]; }
  function charOf(id) { return id && content.characters[id] ? content.characters[id] : null; }

  function portrait(ch, active) {
    if (!ch) return '';
    var inner = ch.portrait
      ? '<img alt="" src="/theme-assets/' + encodeURIComponent(ch.portrait) + '">'
      : '<span class="vn-ph" style="--c:' + esc(ch.color || '#888') + '">' + esc(ch.name.split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join('')) + '</span>';
    return '<div class="vn-char' + (active ? ' on' : '') + '">' + inner + '</div>';
  }

  function draw() {
    var el = document.getElementById('vn');
    if (!el) return;
    var n = cur(), ch = charOf(n.who);
    if (ch) p.last[ch.side === 'left' ? 'left' : 'right'] = n.who;
    var text = n.text[p.i];
    var lastPassage = p.i >= n.text.length - 1;
    var bg = p.scene.background ? ' style="background-image:url(/theme-assets/' + encodeURIComponent(p.scene.background) + ')"' : '';
    var pend = view ? view.pending.length : 0;
    el.innerHTML =
      '<div class="vn-bg"' + bg + '></div><div class="vn-shade"></div>' +
      '<div class="vn-tools">' +
        (p.scene.title ? '<span class="vn-title">' + esc(p.scene.title) + '</span>' : '') +
        '<span class="sp"></span>' +
        '<button class="btn" data-story="minimize" title="Keep the call going in the corner (Esc)">Minimize</button>' +
        '<button class="btn" data-story="close">' + (p.replay ? 'Close' : 'Skip') + '</button>' +
        (!p.replay && pend > 1 ? '<button class="btn" data-story="skipall">Skip all (' + pend + ')</button>' : '') +
      '</div>' +
      '<div class="vn-stage"><div class="vn-side left">' + portrait(charOf(p.last.left), n.who === p.last.left) + '</div><div class="vn-side right">' + portrait(charOf(p.last.right), n.who === p.last.right) + '</div></div>' +
      '<div class="vn-box" data-story="advance" tabindex="0">' +
        (ch ? '<div class="vn-name" style="--c:' + esc(ch.color || '#ddd') + '">' + esc(ch.name) + (n.tag ? ' <em>' + esc(n.tag) + '</em>' : '') + (ch.title ? ' <small>' + esc(ch.title) + '</small>' : '') + '</div>' : '') +
        '<div class="vn-text' + (ch ? '' : ' narr') + '" id="vn-text"></div>' +
        '<div class="vn-choices" id="vn-choices"></div>' +
        '<div class="vn-hint" id="vn-hint">Click or press Space to continue</div>' +
      '</div>';
    reveal(text, lastPassage, n);
    var box = el.querySelector('.vn-box'); if (box) box.focus({ preventScroll: true });
  }

  // Type the passage out; a click finishes it, the next click moves on.
  function reveal(text, lastPassage, n) {
    var t = document.getElementById('vn-text');
    clearInterval(p.timer);
    var k = 0;
    p.full = false;
    var done = function () {
      p.full = true; clearInterval(p.timer);
      t.textContent = text;
      var ch = document.getElementById('vn-choices'), hint = document.getElementById('vn-hint');
      if (lastPassage && n.choices) {
        hint.style.visibility = 'hidden';
        ch.innerHTML = (n.prompt ? '<div class="vn-prompt">' + esc(n.prompt) + '</div>' : '') + n.choices.map(function (c, i) { return '<button class="btn vn-choice" data-story="choose" data-i="' + i + '"><kbd>' + (i + 1) + '</kbd> ' + esc(c.label) + '</button>'; }).join('');
      } else {
        hint.style.visibility = 'visible';
        hint.textContent = lastPassage && !n.next ? 'Click to end' : 'Click or press Space to continue';
      }
    };
    if (reduce) { done(); return; }
    t.textContent = '';
    p.timer = setInterval(function () { k += 2; if (k >= text.length) done(); else t.textContent = text.slice(0, k); }, 16);
    p.done = done;
  }

  function advance() {
    if (!p) return;
    if (!p.full) { p.done ? p.done() : null; return; }
    var n = cur();
    if (p.i < n.text.length - 1) { p.i++; draw(); return; }
    if (n.choices) return; // waits for a choice
    if (n.next) { p.node = n.next; p.i = 0; draw(); return; }
    finish(true);
  }

  function choose(i) {
    var n = cur();
    if (!p || !p.full || !n.choices || p.i < n.text.length - 1 || !n.choices[i]) return;
    p.node = n.choices[i].next; p.i = 0; draw();
  }

  function close() {
    if (!p) return;
    clearInterval(p.timer);
    var el = document.getElementById('vn'); if (el) el.remove();
    p = null;
  }
  // `seen`: the player played it through or skipped it (as opposed to hanging up, which keeps it waiting).
  function finish(seen) {
    var beat = p && p.beat, replay = p && p.replay;
    close();
    if (seen && !replay && beat) {
      view.items.forEach(function (i) { if (i.id === beat) i.seen = true; });
      view.pending = view.pending.filter(function (b) { return b !== beat; });
      host.api('story-seen', { beat: beat }).catch(function () { /* retried next session */ });
    } else if (!seen && !replay) ringMin = true;
    renderDock(); host.changed();
  }
  function minimize() {
    if (!p) return;
    clearInterval(p.timer);
    p.min = true;
    var el = document.getElementById('vn'); if (el) el.style.display = 'none';
    renderDock();
  }
  function resume() {
    if (!p || !p.min) return;
    p.min = false;
    var el = document.getElementById('vn'); if (el) el.style.display = '';
    draw(); renderDock();
  }

  function onKey(e) {
    if (!p || p.min) return;
    if (e.key === ' ' || e.key === 'Enter') { if (e.target.closest && e.target.closest('.vn-tools, .vn-choice')) return; e.preventDefault(); e.stopImmediatePropagation(); advance(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); minimize(); }
    else if (/^[1-9]$/.test(e.key)) { e.stopImmediatePropagation(); choose(+e.key - 1); }
  }

  function onClick(e) {
    var el = e.target.closest && e.target.closest('[data-story]');
    if (!el) return;
    var a = el.dataset.story;
    if (a === 'advance') advance();
    else if (a === 'choose') choose(+el.dataset.i);
    else if (a === 'minimize') minimize();
    else if (a === 'resume') resume();
    else if (a === 'hangup') finish(false);
    else if (a === 'close') { if (p.replay) finish(false); else finish(true); }
    else if (a === 'dockmin') { ringMin = true; renderDock(); }
    else if (a === 'dockexp') { ringMin = false; renderDock(); }
    else if (a === 'answer') play(el.dataset.beat, false);
    else if (a === 'skip') {
      view.items.forEach(function (i) { if (i.id === el.dataset.beat) i.seen = true; });
      view.pending = view.pending.filter(function (b) { return b !== el.dataset.beat; });
      host.api('story-seen', { beat: el.dataset.beat }).catch(function () { /* ignore */ });
      renderDock(); host.changed();
    } else if (a === 'skipall') {
      close();
      view.items.forEach(function (i) { if (i.kind === 'dialogue') i.seen = true; });
      view.pending = [];
      host.api('story-seen', { all: true }).catch(function () { /* ignore */ });
      renderDock(); host.changed();
    } else if (a === 'play') { play(el.dataset.beat, el.dataset.replay === '1'); }
    else if (a === 'scene') play(el.dataset.beat, true);
    else if (a === 'mail') {
      mailSel = mailSel === el.dataset.beat ? null : el.dataset.beat;
      var it = view.items.filter(function (i) { return i.id === mailSel; })[0];
      if (it && !it.seen) { it.seen = true; view.unreadMail = Math.max(0, view.unreadMail - 1); host.api('story-seen', { beat: it.id }).catch(function () { /* ignore */ }); }
      host.changed();
    }
  }

  // ---------------------------------------------------------------- Comms tab
  function commsHtml() {
    if (!view || !view.items.length) return '<div class="empty-state">' + host.icon('mail', 36) + '<div>No messages yet.</div></div>';
    var pending = view.items.filter(function (i) { return i.kind === 'dialogue' && !i.seen; });
    var mail = view.items.filter(function (i) { return i.kind === 'mail'; }).reverse();
    var archive = view.items.filter(function (i) { return i.kind === 'dialogue' && i.seen; }).reverse();
    var h = '';
    if (pending.length) {
      h += '<div class="label sec">Waiting calls</div>' + pending.map(function (i) {
        return '<div class="vn-card"><div><b>' + esc(i.title) + '</b><div class="dim" style="font-size:11px">Waiting for you</div></div>' +
          '<button class="btn primary" data-story="answer" data-beat="' + esc(i.id) + '">' + host.icon('play', 12) + ' Answer</button></div>';
      }).join('');
    }
    h += '<div class="label sec">Inbox</div>';
    if (!mail.length) h += '<div class="dim" style="font-size:12px">Nothing yet.</div>';
    h += mail.map(function (i) {
      var open = mailSel === i.id, c = content && content.beats[i.id], m = c && c.mail;
      var from = nameOf(i.from) || 'Unknown';
      var body = '';
      if (open && m) {
        body = '<div class="mail-body">' + m.body.map(function (t) { return '<p>' + esc(t) + '</p>'; }).join('') +
          (c.scene ? '<button class="btn" data-story="scene" data-beat="' + esc(i.id) + '">' + host.icon('play', 12) + ' Open transmission</button>' : '') + '</div>';
      }
      return '<div class="mail' + (i.seen ? '' : ' unread') + (open ? ' open' : '') + '"><button class="mail-head" data-story="mail" data-beat="' + esc(i.id) + '" aria-expanded="' + open + '">' +
        '<span class="dot"></span><span class="mail-from">' + esc(from) + '</span><span class="mail-subj">' + esc(i.title) + '</span><small>#' + i.tick + '</small></button>' + body + '</div>';
    }).join('');
    if (archive.length) {
      h += '<div class="label sec">Archive</div>' + archive.map(function (i) {
        return '<div class="vn-card"><div><b>' + esc(i.title) + '</b><div class="dim" style="font-size:11px">tick #' + i.tick + '</div></div>' +
          '<button class="btn" data-story="play" data-beat="' + esc(i.id) + '" data-replay="1">Replay</button></div>';
      }).join('');
    }
    return h;
  }

  window.Story = { init: init, setView: setView, commsHtml: commsHtml, unread: unread };
})();
