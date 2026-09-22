/* ==========================================================================
   Scōp — lightweight cookie consent
   Holds the TikTok pixel until the visitor makes a choice (UK GDPR / PECR).
   Stores the decision in a first-party cookie (essential, no consent needed).
   ========================================================================== */
(function () {
  'use strict';

  var COOKIE = 'scop_consent';
  var MAX_AGE = 60 * 60 * 24 * 182; // ~6 months, then re-ask

  /* ---- cookie helpers (with in-memory fallback) ---- */
  var memory = null;

  function readChoice() {
    try {
      var m = document.cookie.match(/(?:^|;\s*)scop_consent=([^;]*)/);
      if (m) return decodeURIComponent(m[1]);
    } catch (e) { /* cookies unavailable */ }
    return memory;
  }

  function writeChoice(value) {
    memory = value;
    try {
      var secure = location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = COOKIE + '=' + encodeURIComponent(value) +
        '; path=/; max-age=' + MAX_AGE + '; SameSite=Lax' + secure;
    } catch (e) { /* cookies unavailable — in-memory only */ }
  }

  /* ---- pixel control ----
     The TikTok SDK is NOT loaded on page load. The inline snippet in <head>
     only defines the queue stub and exposes window.scopLoadTikTok(). Calling
     that is what actually loads the SDK and sets cookies, so declining means
     no third-party script and no analytics cookies, ever. ---- */
  function grant() {
    if (typeof window.scopLoadTikTok === 'function') {
      window.scopLoadTikTok();
    }
  }

  function revoke() {
    if (window.ttq && typeof window.ttq.revokeConsent === 'function') {
      window.ttq.revokeConsent();
    }
    // Best-effort cleanup of any TikTok cookies from a previous visit.
    try {
      var host = location.hostname;
      document.cookie.split(';').forEach(function (raw) {
        var name = raw.split('=')[0].trim();
        if (!/^(_ttp|ttcsid|_tt_enable_cookie)/.test(name)) return;
        var expiry = '=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
        document.cookie = name + expiry;
        document.cookie = name + expiry + '; domain=' + host;
        document.cookie = name + expiry + '; domain=.' + host;
      });
    } catch (e) { /* cookies unavailable */ }
  }

  /* ---- banner ---- */
  function buildBanner() {
    var wrap = document.createElement('div');
    wrap.className = 'consent-banner';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-live', 'polite');
    wrap.setAttribute('aria-label', 'Cookie choices');

    wrap.innerHTML =
      '<div class="consent-banner__inner">' +
        '<p class="consent-banner__text">' +
          'We use a small number of analytics cookies to understand how people find Scōp. ' +
          'Nothing is tracked until you choose. ' +
          '<a href="#" class="consent-banner__link" data-consent-more>What we collect</a>' +
        '</p>' +
        '<div class="consent-banner__detail" hidden>' +
          'If you accept, we set a TikTok analytics cookie that tells us which ads and links bring ' +
          'people to the site. It does not read anything else on your device, and we never sell your ' +
          'data. If you decline, no analytics cookies are set and the site works exactly the same. ' +
          'You can change your mind any time by clearing cookies for this site.' +
        '</div>' +
        '<div class="consent-banner__actions">' +
          '<button type="button" class="consent-banner__btn consent-banner__btn--ghost" data-consent="denied">Decline</button>' +
          '<button type="button" class="consent-banner__btn consent-banner__btn--primary" data-consent="granted">Accept</button>' +
        '</div>' +
      '</div>';

    // expand / collapse the detail copy
    var moreLink = wrap.querySelector('[data-consent-more]');
    var detail = wrap.querySelector('.consent-banner__detail');
    moreLink.addEventListener('click', function (ev) {
      ev.preventDefault();
      var open = !detail.hidden;
      detail.hidden = open;
      moreLink.textContent = open ? 'What we collect' : 'Hide details';
    });

    // accept / decline
    wrap.querySelectorAll('[data-consent]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var choice = btn.getAttribute('data-consent');
        writeChoice(choice);
        if (choice === 'granted') { grant(); } else { revoke(); }
        wrap.classList.remove('is-visible');
        setTimeout(function () { wrap.remove(); }, 320);
      });
    });

    return wrap;
  }

  function showBanner() {
    var banner = buildBanner();
    document.body.appendChild(banner);
    // next frame so the transition runs
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { banner.classList.add('is-visible'); });
    });
  }

  /* ---- init ---- */
  function init() {
    var choice = readChoice();
    if (choice === 'granted') { grant(); return; }
    if (choice === 'denied') { revoke(); return; }
    showBanner();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
