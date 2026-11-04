/*
 * Scōp: give existing subscribers their referral codes (run once, safe to repeat)
 *
 *   https://scopsupplement.uk/.netlify/functions/referral-backfill?key=YOUR_REPORT_SECRET
 *   add &dry=1 to see who would get a code without creating anything
 *
 * For every active subscriber it creates a personal code (e.g. SARAH10), saves it on
 * their Stripe customer and writes REFCODE / REFLINK onto their Brevo contact.
 * Subscribers who already have a code are only re-synced to Brevo.
 * It does a few at a time so it never times out: if it says some are left, refresh.
 */
import referrals from '../lib/referrals.js';

const BATCH = 4;

export default async (req) => {
  const url = new URL(req.url);
  const secret = process.env.REPORT_SECRET;
  if (!secret || url.searchParams.get('key') !== secret) return new Response('Not found', { status: 404 });
  const dry = !!url.searchParams.get('dry');
  const started = Date.now();
  try {
    const subs = [];
    let after;
    for (let page = 0; page < 50; page++) {
      const r = await referrals.stripe('GET', 'subscriptions', { status: 'active', limit: 100, expand: ['data.customer'], ...(after ? { starting_after: after } : {}) });
      subs.push(...r.data);
      if (!r.has_more) break;
      after = r.data[r.data.length - 1].id;
    }
    const seen = new Set(), lines = [], todo = [];
    for (const sub of subs) {
      const c = sub.customer;
      if (!c || c.deleted || seen.has(c.id)) continue;
      seen.add(c.id);
      if (c.metadata && c.metadata.referral_code) {
        // Quick: no Stripe calls, just makes sure Brevo has it
        if (!dry) { try { await referrals.ensureReferralCode(c); } catch (e) { lines.push(`Brevo sync failed for ${c.email}: ${e.message}`); } }
        lines.push(`Already has a code: ${c.metadata.referral_code}  (${c.email || c.id})`);
      } else todo.push(c);
    }
    let made = 0;
    for (const c of todo) {
      if (dry) { lines.push(`Would create: ${referrals.candidates(c.name, c.email)[0]}  (${c.email || c.id})`); continue; }
      if (made >= BATCH || Date.now() - started > 7000) continue;
      try {
        const r = await referrals.ensureReferralCode(c);
        lines.push(`Created: ${r.code}  (${r.email})`);
        made++;
      } catch (e) {
        lines.push(`FAILED for ${c.email || c.id}: ${e.message}`);
        made++;
      }
    }
    const left = dry ? 0 : todo.length - made;
    const head = dry ? `Dry run: ${todo.length} subscriber(s) need a code.`
      : left > 0 ? `${left} subscriber(s) still to do. Refresh this page to carry on.`
      : `All done. ${seen.size} active subscriber(s) have a referral code.`;
    return new Response(head + '\n\n' + lines.join('\n') + '\n', { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  } catch (e) {
    console.error('[referrals] backfill failed:', e.message);
    return new Response('Backfill failed: ' + e.message, { status: 500 });
  }
};
