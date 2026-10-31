import { chromium, type Browser } from 'playwright';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PolicyBroker } from '../src/policy';
import { OwnerPreview } from '../src/owner-preview';
import { register, type Registration, type WorkflowResult } from '../src/workflow';
import { SYNTHETIC_VAULT_ROOT, WindowsPasswordStore } from '../src/windows-vault';
import { LocalAuditJournal } from '../src/audit';

const origin = 'https://registration.auto-mate.test';
const registration: Registration = {
  origin, path: '/signup',
  email: { id: 'account-email', credential: 'registration-email', name: 'Account email', category: 'yellow', fieldSelector: '#email', requestSelector: '#email-request' },
  password: { id: 'account-password', credential: 'registration-password', name: 'New password', category: 'red', fieldSelector: '#password', requestSelector: '#password-request' },
  submitSelector: '#submit', successSelector: '#success',
};
const fixtureStyle = 'body{margin:0;background:#fff;color:#222;font:18px/1.5 "Segoe UI",sans-serif}main{width:480px;max-width:calc(100% - 64px);margin:64px auto}small{font-size:14px;color:#555}h1{font-size:30px;font-weight:600;margin:20px 0 8px}p{color:#555;margin:0 0 28px}label{display:block;margin:24px 0 8px}input{box-sizing:border-box;width:100%;height:48px;border:1px solid #8b9399;border-radius:5px;font:inherit;padding:8px 12px}button{margin-top:28px;background:#24282b;color:white;border:0;border-radius:5px;padding:13px 24px;font:inherit}';
const form = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic registration</title><style>${fixtureStyle}</style></head><body><main><small>Auto-Mate test website · Synthetic data only</small><h1>Create an account</h1><p>A controlled registration page, not a real service.</p><form method="post" action="/register"><label id="email-request" for="email">Email for your account</label><input id="email" name="email" type="email" autocomplete="off"><label id="password-request" for="password">Choose a password for this account</label><input id="password" name="password" type="password" autocomplete="new-password"><button id="submit">Create account</button></form></main></body></html>`;
const success = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic registration accepted</title><style>${fixtureStyle}</style></head><body><main><small>Auto-Mate test website · Synthetic data only</small><h1 id="success">Registration accepted</h1><p>The controlled website accepted the submitted form. The generated password remains in the temporary encrypted vault until the demo closes.</p></main></body></html>`;

/** Development demonstration. Approval never authorizes real vaults or other tasks. */
export async function openPreviewDemo(options: {
  headlessOwner?: boolean; delayMs?: number; viewer?: Browser; auditDirectory?: string;
} = {}) {
  const auditDirectory = options.auditDirectory ?? (process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'AutoMate', 'audit') : undefined);
  if (!auditDirectory) throw new Error('AUDIT_UNAVAILABLE');
  const journal = new LocalAuditJournal(auditDirectory);
  const policy = new PolicyBroker({ 'registration-email': 'yellow', 'registration-password': 'red' }, journal.append);
  const task = 'preview-registration';
  const completion = Promise.withResolvers<WorkflowResult>();
  let directory: string | undefined;
  let worker: Browser | undefined;
  let viewer: Browser | undefined;
  let owner: OwnerPreview | undefined;
  let running: Promise<WorkflowResult> | undefined;
  let submitted = false;
  let closed = false;

  async function close() {
    if (closed) return;
    closed = true;
    let failed = false;
    try { policy.stopAll(); } catch { failed = true; }
    const results = await Promise.allSettled([
      owner?.close(), worker?.close(), options.viewer ? undefined : viewer?.close(), running,
    ]);
    if (results.some(result => result.status === 'rejected')) failed = true;
    try { if (directory) await rm(directory, { recursive: true, force: true }); } catch { failed = true; }
    try { journal.close(); } catch { failed = true; }
    completion.resolve({ status: 'takeover', credentialSaved: false });
    if (failed) throw new Error('PREVIEW_CLEANUP_FAILED');
  }

  try {
    await mkdir(SYNTHETIC_VAULT_ROOT, { recursive: true });
    directory = await mkdtemp(join(SYNTHETIC_VAULT_ROOT, 'preview-'));
    worker = await chromium.launch({ headless: true });
    viewer = options.viewer ?? await chromium.launch({ headless: options.headlessOwner ?? false });
    owner = await OwnerPreview.open(viewer, {
      approval: { origin, credentials: [
        { name: 'Account email', category: policy.category('registration-email') },
        { name: 'New password', category: policy.category('registration-password') },
      ] },
      demoDelayMs: options.delayMs ?? 650,
      onStop: () => policy.stopAll(),
      onFault: () => policy.stopAll(),
      onDeny: () => {
        policy.denyApproval(task, origin);
        completion.resolve({ status: 'takeover', credentialSaved: false });
      },
      onApprove: approval => {
        const grant = policy.approve({
          task, origin, credentials: ['registration-email', 'registration-password'],
          layers: approval.layers, operations: ['fill', 'submit'],
          durationSeconds: approval.durationSeconds, maxSubmissions: 1,
        });
        running = register(worker!, policy, new WindowsPasswordStore({
          vaultPath: join(directory!, 'vault.json'), mode: 'synthetic',
        }), task, grant, registration, 'synthetic@example.test', async page => {
          await page.setViewportSize({ width: 1024, height: 720 });
          await page.route(`${origin}/**`, async route => {
            if (route.request().method() === 'POST') {
              const body = new URLSearchParams(route.request().postData() ?? '');
              if (body.get('email') !== 'synthetic@example.test' || (body.get('password')?.length ?? 0) < 20) {
                await route.abort(); return;
              }
              submitted = true;
              await route.fulfill({ contentType: 'text/html', body: success });
            } else await route.fulfill({ contentType: 'text/html', body: form });
          });
        }, owner);
        void running.then(completion.resolve, () => completion.resolve({ status: 'takeover', credentialSaved: false }));
      },
    });
    return { owner, finished: completion.promise, policy, auditPath: journal.path, wasSubmitted: () => submitted, close };
  } catch {
    await close().catch(() => {});
    throw new Error('PREVIEW_DEMO_UNAVAILABLE');
  }
}

if (import.meta.main) {
  const demo = await openPreviewDemo();
  console.log('Auto-Mate owner preview opened. Choose categories and a duration, then approve or deny the synthetic task.');
  console.log('Synthetic data only. No AI connected. No network preview server is running.');
  console.log('Metadata-safe audit journal: ' + demo.auditPath);
  try { await demo.owner.closed; } finally { await demo.close(); }
}
