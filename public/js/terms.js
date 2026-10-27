// Term layer: a theme can rename the game's own vocabulary (hub, convoy, credits, tick...) everywhere the interface prints
// it, including text that comes from the server (log lines, errors). It rewrites visible text only, never ids, data
// attributes or code, by walking text nodes. Story text (scenes, mail, the call card) is authored and left alone.
// Rules are [from, to] pairs, matched as whole words, case-sensitively and in order, so list a specific phrase before a
// general word. A rule whose replacement already contains the original (Hub -> Command Hub) is safe to run twice.
(function () {
  var rules = [], quick = null, observer = null;
  var SKIP = '#vn, #mailv, #call, script, style, textarea, input, .no-terms';

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function rewrite(text) {
    if (!quick.test(text)) return text;
    for (var i = 0; i < rules.length; i++) {
      (function (r) {
        text = text.replace(r.re, function (m, off, str) {
          var at = r.to.indexOf(m);
          if (at >= 0 && str.substr(off - at, r.to.length) === r.to) return m;
          return r.to;
        });
      })(rules[i]);
    }
    return text;
  }

  function textNode(n) {
    var p = n.parentElement;
    if (!p || p.closest(SKIP)) return;
    var v = n.nodeValue, w = rewrite(v);
    if (w !== v) n.nodeValue = w;
  }
  function attrs(el) {
    if (!el.closest || el.closest(SKIP)) return;
    ['title', 'aria-label', 'placeholder'].forEach(function (a) {
      var v = el.getAttribute && el.getAttribute(a);
      if (v) { var w = rewrite(v); if (w !== v) el.setAttribute(a, w); }
    });
  }
  function walk(root) {
    if (root.nodeType === 3) { textNode(root); return; }
    if (root.nodeType !== 1) return;
    attrs(root);
    var it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
    var n;
    while ((n = it.nextNode())) { if (n.nodeType === 3) textNode(n); else attrs(n); }
  }

  function init(list) {
    if (!list || !list.length) return;
    rules = list.map(function (r) { return { re: new RegExp('\\b' + escapeRe(r[0]) + '\\b', 'g'), to: r[1] }; });
    quick = new RegExp(list.map(function (r) { return '\\b' + escapeRe(r[0]) + '\\b'; }).join('|'));
    walk(document.body);
    if (observer) observer.disconnect();
    observer = new MutationObserver(function (records) {
      records.forEach(function (rec) {
        if (rec.type === 'characterData') textNode(rec.target);
        else rec.addedNodes.forEach(walk);
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  window.Terms = { init: init, rewrite: function (s) { return quick ? rewrite(s) : s; } };
})();
