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
    console.log('Auto-Mate agent workspace opened.');
    console.log('Interactive browser agent with host-redacted observations, live preview, vault grants, and encrypted workspace storage.');
    console.log('Local vault operations require Windows Hello verification. Configure OpenAI-compatible model API in Settings.');
    console.log('Metadata-safe audit journal: ' + app.auditPath);
    try { await app.closed; } finally { await app.close(); }
  }
} catch (error) {
  const code = error instanceof Error ? error.message : '';
  if (code === 'INVALID_START_ARGUMENT') {
    console.error('Usage: bun start [--hosted]');
  } else if (process.argv.slice(2)[0] === '--hosted') {
    console.error('Auto-Mate hosted service could not start or close safely: ' + (error instanceof Error ? error.message : String(error)));
  } else {
    console.error('Auto-Mate could not start or close safely. Check Windows session protection, Chromium, and local audit/vault access.');
  }
  process.exitCode = 1;
}
