import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { SYNTHETIC_VAULT_ROOT } from '../src/windows-vault';

await mkdir(SYNTHETIC_VAULT_ROOT, { recursive: true });
const directory = await mkdtemp(join(SYNTHETIC_VAULT_ROOT, 'ci-diagnostic-'));
try {
  console.log({ TEMP: process.env.TEMP, TMP: process.env.TMP, bunTemp: tmpdir(), syntheticRoot: SYNTHETIC_VAULT_ROOT });
  const source = await readFile(new URL('../platforms/windows/vault.ps1', import.meta.url), 'utf8');
  const marker = '    $isAuthError =';
  if (!source.includes(marker)) throw new Error('Diagnostic insertion point unavailable');
  // Throwaway copy, fixed synthetic payload only. Never changes the shipped broker's diagnostics.
  const diagnosticScript = join(directory, 'diagnostic-vault.ps1');
  const aclFailure = '        throw "Failed to enforce restrictive ACL on vault storage. Refusing to operate on insecure storage."';
  const diagnosticSource = source
    .replace(marker, '    [System.Console]::Error.WriteLine($_.Exception.ToString())\n' + marker)
    .replace(aclFailure, '        [System.Console]::Error.WriteLine($_.Exception.ToString())\n' + aclFailure);
  await writeFile(diagnosticScript, diagnosticSource);
  const environment = { ...process.env, TEMP: dirname(SYNTHETIC_VAULT_ROOT), TMP: dirname(SYNTHETIC_VAULT_ROOT) };
  const probe = Bun.spawn(['powershell.exe', '-NoProfile', '-Command', '[pscustomobject]@{NativeTemp=[IO.Path]::GetTempPath();TEMP=$env:TEMP;TMP=$env:TMP}|ConvertTo-Json -Compress'], { env: environment, stdout: 'pipe', stderr: 'pipe' });
  console.log(await new Response(probe.stdout).text());
  console.log(await new Response(probe.stderr).text());
  await probe.exited;
  const child = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', diagnosticScript, '-Broker', '-Synthetic', '-VaultPath', join(directory, 'vault.json')], {
    env: environment, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  child.stdin.write(JSON.stringify({ action: 'store-secret', origin: 'https://diagnostic.example.test', recordId: 'synthetic-fixture', secret: 'synthetic-fixture-value' }));
  child.stdin.end();
  console.log(await new Response(child.stdout).text());
  console.log(await new Response(child.stderr).text());
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error('Isolated native diagnostic refused its fixed synthetic fixture');
} finally {
  await rm(directory, { recursive: true, force: true });
}
