/* ==========================================================================
   Scōp — first-order welcome offer pop-up (home page only)
   - Opens 5 seconds after the page loads, whether or not the visitor has
     answered the cookie banner (it sits above the banner; the banner is
     still there to answer once the pop-up is closed).
   - Shown once, then stays quiet for 7 days (first-party cookie
     `scop_offer_seen`, essential/functional — no tracking).
   - Accessible dialog: focus moves in, Tab is trapped, Esc / backdrop /
     close button all dismiss, focus returns to where it was.
   Preview tip: add ?offer=1 to the URL to force it to show.
   ========================================================================== */
(function () {
  'use strict';

  var DELAY_MS = 5000;
  var COOKIE = 'scop_offer_seen';
  var QUIET_DAYS = 7;
  var CODE = 'FIRSTDIBS15';

  var forced = /[?&]offer=1\b/.test(location.search);
  var memorySeen = false;

  function seen() {
    if (memorySeen) return true;
    try { return new RegExp('(?:^|;\\s*)' + COOKIE + '=').test(document.cookie); }
    catch (e) { return false; }
  }

  function markSeen() {
    memorySeen = true;
    try {
      var secure = location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = COOKIE + '=1; path=/; max-age=' + (QUIET_DAYS * 86400) + '; SameSite=Lax' + secure;
    } catch (e) { /* cookies unavailable — in-memory only */ }
  }

  if (!forced && seen()) return;

  var lastFocus = null;
  var root = null;

  function build() {
    root = document.createElement('div');
    root.className = 'offer';
    root.setAttribute('hidden', '');
    root.innerHTML =
      '<div class="offer__backdrop" data-offer-close></div>' +
      '<div class="offer__dialog" role="dialog" aria-modal="true" aria-labelledby="offer-title" aria-describedby="offer-desc">' +
        '<button type="button" class="offer__close" data-offer-close aria-label="Close offer">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
        '</button>' +

        '<div class="offer__visual" aria-hidden="true">' +
          '<span class="offer__badge">Free<br><strong>bottle</strong></span>' +
          '<picture>' +
            '<source type="image/webp" srcset="assets/scop-free-bottle-240.webp 240w, assets/scop-free-bottle-398.webp 398w" sizes="(max-width: 640px) 96px, 200px">' +
            '<img class="offer__bottle" src="assets/scop-free-bottle-240.png" width="240" height="562" alt="" decoding="async">' +
          '</picture>' +
          '<p class="offer__strap">One scoop. <span>Everything.</span></p>' +
        '</div>' +

        '<div class="offer__content">' +
          '<p class="offer__eyebrow">Welcome offer</p>' +
          '<h2 class="offer__title" id="offer-title">A free Scōp bottle with your first subscription.</h2>' +
          '<p class="offer__desc" id="offer-desc">Plus 15% off your first order, whichever way you buy.</p>' +

          '<ul class="offer__deals" role="list">' +
            '<li class="offer__deal offer__deal--sub">' +
              '<span class="offer__deal-label">Subscribe &amp; save</span>' +
              '<span class="offer__deal-value">Free bottle <em>+</em> 15% off</span>' +
            '</li>' +
            '<li class="offer__deal">' +
              '<span class="offer__deal-label">One-off order</span>' +
              '<span class="offer__deal-value">15% off</span>' +
            '</li>' +
          '</ul>' +

          '<div class="offer__code">' +
            '<span class="offer__code-label">Use code at checkout</span>' +
            '<button type="button" class="offer__code-btn" data-offer-copy aria-describedby="offer-copy-status">' +
              '<span class="offer__code-text">' + CODE + '</span>' +
              '<span class="offer__code-action" aria-hidden="true">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>' +
                '<span data-offer-copy-label>Copy</span>' +
              '</span>' +
            '</button>' +
            '<span class="offer__sr" id="offer-copy-status" role="status" aria-live="polite"></span>' +
          '</div>' +

          '<a href="order.html?code=' + CODE + '" class="btn btn--primary offer__cta" data-offer-cta>' +
            'Claim my offer' +
            '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</a>' +
          '<button type="button" class="offer__later" data-offer-close>Maybe later</button>' +

          '<p class="offer__terms">First orders only. One use per customer. Free bottle included with your first subscription delivery.</p>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);

    root.addEventListener('click', function (e) {
      if (e.target.closest('[data-offer-close]')) { e.preventDefault(); close(); return; }
      if (e.target.closest('[data-offer-copy]')) { copyCode(); return; }
      if (e.target.closest('[data-offer-cta]')) { copyCode(true); markSeen(); }
    });
    root.addEventListener('keydown', onKey);
  }

  function copyCode(silent) {
    var label = root.querySelector('[data-offer-copy-label]');
    var status = root.querySelector('#offer-copy-status');
    var done = function () {
      if (silent) return;
      label.textContent = 'Copied';
      status.textContent = 'Code ' + CODE + ' copied';
      root.querySelector('.offer__code-btn').classList.add('is-copied');
      setTimeout(function () {
        label.textContent = 'Copy';
        root.querySelector('.offer__code-btn').classList.remove('is-copied');
      }, 2200);
    };
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(CODE).then(done, fallback);
      } else { fallback(); }
    } catch (e) { fallback(); }
    function fallback() {
      var t = document.createElement('textarea');
      t.value = CODE; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
      t.remove(); done();
    }
  }

  function focusables() {
    return Array.prototype.slice.call(
      root.querySelectorAll('.offer__dialog a[href], .offer__dialog button:not([disabled])')
    );
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    var f = focusables(); if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function open() {
    if (!root) build();
    lastFocus = document.activeElement;
    root.removeAttribute('hidden');
    document.documentElement.classList.add('offer-open');
    requestAnimationFrame(function () {
      root.classList.add('is-visible');
      var cta = root.querySelector('.offer__cta');
      if (cta) cta.focus({ preventScroll: true });
    });
    markSeen();
  }

  function close() {
    if (!root) return;
    root.classList.remove('is-visible');
    document.documentElement.classList.remove('offer-open');
    setTimeout(function () { root.setAttribute('hidden', ''); }, 260);
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus({ preventScroll: true });
  }

  function start() {
    setTimeout(open, forced ? 600 : DELAY_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.scopOpenOffer = open; // handy for testing from the console
})();
