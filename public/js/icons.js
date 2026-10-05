// Hand-drawn 24x24 stroke icons so the game needs no external assets.
(function () {
  var I = {
    solar_array: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
    scrap_extractor: '<path d="M12 3v10M8 9l4 4 4-4M5 17h14M7 21h10"/>',
    water_pump: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/><path d="M9.5 14.5a2.5 2.5 0 0 0 2.5 2.5"/>',
    water_purifier: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
    parts_assembler: '<circle cx="12" cy="12" r="6.5" stroke-width="3.2" stroke-dasharray="2.55 2.555"/><circle cx="12" cy="12" r="2.2"/>',
    hydroponics_bay: '<path d="M5 19c0-8 5-14 15-14 0 10-6 15-14 15"/><path d="M5 19l8-8"/>',
    fabrication_works: '<path d="M4 8h13a3 3 0 0 1-3 4h-3v3h4v3H8v-3h3v-3H8a4 4 0 0 1-4-4z"/>',
    scrap_generator: '<path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z"/>',
    synth_reclaimer: '<path d="M12 3l8 4.6v8.8L12 21l-8-4.6V7.6z"/><circle cx="12" cy="12" r="2.4"/>',
    foundry: '<path d="M5 9h14l-2 10H7z"/><path d="M9 9V5h6v4M8 21h8"/>',
    circuit_fab: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
    cell_forge: '<rect x="4" y="8" width="14" height="10" rx="2"/><path d="M18 11h2.5v4H18M8 11v4M11 11v4M14 11v4"/>',
    warehouse: '<path d="M3 10l9-6 9 6v10H3z"/><path d="M9 20v-6h6v6"/>',
    watch_post: '<path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z"/>',
    beacon_array: '<path d="M12 12v9M9 21h6M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13"/><circle cx="12" cy="12" r="1.2"/>',
    lock: '<rect x="6" y="11" width="12" height="9" rx="1.5"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    users: '<circle cx="12" cy="8" r="3.2"/><path d="M5.5 20c0-4 3-6 6.5-6s6.5 2 6.5 6"/>',
    truck: '<path d="M2 6h12v10H2zM14 9h4l3 3v4h-7"/><circle cx="6.5" cy="18" r="1.8"/><circle cx="17.5" cy="18" r="1.8"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    play: '<path d="M7 4l13 8-13 8z"/>',
    warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.4"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    hub: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
    site: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 8v8M8 12h8"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>'
  };
  window.ICONS = I;
  window.icon = function (name, size) {
    size = size || 18;
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (I[name] || '') + '</svg>';
  };
})();
