import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerPreview } from '../src/owner-preview';
import { LocalAuditHistory } from '../src/audit-history';
import { TaskPlanner } from '../src/task-planner';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

async function command(page: Page, raw: unknown) {
  return page.evaluate(async value => {
    try { await window.autoMateOwnerCommand!(value); return 'accepted'; }
    catch { return 'denied'; }
  }, raw);
}
async function plan(page: Page, prompt: string, allowCloud = false) {
  return page.evaluate(async value => {
    try { await window.autoMatePlanTask!(value); return 'accepted'; }
    catch { return 'denied'; }
  }, { prompt, allowCloud });
}
async function fixture(planner: TaskPlanner) {
  const directory = await mkdtemp(join(tmpdir(), 'automate-owner-planning-'));
  let approved = 0;
  let stopped = 0;
  const owner = await OwnerPreview.open(browser, {
    planner, history: new LocalAuditHistory(directory),
    approval: { origin: 'https://registration.auto-mate.test', credentials: [
      { name: 'Account email', category: 'yellow' }, { name: 'New password', category: 'red' },
    ] },
    onApprove: () => { approved++; }, onDeny: () => {},
    onStop: () => { stopped++; }, onFault: () => {},
  });
  return { owner, approved: () => approved, stopped: () => stopped, async close() {
    await owner.close(); await rm(directory, { recursive: true, force: true });
  } };
}
const approve = { action: 'approve', layers: ['yellow', 'red'], durationSeconds: 60 };

test('approval cannot bypass missing or unsupported plans; accepted planning still requires a separate owner action', async () => {
  const app = await fixture(new TaskPlanner({ mode: 'reviewed' }));
  try {
    expect(await command(app.owner.page, approve)).toBe('denied');
    await plan(app.owner.page, 'Log into a real bank');
    expect(await app.owner.page.locator('#planner-error').textContent()).toContain('Unsupported task');
    expect(await command(app.owner.page, approve)).toBe('denied');
    expect(app.approved()).toBe(0);
    await plan(app.owner.page, 'Run synthetic registration');
    expect(await app.owner.page.locator('#task-plan').isVisible()).toBe(true);
    expect(app.approved()).toBe(0);
    expect(await command(app.owner.page, approve)).toBe('accepted');
    expect(app.approved()).toBe(1);
    expect(await command(app.owner.page, approve)).toBe('denied');
    expect(await plan(app.owner.page, 'Run synthetic registration')).toBe('denied');
  } finally { await app.close(); }
});

test('cloud planning requires explicit disclosure consent even when bypassing the UI', async () => {
  // No request can be issued without consent; this reserved endpoint must never be contacted.
  const app = await fixture(new TaskPlanner({ mode: 'cloud', endpoint: 'https://provider.invalid/v1/chat/completions', model: 'test', apiKey: 'synthetic-key' }));
  try {
    expect(await plan(app.owner.page, 'Run synthetic registration', false)).toBe('denied');
    expect(await command(app.owner.page, approve)).toBe('denied');
    expect(app.approved()).toBe(0);
    expect(await app.owner.page.locator('#planner-status').textContent()).toContain('Waiting for a task');
  } finally { await app.close(); }
});

test('Stop during a pending model request cannot be undone by a late valid plan', async () => {
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() {
    started.resolve(); await gate.promise;
    return Response.json({ choices: [{ message: { content: '{"workflow":"synthetic-registration"}' } }] });
  } });
  const app = await fixture(new TaskPlanner({ mode: 'local', endpoint: `http://127.0.0.1:${server.port}/v1/chat/completions`, model: 'fixture' }));
  try {
    const pending = plan(app.owner.page, 'Create a synthetic account');
    await started.promise;
    expect(await command(app.owner.page, approve)).toBe('denied');
    expect(await command(app.owner.page, { action: 'stop' })).toBe('accepted');
    gate.resolve(); await pending;
    expect(await app.owner.page.locator('#phase').textContent()).toBe('Stopped');
    expect(await app.owner.page.locator('#task-plan').isVisible()).toBe(false);
    expect(await command(app.owner.page, approve)).toBe('denied');
    expect(app.approved()).toBe(0);
    expect(app.stopped()).toBe(1);
  } finally { gate.resolve(); await app.close(); await server.stop(true); }
});
