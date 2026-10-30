/*
 * Scōp — affiliate commission report (shared logic)
 *
 * Reads Stripe and works out, for one calendar month, what each partner's
 * discount code brought in and the commission owed (partner terms, Oct 2026):
 *   - One-off orders that used the code: AFFILIATE_RATE (15%) of the amount paid.
 *   - Subscriptions started with the code:
 *       payments 1 to AFFILIATE_MONTHS (3): 15% of each payment
 *       payment 4 onwards, for as long as they stay: the ongoing rate, set by
 *       how many active subscribers the partner has that month
 *       (AFFILIATE_TIERS, default 1 to 9: 5%, 10 to 24: 7.5%, 25+: 10%)
 *   - Nothing is paid on a subscriber until their 2nd payment clears. The
 *     commission for payment 1 is held, then released in the month payment 2
 *     is made. If they cancel after one payment, nothing is paid.
 *   - "Active subscribers" = subscriptions on that code with a paid payment in
 *     the month.
 * Commission is worked out on what the customer actually paid (after the
 * discount). Refunds are not deducted automatically; check before paying.
 *
 * Environment variables (Netlify > Site configuration > Environment variables)
 *   STRIPE_REPORT_KEY      Stripe restricted key, read only (see setup notes)
 *   AFFILIATE_CODES        e.g.  MJW10=MJW Coaching;TF10=TransFit
 *   AFFILIATE_RATE         optional, default 0.15
 *   AFFILIATE_MONTHS       optional, default 3 (months at the starting rate)
 *   AFFILIATE_TIERS        optional, default 1:0.05;10:0.075;25:0.10
 *                          (active subscribers from : ongoing rate)
 *   BREVO_REPORT_API_KEY   Brevo key allowed to send transactional email
 *   REPORT_EMAIL           where the report goes, e.g. grae@scopsupplement.com
 *   REPORT_FROM_EMAIL      a verified Brevo sender, defaults to REPORT_EMAIL
 */

const STRIPE = 'https://api.stripe.com/v1/';

export function config() {
  const env = process.env;
  const codes = {};
  String(env.AFFILIATE_CODES || '').split(/[;,\n]/).forEach(pair => {
    const [code, ...name] = pair.split('=');
    if (code && code.trim()) codes[code.trim().toUpperCase()] = (name.join('=') || code).trim();
  });
  return {
    stripeKey: env.STRIPE_REPORT_KEY,
    codes,
    rate: Number(env.AFFILIATE_RATE || 0.15),
    months: Math.max(1, parseInt(env.AFFILIATE_MONTHS || '3', 10)),
    tiers: parseTiers(env.AFFILIATE_TIERS || '1:0.05;10:0.075;25:0.10'),
    brevoKey: env.BREVO_REPORT_API_KEY,
    to: env.REPORT_EMAIL,
    from: env.REPORT_FROM_EMAIL || env.REPORT_EMAIL,
  };
}

// "1:0.05;10:0.075;25:0.10" -> [{from:1,rate:0.05}, ...] sorted
export function parseTiers(str) {
  const tiers = String(str).split(/[;,\n]/).map(t => t.split(':').map(Number))
    .filter(([from, rate]) => from >= 0 && rate >= 0 && rate < 1).map(([from, rate]) => ({ from, rate }))
    .sort((a, b) => a.from - b.from);
  return tiers.length ? tiers : [{ from: 1, rate: 0.05 }];
}
export function ongoingRate(tiers, active) {
  let rate = 0;
  for (const t of tiers) if (active >= t.from) rate = t.rate;
  return rate;
}
const pct = r => (Math.round(r * 1000) / 10) + '%';
const money = n => Math.round(n * 100) / 100;

// ── Stripe helpers ─────────────────────────────────────────────────────────
function makeStripe(key, fetchImpl = fetch) {
  async function get(path, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.forEach(x => qs.append(k, x)); else if (v !== undefined) qs.append(k, String(v));
    }
    const res = await fetchImpl(STRIPE + path + (qs.toString() ? '?' + qs : ''), {
      headers: { Authorization: 'Bearer ' + key },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Stripe ${path}: ${res.status} ${body?.error?.message || ''}`);
    return body;
  }
  async function list(path, params = {}) {
    const out = []; let after;
    for (let page = 0; page < 200; page++) {
      const body = await get(path, { limit: 100, ...params, ...(after ? { starting_after: after } : {}) });
      out.push(...body.data);
      if (!body.has_more || !body.data.length) break;
      after = body.data[body.data.length - 1].id;
    }
    return out;
  }
  return { get, list };
}

// Month window in UTC. month = 'YYYY-MM'. Default: the previous month.
export function monthWindow(month, now = new Date()) {
  let y, m;
  if (month && /^\d{4}-\d{2}$/.test(month)) { [y, m] = month.split('-').map(Number); }
  else { y = now.getUTCFullYear(); m = now.getUTCMonth(); if (m === 0) { y -= 1; m = 12; } }
  const start = Date.UTC(y, m - 1, 1) / 1000;
  const end = Date.UTC(y, m, 1) / 1000;
  const label = new Date(start * 1000).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { start, end, label, key: `${y}-${String(m).padStart(2, '0')}` };
}

// Promotion code ids found on an invoice (handles old and new Stripe API shapes)
function invoicePromoIds(inv) {
  const ids = [];
  const push = d => { if (d && typeof d === 'object' && d.promotion_code) ids.push(typeof d.promotion_code === 'string' ? d.promotion_code : d.promotion_code.id); };
  (inv.discounts || []).forEach(push);
  push(inv.discount);
  (inv.total_discount_amounts || []).forEach(t => push(typeof t.discount === 'object' ? t.discount : null));
  return ids;
}

export async function buildReport({ month, now, fetchImpl } = {}) {
  const cfg = config();
  if (!cfg.stripeKey) throw new Error('STRIPE_REPORT_KEY is not set');
  const stripe = makeStripe(cfg.stripeKey, fetchImpl);
  const win = monthWindow(month, now);

  const promoCache = new Map();
  async function promoCode(id) {
    if (!id) return null;
    if (!promoCache.has(id)) {
      try { promoCache.set(id, String((await stripe.get('promotion_codes/' + id)).code || '').toUpperCase()); }
      catch (_) { promoCache.set(id, null); }
    }
    return promoCache.get(id);
  }

  const rows = [];

  // 1. One-off orders: completed Checkout Sessions in payment mode
  const sessions = await stripe.list('checkout/sessions', {
    'created[gte]': win.start, 'created[lt]': win.end, status: 'complete',
    'expand[]': ['data.total_details.breakdown'],
  });
  for (const s of sessions) {
    if (s.mode !== 'payment' || s.payment_status !== 'paid') continue;
    const discounts = s.total_details?.breakdown?.discounts || [];
    for (const d of discounts) {
      const pc = d.discount?.promotion_code;
      const code = await promoCode(typeof pc === 'string' ? pc : pc?.id);
      if (!code) continue;
      rows.push({
        date: new Date(s.created * 1000), code, type: 'One-off order',
        customer: s.customer_details?.email || '', amount: (s.amount_total || 0) / 100,
        isNewUse: true, commissionable: true,
      });
      break;
    }
  }

  // 2. Subscription payments in the month
  const invoices = await stripe.list('invoices', {
    'created[gte]': win.start, 'created[lt]': win.end, status: 'paid',
    'expand[]': ['data.discounts'],
  });
  const subCache = new Map();
  async function subscriptionInfo(subId) {
    if (subCache.has(subId)) return subCache.get(subId);
    const all = (await stripe.list('invoices', { subscription: subId, status: 'paid', 'expand[]': ['data.discounts'] }))
      .filter(i => (i.amount_paid || 0) > 0)
      .sort((a, b) => a.created - b.created);
    let code = null;
    if (all.length) for (const id of invoicePromoIds(all[0])) { code = await promoCode(id); if (code) break; }
    const info = { code, order: all.map(i => i.id), amounts: all.map(i => i.amount_paid / 100) };
    subCache.set(subId, info);
    return info;
  }
  const subPayments = [];
  for (const inv of invoices) {
    const subId = typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id
      || inv.parent?.subscription_details?.subscription;
    if (!subId || !(inv.amount_paid > 0)) continue;
    const info = await subscriptionInfo(subId);
    if (!info.code) continue;
    const n = info.order.indexOf(inv.id) + 1; // 1 = first payment
    if (n < 1) continue;
    subPayments.push({ inv, subId, info, n });
  }

  // Active subscribers per code this month (unique subscriptions with a paid payment)
  const activeSets = {};
  for (const p of subPayments) (activeSets[p.info.code] ||= new Set()).add(p.subId);
  const active = Object.fromEntries(Object.entries(activeSets).map(([c, set]) => [c, set.size]));

  for (const { inv, info, n } of subPayments) {
    const code = info.code;
    const base = { date: new Date(inv.created * 1000), code, customer: inv.customer_email || '', isNewUse: n === 1 };
    const amount = inv.amount_paid / 100;
    if (n === 1) {
      // Held until the 2nd payment clears
      rows.push({ ...base, type: 'Subscription payment 1 (held until payment 2)', amount, rate: 0, commissionable: false, held: true });
    } else if (n <= cfg.months) {
      rows.push({ ...base, type: `Subscription payment ${n}`, amount, rate: cfg.rate, commissionable: true });
      if (n === 2) {
        rows.push({ ...base, isNewUse: false, type: 'Subscription payment 1 (released now payment 2 has cleared)',
          amount: info.amounts[0], rate: cfg.rate, commissionable: true });
      }
    } else {
      const r = ongoingRate(cfg.tiers, active[code] || 0);
      rows.push({ ...base, type: `Subscription payment ${n} (ongoing)`, amount, rate: r, commissionable: r > 0 });
    }
  }
  // One-off orders use the starting rate
  for (const r of rows) if (r.rate === undefined) r.rate = cfg.rate;

  rows.sort((a, b) => a.date - b.date);

  // Summary per code
  const summary = {};
  const blank = (code) => ({ code, name: cfg.codes[code] || '', affiliate: !!cfg.codes[code], newUses: 0, payments: 0, value: 0, commission: 0, held: 0, active: active[code] || 0, ongoingRate: ongoingRate(cfg.tiers, active[code] || 0) });
  for (const r of rows) {
    const s = summary[r.code] ||= blank(r.code);
    if (r.isNewUse) s.newUses += 1;
    if (r.held) s.held += 1;
    if (r.commissionable) { s.payments += 1; s.value = money(s.value + r.amount); }
    r.commission = s.affiliate && r.commissionable ? money(r.amount * r.rate) : 0;
    s.commission = money(s.commission + r.commission);
  }
  for (const code of Object.keys(cfg.codes)) summary[code] ||= blank(code);

  return { cfg, win, rows, summary: Object.values(summary).sort((a, b) => (b.affiliate - a.affiliate) || a.code.localeCompare(b.code)) };
}

// ── Output ─────────────────────────────────────────────────────────────────
const gbp = n => '£' + (Math.round(n * 100) / 100).toFixed(2);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const csvCell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

export function toCsv(report) {
  const { cfg, win, rows, summary } = report;
  const lines = [
    [`Scōp partner commission report`, win.label],
    [],
    ['Partner', 'Code', 'New customers', 'Active subscribers', 'Ongoing rate this month', 'Payments held', 'Commissionable payments', 'Total value (£)', 'To pay (£)'],
    ...summary.filter(s => s.affiliate).map(s => [s.name, s.code, s.newUses, s.active, pct(s.ongoingRate), s.held, s.payments, s.value.toFixed(2), s.commission.toFixed(2)]),
    [],
    ['Date', 'Code', 'Partner', 'Type', 'Customer email', 'Amount paid (£)', 'Rate', 'Commission (£)'],
    ...rows.map(r => [r.date.toISOString().slice(0, 10), r.code, cfg.codes[r.code] || 'Not a partner', r.type, r.customer, r.amount.toFixed(2), r.commissionable ? pct(r.rate) : '', (r.commission || 0).toFixed(2)]),
  ];
  return lines.map(l => l.map(csvCell).join(',')).join('\n') + '\n';
}

export function toHtml(report) {
  const { cfg, win, rows, summary } = report;
  const aff = summary.filter(s => s.affiliate);
  const other = summary.filter(s => !s.affiliate);
  const total = aff.reduce((t, s) => t + s.commission, 0);
  const th = 'style="text-align:left;padding:8px 10px;border-bottom:2px solid #c17f3e;font-size:13px;color:#1a2540;"';
  const td = 'style="padding:8px 10px;border-bottom:1px solid #e6ddd2;font-size:14px;color:#2b2b2b;"';
  const tdr = 'style="padding:8px 10px;border-bottom:1px solid #e6ddd2;font-size:14px;color:#2b2b2b;text-align:right;"';
  return `<div style="font-family:Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;">
<h2 style="font-family:Georgia,serif;font-weight:normal;color:#1a2540;margin:0 0 4px;">Partner commission: ${esc(win.label)}</h2>
<p style="color:#6b6b6b;margin:0 0 18px;font-size:14px;">${pct(cfg.rate)} on one-off orders and on subscription payments 1 to ${cfg.months}, then the ongoing rate (${cfg.tiers.map(t => `${t.from}+ active: ${pct(t.rate)}`).join(', ')}). A subscriber's first payment is held until their second clears. Total to pay: <strong style="color:#1a2540;">${gbp(total)}</strong></p>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;">
<tr><th ${th}>Partner</th><th ${th}>Code</th><th ${th}>New</th><th ${th}>Active subs</th><th ${th}>Ongoing rate</th><th ${th}>Held</th><th ${th}>To pay</th></tr>
${aff.map(s => `<tr><td ${td}>${esc(s.name)}</td><td ${td}>${esc(s.code)}</td><td ${tdr}>${s.newUses}</td><td ${tdr}>${s.active}</td><td ${tdr}>${pct(s.ongoingRate)}</td><td ${tdr}>${s.held}</td><td ${tdr}><strong>${gbp(s.commission)}</strong></td></tr>`).join('\n') || `<tr><td ${td} colspan="7">No partner codes set up</td></tr>`}
</table>
${other.length ? `<p style="font-size:13px;color:#6b6b6b;margin:18px 0 0;">Other codes used this month (no commission): ${other.map(s => `${esc(s.code)} × ${s.newUses}`).join(', ')}</p>` : ''}
<h3 style="font-family:Georgia,serif;font-weight:normal;color:#1a2540;margin:26px 0 8px;">Every payment</h3>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;">
<tr><th ${th}>Date</th><th ${th}>Code</th><th ${th}>Type</th><th ${th}>Paid</th><th ${th}>Rate</th><th ${th}>Commission</th></tr>
${rows.map(r => `<tr><td ${td}>${r.date.toISOString().slice(0, 10)}</td><td ${td}>${esc(r.code)}</td><td ${td}>${esc(r.type)}</td><td ${tdr}>${gbp(r.amount)}</td><td ${tdr}>${r.commissionable ? pct(r.rate) : '–'}</td><td ${tdr}>${gbp(r.commission || 0)}</td></tr>`).join('\n') || `<tr><td ${td} colspan="6">No orders used a discount code this month</td></tr>`}
</table>
<p style="font-size:12px;color:#6b6b6b;margin-top:18px;">Refunds aren't deducted automatically, so check for any before paying. The full list, including customer emails, is in the attached spreadsheet.</p>
</div>`;
}

export async function sendReport(report, fetchImpl = fetch) {
  const { cfg, win } = report;
  if (!cfg.brevoKey || !cfg.to) throw new Error('BREVO_REPORT_API_KEY or REPORT_EMAIL is not set');
  const csv = toCsv(report);
  const res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': cfg.brevoKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Scōp reports', email: cfg.from },
      to: [{ email: cfg.to }],
      subject: `Scōp partner commission: ${win.label}`,
      htmlContent: toHtml(report),
      attachment: [{ name: `scop-affiliate-report-${win.key}.csv`, content: Buffer.from('﻿' + csv, 'utf8').toString('base64') }],
    }),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${await res.text()}`);
  return true;
}
