/* ==========================================================================
   Scōp — app.js
   Dark mode toggle, scroll animations, waitlist form
   ========================================================================== */

(function () {
  'use strict';

  /* ---------- DARK MODE TOGGLE ---------- */
  const toggle = document.querySelector('[data-theme-toggle]');
  const root = document.documentElement;

  // Determine initial theme from system preference
  let currentTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
  root.setAttribute('data-theme', currentTheme);
  updateToggleIcon();

  if (toggle) {
    toggle.addEventListener('click', function () {
      currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', currentTheme);
      toggle.setAttribute(
        'aria-label',
        'Switch to ' + (currentTheme === 'dark' ? 'light' : 'dark') + ' mode'
      );
      updateToggleIcon();
    });
  }

  function updateToggleIcon() {
    if (!toggle) return;
    if (currentTheme === 'dark') {
      // Show sun icon (switch to light)
      toggle.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
    } else {
      // Show moon icon (switch to dark)
      toggle.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    }
  }


  /* ---------- HEADER SCROLL STATE ---------- */
  const header = document.getElementById('header');
  let lastScrollY = 0;

  function onScroll() {
    const scrollY = window.scrollY;
    if (header) {
      if (scrollY > 10) {
        header.classList.add('header--scrolled');
      } else {
        header.classList.remove('header--scrolled');
      }
    }
    lastScrollY = scrollY;
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();


  /* ---------- SCROLL ANIMATIONS (IntersectionObserver) ---------- */
  const animatedElements = document.querySelectorAll('[data-animate]');

  if ('IntersectionObserver' in window && animatedElements.length > 0) {
    const observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      {
        threshold: 0.1,
        rootMargin: '0px 0px -40px 0px',
      }
    );

    animatedElements.forEach(function (el) {
      observer.observe(el);
    });
  } else {
    // Fallback: show all immediately
    animatedElements.forEach(function (el) {
      el.classList.add('is-visible');
    });
  }


  /* ---------- WAITLIST FORM (Netlify Forms) ---------- */
  const form = document.getElementById('waitlist-form');

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();

      const input = form.querySelector('.waitlist__input');
      const email = input ? input.value.trim() : '';

      // Basic email validation
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        if (input) {
          input.style.borderColor = '#a13544';
          input.focus();
          setTimeout(function () {
            input.style.borderColor = '';
          }, 2000);
        }
        return;
      }

      // Submit to Netlify via fetch
      var formData = new FormData(form);

      fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(formData).toString(),
      })
        .then(function () {
          // Show success state
          form.style.display = 'none';
          var note = form.parentElement.querySelector('.waitlist__note');
          if (note) note.style.display = 'none';
          var success = form.parentElement.querySelector('.waitlist-success');
          if (success) success.removeAttribute('hidden');
        })
        .catch(function () {
          // Fallback: still show success (Netlify may have caught it)
          form.style.display = 'none';
          var success = form.parentElement.querySelector('.waitlist-success');
          if (success) success.removeAttribute('hidden');
        });
    });
  }


  /* ---------- SMOOTH SCROLL for anchor links ---------- */
  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener('click', function (e) {
      const targetId = this.getAttribute('href');
      if (targetId === '#') return;
      const target = document.querySelector(targetId);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
})();
