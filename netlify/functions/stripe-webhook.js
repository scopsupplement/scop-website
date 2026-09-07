// stripe-webhook.js
// Receives Stripe checkout.session.completed events and creates
// a Netlify Identity account for the customer automatically.

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

// Invite a user via Netlify Identity Admin API
async function inviteNetlifyUser(email, accountType, siteUrl, identityToken) {
  const identityUrl = `${siteUrl}/.netlify/identity/admin/users`;

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

exports.handler = async function(event) {
  // Only accept POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const webhookSecret  = process.env.STRIPE_WEBHOOK_SECRET;
  const identityToken  = process.env.NETLIFY_IDENTITY_TOKEN;
  const siteUrl        = process.env.URL || 'https://scopsupplement.uk';

  if (!webhookSecret || !identityToken) {
    console.error('Missing environment variables');
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

  try {
    const result = await inviteNetlifyUser(email, accountType, siteUrl, identityToken);
    console.log('Identity result:', result);
    return { statusCode: 200, body: JSON.stringify({ success: true, email, accountType }) };
  } catch (err) {
    console.error('Failed to create Identity user:', err.message);
    return { statusCode: 500, body: 'Failed to create account' };
  }
};
