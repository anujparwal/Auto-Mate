import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { PolicyBroker } from '../src/policy';
import { register } from '../src/workflow';
import { WindowsPasswordStore } from '../src/windows-vault';

// Controlled HTTPS origin intercepted inside Chromium; no credentials sent to the internet.
const origin = 'https://registration.auto-mate.test';
const directory = await mkdtemp(join(tmpdir(), 'auto-mate-smoke-'));
const vault = new WindowsPasswordStore(join(directory, 'vault.json'));
const browser = await chromium.launch();
let observedSubmission = false;
const policy = new PolicyBroker();
const grant = policy.approve({ task: 'smoke-registration', origin, credentials: ['registration-email', 'registration-password'], operations: ['fill', 'submit'], durationSeconds: 60, maxSubmissions: 1 });
try {
  const result = await register(browser, policy, vault, 'smoke-registration', grant, {
    origin, path: '/signup', emailSelector: '#email', passwordSelector: '#password', submitSelector: '#submit', successSelector: '#success',
  }, 'synthetic@example.test', async page => {
    await page.route(`${origin}/**`, async route => {
      if (route.request().method() === 'POST') {
        const body = new URLSearchParams(route.request().postData() ?? '');
        assert.equal(body.get('email'), 'synthetic@example.test');
        assert.match(body.get('password') ?? '', /^.{20,}$/);
        assert.equal(policy.canObserve('smoke-registration'), false);
        observedSubmission = true;
        await route.fulfill({ contentType: 'text/html', body: '<h1 id="success">Registration accepted</h1>' });
      } else {
        await route.fulfill({ contentType: 'text/html', body: '<form method="post" action="/register"><input id="email" name="email" type="email"><input id="password" name="password" type="password"><button id="submit">Create account</button></form>' });
      }
    });
  });
  assert.deepEqual(result, { status: 'completed', credentialSaved: true });
  assert.equal(observedSubmission, true);
  assert.equal(policy.canObserve('smoke-registration'), false);
  const persisted = await Bun.file(join(directory, 'vault.json')).text();
  assert.equal(persisted.includes('synthetic@example.test'), false);
  console.log('PASS: Windows DPAPI persistence -> Chromium protected fill -> POST -> bounded completion.');
  console.log('PASS: protected task observations disabled; no raw browser output returned.');
  console.log(JSON.stringify(policy.audit(), null, 2));
} finally {
  await browser.close();
  await rm(directory, { recursive: true, force: true });
}
