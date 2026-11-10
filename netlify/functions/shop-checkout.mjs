/*
 * Scōp: basket checkout (v39)
 *
 * The basket on the site posts { items: [{ id, qty }], code, from } here. This builds a
 * Stripe Checkout Session from the fixed Stripe prices below (the browser never sends
 * a price) and returns the Stripe URL to send the customer to.
 *
 *   - Delivery: free on any order with a pouch; accessories-only orders pay the £3.95
 *     shipping rate.
 *   - Discount codes: only on orders with a pouch. Accessories-only orders get no code box.
 *     If the visitor arrived with FIRSTDIBS15 (pop-up), it's applied automatically.
 *   - Gift message box, UK delivery address, receipts as normal.
 *   - Paid orders reach the existing stripe-webhook like any other one-off order.
 *
 * Netlify environment variable:
 *   STRIPE_CHECKOUT_KEY  restricted Stripe key: Checkout Sessions write, Prices read,
 *                        Products read, Shipping rates read, Promotion codes read
 */

const STRIPE = 'https://api.stripe.com/v1/';
const STRIPE_VERSION = '2024-06-20';

// Fixed prices. Changing a price in Stripe means a new price ID here.
const PRICES = {
  pouch:  { price: 'price_1TPh3jK1mYXWz9EQUTsMh3K3', max: 3 }, // £49 one-off pouch
  bottle: { price: 'price_1UaCdcK1mYXWz9EQHDClRdiL', max: 5 }, // £15 steel bottle
  beanie: { price: 'price_1UaCX0K1mYXWz9EQwXVxqPGU', max: 5 }, // £16 beanie
};
const ACCESSORY_DELIVERY = 'shr_1UaDOfK1mYXWz9EQ3tJoL0ZO'; // £3.95, accessories-only orders
const AUTO_CODES = ['FIRSTDIBS15']; // codes the site may apply on the customer's behalf
const PAGES = { order: '/order.html', shop: '/shop.html' };

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

async function stripe(method, path, params) {
  const key = process.env.STRIPE_CHECKOUT_KEY;
  const body = params ? new URLSearchParams(params).toString() : undefined;
  const url = STRIPE + path + (method === 'GET' && body ? '?' + body : '');
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: 'Bearer ' + key,
      'Stripe-Version': STRIPE_VERSION,
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: method === 'POST' ? body : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || ('Stripe ' + res.status));
    err.status = res.status; err.code = data?.error?.code; err.param = data?.error?.param;
    throw err;
  }
  return data;
}

// Merge and check the basket; anything unknown or silly is dropped or capped.
export function cleanItems(raw) {
  const out = {};
  for (const it of Array.isArray(raw) ? raw : []) {
    const id = String(it?.id || '');
    const qty = parseInt(it?.qty, 10);
    if (!PRICES[id] || !(qty > 0)) continue;
    out[id] = Math.min((out[id] || 0) + qty, PRICES[id].max);
  }
  return out;
}

export function buildParams(items, { site, from, promotionCodeId }) {
  const hasPouch = !!items.pouch;
  const p = {
    mode: 'payment',
    locale: 'en-GB',
    success_url: site + PAGES[from] + '?order=complete',
    cancel_url: site + PAGES[from] + '?basket=open',
    'shipping_address_collection[allowed_countries][0]': 'GB',
    'custom_fields[0][key]': 'giftnote',
    'custom_fields[0][label][type]': 'custom',
    'custom_fields[0][label][custom]': 'Gift message (optional)',
    'custom_fields[0][type]': 'text',
    'custom_fields[0][optional]': 'true',
    'custom_fields[0][text][maximum_length]': '200',
    'metadata[source]': 'basket',
    'metadata[order_type]': hasPouch ? 'pouch' : 'accessories',
    'metadata[basket]': Object.entries(items).map(([k, q]) => k + ':' + q).join(','),
  };
  p['payment_intent_data[metadata][source]'] = p['metadata[source]'];
  p['payment_intent_data[metadata][basket]'] = p['metadata[basket]'];
  Object.keys(PRICES).filter(id => items[id]).forEach((id, i) => {
    p[`line_items[${i}][price]`] = PRICES[id].price;
    p[`line_items[${i}][quantity]`] = String(items[id]);
  });
  if (hasPouch) {
    p['custom_text[shipping_address][message]'] = 'Free UK delivery on every order with a pouch.';
    if (promotionCodeId) p['discounts[0][promotion_code]'] = promotionCodeId;
    else p.allow_promotion_codes = 'true';
  } else {
    p['shipping_options[0][shipping_rate]'] = ACCESSORY_DELIVERY;
  }
  return p;
}

async function findPromotionCode(code) {
  if (!AUTO_CODES.includes(code)) return null;
  try {
    const r = await stripe('GET', 'promotion_codes', { code, active: 'true', limit: '1' });
    return r.data?.[0]?.id || null;
  } catch (e) {
    console.warn('[shop] promotion code lookup failed, customer can type it instead:', e.message);
    return null;
  }
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });
  if (!process.env.STRIPE_CHECKOUT_KEY) {
    console.error('[shop] STRIPE_CHECKOUT_KEY is not set');
    return json(500, { error: 'Checkout is not set up yet' });
  }
  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Bad request' }); }

  const items = cleanItems(body.items);
  if (!Object.keys(items).length) return json(400, { error: 'Your basket is empty' });
  const from = PAGES[body.from] ? body.from : 'shop';
  const site = String(process.env.URL || 'https://www.scopsupplement.uk').replace(/\/$/, '');
  const code = String(body.code || '').trim().toUpperCase();

  const promotionCodeId = items.pouch ? await findPromotionCode(code) : null;
  try {
    const s = await stripe('POST', 'checkout/sessions', buildParams(items, { site, from, promotionCodeId }));
    return json(200, { url: s.url });
  } catch (e) {
    // e.g. the code was already used by this customer: try again without it
    if (promotionCodeId) {
      console.warn('[shop] session with code failed, retrying without:', e.message);
      try {
        const s = await stripe('POST', 'checkout/sessions', buildParams(items, { site, from, promotionCodeId: null }));
        return json(200, { url: s.url });
      } catch (e2) { e = e2; }
    }
    console.error('[shop] checkout failed:', e.message, e.param || '');
    return json(502, { error: 'Checkout failed' });
  }
};
