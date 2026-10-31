import { chromium } from 'playwright';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { PolicyBroker } from '../src/policy';
import { register } from '../src/workflow';
import { SYNTHETIC_VAULT_ROOT, WindowsPasswordStore } from '../src/windows-vault';
import { LocalAuditJournal } from '../src/audit';

// Controlled HTTPS origin intercepted inside Chromium; no credentials sent to the internet.
const origin = 'https://registration.auto-mate.test';
await mkdir(SYNTHETIC_VAULT_ROOT, { recursive: true });
const directory = await mkdtemp(join(SYNTHETIC_VAULT_ROOT, 'smoke-'));
const vault = new WindowsPasswordStore({ vaultPath: join(directory, 'vault.json'), mode: 'synthetic' });
const browser = await chromium.launch();
let observedSubmission = false;
let submittedPassword: string | null = null;
const journal = new LocalAuditJournal(join(directory, 'audit'));
const policy = new PolicyBroker({ 'registration-email': 'yellow', 'registration-password': 'red' }, journal.append);
try {
  const grant = policy.approve({ task: 'smoke-registration', origin, credentials: ['registration-email', 'registration-password'], layers: ['yellow', 'red'], operations: ['fill', 'submit'], durationSeconds: 60, maxSubmissions: 1 });
  const result = await register(browser, policy, vault, 'smoke-registration', grant, {
    origin, path: '/signup',
    email: { id: 'email', name: 'Email', credential: 'registration-email', category: 'yellow', fieldSelector: '#email', requestSelector: '#email-label' },
    password: { id: 'password', name: 'Password', credential: 'registration-password', category: 'red', fieldSelector: '#password', requestSelector: '#password-label' },
    submitSelector: '#submit', successSelector: '#success',
  }, 'synthetic@example.test', async page => {
    await page.route(`${origin}/**`, async route => {
      if (route.request().method() === 'POST') {
        const body = new URLSearchParams(route.request().postData() ?? '');
        assert.equal(body.get('email'), 'synthetic@example.test');
        assert.match(body.get('password') ?? '', /^.{20,}$/);
        submittedPassword = body.get('password');
        assert.equal(policy.canObserve('smoke-registration'), false);
        observedSubmission = true;
        await route.fulfill({ contentType: 'text/html', body: '<h1 id="success">Registration accepted</h1>' });
      } else {
        await route.fulfill({ contentType: 'text/html', body: '<form method="post" action="/register"><label id="email-label" for="email">Email</label><input id="email" name="email" type="email"><label id="password-label" for="password">Password</label><input id="password" name="password" type="password"><button id="submit">Create account</button></form>' });
      }
    });
  });
  assert.deepEqual(result, { status: 'completed', credentialSaved: true });
  assert.equal(observedSubmission, true);
  assert.equal(policy.canObserve('smoke-registration'), false);
  const persisted = await Bun.file(join(directory, 'vault.json')).text();
  assert.equal(persisted.includes(origin), false);
  assert.ok(submittedPassword);
  assert.equal(persisted.includes(submittedPassword), false);
  const envelope: unknown = JSON.parse(persisted);
  assert.ok(envelope && typeof envelope === 'object' && 'version' in envelope);
  assert.equal(envelope.version, 2);
  assert.deepEqual(Object.keys(envelope).sort(), ['cipherText', 'version']);
  console.log('PASS: isolated synthetic Windows DPAPI persistence -> verified label/field fill -> Chromium POST -> bounded completion.');
  console.log('PASS: protected task observations disabled; no raw browser output returned.');
  console.log('PASS: persisted v2 envelope exposes neither destination metadata nor the submitted password.');
  const audit = await Bun.file(journal.path).text();
  assert.equal(audit.includes(origin), false);
  assert.equal(audit.includes('smoke-registration'), false);
  assert.equal(audit.includes('registration-password'), false);
  assert.equal(audit.includes(submittedPassword), false);
  const events = audit.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].event, 'approved');
  assert.equal(events.at(-1).event, 'completed');
  assert.equal(events.filter(event => event.event === 'submit_authorized').length, 1);
  console.log('PASS: durable journal records approval, credential use and completion without raw task/destination/credential values.');
} finally {
  await browser.close();
  journal.close();
  await rm(directory, { recursive: true, force: true });
}
