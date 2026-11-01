import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  PROFILE_ORIGIN_NORMAL,
  PROFILE_ORIGIN_SYNTHETIC,
  WindowsInformationVault,
} from '../src/information-vault';
import {
  SYNTHETIC_VAULT_ROOT,
  WindowsAutofillVault,
  WindowsPasswordStore,
} from '../src/windows-vault';
import type { CardRecord, LoginRecord } from '../src/autofill-contract';

const isWindows = process.platform === 'win32';
const windowsSuite = isWindows ? describe : describe.skip;
const nativeIntegrationTimeoutMs = 60_000;

windowsSuite('WindowsInformationVault (Native DPAPI Synthetic Tests)', () => {
  let tempDir: string;
  let vaultPath: string;

  beforeEach(async () => {
    if (!isWindows) return;
    await mkdir(SYNTHETIC_VAULT_ROOT, { recursive: true });
    tempDir = await mkdtemp(join(SYNTHETIC_VAULT_ROOT, 'info-vault-'));
    vaultPath = join(tempDir, 'vault.json');
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('validates constructor mode options', () => {
    const invalidModeOpts = { mode: 'unsupported' as unknown as 'synthetic' };
    expect(() => new WindowsInformationVault(invalidModeOpts)).toThrow('INVALID_VAULT_MODE');
  });

  test('enforces synthetic namespace and origin restrictions', async () => {
    if (!isWindows) return;
    const noPathVault = new WindowsInformationVault({ mode: 'synthetic' });
    await expect(noPathVault.catalog('https://login.example.test')).rejects.toThrow('SYNTHETIC_VAULT_PATH_REQUIRED');

    const outsideVault = new WindowsInformationVault({
      vaultPath: 'C:/temp/outside/vault.json',
      mode: 'synthetic',
    });
    await expect(outsideVault.catalog('https://login.example.test')).rejects.toThrow('SYNTHETIC_VAULT_PATH_DENIED');

    const vault = new WindowsInformationVault({ vaultPath, mode: 'synthetic' });
    const realDomain = 'https://the-internet.herokuapp.com';
    await expect(vault.catalog(realDomain)).rejects.toThrow('SYNTHETIC_ORIGIN_DENIED');
    await expect(
      vault.save({
        name: 'Username',
        description: 'Test username',
        value: 'alice',
        kind: 'username',
        scope: 'site',
        origin: realDomain,
      }),
    ).rejects.toThrow('SYNTHETIC_ORIGIN_DENIED');
  });

  test('validates save variable input bounds and kinds strictly', async () => {
    if (!isWindows) return;
    const vault = new WindowsInformationVault({ vaultPath, mode: 'synthetic' });
    const origin = 'https://site.example.test';

    // Empty or whitespace name
    await expect(
      vault.save({
        name: '   ',
        description: 'Valid desc',
        value: 'val',
        kind: 'text',
        scope: 'site',
        origin,
      }),
    ).rejects.toThrow('INVALID_VARIABLE_NAME');

    // Name exceeding 80 characters
    await expect(
      vault.save({
        name: 'A'.repeat(81),
        description: 'Valid desc',
        value: 'val',
        kind: 'text',
        scope: 'site',
        origin,
      }),
    ).rejects.toThrow('INVALID_VARIABLE_NAME');

    // Empty description
    await expect(
      vault.save({
        name: 'ValidName',
        description: '',
        value: 'val',
        kind: 'text',
        scope: 'site',
        origin,
      }),
    ).rejects.toThrow('INVALID_VARIABLE_DESCRIPTION');

    // Description exceeding 500 characters
    await expect(
      vault.save({
        name: 'ValidName',
        description: 'D'.repeat(501),
        value: 'val',
        kind: 'text',
        scope: 'site',
        origin,
      }),
    ).rejects.toThrow('INVALID_VARIABLE_DESCRIPTION');

    // Empty value
    await expect(
      vault.save({
        name: 'ValidName',
        description: 'Valid desc',
        value: '',
        kind: 'text',
        scope: 'site',
        origin,
      }),
    ).rejects.toThrow('INVALID_VARIABLE_VALUE');

    // Value exceeding 4096 characters
    await expect(
      vault.save({
        name: 'ValidName',
        description: 'Valid desc',
        value: 'V'.repeat(4097),
        kind: 'text',
        scope: 'site',
        origin,
      }),
    ).rejects.toThrow('INVALID_VARIABLE_VALUE');

    // Invalid kind
    await expect(
      vault.save({
        name: 'ValidName',
        description: 'Valid desc',
        value: 'val',
        kind: 'unsupported-kind' as unknown as 'text',
        scope: 'site',
        origin,
      }),
    ).rejects.toThrow('INVALID_VARIABLE_KIND');

    // Username/password in profile scope strictly forbidden
    await expect(
      vault.save({
        name: 'MyUsername',
        description: 'Profile username',
        value: 'alice',
        kind: 'username',
        scope: 'profile',
        origin,
      }),
    ).rejects.toThrow('CREDENTIAL_CANNOT_BE_PROFILE');

    await expect(
      vault.save({
        name: 'MyPassword',
        description: 'Profile password',
        value: 'secret123',
        kind: 'password',
        scope: 'profile',
        origin,
      }),
    ).rejects.toThrow('CREDENTIAL_CANNOT_BE_PROFILE');

    // Site variable cannot use profile origin
    await expect(
      vault.save({
        name: 'SiteVar',
        description: 'Desc',
        value: 'val',
        kind: 'text',
        scope: 'site',
        origin: PROFILE_ORIGIN_SYNTHETIC,
      }),
    ).rejects.toThrow('INVALID_ORIGIN');
  });

  test('enforces DPAPI metadata privacy at rest and omits values from catalog serialization', async () => {
    if (!isWindows) return;
    const vault = new WindowsInformationVault({ vaultPath, mode: 'synthetic' });
    const origin = 'https://privacy.example.test';

    const sentinelSecret = 'SENTINEL_SECRET_XYZ_9876543210';
    const sentinelName = 'Company API Secret';
    const sentinelDesc = 'Secret token for partner service';

    await vault.save({
      name: sentinelName,
      description: sentinelDesc,
      value: sentinelSecret,
      kind: 'text',
      scope: 'site',
      origin,
    });

    // 1. Verify at-rest DPAPI encryption in raw vault file:
    const rawFileContent = await readFile(vaultPath, 'utf-8');
    expect(rawFileContent).not.toContain(sentinelSecret);
    expect(rawFileContent).not.toContain(sentinelName);
    expect(rawFileContent).not.toContain(sentinelDesc);
    expect(rawFileContent).not.toContain('privacy.example.test');

    const envelope = JSON.parse(rawFileContent);
    expect(envelope.version).toBe(2);
    expect(typeof envelope.cipherText).toBe('string');
    expect(Object.keys(envelope)).toEqual(['version', 'cipherText']);

    // 2. Verify catalog projection contains allowlisted metadata only, NEVER the secret value
    const catalog = await vault.catalog(origin);
    expect(catalog.length).toBe(1);

    const serializedCatalog = JSON.stringify(catalog);
    expect(serializedCatalog).not.toContain(sentinelSecret);
    expect(serializedCatalog).toContain(sentinelName);
    expect(serializedCatalog).toContain(sentinelDesc);

    const item = catalog[0]!;
    expect(item.name).toBe(sentinelName);
    expect(item.description).toBe(sentinelDesc);
    expect(item.kind).toBe('text');
    expect(item.scope).toBe('site');
    expect(item.available).toBe(true);

    // Allowlist check: only id, name, description, kind, scope, available
    const keys = Object.keys(item).sort();
    expect(keys).toEqual(['available', 'description', 'id', 'kind', 'name', 'scope']);

    // 3. Trusted read resolves the secret value
    const readSecret = await vault.read(item.id, origin);
    expect(readSecret).toBe(sentinelSecret);
  }, nativeIntegrationTimeoutMs);

  test('allows shared profile variable reuse across origins with explicit trusted read target', async () => {
    if (!isWindows) return;
    const vault = new WindowsInformationVault({ vaultPath, mode: 'synthetic' });
    const siteA = 'https://site-a.example.test';
    const siteB = 'https://site-b.example.test';

    // Save profile variable from siteA
    await vault.save({
      name: 'Full Name',
      description: 'Legal full name of user',
      value: 'Alice Wonder',
      kind: 'text',
      scope: 'profile',
      origin: siteA,
    });

    // Catalog for siteA shows it as available
    const catalogA = await vault.catalog(siteA);
    const profileItemA = catalogA.find((v) => v.name === 'Full Name');
    expect(profileItemA).toBeDefined();
    expect(profileItemA?.scope).toBe('profile');
    expect(profileItemA?.available).toBe(true);

    const valA = await vault.read(profileItemA!.id, siteA);
    expect(valA).toBe('Alice Wonder');

    // Catalog for siteB also shows it as available
    const catalogB = await vault.catalog(siteB);
    const profileItemB = catalogB.find((v) => v.name === 'Full Name');
    expect(profileItemB).toBeDefined();
    expect(profileItemB?.scope).toBe('profile');
    expect(profileItemB?.available).toBe(true);

    const valB = await vault.read(profileItemB!.id, siteB);
    expect(valB).toBe('Alice Wonder');
  }, nativeIntegrationTimeoutMs);

  test('refuses cross-origin reads on site-scoped variables and credentials', async () => {
    if (!isWindows) return;
    const vault = new WindowsInformationVault({ vaultPath, mode: 'synthetic' });
    const autofillVault = new WindowsAutofillVault({ vaultPath, mode: 'synthetic' });

    const siteA = 'https://site-a.example.test';
    const siteB = 'https://site-b.example.test';

    // Save site variable on siteA
    await vault.save({
      name: 'SiteA API Key',
      description: 'API key for Site A only',
      value: 'key-site-a-999',
      kind: 'text',
      scope: 'site',
      origin: siteA,
    });

    // Save login record on siteA
    const loginRec: LoginRecord = {
      version: 1,
      kind: 'login',
      username: 'alice-a',
      password: 'password-a',
    };
    await autofillVault.save(siteA, 'personal-login', loginRec);

    // Catalog for siteA has both items available
    const catalogA = await vault.catalog(siteA);
    const varA = catalogA.find((v) => v.name === 'SiteA API Key');
    const userA = catalogA.find((v) => v.kind === 'username');
    expect(varA?.available).toBe(true);
    expect(userA?.available).toBe(true);

    // Catalog for siteB sees the names/descriptions for model planning but available is FALSE
    const catalogB = await vault.catalog(siteB);
    const varB = catalogB.find((v) => v.name === 'SiteA API Key');
    const userB = catalogB.find((v) => v.kind === 'username');
    expect(varB).toBeDefined();
    expect(varB?.available).toBe(false);
    expect(userB).toBeDefined();
    expect(userB?.available).toBe(false);

    // Reading unavailable variable from siteB catalog throws VARIABLE_NOT_AVAILABLE
    await expect(vault.read(varB!.id, siteB)).rejects.toThrow('VARIABLE_NOT_AVAILABLE');
    await expect(vault.read(userB!.id, siteB)).rejects.toThrow('VARIABLE_NOT_AVAILABLE');

    // Attempting to read siteA binding with siteB origin throws CROSS_ORIGIN_DENIED
    await expect(vault.read(varA!.id, siteB)).rejects.toThrow('CROSS_ORIGIN_DENIED');
    await expect(vault.read(userA!.id, siteB)).rejects.toThrow('CROSS_ORIGIN_DENIED');
  }, nativeIntegrationTimeoutMs);

  test('supports intentional metadata updates and prevents silent overwrite of unrelated typed records', async () => {
    if (!isWindows) return;
    const vault = new WindowsInformationVault({ vaultPath, mode: 'synthetic' });
    const autofillVault = new WindowsAutofillVault({ vaultPath, mode: 'synthetic' });
    const origin = 'https://update.example.test';

    // 1. Initial save of named variable
    await vault.save({
      name: 'Theme',
      description: 'Initial UI theme',
      value: 'dark',
      kind: 'text',
      scope: 'site',
      origin,
    });

    let catalog = await vault.catalog(origin);
    let themeVar = catalog.find((v) => v.name === 'Theme');
    expect(themeVar?.description).toBe('Initial UI theme');
    expect(await vault.read(themeVar!.id, origin)).toBe('dark');

    // 2. Intentional overwrite updates metadata and value
    await vault.save({
      name: 'Theme',
      description: 'Updated UI theme preference',
      value: 'high-contrast',
      kind: 'text',
      scope: 'site',
      origin,
    });

    catalog = await vault.catalog(origin);
    themeVar = catalog.find((v) => v.name === 'Theme');
    expect(themeVar?.description).toBe('Updated UI theme preference');
    expect(await vault.read(themeVar!.id, origin)).toBe('high-contrast');

    // 3. Prevent silent overwrite of unrelated typed record:
    // Create typed login record with recordId 'var:ProtectedLogin'
    const loginRec: LoginRecord = {
      version: 1,
      kind: 'login',
      username: 'protected-user',
      password: 'protected-password',
    };
    await autofillVault.save(origin, 'var:ProtectedLogin', loginRec);

    // Attempting to save a named variable with name 'ProtectedLogin' (targeting 'var:ProtectedLogin')
    await expect(
      vault.save({
        name: 'ProtectedLogin',
        description: 'Should fail overwrite',
        value: 'new-val',
        kind: 'text',
        scope: 'site',
        origin,
      }),
    ).rejects.toThrow();

    // Verify existing typed record was not modified
    const readLogin = (await autofillVault.read(origin, 'var:ProtectedLogin', 'login')) as LoginRecord;
    expect(readLogin.username).toBe('protected-user');
    expect(readLogin.password).toBe('protected-password');
  }, nativeIntegrationTimeoutMs);

  test('refuses stale or unknown bindings and clear() invalidates bindings', async () => {
    if (!isWindows) return;
    const vault = new WindowsInformationVault({ vaultPath, mode: 'synthetic' });
    const origin = 'https://stale.example.test';

    await vault.save({
      name: 'Temp Secret',
      description: 'Temporary value',
      value: 'val123',
      kind: 'text',
      scope: 'site',
      origin,
    });

    // Unknown UUID
    await expect(vault.read('00000000-0000-0000-0000-000000000000', origin)).rejects.toThrow('UNKNOWN_VARIABLE');

    // Valid binding
    const catalog = await vault.catalog(origin);
    const item = catalog[0]!;
    expect(await vault.read(item.id, origin)).toBe('val123');

    // clear() invalidates all bindings
    vault.clear();
    await expect(vault.read(item.id, origin)).rejects.toThrow('UNKNOWN_VARIABLE');
  }, nativeIntegrationTimeoutMs);

  test('authenticates for one-off entered data without returning values', async () => {
    if (!isWindows) return;
    const vault = new WindowsInformationVault({ vaultPath, mode: 'synthetic' });
    const origin = 'https://auth.example.test';

    // Normal authenticate call resolves with void
    const result = await vault.authenticate(origin);
    expect(result).toBeUndefined();

    // Invalid origin rejected
    await expect(vault.authenticate('http://insecure.test')).rejects.toThrow('INVALID_ORIGIN');
    await expect(vault.authenticate('https://real-domain.com')).rejects.toThrow('SYNTHETIC_ORIGIN_DENIED');
  }, nativeIntegrationTimeoutMs);

  test('coexists with existing typed login/card records and legacy generated passwords', async () => {
    if (!isWindows) return;
    const vault = new WindowsInformationVault({ vaultPath, mode: 'synthetic' });
    const autofillVault = new WindowsAutofillVault({ vaultPath, mode: 'synthetic' });
    const pwdStore = new WindowsPasswordStore({ vaultPath, mode: 'synthetic' });
    const origin = 'https://coexist.example.test';

    // 1. Store login record
    const loginRec: LoginRecord = {
      version: 1,
      kind: 'login',
      username: 'login-user',
      password: 'login-pass',
    };
    await autofillVault.save(origin, 'login-rec', loginRec);

    // 2. Store card record
    const cardRec: CardRecord = {
      version: 1,
      kind: 'card',
      cardholder: 'Alice Wonder',
      cardNumber: '4532015000000007',
      expiryMonth: '11',
      expiryYear: '2028',
    };
    await autofillVault.save(origin, 'card-rec', cardRec);

    // 3. Generate legacy password
    const gen = await pwdStore.generateAndPersist(origin);

    // 4. Save named variable
    await vault.save({
      name: 'Custom Email',
      description: 'Notification email',
      value: 'notify@example.test',
      kind: 'email',
      scope: 'site',
      origin,
    });

    // Existing AutofillVault still lists entries
    const entries = await autofillVault.list(origin);
    expect(entries.length).toBeGreaterThanOrEqual(3);

    // Existing AutofillVault reads login and card records accurately
    const readLogin = await autofillVault.read(origin, 'login-rec', 'login');
    expect(readLogin).toEqual(loginRec);

    const readCard = await autofillVault.read(origin, 'card-rec', 'card');
    expect(readCard).toEqual(cardRec);

    // InformationVault catalog reflects typed fields and named variables
    const catalog = await vault.catalog(origin);
    expect(catalog.length).toBeGreaterThanOrEqual(8);

    // Find custom variable
    const emailVar = catalog.find((v) => v.name === 'Custom Email');
    expect(emailVar).toBeDefined();
    expect(await vault.read(emailVar!.id, origin)).toBe('notify@example.test');

    // Find typed login username & password fields in catalog
    const usernameVar = catalog.find((v) => v.kind === 'username' && v.name.includes('login-rec'));
    const passwordVar = catalog.find((v) => v.kind === 'password' && v.name.includes('login-rec'));
    expect(usernameVar).toBeDefined();
    expect(passwordVar).toBeDefined();
    expect(await vault.read(usernameVar!.id, origin)).toBe('login-user');
    expect(await vault.read(passwordVar!.id, origin)).toBe('login-pass');

    // Find card fields in catalog
    const cardNumVar = catalog.find((v) => v.kind === 'cardNumber' && v.name.includes('card-rec'));
    const cardholderVar = catalog.find((v) => v.kind === 'cardholder' && v.name.includes('card-rec'));
    const expiryMonthVar = catalog.find((v) => v.kind === 'expiryMonth' && v.name.includes('card-rec'));
    const expiryYearVar = catalog.find((v) => v.kind === 'expiryYear' && v.name.includes('card-rec'));
    expect(cardNumVar).toBeDefined();
    expect(cardholderVar).toBeDefined();
    expect(expiryMonthVar).toBeDefined();
    expect(expiryYearVar).toBeDefined();

    expect(await vault.read(cardNumVar!.id, origin)).toBe('4532015000000007');
    expect(await vault.read(cardholderVar!.id, origin)).toBe('Alice Wonder');
    expect(await vault.read(expiryMonthVar!.id, origin)).toBe('11');
    expect(await vault.read(expiryYearVar!.id, origin)).toBe('2028');

    // Find legacy generated password in catalog
    const legacyVar = catalog.find((v) => v.kind === 'password' && v.name.includes(gen.reference));
    expect(legacyVar).toBeDefined();
    expect(await vault.read(legacyVar!.id, origin)).toBe(gen.password);
  }, nativeIntegrationTimeoutMs);
});
