import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openAutofillApp, type AutofillAppState } from '../src/autofill-owner';
import type { AutofillVault, VaultEntry, VaultRecord } from '../src/autofill-contract';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

const origin = 'https://owner-autofill.test';
const form = '<!doctype html><body style="margin:64px;font:18px sans-serif"><form method="post"><label for="username">Username</label><input id="username" autocomplete="username"><label for="password">Password</label><input id="password" type="password" autocomplete="current-password"><button>Login</button></form></body>';
const login: VaultRecord = { version: 1, kind: 'login', username: 'public-test-user', password: 'synthetic-test-password' };
const card: VaultRecord = {
  version: 1,
  kind: 'card',
  cardholder: 'Public Test User',
  cardNumber: '4111111111111111',
  expiryMonth: '12',
  expiryYear: '2028',
};

declare global {
  interface Window {
    testAutofillRevision?: number;
    testAutofillState?: AutofillAppState;
  }
}

interface FixtureOptions {
  read?: () => Promise<VaultRecord>;
  list?: (origin: string) => Promise<readonly VaultEntry[]>;
  save?: (origin: string, recordId: string, record: VaultRecord) => Promise<void>;
  initiallyActive?: boolean;
  initialEntries?: readonly VaultEntry[];
}

async function fixture(optionsOrRead?: (() => Promise<VaultRecord>) | FixtureOptions, initiallyActiveParam = true) {
  const options: FixtureOptions = typeof optionsOrRead === 'function'
    ? { read: optionsOrRead, initiallyActive: initiallyActiveParam }
    : optionsOrRead ?? { initiallyActive: initiallyActiveParam };

  const directory = await mkdtemp(join(tmpdir(), 'automate-autofill-owner-'));
  let reads = 0;
  let writes = 0;
  let lists = 0;
  let submissions = 0;
  let worker: Page | undefined;
  const savedRecords: Array<{ origin: string; recordId: string; record: VaultRecord }> = [];
  const entries: VaultEntry[] = [...(options.initialEntries ?? [])];

  const vault: AutofillVault = {
    async list(targetOrigin) {
      lists++;
      if (options.list) return options.list(targetOrigin);
      return entries.filter(e => e.origin === targetOrigin);
    },
    async save(targetOrigin, recordId, record) {
      writes++;
      savedRecords.push({ origin: targetOrigin, recordId, record });
      if (options.save) await options.save(targetOrigin, recordId, record);
    },
    async read() {
      reads++;
      return options.read ? options.read() : login;
    },
  };

  const active = options.initiallyActive ?? initiallyActiveParam;
  const app = await openAutofillApp({
    viewer: browser,
    vault,
    auditDirectory: directory,
    protection: {
      assertActive() {
        if (!active) throw new Error('SESSION_UNAVAILABLE');
      },
      close() {},
    },
    async prepareWebsite(page) {
      worker = page;
      await page.route(origin + '/**', async route => {
        if (route.request().method() === 'POST') submissions++;
        await route.fulfill({ contentType: 'text/html', body: form });
      });
    },
  });

  await app.page.evaluate(() => {
    const update = window.autoMateAutofillUpdate;
    window.autoMateAutofillUpdate = value => {
      if (value && typeof value === 'object' && 'state' in value && value.state && typeof value.state === 'object') {
        window.testAutofillState = value.state as AutofillAppState;
        if ('revision' in value.state && typeof value.state.revision === 'number') {
          window.testAutofillRevision = value.state.revision;
        }
      }
      update(value);
    };
  });

  async function inspect(path = '/') {
    await app.page.locator('#website-url').fill(origin + path);
    await app.page.locator('#inspect').click();
    await app.page.waitForFunction(() => document.querySelector('#phase')?.textContent === 'Awaiting field approval');
  }

  const send = (command: unknown) => app.page.evaluate(async cmd => {
    await window.autoMateAutofill!(cmd);
  }, command);

  const getState = (): Promise<AutofillAppState> => app.page.evaluate(() => window.testAutofillState as AutofillAppState);
  const getRevision = (): Promise<number> => app.page.evaluate(() => window.testAutofillRevision ?? 0);

  return {
    app,
    inspect,
    send,
    getState,
    getRevision,
    reads: () => reads,
    writes: () => writes,
    lists: () => lists,
    submissions: () => submissions,
    savedRecords: () => [...savedRecords],
    hasWorker: () => worker !== undefined,
    worker: () => {
      if (!worker) throw new Error('TEST_WORKER_MISSING');
      return worker;
    },
    async close() {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('only explicitly checked owner fields are disclosed; no app submission and no vault access while inspecting', async () => {
  const fixtureApp = await fixture();
  try {
    await fixtureApp.inspect();
    expect(fixtureApp.reads()).toBe(0);
    expect(await fixtureApp.app.page.locator('#fill').isEnabled()).toBe(false);
    expect(await fixtureApp.app.page.locator('#fields input:checked').count()).toBe(0);
    await fixtureApp.app.page.locator('#record-id').fill('test-record');
    await fixtureApp.app.page.locator('#fields input[value=username]').check();
    await fixtureApp.app.page.locator('#fill').click();
    await fixtureApp.app.page.waitForFunction(() => document.querySelector('#phase')?.textContent?.startsWith('Filled'));
    expect(await fixtureApp.worker().locator('#username').inputValue()).toBe('public-test-user');
    expect(await fixtureApp.worker().locator('#password').inputValue()).toBe('');
    expect(fixtureApp.worker().isClosed()).toBe(false);
    expect(fixtureApp.reads()).toBe(1);
    expect(fixtureApp.submissions()).toBe(0);
  } finally { await fixtureApp.close(); }
});

test('stale website approval and invented fields are rejected before native record access', async () => {
  const fixtureApp = await fixture();
  try {
    await fixtureApp.inspect('/first');
    const revision = await fixtureApp.app.page.evaluate(() => window.testAutofillRevision);
    await fixtureApp.inspect('/second');
    await fixtureApp.app.page.evaluate(async oldRevision => {
      await window.autoMateAutofill!({ action: 'fill', revision: oldRevision, recordId: 'test-record', fields: ['username'], durationSeconds: 60 });
    }, revision);
    expect(fixtureApp.reads()).toBe(0);
    await fixtureApp.app.page.evaluate(async () => {
      await window.autoMateAutofill!({ action: 'fill', revision: window.testAutofillRevision, recordId: 'test-record', fields: ['cvv'], durationSeconds: 60 });
    });
    expect(fixtureApp.reads()).toBe(0);
    expect(await fixtureApp.worker().locator('#username').inputValue()).toBe('');
    expect(await fixtureApp.worker().locator('#password').inputValue()).toBe('');
  } finally { await fixtureApp.close(); }
});

test('Stop closes the website while native retrieval is pending and a late record cannot fill it', async () => {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<VaultRecord>();
  const fixtureApp = await fixture(async () => { entered.resolve(); return released.promise; });
  try {
    await fixtureApp.inspect();
    await fixtureApp.app.page.locator('#record-id').fill('test-record');
    await fixtureApp.app.page.locator('#fields input[value=password]').check();
    await fixtureApp.app.page.locator('#fill').click();
    await entered.promise;
    const worker = fixtureApp.worker();
    const closed = worker.waitForEvent('close');
    await fixtureApp.app.page.locator('#stop').click();
    await closed;
    expect(worker.isClosed()).toBe(true);
    expect(fixtureApp.submissions()).toBe(0);
    released.resolve(login);
    await fixtureApp.app.page.waitForFunction(() => !document.querySelector('#inspect')?.hasAttribute('disabled'));
    expect(await fixtureApp.app.page.locator('#phase').textContent()).toBe('Stopped');
  } finally { released.resolve(login); await fixtureApp.close(); }
});

test('inactive workstation protection prevents vault use even with a direct owner approval command', async () => {
  const fixtureApp = await fixture(undefined, false);
  try {
    await fixtureApp.inspect();
    await fixtureApp.app.page.locator('#record-id').fill('test-record');
    await fixtureApp.app.page.locator('#fields input[value=password]').check();
    await fixtureApp.app.page.locator('#fill').click();
    await fixtureApp.app.page.waitForFunction(() => document.querySelector('#phase')?.textContent === 'Stopped');
    expect(fixtureApp.reads()).toBe(0);
    expect(fixtureApp.writes()).toBe(0);
    expect(fixtureApp.submissions()).toBe(0);
  } finally { await fixtureApp.close(); }
});

test('vault save before inspect stores record for explicit origin without creating browser, grant, or fill', async () => {
  const fixtureApp = await fixture();
  try {
    const revision = await fixtureApp.getRevision();
    await fixtureApp.send({
      action: 'vault-save',
      revision,
      origin: 'https://vault-target.test',
      recordId: '  exact-untrimmed-id  ',
      record: login,
    });
    expect(fixtureApp.writes()).toBe(1);
    expect(fixtureApp.reads()).toBe(0);
    expect(fixtureApp.hasWorker()).toBe(false);
    expect(fixtureApp.submissions()).toBe(0);
    expect(fixtureApp.savedRecords()[0]).toEqual({
      origin: 'https://vault-target.test',
      recordId: '  exact-untrimmed-id  ',
      record: login,
    });

    const stateAfterLogin = await fixtureApp.getState();
    expect(stateAfterLogin.phase).toBe('idle');
    expect(stateAfterLogin.vault.error).toBe('');

    // Save a valid card record before inspection
    await fixtureApp.send({
      action: 'vault-save',
      revision: await fixtureApp.getRevision(),
      origin: 'https://vault-target.test',
      recordId: 'card-record-1',
      record: card,
    });
    expect(fixtureApp.writes()).toBe(2);
    expect(fixtureApp.reads()).toBe(0);
    expect(fixtureApp.hasWorker()).toBe(false);
  } finally { await fixtureApp.close(); }
});

test('vault list before inspect returns allowlisted native metadata only and no secret fields', async () => {
  const initialEntries: VaultEntry[] = [
    {
      origin: 'https://vault-target.test',
      recordId: 'login-cred-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      extraSecretData: 'leak-attempt',
      vaultPath: 'C:/sensitive/vault.db',
    } as unknown as VaultEntry,
  ];
  const fixtureApp = await fixture({ initialEntries });
  try {
    const revision = await fixtureApp.getRevision();
    await fixtureApp.send({
      action: 'vault-list',
      revision,
      origin: 'https://vault-target.test',
    });

    expect(fixtureApp.reads()).toBe(0);
    expect(fixtureApp.hasWorker()).toBe(false);

    const state = await fixtureApp.getState();
    expect(state.phase).toBe('idle');
    expect(state.vault.locked).toBe(false);
    expect(state.vault.origin).toBe('https://vault-target.test');
    expect(state.vault.entries).toHaveLength(1);
    expect(state.vault.entries[0]).toEqual({
      origin: 'https://vault-target.test',
      recordId: 'login-cred-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    // Verify secret fields and extra adapter properties are not in published state
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain('synthetic-test-password');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('cardNumber');
    expect(serialized).not.toContain('ciphertext');
    expect(serialized).not.toContain('leak-attempt');
    expect(serialized).not.toContain('sensitive/vault.db');
  } finally { await fixtureApp.close(); }
});

test('malformed and export/read commands are denied', async () => {
  const fixtureApp = await fixture();
  try {
    const rev = await fixtureApp.getRevision();

    // Export commands denied
    await fixtureApp.send({ action: 'export', revision: rev });

    // Generic read commands denied
    await fixtureApp.send({ action: 'read', revision: rev, origin: 'https://vault-target.test' });

    // Old list and save actions denied
    await fixtureApp.send({ action: 'list', revision: rev });
    await fixtureApp.send({ action: 'save', revision: rev, recordId: 'id', record: login });

    // Malformed records (e.g. CVV included) denied
    const recordWithCvv = { ...login, cvv: '123' };
    await fixtureApp.send({ action: 'vault-save', revision: rev, origin: 'https://vault-target.test', recordId: 'id', record: recordWithCvv });

    // Extra keys on vault-save command denied
    await fixtureApp.send({ action: 'vault-save', revision: rev, origin: 'https://vault-target.test', recordId: 'id', record: login, extraKey: 'denied' });

    // Extra keys on vault-list command denied
    await fixtureApp.send({ action: 'vault-list', revision: rev, origin: 'https://vault-target.test', extraKey: 'denied' });

    // Extra keys on vault-lock command denied
    await fixtureApp.send({ action: 'vault-lock', revision: rev, extraKey: 'denied' });

    // Zero vault operations were performed
    expect(fixtureApp.writes()).toBe(0);
    expect(fixtureApp.reads()).toBe(0);
    expect(fixtureApp.lists()).toBe(0);
  } finally { await fixtureApp.close(); }
});

test('origin and revision validation rejects non-origin URLs and stale revisions', async () => {
  const fixtureApp = await fixture();
  try {
    const rev = await fixtureApp.getRevision();

    // Origin with path rejected
    await fixtureApp.send({ action: 'vault-list', revision: rev, origin: 'https://vault-target.test/login' });

    // Origin with query rejected
    await fixtureApp.send({ action: 'vault-list', revision: rev, origin: 'https://vault-target.test?param=1' });

    // Origin with credentials rejected
    await fixtureApp.send({ action: 'vault-list', revision: rev, origin: 'https://user:pass@vault-target.test' });

    // Non-HTTPS origin rejected
    await fixtureApp.send({ action: 'vault-list', revision: rev, origin: 'http://vault-target.test' });

    // Stale revision on vault-list rejected
    await fixtureApp.send({ action: 'vault-list', revision: rev + 99, origin: 'https://vault-target.test' });

    // Stale revision on vault-save rejected
    await fixtureApp.send({ action: 'vault-save', revision: rev + 99, origin: 'https://vault-target.test', recordId: 'id', record: login });

    expect(fixtureApp.writes()).toBe(0);
    expect(fixtureApp.reads()).toBe(0);
    expect(fixtureApp.lists()).toBe(0);
  } finally { await fixtureApp.close(); }
});

test('Stop invalidates pending vault response and prevents late results from repopulating metadata', async () => {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<readonly VaultEntry[]>();

  const fixtureApp = await fixture({
    async list() {
      entered.resolve();
      return released.promise;
    },
  });

  try {
    const rev = await fixtureApp.getRevision();
    void fixtureApp.send({ action: 'vault-list', revision: rev, origin: 'https://vault-target.test' });
    await entered.promise;

    // Send Stop while vault-list is pending
    await fixtureApp.send({ action: 'stop', revision: rev });

    const stateAfterStop = await fixtureApp.getState();
    expect(stateAfterStop.phase).toBe('stopped');
    expect(stateAfterStop.vault.locked).toBe(true);
    expect(stateAfterStop.vault.entries).toHaveLength(0);

    // Release late vault list result
    released.resolve([
      { origin: 'https://vault-target.test', recordId: 'late-record', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]);

    await fixtureApp.app.page.waitForFunction(() => !document.querySelector('#inspect')?.hasAttribute('disabled'));

    const stateAfterRelease = await fixtureApp.getState();
    expect(stateAfterRelease.vault.locked).toBe(true);
    expect(stateAfterRelease.vault.entries).toHaveLength(0);
  } finally {
    released.resolve([]);
    await fixtureApp.close();
  }
});

test('vault-lock clears metadata and closes active execution even with an older inspection revision', async () => {
  const initialEntries: VaultEntry[] = [
    { origin: 'https://vault-target.test', recordId: 'my-cred', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  ];
  const fixtureApp = await fixture({ initialEntries });
  try {
    const rev = await fixtureApp.getRevision();
    await fixtureApp.send({ action: 'vault-list', revision: rev, origin: 'https://vault-target.test' });

    const unlockedState = await fixtureApp.getState();
    expect(unlockedState.vault.locked).toBe(false);
    expect(unlockedState.vault.entries).toHaveLength(1);
    await fixtureApp.inspect();
    await fixtureApp.app.page.locator('#record-id').fill('test-record');
    await fixtureApp.app.page.locator('#fields input[value=username]').check();
    await fixtureApp.app.page.locator('#fill').click();
    await fixtureApp.app.page.waitForFunction(() => document.querySelector('#phase')?.textContent?.startsWith('Filled'));
    await fixtureApp.send({ action: 'vault-list', revision: await fixtureApp.getRevision(), origin: 'https://vault-target.test' });

    await fixtureApp.send({ action: 'vault-lock', revision: rev });

    const lockedState = await fixtureApp.getState();
    expect(lockedState.vault.locked).toBe(true);
    expect(lockedState.vault.entries).toHaveLength(0);
    expect(lockedState.vault.origin).toBeUndefined();
    expect(lockedState.phase).toBe('stopped');
    expect(fixtureApp.worker().isClosed()).toBe(true);
    // Ensure no records were deleted
    expect(fixtureApp.writes()).toBe(0);
  } finally { await fixtureApp.close(); }
});

test('vault error publishes bounded vault.error without raw exception or leak', async () => {
  const fixtureApp = await fixture({
    async list() {
      throw new Error('VAULT_AUTHENTICATION_REQUIRED');
    },
  });
  try {
    const rev = await fixtureApp.getRevision();
    await fixtureApp.send({ action: 'vault-list', revision: rev, origin: 'https://vault-target.test' });

    const state = await fixtureApp.getState();
    expect(state.vault.locked).toBe(true);
    expect(state.vault.entries).toHaveLength(0);
    expect(state.vault.error.length).toBeGreaterThan(0);
    expect(state.vault.error).not.toContain('VAULT_AUTHENTICATION_REQUIRED');
    expect(state.vault.error).not.toContain('Error:');
  } finally { await fixtureApp.close(); }
});

test('inactive workstation protection blocks vault operations and locks metadata', async () => {
  const fixtureApp = await fixture(undefined, false);
  try {
    const rev = await fixtureApp.getRevision();
    await fixtureApp.send({ action: 'vault-list', revision: rev, origin: 'https://vault-target.test' });

    const state = await fixtureApp.getState();
    expect(state.vault.locked).toBe(true);
    expect(state.vault.entries).toHaveLength(0);
    expect(fixtureApp.writes()).toBe(0);
    expect(fixtureApp.reads()).toBe(0);
  } finally { await fixtureApp.close(); }
});

test('Stop during replacement website teardown cannot reopen an inspection', async () => {
  const fixtureApp = await fixture();
  const closing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let replacement: Promise<void> | undefined;
  try {
    await fixtureApp.inspect('/first');
    const worker = fixtureApp.worker();
    const context = worker.context();
    const closeContext = context.close.bind(context);
    context.close = async options => {
      closing.resolve();
      await release.promise;
      await closeContext(options);
    };
    replacement = fixtureApp.send({
      action: 'inspect', revision: await fixtureApp.getRevision(), url: origin + '/second', kind: 'login',
    });
    await closing.promise;
    await fixtureApp.app.page.locator('#stop').click();
    release.resolve();
    await replacement;
    expect((await fixtureApp.getState()).phase).toBe('stopped');
    expect(worker.isClosed()).toBe(true);
    expect(fixtureApp.worker()).toBe(worker);
    expect(fixtureApp.reads()).toBe(0);
  } finally {
    release.resolve();
    await replacement;
    await fixtureApp.close();
  }
});
