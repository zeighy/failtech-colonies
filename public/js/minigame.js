// Trace recovery: the minigames on the Data page. Presentational only. The server makes each puzzle, keeps its answer and
// judges every move (src/minigames.js); this draws what it sends and posts the player's moves. The relay grid is turned
// here and checked here for convenience, but only the server's check counts.
(function () {
  var H = null; // host: { S(), act(path, body, okMsg), esc, icon, toast, now() }
  var cur = null;     // the open session, as the server last described it
  var local = null;   // per-session client state: cipher draft, sweep flags, relay turns
  var result = null;  // the reply that ended the session
  var bg = null, timer = null, busy = false, timedOut = false;

  var GLYPHS = ['◆', '▲', '●', '■', '✚', '★', '⬢', '✦'];
  var GCOL = ['#4cc9f0', '#ff9f1c', '#5ad17a', '#ff5252', '#ffd23f', '#c77dff', '#f28482', '#cdd5dd'];

  function init(host) { H = host; document.addEventListener('click', onClick); document.addEventListener('contextmenu', onContext); }
  var esc = function (s) { return H.esc(s); };
  function M() { var S = H.S(); return S && S.minigame; }

  function span(ms) {
    ms = Math.max(0, ms);
    var h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000);
    return h ? h + 'h ' + (m < 10 ? '0' : '') + m + 'm' : m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ---- the section on the Data page --------------------------------------------------------------------------------
  function section() {
    var G = M();
    if (!G) return '';
    var h = '<div class="sheet-h">Trace recovery</div>';
    if (!G.unlocked) return h + '<div class="dim" style="font-size:12px">Opens once you have read a data packet. Solve a short puzzle to recover a trace toward the next fragment, the same as a recovery rig finds. Harder puzzles recover more.</div>';
    var freeLeft = G.free.used < G.free.limit, paidLeft = G.paid.used < G.paid.limit, afford = G.standing.spendable >= G.cost;
    var reset = span(G.nextReset - H.now());
    h += '<div class="mg-box"><div class="mg-stats">' +
      '<div><span class="label">Spendable standing</span><b class="num">' + G.standing.spendable + '</b></div>' +
      '<div><span class="label">Spent</span><b class="num dimb">' + G.standing.spent + '</b></div>' +
      '<div><span class="label">Free trace</span><b class="' + (freeLeft ? 'good' : 'dimb') + '">' + (freeLeft ? 'Ready' : 'in ' + reset) + '</b></div>' +
      '<div><span class="label">Paid today</span><b class="num dimb">' + G.paid.used + ' / ' + G.paid.limit + '</b></div></div>';
    h += '<div class="dim" style="font-size:12px;margin:8px 0">Solve a short puzzle to recover a trace toward the next fragment: 1 step at L1–L2, 2 at L3–L4, 3 at L5. You get one free trace a day (it resets at midnight, server time). After that, each trace costs ' + G.cost + ' standing. Earned standing (' + G.standing.earned + ') still counts in full with the factions.</div>';
    if (G.active) h += '<div class="actions"><button class="btn primary" data-mg="resume">' + H.icon('play', 12) + ' Resume ' + esc(G.active.name) + '</button></div>';
    else {
      var btns = [];
      if (freeLeft) btns.push('<button class="btn primary" data-mg="start" data-paid="free">' + H.icon('play', 12) + ' Free trace</button>');
      btns.push('<button class="btn' + (freeLeft ? '' : ' primary') + '" data-mg="start" data-paid="standing"' + (paidLeft && afford ? '' : ' disabled') + '>Trace · ' + G.cost + ' standing</button>');
      h += '<div class="actions">' + btns.join('') + '</div>';
      if (!paidLeft) h += '<div class="dim" style="font-size:12px;margin-top:6px">That is all the paid traces for today. More in ' + reset + '.</div>';
      else if (!afford) h += '<div class="dim" style="font-size:12px;margin-top:6px">Fill postings to earn more standing.</div>';
    }
    h += '<div class="mg-games">' + Object.keys(G.games).map(function (k) {
      var g = G.games[k];
      return '<span title="' + esc(g.blurb) + '">' + esc(g.name) + ' <span class="dim">L' + (g.level + 1) + '/' + g.levels + '</span></span>';
    }).join('') + '</div>';
    return h + '</div>';
  }

  // ---- the play window --------------------------------------------------------------------------------------------
  function open(session) {
    if (!cur || cur.id !== session.id || !local) { local = fresh(session); result = null; timedOut = false; }
    cur = session;
    if (!bg) {
      bg = document.createElement('div');
      bg.className = 'modal-bg mg-bg';
      bg.innerHTML = '<div class="modal mg" role="dialog" aria-modal="true" data-lock></div>';
      document.body.appendChild(bg);
    }
    clearInterval(timer); timer = setInterval(tickClock, 250);
    draw();
  }
  function close() { clearInterval(timer); timer = null; if (bg) bg.remove(); bg = null; cur = null; local = null; result = null; }
  function fresh(s) {
    if (s.kind === 'cipher') return { draft: [] };
    if (s.kind === 'sweep') return { flags: {}, flagMode: false };
    if (s.kind === 'relay') return { turns: s.game.tiles.map(function () { return 0; }) };
    if (s.kind === 'parity') return { cells: new Array(s.game.size * s.game.size).fill(0), markMode: false };
    if (s.kind === 'splice') return { chain: [] };
    return {};
  }
  function tickClock() {
    if (!cur || result) return;
    var left = cur.expiresAt - H.now();
    var el = bg && bg.querySelector('[data-mg-clock]');
    if (el) { el.textContent = span(left); el.classList.toggle('bad', left < 30000); }
    if (left <= 0 && !timedOut) { timedOut = true; send('minigame-quit', { id: cur.id }); }
  }

  function send(path, body) {
    if (busy) return Promise.resolve(null);
    busy = true;
    return H.act(path, body).then(function (d) {
      busy = false;
      if (!d || !d.ok) return d;
      if (d.session && cur && d.session.id === cur.id) { cur = d.session; if (d.status && d.status !== 'active') { result = d; clearInterval(timer); } }
      draw();
      return d;
    }, function () { busy = false; });
  }

  function draw() {
    if (!bg || !cur) return;
    var box = bg.querySelector('.modal'), G = M(), info = G && G.games[cur.kind];
    var h = '<div class="mg-head"><h2>' + esc(cur.name) + '</h2><span class="dim">Level ' + (cur.level + 1) + '</span>' +
      (result ? '' : '<span class="mg-clock num" data-mg-clock>' + span(cur.expiresAt - H.now()) + '</span>') + '</div>';
    if (info && !result) h += '<p class="mg-blurb">' + esc(info.blurb) + '</p>';
    if (result) h += outcome();
    h += '<div class="mg-board">' + ({ cipher: cipher, sweep: sweep, relay: relay, parity: parity, splice: splice }[cur.kind] || function () { return ''; })() + '</div>';
    var submit = cur.kind === 'relay' ? '<button class="btn primary" data-mg="transmit"' + (relayDone() ? '' : ' disabled') + '>Transmit</button>'
      : cur.kind === 'parity' ? '<button class="btn primary" data-mg="commit">Commit</button>'
      : cur.kind === 'splice' ? '<button class="btn primary" data-mg="splice"' + (local.chain.length === cur.game.length ? '' : ' disabled') + '>Transmit</button>' : '';
    h += '<div class="actions">' + (result ? '<button class="btn primary" data-mg="close">Close</button>' : '<button class="btn" data-mg="quit">Give up</button>' + submit) + '</div>';
    box.innerHTML = h;
  }
  function outcome() {
    var r = result, won = r.status === 'won';
    var why = { lost: 'The trace was lost.', expired: 'Time ran out and the trace was lost.', abandoned: 'You let the trace go.' }[r.status] || '';
    var h = '<div class="mg-result ' + (won ? 'good' : 'bad') + '"><b>' + (won ? 'Trace recovered' : 'Trace lost') + '</b>';
    if (won && r.award) {
      var a = r.award, gain = a.steps > 1 ? '+' + a.steps + ' progress. ' : '';
      h += '<div>' + gain + (a.fragment ? (a.fragments > 1 ? a.fragments + ' data fragments completed' : 'That completes a data fragment') + (a.carried ? ', ' + a.carried + ' of ' + a.of + ' toward the next.' : '.') : a.wins + ' of ' + a.of + ' toward the next fragment.') + '</div>';
    }
    else if (!won) h += '<div>' + why + '</div>';
    if (r.levelChanged) h += '<div class="dim">This puzzle will be ' + (won ? 'harder' : 'easier') + ' next time.</div>';
    return h + '</div>';
  }

  // cipher
  function glyph(k, cls) { return '<span class="mg-g ' + (cls || '') + '" style="--g:' + GCOL[k % GCOL.length] + '">' + GLYPHS[k % GLYPHS.length] + '</span>'; }
  function cipher() {
    var g = cur.game, h = '<div class="mg-cipher">';
    g.guesses.forEach(function (x) {
      h += '<div class="mg-row">' + x.guess.map(function (k) { return glyph(k); }).join('') + '<span class="mg-score"><b class="good">' + x.exact + '</b> exact · <b class="warn">' + x.near + '</b> near</span></div>';
    });
    if (g.code) h += '<div class="mg-row key"><span class="label">Key</span>' + g.code.map(function (k) { return glyph(k); }).join('') + '</div>';
    if (!result) {
      var slots = '';
      for (var i = 0; i < g.length; i++) slots += local.draft[i] !== undefined ? '<button class="mg-slot" data-mg="unslot" data-i="' + i + '">' + glyph(local.draft[i]) + '</button>' : '<span class="mg-slot empty"></span>';
      h += '<div class="mg-row draft">' + slots + '<span class="mg-score dim">' + (g.maxGuesses - g.guesses.length) + ' guess' + (g.maxGuesses - g.guesses.length === 1 ? '' : 'es') + ' left</span></div>';
      h += '<div class="mg-pal">';
      for (var k = 0; k < g.symbols; k++) h += '<button class="mg-key" data-mg="sym" data-k="' + k + '">' + glyph(k) + '</button>';
      h += '<button class="btn" data-mg="back">⌫</button><button class="btn primary" data-mg="guess"' + (local.draft.length === g.length && local.draft.every(function (x) { return x !== undefined; }) ? '' : ' disabled') + '>Guess</button></div>';
    }
    return h + '</div>';
  }
  // sweep
  function sweep() {
    var g = cur.game, n = g.width * g.height, bad = {}, blown = {}, i;
    (g.corrupted || []).forEach(function (x) { bad[x] = 1; });
    g.blown.forEach(function (x) { blown[x] = 1; });
    var flags = Object.keys(local.flags).length;
    var h = '<div class="mg-sweepbar"><span>Integrity <b class="' + (g.integrity - g.hits > 1 ? 'good' : 'bad') + '">' + (g.integrity - g.hits) + '</b> / ' + g.integrity + '</span><span>Corrupted <b>' + g.bad + '</b>' + (flags ? ' <span class="dim">(' + flags + ' marked)</span>' : '') + '</span>' +
      (result ? '' : '<button class="btn' + (local.flagMode ? ' primary' : '') + '" data-mg="flagmode">' + (local.flagMode ? 'Marking' : 'Mark') + '</button>') + '</div>';
    h += '<div class="mg-sweep" style="grid-template-columns:repeat(' + g.width + ',1fr)">';
    for (i = 0; i < n; i++) {
      var o = g.open[i];
      if (o !== undefined) h += '<span class="mg-c open n' + o + '">' + (o || '') + '</span>';
      else if (blown[i]) h += '<span class="mg-c blown">✕</span>';
      else if (bad[i]) h += '<span class="mg-c bad">✕</span>';
      else h += '<button class="mg-c' + (local.flags[i] ? ' flag' : '') + '" data-mg="cell" data-i="' + i + '"' + (result ? ' disabled' : '') + '>' + (local.flags[i] ? '⚑' : '') + '</button>';
    }
    return h + '</div>' + (result ? '' : '<div class="dim mg-hint">Tap to read a sector. Right-click (or Mark) flags one you think is corrupted.</div>');
  }
  // relay: tiles are bit masks of open sides (N 1, E 2, S 4, W 8)
  function turn(m, k) { for (var i = 0; i < (k & 3); i++) m = ((m << 1) | (m >> 3)) & 15; return m; }
  function masks() { var g = cur.game; return result && g.solution && result.status !== 'won' ? g.solution : g.tiles.map(function (m, i) { return turn(m, local.turns[i]); }); }
  var D = [[1, 0, -1, 4], [2, 1, 0, 8], [4, 0, 1, 1], [8, -1, 0, 2]];
  function powered(ms) {
    var size = cur.game.size, seen = {}, todo = [cur.game.core]; seen[cur.game.core] = 1;
    while (todo.length) {
      var i = todo.pop(), x = i % size, y = Math.floor(i / size);
      D.forEach(function (d) {
        if (!(ms[i] & d[0])) return;
        var nx = x + d[1], ny = y + d[2], j = ny * size + nx;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size || !(ms[j] & d[3]) || seen[j]) return;
        seen[j] = 1; todo.push(j);
      });
    }
    return seen;
  }
  function relayDone() {
    if (!cur || cur.kind !== 'relay') return false;
    var ms = masks(), size = cur.game.size, ok = true;
    ms.forEach(function (m, i) {
      var x = i % size, y = Math.floor(i / size);
      D.forEach(function (d) { if (!(m & d[0])) return; var nx = x + d[1], ny = y + d[2]; if (nx < 0 || ny < 0 || nx >= size || ny >= size || !(ms[ny * size + nx] & d[3])) ok = false; });
    });
    return ok && Object.keys(powered(ms)).length === ms.length;
  }
  function tileSvg(m, core) {
    var p = '';
    if (m & 1) p += 'M50 50V0'; if (m & 2) p += 'M50 50H100'; if (m & 4) p += 'M50 50V100'; if (m & 8) p += 'M50 50H0';
    return '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="' + p + '"/>' + (core ? '<rect x="30" y="30" width="40" height="40" rx="6"/>' : '<circle cx="50" cy="50" r="' + ((m & (m - 1)) ? 9 : 14) + '"/>') + '</svg>';
  }
  function relay() {
    var g = cur.game, ms = masks(), on = powered(ms), h = '<div class="mg-relay" style="grid-template-columns:repeat(' + g.size + ',1fr)">';
    ms.forEach(function (m, i) {
      h += '<button class="mg-t' + (on[i] ? ' on' : '') + (i === g.core ? ' core' : '') + '" data-mg="rot" data-i="' + i + '"' + (result ? ' disabled' : '') + '>' + tileSvg(m, i === g.core) + '</button>';
    });
    var lit = Object.keys(on).length;
    return h + '</div><div class="dim mg-hint">' + (result && result.status !== 'won' ? 'One working layout.' : lit + ' of ' + ms.length + ' conduits carry signal. Tap to turn clockwise, right-click to turn back.') + '</div>';
  }

  // parity: local cells are 0 unknown, 1 intact, 2 marked void
  function runs(bits) { var out = [], r = 0; bits.forEach(function (b) { if (b) r++; else if (r) { out.push(r); r = 0; } }); if (r) out.push(r); return out; }
  function clueHtml(c, bits, cls) {
    var ok = c && runs(bits).join(',') === c.join(',');
    return '<span class="mg-clue ' + cls + (ok ? ' ok' : '') + (c ? '' : ' lost') + '">' + (c ? (c.length ? c : [0]).map(function (x) { return '<i>' + x + '</i>'; }).join('') : '<i>?</i>') + '</span>';
  }
  function parity() {
    var g = cur.game, n = g.size, show = result && g.solution && result.status !== 'won', x, y;
    var cell = function (i) { return show ? g.solution[i] : local.cells[i] === 1 ? 1 : 0; };
    var row = function (y) { var b = []; for (var x = 0; x < n; x++) b.push(cell(y * n + x)); return b; };
    var col = function (x) { var b = []; for (var y = 0; y < n; y++) b.push(cell(y * n + x)); return b; };
    var left = g.maxCommits - g.commits.length;
    var h = '<div class="mg-sweepbar"><span>Commits left <b class="' + (left > 1 ? 'good' : 'bad') + '">' + left + '</b> / ' + g.maxCommits + '</span>' +
      (g.commits.length ? '<span>Last commit <b class="warn">' + g.commits[g.commits.length - 1].off + '</b> cells off</span>' : '') +
      (result ? '' : '<button class="btn' + (local.markMode ? ' primary' : '') + '" data-mg="pmark">' + (local.markMode ? 'Marking void' : 'Mark void') + '</button>') + '</div>';
    h += '<div class="mg-parity" style="grid-template-columns:auto repeat(' + n + ',1fr)"><span></span>';
    for (x = 0; x < n; x++) h += clueHtml(g.cols[x], col(x), 'col');
    for (y = 0; y < n; y++) {
      h += clueHtml(g.rows[y], row(y), 'row');
      for (x = 0; x < n; x++) {
        var i = y * n + x, v = show ? g.solution[i] : local.cells[i];
        h += '<button class="mg-p' + (v === 1 ? ' on' : v === 2 ? ' void' : '') + ((x + 1) % 5 === 0 && x + 1 < n ? ' br' : '') + ((y + 1) % 5 === 0 && y + 1 < n ? ' bb' : '') + '" data-mg="pcell" data-i="' + i + '"' + (result ? ' disabled' : '') + '>' + (v === 2 ? '·' : '') + '</button>';
      }
    }
    return h + '</div>' + (show ? '<div class="dim mg-hint">The block as it was.</div>' : '');
  }
  // splice: symbols are 0..n-1, BEGIN -1, END -2
  function sym(k) { return k === -1 ? '<span class="mg-g sm mk">BEGIN</span>' : k === -2 ? '<span class="mg-g sm mk">END</span>' : glyph(k, 'sm'); }
  function fits(a, b, k) { if (a.length < k || b.length < k) return false; for (var i = 0; i < k; i++) { var s = a[a.length - k + i]; if (s < 0 || s !== b[i]) return false; } return true; }
  function splice() {
    var g = cur.game, show = result && g.order && result.status !== 'won', chain = show ? g.order : local.chain, inChain = {}, h;
    chain.forEach(function (p) { inChain[p] = 1; });
    var left = g.maxAttempts - g.attempts.length, last = g.attempts[g.attempts.length - 1];
    h = '<div class="mg-sweepbar"><span>Attempts left <b class="' + (left > 1 ? 'good' : 'bad') + '">' + left + '</b> / ' + g.maxAttempts + '</span>' +
      (last ? '<span>Last attempt <b class="warn">' + last.links + '</b> of ' + (g.length - 1) + ' links right</span>' : '') +
      '<span class="dim">' + g.length + ' pieces' + (g.decoys ? ' · ' + g.decoys + ' not from this log' : '') + ' · overlap ' + g.overlap + '</span></div>';
    h += '<div class="mg-chain">' + (chain.length ? '' : '<div class="dim mg-hint">Empty chain.</div>');
    chain.forEach(function (p, i) {
      var ok = i && fits(g.pieces[chain[i - 1]], g.pieces[p], g.overlap);
      if (i) h += '<div class="mg-link ' + (ok ? 'good' : 'bad') + '">' + (ok ? '⋮' : '✕') + '</div>';
      h += '<button class="mg-piece" data-mg="unpiece" data-i="' + i + '"' + (result ? ' disabled' : '') + '>' + g.pieces[p].map(sym).join('') + '</button>';
    });
    h += '</div>';
    if (!result) {
      h += '<div class="label" style="margin-top:10px">Pieces</div><div class="mg-pool">';
      g.pieces.forEach(function (pc, i) { if (!inChain[i]) h += '<button class="mg-piece" data-mg="piece" data-i="' + i + '"' + (local.chain.length >= g.length ? ' disabled' : '') + '>' + pc.map(sym).join('') + '</button>'; });
      h += '</div>';
    } else if (show) h += '<div class="dim mg-hint">The log as it was.</div>';
    return h;
  }

  // ---- input ------------------------------------------------------------------------------------------------------
  function onContext(e) {
    if (!bg || !cur || result) return;
    var el = e.target.closest('[data-mg]');
    if (!el || !bg.contains(el)) return;
    if (el.dataset.mg === 'cell') { e.preventDefault(); toggleFlag(+el.dataset.i); }
    else if (el.dataset.mg === 'rot') { e.preventDefault(); local.turns[+el.dataset.i] = (local.turns[+el.dataset.i] + 3) % 4; draw(); }
    else if (el.dataset.mg === 'pcell') { e.preventDefault(); markVoid(+el.dataset.i); }
  }
  function markVoid(i) { local.cells[i] = local.cells[i] === 2 ? 0 : 2; draw(); }
  function toggleFlag(i) { if (local.flags[i]) delete local.flags[i]; else local.flags[i] = 1; draw(); }
  function onClick(e) {
    var el = e.target.closest('[data-mg]');
    if (!el || el.disabled) return;
    var a = el.dataset.mg, G = M();
    if (a === 'start') {
      send('minigame-start', { paid: el.dataset.paid }).then(function (d) { if (d && d.ok && d.session) open(d.session); });
      return;
    }
    if (a === 'resume') { if (G && G.active) open(G.active); return; }
    if (!bg || !bg.contains(el)) return;
    if (a === 'close') { close(); return; }
    if (!cur || result) return;
    if (a === 'quit') send('minigame-quit', { id: cur.id });
    else if (a === 'sym') { var L = cur.game.length, at = -1; for (var i = 0; i < L; i++) if (local.draft[i] === undefined) { at = i; break; } if (at >= 0) { local.draft[at] = +el.dataset.k; draw(); } }
    else if (a === 'unslot') { local.draft[+el.dataset.i] = undefined; while (local.draft.length && local.draft[local.draft.length - 1] === undefined) local.draft.pop(); draw(); }
    else if (a === 'back') { local.draft.pop(); draw(); }
    else if (a === 'guess') send('minigame-move', { id: cur.id, input: { guess: local.draft.slice() } }).then(function (d) { if (d && d.ok) { local.draft = []; draw(); } });
    else if (a === 'flagmode') { local.flagMode = !local.flagMode; draw(); }
    else if (a === 'cell') {
      var c = +el.dataset.i;
      if (local.flagMode) toggleFlag(c);
      else if (!local.flags[c]) send('minigame-move', { id: cur.id, input: { cell: c } });
    }
    else if (a === 'rot') { local.turns[+el.dataset.i] = (local.turns[+el.dataset.i] + 1) % 4; draw(); }
    else if (a === 'transmit') send('minigame-move', { id: cur.id, input: { turns: local.turns.slice() } });
    else if (a === 'pmark') { local.markMode = !local.markMode; draw(); }
    else if (a === 'pcell') { var pi = +el.dataset.i; if (local.markMode) markVoid(pi); else { local.cells[pi] = local.cells[pi] === 1 ? 0 : 1; draw(); } }
    else if (a === 'commit') send('minigame-move', { id: cur.id, input: { cells: local.cells.map(function (v) { return v === 1 ? 1 : 0; }) } });
    else if (a === 'piece') { if (local.chain.length < cur.game.length) { local.chain.push(+el.dataset.i); draw(); } }
    else if (a === 'unpiece') { local.chain.splice(+el.dataset.i, 1); draw(); }
    else if (a === 'splice') send('minigame-move', { id: cur.id, input: { order: local.chain.slice() } });
  }

  // Open and still on the page (a reload of the panels can remove every modal). The colony view pauses while it is.
  function isOpen() { return !!(bg && bg.isConnected); }
  window.Mini = { init: init, section: section, isOpen: isOpen };
})();
