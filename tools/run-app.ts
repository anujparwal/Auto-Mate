import { openAutofillApp } from '../src/autofill-owner';

try {
  const args = process.argv.slice(2);
  if (args.length > 0) throw new Error('INVALID_START_ARGUMENT');
  const app = await openAutofillApp();
  console.log('Auto-Mate website autofill opened. Inspect an HTTPS website, choose a vault record, and approve individual fields.');
  console.log('Normal vault operations require Windows Hello. No model receives vault values, pages, or preview frames.');
  console.log('Fill only: the app does not click Login, Pay, or Submit. Filling itself discloses data to website scripts.');
  console.log('Development software: use public test forms and fictitious data until your hardware authentication and lifecycle behavior are verified.');
  console.log('Metadata-safe audit journal: ' + app.auditPath);
  try { await app.closed; } finally { await app.close(); }
} catch (error) {
  const code = error instanceof Error ? error.message : '';
  console.error(code === 'INVALID_START_ARGUMENT'
    ? 'Usage: Auto-Mate.exe'
    : 'Auto-Mate could not start or close safely. Check Windows session protection, Chromium, and local audit/vault access.');
  process.exitCode = 1;
}
