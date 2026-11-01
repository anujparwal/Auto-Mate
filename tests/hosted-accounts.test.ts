import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CardRecord, LoginRecord } from '../src/autofill-contract';
import { HostedAccounts, HostedAccountSession } from '../src/hosted-accounts';
import { PolicyError } from '../src/policy';

describe('HostedAccounts and Encrypted Vault', () => {
  let testDir: string;
  const regKey = 'master-secret-regkey-at-least-16';

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'hosted-accounts-test-'));
  });

  afterEach(async () => {
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('validates open options strictly and enforces strong registrationKey >= 16', async () => {
    await expect(HostedAccounts.open({ directory: '', registrationKey: regKey })).rejects.toThrow(
      'INVALID_DIRECTORY',
    );
    await expect(
      HostedAccounts.open({ directory: testDir, registrationKey: 'short' }),
    ).rejects.toThrow('INVALID_REGISTRATION_KEY');

    const accounts = await HostedAccounts.open({ directory: testDir, registrationKey: regKey });
    expect(accounts).toBeInstanceOf(HostedAccounts);
  });

  test('detects corrupted accounts.json index on open', async () => {
    const indexPath = join(testDir, 'accounts.json');
    await mkdir(testDir, { recursive: true });
    await writeFile(indexPath, '{ corrupt json', 'utf-8');

    await expect(
      HostedAccounts.open({ directory: testDir, registrationKey: regKey }),
    ).rejects.toThrow('ACCOUNTS_INDEX_CORRUPT');
  });

  test('enforces invite-only registrationKey: wrong key cannot create data', async () => {
    const accounts = await HostedAccounts.open({ directory: testDir, registrationKey: regKey });

    await expect(
      accounts.register('alice', 'correct-password-1234', 'wrong-registration-key'),
    ).rejects.toThrow('INVALID_REGISTRATION_KEY');

    const files = await readFile(join(testDir, 'accounts.json'), 'utf-8');
    const index = JSON.parse(files);
    expect(Object.keys(index.accounts)).toHaveLength(0);
  });

  test('validates canonical ASCII lower-case username 3..64 strictly', async () => {
    const accounts = await HostedAccounts.open({ directory: testDir, registrationKey: regKey });
    const key = 'secure-password-1234';

    // Disallowed uppercase
    await expect(accounts.register('Alice', key, regKey)).rejects.toThrow('INVALID_USERNAME');
    // Disallowed non-alnum prefix
    await expect(accounts.register('.alice', key, regKey)).rejects.toThrow('INVALID_USERNAME');
    await expect(accounts.register('-alice', key, regKey)).rejects.toThrow('INVALID_USERNAME');
    await expect(accounts.register('_alice', key, regKey)).rejects.toThrow('INVALID_USERNAME');
    // Disallowed length < 3
    await expect(accounts.register('al', key, regKey)).rejects.toThrow('INVALID_USERNAME');
    // Disallowed length > 64
    await expect(accounts.register('a'.repeat(65), key, regKey)).rejects.toThrow('INVALID_USERNAME');
    // Disallowed special chars
    await expect(accounts.register('alice@example', key, regKey)).rejects.toThrow('INVALID_USERNAME');
    await expect(accounts.register('alice user', key, regKey)).rejects.toThrow('INVALID_USERNAME');

    // Valid canonical usernames
    const session = await accounts.register('alice-01.test_user', key, regKey);
    expect(session.username).toBe('alice-01.test_user');
    await session.close();
  });

  test('a legal username matching an Object prototype name persists and authenticates', async () => {
    const accounts = await HostedAccounts.open({ directory: testDir, registrationKey: regKey });
    const created = await accounts.register('constructor', 'fictitious-account-key-123', regKey);
    await created.informationVault.save({ name: 'Name', description: 'Name for forms', value: 'QA-VALUE-LOCAL-ONLY', kind: 'text', scope: 'profile', origin: 'https://forms.example.com' });
    await created.close();
    const reopened = await accounts.unlock('constructor', 'fictitious-account-key-123');
    try {
      const variable = (await reopened.informationVault.catalog('https://forms.example.com'))[0]!;
      expect(await reopened.informationVault.read(variable.id, 'https://forms.example.com')).toBe('QA-VALUE-LOCAL-ONLY');
    } finally { await reopened.close(); }
  });

  test('enforces key length between 12 and 1024, never trimming it', async () => {
    const accounts = await HostedAccounts.open({ directory: testDir, registrationKey: regKey });

    // Too short (< 12)
    await expect(accounts.register('bob001', 'short1234', regKey)).rejects.toThrow('INVALID_KEY');

    // Untrimmed key with spaces
    const untrimmedKey = '   spaced-passphrase-at-least-12   ';
    const session = await accounts.register('bob001', untrimmedKey, regKey);
    expect(session).toBeInstanceOf(HostedAccountSession);
    await session.close();

    // Unlock with exact untrimmed key succeeds
    const unlocked = await accounts.unlock('bob001', untrimmedKey);
    expect(unlocked.username).toBe('bob001');
    await unlocked.close();

    // Unlock with trimmed key fails
    await expect(accounts.unlock('bob001', untrimmedKey.trim())).rejects.toThrow('INVALID_CREDENTIALS');
  });

  test('exclusive account creation prevents duplicate registration', async () => {
    const accounts = await HostedAccounts.open({ directory: testDir, registrationKey: regKey });
    const key = 'secure-password-1234';

    const session1 = await accounts.register('charlie', key, regKey);
    expect(session1.username).toBe('charlie');
    await session1.close();

    await expect(accounts.register('charlie', key, regKey)).rejects.toThrow('ACCOUNT_ALREADY_EXISTS');
  });

  test('stores no plaintext credentials, variable metadata, or origins in outer metadata or files', async () => {
    const accounts = await HostedAccounts.open({ directory: testDir, registrationKey: regKey });
    const secretPass = 'super-secret-passphrase-1234';
    const session = await accounts.register('dana01', secretPass, regKey);

    const sensitiveLogin: LoginRecord = {
      version: 1,
      kind: 'login',
      username: 'dana-online-identity',
      password: 'dana-raw-site-password-999',
    };
    await session.vault.save('https://bank.example.com', 'bank-login', sensitiveLogin);

    await session.informationVault.save({
      name: 'Tax ID',
      description: 'Personal social tax identifier',
      value: 'TAX-9988-SECRET',
      kind: 'text',
      scope: 'site',
      origin: 'https://tax.example.com',
    });

    // 1. Inspect outer accounts.json
    const indexRaw = await readFile(join(testDir, 'accounts.json'), 'utf-8');
    expect(indexRaw).not.toContain(secretPass);
    expect(indexRaw).not.toContain('dana-online-identity');
    expect(indexRaw).not.toContain('dana-raw-site-password-999');
    expect(indexRaw).not.toContain('TAX-9988-SECRET');
    expect(indexRaw).not.toContain('Tax ID');
    expect(indexRaw).not.toContain('bank.example.com');
    expect(indexRaw).not.toContain('tax.example.com');

    // Outer index contains only allowlisted account metadata
    const parsedIndex = JSON.parse(indexRaw) as {
      accounts: Record<string, { accountId: string; username: string; salt: string; authVerifier: string; vaultFile: string }>;
    };
    const accountMeta = parsedIndex.accounts.dana01;
    expect(accountMeta).toBeDefined();
    expect(accountMeta?.accountId).toBe(session.accountId);
    expect(accountMeta?.username).toBe('dana01');
    expect(typeof accountMeta?.salt).toBe('string');
    expect(typeof accountMeta?.authVerifier).toBe('string');
    expect(accountMeta?.vaultFile).toBe(`${session.accountId}.vault`);

    // Verify file name uses randomID/hash, not raw username
    expect(accountMeta?.vaultFile).not.toContain('dana');

    // 2. Inspect encrypted vault file on disk
    const vaultRaw = await readFile(join(testDir, accountMeta!.vaultFile), 'utf-8');
    expect(vaultRaw).not.toContain(secretPass);
    expect(vaultRaw).not.toContain('dana-online-identity');
    expect(vaultRaw).not.toContain('dana-raw-site-password-999');
    expect(vaultRaw).not.toContain('TAX-9988-SECRET');
    expect(vaultRaw).not.toContain('Tax ID');
    expect(vaultRaw).not.toContain('bank.example.com');
    expect(vaultRaw).not.toContain('tax.example.com');

    const envelope = JSON.parse(vaultRaw);
    expect(envelope.version).toBe(1);
    expect(typeof envelope.iv).toBe('string');
    expect(typeof envelope.authTag).toBe('string');
    expect(typeof envelope.ciphertext).toBe('string');

    await session.close();
  });

  test('unlock verifies credentials and corrupted ciphertext fails closed', async () => {
    const accounts = await HostedAccounts.open({ directory: testDir, registrationKey: regKey });
    const correctKey = 'correct-password-1234';
    const wrongKey = 'wrong-password-1234';

    const session = await accounts.register('eve001', correctKey, regKey);
    const accountId = session.accountId;
    await session.close();

    // Unknown user
    await expect(accounts.unlock('nonexistent', correctKey)).rejects.toThrow('INVALID_CREDENTIALS');

    // Wrong password
    await expect(accounts.unlock('eve001', wrongKey)).rejects.toThrow('INVALID_CREDENTIALS');

    // Corrupted ciphertext fails closed
    const vaultPath = join(testDir, `${accountId}.vault`);
    const envelope = JSON.parse(await readFile(vaultPath, 'utf-8'));
    // Tamper with ciphertext
    const rawBuf = Buffer.from(envelope.ciphertext, 'base64');
    rawBuf[0] = (rawBuf[0] ?? 0) ^ 0xff;
    envelope.ciphertext = rawBuf.toString('base64');
    await writeFile(vaultPath, JSON.stringify(envelope), 'utf-8');

    await expect(accounts.unlock('eve001', correctKey)).rejects.toThrow('VAULT_CORRUPTED');
  });

  test('persists state across service restarts', async () => {
    const key = 'persistent-password-1234';
    const origin = 'https://app.example.com';

    // Instance 1
    const app1 = await HostedAccounts.open({ directory: testDir, registrationKey: regKey });
    const session1 = await app1.register('frank01', key, regKey);

    const login: LoginRecord = {
      version: 1,
      kind: 'login',
      username: 'frank-user',
      password: 'frank-password',
    };
    await session1.vault.save(origin, 'login-main', login);
    await session1.informationVault.save({
      name: 'User Email',
      description: 'Account contact email',
      value: 'frank@example.com',
      kind: 'email',
      scope: 'site',
      origin,
    });
    await session1.close();

    // Instance 2 (simulate process restart)
    const app2 = await HostedAccounts.open({ directory: testDir, registrationKey: regKey });
    const session2 = await app2.unlock('frank01', key);

    // AutofillVault record persisted
    const readLogin = (await session2.vault.read(origin, 'login-main', 'login')) as LoginRecord;
    expect(readLogin.username).toBe('frank-user');
    expect(readLogin.password).toBe('frank-password');

    // InformationVault variable persisted
    const catalog = await session2.informationVault.catalog(origin);
    const emailVar = catalog.find((v) => v.name === 'User Email');
    expect(emailVar).toBeDefined();
    expect(emailVar?.available).toBe(true);
    expect(await session2.informationVault.read(emailVar!.id, origin)).toBe('frank@example.com');

    await session2.close();
  });

  test('guarantees complete isolation between distinct user accounts', async () => {
    const accounts = await HostedAccounts.open({ directory: testDir, registrationKey: regKey });
    const keyA = 'user-a-password-1234';
    const keyB = 'user-b-password-1234';
    const origin = 'https://portal.example.com';

    const sessionA = await accounts.register('user_a', keyA, regKey);
    const sessionB = await accounts.register('user_b', keyB, regKey);

    await sessionA.vault.save(origin, 'login-a', {
      version: 1,
      kind: 'login',
      username: 'userA',
      password: 'passA',
    });
    await sessionA.informationVault.save({
      name: 'Var A',
      description: 'A only',
      value: 'secret-a',
      kind: 'text',
      scope: 'site',
      origin,
    });

    // User B cannot see User A's login entries
    const listB = await sessionB.vault.list(origin);
    expect(listB).toHaveLength(0);
    await expect(sessionB.vault.read(origin, 'login-a', 'login')).rejects.toThrow('RECORD_NOT_FOUND');

    // User B cannot see User A's variables in catalog
    const catalogB = await sessionB.informationVault.catalog(origin);
    expect(catalogB).toHaveLength(0);

    await sessionA.close();
    await sessionB.close();
  });

  test('AutofillVault strictly enforces typed records, Luhn check, origin validation, and kind checks', async () => {
    const accounts = await HostedAccounts.open({ directory: testDir, registrationKey: regKey });
    const session = await accounts.register('grace01', 'grace-passphrase-1234', regKey);
    const origin = 'https://shop.example.com';

    // 1. Invalid origin rejected
    const validLogin: LoginRecord = {
      version: 1,
      kind: 'login',
      username: 'grace',
      password: 'secret-password',
    };
    await expect(session.vault.save('http://insecure.example.com', 'login-1', validLogin)).rejects.toThrow(
      'INVALID_ORIGIN',
    );
    await expect(session.vault.save('https://shop.example.com/login', 'login-1', validLogin)).rejects.toThrow(
      'INVALID_ORIGIN',
    );

    // 2. Valid card record with Luhn check
    const validCard: CardRecord = {
      version: 1,
      kind: 'card',
      cardholder: 'Grace Hopper',
      cardNumber: '4532015000000007', // Valid Luhn Visa test number
      expiryMonth: '12',
      expiryYear: '2029',
    };
    await session.vault.save(origin, 'visa-card', validCard);

    // 3. Card with invalid Luhn checksum is rejected
    const badLuhnCard: CardRecord = {
      version: 1,
      kind: 'card',
      cardholder: 'Grace Hopper',
      cardNumber: '4532015000000008', // Invalid Luhn
      expiryMonth: '12',
      expiryYear: '2029',
    };
    await expect(session.vault.save(origin, 'bad-card', badLuhnCard)).rejects.toThrow();

    // 4. List returns entries
    const entries = await session.vault.list(origin);
    expect(entries.some((e) => e.recordId === 'visa-card')).toBe(true);

    // 5. Kind mismatch on read throws VAULT_RECORD_KIND_MISMATCH
    await expect(session.vault.read(origin, 'visa-card', 'login')).rejects.toThrow(
      'VAULT_RECORD_KIND_MISMATCH',
    );

    // 6. Successful read of card
    const readCard = (await session.vault.read(origin, 'visa-card', 'card')) as CardRecord;
    expect(readCard.cardholder).toBe('Grace Hopper');
    expect(readCard.cardNumber).toBe('4532015000000007');

    await session.close();
  });

  test('InformationVault enforces variable bounds, profile restrictions, and origin binding', async () => {
    const accounts = await HostedAccounts.open({ directory: testDir, registrationKey: regKey });
    const session = await accounts.register('heidi01', 'heidi-passphrase-1234', regKey);
    const siteA = 'https://site-a.example.com';
    const siteB = 'https://site-b.example.com';

    // 1. Validation bounds
    await expect(
      session.informationVault.save({
        name: 'A'.repeat(81),
        description: 'valid desc',
        value: 'val',
        kind: 'text',
        scope: 'site',
        origin: siteA,
      }),
    ).rejects.toThrow('INVALID_VARIABLE_NAME');

    await expect(
      session.informationVault.save({
        name: 'ValidName',
        description: 'D'.repeat(501),
        value: 'val',
        kind: 'text',
        scope: 'site',
        origin: siteA,
      }),
    ).rejects.toThrow('INVALID_VARIABLE_DESCRIPTION');

    await expect(
      session.informationVault.save({
        name: 'ValidName',
        description: 'valid desc',
        value: 'V'.repeat(4097),
        kind: 'text',
        scope: 'site',
        origin: siteA,
      }),
    ).rejects.toThrow('INVALID_VARIABLE_VALUE');

    // 2. Credentials cannot be profile scope
    await expect(
      session.informationVault.save({
        name: 'Master User',
        description: 'Profile username',
        value: 'admin',
        kind: 'username',
        scope: 'profile',
        origin: siteA,
      }),
    ).rejects.toThrow('CREDENTIAL_CANNOT_BE_PROFILE');

    await expect(
      session.informationVault.save({
        name: 'Master Pass',
        description: 'Profile password',
        value: 'secretpass',
        kind: 'password',
        scope: 'profile',
        origin: siteA,
      }),
    ).rejects.toThrow('CREDENTIAL_CANNOT_BE_PROFILE');

    // 3. Shared profile variables are reusable across origins
    await session.informationVault.save({
      name: 'Shipping Address',
      description: 'Home address for shipping',
      value: '123 Main St, Springfield',
      kind: 'text',
      scope: 'profile',
      origin: siteA,
    });

    const catalogA = await session.informationVault.catalog(siteA);
    const profileItemA = catalogA.find((v) => v.name === 'Shipping Address');
    expect(profileItemA).toBeDefined();
    expect(profileItemA?.scope).toBe('profile');
    expect(profileItemA?.available).toBe(true);
    expect(await session.informationVault.read(profileItemA!.id, siteA)).toBe('123 Main St, Springfield');

    const catalogB = await session.informationVault.catalog(siteB);
    const profileItemB = catalogB.find((v) => v.name === 'Shipping Address');
    expect(profileItemB).toBeDefined();
    expect(profileItemB?.scope).toBe('profile');
    expect(profileItemB?.available).toBe(true);
    expect(await session.informationVault.read(profileItemB!.id, siteB)).toBe('123 Main St, Springfield');

    // 4. Site-scoped variable on siteA is unavailable on siteB
    await session.informationVault.save({
      name: 'Site A Token',
      description: 'API key for Site A',
      value: 'token-abc-123',
      kind: 'text',
      scope: 'site',
      origin: siteA,
    });

    const catalogB2 = await session.informationVault.catalog(siteB);
    const tokenItemB = catalogB2.find((v) => v.name === 'Site A Token');
    expect(tokenItemB).toBeDefined();
    expect(tokenItemB?.available).toBe(false);

    // Reading unavailable variable from siteB catalog throws VARIABLE_NOT_AVAILABLE
    await expect(session.informationVault.read(tokenItemB!.id, siteB)).rejects.toThrow(
      'VARIABLE_NOT_AVAILABLE',
    );

    // Cross-origin read of siteA binding with siteB target throws CROSS_ORIGIN_DENIED
    const catalogA2 = await session.informationVault.catalog(siteA);
    const tokenItemA = catalogA2.find((v) => v.name === 'Site A Token');
    await expect(session.informationVault.read(tokenItemA!.id, siteB)).rejects.toThrow(
      'CROSS_ORIGIN_DENIED',
    );

    await session.close();
  });

  test('catalog projects typed record fields with opaque IDs without exposing actual secrets as metadata', async () => {
    const accounts = await HostedAccounts.open({ directory: testDir, registrationKey: regKey });
    const session = await accounts.register('ian001', 'ian-passphrase-1234', regKey);
    const origin = 'https://service.example.com';

    await session.vault.save(origin, 'login-prod', {
      version: 1,
      kind: 'login',
      username: 'ian-actual-login-user',
      password: 'ian-super-secret-password-xyz',
    });

    const catalog = await session.informationVault.catalog(origin);
    const usernameVar = catalog.find((v) => v.kind === 'username');
    const passwordVar = catalog.find((v) => v.kind === 'password');

    expect(usernameVar).toBeDefined();
    expect(passwordVar).toBeDefined();

    // Verify metadata names/descriptions do NOT contain actual username or password values
    expect(usernameVar?.name).toBe('Username (login-prod)');
    expect(usernameVar?.description).toBe('Username for https://service.example.com (login-prod)');
    expect(usernameVar?.name).not.toContain('ian-actual-login-user');
    expect(passwordVar?.name).toBe('Password (login-prod)');
    expect(passwordVar?.description).not.toContain('ian-super-secret-password-xyz');

    // Allowlisted properties only: available, description, id, kind, name, scope
    const keys = Object.keys(usernameVar!).sort();
    expect(keys).toEqual(['available', 'description', 'id', 'kind', 'name', 'scope']);

    // Trusted read resolves secret value
    expect(await session.informationVault.read(usernameVar!.id, origin)).toBe('ian-actual-login-user');
    expect(await session.informationVault.read(passwordVar!.id, origin)).toBe(
      'ian-super-secret-password-xyz',
    );

    await session.close();
  });

  test('clear() revokes issued bindings immediately', async () => {
    const accounts = await HostedAccounts.open({ directory: testDir, registrationKey: regKey });
    const session = await accounts.register('judy01', 'judy-passphrase-1234', regKey);
    const origin = 'https://clear-test.example.com';

    await session.informationVault.save({
      name: 'Temp Token',
      description: 'One-off secret',
      value: 'ephemeral-val',
      kind: 'text',
      scope: 'site',
      origin,
    });

    const catalog = await session.informationVault.catalog(origin);
    const item = catalog[0]!;
    expect(await session.informationVault.read(item.id, origin)).toBe('ephemeral-val');

    session.informationVault.clear();

    await expect(session.informationVault.read(item.id, origin)).rejects.toThrow('UNKNOWN_VARIABLE');

    await session.close();
  });

  test('session close revokes immediately and prevents operations and disk writes after close', async () => {
    const accounts = await HostedAccounts.open({ directory: testDir, registrationKey: regKey });
    const session = await accounts.register('karen01', 'karen-passphrase-1234', regKey);
    const origin = 'https://session-test.example.com';

    session.assertActive();
    await session.close();

    // assertActive throws SESSION_CLOSED
    expect(() => session.assertActive()).toThrow('SESSION_CLOSED');

    // AutofillVault methods reject
    await expect(session.vault.list(origin)).rejects.toThrow('SESSION_CLOSED');
    await expect(
      session.vault.save(origin, 'rec-1', {
        version: 1,
        kind: 'login',
        username: 'u',
        password: 'p',
      }),
    ).rejects.toThrow('SESSION_CLOSED');
    await expect(session.vault.read(origin, 'rec-1', 'login')).rejects.toThrow('SESSION_CLOSED');

    // InformationVault methods reject
    await expect(session.informationVault.catalog(origin)).rejects.toThrow('SESSION_CLOSED');
    await expect(
      session.informationVault.save({
        name: 'V',
        description: 'D',
        value: '1',
        kind: 'text',
        scope: 'site',
        origin,
      }),
    ).rejects.toThrow('SESSION_CLOSED');
    await expect(session.informationVault.read('dummy-id', origin)).rejects.toThrow('SESSION_CLOSED');
    await expect(session.informationVault.authenticate(origin)).rejects.toThrow('SESSION_CLOSED');
  });

  test('handles concurrent registrations and serialized per-account read-modify-write without lost updates', async () => {
    const accounts = await HostedAccounts.open({ directory: testDir, registrationKey: regKey });
    const origin = 'https://concurrency.example.com';

    // 1. Concurrent registrations of distinct users
    const users = ['user_1', 'user_2', 'user_3', 'user_4', 'user_5'];
    const sessions = await Promise.all(
      users.map((u) => accounts.register(u, 'common-password-1234', regKey)),
    );
    expect(sessions).toHaveLength(5);
    await Promise.all(sessions.map((s) => s.close()));

    // 2. Serialized concurrent writes on a single account
    const activeSession = await accounts.unlock('user_1', 'common-password-1234');
    const writePromises = Array.from({ length: 10 }, (_, i) =>
      activeSession.informationVault.save({
        name: `Var_${i}`,
        description: `Description ${i}`,
        value: `Value_${i}`,
        kind: 'text',
        scope: 'site',
        origin,
      }),
    );
    await Promise.all(writePromises);

    const finalCatalog = await activeSession.informationVault.catalog(origin);
    expect(finalCatalog).toHaveLength(10);

    for (let i = 0; i < 10; i++) {
      const item = finalCatalog.find((v) => v.name === `Var_${i}`);
      expect(item).toBeDefined();
      expect(await activeSession.informationVault.read(item!.id, origin)).toBe(`Value_${i}`);
    }

    await activeSession.close();
  });

  test('supports intentional variable updates while preventing silent overwrite of unrelated typed records', async () => {
    const accounts = await HostedAccounts.open({ directory: testDir, registrationKey: regKey });
    const session = await accounts.register('overwrite_test', 'secure-password-1234', regKey);
    const origin = 'https://app.example.com';

    // 1. Save variable
    await session.informationVault.save({
      name: 'Theme',
      description: 'Initial theme',
      value: 'light',
      kind: 'text',
      scope: 'site',
      origin,
    });

    // 2. Intentional update of variable
    await session.informationVault.save({
      name: 'Theme',
      description: 'Updated theme',
      value: 'dark',
      kind: 'text',
      scope: 'site',
      origin,
    });

    let catalog = await session.informationVault.catalog(origin);
    let themeVar = catalog.find((v) => v.name === 'Theme');
    expect(themeVar?.description).toBe('Updated theme');
    expect(await session.informationVault.read(themeVar!.id, origin)).toBe('dark');

    // 3. Save a typed record with recordId 'var:ProtectedLogin'
    await session.vault.save(origin, 'var:ProtectedLogin', {
      version: 1,
      kind: 'login',
      username: 'prot-user',
      password: 'prot-password',
    });

    // Attempting to overwrite typed record with named variable targeting 'var:ProtectedLogin' throws RECORD_OVERWRITE_DENIED
    await expect(
      session.informationVault.save({
        name: 'ProtectedLogin',
        description: 'Should fail overwrite',
        value: 'new-val',
        kind: 'text',
        scope: 'site',
        origin,
      }),
    ).rejects.toThrow('RECORD_OVERWRITE_DENIED');

    // Attempting to overwrite existing variable with typed record throws RECORD_OVERWRITE_DENIED
    await expect(
      session.vault.save(origin, 'var:Theme', {
        version: 1,
        kind: 'login',
        username: 'theme-user',
        password: 'theme-password',
      }),
    ).rejects.toThrow('RECORD_OVERWRITE_DENIED');

    await session.close();
  });

  test('verifies full metadata snapshot checks and detects metadata tampering before read', async () => {
    const accounts = await HostedAccounts.open({ directory: testDir, registrationKey: regKey });
    const session = await accounts.register('snapshot_test', 'secure-password-1234', regKey);
    const origin = 'https://app.example.com';

    await session.informationVault.save({
      name: 'Setting',
      description: 'Original description',
      value: 'val-123',
      kind: 'text',
      scope: 'site',
      origin,
    });

    const catalog = await session.informationVault.catalog(origin);
    const item = catalog[0]!;
    expect(item).toBeDefined();

    // Update description in vault
    await session.informationVault.save({
      name: 'Setting',
      description: 'Tampered description',
      value: 'val-123',
      kind: 'text',
      scope: 'site',
      origin,
    });

    // Reading with old opaque binding snapshot throws VARIABLE_SNAPSHOT_MISMATCH
    await expect(session.informationVault.read(item.id, origin)).rejects.toThrow(
      'VARIABLE_SNAPSHOT_MISMATCH',
    );

    await session.close();
  });

  test('enforces max 100 accounts limit', async () => {
    // Pre-populate index with 100 accounts
    const indexPath = join(testDir, 'accounts.json');
    const mockAccounts: Record<string, { accountId: string; username: string; salt: string; authVerifier: string; vaultFile: string; createdAt: string }> = {};
    for (let i = 0; i < 100; i++) {
      const u = `preuser_${i.toString().padStart(3, '0')}`;
      mockAccounts[u] = {
        accountId: `mock-${i}`,
        username: u,
        salt: '0'.repeat(64),
        authVerifier: '0'.repeat(64),
        vaultFile: `mock-${i}.vault`,
        createdAt: new Date().toISOString(),
      };
    }
    await mkdir(testDir, { recursive: true });
    await writeFile(indexPath, JSON.stringify({ version: 1, accounts: mockAccounts }), 'utf-8');

    const accounts = await HostedAccounts.open({ directory: testDir, registrationKey: regKey });

    // 101st registration throws ACCOUNT_LIMIT_EXCEEDED
    await expect(
      accounts.register('user_limit_exceeded', 'common-password-1234', regKey),
    ).rejects.toThrow('ACCOUNT_LIMIT_EXCEEDED');
  });
});
