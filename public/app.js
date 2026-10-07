/* Lille Ælling – catering request page. Vanilla JS, no build step. */
(function () {
  'use strict';
  var CFG = window.LAE_CONFIG || { site: {} };
  var PAGE = document.body.getAttribute('data-page');
  var BASKET_KEY = 'lae_basket_v1';
  var UPSELL = { // buffet handle pattern -> add-on handle (shop: riskrem only with julebuffet)
    test: function (h) { return /julebuffet/.test(h); },
    addon: 'riskrem-med-rod-saus-tillegg-til-buffet'
  };

  /* ---------- utils ---------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function nok(n) { return new Intl.NumberFormat('nb-NO').format(Math.round(n)) + ' kr'; }
  function ls(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }
  function ss(k, v) { try { if (v === undefined) return JSON.parse(sessionStorage.getItem(k)); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }
  function img(url, w) { if (!url) return ''; return url + (url.indexOf('?') > -1 ? '&' : '?') + 'width=' + w; }
  function icon(id, cls) { return '<svg class="icon ' + (cls || '') + '" aria-hidden="true"><use href="#i-' + id + '"/></svg>'; }
  var UNIT = {
    person: { per: 'per person', short: 'pers.', many: 'personer', one: 'person' },
    pakke: { per: 'per pakke', short: 'pakker', many: 'pakker', one: 'pakke' },
    stk: { per: 'per stk.', short: 'stk.', many: 'stk.', one: 'stk.' }
  };
  function unitWord(u, q) { var x = UNIT[u] || UNIT.stk; return q === 1 ? x.one : x.many; }

  /* ---------- source / UTM capture (first touch per session) ---------- */
  (function captureSource() {
    if (ss('lae_src')) return;
    var p = new URLSearchParams(location.search), src = {};
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid'].forEach(function (k) { if (p.get(k)) src[k] = p.get(k).slice(0, 150); });
    if (document.referrer && document.referrer.indexOf(location.host) === -1) src.referrer = document.referrer.slice(0, 150);
    src.landing = location.pathname;
    ss('lae_src', src);
  })();

  /* ---------- consent + tags ---------- */
  var tagsLoaded = false;
  function loadTags() {
    if (tagsLoaded) return; tagsLoaded = true;
    window.dataLayer = window.dataLayer || [];
    if (CFG.gtmId) {
      window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
      var g = document.createElement('script'); g.async = true; g.src = 'https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(CFG.gtmId); document.head.appendChild(g);
    }
    if (CFG.pixelId) {
      /* Meta Pixel base code */
      !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
      window.fbq('init', CFG.pixelId);
      window.fbq('track', 'PageView');
    }
    flushQueue();
  }
  var queue = [];
  function flushQueue() { var q = queue; queue = []; q.forEach(function (a) { track(a[0], a[1], a[2]); }); }
  /* track(metaEventName, params, options) – pushes to dataLayer and Meta Pixel */
  function track(name, params, opt) {
    params = params || {};
    if (!tagsLoaded) { queue.push([name, params, opt]); return; }
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(Object.assign({ event: 'lae_' + name.toLowerCase() }, params));
    if (window.fbq) window.fbq('track', name, params, opt && opt.eventID ? { eventID: opt.eventID } : undefined);
  }
  function initConsent() {
    var box = $('#consent');
    var state = ls('lae_consent');
    if (!CFG.consentRequired || state === 'granted') loadTags();
    if (box && CFG.consentRequired && !state && (CFG.gtmId || CFG.pixelId)) box.hidden = false;
    $$('[data-consent]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-consent'); ls('lae_consent', v); if (box) box.hidden = true;
        if (v === 'granted') loadTags(); else queue = [];
      });
    });
    $$('[data-consent-open]').forEach(function (b) { b.addEventListener('click', function () { ls('lae_consent', null); if (box) box.hidden = false; }); });
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest('[data-track="call"]'); if (a) track('Contact', { method: 'phone' });
  });

  /* ---------- basket ---------- */
  var basket = ls(BASKET_KEY) || { items: {} }; // items: { handle: qty }
  if (!basket.items) basket = { items: {} };
  function saveBasket() { ls(BASKET_KEY, basket); }
  function basketLines(menu) {
    return Object.keys(basket.items).map(function (h) {
      var p = menu && menu.products[h]; if (!p) return null;
      var q = basket.items[h]; return { p: p, qty: q, line: p.price * q };
    }).filter(Boolean);
  }
  function basketTotal(lines) { return lines.reduce(function (s, l) { return s + l.line; }, 0); }

  /* ---------- menu ---------- */
  var MENU = null;
  function loadMenu() {
    return fetch('/api/menu').then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (m) {
        MENU = m;
        // drop basket items that no longer exist
        Object.keys(basket.items).forEach(function (h) { if (!m.products[h]) delete basket.items[h]; });
        saveBasket();
        return m;
      });
  }
  function defaultQty(p) { if (p.unit === 'person') return Math.max(p.min || 10, 1); if (p.unit === 'pakke') return 10; return 1; }
  function minQty(p) { return p.min || 1; }
  function shortDesc(p) {
    var t = (p.description || '').replace(/^\([^)]*\)\s*/, '').replace(/\s*•\s*/g, ', ').replace(/\n/g, ' ').replace(/^,\s*/, '').replace(/\s+/g, ' ').trim();
    if (t.length > 130) t = t.slice(0, 130).replace(/[\s,.;:–-]+\S*$/, '') + ' …';
    return t;
  }
  function descItems(p) {
    var d = (p.description || '').replace(/^\([^)]*\)\s*/, '').trim();
    var cap = function (x) { return x.charAt(0).toUpperCase() + x.slice(1); };
    var parts = d.split(/\s*•\s*|\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (parts.length > 2) {
      var its = parts.slice(1), tail = [];
      var m = /^(.*?[a-zæøå&)])\s+([A-ZÆØÅ][a-zæøå].{10,})$/.exec(its[its.length - 1]);
      if (m) { its[its.length - 1] = m[1]; tail.push(m[2]); }
      return { intro: [parts[0]].concat(tail), items: its.filter(function (s) { return s.length < 80; }) };
    }
    // comma list, optionally grouped "Kaldt: a, b. Varmt: c, d."
    var intro = [], items = [];
    d.split(/(?<=\.)\s+/).forEach(function (sent) {
      var body = sent.replace(/\.$/, '');
      var label = /^([A-ZÆØÅ][\wæøåÆØÅ ]{1,20}):\s*(.+)$/.exec(body);
      var list = label ? label[2] : body;
      if ((list.match(/,/g) || []).length >= 2 && list.length < 400 && !/(pris|kr\b|perfekt|passer)/i.test(list)) {
        list.split(/,\s*|\s+og\s+/).map(function (x) { return x.trim(); }).filter(Boolean).forEach(function (x) { items.push(cap(x)); });
      } else if (body) intro.push(sent);
    });
    return { intro: intro, items: items };
  }

  /* ---------- HOME ---------- */
  var current = 'populare';
  function renderCats() {
    var el = $('#cats'); if (!el) return;
    el.innerHTML = MENU.categories.map(function (c) {
      return '<button type="button" class="cat" data-cat="' + esc(c.id) + '" aria-pressed="' + (c.id === current) + '">' +
        '<span class="cat__img cat__img--' + esc(c.id) + '">' +
        (c.image ? '<img src="' + esc(img(c.image, 300)) + '" alt="" loading="lazy">' : '') +
        '<svg class="cat__check" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="11" fill="#373029"/><circle cx="11" cy="11" r="10.25" fill="none" stroke="#fff" stroke-width="1.5"/><path d="M15.5 7.5 9.3 13.7 6.5 10.9" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</span><span class="cat__chip">' + esc(c.label) + '</span></button>';
    }).join('');
  }
  function cardHTML(p) {
    var added = basket.items[p.handle] != null;
    var q = added ? basket.items[p.handle] : defaultQty(p);
    var u = UNIT[p.unit] || UNIT.stk;
    return '<article class="card' + (added ? ' is-added' : '') + '" data-handle="' + esc(p.handle) + '">' +
      (p.image ? '<button type="button" class="card__media" data-detail aria-label="Se detaljer: ' + esc(p.title) + '"><img src="' + esc(img(p.image, 600)) + '" alt="" loading="lazy"></button>'
        : '<button type="button" class="card__media card__media--empty" data-detail aria-label="Se detaljer: ' + esc(p.title) + '">' + esc(p.title.charAt(0)) + '</button>') +
      '<div class="card__body">' +
      '<h4 class="card__title"><button type="button" data-detail>' + esc(p.title) + '</button></h4>' +
      (shortDesc(p) ? '<p class="card__inc">' + esc(shortDesc(p)) + '</p>' : '') +
      '<p class="card__price"><span class="price-lg">' + nok(p.price) + '</span><small>' + u.per + '</small></p>' +
      (p.min ? '<p class="meta">Minimum ' + p.min + ' personer</p>' : '') +
      '<div class="card__spacer"></div>' +
      '<p class="card__note" data-note hidden></p>' +
      '<div class="card__controls">' + stepperHTML(p, q, '') +
      '<button type="button" class="add-btn" data-add aria-pressed="' + added + '">' +
      (added ? '<span class="add-btn__on">' + icon('check') + ' Lagt til</span><span class="add-btn__off">Fjern</span>' : 'Legg til') +
      '</button></div></div></article>';
  }
  function stepperHTML(p, q, extra) {
    var u = UNIT[p.unit] || UNIT.stk;
    return '<div class="stepper ' + extra + '"><button type="button" data-step="-1" aria-label="Færre"' + (q <= minQty(p) ? ' disabled' : '') + '>' + icon('minus') + '</button>' +
      '<input type="number" inputmode="numeric" min="' + minQty(p) + '" max="2000" value="' + q + '" aria-label="Antall ' + u.many + '" data-qty>' +
      (/stepper--lg|with-unit/.test(extra) ? '<span class="stepper__unit">' + u.short + '</span>' : '') +
      '<button type="button" data-step="1" aria-label="Flere">' + icon('plus') + '</button></div>';
  }
  function renderResults() {
    var cat = MENU.categories.filter(function (c) { return c.id === current; })[0] || MENU.categories[0];
    current = cat.id;
    var count = 0;
    var html = cat.groups.map(function (g) {
      var items = g.items.map(function (h) { return MENU.products[h]; }).filter(Boolean);
      count += items.length;
      return '<div class="grp">' + (g.title ? '<h4 class="grp__title">' + esc(g.title) + '</h4>' : '') + '<div class="cards">' + items.map(cardHTML).join('') + '</div></div>';
    }).join('');
    html += '<div class="grp"><div class="cards"><div class="custom-card"><h4 class="h3">Noe annet i tankene?</h4><p class="small muted">Skriv hva du ønsker i forespørselen, så setter vi sammen et forslag med pris.</p><div><a class="btn btn--secondary" href="/foresporsel?onske=1">Skriv et ønske</a></div></div></div></div>';
    $('#results').innerHTML = html;
    $('#resultsTitle').textContent = cat.label;
    $('#resultsCount').textContent = count + (count === 1 ? ' meny' : ' menyer');
    $$('#cats .cat').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-cat') === current)); });
  }
  function thumbHTML(p) {
    return '<div class="sline__img">' + (p.image ? '<img src="' + esc(img(p.image, 160)) + '" alt="" loading="lazy">' : '<span>' + esc(p.title.charAt(0)) + '</span>') + '</div>';
  }
  function editLineHTML(l) {
    var u = UNIT[l.p.unit] || UNIT.stk;
    return '<div class="sline" data-handle="' + esc(l.p.handle) + '">' + thumbHTML(l.p) +
      '<div class="sline__main"><div class="sline__top"><span class="sline__t">' + esc(l.p.title) + '</span>' +
      '<button type="button" class="sline__rm" data-remove aria-label="Fjern ' + esc(l.p.title) + '" title="Fjern">' + icon('trash') + '</button></div>' +
      '<div class="small muted">' + nok(l.p.price) + ' ' + u.per + (l.p.min ? ', min. ' + l.p.min : '') + '</div>' +
      '<div class="sline__bottom">' + stepperHTML(l.p, l.qty, 'stepper--sm') + '<span class="sline__amt">' + nok(l.line) + '</span></div></div></div>';
  }
  function clearAllHTML(n) {
    return '<div class="clear-all" data-clear-wrap><button type="button" class="clear-all__btn" data-clear>' + icon('trash') + ' Tøm forespørselen</button>' +
      '<div class="clear-all__confirm" hidden><span class="small">Fjerne alle ' + n + ' valg?</span><button type="button" class="btn-outline-sm clear-all__yes" data-clear-yes>Ja, tøm</button><button type="button" class="link" data-clear-no>Avbryt</button></div></div>';
  }
  function clearBasket() { basket = { items: {} }; saveBasket(); }
  /* shared handlers for editable lines (home panel + checkout). Returns true if handled. */
  function handleLineClick(t, after) {
    var wrap = t.closest('[data-clear-wrap]');
    if (wrap) {
      if (t.closest('[data-clear]')) { $('[data-clear]', wrap).hidden = true; $('.clear-all__confirm', wrap).hidden = false; $('[data-clear-yes]', wrap).focus(); return true; }
      if (t.closest('[data-clear-no]')) { $('[data-clear]', wrap).hidden = false; $('.clear-all__confirm', wrap).hidden = true; $('[data-clear]', wrap).focus(); return true; }
      if (t.closest('[data-clear-yes]')) { var hs = Object.keys(basket.items); clearBasket(); after(hs); return true; }
    }
    var line = t.closest('.sline'); if (!line) return false;
    var h = line.getAttribute('data-handle');
    if (t.closest('[data-remove]')) { removeItem(h); after([h, UPSELL.addon]); return true; }
    var st = t.closest('[data-step]');
    if (st) { var q = stepperChange(line, h, Number(st.getAttribute('data-step'))); basket.items[h] = q; saveBasket(); after([h]); return true; }
    return false;
  }
  function handleLineChange(input, after) {
    var line = input.closest('.sline'); if (!line) return false;
    var h = line.getAttribute('data-handle'); var q = stepperChange(line, h, 0, Number(input.value));
    basket.items[h] = q; saveBasket(); after([h]); return true;
  }

  function renderPanel() {
    var lines = basketLines(MENU), total = basketTotal(lines), n = lines.length;
    var panel = $('#panel');
    if (panel) {
      var h = '<div class="panel__head"><h3 class="h3">Din forespørsel</h3><span class="small muted">' + n + ' valg</span></div>';
      if (!n) {
        h += '<p class="panel__empty">Ingen menyer valgt ennå. Trykk «Legg til» på menyene du vil ha med.</p>';
      } else {
        h += '<div class="slines">' + lines.map(editLineHTML).join('') + '</div>';
        h += upsellHTML(lines);
        h += '<hr class="divider"><div class="row"><span class="small muted">Levering</span><span class="small muted">Avklares med deg</span></div>';
        h += '<div class="row"><span style="font-weight:500">Estimert pris</span><span class="price-lg">' + nok(total) + '</span></div>';
        h += '<p class="meta">Inkludert mva. Endelig pris bekreftes når vi ringer deg.</p>';
      }
      h += '<a class="btn btn--primary btn--block" href="/foresporsel">Velg dato og levering</a>';
      h += '<p class="meta" style="text-align:center">Ingen betaling nå. Forespørselen er uforpliktende.</p>';
      if (n) h += clearAllHTML(n);
      panel.innerHTML = h;
    }
    var c = $('#basketCount'); if (c) c.textContent = n;
    var bar = $('#mbar');
    if (bar) {
      bar.hidden = !n; document.body.classList.toggle('has-mbar', !!n);
      $('#mbarCount').textContent = n + ' valg i forespørselen';
      $('#mbarTotal').textContent = 'Estimert ' + nok(total);
    }
  }
  function upsellHTML(lines) {
    var buffet = lines.filter(function (l) { return UPSELL.test(l.p.handle); })[0];
    var addon = MENU.products[UPSELL.addon];
    if (!buffet || !addon || basket.items[UPSELL.addon] != null) return '';
    return '<div class="upsell" data-handle="' + esc(addon.handle) + '"><div class="grow"><div class="small" style="font-weight:500">Riskrem med rød saus</div><div class="meta">' + nok(addon.price) + ' ' + UNIT[addon.unit].per + '</div></div><button type="button" class="btn-outline-sm" data-upsell="' + buffet.qty + '">' + icon('plus') + ' Legg til</button></div>';
  }
  function canAdd(p) {
    if (p.handle === UPSELL.addon) {
      var hasBuffet = Object.keys(basket.items).some(function (h) { return UPSELL.test(h); });
      if (!hasBuffet) return 'Riskremen kan bare bestilles sammen med en av julebuffetene.';
    }
    return '';
  }
  function setQty(handle, qty) {
    var p = MENU.products[handle]; if (!p) return;
    qty = Math.max(minQty(p), Math.min(2000, Math.floor(qty) || minQty(p)));
    if (basket.items[handle] != null) { basket.items[handle] = qty; saveBasket(); renderPanel(); }
    return qty;
  }
  function addItem(handle, qty, source) {
    var p = MENU.products[handle]; if (!p) return false;
    var why = canAdd(p); if (why) return why;
    basket.items[handle] = Math.max(minQty(p), qty || defaultQty(p)); saveBasket();
    track('AddToCart', { content_ids: [handle], content_name: p.title, content_type: 'product', value: p.price * basket.items[handle], currency: 'NOK', contents: [{ id: handle, quantity: basket.items[handle] }] });
    return true;
  }
  function removeItem(handle) {
    delete basket.items[handle];
    if (UPSELL.test(handle) && !Object.keys(basket.items).some(function (h) { return UPSELL.test(h); })) delete basket.items[UPSELL.addon];
    saveBasket();
  }
  function refreshCard(handle) {
    var el = $('#results .card[data-handle="' + handle + '"]'); if (!el) return;
    el.outerHTML = cardHTML(MENU.products[handle]);
  }

  function openDetail(handle) {
    var p = MENU.products[handle]; if (!p) return;
    var dlg = $('#detail'); var d = descItems(p); var cat = MENU.categories.filter(function (c) { return c.id === current; })[0];
    var added = basket.items[handle] != null, q = added ? basket.items[handle] : defaultQty(p), u = UNIT[p.unit] || UNIT.stk;
    var addon = UPSELL.test(handle) ? MENU.products[UPSELL.addon] : null;
    dlg.innerHTML = '<div class="dlg__grid" data-handle="' + esc(handle) + '">' +
      '<div class="dlg__img">' + (p.image ? '<img src="' + esc(img(p.image, 900)) + '" alt="">' : '') + '</div>' +
      '<div class="dlg__c">' +
      '<div class="dlg__top"><span class="small muted">' + esc(cat ? cat.label : '') + '</span><button type="button" class="icon-btn" data-close aria-label="Lukk">' + icon('x') + '</button></div>' +
      '<h2 class="h2" id="dlgTitle">' + esc(p.title) + '</h2>' +
      '<p class="card__price"><span class="h3">' + nok(p.price) + '</span><span class="muted">' + u.per + (p.min ? ', minimum ' + p.min + ' personer' : '') + '</span></p>' +
      (d.intro.length ? '<div class="dlg__desc muted">' + d.intro.map(function (s) { return '<p>' + esc(s) + '</p>'; }).join('') + '</div>' : '') +
      (d.items.length ? '<div><h3 class="title">Dette er med</h3><ul class="inc-list">' + d.items.map(function (s) { return '<li>' + icon('check') + '<span>' + esc(s) + '</span></li>'; }).join('') + '</ul></div>' : '') +
      '<p class="small muted">Allergier eller spesielle ønsker? Skriv det i forespørselen, så tilpasser vi.</p>' +
      (addon && basket.items[addon.handle] == null ? '<div class="upsell"><div class="grow"><div style="font-weight:500">Riskrem med rød saus</div><div class="small muted">' + nok(addon.price) + ' per person, kun sammen med julebuffet</div></div><button type="button" class="btn-outline-sm" data-dlg-addon>' + icon('plus') + ' Legg til</button></div>' : '') +
      '<div class="dlg__ctl"><div class="field"><span class="lbl">Antall ' + u.many + '</span>' + stepperHTML(p, q, 'stepper--lg') + '</div>' +
      '<div style="text-align:right"><div class="small muted" data-dlg-calc>' + q + ' × ' + nok(p.price) + '</div><div class="price-lg" data-dlg-total>' + nok(q * p.price) + '</div></div></div>' +
      '<p class="card__note" data-note hidden></p>' +
      '<button type="button" class="btn btn--primary btn--block" data-dlg-add>' + (added ? 'Oppdater forespørselen' : 'Legg til i forespørselen') + '</button>' +
      '</div></div>';
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    track('ViewContent', { content_ids: [handle], content_name: p.title, content_type: 'product', value: p.price, currency: 'NOK' });
  }
  function closeDetail() { var d = $('#detail'); if (d.close) d.close(); else d.removeAttribute('open'); }

  function stepperChange(root, handle, delta, direct) {
    var p = MENU.products[handle]; var input = $('[data-qty]', root);
    var q = direct != null ? direct : (Number(input.value) || 0) + delta;
    q = Math.max(minQty(p), Math.min(2000, Math.floor(q) || minQty(p)));
    input.value = q;
    var minus = $('[data-step="-1"]', root); if (minus) minus.disabled = q <= minQty(p);
    return q;
  }

  function initHome() {
    initRating();
    loadMenu().then(function () {
      var hash = (location.hash || '').replace('#kategori-', '');
      if (MENU.categories.some(function (c) { return c.id === hash; })) current = hash;
      renderCats(); renderResults(); renderPanel();
    }).catch(function () {
      $('#results').innerHTML = '<div class="alert alert--error">Vi fikk ikke lastet menyene akkurat nå. Ring oss på <a href="tel:+4791586115">915 86 115</a>, eller <a href="https://lilleelling.no/collections/catering">se menyene i nettbutikken</a>.</div>';
    });

    document.addEventListener('click', function (e) {
      var t = e.target;
      var cat = t.closest('[data-cat]');
      if (cat && MENU) {
        current = cat.getAttribute('data-cat'); renderCats(); renderResults();
        if (cat.classList.contains('btn')) { e.preventDefault(); document.getElementById('menyer').scrollIntoView(); }
        return;
      }
      var card = t.closest('.card');
      if (card && MENU) {
        var h = card.getAttribute('data-handle');
        if (t.closest('[data-detail]')) { openDetail(h); return; }
        var st = t.closest('[data-step]');
        if (st) { var q = stepperChange(card, h, Number(st.getAttribute('data-step'))); setQty(h, q); return; }
        if (t.closest('[data-add]')) {
          if (basket.items[h] != null) { removeItem(h); }
          else {
            var res = addItem(h, Number($('[data-qty]', card).value));
            if (res !== true) { var n = $('[data-note]', card); n.textContent = res; n.hidden = false; return; }
          }
          refreshCard(h); if (UPSELL.test(h)) refreshCard(UPSELL.addon); renderPanel();
          return;
        }
      }
      if (t.closest('#panel') && handleLineClick(t, function (hs) { renderPanel(); hs.forEach(refreshCard); })) return;
      var up = t.closest('[data-upsell]');
      if (up) { addItem(UPSELL.addon, Number(up.getAttribute('data-upsell'))); refreshCard(UPSELL.addon); renderPanel(); return; }
      // dialog
      var dlg = t.closest('#detail');
      if (dlg) {
        var grid = $('.dlg__grid', dlg); var dh = grid && grid.getAttribute('data-handle');
        if (t === dlg || t.closest('[data-close]')) { closeDetail(); return; }
        var ds = t.closest('[data-step]');
        if (ds) { var dq = stepperChange(dlg, dh, Number(ds.getAttribute('data-step'))); updateDlgCalc(dlg, dh, dq); return; }
        if (t.closest('[data-dlg-addon]')) {
          var qq = Number($('[data-qty]', dlg).value);
          if (basket.items[dh] == null) addItem(dh, qq);
          addItem(UPSELL.addon, qq); t.closest('.upsell').remove(); refreshCard(dh); refreshCard(UPSELL.addon); renderPanel(); return;
        }
        if (t.closest('[data-dlg-add]')) {
          var qv = Number($('[data-qty]', dlg).value);
          if (basket.items[dh] != null) { setQty(dh, qv); }
          else { var r2 = addItem(dh, qv); if (r2 !== true) { var nn = $('[data-note]', dlg); nn.textContent = r2; nn.hidden = false; return; } }
          refreshCard(dh); renderPanel(); closeDetail(); return;
        }
      }
    });
    document.addEventListener('change', function (e) {
      var input = e.target.closest('[data-qty]'); if (!input || !MENU) return;
      if (input.closest('#panel')) { handleLineChange(input, function (hs) { renderPanel(); hs.forEach(refreshCard); }); return; }
      var card = input.closest('.card'); var dlg = input.closest('#detail');
      if (card) { var h = card.getAttribute('data-handle'); var q = stepperChange(card, h, 0, Number(input.value)); setQty(h, q); }
      if (dlg) { var dh = $('.dlg__grid', dlg).getAttribute('data-handle'); updateDlgCalc(dlg, dh, stepperChange(dlg, dh, 0, Number(input.value))); }
    });
    var bb = $('#basketBtn');
    if (bb) bb.addEventListener('click', function () {
      var n = Object.keys(basket.items).length;
      if (window.matchMedia('(max-width: 1023px)').matches) { if (n) location.href = '/foresporsel'; else document.getElementById('menyer').scrollIntoView(); }
      else { document.getElementById('menyer').scrollIntoView(); }
    });
  }
  function updateDlgCalc(dlg, h, q) {
    var p = MENU.products[h];
    $('[data-dlg-calc]', dlg).textContent = q + ' × ' + nok(p.price);
    $('[data-dlg-total]', dlg).textContent = nok(q * p.price);
  }
  function initRating() {
    var g = (CFG.site && CFG.site.google) || {};
    if (g.rating && g.count) {
      var li = $('#factRating'); if (li) { $('span', li).textContent = String(g.rating).replace('.', ',') + ' av 5 på Google (' + g.count + ' omtaler)'; li.hidden = false; }
    }
    var revs = (CFG.site && CFG.site.reviews) || [];
    if (revs.length) {
      $('#omtaler').hidden = false;
      if (g.rating && g.count) $('#revSummary').textContent = String(g.rating).replace('.', ',') + ' av 5 basert på ' + g.count + ' omtaler';
      if (g.url) $('#revLink').href = g.url; else $('#revLink').hidden = true;
      $('#revs').innerHTML = revs.slice(0, 3).map(function (r) {
        return '<figure class="rev" style="margin:0"><div class="stars" aria-label="' + (r.stars || 5) + ' av 5 stjerner">' + new Array((r.stars || 5) + 1).join('<svg width="16" height="16" aria-hidden="true"><use href="#i-star"/></svg>') + '</div><blockquote style="margin:0">' + esc(r.text) + '</blockquote><figcaption class="small muted">' + esc(r.author) + '</figcaption></figure>';
      }).join('');
    }
  }

  /* ---------- REQUEST (step 2) ---------- */
  var FIELDS = {
    date: function (v) { if (!v) return 'Velg en dato.'; var d = new Date(v + 'T00:00:00'), t = new Date(); t.setHours(0, 0, 0, 0); t.setDate(t.getDate() + 1); return d < t ? 'Velg en dato fra i morgen og fremover. Haster det, ring 915 86 115.' : ''; },
    time: function (v) { return v ? '' : 'Velg et klokkeslett.'; },
    address: function (v) { return fulfil() === 'henting' || v.trim().length >= 3 ? '' : 'Skriv inn leveringsadressen.'; },
    postcode: function (v) { return fulfil() === 'henting' || /^\d{4}$/.test(v.trim()) ? '' : 'Skriv inn et postnummer med 4 siffer.'; },
    name: function (v) { return v.trim().length >= 2 ? '' : 'Skriv inn navnet ditt.'; },
    phone: function (v) { return v.replace(/\D/g, '').length >= 8 ? '' : 'Skriv inn et telefonnummer med 8 siffer.'; },
    email: function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? '' : 'Skriv inn en e-post som navn@domene.no.'; },
    message: function (v) { return Object.keys(basket.items).length || v.trim().length >= 5 ? '' : 'Beskriv hva du ønsker, eller gå tilbake og velg menyer.'; }
  };
  function fulfil() { var r = $('input[name="fulfil"]:checked'); return r ? r.value : 'levering'; }
  function fieldEl(name) { return $('.field[data-f="' + name + '"]'); }
  function showErr(name, msg) {
    var f = fieldEl(name); if (!f) return;
    var input = $('input,textarea', f), err = $('.err', f);
    f.classList.toggle('is-invalid', !!msg);
    if (input) { if (msg) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', name + '-err'); } else input.removeAttribute('aria-invalid'); }
    if (err) err.textContent = msg || '';
  }
  function validateField(name) { var f = fieldEl(name); if (!f) return ''; var input = $('input,textarea', f); var msg = FIELDS[name](input.value || ''); showErr(name, msg); return msg; }

  function renderSummary() {
    var lines = basketLines(MENU), total = basketTotal(lines);
    var body = lines.length
      ? '<div class="slines">' + lines.map(editLineHTML).join('') + '</div>' +
        '<div class="row"><span style="font-weight:500">Estimert pris</span><span class="price-lg">' + nok(total) + '</span></div>' +
        '<p class="meta">Inkludert mva. Levering avklares med deg.</p>' +
        '<div class="row row--links"><a class="link" href="/#menyer">' + icon('plus') + ' Legg til flere menyer</a></div>' + clearAllHTML(lines.length)
      : '<div class="empty-basket"><p class="small muted">Ingen menyer valgt ennå.</p><a class="btn btn--secondary" href="/#menyer">Velg menyer</a></div>';
    var s = $('#summary'); if (s) s.innerHTML = '<h2 class="h3">Din forespørsel</h2>' + body;
    var sb = $('#sumbarBody'); if (sb) sb.innerHTML = body;
    var sl = $('#sumbarLine'); if (sl) sl.textContent = lines.length ? lines.length + ' valg, estimert ' + nok(total) : 'Ingen menyer valgt';
    $('#emptyNote').hidden = !!lines.length;
    $('#msgOpt').hidden = !lines.length;
    return { lines: lines, total: total };
  }

  function initRequest() {
    var form = $('#reqForm');
    var dateInput = $('#date'); var tmr = new Date(); tmr.setDate(tmr.getDate() + 1);
    dateInput.min = tmr.getFullYear() + '-' + String(tmr.getMonth() + 1).padStart(2, '0') + '-' + String(tmr.getDate()).padStart(2, '0');
    var afterEdit = function () { renderSummary(); };
    document.addEventListener('click', function (e) { if (MENU && (e.target.closest('#summary') || e.target.closest('#sumbarBody'))) handleLineClick(e.target, afterEdit); });
    document.addEventListener('change', function (e) { var i = e.target.closest('.sline [data-qty]'); if (i && MENU) handleLineChange(i, afterEdit); });
    var draft = ss('lae_form') || {};
    Object.keys(draft).forEach(function (k) { var el = form.elements[k]; if (!el || k === 'website') return; if (el.length && el[0] && el[0].type === 'radio') { $$('input[name="' + k + '"]').forEach(function (r) { r.checked = r.value === draft[k]; }); } else el.value = draft[k]; });
    function syncFulfil() { var h = fulfil() === 'henting'; $('#addrRow').hidden = h; $('#addrHelp').textContent = h ? 'Hent maten hos oss på Losjeplassen 2, 3015 Drammen.' : 'Vi leverer innen 40 km fra Drammen.'; if (h) { showErr('address', ''); showErr('postcode', ''); } }
    syncFulfil();
    $$('input[name="fulfil"]').forEach(function (r) { r.addEventListener('change', function () { syncFulfil(); saveDraft(); }); });
    if (/onske=1/.test(location.search)) setTimeout(function () { $('#message').focus(); }, 300);

    var touched = {};
    Object.keys(FIELDS).forEach(function (name) {
      var f = fieldEl(name); if (!f) return; var input = $('input,textarea', f);
      input.addEventListener('blur', function () { if (input.value || touched[name]) { touched[name] = true; validateField(name); } else if (f.classList.contains('is-invalid')) validateField(name); touched[name] = true; });
      input.addEventListener('focus', function () { if (f.classList.contains('is-invalid') && !input.__keepErr) showErr(name, ''); input.__keepErr = false; });
      input.addEventListener('keydown', function () { if (f.classList.contains('is-invalid')) showErr(name, ''); });
      input.addEventListener('input', function () { if (f.classList.contains('is-invalid')) showErr(name, ''); saveDraft(); });
    });
    function saveDraft() { var d = {}; ['date', 'time', 'address', 'postcode', 'name', 'phone', 'email', 'company', 'message'].forEach(function (k) { d[k] = form.elements[k].value; }); d.fulfil = fulfil(); ss('lae_form', d); }

    loadMenu().then(function () {
      var s = renderSummary();
      if (s.lines.length) track('InitiateCheckout', { value: s.total, currency: 'NOK', num_items: s.lines.length, content_ids: s.lines.map(function (l) { return l.p.handle; }), content_type: 'product' });
    }).catch(function () { $('#summary').innerHTML = '<p class="small muted">Kunne ikke laste menyene. Du kan likevel sende forespørselen.</p>'; MENU = { products: {}, categories: [] }; });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var first = null;
      Object.keys(FIELDS).forEach(function (n) { touched[n] = true; var m = validateField(n); if (m && !first) first = n; });
      var errBox = $('#formError'); errBox.hidden = true;
      if (first) { var el = $('input,textarea', fieldEl(first)); el.scrollIntoView({ block: 'center' }); el.__keepErr = true; el.focus({ preventScroll: true }); return; }
      var btn = $('#submitBtn'); if (btn.getAttribute('aria-busy') === 'true') return;
      btn.setAttribute('aria-busy', 'true'); btn.textContent = 'Sender …';
      var lines = basketLines(MENU);
      var payload = {
        date: form.elements.date.value, time: form.elements.time.value, fulfil: fulfil(),
        address: form.elements.address.value, postcode: form.elements.postcode.value,
        name: form.elements.name.value, phone: form.elements.phone.value, email: form.elements.email.value,
        company: form.elements.company.value, message: form.elements.message.value, website: form.elements.website.value,
        items: lines.map(function (l) { return { handle: l.p.handle, qty: l.qty }; }),
        source: ss('lae_src') || {}
      };
      fetch('/api/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
        .then(function (res) {
          if (res.j && res.j.ok) {
            ss('lae_last', { id: res.j.id, name: payload.name, phone: payload.phone, email: payload.email, date: payload.date, time: payload.time, fulfil: payload.fulfil, address: payload.address, postcode: payload.postcode, estimate: res.j.estimate, items: (res.j.items || []).map(function (i) { return { title: i.title, qty: i.qty, unit: i.unit }; }) });
            basket = { items: {} }; saveBasket(); ss('lae_form', null);
            location.href = '/takk';
            return;
          }
          if (res.status === 422 && res.j.errors) {
            var f1 = null; Object.keys(res.j.errors).forEach(function (k) { if (fieldEl(k)) { showErr(k, res.j.errors[k]); if (!f1) f1 = k; } });
            if (res.j.errors.items) { errBox.textContent = res.j.errors.items; errBox.hidden = false; }
            if (f1) { var fe = $('input,textarea', fieldEl(f1)); fe.__keepErr = true; fe.focus(); }
          } else {
            errBox.innerHTML = esc((res.j && res.j.message) || 'Noe gikk galt.') + ' <a href="tel:+4791586115">Ring 915 86 115</a>';
            errBox.hidden = false;
          }
          btn.removeAttribute('aria-busy'); btn.textContent = 'Send forespørsel';
        })
        .catch(function () {
          errBox.innerHTML = 'Vi fikk ikke kontakt med serveren. Prøv igjen, eller <a href="tel:+4791586115">ring 915 86 115</a>. Det du har skrevet er lagret.';
          errBox.hidden = false; btn.removeAttribute('aria-busy'); btn.textContent = 'Send forespørsel';
        });
    });
  }

  /* ---------- THANK-YOU ---------- */
  function dateNo(iso) { try { return new Date(iso + 'T12:00:00').toLocaleDateString('nb-NO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return iso; } }
  function initThanks() {
    var d = ss('lae_last');
    if (!d) return;
    var first = (d.name || '').split(' ')[0];
    $('#tyTitle').textContent = 'Takk, ' + first + '. Forespørselen er sendt.';
    $('#tyLead').textContent = 'Vi ringer deg på ' + d.phone + ' for å bekrefte meny, pris og levering.' + (CFG.customerCopy ? ' En kopi av forespørselen er sendt til ' + d.email + '.' : '');
    var rows = [['Dato', dateNo(d.date) + ', kl. ' + d.time], [d.fulfil === 'henting' ? 'Henting' : 'Levering', d.fulfil === 'henting' ? 'Losjeplassen 2, 3015 Drammen' : d.address + ', ' + d.postcode]];
    if (d.items && d.items.length) {
      rows.push(['Menyer', d.items.map(function (i) { return i.title + ', ' + i.qty + ' ' + unitWord(i.unit, i.qty); }).join('\n')]);
      rows.push(['Estimert pris', nok(d.estimate) + ' inkl. mva.\nEndelig pris bekreftes på telefon.']);
    }
    var dl = $('#tySummary'); dl.innerHTML = rows.map(function (r) { return '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>'; }).join(''); dl.hidden = false;
    var fired = ss('lae_lead_' + d.id);
    if (!fired) { track('Lead', { value: d.estimate || 0, currency: 'NOK', content_name: 'Catering-forespørsel' }, { eventID: d.id }); ss('lae_lead_' + d.id, true); }
  }

  /* ---------- boot ---------- */
  initConsent();
  if (PAGE === 'home') initHome();
  if (PAGE === 'request') initRequest();
  if (PAGE === 'thanks') initThanks();
})();
