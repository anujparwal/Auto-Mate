import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  AutofillVault,
  CardRecord,
  LoginRecord,
  VaultEntry,
  VaultKind,
  VaultRecord,
} from './autofill-contract';
import type {
  InformationFieldKind,
  InformationScope,
  InformationVault,
  InformationVariable,
  InformationVariableInput,
  InformationVariableKind,
} from './information-contract';
import { PROFILE_ORIGIN_NORMAL } from './information-vault';
import { httpsOrigin, PolicyError } from './policy';
import { decodeVaultRecord, parseVaultRecord, serializeVaultRecord } from './vault-record';

function scryptAsync(
  password: Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  scrypt(password, salt, keylen, options, (err, derivedKey) => {
    if (err) reject(err);
    else resolve(derivedKey as Buffer);
  });
  return promise;
}

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024; // 64 MiB
const SCRYPT_KEYLEN = 32;

const MAX_ACCOUNTS = 100;

const VALID_VARIABLE_INPUT_KINDS: Readonly<Record<string, true>> = Object.freeze({
  text: true,
  email: true,
  tel: true,
  url: true,
  username: true,
  password: true,
  date: true,
  number: true,
});

class AsyncMutex {
  #queue: Promise<void> = Promise.resolve();

  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const { promise: next, resolve } = Promise.withResolvers<void>();
    const previous = this.#queue;
    this.#queue = next;
    try {
      await previous;
      return await task();
    } finally {
      resolve();
    }
  }
}

function safeStringEqual(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a, 'utf-8').digest();
  const hashB = createHash('sha256').update(b, 'utf-8').digest();
  const equalHash = timingSafeEqual(hashA, hashB);
  return equalHash && a.length === b.length;
}

function validateUsername(username: unknown): string {
  if (typeof username !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) {
    throw new PolicyError('INVALID_USERNAME');
  }
  return username;
}

function validateKey(key: unknown): string {
  if (typeof key !== 'string' || key.length < 12 || key.length > 1024) {
    throw new PolicyError('INVALID_KEY');
  }
  return key; // Never trim passphrase
}

function validateRegistrationKey(key: unknown): string {
  if (typeof key !== 'string' || key.length < 16) {
    throw new PolicyError('INVALID_REGISTRATION_KEY');
  }
  return key;
}

async function writeAtomic(targetPath: string, data: string | Buffer): Promise<void> {
  const dir = dirname(targetPath);
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  try {
    await writeFile(tmpPath, data);
    await rename(tmpPath, targetPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {}
    throw err;
  }
}

async function deriveKeys(passphrase: string, salt: Buffer): Promise<{ authSubkey: Buffer; encSubkey: Buffer }> {
  const masterKey = (await scryptAsync(Buffer.from(passphrase, 'utf-8'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  })) as Buffer;

  const authSubkey = createHmac('sha256', masterKey).update('auto-mate:hosted-account:auth-verifier:v1').digest();
  const encSubkey = createHmac('sha256', masterKey).update('auto-mate:hosted-account:vault-encryption:v1').digest();

  masterKey.fill(0);
  return { authSubkey, encSubkey };
}

function computeAuthVerifier(authSubkey: Buffer): string {
  return createHmac('sha256', authSubkey).update('auto-mate:hosted-account:auth-verifier-check:v1').digest('hex');
}

interface StoredTypedRecord {
  readonly type: 'record';
  readonly origin: string;
  readonly recordId: string;
  readonly secret: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface StoredVariable {
  readonly type: 'variable';
  readonly origin: string;
  readonly recordId: string;
  readonly name: string;
  readonly description: string;
  readonly value: string;
  readonly kind: Exclude<InformationFieldKind, 'select'>;
  readonly scope: InformationScope;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type StoredVaultItem = StoredTypedRecord | StoredVariable;

interface VaultPayload {
  readonly version: 1;
  readonly records: StoredVaultItem[];
}

interface EncryptedEnvelope {
  readonly version: 1;
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
}

function encryptVault(data: VaultPayload, encKey: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey, nonce);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf-8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const envelope: EncryptedEnvelope = {
    version: 1,
    iv: nonce.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: ciphertext.toString('base64'),
  };
  return Buffer.from(JSON.stringify(envelope), 'utf-8');
}

function decryptVault(fileBuffer: Buffer, encKey: Buffer): VaultPayload {
  let envelope: EncryptedEnvelope;
  try {
    const raw = JSON.parse(fileBuffer.toString('utf-8'));
    if (
      !raw ||
      typeof raw !== 'object' ||
      raw.version !== 1 ||
      typeof raw.iv !== 'string' ||
      typeof raw.authTag !== 'string' ||
      typeof raw.ciphertext !== 'string'
    ) {
      throw new PolicyError('VAULT_CORRUPTED');
    }
    envelope = raw;
  } catch (err) {
    if (err instanceof PolicyError) throw err;
    throw new PolicyError('VAULT_CORRUPTED');
  }

  const nonce = Buffer.from(envelope.iv, 'hex');
  const authTag = Buffer.from(envelope.authTag, 'hex');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');

  if (nonce.length !== 12 || authTag.length !== 16) {
    throw new PolicyError('VAULT_CORRUPTED');
  }

  const decipher = createDecipheriv('aes-256-gcm', encKey, nonce);
  decipher.setAuthTag(authTag);
  let decrypted: Buffer;
  try {
    decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new PolicyError('VAULT_CORRUPTED');
  }

  try {
    const payload = JSON.parse(decrypted.toString('utf-8'));
    if (!payload || typeof payload !== 'object' || payload.version !== 1 || !Array.isArray(payload.records)) {
      throw new PolicyError('VAULT_CORRUPTED');
    }
    return payload as VaultPayload;
  } catch {
    throw new PolicyError('VAULT_CORRUPTED');
  }
}

interface AccountMetadata {
  readonly accountId: string;
  readonly username: string;
  readonly salt: string;
  readonly authVerifier: string;
  readonly vaultFile: string;
  readonly createdAt: string;
}

interface AccountsIndex {
  readonly version: 1;
  readonly accounts: Record<string, AccountMetadata>;
}

interface HostedVariableBinding {
  readonly id: string;
  readonly recordId: string;
  readonly sourceOrigin: string;
  readonly fieldKey?: 'username' | 'password' | 'cardholder' | 'cardNumber' | 'expiryMonth' | 'expiryYear';
  readonly name: string;
  readonly description: string;
  readonly kind: InformationVariableKind;
  readonly scope: InformationScope;
  readonly targetOrigin: string;
  readonly available: boolean;
}

class HostedAutofillVault implements AutofillVault {
  readonly #session: HostedAccountSession;

  constructor(session: HostedAccountSession) {
    this.#session = session;
  }

  async list(origin: string): Promise<readonly VaultEntry[]> {
    this.#session.assertActive();
    const canonical = httpsOrigin(origin);

    return await this.#session.runInFlight(async () => {
      this.#session.assertActive();
      const mutex = this.#session.getMutex();
      return await mutex.runExclusive(async () => {
        this.#session.assertActive();
        const vaultData = await this.#session.readVaultUnderLock();
        this.#session.assertActive();

        const entries: VaultEntry[] = [];
        for (const item of vaultData.records) {
          if (item.origin === canonical) {
            entries.push(
              Object.freeze({
                origin: item.origin,
                recordId: item.recordId,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
              }),
            );
          }
        }
        return Object.freeze(entries);
      });
    });
  }

  async save(origin: string, recordId: string, record: VaultRecord): Promise<void> {
    this.#session.assertActive();
    const canonical = httpsOrigin(origin);
    if (!recordId || typeof recordId !== 'string' || recordId.trim().length === 0 || recordId.length > 320) {
      throw new PolicyError('INVALID_RECORD_ID');
    }
    const parsed = parseVaultRecord(record);
    const secret = serializeVaultRecord(parsed);

    await this.#session.runInFlight(async () => {
      this.#session.assertActive();
      const mutex = this.#session.getMutex();
      await mutex.runExclusive(async () => {
        this.#session.assertActive();
        const vaultData = await this.#session.readVaultUnderLock();
        this.#session.assertActive();

        const existingIdx = vaultData.records.findIndex(
          (r) => r.origin === canonical && r.recordId === recordId,
        );

        if (existingIdx >= 0) {
          const existing = vaultData.records[existingIdx]!;
          if (existing.type === 'variable') {
            throw new PolicyError('RECORD_OVERWRITE_DENIED');
          }
        }

        const now = new Date().toISOString();
        const createdAt = existingIdx >= 0 ? vaultData.records[existingIdx]!.createdAt : now;
        const newItem: StoredTypedRecord = {
          type: 'record',
          origin: canonical,
          recordId,
          secret,
          createdAt,
          updatedAt: now,
        };

        const nextRecords = [...vaultData.records];
        if (existingIdx >= 0) {
          nextRecords[existingIdx] = newItem;
        } else {
          nextRecords.push(newItem);
        }

        const updatedPayload: VaultPayload = {
          version: 1,
          records: nextRecords,
        };

        this.#session.assertActive();
        await this.#session.writeVaultUnderLock(updatedPayload);
        this.#session.assertActive();
      });
    });
  }

  async read(origin: string, recordId: string, kind: VaultKind): Promise<VaultRecord> {
    this.#session.assertActive();
    const canonical = httpsOrigin(origin);
    if (!recordId || typeof recordId !== 'string' || recordId.trim().length === 0 || recordId.length > 320) {
      throw new PolicyError('INVALID_RECORD_ID');
    }
    if (kind !== 'login' && kind !== 'card') {
      throw new PolicyError('INVALID_VAULT_RECORD');
    }

    return await this.#session.runInFlight(async () => {
      this.#session.assertActive();
      const mutex = this.#session.getMutex();
      return await mutex.runExclusive(async () => {
        this.#session.assertActive();
        const vaultData = await this.#session.readVaultUnderLock();
        this.#session.assertActive();

        const item = vaultData.records.find((r) => r.origin === canonical && r.recordId === recordId);
        if (!item) {
          throw new PolicyError('RECORD_NOT_FOUND');
        }
        if (item.type !== 'record') {
          throw new PolicyError('INVALID_VAULT_RECORD');
        }

        return decodeVaultRecord(item.secret, kind, recordId);
      });
    });
  }
}

class HostedInformationVault implements InformationVault {
  readonly #session: HostedAccountSession;
  readonly #bindings = new Map<string, HostedVariableBinding>();

  constructor(session: HostedAccountSession) {
    this.#session = session;
  }

  async catalog(origin: string): Promise<readonly InformationVariable[]> {
    this.#session.assertActive();
    const canonicalTargetOrigin = httpsOrigin(origin);

    return await this.#session.runInFlight(async () => {
      this.#session.assertActive();
      const mutex = this.#session.getMutex();
      return await mutex.runExclusive(async () => {
        this.#session.assertActive();
        const vaultData = await this.#session.readVaultUnderLock();
        this.#session.assertActive();

        const allowlisted: InformationVariable[] = [];

        for (const item of vaultData.records) {
          if (item.type === 'variable') {
            const isProfile = item.scope === 'profile';
            const available = isProfile || item.origin === canonicalTargetOrigin;
            const opaqueId = randomUUID();

            this.#bindings.set(opaqueId, {
              id: opaqueId,
              recordId: item.recordId,
              sourceOrigin: item.origin,
              name: item.name,
              description: item.description,
              kind: item.kind,
              scope: item.scope,
              targetOrigin: canonicalTargetOrigin,
              available,
            });

            allowlisted.push(
              Object.freeze({
                id: opaqueId,
                name: item.name,
                description: item.description,
                kind: item.kind,
                scope: item.scope,
                available,
              }),
            );
          } else if (item.type === 'record') {
            let parsed: VaultRecord;
            try {
              parsed = parseVaultRecord(JSON.parse(item.secret));
            } catch {
              continue;
            }

            const available = item.origin === canonicalTargetOrigin;

            if (parsed.kind === 'login') {
              const usernameId = randomUUID();
              const usernameName = `Username (${item.recordId})`;
              const usernameDesc = `Username for ${item.origin} (${item.recordId})`;
              this.#bindings.set(usernameId, {
                id: usernameId,
                recordId: item.recordId,
                sourceOrigin: item.origin,
                fieldKey: 'username',
                name: usernameName,
                description: usernameDesc,
                kind: 'username',
                scope: 'site',
                targetOrigin: canonicalTargetOrigin,
                available,
              });
              allowlisted.push(
                Object.freeze({
                  id: usernameId,
                  name: usernameName,
                  description: usernameDesc,
                  kind: 'username',
                  scope: 'site',
                  available,
                }),
              );

              const passwordId = randomUUID();
              const passwordName = `Password (${item.recordId})`;
              const passwordDesc = `Password for ${item.origin} (${item.recordId})`;
              this.#bindings.set(passwordId, {
                id: passwordId,
                recordId: item.recordId,
                sourceOrigin: item.origin,
                fieldKey: 'password',
                name: passwordName,
                description: passwordDesc,
                kind: 'password',
                scope: 'site',
                targetOrigin: canonicalTargetOrigin,
                available,
              });
              allowlisted.push(
                Object.freeze({
                  id: passwordId,
                  name: passwordName,
                  description: passwordDesc,
                  kind: 'password',
                  scope: 'site',
                  available,
                }),
              );
            } else if (parsed.kind === 'card') {
              const cardFields: Array<{
                key: 'cardholder' | 'cardNumber' | 'expiryMonth' | 'expiryYear';
                kind: InformationVariableKind;
                name: string;
                desc: string;
              }> = [
                {
                  key: 'cardholder',
                  kind: 'cardholder',
                  name: `Cardholder (${item.recordId})`,
                  desc: `Cardholder name for ${item.origin} (${item.recordId})`,
                },
                {
                  key: 'cardNumber',
                  kind: 'cardNumber',
                  name: `Card number (${item.recordId})`,
                  desc: `Credit card number for ${item.origin} (${item.recordId})`,
                },
                {
                  key: 'expiryMonth',
                  kind: 'expiryMonth',
                  name: `Expiry month (${item.recordId})`,
                  desc: `Card expiration month for ${item.origin} (${item.recordId})`,
                },
                {
                  key: 'expiryYear',
                  kind: 'expiryYear',
                  name: `Expiry year (${item.recordId})`,
                  desc: `Card expiration year for ${item.origin} (${item.recordId})`,
                },
              ];

              for (const f of cardFields) {
                const fieldId = randomUUID();
                this.#bindings.set(fieldId, {
                  id: fieldId,
                  recordId: item.recordId,
                  sourceOrigin: item.origin,
                  fieldKey: f.key,
                  name: f.name,
                  description: f.desc,
                  kind: f.kind,
                  scope: 'site',
                  targetOrigin: canonicalTargetOrigin,
                  available,
                });
                allowlisted.push(
                  Object.freeze({
                    id: fieldId,
                    name: f.name,
                    description: f.desc,
                    kind: f.kind,
                    scope: 'site',
                    available,
                  }),
                );
              }
            }
          }
        }

        return Object.freeze(allowlisted);
      });
    });
  }

  async save(input: InformationVariableInput): Promise<void> {
    this.#session.assertActive();
    if (!input || typeof input !== 'object') {
      throw new PolicyError('INVALID_VARIABLE_INPUT');
    }

    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80) {
      throw new PolicyError('INVALID_VARIABLE_NAME');
    }

    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (!description || description.length > 500) {
      throw new PolicyError('INVALID_VARIABLE_DESCRIPTION');
    }

    const value = typeof input.value === 'string' ? input.value : '';
    if (!value || value.length > 4096) {
      throw new PolicyError('INVALID_VARIABLE_VALUE');
    }

    if (!VALID_VARIABLE_INPUT_KINDS[input.kind]) {
      throw new PolicyError('INVALID_VARIABLE_KIND');
    }

    if (input.scope !== 'profile' && input.scope !== 'site') {
      throw new PolicyError('INVALID_VARIABLE_SCOPE');
    }

    if (input.scope === 'profile') {
      if (input.kind === 'username' || input.kind === 'password') {
        throw new PolicyError('CREDENTIAL_CANNOT_BE_PROFILE');
      }
    }

    const targetOrigin = httpsOrigin(input.origin);
    const profileOrigin = PROFILE_ORIGIN_NORMAL;

    let storageOrigin: string;
    if (input.scope === 'profile') {
      storageOrigin = profileOrigin;
    } else {
      if (targetOrigin === profileOrigin) {
        throw new PolicyError('INVALID_ORIGIN');
      }
      storageOrigin = targetOrigin;
    }

    const recordId = 'var:' + name;

    await this.#session.runInFlight(async () => {
      this.#session.assertActive();
      const mutex = this.#session.getMutex();
      await mutex.runExclusive(async () => {
        this.#session.assertActive();
        const vaultData = await this.#session.readVaultUnderLock();
        this.#session.assertActive();

        const existingIdx = vaultData.records.findIndex(
          (r) => r.origin === storageOrigin && r.recordId === recordId,
        );

        if (existingIdx >= 0) {
          const existing = vaultData.records[existingIdx]!;
          if (existing.type !== 'variable') {
            throw new PolicyError('RECORD_OVERWRITE_DENIED');
          }
        }

        const now = new Date().toISOString();
        const createdAt = existingIdx >= 0 ? vaultData.records[existingIdx]!.createdAt : now;
        const newItem: StoredVariable = {
          type: 'variable',
          origin: storageOrigin,
          recordId,
          name,
          description,
          value,
          kind: input.kind,
          scope: input.scope,
          createdAt,
          updatedAt: now,
        };

        const nextRecords = [...vaultData.records];
        if (existingIdx >= 0) {
          nextRecords[existingIdx] = newItem;
        } else {
          nextRecords.push(newItem);
        }

        const updatedPayload: VaultPayload = {
          version: 1,
          records: nextRecords,
        };

        this.#session.assertActive();
        await this.#session.writeVaultUnderLock(updatedPayload);
        this.#session.assertActive();
      });
    });
  }

  async read(id: string, origin: string): Promise<string> {
    this.#session.assertActive();
    const canonicalTargetOrigin = httpsOrigin(origin);

    if (!id || typeof id !== 'string') {
      throw new PolicyError('INVALID_VARIABLE_ID');
    }

    const binding = this.#bindings.get(id);
    if (!binding) {
      throw new PolicyError('UNKNOWN_VARIABLE');
    }

    if (!binding.available) {
      throw new PolicyError('VARIABLE_NOT_AVAILABLE');
    }

    if (binding.targetOrigin !== canonicalTargetOrigin) {
      throw new PolicyError('CROSS_ORIGIN_DENIED');
    }

    if (binding.scope === 'site' && binding.sourceOrigin !== canonicalTargetOrigin) {
      throw new PolicyError('CROSS_ORIGIN_DENIED');
    }

    return await this.#session.runInFlight(async () => {
      this.#session.assertActive();
      const mutex = this.#session.getMutex();
      return await mutex.runExclusive(async () => {
        this.#session.assertActive();
        const vaultData = await this.#session.readVaultUnderLock();
        this.#session.assertActive();

        const item = vaultData.records.find(
          (r) => r.origin === binding.sourceOrigin && r.recordId === binding.recordId,
        );
        if (!item) {
          throw new PolicyError('UNKNOWN_VARIABLE');
        }

        if (binding.fieldKey) {
          if (item.type !== 'record') {
            throw new PolicyError('VARIABLE_SNAPSHOT_MISMATCH');
          }

          let parsed: VaultRecord;
          try {
            parsed = parseVaultRecord(JSON.parse(item.secret));
          } catch {
            throw new PolicyError('VARIABLE_SNAPSHOT_MISMATCH');
          }

          if (parsed.kind === 'login') {
            if (binding.fieldKey === 'username') {
              if (
                binding.name !== `Username (${item.recordId})` ||
                binding.description !== `Username for ${item.origin} (${item.recordId})` ||
                binding.kind !== 'username' ||
                binding.scope !== 'site'
              ) {
                throw new PolicyError('VARIABLE_SNAPSHOT_MISMATCH');
              }
              return parsed.username;
            } else if (binding.fieldKey === 'password') {
              if (
                binding.name !== `Password (${item.recordId})` ||
                binding.description !== `Password for ${item.origin} (${item.recordId})` ||
                binding.kind !== 'password' ||
                binding.scope !== 'site'
              ) {
                throw new PolicyError('VARIABLE_SNAPSHOT_MISMATCH');
              }
              return parsed.password;
            } else {
              throw new PolicyError('VARIABLE_SNAPSHOT_MISMATCH');
            }
          } else if (parsed.kind === 'card') {
            if (binding.fieldKey === 'cardholder') {
              if (
                binding.name !== `Cardholder (${item.recordId})` ||
                binding.description !== `Cardholder name for ${item.origin} (${item.recordId})` ||
                binding.kind !== 'cardholder' ||
                binding.scope !== 'site'
              ) {
                throw new PolicyError('VARIABLE_SNAPSHOT_MISMATCH');
              }
              return parsed.cardholder;
            } else if (binding.fieldKey === 'cardNumber') {
              if (
                binding.name !== `Card number (${item.recordId})` ||
                binding.description !== `Credit card number for ${item.origin} (${item.recordId})` ||
                binding.kind !== 'cardNumber' ||
                binding.scope !== 'site'
              ) {
                throw new PolicyError('VARIABLE_SNAPSHOT_MISMATCH');
              }
              return parsed.cardNumber;
            } else if (binding.fieldKey === 'expiryMonth') {
              if (
                binding.name !== `Expiry month (${item.recordId})` ||
                binding.description !== `Card expiration month for ${item.origin} (${item.recordId})` ||
                binding.kind !== 'expiryMonth' ||
                binding.scope !== 'site'
              ) {
                throw new PolicyError('VARIABLE_SNAPSHOT_MISMATCH');
              }
              return parsed.expiryMonth;
            } else if (binding.fieldKey === 'expiryYear') {
              if (
                binding.name !== `Expiry year (${item.recordId})` ||
                binding.description !== `Card expiration year for ${item.origin} (${item.recordId})` ||
                binding.kind !== 'expiryYear' ||
                binding.scope !== 'site'
              ) {
                throw new PolicyError('VARIABLE_SNAPSHOT_MISMATCH');
              }
              return parsed.expiryYear;
            } else {
              throw new PolicyError('VARIABLE_SNAPSHOT_MISMATCH');
            }
          } else {
            throw new PolicyError('VARIABLE_SNAPSHOT_MISMATCH');
          }
        } else {
          if (item.type !== 'variable') {
            throw new PolicyError('VARIABLE_SNAPSHOT_MISMATCH');
          }
          if (
            item.name !== binding.name ||
            item.description !== binding.description ||
            item.kind !== binding.kind ||
            item.scope !== binding.scope ||
            item.origin !== binding.sourceOrigin
          ) {
            throw new PolicyError('VARIABLE_SNAPSHOT_MISMATCH');
          }
          return item.value;
        }
      });
    });
  }

  async authenticate(origin: string): Promise<void> {
    this.#session.assertActive();
    httpsOrigin(origin);
  }

  clear(): void {
    this.#bindings.clear();
  }
}

export class HostedAccountSession {
  readonly #accountId: string;
  readonly #username: string;
  readonly #vault: AutofillVault;
  readonly #informationVault: InformationVault;
  readonly #accountMutex: AsyncMutex;
  readonly #vaultFilePath: string;
  #encKeyBuffer: Buffer | null;
  #closed = false;
  readonly #inFlight = new Set<Promise<unknown>>();

  constructor(
    accountId: string,
    username: string,
    encKeyBuffer: Buffer,
    vaultFilePath: string,
    accountMutex: AsyncMutex,
  ) {
    this.#accountId = accountId;
    this.#username = username;
    this.#encKeyBuffer = encKeyBuffer;
    this.#vaultFilePath = vaultFilePath;
    this.#accountMutex = accountMutex;

    this.#vault = new HostedAutofillVault(this);
    this.#informationVault = new HostedInformationVault(this);
  }

  get accountId(): string {
    return this.#accountId;
  }

  get username(): string {
    return this.#username;
  }

  get vault(): AutofillVault {
    return this.#vault;
  }

  get informationVault(): InformationVault {
    return this.#informationVault;
  }

  assertActive(): void {
    if (this.#closed || !this.#encKeyBuffer) {
      throw new PolicyError('SESSION_CLOSED');
    }
  }

  async runInFlight<T>(op: () => Promise<T>): Promise<T> {
    this.assertActive();
    let promise: Promise<T>;
    const track = async () => {
      this.assertActive();
      return await op();
    };
    promise = track();
    this.#inFlight.add(promise);
    try {
      const result = await promise;
      this.assertActive();
      return result;
    } finally {
      this.#inFlight.delete(promise);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#informationVault.clear();

    if (this.#inFlight.size > 0) {
      await Promise.allSettled(Array.from(this.#inFlight));
    }

    if (this.#encKeyBuffer) {
      this.#encKeyBuffer.fill(0);
      this.#encKeyBuffer = null;
    }
  }

  getMutex(): AsyncMutex {
    return this.#accountMutex;
  }

  async readVaultUnderLock(): Promise<VaultPayload> {
    this.assertActive();
    if (!this.#encKeyBuffer) {
      throw new PolicyError('SESSION_CLOSED');
    }
    const raw = await readFile(this.#vaultFilePath);
    this.assertActive();
    if (!this.#encKeyBuffer) {
      throw new PolicyError('SESSION_CLOSED');
    }
    return decryptVault(raw, this.#encKeyBuffer);
  }

  async writeVaultUnderLock(payload: VaultPayload): Promise<void> {
    this.assertActive();
    if (!this.#encKeyBuffer) {
      throw new PolicyError('SESSION_CLOSED');
    }
    const encrypted = encryptVault(payload, this.#encKeyBuffer);
    this.assertActive();
    await writeAtomic(this.#vaultFilePath, encrypted);
    this.assertActive();
  }
}

export class HostedAccounts {
  readonly #directory: string;
  readonly #registrationKey: string;
  readonly #creationMutex = new AsyncMutex();
  readonly #accountMutexes = new Map<string, AsyncMutex>();

  private constructor(directory: string, registrationKey: string) {
    this.#directory = directory;
    this.#registrationKey = registrationKey;
  }

  static async open(options: { directory: string; registrationKey: string }): Promise<HostedAccounts> {
    if (!options || typeof options !== 'object') {
      throw new PolicyError('INVALID_OPTIONS');
    }
    if (typeof options.directory !== 'string' || options.directory.trim().length === 0) {
      throw new PolicyError('INVALID_DIRECTORY');
    }
    validateRegistrationKey(options.registrationKey);

    const directory = resolve(options.directory);
    await mkdir(directory, { recursive: true });

    const accountsFilePath = join(directory, 'accounts.json');
    try {
      const raw = await readFile(accountsFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1 || typeof parsed.accounts !== 'object' || parsed.accounts === null) {
        throw new PolicyError('ACCOUNTS_INDEX_CORRUPT');
      }
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        const initialIndex: AccountsIndex = { version: 1, accounts: {} };
        await writeAtomic(accountsFilePath, Buffer.from(JSON.stringify(initialIndex, null, 2), 'utf-8'));
      } else {
        if (err instanceof PolicyError) throw err;
        throw new PolicyError('ACCOUNTS_INDEX_CORRUPT');
      }
    }

    return new HostedAccounts(directory, options.registrationKey);
  }

  private getAccountMutex(accountId: string): AsyncMutex {
    let mutex = this.#accountMutexes.get(accountId);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.#accountMutexes.set(accountId, mutex);
    }
    return mutex;
  }

  private async loadIndex(): Promise<AccountsIndex> {
    const accountsFilePath = join(this.#directory, 'accounts.json');
    try {
      const raw = await readFile(accountsFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1 || typeof parsed.accounts !== 'object' || parsed.accounts === null) {
        throw new PolicyError('ACCOUNTS_INDEX_CORRUPT');
      }
      return parsed as AccountsIndex;
    } catch (err) {
      if (err instanceof PolicyError) throw err;
      throw new PolicyError('ACCOUNTS_INDEX_CORRUPT');
    }
  }

  private async saveIndex(index: AccountsIndex): Promise<void> {
    const accountsFilePath = join(this.#directory, 'accounts.json');
    await writeAtomic(accountsFilePath, Buffer.from(JSON.stringify(index, null, 2), 'utf-8'));
  }

  async register(username: string, key: string, registrationKey: string): Promise<HostedAccountSession> {
    // 1. Safe registrationKey check: wrong registration code cannot create data
    if (typeof registrationKey !== 'string' || !safeStringEqual(registrationKey, this.#registrationKey)) {
      throw new PolicyError('INVALID_REGISTRATION_KEY');
    }

    // 2. Format validation
    const validUser = validateUsername(username);
    const validKey = validateKey(key);

    return await this.#creationMutex.runExclusive(async () => {
      // 3. Read latest index under exclusive creation lock
      const index = await this.loadIndex();

      if (Object.keys(index.accounts).length >= MAX_ACCOUNTS) {
        throw new PolicyError('ACCOUNT_LIMIT_EXCEEDED');
      }

      if (Object.hasOwn(index.accounts, validUser)) {
        throw new PolicyError('ACCOUNT_ALREADY_EXISTS');
      }

      // 4. Generate random ID for account and storage file (no user input in path)
      const accountId = randomUUID();
      const vaultFileName = `${accountId}.vault`;
      const vaultFilePath = join(this.#directory, vaultFileName);

      // 5. Derive independent subkeys via domain-separated HMAC
      const salt = randomBytes(32);
      const { authSubkey, encSubkey } = await deriveKeys(validKey, salt);
      const authVerifier = computeAuthVerifier(authSubkey);
      authSubkey.fill(0);

      // 6. Encrypt and write initial empty vault to disk
      const initialVault: VaultPayload = {
        version: 1,
        records: [],
      };
      const encryptedVault = encryptVault(initialVault, encSubkey);
      await writeAtomic(vaultFilePath, encryptedVault);

      // 7. Store outer login metadata (no plaintext passphrase, variable data, records, origins)
      const now = new Date().toISOString();
      index.accounts[validUser] = {
        accountId,
        username: validUser,
        salt: salt.toString('hex'),
        authVerifier,
        vaultFile: vaultFileName,
        createdAt: now,
      };
      await this.saveIndex(index);

      // 8. Return already-unlocked session to avoid repeating KDF
      const mutex = this.getAccountMutex(accountId);
      return new HostedAccountSession(accountId, validUser, encSubkey, vaultFilePath, mutex);
    });
  }

  async unlock(username: string, key: string): Promise<HostedAccountSession> {
    const validUser = validateUsername(username);
    const validKey = validateKey(key);

    const index = await this.loadIndex();
    const accountMeta = Object.hasOwn(index.accounts, validUser) ? index.accounts[validUser] : undefined;
    if (!accountMeta) {
      throw new PolicyError('INVALID_CREDENTIALS');
    }

    const salt = Buffer.from(accountMeta.salt, 'hex');
    const { authSubkey, encSubkey } = await deriveKeys(validKey, salt);
    const candidateVerifier = computeAuthVerifier(authSubkey);
    authSubkey.fill(0);

    if (!safeStringEqual(candidateVerifier, accountMeta.authVerifier)) {
      encSubkey.fill(0);
      throw new PolicyError('INVALID_CREDENTIALS');
    }

    const vaultFilePath = join(this.#directory, accountMeta.vaultFile);
    const mutex = this.getAccountMutex(accountMeta.accountId);

    // Authenticate ciphertext immediately fails closed if corrupted
    try {
      const rawVault = await readFile(vaultFilePath);
      decryptVault(rawVault, encSubkey);
    } catch (err) {
      encSubkey.fill(0);
      if (err instanceof PolicyError) throw err;
      throw new PolicyError('VAULT_CORRUPTED');
    }

    return new HostedAccountSession(accountMeta.accountId, validUser, encSubkey, vaultFilePath, mutex);
  }
}
