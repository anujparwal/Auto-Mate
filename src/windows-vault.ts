import { isAbsolute, relative, resolve, sep, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { PasswordStore } from './workflow';
import { httpsOrigin, PolicyError } from './policy';

export const SYNTHETIC_VAULT_ROOT = join(tmpdir(), 'AutoMate-Synthetic');
export interface WindowsPasswordStoreOptions {
  readonly vaultPath?: string;
  readonly mode?: 'windows-hello' | 'synthetic';
}

/** Trusted executor only. Hello gates normal operations; it does not change DPAPI's same-user boundary. */
export class WindowsPasswordStore implements PasswordStore {
  private readonly vaultPath?: string;
  private readonly mode: 'windows-hello' | 'synthetic';
  constructor(options: WindowsPasswordStoreOptions = {}) {
    this.vaultPath = options.vaultPath;
    this.mode = options.mode ?? 'windows-hello';
    if (this.mode !== 'windows-hello' && this.mode !== 'synthetic') throw new PolicyError('INVALID_VAULT_MODE');
  }

  async generateAndPersist(origin: string): Promise<{ reference: string; password: string }> {
    if (process.platform !== 'win32') throw new PolicyError('WINDOWS_REQUIRED');
    const canonical = httpsOrigin(origin);
    if (this.mode === 'synthetic') {
      if (!this.vaultPath) throw new PolicyError('SYNTHETIC_VAULT_PATH_REQUIRED');
      const location = relative(SYNTHETIC_VAULT_ROOT, resolve(this.vaultPath));
      if (!location || isAbsolute(location) || location === '..' || location.startsWith('..' + sep) || location.split(sep).length < 2)
        throw new PolicyError('SYNTHETIC_VAULT_PATH_DENIED');
      if (!new URL(canonical).hostname.endsWith('.test')) throw new PolicyError('SYNTHETIC_ORIGIN_DENIED');
    }
    const reference = randomUUID();
    const args = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve(import.meta.dir, '../platforms/windows/vault.ps1'), '-Broker'];
    if (this.vaultPath) args.push('-VaultPath', resolve(this.vaultPath));
    if (this.mode === 'synthetic') args.push('-Synthetic');
    const child = Bun.spawn(args, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    child.stdin.write(JSON.stringify({ action: 'persist-generated', origin: canonical, recordId: reference, length: 28 }));
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 90000);
    try {
      const [text, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      let result: unknown;
      try { result = JSON.parse(text); } catch { throw new PolicyError(exit === 0 ? 'VAULT_PROTOCOL_FAILED' : 'VAULT_WRITE_FAILED'); }
      if (exit !== 0) {
        if (result && typeof result === 'object' && 'error' in result && result.error === 'VAULT_AUTHENTICATION_REQUIRED')
          throw new PolicyError('VAULT_AUTHENTICATION_REQUIRED');
        throw new PolicyError('VAULT_WRITE_FAILED');
      }
      const expectedAuthentication = this.mode === 'synthetic' ? 'synthetic-isolated' : 'windows-hello';
      if (!result || typeof result !== 'object' || !('success' in result) || result.success !== true ||
          !('authentication' in result) || result.authentication !== expectedAuthentication ||
          !('action' in result) || result.action !== 'persist-generated' ||
          !('origin' in result) || result.origin !== canonical || !('recordId' in result) || result.recordId !== reference ||
          !('generatedSecret' in result) || typeof result.generatedSecret !== 'string' || result.generatedSecret.length < 20)
        throw new PolicyError('VAULT_PROTOCOL_FAILED');
      return { reference, password: result.generatedSecret };
    } finally { clearTimeout(timer); }
  }
}
