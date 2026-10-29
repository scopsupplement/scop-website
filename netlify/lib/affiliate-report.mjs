/*
 * Scōp — affiliate commission report (shared logic)
 *
 * Reads Stripe and works out, for one calendar month, what each affiliate's
 * discount code brought in and the commission owed:
 *   - One-off orders that used the code: commission on the amount paid.
 *   - Subscriptions started with the code: commission on each of the first
 *     AFFILIATE_MONTHS payments (default 3) that fall in the month.
 * Commission = AFFILIATE_RATE (default 0.15) × amount the customer actually paid
 * (after the discount). Refunds are not deducted; check the detail list.
 *
 * Environment variables (Netlify > Site configuration > Environment variables)
 *   STRIPE_REPORT_KEY      Stripe restricted key, read only (see setup notes)
 *   AFFILIATE_CODES        e.g.  MJW10=MJW Coaching;TF10=TransFit
 *   AFFILIATE_RATE         optional, default 0.15
 *   AFFILIATE_MONTHS       optional, default 3
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
    brevoKey: env.BREVO_REPORT_API_KEY,
    to: env.REPORT_EMAIL,
    from: env.REPORT_FROM_EMAIL || env.REPORT_EMAIL,
  };
}

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
    const info = { code, order: all.map(i => i.id) };
    subCache.set(subId, info);
    return info;
  }
  for (const inv of invoices) {
    const subId = typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id
      || inv.parent?.subscription_details?.subscription;
    if (!subId || !(inv.amount_paid > 0)) continue;
    const info = await subscriptionInfo(subId);
    if (!info.code) continue;
    const n = info.order.indexOf(inv.id) + 1; // 1 = first payment
    if (n < 1) continue;
    rows.push({
      date: new Date(inv.created * 1000), code: info.code,
      type: `Subscription payment ${n}`, customer: inv.customer_email || '',
      amount: inv.amount_paid / 100, isNewUse: n === 1, commissionable: n <= cfg.months,
    });
  }

  rows.sort((a, b) => a.date - b.date);

  // Summary per code
  const summary = {};
  for (const r of rows) {
    const s = summary[r.code] ||= { code: r.code, name: cfg.codes[r.code] || '', affiliate: !!cfg.codes[r.code], newUses: 0, payments: 0, value: 0, commission: 0 };
    if (r.isNewUse) s.newUses += 1;
    if (r.commissionable) { s.payments += 1; s.value += r.amount; }
    r.commission = s.affiliate && r.commissionable ? Math.round(r.amount * cfg.rate * 100) / 100 : 0;
    s.commission = Math.round((s.commission + r.commission) * 100) / 100;
  }
  for (const code of Object.keys(cfg.codes)) summary[code] ||= { code, name: cfg.codes[code], affiliate: true, newUses: 0, payments: 0, value: 0, commission: 0 };

  return { cfg, win, rows, summary: Object.values(summary).sort((a, b) => (b.affiliate - a.affiliate) || a.code.localeCompare(b.code)) };
}

// ── Output ─────────────────────────────────────────────────────────────────
const gbp = n => '£' + (Math.round(n * 100) / 100).toFixed(2);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const csvCell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

export function toCsv(report) {
  const { cfg, win, rows, summary } = report;
  const lines = [
    [`Scōp affiliate report`, win.label],
    [],
    ['Affiliate', 'Code', 'New customers', 'Commissionable payments', 'Total value (£)', `Commission ${Math.round(cfg.rate * 100)}% (£)`],
    ...summary.filter(s => s.affiliate).map(s => [s.name, s.code, s.newUses, s.payments, s.value.toFixed(2), s.commission.toFixed(2)]),
    [],
    ['Date', 'Code', 'Affiliate', 'Type', 'Customer email', 'Amount paid (£)', 'Commission (£)'],
    ...rows.map(r => [r.date.toISOString().slice(0, 10), r.code, cfg.codes[r.code] || 'Not an affiliate', r.type, r.customer, r.amount.toFixed(2), (r.commission || 0).toFixed(2)]),
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
<h2 style="font-family:Georgia,serif;font-weight:normal;color:#1a2540;margin:0 0 4px;">Affiliate commission: ${esc(win.label)}</h2>
<p style="color:#6b6b6b;margin:0 0 18px;font-size:14px;">${Math.round(cfg.rate * 100)}% of what customers paid on one-off orders and on the first ${cfg.months} payments of each subscription started with an affiliate code. Total to pay: <strong style="color:#1a2540;">${gbp(total)}</strong></p>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;">
<tr><th ${th}>Affiliate</th><th ${th}>Code</th><th ${th}>New customers</th><th ${th}>Payments</th><th ${th}>Total value</th><th ${th}>To pay</th></tr>
${aff.map(s => `<tr><td ${td}>${esc(s.name)}</td><td ${td}>${esc(s.code)}</td><td ${tdr}>${s.newUses}</td><td ${tdr}>${s.payments}</td><td ${tdr}>${gbp(s.value)}</td><td ${tdr}><strong>${gbp(s.commission)}</strong></td></tr>`).join('\n') || `<tr><td ${td} colspan="6">No affiliate codes set up</td></tr>`}
</table>
${other.length ? `<p style="font-size:13px;color:#6b6b6b;margin:18px 0 0;">Other codes used this month (no commission): ${other.map(s => `${esc(s.code)} × ${s.newUses}`).join(', ')}</p>` : ''}
<h3 style="font-family:Georgia,serif;font-weight:normal;color:#1a2540;margin:26px 0 8px;">Every payment</h3>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;">
<tr><th ${th}>Date</th><th ${th}>Code</th><th ${th}>Type</th><th ${th}>Paid</th><th ${th}>Commission</th></tr>
${rows.map(r => `<tr><td ${td}>${r.date.toISOString().slice(0, 10)}</td><td ${td}>${esc(r.code)}</td><td ${td}>${esc(r.type)}</td><td ${tdr}>${gbp(r.amount)}</td><td ${tdr}>${gbp(r.commission || 0)}</td></tr>`).join('\n') || `<tr><td ${td} colspan="5">No orders used a discount code this month</td></tr>`}
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
      subject: `Scōp affiliate commission: ${win.label}`,
      htmlContent: toHtml(report),
      attachment: [{ name: `scop-affiliate-report-${win.key}.csv`, content: Buffer.from('﻿' + csv, 'utf8').toString('base64') }],
    }),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${await res.text()}`);
  return true;
}
