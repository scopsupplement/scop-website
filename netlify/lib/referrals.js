// referrals.js
// Scōp referral scheme: "give £10, get a month free" (v43).
//
//   - Every subscriber gets a personal Stripe promotion code (e.g. SARAH10) made from
//     the coupon REFERRAL_COUPON_ID. It gives the friend £10 off their first order only.
//   - The code is saved on the subscriber's Stripe customer (metadata.referral_code)
//     and on their Brevo contact as REFCODE and REFLINK, so emails can show it.
//   - When a friend SUBSCRIBES with the code and their first payment goes through, the
//     referrer gets a credit on their Stripe balance equal to one month of their own
//     subscription (what they actually pay, after any ongoing discount), so their next
//     payment is covered. This happens automatically from the Stripe webhook.
//   - When a friend buys a single pouch with the code, the friend still gets £10 off but
//     the referrer gets nothing. Grae is still emailed so he can see the code was used.
//   - Stripe takes credit off the referrer's next invoice automatically and credits
//     stack. Grae gets an email each time. Every credit is a balance transaction on the
//     referrer's customer with metadata reward=free_month or reward=credit.
//
// Netlify environment variables:
//   STRIPE_REFERRAL_KEY   restricted Stripe key (Customers write, Promotion codes write,
//                         Coupons read, Subscriptions read, Checkout Sessions read)
//   REFERRAL_COUPON_ID    the Stripe coupon id, e.g. REFER10
//   REFERRAL_MONTH_FALLBACK  free month value in pence if the referrer's subscription
//                         price can't be read, default 3900 (= £39)
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
    monthFallback: parseInt(e.REFERRAL_MONTH_FALLBACK || '3900', 10),
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


// One month of the referrer's own subscription, in pence, after any discount on it.
// Uses Subscriptions read only (no extra key permissions needed).
async function oneMonthValue(customerId) {
  const c = cfg();
  try {
    const r = await stripe('GET', 'subscriptions', { customer: customerId, status: 'active', limit: 1 });
    const sub = r.data[0];
    if (!sub) return { amount: c.monthFallback, basis: 'no active subscription, standard month' };
    let amount = 0;
    for (const it of sub.items.data) amount += (it.price.unit_amount || 0) * (it.quantity || 1);
    const coupon = sub.discount && sub.discount.coupon;
    if (coupon && coupon.duration !== 'once') {
      if (coupon.percent_off) amount = Math.round(amount * (1 - coupon.percent_off / 100));
      else if (coupon.amount_off) amount = Math.max(0, amount - coupon.amount_off);
    }
    if (!amount) return { amount: c.monthFallback, basis: 'price unreadable, standard month' };
    return { amount, basis: 'their monthly price' };
  } catch (e) {
    console.warn('oneMonthValue failed', e.message);
    return { amount: c.monthFallback, basis: 'lookup failed, standard month' };
  }
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
  const ref = await stripe('GET', 'customers/' + referrer);
  if (s.mode !== 'subscription') {
    // Single pouch: the friend's £10 off is the whole reward. Nothing for the referrer.
    await notifyGrae(`Referral: ${promo.code} used for a single pouch (no free month)`,
      `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a2540">
        <p><b>${promo.code}</b> was used for a single pouch by ${friendEmail} (paid ${money(s.amount_total || 0)}).</p>
        <p>Referrer: ${ref.name || ''} (${ref.email || referrer}). No free month, because free months are for new subscriptions only. Nothing to do.</p></div>`);
    return 'single pouch, no reward';
  }
  const month = await oneMonthValue(referrer);
  await stripe('POST', `customers/${referrer}/balance_transactions`, {
    amount: String(-Math.abs(month.amount)), currency: 'gbp',
    description: `Referral: next month free (${promo.code} used by a new subscriber)`,
    metadata: { checkout_session: s.id, referral_code: promo.code, friend_email: friendEmail, reward: 'free_month' },
  });
  await notifyGrae(`Referral: ${promo.code} brought in a new subscriber`,
    `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a2540">
      <p><b>${promo.code}</b> was just used for a new subscription.</p>
      <p>Referrer: ${ref.name || ''} (${ref.email || referrer})<br>
      Friend: ${friendEmail} (paid ${money(s.amount_total || 0)})</p>
      <p>Reward: next month free (${money(month.amount)} credit, ${month.basis}). It has been added to the referrer's Stripe balance and comes off their next payment automatically. Nothing to do.</p>
      <p style="color:#6b6b6b;font-size:13px">If the friend's order is refunded, remove the credit in Stripe: Customers → ${ref.email || referrer} → Credit balance.</p></div>`);
  return `credited ${referrer} ${money(month.amount)} (free_month) for ${promo.code}`;
}

module.exports = { ensureReferralCode, creditReferrer, shareLink, candidates, stripe, oneMonthValue };
