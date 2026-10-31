import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PasswordStore } from './workflow';
import { httpsOrigin, PolicyError } from './policy';

/** Trusted executor adapter. DPAPI is user-bound storage, NOT per-use Windows Hello. */
export class WindowsPasswordStore implements PasswordStore {
  constructor(private readonly vaultPath?: string) {}
  async generateAndPersist(origin: string): Promise<{ reference: string; password: string }> {
    if (process.platform !== 'win32') throw new PolicyError('WINDOWS_REQUIRED');
    const reference = randomUUID();
    const args = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve(import.meta.dir, '../platforms/windows/vault.ps1'), '-Broker'];
    if (this.vaultPath) args.push('-VaultPath', resolve(this.vaultPath));
    const child = Bun.spawn(args, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    child.stdin.write(JSON.stringify({ action: 'persist-generated', origin: httpsOrigin(origin), recordId: reference, length: 28 }));
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 30000);
    try {
      const [text, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (exit !== 0) throw new PolicyError('VAULT_WRITE_FAILED');
      let result: unknown;
      try { result = JSON.parse(text); } catch { throw new PolicyError('VAULT_PROTOCOL_FAILED'); }
      if (!result || typeof result !== 'object' || !('generatedSecret' in result) || typeof result.generatedSecret !== 'string' || result.generatedSecret.length < 20 || !('success' in result) || result.success !== true)
        throw new PolicyError('VAULT_PROTOCOL_FAILED');
      return { reference, password: result.generatedSecret };
    } finally { clearTimeout(timer); }
  }
}
