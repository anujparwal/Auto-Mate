import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SYNTHETIC_VAULT_ROOT, WindowsAutofillVault, WindowsPasswordStore } from '../src/windows-vault';
import type { CardRecord, LoginRecord } from '../src/autofill-contract';

const isWindows = process.platform === 'win32';
const windowsSuite = isWindows ? describe : describe.skip;
// Real native cold starts plus several sequential DPAPI/ACL broker processes.
// This is a fixture budget, not a change to production/authentication deadlines.
const nativeIntegrationTimeoutMs = 60_000;

windowsSuite('WindowsAutofillVault & WindowsPasswordStore (Native DPAPI Synthetic Tests)', () => {
  let tempDir: string;
  let vaultPath: string;

  beforeEach(async () => {
    if (!isWindows) return;
    await mkdir(SYNTHETIC_VAULT_ROOT, { recursive: true });
    tempDir = await mkdtemp(join(SYNTHETIC_VAULT_ROOT, 'test-vault-'));
    vaultPath = join(tempDir, 'vault.json');
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('validates constructor mode options', () => {
    const invalidModeOpts = { mode: 'unsupported' as unknown as 'synthetic' };
    expect(() => new WindowsAutofillVault(invalidModeOpts)).toThrow('INVALID_VAULT_MODE');
    expect(() => new WindowsPasswordStore(invalidModeOpts)).toThrow('INVALID_VAULT_MODE');
  });

  test('enforces synthetic namespace restrictions: requires path in SYNTHETIC_VAULT_ROOT', async () => {
    if (!isWindows) return;
    const noPathVault = new WindowsAutofillVault({ mode: 'synthetic' });
    await expect(noPathVault.list('https://login.example.test')).rejects.toThrow('SYNTHETIC_VAULT_PATH_REQUIRED');

    const outsideVault = new WindowsAutofillVault({ vaultPath: 'C:/temp/outside/vault.json', mode: 'synthetic' });
    await expect(outsideVault.list('https://login.example.test')).rejects.toThrow('SYNTHETIC_VAULT_PATH_DENIED');
  });

  test('enforces synthetic domain restrictions: refuses real domains on synthetic adapter', async () => {
    if (!isWindows) return;
    const vault = new WindowsAutofillVault({ vaultPath, mode: 'synthetic' });
    const realDomain = 'https://the-internet.herokuapp.com';
    const sampleLogin: LoginRecord = {
      version: 1,
      kind: 'login',
      username: 'tomsmith',
      password: 'SuperSecretPassword!',
    };

    await expect(vault.list(realDomain)).rejects.toThrow('SYNTHETIC_ORIGIN_DENIED');
    await expect(vault.save(realDomain, 'rec-1', sampleLogin)).rejects.toThrow('SYNTHETIC_ORIGIN_DENIED');
    await expect(vault.read(realDomain, 'rec-1', 'login')).rejects.toThrow('SYNTHETIC_ORIGIN_DENIED');

    const pwdStore = new WindowsPasswordStore({ vaultPath, mode: 'synthetic' });
    await expect(pwdStore.generateAndPersist(realDomain)).rejects.toThrow('SYNTHETIC_ORIGIN_DENIED');
  });

  test('validates input origins strictly (https only, no userinfo/query/fragment)', async () => {
    if (!isWindows) return;
    const vault = new WindowsAutofillVault({ vaultPath, mode: 'synthetic' });
    await expect(vault.list('http://insecure.test')).rejects.toThrow('INVALID_ORIGIN');
    await expect(vault.list('https://user:pass@login.example.test')).rejects.toThrow('INVALID_ORIGIN');
    await expect(vault.list('https://login.example.test/path')).rejects.toThrow('INVALID_ORIGIN');
    await expect(vault.list('https://login.example.test?query=1')).rejects.toThrow('INVALID_ORIGIN');
    await expect(vault.list('https://login.example.test#fragment')).rejects.toThrow('INVALID_ORIGIN');
  });

  test('validates recordId parameters', async () => {
    if (!isWindows) return;
    const vault = new WindowsAutofillVault({ vaultPath, mode: 'synthetic' });
    const origin = 'https://accounts.example.test';
    const sampleLogin: LoginRecord = {
      version: 1,
      kind: 'login',
      username: 'user',
      password: 'pwd',
    };

    await expect(vault.save(origin, '', sampleLogin)).rejects.toThrow('INVALID_RECORD_ID');
    await expect(vault.save(origin, '   ', sampleLogin)).rejects.toThrow('INVALID_RECORD_ID');
    await expect(vault.save(origin, 'x'.repeat(321), sampleLogin)).rejects.toThrow('INVALID_RECORD_ID');

    await expect(vault.read(origin, '', 'login')).rejects.toThrow('INVALID_RECORD_ID');
    await expect(vault.read(origin, '   ', 'login')).rejects.toThrow('INVALID_RECORD_ID');
  });

  // Includes seven real PowerShell starts plus DPAPI/ACL work on hosted Windows.
  test('roundtrips typed login and card records through native DPAPI storage', async () => {
    if (!isWindows) return;
    const vault = new WindowsAutofillVault({ vaultPath, mode: 'synthetic' });
    const origin = 'https://banking.example.test';

    const loginRecord: LoginRecord = {
      version: 1,
      kind: 'login',
      username: 'अनुज@example.test',
      password: 'परीक्षण🔒-synthetic-2026',
    };

    const cardRecord: CardRecord = {
      version: 1,
      kind: 'card',
      cardholder: 'José Example',
      cardNumber: '4532 0150 0000 0007',
      expiryMonth: '11',
      expiryYear: '2028',
    };

    // Save login
    await vault.save(origin, 'user-login', loginRecord);

    // Save card
    await vault.save(origin, 'user-card', cardRecord);

    // List entries for origin
    const entries = await vault.list(origin);
    expect(entries.length).toBe(2);

    const recordIds = entries.map((e) => e.recordId);
    expect(recordIds).toContain('user-login');
    expect(recordIds).toContain('user-card');
    for (const e of entries) {
      expect(e.origin).toBe(origin);
      expect(typeof e.createdAt).toBe('string');
      expect(typeof e.updatedAt).toBe('string');
    }

    // Read login
    const retrievedLogin = await vault.read(origin, 'user-login', 'login');
    expect(retrievedLogin).toEqual(loginRecord);

    // Read card
    const retrievedCard = (await vault.read(origin, 'user-card', 'card')) as CardRecord;
    expect(retrievedCard.cardholder).toBe('José Example');
    expect(retrievedCard.cardNumber).toBe('4532015000000007');
    expect(retrievedCard.expiryMonth).toBe('11');
    expect(retrievedCard.expiryYear).toBe('2028');

    // Kind mismatch refusal
    await expect(vault.read(origin, 'user-login', 'card')).rejects.toThrow('VAULT_RECORD_KIND_MISMATCH');
    await expect(vault.read(origin, 'user-card', 'login')).rejects.toThrow('VAULT_RECORD_KIND_MISMATCH');
  }, nativeIntegrationTimeoutMs);

  test('verifies ciphertext at-rest privacy (no plaintext secrets or metadata in vault file)', async () => {
    if (!isWindows) return;
    const vault = new WindowsAutofillVault({ vaultPath, mode: 'synthetic' });
    await vault.save('https://privacy.example.test', 'user-login', {
      version: 1, kind: 'login', username: 'alice@example.test', password: 'CorrectHorseBatteryStaple!2026',
    });
    await vault.save('https://privacy.example.test', 'user-card', {
      version: 1, kind: 'card', cardholder: 'Alice Smith', cardNumber: '4532015000000007', expiryMonth: '11', expiryYear: '2028',
    });
    const fileText = await Bun.file(vaultPath).text();
    const diskEnvelope = JSON.parse(fileText);

    // File envelope must contain only version and cipherText
    expect(diskEnvelope.version).toBe(2);
    expect(typeof diskEnvelope.cipherText).toBe('string');
    expect(Object.keys(diskEnvelope).sort()).toEqual(['cipherText', 'version']);

    // Plaintext sensitive strings MUST NOT appear anywhere in the file
    expect(fileText).not.toContain('CorrectHorseBatteryStaple!2026');
    expect(fileText).not.toContain('alice@example.test');
    expect(fileText).not.toContain('Alice Smith');
    expect(fileText).not.toContain('4532015000000007');
    expect(fileText).not.toContain('user-login');
    expect(fileText).not.toContain('user-card');
  }, nativeIntegrationTimeoutMs);

  test('enforces wrong-origin denial', async () => {
    if (!isWindows) return;
    const vault = new WindowsAutofillVault({ vaultPath, mode: 'synthetic' });
    const originA = 'https://site-a.example.test';
    const originB = 'https://site-b.example.test';

    const login: LoginRecord = {
      version: 1,
      kind: 'login',
      username: 'charlie',
      password: 'passwordA',
    };

    await vault.save(originA, 'rec-a', login);

    // Reading rec-a under originB must be denied
    await expect(vault.read(originB, 'rec-a', 'login')).rejects.toThrow('VAULT_REQUEST_DENIED');

    // Listing originB must not show entries for originA
    const entriesB = await vault.list(originB);
    expect(entriesB.length).toBe(0);
  }, nativeIntegrationTimeoutMs);

  test('preserves old generated-password adapter functionality and allows login read', async () => {
    if (!isWindows) return;
    const pwdStore = new WindowsPasswordStore({ vaultPath, mode: 'synthetic' });
    const vault = new WindowsAutofillVault({ vaultPath, mode: 'synthetic' });
    const origin = 'https://legacy.example.test';

    // Generate and persist using existing PasswordStore interface
    const generated = await pwdStore.generateAndPersist(origin);
    expect(typeof generated.reference).toBe('string');
    expect(typeof generated.password).toBe('string');
    expect(generated.password.length).toBeGreaterThanOrEqual(20);

    // Reading the legacy record as login returns username = reference
    const decodedLogin = (await vault.read(origin, generated.reference, 'login')) as LoginRecord;
    expect(decodedLogin.version).toBe(1);
    expect(decodedLogin.kind).toBe('login');
    expect(decodedLogin.username).toBe(generated.reference);
    expect(decodedLogin.password).toBe(generated.password);

    // Reading the legacy raw password as card fails with kind mismatch
    await expect(vault.read(origin, generated.reference, 'card')).rejects.toThrow('VAULT_RECORD_KIND_MISMATCH');
  }, nativeIntegrationTimeoutMs);

  test('synthetic native records roundtrip when Windows TMP and TEMP disagree', async () => {
    const alternateTmp = join(tempDir, 'native-temp');
    await mkdir(alternateTmp);
    const record: LoginRecord = {
      version: 1, kind: 'login', username: 'synthetic-user', password: 'synthetic-only-password',
    };
    const child = Bun.spawn([process.execPath, '-e', `
      import { WindowsAutofillVault } from './src/windows-vault.ts';
      const vault = new WindowsAutofillVault({ vaultPath: ${JSON.stringify(vaultPath)}, mode: 'synthetic' });
      const origin = 'https://temp-roots.example.test';
      await vault.save(origin, 'temp-root-record', ${JSON.stringify(record)});
      console.log(JSON.stringify(await vault.read(origin, 'temp-root-record', 'login')));
    `], {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, TEMP: dirname(SYNTHETIC_VAULT_ROOT), TMP: alternateTmp },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (exitCode !== 0) throw new Error('Synthetic temp-root fixture failed: ' + stderr);
    expect(JSON.parse(stdout)).toEqual(record);
  }, nativeIntegrationTimeoutMs);

});
