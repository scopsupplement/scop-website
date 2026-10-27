/*
 * Scōp — send newsletter sign-ups from Netlify Forms to Brevo
 *
 * Netlify runs this function automatically every time a form submission
 * is verified (spam and honeypot submissions never reach it). The filename
 * must stay "submission-created" for Netlify to trigger it.
 *
 * It only acts on the "waitlist" form (homepage sign-up and the pop-up),
 * and adds the email to your Brevo list. If the person is already in Brevo,
 * they are simply added to the list again with no duplicate created.
 *
 * Set these in Netlify: Site configuration > Environment variables
 *   BREVO_API_KEY       your Brevo API key (Brevo: SMTP & API > API keys)
 *   BREVO_LIST_ID       the number of the Brevo list for the weekly email
 *   BREVO_TRACK_SOURCE  optional, "true" to also save where they signed up
 *                       (needs a text attribute called SOURCE in Brevo first)
 */

const FORMS = ['waitlist'];

export default async (req) => {
  let payload;
  try {
    ({ payload } = await req.json());
  } catch (e) {
    console.error('[brevo] could not read submission', e);
    return new Response('Bad request', { status: 400 });
  }

  const formName = payload && payload.form_name;
  if (!FORMS.includes(formName)) {
    return new Response('Ignored: ' + formName, { status: 200 });
  }

  const data = payload.data || {};
  const email = String(data.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.warn('[brevo] no valid email in submission');
    return new Response('No valid email', { status: 200 });
  }

  const apiKey = process.env.BREVO_API_KEY;
  const listId = Number(process.env.BREVO_LIST_ID);
  if (!apiKey || !listId) {
    console.error('[brevo] BREVO_API_KEY or BREVO_LIST_ID is not set in Netlify');
    return new Response('Not configured', { status: 500 });
  }

  const body = { email, listIds: [listId], updateEnabled: true };
  if (process.env.BREVO_TRACK_SOURCE === 'true' && data.source) {
    body.attributes = { SOURCE: String(data.source) };
  }

  try {
    const res = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      console.log(`[brevo] added ${email} to list ${listId} (source: ${data.source || 'unknown'})`);
      return new Response('OK', { status: 200 });
    }
    const text = await res.text();
    console.error(`[brevo] Brevo returned ${res.status}: ${text}`);
    return new Response('Brevo error', { status: 502 });
  } catch (e) {
    console.error('[brevo] request failed', e);
    return new Response('Request failed', { status: 502 });
  }
};
