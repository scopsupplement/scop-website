// stripe-webhook.js
// Receives Stripe checkout.session.completed events and:
//   1. adds the customer to a Brevo list (so Brevo can send the welcome email)
//      - subscribers  -> BREVO_SUBSCRIBERS_LIST_ID
//      - one-off buyers -> BREVO_ONEOFF_LIST_ID (optional)
//      Uses BREVO_API_KEY (the same key the sign-up forms already use).
//   2. creates a Netlify Identity account for the customer (if set up).

const crypto = require('crypto');

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
async function addToBrevo(session, listId) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey || !listId) return { skipped: true };
  const email = (session.customer_details?.email || session.customer_email || '').trim().toLowerCase();
  const fullName = (session.customer_details?.name || '').trim();
  const first = fullName.split(/\s+/)[0] || '';
  const last = fullName.split(/\s+/).slice(1).join(' ');
  const attributes = {};
  if (first) attributes.FIRSTNAME = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  if (last) attributes.LASTNAME = last;
  const res = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ email, attributes, listIds: [Number(listId)], updateEnabled: true }),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${await res.text()}`);
  return { added: email, listId: Number(listId) };
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

  // 1. Brevo: put them on the right list so the welcome email goes out
  try {
    const listId = mode === 'subscription' ? process.env.BREVO_SUBSCRIBERS_LIST_ID : process.env.BREVO_ONEOFF_LIST_ID;
    const r = await addToBrevo(session, listId);
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
