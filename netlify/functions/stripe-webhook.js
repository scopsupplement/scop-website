// stripe-webhook.js
// Receives Stripe checkout.session.completed events and:
//   1. adds the customer to a Brevo list (so Brevo can send the welcome email)
//      - subscribers  -> BREVO_SUBSCRIBERS_LIST_ID
//      - one-off buyers -> BREVO_ONEOFF_LIST_ID (optional)
//      Uses BREVO_API_KEY (the same key the sign-up forms already use).
//   2. creates a Netlify Identity account for the customer (if set up).
// It also receives checkout.session.expired (someone started checkout but didn't pay):
//   if they ticked Stripe's "send me offers" box, they're added to the Brevo list
//   BREVO_ABANDONED_LIST_ID so Brevo can send the abandoned checkout email.
//   It skips anyone who has since completed a purchase (checked with STRIPE_REPORT_KEY).
// Referrals (v34): new subscribers get a personal referral code (REFCODE / REFLINK in Brevo,
//   set before they join the list so the welcome email can show it), and when a checkout
//   uses someone's referral code, that person gets a credit on their Stripe balance.
//   See netlify/lib/referrals.js.

const crypto = require('crypto');
const referrals = require('../lib/referrals.js');

// Verify the webhook came from Stripe using the signing secret
function verifyStripeSignature(payload, header, secret) {
  const parts = header.split(',').reduce((acc, part) => {
    const [key, val] = part.split('=');
    acc[key] = val;
    return acc;
  }, {});

  const timestamp = parts['t'];
  const signature = parts['v1'];

  if (!timestamp || !signature) return false;

  // Reject webhooks older than 5 minutes
  const tolerance = 300;
  if (Math.floor(Date.now() / 1000) - parseInt(timestamp) > tolerance) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(signature, 'hex')
  );
}

// Add or update the customer in Brevo and put them on a list.
// Brevo automations ("contact added to list") then send the right email.
async function addToBrevo(session, listId, extra = {}) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey || !listId) return { skipped: true };
  const email = (session.customer_details?.email || session.customer_email || '').trim().toLowerCase();
  const fullName = (session.customer_details?.name || '').trim();
  const first = fullName.split(/\s+/)[0] || '';
  const last = fullName.split(/\s+/).slice(1).join(' ');
  const attributes = {};
  if (first) attributes.FIRSTNAME = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  if (last) attributes.LASTNAME = last;
  Object.assign(attributes, extra);
  const res = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ email, attributes, listIds: [Number(listId)], updateEnabled: true }),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${await res.text()}`);
  return { added: email, listId: Number(listId) };
}

// Abandoned checkout: has this email completed a checkout since the abandoned one started?
async function hasPurchasedSince(email, since) {
  const key = process.env.STRIPE_REPORT_KEY;
  if (!key) return false;
  const qs = new URLSearchParams({ 'customer_details[email]': email, status: 'complete', 'created[gte]': String(since), limit: '1' });
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions?' + qs, { headers: { Authorization: 'Bearer ' + key } });
  if (!res.ok) { console.warn('Could not check later purchases:', res.status); return false; }
  const body = await res.json();
  return Array.isArray(body.data) && body.data.length > 0;
}

async function handleAbandoned(session) {
  const listId = process.env.BREVO_ABANDONED_LIST_ID;
  const email = (session.customer_details?.email || session.customer_email || '').trim().toLowerCase();
  if (!listId) return 'abandoned list not set';
  if (!email) return 'no email (customer did not tick the offers box)';
  if (session.consent?.promotions !== 'opt_in') return 'no marketing consent';
  if (await hasPurchasedSince(email, session.created)) return 'already bought since, skipped';
  const apiKey = process.env.BREVO_API_KEY;
  const res = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ email, listIds: [Number(listId)], updateEnabled: true }),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${await res.text()}`);
  return `added ${email} to abandoned list ${listId}`;
}

// Invite a user via Netlify Identity Admin API
async function inviteNetlifyUser(email, accountType, identityBase, identityToken) {
  const identityUrl = `${identityBase}/admin/users`;

  const response = await fetch(identityUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${identityToken}`
    },
    body: JSON.stringify({
      email,
      send_invite: true,                 // Netlify emails the customer a set-password link
      app_metadata: {
        roles: [accountType]             // 'subscriber' or 'one-time'
      },
      user_metadata: {
        account_type: accountType
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    // 422 means user already exists — not an error, just skip
    if (response.status === 422) {
      console.log(`User ${email} already exists in Identity — skipping invite`);
      return { already_exists: true };
    }
    throw new Error(`Identity API error ${response.status}: ${text}`);
  }

  return response.json();
}

exports.handler = async function(event, context) {
  // Only accept POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const webhookSecret  = process.env.STRIPE_WEBHOOK_SECRET;
  const identityToken  = process.env.NETLIFY_IDENTITY_TOKEN;
  const siteUrl        = process.env.URL || 'https://scopsupplement.uk';

  if (!webhookSecret) {
    console.error('Missing STRIPE_WEBHOOK_SECRET');
    return { statusCode: 500, body: 'Server misconfiguration' };
  }

  // Verify signature
  const stripeHeader = event.headers['stripe-signature'];
  const payload      = event.body;

  const valid = verifyStripeSignature(payload, stripeHeader, webhookSecret);
  if (!valid) {
    console.error('Invalid Stripe signature');
    return { statusCode: 401, body: 'Unauthorised' };
  }

  // Parse event
  let stripeEvent;
  try {
    stripeEvent = JSON.parse(payload);
  } catch (e) {
    return { statusCode: 400, body: 'Bad JSON' };
  }

  // Abandoned checkouts
  if (stripeEvent.type === 'checkout.session.expired') {
    try {
      const r = await handleAbandoned(stripeEvent.data.object);
      console.log('Abandoned checkout:', r);
    } catch (err) {
      console.error('Abandoned checkout failed:', err.message);
    }
    return { statusCode: 200, body: 'Expired session handled' };
  }

  // Only handle completed checkouts
  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'Event ignored' };
  }

  const session     = stripeEvent.data.object;
  const email       = session.customer_details?.email || session.customer_email;
  const mode        = session.mode; // 'subscription' or 'payment'
  const accountType = mode === 'subscription' ? 'subscriber' : 'one-time';

  if (!email) {
    console.error('No email in session', session.id);
    return { statusCode: 400, body: 'No email found' };
  }

  console.log(`Processing ${accountType} purchase for ${email}`);

  // 0. Referrals: credit whoever referred them, and give new subscribers their own code
  try {
    console.log('Referral credit:', await referrals.creditReferrer(session.id));
  } catch (err) {
    console.error('Referral credit failed:', err.message);   // never blocks the rest
  }
  let refAttrs = {};
  if (mode === 'subscription' && session.customer && process.env.STRIPE_REFERRAL_KEY) {
    try {
      const ref = await referrals.ensureReferralCode(session.customer, { syncBrevo: false });
      refAttrs = { REFCODE: ref.code, REFLINK: ref.link };
      console.log('Referral code:', ref.code);
    } catch (err) {
      console.error('Referral code failed:', err.message);
    }
  }

  // 1. Brevo: put them on the right list so the welcome email goes out
  try {
    const listId = mode === 'subscription' ? process.env.BREVO_SUBSCRIBERS_LIST_ID : process.env.BREVO_ONEOFF_LIST_ID;
    const r = await addToBrevo(session, listId, refAttrs);
    console.log('Brevo result:', r);
  } catch (err) {
    console.error('Failed to add to Brevo:', err.message);   // never blocks the rest
  }

  // 2. Netlify Identity account. Netlify gives functions a built-in admin token for
  //    Identity (context.clientContext.identity); a personal access token does not work here.
  const idCtx = context && context.clientContext && context.clientContext.identity;
  const idToken = (idCtx && idCtx.token) || identityToken;
  const idBase = (idCtx && idCtx.url) || `${siteUrl}/.netlify/identity`;
  if (!idToken) {
    return { statusCode: 200, body: JSON.stringify({ success: true, email, accountType, identity: 'skipped' }) };
  }

  try {
    const result = await inviteNetlifyUser(email, accountType, idBase, idToken);
    console.log('Identity result:', result);
    return { statusCode: 200, body: JSON.stringify({ success: true, email, accountType }) };
  } catch (err) {
    // Log it but still tell Stripe "received", so a login problem never blocks
    // the Brevo step or makes Stripe retry and fail over and over.
    console.error('Failed to create Identity user:', err.message);
    return { statusCode: 200, body: JSON.stringify({ success: true, email, accountType, identity: 'failed' }) };
  }
};
