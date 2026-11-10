/* ==========================================================================
   Scōp — first-order welcome offer pop-up (home page only)
   - Opens 5 seconds after the page loads, whether or not the visitor has
     answered the cookie banner (it sits above the banner; the banner is
     still there to answer once the pop-up is closed).
   - Shown once, then stays quiet for 7 days (first-party cookie
     `scop_offer_seen`, essential/functional — no tracking).
   - Accessible dialog: focus moves in, Tab is trapped, Esc / backdrop /
     close button all dismiss, focus returns to where it was.
   - Includes an email sign-up for the weekly email, posted to the existing
     Netlify "waitlist" form with source=popup.
   - v38: one navy panel. Free bottle + 8 week training plan with a first
     subscription, 15% off any first order, one email field.
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
      '<div class="offer__dialog" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="offer-title" aria-describedby="offer-desc">' +
        '<button type="button" class="offer__close" data-offer-close aria-label="Close offer">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
        '</button>' +

        '<div class="offer__visual" aria-hidden="true">' +
          '<picture>' +
            '<source type="image/webp" srcset="assets/scop-offer-duo.webp">' +
            '<img class="offer__hero" src="assets/scop-offer-duo.png" width="571" height="459" alt="" decoding="async">' +
          '</picture>' +
        '</div>' +

        '<div class="offer__content">' +
          '<p class="offer__eyebrow">Welcome offer</p>' +
          '<h2 class="offer__title" id="offer-title">Free bottle.<br>Free training plan.</h2>' +
          '<p class="offer__desc" id="offer-desc">With your first subscription.</p>' +

          '<div class="offer__ticket">' +
            '<p class="offer__save"><strong>15% off</strong><span>your first order</span></p>' +
            '<button type="button" class="offer__code-btn" data-offer-copy aria-describedby="offer-copy-status">' +
              '<span class="offer__code-label" data-offer-copy-label>Your code</span>' +
              '<span class="offer__code-text">' + CODE +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>' +
              '</span>' +
            '</button>' +
            '<span class="offer__sr" id="offer-copy-status" role="status" aria-live="polite"></span>' +
          '</div>' +

          '<a href="order.html?code=' + CODE + '" class="btn btn--primary offer__cta" data-offer-cta>' +
            'Claim my offer' +
            '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</a>' +

          '<div class="offer__signup" data-offer-signup>' +
            '<p class="offer__signup-title" id="offer-signup-title">Not ready? Get the weekly email.</p>' +
            '<form class="offer__form" name="waitlist" method="POST" data-netlify="true" netlify-honeypot="bot-field" novalidate data-offer-form aria-labelledby="offer-signup-title">' +
              '<input type="hidden" name="form-name" value="waitlist">' +
              '<input type="hidden" name="source" value="popup">' +
              '<input type="hidden" name="weekly_email_consent" value="yes">' +
              '<p class="offer__sr" aria-hidden="true"><label>Leave blank <input name="bot-field" tabindex="-1" autocomplete="off"></label></p>' +
              '<label class="offer__sr" for="offer-email">Email address</label>' +
              '<input class="offer__input" id="offer-email" type="email" name="email" autocomplete="email" inputmode="email" placeholder="Your email" required aria-describedby="offer-form-status">' +
              '<button type="submit" class="offer__submit">Sign up</button>' +
            '</form>' +
            '<p class="offer__form-status" id="offer-form-status" role="status" aria-live="polite"></p>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);

    root.addEventListener('click', function (e) {
      if (e.target.closest('[data-offer-close]')) { e.preventDefault(); close(); return; }
      if (e.target.closest('[data-offer-copy]')) { copyCode(); return; }
      if (e.target.closest('[data-offer-cta]')) { copyCode(true); markSeen(); }
    });
    root.addEventListener('keydown', onKey);
    root.querySelector('[data-offer-form]').addEventListener('submit', onSignup);
  }

  // Email sign-up: posts to the existing Netlify "waitlist" form (source=popup)
  function onSignup(e) {
    e.preventDefault();
    var form = e.currentTarget;
    var input = form.querySelector('input[name="email"]');
    var btn = form.querySelector('.offer__submit');
    var status = root.querySelector('#offer-form-status');
    var email = (input.value || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      input.setAttribute('aria-invalid', 'true');
      status.textContent = 'Please enter a valid email address.';
      status.className = 'offer__form-status is-error';
      input.focus();
      return;
    }
    input.removeAttribute('aria-invalid');
    btn.disabled = true; btn.textContent = 'One sec\u2026';
    status.textContent = ''; status.className = 'offer__form-status';
    fetch('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(new FormData(form)).toString()
    }).then(function (res) {
      if (!res.ok) throw new Error('status ' + res.status);
      markSeen();
      root.querySelector('[data-offer-signup]').innerHTML =
        '<p class="offer__signup-title">You\u2019re on the list.</p>' +
        '<p class="offer__signup-desc">Your 15% code keeps until you\u2019re ready.</p>';
      var t = root.querySelector('.offer__signup-title'); if (t) { t.setAttribute('tabindex', '-1'); t.focus({ preventScroll: true }); }
    }).catch(function () {
      btn.disabled = false; btn.textContent = 'Sign up';
      status.textContent = 'Sorry, that didn\u2019t go through. Please try again.';
      status.className = 'offer__form-status is-error';
    });
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
        label.textContent = 'Your code';
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
      root.querySelectorAll('.offer__dialog a[href], .offer__dialog button:not([disabled]), .offer__dialog input:not([type="hidden"]):not([tabindex="-1"])')
    );
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    var f = focusables(); if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (document.activeElement === root.querySelector('.offer__dialog')) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
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
      // focus the dialog itself so no button opens with a focus ring; Tab moves into it
      var dlg = root.querySelector('.offer__dialog');
      if (dlg) dlg.focus({ preventScroll: true });
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
