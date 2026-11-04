/*
 * Scōp — run the affiliate report on demand
 *
 *   https://scopsupplement.uk/.netlify/functions/affiliate-report-run?key=YOUR_REPORT_SECRET
 *   add &month=2026-11 for a specific month (default: last month)
 *   add &view=1 to see the report in the browser instead of emailing it
 *   add &partner=MJW10&view=1 to preview one partner's statement
 *   add &partners=1 to (re)send the partner statements to you
 *
 * Protected by REPORT_SECRET (Netlify environment variable). Without the right
 * key it does nothing.
 */
import { buildReport, sendReport, toHtml, partnerStatement, partnerHtml, sendPartnerStatements } from '../lib/affiliate-report.mjs';

export default async (req) => {
  const url = new URL(req.url);
  const secret = process.env.REPORT_SECRET;
  if (!secret || url.searchParams.get('key') !== secret) {
    return new Response('Not found', { status: 404 });
  }
  try {
    const report = await buildReport({ month: url.searchParams.get('month') || undefined });
    const partner = url.searchParams.get('partner');
    if (partner) {
      const st = partnerStatement(report, partner);
      if (!st) return new Response('No partner with that code', { status: 404 });
      return new Response(`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><body style="padding:24px;background:#fff;">${partnerHtml(st)}</body>`,
        { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (url.searchParams.get('partners')) {
      const done = await sendPartnerStatements(report);
      return new Response(done.join('\n') || 'No partners set up', { status: 200 });
    }
    if (url.searchParams.get('view')) {
      return new Response(`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><body style="padding:24px;background:#f6f1ea;">${toHtml(report)}</body>`,
        { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    await sendReport(report);
    const done = await sendPartnerStatements(report);
    return new Response(`Report for ${report.win.label} sent to ${report.cfg.to}\n` + (done.join('\n') || 'No partner breakdowns'), { status: 200 });
  } catch (e) {
    console.error('[affiliate] manual run failed:', e.message);
    return new Response('Report failed: ' + e.message, { status: 500 });
  }
};
