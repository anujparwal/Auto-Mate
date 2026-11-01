import { isAbsolute, relative, resolve, sep, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { PasswordStore } from './workflow';
import { httpsOrigin, PolicyError } from './policy';
import type { AutofillVault, VaultEntry, VaultKind, VaultRecord } from './autofill-contract';
import { decodeVaultRecord, serializeVaultRecord } from './vault-record';

export const SYNTHETIC_VAULT_ROOT = join(tmpdir(), 'AutoMate-Synthetic');

export interface WindowsPasswordStoreOptions {
  readonly vaultPath?: string;
  readonly mode?: 'windows-hello' | 'synthetic';
}

const MAX_STDOUT_BYTES = 1024 * 1024; // 1 MiB
const MAX_STDERR_BYTES = 64 * 1024;   // 64 KiB
const TIMEOUT_MS = 90_000;            // 90s

async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number, keep = true): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          try { await reader.cancel(); } catch {}
          throw new PolicyError('VAULT_PROTOCOL_FAILED');
        }
        if (keep) chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return keep ? new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) : '';
}

function validateOriginAndMode(origin: string, mode: 'windows-hello' | 'synthetic', vaultPath?: string): string {
  if (process.platform !== 'win32') throw new PolicyError('WINDOWS_REQUIRED');
  const canonical = httpsOrigin(origin);
  if (mode === 'synthetic') {
    if (!vaultPath) throw new PolicyError('SYNTHETIC_VAULT_PATH_REQUIRED');
    const location = relative(SYNTHETIC_VAULT_ROOT, resolve(vaultPath));
    if (!location || isAbsolute(location) || location === '..' || location.startsWith('..' + sep) || location.split(sep).length < 2) {
      throw new PolicyError('SYNTHETIC_VAULT_PATH_DENIED');
    }
    if (!new URL(canonical).hostname.endsWith('.test')) {
      throw new PolicyError('SYNTHETIC_ORIGIN_DENIED');
    }
  }
  return canonical;
}

interface BrokerOptions {
  readonly mode: 'windows-hello' | 'synthetic';
  readonly vaultPath?: string;
}

interface BrokerOutputPayload {
  readonly success: true;
  readonly authentication: string;
  readonly action: string;
  readonly origin?: string;
  readonly recordId?: string;
  readonly generatedSecret?: string;
  readonly secret?: string;
  readonly entries?: readonly unknown[];
}

async function invokeNativeBroker(options: BrokerOptions, payload: Record<string, unknown>): Promise<BrokerOutputPayload> {
  if (process.platform !== 'win32') throw new PolicyError('WINDOWS_REQUIRED');

  const scriptPath = resolve(import.meta.dir, '../platforms/windows/vault.ps1');
  const args = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Broker'];
  if (options.vaultPath) args.push('-VaultPath', resolve(options.vaultPath));
  if (options.mode === 'synthetic') args.push('-Synthetic');

  const child = Bun.spawn(args, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  try {
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  } catch {
    // child stdin write failed; proceed to collect exit/stderr
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill(); } catch {}
  }, TIMEOUT_MS);

  let text = '';
  let exitCode = -1;

  try {
    [text, , exitCode] = await Promise.all([
      readBounded(child.stdout, MAX_STDOUT_BYTES),
      readBounded(child.stderr, MAX_STDERR_BYTES, false),
      child.exited,
    ]);
  } catch (err) {
    try { child.kill(); } catch {}
    if (err instanceof PolicyError) throw err;
    throw new PolicyError('VAULT_PROTOCOL_FAILED');
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    throw new PolicyError('VAULT_PROTOCOL_FAILED');
  }

  let result: unknown;
  try {
    result = JSON.parse(text);
  } catch {
    throw new PolicyError(exitCode === 0 ? 'VAULT_PROTOCOL_FAILED' : 'VAULT_WRITE_FAILED');
  }

  if (exitCode !== 0) {
    if (result && typeof result === 'object' && !Array.isArray(result) && 'error' in result) {
      if (result.error === 'VAULT_AUTHENTICATION_REQUIRED') {
        throw new PolicyError('VAULT_AUTHENTICATION_REQUIRED');
      }
      if (result.error === 'VAULT_REQUEST_DENIED') {
        throw new PolicyError('VAULT_REQUEST_DENIED');
      }
    }
    throw new PolicyError('VAULT_WRITE_FAILED');
  }

  const expectedAuthentication = options.mode === 'synthetic' ? 'synthetic-isolated' : 'windows-hello';
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    !('success' in result) ||
    result.success !== true ||
    !('authentication' in result) ||
    result.authentication !== expectedAuthentication ||
    !('action' in result) ||
    typeof result.action !== 'string'
  ) {
    throw new PolicyError('VAULT_PROTOCOL_FAILED');
  }

  const verified: BrokerOutputPayload = {
    success: true,
    authentication: expectedAuthentication,
    action: result.action,
    origin: 'origin' in result && typeof result.origin === 'string' ? result.origin : undefined,
    recordId: 'recordId' in result && typeof result.recordId === 'string' ? result.recordId : undefined,
    generatedSecret: 'generatedSecret' in result && typeof result.generatedSecret === 'string' ? result.generatedSecret : undefined,
    secret: 'secret' in result && typeof result.secret === 'string' ? result.secret : undefined,
    entries: 'entries' in result && Array.isArray(result.entries) ? result.entries : undefined,
  };

  return verified;
}

/** Trusted executor only. Hello gates normal operations; it does not change DPAPI's same-user boundary. */
export class WindowsPasswordStore implements PasswordStore {
  private readonly vaultPath?: string;
  private readonly mode: 'windows-hello' | 'synthetic';

  constructor(options: WindowsPasswordStoreOptions = {}) {
    this.vaultPath = options.vaultPath;
    this.mode = options.mode ?? 'windows-hello';
    if (this.mode !== 'windows-hello' && this.mode !== 'synthetic') {
      throw new PolicyError('INVALID_VAULT_MODE');
    }
  }

  async generateAndPersist(origin: string): Promise<{ reference: string; password: string }> {
    const canonical = validateOriginAndMode(origin, this.mode, this.vaultPath);
    const reference = randomUUID();
    const result = await invokeNativeBroker(
      { mode: this.mode, vaultPath: this.vaultPath },
      { action: 'persist-generated', origin: canonical, recordId: reference, length: 28 },
    );

    if (
      result.action !== 'persist-generated' ||
      result.origin !== canonical ||
      result.recordId !== reference ||
      typeof result.generatedSecret !== 'string' ||
      result.generatedSecret.length < 20
    ) {
      throw new PolicyError('VAULT_PROTOCOL_FAILED');
    }

    return { reference, password: result.generatedSecret };
  }
}

/**
 * Windows Autofill Vault implementing AutofillVault.
 * Encrypts and decrypts typed records (login, card) via native DPAPI CurrentUser storage.
 * In normal mode, gated by mandatory Windows Hello biometric/PIN consent.
 * In synthetic mode, restricted to isolated child temporary directory and .test origins.
 */
export class WindowsAutofillVault implements AutofillVault {
  private readonly vaultPath?: string;
  private readonly mode: 'windows-hello' | 'synthetic';

  constructor(options: WindowsPasswordStoreOptions = {}) {
    this.vaultPath = options.vaultPath;
    this.mode = options.mode ?? 'windows-hello';
    if (this.mode !== 'windows-hello' && this.mode !== 'synthetic') {
      throw new PolicyError('INVALID_VAULT_MODE');
    }
  }

  async list(origin: string): Promise<readonly VaultEntry[]> {
    const canonical = validateOriginAndMode(origin, this.mode, this.vaultPath);
    const result = await invokeNativeBroker(
      { mode: this.mode, vaultPath: this.vaultPath },
      { action: 'list', origin: canonical },
    );

    const rawEntries = result.entries;
    if (result.action !== 'list' || !Array.isArray(rawEntries) || rawEntries.length > 2000) {
      throw new PolicyError('VAULT_PROTOCOL_FAILED');
    }

    const entries: VaultEntry[] = [];
    for (const e of rawEntries) {
      if (
        !e ||
        typeof e !== 'object' ||
        Array.isArray(e) ||
        !('origin' in e) ||
        !('recordId' in e) ||
        !('createdAt' in e) ||
        !('updatedAt' in e)
      ) {
        throw new PolicyError('VAULT_PROTOCOL_FAILED');
      }
      if (
        e.origin !== canonical ||
        typeof e.recordId !== 'string' ||
        !e.recordId ||
        e.recordId.length > 320 ||
        typeof e.createdAt !== 'string' ||
        typeof e.updatedAt !== 'string'
      ) {
        throw new PolicyError('VAULT_PROTOCOL_FAILED');
      }
      entries.push(
        Object.freeze({
          origin: e.origin,
          recordId: e.recordId,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
        }),
      );
    }
    return Object.freeze(entries);
  }

  async save(origin: string, recordId: string, record: VaultRecord): Promise<void> {
    const canonical = validateOriginAndMode(origin, this.mode, this.vaultPath);
    if (!recordId || typeof recordId !== 'string' || recordId.trim().length === 0 || recordId.length > 320) {
      throw new PolicyError('INVALID_RECORD_ID');
    }

    const secret = serializeVaultRecord(record);

    const result = await invokeNativeBroker(
      { mode: this.mode, vaultPath: this.vaultPath },
      { action: 'store-secret', origin: canonical, recordId, secret },
    );

    if (result.action !== 'store-secret' || result.origin !== canonical || result.recordId !== recordId) {
      throw new PolicyError('VAULT_PROTOCOL_FAILED');
    }
  }

  async read(origin: string, recordId: string, kind: VaultKind): Promise<VaultRecord> {
    const canonical = validateOriginAndMode(origin, this.mode, this.vaultPath);
    if (!recordId || typeof recordId !== 'string' || recordId.trim().length === 0 || recordId.length > 320) {
      throw new PolicyError('INVALID_RECORD_ID');
    }
    if (kind !== 'login' && kind !== 'card') {
      throw new PolicyError('INVALID_VAULT_RECORD');
    }

    const result = await invokeNativeBroker(
      { mode: this.mode, vaultPath: this.vaultPath },
      { action: 'retrieve-fill', origin: canonical, recordId },
    );

    if (
      result.action !== 'retrieve-fill' ||
      result.origin !== canonical ||
      result.recordId !== recordId ||
      typeof result.secret !== 'string'
    ) {
      throw new PolicyError('VAULT_PROTOCOL_FAILED');
    }

    return decodeVaultRecord(result.secret, kind, recordId);
  }
}
