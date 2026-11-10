/* ==========================================================================
   Scōp basket (v39)
   - Basket icon in the header on every page, with a count.
   - Slide-out basket: change quantities, see delivery, go to checkout.
   - Items live in this browser only (localStorage, with an in-memory fallback).
   - Checkout: the basket is sent to /.netlify/functions/shop-checkout, which
     builds the Stripe checkout from fixed Stripe prices (the browser never sets
     a price) and sends the customer to Stripe.
   - Delivery: free on any order with a pouch, otherwise £3.95.
   Add buttons:  <button data-add="bottle">          adds one and opens the basket
                 <button data-toggle="beanie">        adds or removes, no basket pop-out
   ========================================================================== */
(function () {
  'use strict';

  var KEY = 'scop_basket_v1';
  var DELIVERY = 395; // pence, accessories-only orders
  var CATALOGUE = {
    pouch:  { name: 'Scōp Daybreak Orange', sub: 'One-off pouch · 30 servings', price: 4900, max: 3, img: '/assets/scop-shop-pouch-160.webp' },
    bottle: { name: 'Scōp steel bottle',    sub: '500ml',                        price: 1500, max: 5, img: '/assets/scop-shop-bottle-160.webp' },
    beanie: { name: 'Scōp beanie',          sub: 'Navy ribbed knit',             price: 1600, max: 5, img: '/assets/scop-shop-beanie-160.webp' }
  };
  var ORDER = ['pouch', 'bottle', 'beanie'];

  var memory = {};
  function read() {
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || '{}');
      var out = {};
      ORDER.forEach(function (id) {
        var q = parseInt(raw[id], 10);
        if (q > 0) out[id] = Math.min(q, CATALOGUE[id].max);
      });
      return out;
    } catch (e) { return Object.assign({}, memory); }
  }
  function write(b) {
    memory = Object.assign({}, b);
    try { localStorage.setItem(KEY, JSON.stringify(b)); } catch (e) { /* in-memory only */ }
    render();
    try { document.dispatchEvent(new CustomEvent('scop:basket', { detail: api.summary() })); } catch (e) {}
  }

  function money(p) { return '£' + (p % 100 === 0 ? (p / 100) : (p / 100).toFixed(2)); }

  var api = {
    CATALOGUE: CATALOGUE,
    items: function () { return read(); },
    qty: function (id) { return read()[id] || 0; },
    has: function (id) { return !!read()[id]; },
    set: function (id, q) {
      if (!CATALOGUE[id]) return;
      var b = read();
      q = Math.max(0, Math.min(parseInt(q, 10) || 0, CATALOGUE[id].max));
      if (q) b[id] = q; else delete b[id];
      write(b);
    },
    add: function (id, opts) {
      if (!CATALOGUE[id]) return;
      api.set(id, api.qty(id) + 1);
      bump();
      if (!opts || opts.open !== false) api.open();
    },
    remove: function (id) { api.set(id, 0); },
    clear: function () { write({}); },
    summary: function () {
      var b = read(), count = 0, subtotal = 0;
      ORDER.forEach(function (id) { if (b[id]) { count += b[id]; subtotal += b[id] * CATALOGUE[id].price; } });
      var hasPouch = !!b.pouch;
      var delivery = count && !hasPouch ? DELIVERY : 0;
      return { count: count, subtotal: subtotal, delivery: delivery, total: subtotal + delivery, hasPouch: hasPouch };
    },
    money: money,
    open: open,
    close: close,
    checkout: checkout
  };
  window.ScopBasket = api;

  /* ---------- header icon ---------- */
  var btn = null;
  function mountButton() {
    var actions = document.querySelector('.header__actions');
    if (!actions || actions.querySelector('.basket-btn')) return;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'basket-btn';
    btn.setAttribute('data-basket-open', '');
    btn.innerHTML =
      '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 8.5h15l-1.1 10.6a2 2 0 0 1-2 1.9H7.6a2 2 0 0 1-2-1.9L4.5 8.5z"/><path d="M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11"/></svg>' +
      '<span class="basket-btn__count" hidden>0</span>';
    var toggle = actions.querySelector('.theme-toggle');
    actions.insertBefore(btn, toggle || null);
  }
  function bump() {
    if (!btn) return;
    btn.classList.remove('is-bumped'); void btn.offsetWidth; btn.classList.add('is-bumped');
  }

  /* ---------- drawer ---------- */
  var root = null, lastFocus = null;
  function build() {
    root = document.createElement('div');
    root.className = 'basket';
    root.setAttribute('hidden', '');
    root.innerHTML =
      '<div class="basket__backdrop" data-basket-close></div>' +
      '<aside class="basket__panel" role="dialog" aria-modal="true" aria-labelledby="basket-title" tabindex="-1">' +
        '<div class="basket__head">' +
          '<h2 class="basket__title" id="basket-title">Your basket</h2>' +
          '<button type="button" class="basket__close" data-basket-close aria-label="Close basket">' +
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="basket__body" data-basket-body></div>' +
        '<div class="basket__foot" data-basket-foot hidden>' +
          '<div class="basket__row"><span>Subtotal</span><b data-basket-subtotal></b></div>' +
          '<div class="basket__row"><span>Delivery</span><b data-basket-delivery></b></div>' +
          '<p class="basket__nudge" data-basket-nudge hidden>Add a pouch and delivery’s free. <a href="/order.html">Choose one</a></p>' +
          '<button type="button" class="btn btn--primary basket__checkout" data-basket-checkout>Checkout</button>' +
          '<p class="basket__error" data-basket-error role="status" aria-live="polite"></p>' +
        '</div>' +
      '</aside>';
    document.body.appendChild(root);
    root.addEventListener('keydown', onKey);
  }

  function render() {
    var s = api.summary();
    if (btn) {
      var c = btn.querySelector('.basket-btn__count');
      c.textContent = s.count; c.hidden = !s.count;
      btn.setAttribute('aria-label', 'Basket, ' + s.count + (s.count === 1 ? ' item' : ' items'));
    }
    document.querySelectorAll('[data-toggle]').forEach(function (b) {
      var on = api.has(b.getAttribute('data-toggle'));
      b.classList.toggle('is-added', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      var l = b.querySelector('[data-label]'); if (l) l.textContent = on ? 'Added' : 'Add';
    });
    if (!root) return;
    var body = root.querySelector('[data-basket-body]');
    var foot = root.querySelector('[data-basket-foot]');
    var b = read();
    if (!s.count) {
      body.innerHTML = '<div class="basket__empty"><p>Nothing in here yet. Very minimalist of you.</p><a href="/shop.html">Browse the shop</a></div>';
      foot.hidden = true;
      return;
    }
    body.innerHTML = ORDER.filter(function (id) { return b[id]; }).map(function (id) {
      var p = CATALOGUE[id], q = b[id];
      return '<div class="basket__item">' +
        '<img class="basket__thumb" src="' + p.img + '" alt="" width="64" height="64">' +
        '<div><p class="basket__name">' + p.name + '</p><p class="basket__sub">' + p.sub + '</p>' +
          '<span class="qty" role="group" aria-label="Quantity of ' + p.name + '">' +
            '<button type="button" data-qty="' + id + '" data-step="-1" aria-label="' + (q === 1 ? 'Remove ' : 'One fewer ') + p.name + '">' +
              (q === 1
                ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>'
                : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>') +
            '</button>' +
            '<span>' + q + '</span>' +
            '<button type="button" data-qty="' + id + '" data-step="1" aria-label="One more ' + p.name + '"' + (q >= p.max ? ' disabled' : '') + '>' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>' +
            '</button>' +
          '</span>' +
        '</div>' +
        '<span class="basket__price">' + money(p.price * q) + '</span>' +
      '</div>';
    }).join('');
    foot.hidden = false;
    root.querySelector('[data-basket-subtotal]').textContent = money(s.subtotal);
    root.querySelector('[data-basket-delivery]').textContent = s.delivery ? money(s.delivery) : 'Free';
    root.querySelector('[data-basket-nudge]').hidden = s.hasPouch;
    var co = root.querySelector('[data-basket-checkout]');
    if (!co.disabled) co.textContent = 'Checkout · ' + money(s.total);
  }

  function open() {
    if (!root) build();
    render();
    lastFocus = document.activeElement;
    root.removeAttribute('hidden');
    document.documentElement.classList.add('basket-open');
    requestAnimationFrame(function () {
      root.classList.add('is-visible');
      root.querySelector('.basket__panel').focus({ preventScroll: true });
    });
  }
  function close() {
    if (!root || root.hasAttribute('hidden')) return;
    root.classList.remove('is-visible');
    document.documentElement.classList.remove('basket-open');
    setTimeout(function () { root.setAttribute('hidden', ''); }, 300);
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    var f = Array.prototype.slice.call(root.querySelectorAll('.basket__panel a[href], .basket__panel button:not([disabled])'));
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1], panel = root.querySelector('.basket__panel');
    if (document.activeElement === panel) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* ---------- checkout ---------- */
  function promoCode() {
    var m = document.cookie.match(/(?:^|;\s*)scop_promo=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
  function go(url) {
    var framed = false;
    try { framed = window.top !== window.self; } catch (e) { framed = true; }
    if (framed) window.open(url, '_blank', 'noopener'); else window.location.href = url;
  }
  function checkout(opts) {
    var b = read();
    var items = ORDER.filter(function (id) { return b[id]; }).map(function (id) { return { id: id, qty: b[id] }; });
    if (!items.length) return Promise.resolve();
    if (!root) build();
    var co = root.querySelector('[data-basket-checkout]');
    var err = root.querySelector('[data-basket-error]');
    if (co) { co.disabled = true; co.textContent = 'One sec…'; }
    if (err) err.textContent = '';
    var from = /\/order(\.html)?$/.test(location.pathname) ? 'order' : 'shop';
    return fetch('/.netlify/functions/shop-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items, code: promoCode(), from: from })
    }).then(function (r) { return r.json().then(function (d) { if (!r.ok || !d.url) throw new Error(d.error || 'failed'); return d; }); })
      .then(function (d) { go(d.url); })
      .catch(function () {
        if (co) { co.disabled = false; render(); }
        if (err) err.textContent = 'Checkout didn’t load. Please try again.';
        if (opts && opts.onError) opts.onError();
      })
      .finally(function () { setTimeout(function () { if (co && co.disabled) { co.disabled = false; render(); } }, 8000); });
  }

  /* ---------- wiring ---------- */
  document.addEventListener('click', function (e) {
    var t;
    if ((t = e.target.closest('[data-basket-open]'))) { e.preventDefault(); open(); return; }
    if ((t = e.target.closest('[data-basket-close]'))) { e.preventDefault(); close(); return; }
    if ((t = e.target.closest('[data-basket-checkout]'))) { e.preventDefault(); checkout(); return; }
    if ((t = e.target.closest('[data-qty]'))) {
      var id = t.getAttribute('data-qty');
      api.set(id, api.qty(id) + parseInt(t.getAttribute('data-step'), 10));
      return;
    }
    if ((t = e.target.closest('[data-add]'))) { e.preventDefault(); api.add(t.getAttribute('data-add')); return; }
    if ((t = e.target.closest('[data-toggle]'))) {
      e.preventDefault();
      if (t.disabled) return;
      var tid = t.getAttribute('data-toggle');
      if (api.has(tid)) api.remove(tid); else api.add(tid, { open: false });
    }
  });

  function start() {
    mountButton();
    var q = new URLSearchParams(location.search);
    if (q.get('order') === 'complete') {
      write({});
      var t = document.querySelector('[data-basket-thanks]');
      if (t) t.hidden = false;
    }
    render();
    if (q.get('basket') === 'open') open();
    window.addEventListener('storage', function (e) { if (e.key === KEY) render(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
