import { openAutofillApp } from '../src/autofill-owner';
import { runHosted } from './run-hosted';

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--hosted')) {
    throw new Error('INVALID_START_ARGUMENT');
  }
  if (args[0] === '--hosted') {
    await runHosted([]);
  } else {
    const app = await openAutofillApp();
    console.log('Auto-Mate website autofill opened. Inspect an HTTPS website, choose a vault record, and approve individual fields.');
    console.log('Normal vault operations require Windows Hello. No model receives vault values, pages, or preview frames.');
    console.log('Fill only: the app does not click Login, Pay, or Submit. Filling itself discloses data to website scripts.');
    console.log('Development software: use public test forms and fictitious data until your hardware authentication and lifecycle behavior are verified.');
    console.log('Metadata-safe audit journal: ' + app.auditPath);
    try { await app.closed; } finally { await app.close(); }
  }
} catch (error) {
  const code = error instanceof Error ? error.message : '';
  if (code === 'INVALID_START_ARGUMENT') {
    console.error('Usage: Auto-Mate.exe [--hosted]');
  } else if (process.argv.slice(2)[0] === '--hosted') {
    console.error('Auto-Mate hosted service could not start or close safely: ' + (error instanceof Error ? error.message : String(error)));
  } else {
    console.error('Auto-Mate could not start or close safely. Check Windows session protection, Chromium, and local audit/vault access.');
  }
  process.exitCode = 1;
}
