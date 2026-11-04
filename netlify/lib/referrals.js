// referrals.js
// Scōp referral scheme: "give £10, get £10".
//
//   - Every subscriber gets a personal Stripe promotion code (e.g. SARAH10) made from
//     the coupon REFERRAL_COUPON_ID. It only works on a friend's first order.
//   - The code is saved on the subscriber's Stripe customer (metadata.referral_code)
//     and on their Brevo contact as REFCODE and REFLINK, so emails can show it.
//   - When a friend's checkout uses a referral code, the referrer gets a credit on
//     their Stripe balance (REFERRAL_CREDIT pence), which Stripe takes off their next
//     invoice automatically. Grae gets an email each time.
//
// Netlify environment variables:
//   STRIPE_REFERRAL_KEY   restricted Stripe key (Customers write, Promotion codes write,
//                         Coupons read, Subscriptions read, Checkout Sessions read)
//   REFERRAL_COUPON_ID    the Stripe coupon id, e.g. REFER10
//   REFERRAL_CREDIT       credit for the referrer in pence, e.g. 1000 (= £10)
//   REFERRAL_LINK_BASE    optional, the page the share link opens
//                         (defaults to the subscription payment link)
//   BREVO_API_KEY         to write REFCODE / REFLINK onto contacts
//   BREVO_REPORT_API_KEY, REPORT_EMAIL, REPORT_FROM_EMAIL   for the email to Grae

const STRIPE = 'https://api.stripe.com/v1/';
// Pinned so Stripe's responses keep the same shape whatever the account default is
const STRIPE_VERSION = '2024-06-20';
const DEFAULT_LINK = 'https://buy.stripe.com/9B6eVe3vA7SvcZ39cy3cc01';

function cfg() {
  const e = process.env;
  return {
    key: e.STRIPE_REFERRAL_KEY,
    coupon: e.REFERRAL_COUPON_ID || 'REFER10',
    credit: parseInt(e.REFERRAL_CREDIT || '1000', 10),
    linkBase: e.REFERRAL_LINK_BASE || DEFAULT_LINK,
    brevoKey: e.BREVO_API_KEY,
    mailKey: e.BREVO_REPORT_API_KEY || e.BREVO_API_KEY,
    to: e.REPORT_EMAIL,
    from: e.REPORT_FROM_EMAIL || e.REPORT_EMAIL,
  };
}

function form(obj, prefix, out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach(x => out.append(key + '[]', String(x)));
    else if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(method, path, params) {
  const c = cfg();
  if (!c.key) throw new Error('STRIPE_REFERRAL_KEY is not set');
  let url = STRIPE + path;
  const opts = { method, headers: { Authorization: 'Bearer ' + c.key, 'Stripe-Version': STRIPE_VERSION } };
  if (params && method === 'GET') { const qs = form(params).toString(); if (qs) url += '?' + qs; }
  else if (params) { opts.body = form(params); opts.headers['content-type'] = 'application/x-www-form-urlencoded'; }
  const res = await fetch(url, opts);
  const body = await res.json();
  if (!res.ok) { const err = new Error(`Stripe ${path}: ${res.status} ${body?.error?.message || ''}`); err.status = res.status; err.code = body?.error?.code; throw err; }
  return body;
}

const money = p => '£' + (p / 100).toFixed(2).replace(/\.00$/, '');
const cleanName = s => String(s || '').normalize('NFD').replace(/[^A-Za-z]/g, '').toUpperCase();

function shareLink(code) {
  const base = cfg().linkBase;
  return base + (base.includes('?') ? '&' : '?') + 'prefilled_promo_code=' + encodeURIComponent(code);
}

// Candidate codes: SARAH10, SARAHK10, then SARAHK10 plus a number
function candidates(name, email) {
  const parts = String(name || '').trim().split(/\s+/);
  let first = cleanName(parts[0]).slice(0, 10);
  if (first.length < 2) first = cleanName(String(email || '').split('@')[0]).slice(0, 8);
  if (first.length < 2) first = 'SCOP';
  const initial = cleanName(parts[parts.length - 1]).slice(0, 1);
  const list = [first + '10'];
  if (initial && parts.length > 1) list.push(first + initial + '10');
  for (let i = 2; i <= 30; i++) list.push(first + (initial || '') + '10' + i);
  return list;
}

async function codeTaken(code) {
  const r = await stripe('GET', 'promotion_codes', { code, limit: 1 });
  return r.data.length > 0;
}

async function updateBrevo(email, code) {
  const c = cfg();
  if (!c.brevoKey || !email) return 'brevo skipped';
  const res = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: { 'api-key': c.brevoKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ email: email.toLowerCase(), attributes: { REFCODE: code, REFLINK: shareLink(code) }, updateEnabled: true }),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${await res.text()}`);
  return 'brevo updated';
}

// Make (or find) the referral code for a Stripe customer.
// Returns { code, link, created } . Safe to call more than once.
async function ensureReferralCode(customer, { syncBrevo = true } = {}) {
  const c = cfg();
  const cust = typeof customer === 'string' ? await stripe('GET', 'customers/' + customer) : customer;
  if (!cust || cust.deleted) throw new Error('customer not found');
  let code = cust.metadata && cust.metadata.referral_code;
  let created = false;
  if (!code) {
    for (const cand of candidates(cust.name, cust.email)) {
      if (await codeTaken(cand)) continue;
      try {
        await stripe('POST', 'promotion_codes', {
          coupon: c.coupon, code: cand,
          restrictions: { first_time_transaction: 'true' },
          metadata: { type: 'referral', referrer_customer: cust.id, referrer_email: cust.email || '' },
        });
        code = cand; created = true; break;
      } catch (e) {
        if (e.status === 400 && /already exists|in use/i.test(e.message)) continue;
        throw e;
      }
    }
    if (!code) throw new Error('could not find a free code for ' + cust.id);
    await stripe('POST', 'customers/' + cust.id, { metadata: { referral_code: code } });
  }
  if (syncBrevo && cust.email) await updateBrevo(cust.email, code);
  return { code, link: shareLink(code), created, email: cust.email || '', name: cust.name || '' };
}

async function notifyGrae(subject, html) {
  const c = cfg();
  if (!c.mailKey || !c.to) return;
  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': c.mailKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { name: 'Scōp referrals', email: c.from }, to: [{ email: c.to }], subject, htmlContent: html }),
  }).catch(e => console.warn('referral email failed', e.message));
}

// Called for every completed checkout. If a referral code was used, credit the referrer.
async function creditReferrer(sessionId) {
  const c = cfg();
  const s = await stripe('GET', 'checkout/sessions/' + sessionId, { expand: ['total_details.breakdown'] });
  if (s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') return 'not paid';
  const discounts = (s.total_details && s.total_details.breakdown && s.total_details.breakdown.discounts) || [];
  let promo = null;
  for (const d of discounts) {
    const pc = d.discount && d.discount.promotion_code;
    const obj = typeof pc === 'string' ? await stripe('GET', 'promotion_codes/' + pc) : pc;
    if (obj && obj.metadata && obj.metadata.type === 'referral') { promo = obj; break; }
  }
  if (!promo) return 'no referral code';
  const referrer = promo.metadata.referrer_customer;
  const friendEmail = (s.customer_details && s.customer_details.email || '').toLowerCase();
  const friendCustomer = typeof s.customer === 'string' ? s.customer : s.customer && s.customer.id;
  if (!referrer) return 'referral code has no referrer';
  if (referrer === friendCustomer || (promo.metadata.referrer_email || '').toLowerCase() === friendEmail) {
    await notifyGrae(`Referral not credited: ${promo.code} used by its owner`, `<p>${promo.code} was used by ${friendEmail}, who owns the code, so no credit was added.</p>`);
    return 'self referral, skipped';
  }
  // Stripe retries webhooks, so never credit the same checkout twice
  const existing = await stripe('GET', `customers/${referrer}/balance_transactions`, { limit: 100 });
  if (existing.data.some(t => t.metadata && t.metadata.checkout_session === s.id)) return 'already credited';
  await stripe('POST', `customers/${referrer}/balance_transactions`, {
    amount: String(-Math.abs(c.credit)), currency: 'gbp',
    description: `Referral credit: ${promo.code} used by a friend`,
    metadata: { checkout_session: s.id, referral_code: promo.code, friend_email: friendEmail },
  });
  const ref = await stripe('GET', 'customers/' + referrer);
  await notifyGrae(`Referral: ${promo.code} brought in a new ${s.mode === 'subscription' ? 'subscriber' : 'one-off order'}`,
    `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a2540">
      <p><b>${promo.code}</b> was just used.</p>
      <p>Referrer: ${ref.name || ''} (${ref.email || referrer})<br>
      Friend: ${friendEmail} (${s.mode === 'subscription' ? 'subscription' : 'one-off order'}, paid ${money(s.amount_total || 0)})</p>
      <p>${money(c.credit)} credit has been added to the referrer's Stripe balance. It comes off their next invoice automatically.</p>
      <p style="color:#6b6b6b;font-size:13px">If the friend's order is refunded, remove the credit in Stripe: Customers → ${ref.email || referrer} → Credit balance.</p></div>`);
  return `credited ${referrer} ${money(c.credit)} for ${promo.code}`;
}

module.exports = { ensureReferralCode, creditReferrer, shareLink, candidates, stripe };
