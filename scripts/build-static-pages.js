#!/usr/bin/env node
/*
 * Scōp — build static, crawlable HTML pages
 *
 * Why this exists
 *   article.html loads each article in the browser with JavaScript. People see
 *   it fine, but most AI search crawlers (Perplexity, ChatGPT, Claude) and some
 *   search engines do not run JavaScript, so to them every article was an empty
 *   "Loading article…" page. This step writes each article out as finished HTML.
 *
 * What it writes on every Netlify build (after build-articles-index.js)
 *   articles/<slug>.html   one ready-made page per published article
 *   faq.html               the FAQ page, from _pages/faq.md
 *   sitemap.xml            every public page, for Google, Bing and AI crawlers
 *   education.html         a plain list of article links between the
 *                          STATIC-ARTICLES markers (the live page still uses
 *                          JavaScript on top of it for filters)
 *
 * article.html is used as the page template, so any design change made there
 * flows through to every article automatically. Old article.html?slug= links
 * are redirected to the new pages in _redirects.
 *
 * Run locally:  node scripts/build-static-pages.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const fm = require('../frontmatter.js');
const { marked } = require('./vendor/marked.umd.js');

const SITE = 'https://scopsupplement.uk';
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(ROOT, f)), { recursive: true }); fs.writeFileSync(path.join(ROOT, f), s); };

const CATEGORY_LABELS = {
  nutrition: 'Nutrition & Supplementation',
  movement: 'Movement & Recovery',
  sleep: 'Sleep & Restoration',
  stress: 'Stress & Resilience',
};

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ldScript = obj => `<script type="application/ld+json">\n${JSON.stringify(obj, null, 2).replace(/</g, '\\u003c')}\n</script>`;

const ORG = { '@type': 'Organization', name: 'Scōp Supplement Ltd', alternateName: 'Scōp', url: SITE, logo: SITE + '/assets/logo.svg' };

// ── Template ──────────────────────────────────────────────────────────────
const TEMPLATE = read('article.html');

const faqMatch = TEMPLATE.match(/const ARTICLE_FAQS = (\{[\s\S]*?\});\n/);
const ARTICLE_FAQS = faqMatch ? JSON.parse(faqMatch[1]) : {};

function replaceOnce(html, find, repl, label) {
  if (!html.includes(find)) throw new Error(`[static-pages] template changed, could not find: ${label}`);
  return html.replace(find, () => repl);
}

// Turn root relative links (base.css, index.html) into absolute ones (/base.css)
// so pages work from any folder. Leaves #anchors, full URLs and mailto alone.
function absolutise(html) {
  return html.replace(/\b(href|src)="(?!https?:|\/|#|mailto:|tel:|data:|\{)([^"]+)"/g, '$1="/$2"');
}

function faqSectionHtml(faqs) {
  if (!faqs || !faqs.length) return '';
  return '\n<h2 id="common-questions">Common questions</h2>\n' +
    faqs.map(([q, a]) => `<h3>${esc(q)}</h3>\n<p>${esc(a)}</p>`).join('\n') + '\n';
}

function faqSchema(faqs) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
  };
}

/**
 * Fill the article.html template with finished content.
 * opts: { url, title, description, eyebrow, readTime, dateText, bodyHtml,
 *         schemas[], backHref, backText, moreHref, moreText, ogType }
 */
function renderPage(opts) {
  let html = TEMPLATE;
  // Search engines show about 60 to 70 characters of a title and 160 of a
  // description. Articles can set shorter seo_title / seo_description in their
  // frontmatter; the on-page heading and summary are unchanged.
  const baseTitle = opts.seoTitle || opts.title;
  const pageTitle = (baseTitle + ' | Scōp').length <= 70 ? `${baseTitle} | Scōp` : baseTitle;
  const metaDesc = opts.seoDescription || opts.description;
  if (pageTitle.length > 70) console.warn(`[static-pages] title over 70 characters, add seo_title: ${opts.url}`);
  if (metaDesc.length > 160) console.warn(`[static-pages] description over 160 characters, add seo_description: ${opts.url}`);
  const head = [
    `<title>${esc(pageTitle)}</title>`,
    `<meta name="description" content="${esc(metaDesc)}">`,
    `<link rel="canonical" href="${opts.url}">`,
    `<meta property="og:type" content="${opts.ogType || 'article'}">`,
    `<meta property="og:title" content="${esc(opts.title)}">`,
    `<meta property="og:description" content="${esc(metaDesc)}">`,
    `<meta property="og:url" content="${opts.url}">`,
    `<meta property="og:site_name" content="Scōp">`,
    `<meta property="og:image" content="${SITE}/assets/scop-product-hero-portrait-2.jpg">`,
  ].join('\n  ');

  html = html.replace(/<title>[\s\S]*?<\/title>\s*<meta name="description"[^>]*>/, head);
  html = html.replace(/\s*<!-- Marked\.js to render markdown body -->\s*<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/marked[^"]*"><\/script>/, '');

  html = replaceOnce(html, '<div id="article-loading">Loading article…</div>', '', 'loading placeholder');
  html = replaceOnce(html, '<div id="article-content" hidden>', '<article id="article-content">', 'article wrapper');
  html = html.replace(/(<\/aside>\s*)<\/div>(\s*<\/main>)/, '$1</article>$2');

  html = replaceOnce(html, `<a href="education.html" class="article-back">
        ← Back to Education
      </a>`, `<a href="${opts.backHref}" class="article-back">${esc(opts.backText)}</a>`, 'back link');
  html = replaceOnce(html, '<span class="article-category" id="art-category"></span>', `<span class="article-category" id="art-category">${esc(opts.eyebrow)}</span>`, 'category');
  html = replaceOnce(html, '<span class="article-read-time" id="art-read-time"></span>', opts.readTime ? `<span class="article-read-time" id="art-read-time">${opts.readTime} min read</span>` : '', 'read time');
  html = replaceOnce(html, '<span class="article-date" id="art-date"></span>', opts.dateText ? `<time class="article-date" id="art-date" datetime="${opts.dateIso}">${esc(opts.dateText)}</time>` : '', 'date');
  html = replaceOnce(html, '<h1 class="article-title" id="art-title"></h1>', `<h1 class="article-title" id="art-title">${esc(opts.title)}</h1>`, 'title');
  html = replaceOnce(html, '<p class="article-summary" id="art-summary"></p>', `<p class="article-summary" id="art-summary">${esc(opts.description)}</p>`, 'summary');
  html = replaceOnce(html, '<img id="art-image" class="article-image" src="" alt="" hidden>',
    opts.image ? `<img id="art-image" class="article-image" src="${esc(opts.image)}" alt="${esc(opts.title)}">` : '', 'image');
  html = replaceOnce(html, '<div class="article-body" id="art-body"></div>', `<div class="article-body" id="art-body">\n${opts.bodyHtml}\n</div>`, 'body');
  html = html.replace('<a href="education.html" class="article-cta__more">More articles &rarr;</a>',
    `<a href="${opts.moreHref}" class="article-cta__more">${opts.moreText}</a>`);

  // Swap the in-browser loader script for fixed structured data
  html = html.replace(/<script>\s*\n\s*\/\/ ── Category labels[\s\S]*?loadArticle\(\);\s*<\/script>/,
    opts.schemas.map(ldScript).join('\n  '));
  if (html.includes('loadArticle();')) throw new Error('[static-pages] template changed, could not remove loader script');

  html = absolutise(html);
  return html;
}

// ── Articles ──────────────────────────────────────────────────────────────
const index = JSON.parse(read('articles-index.json'));
fs.rmSync(path.join(ROOT, 'articles'), { recursive: true, force: true });

for (const a of index) {
  const raw = read(`_articles/${a.slug}.md`);
  const { data, body } = fm.split(raw);
  const url = `${SITE}/articles/${a.slug}.html`;
  const faqs = ARTICLE_FAQS[a.slug] || [];
  const cat = String(data.category || '').toLowerCase();
  const catLabel = CATEGORY_LABELS[cat] || a.category;
  const dt = a.date ? new Date(a.date + 'T12:00:00Z') : null;

  // Put the FAQs before the sources list so readers see them in the article
  let bodyMd = body;
  let bodyHtml = marked.parse(bodyMd);
  if (faqs.length) {
    const sourcesAt = bodyHtml.search(/<hr>\s*<h2[^>]*>Sources<\/h2>/);
    const faqHtml = faqSectionHtml(faqs);
    bodyHtml = sourcesAt > -1 ? bodyHtml.slice(0, sourcesAt) + faqHtml + bodyHtml.slice(sourcesAt) : bodyHtml + faqHtml;
  }

  const schemas = [{
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.title,
    description: a.summary,
    datePublished: a.date || undefined,
    dateModified: a.date || undefined,
    author: ORG,
    publisher: ORG,
    image: data.image ? SITE + '/' + String(data.image).replace(/^\//, '') : SITE + '/assets/scop-product-hero-portrait-2.jpg',
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    isPartOf: { '@type': 'WebSite', name: 'Scōp', url: SITE },
  }];
  if (faqs.length) schemas.push(faqSchema(faqs));
  schemas.push({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: 'Education', item: SITE + '/education.html' },
      { '@type': 'ListItem', position: 3, name: a.title, item: url },
    ],
  });

  write(`articles/${a.slug}.html`, renderPage({
    url, title: a.title, description: a.summary, eyebrow: catLabel,
    seoTitle: data.seo_title ? String(data.seo_title) : '', seoDescription: data.seo_description ? String(data.seo_description) : '', readTime: a.read_time,
    dateIso: a.date, dateText: dt ? dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '',
    bodyHtml, schemas, image: data.image,
    backHref: CATEGORY_LABELS[cat] ? `education.html?topic=${cat}#articles` : 'education.html',
    backText: CATEGORY_LABELS[cat] ? `← More in ${catLabel}` : '← Back to Education',
    moreHref: CATEGORY_LABELS[cat] ? `education.html?topic=${cat}#articles` : 'education.html',
    moreText: CATEGORY_LABELS[cat] ? `More ${cat} articles &rarr;` : 'More articles &rarr;',
  }));
}

// ── FAQ page (_pages/faq.md: each "### Question" followed by its answer) ──
const pages = [];
if (fs.existsSync(path.join(ROOT, '_pages/faq.md'))) {
  const { data, body } = fm.split(read('_pages/faq.md'));
  const faqs = [];
  const parts = body.split(/^### /m).slice(1);
  for (const part of parts) {
    const [q, ...rest] = part.split('\n');
    const answerMd = rest.join('\n').split(/^## /m)[0].trim();
    const answerText = marked.parse(answerMd).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
    faqs.push([q.trim(), answerText]);
  }
  const url = SITE + '/faq.html';
  write('faq.html', renderPage({
    url, title: data.title, description: data.summary, eyebrow: 'Questions & answers', ogType: 'website',
    bodyHtml: marked.parse(body), schemas: [faqSchema(faqs), { '@context': 'https://schema.org', ...ORG }],
    backHref: 'index.html', backText: '← Back to home', moreHref: 'education.html', moreText: 'Explore the Education hub &rarr;',
  }));
  pages.push({ loc: url, lastmod: data.date });
  console.log(`[static-pages] faq.html written with ${faqs.length} questions`);
}

// ── Education page: plain article links for crawlers ──────────────────────
const edu = read('education.html');
const listHtml = index.map(a => `
          <article class="hub-article-card">
            <div class="hub-article-card__top">
              <span class="hub-article-card__category">${esc(a.category)}</span>
              <span class="hub-article-card__time">${esc(a.read_time)} min read</span>
            </div>
            <h3 class="hub-article-card__title"><a href="articles/${a.slug}.html">${esc(a.title)}</a></h3>
            <p class="hub-article-card__excerpt">${esc(a.summary)}</p>
          </article>`).join('');
const eduOut = edu.replace(/(<!-- STATIC-ARTICLES:START -->)[\s\S]*?(<!-- STATIC-ARTICLES:END -->)/, `$1${listHtml}\n          $2`);
if (eduOut !== edu) write('education.html', eduOut);

// ── Review page (_pages/review-form.html → review.html) ──────────────────
if (fs.existsSync(path.join(ROOT, '_pages/review-form.html'))) {
  write('review.html', renderPage({
    url: SITE + '/review.html', title: 'Leave a Review', ogType: 'website',
    description: 'Tried Scōp? Leave a star rating and a short review to help others decide.',
    eyebrow: 'Customer reviews', bodyHtml: read('_pages/review-form.html'),
    schemas: [{ '@context': 'https://schema.org', ...ORG }],
    backHref: 'order.html', backText: '← Back to Scōp', moreHref: 'order.html#reviews', moreText: 'Read reviews &rarr;',
  }));
  console.log('[static-pages] review.html written');
}

// ── Customer reviews on the order page (_reviews/*.md, added in the CMS) ──
{
  const dir = path.join(ROOT, '_reviews');
  const reviews = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const { data, body } = fm.split(fs.readFileSync(path.join(dir, f), 'utf8'));
      const rating = Math.round(Number(data.rating));
      const text = String(data.body || body || '').trim();
      const name = String(data.name || '').trim();
      const date = String(data.date || '').slice(0, 10);
      if (!(rating >= 1 && rating <= 5) || !text || !name) {
        console.warn(`[reviews] skipped ${f}: needs a name, a 1 to 5 rating and review text`);
        return null;
      }
      return { name, rating, text, date };
    })
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date));

  const starStr = n => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
  let order = read('order.html');
  let section;
  if (reviews.length) {
    const avg = reviews.reduce((t, r) => t + r.rating, 0) / reviews.length;
    const avgTxt = (Math.round(avg * 10) / 10).toFixed(1);
    section = `
    <section class="order-section" id="reviews">
      <div class="order-section__inner">
        <div class="order-section__header" data-animate>
          <h2 class="order-section__title">What customers say</h2>
          <div class="reviews-summary"><span class="stars" aria-hidden="true">${starStr(Math.round(avg))}</span><span>${avgTxt} out of 5 from ${reviews.length} review${reviews.length === 1 ? '' : 's'}</span></div>
        </div>
        <div class="reviews-grid">${reviews.map(r => `
          <article class="review-card">
            <div class="stars" aria-label="${r.rating} out of 5 stars">${starStr(r.rating)}</div>
            <p>${esc(r.text).replace(/\n+/g, '<br>')}</p>
            <div class="review-card__who">${esc(r.name)}${r.date ? ' · ' + new Date(r.date + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : ''}</div>
          </article>`).join('')}
        </div>
        <div class="reviews-cta"><a href="review.html">Tried Scōp? Leave a review</a></div>
      </div>
    </section>
    `;
    // Rating data for Google, only ever built from the published reviews above
    order = order.replace(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g, (whole, json) => {
      let d; try { d = JSON.parse(json); } catch (_) { return whole; }
      if (d['@type'] !== 'Product') return whole;
      d.aggregateRating = { '@type': 'AggregateRating', ratingValue: avgTxt, reviewCount: reviews.length, bestRating: '5', worstRating: '1' };
      d.review = reviews.slice(0, 20).map(r => ({
        '@type': 'Review',
        author: { '@type': 'Person', name: r.name },
        reviewRating: { '@type': 'Rating', ratingValue: String(r.rating), bestRating: '5', worstRating: '1' },
        reviewBody: r.text,
        ...(r.date ? { datePublished: r.date } : {}),
      }));
      return `<script type="application/ld+json">\n${JSON.stringify(d, null, 2)}\n</script>`;
    });
  } else {
    section = `
    <section class="order-section" id="reviews">
      <div class="order-section__inner">
        <div class="order-section__header" data-animate>
          <h2 class="order-section__title">Customer reviews</h2>
          <p class="order-section__sub">Already taking Scōp? <a href="review.html" style="color:var(--color-accent);text-decoration:underline;">Be one of the first to leave a review.</a></p>
        </div>
      </div>
    </section>
    `;
    // No published reviews: make sure no rating data is left over
    order = order.replace(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g, (whole, json) => {
      let d; try { d = JSON.parse(json); } catch (_) { return whole; }
      if (d['@type'] !== 'Product' || (!d.aggregateRating && !d.review)) return whole;
      delete d.aggregateRating; delete d.review;
      return `<script type="application/ld+json">\n${JSON.stringify(d, null, 2)}\n</script>`;
    });
  }
  const out = order.replace(/(<!-- REVIEWS:START -->)[\s\S]*?(<!-- REVIEWS:END -->)/, `$1${section}$2`);
  if (out !== read('order.html')) write('order.html', out);
  console.log(`[reviews] ${reviews.length} published review(s) on order.html`);
}

// ── Sitemap ───────────────────────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);
const urls = [
  { loc: SITE + '/', priority: '1.0', lastmod: today },
  { loc: SITE + '/order.html', priority: '0.9', lastmod: today },
  { loc: SITE + '/education.html', priority: '0.8', lastmod: today },
  ...pages.map(p => ({ ...p, priority: '0.7' })),
  ...index.map(a => ({ loc: `${SITE}/articles/${a.slug}.html`, lastmod: a.date, priority: '0.7' })),
];
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<priority>${u.priority}</priority></url>`).join('\n')}
</urlset>
`);

console.log(`[static-pages] ${index.length} article page(s) written to articles/, sitemap.xml has ${urls.length} URLs`);
