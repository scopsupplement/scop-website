#!/usr/bin/env node
/*
 * Scōp — build articles-index.json from _articles/*.md
 *
 * Runs automatically on every Netlify build (see netlify.toml), including
 * the rebuild Netlify triggers when an article is published through the CMS.
 * The Education page reads articles-index.json to list articles and map
 * them to their knowledge pillar, so new articles appear with no manual step.
 *
 * Rules
 *   - Articles with `draft: true` are left out (use this while an article is
 *     awaiting compliance review).
 *   - Articles missing a title or a recognised category fail the build, so a
 *     broken article can never take the Education page down silently.
 *   - Newest first by date. Articles sharing a date keep their previous order,
 *     so the current curated order is stable between builds.
 *
 * Run locally:  node scripts/build-articles-index.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const fm = require('../frontmatter.js');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, '_articles');
const OUT = path.join(ROOT, 'articles-index.json');

const PILLARS = {
  nutrition: 'Nutrition',
  movement: 'Movement',
  sleep: 'Sleep',
  stress: 'Stress',
};

const WORDS_PER_MINUTE = 220;

function readPrevOrder() {
  try {
    return JSON.parse(fs.readFileSync(OUT, 'utf8')).map(a => a.slug);
  } catch (_) {
    return [];
  }
}

function toISODate(v) {
  if (v === undefined || v === null || v === '') return '';
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

function estimateReadTime(body) {
  const words = body.replace(/[#>*_`\[\]()!-]/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

function build() {
  const prevOrder = readPrevOrder();
  const files = fs.readdirSync(SRC).filter(f => f.endsWith('.md')).sort();
  const errors = [];
  const skipped = [];
  const articles = [];

  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    const { data, body } = fm.split(fs.readFileSync(path.join(SRC, file), 'utf8'));
    const category = String(data.category || '').toLowerCase().trim();

    if (data.draft === true) { skipped.push(slug); continue; }
    if (!data.title) errors.push(`${file}: missing title`);
    if (!PILLARS[category]) {
      errors.push(`${file}: category "${data.category || ''}" must be one of ${Object.keys(PILLARS).join(', ')}`);
    }
    if (!/^[a-z0-9-]+$/.test(slug)) errors.push(`${file}: filename must be lowercase letters, numbers and hyphens`);

    const readTime = Number(data.read_time) > 0 ? Math.round(Number(data.read_time)) : estimateReadTime(body);

    articles.push({
      slug,
      title: String(data.title || '').trim(),
      category: PILLARS[category] || '',
      read_time: readTime,
      summary: String(data.summary || '').replace(/\s+/g, ' ').trim(),
      date: toISODate(data.date),
      ...(data.image ? { image: String(data.image) } : {}),
    });
  }

  if (errors.length) {
    console.error('\n[articles-index] Build stopped — fix these article(s):\n  - ' + errors.join('\n  - ') + '\n');
    process.exit(1);
  }

  const rank = slug => {
    const i = prevOrder.indexOf(slug);
    return i === -1 ? -1 : i; // brand-new articles sit ahead of older ones with the same date
  };
  articles.sort((a, b) => (b.date || '').localeCompare(a.date || '') || rank(a.slug) - rank(b.slug) || a.title.localeCompare(b.title));

  fs.writeFileSync(OUT, JSON.stringify(articles, null, 2) + '\n');

  const counts = Object.values(PILLARS).map(p => `${p} ${articles.filter(a => a.category === p).length}`).join(' · ');
  console.log(`[articles-index] ${articles.length} article(s) written to articles-index.json (${counts})`);
  if (skipped.length) console.log(`[articles-index] Draft, not listed: ${skipped.join(', ')}`);
}

build();
