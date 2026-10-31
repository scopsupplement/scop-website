/*
 * Scōp — monthly affiliate commission email
 * Runs automatically at 07:00 UTC on the 1st of every month and emails the
 * report for the month that just ended, then one statement per partner
 * (only their own code, customers anonymised), all sent to you only. Logic lives in ../lib/affiliate-report.mjs.
 * To run it by hand (or for an earlier month) use affiliate-report-run.
 */
import { buildReport, sendReport, sendPartnerStatements } from '../lib/affiliate-report.mjs';

export default async () => {
  try {
    const report = await buildReport();
    await sendReport(report);
    console.log(`[affiliate] sent report for ${report.win.label}: ${report.rows.length} coded payment(s)`);
    const done = await sendPartnerStatements(report);
    done.forEach(d => console.log('[affiliate] ' + d));
  } catch (e) {
    console.error('[affiliate] report failed:', e.message);
  }
};

export const config = { schedule: '0 7 1 * *' };
