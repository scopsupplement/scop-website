/*
 * Scōp — run the affiliate report on demand
 *
 *   https://scopsupplement.uk/.netlify/functions/affiliate-report-run?key=YOUR_REPORT_SECRET
 *   add &month=2026-11 for a specific month (default: last month)
 *   add &view=1 to see the report in the browser instead of emailing it
 *
 * Protected by REPORT_SECRET (Netlify environment variable). Without the right
 * key it does nothing.
 */
import { buildReport, sendReport, toHtml } from '../lib/affiliate-report.mjs';

export default async (req) => {
  const url = new URL(req.url);
  const secret = process.env.REPORT_SECRET;
  if (!secret || url.searchParams.get('key') !== secret) {
    return new Response('Not found', { status: 404 });
  }
  try {
    const report = await buildReport({ month: url.searchParams.get('month') || undefined });
    if (url.searchParams.get('view')) {
      return new Response(`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><body style="padding:24px;background:#f6f1ea;">${toHtml(report)}</body>`,
        { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    await sendReport(report);
    return new Response(`Report for ${report.win.label} sent to ${report.cfg.to}`, { status: 200 });
  } catch (e) {
    console.error('[affiliate] manual run failed:', e.message);
    return new Response('Report failed: ' + e.message, { status: 500 });
  }
};
