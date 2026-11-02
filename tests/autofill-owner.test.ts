import { expect, test } from 'bun:test';
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAutofillApp } from '../src/autofill-owner';
import { HostedAccounts } from '../src/hosted-accounts';
import type { WorkspaceState, WorkspaceStoredData } from '../src/agent-types';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'AutoMate-owner-'));
  const browser = await chromium.launch({ headless: true });
  const accounts = await HostedAccounts.open({ directory, registrationKey: 'qa-operator-fixture-key-123' });
  const account = await accounts.register('native-fixture', 'qa-native-fixture-passphrase', 'qa-operator-fixture-key-123');
  let active = true;
  let saved: WorkspaceStoredData | null = null;
  let state: WorkspaceState | undefined;
  const app = await openAutofillApp({ viewer: browser, auditDirectory: directory, informationVault: account.informationVault,
    protection: { assertActive() { if (!active) throw Error('SESSION_UNAVAILABLE'); }, close() { active = false; } },
    workspaceStore: { async load() { return saved; }, async save(data) { saved = structuredClone(data); } },
    onUpdate(update) { if (update && typeof update === 'object' && 'kind' in update && update.kind === 'workspace' && 'state' in update) state = update.state as WorkspaceState; },
  });
  await app.command({ action: 'workspace-init' });
  return { app, account, get state() { return state!; }, deactivate() { active = false; }, async close() { try { await app.close(); } finally { await browser.close(); await account.close(); await rm(directory, { recursive: true, force: true }); } } };
}

test('native owner blocks vault mutation after workstation authority is lost, but Stop remains available', async () => {
  const current = await fixture();
  try {
    current.deactivate();
    await expect(current.app.command({ action: 'workspace-save-variable', input: { name: 'Unauthorized', description: 'Must not save', value: 'private-value', kind: 'text', scope: 'profile', origin: 'https://example.com' } })).rejects.toThrow();
    expect(await current.account.informationVault.catalog('https://example.com')).toEqual([]);
    await current.app.command({ action: 'workspace-stop' });
    expect(current.state.phase).toBe('stopped');
    expect(current.state.request).toBeUndefined();
    expect(current.state.permission).toBeUndefined();
  } finally { await current.close(); }
});

test('the desktop settings surface never renders a saved API key and can be reopened after Stop', async () => {
  const current = await fixture();
  try {
    const apiKey = 'qa-api-key-not-for-owner-snapshot-7381';
    await current.app.command({ action: 'workspace-settings', settings: { model: { mode: 'cloud', preset: 'custom', endpoint: 'https://api.example.com/v1/chat/completions', model: 'configured-model', apiKey }, navigation: { mode: 'blacklist', domains: [] }, memory: { enabled: false, content: '' }, groups: [] } });
    expect(current.state.settings.model.keyConfigured).toBe(true);
    expect(JSON.stringify(current.state)).not.toContain(apiKey);
    await current.app.page.locator('#open-settings-btn').click();
    expect(await current.app.page.locator('#setting-model-apikey').inputValue()).toBe('');
    await current.app.page.locator('#close-settings-btn').click();
    await current.app.command({ action: 'workspace-stop' });
    await current.app.page.locator('#open-settings-btn').click();
    expect(await current.app.page.locator('#settings-modal').evaluate(dialog => (dialog as HTMLDialogElement).open)).toBe(true);
  } finally { await current.close(); }
});

test('native named-variable metadata is listed without values and usernames cannot be saved as shared-profile credentials', async () => {
  const current = await fixture();
  try {
    const input = { name: 'Preferred Name', description: 'Name for sign-up forms', value: 'private-name-839', kind: 'text', scope: 'profile', origin: 'https://example.com' };
    await current.app.command({ action: 'workspace-save-variable', input });
    expect(current.state.variables.map(variable => ({ name: variable.name, description: variable.description }))).toEqual([{ name: input.name, description: input.description }]);
    expect(JSON.stringify(current.state)).not.toContain(input.value);
    await expect(current.app.command({ action: 'workspace-save-variable', input: { ...input, name: 'Login', kind: 'username' } })).rejects.toThrow();
    expect((await current.account.informationVault.catalog('https://example.com')).map(variable => variable.name)).toEqual(['Preferred Name']);
  } finally { await current.close(); }
});
