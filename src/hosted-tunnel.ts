import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, open, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Pinned official Cloudflare cloudflared release metadata.
 * Observed GitHub official latest release tag 2026.10.7 for Windows x64.
 */
export const CLOUDFLARED_WINDOWS_AMD64 = {
  version: '2026.10.7',
  assetName: 'cloudflared-windows-amd64.exe',
  url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.7/cloudflared-windows-amd64.exe',
  size: 55390512,
  sha256: '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343',
} as const;

export const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;

const ANSI_REGEX = /\u001b\[[0-9;]*[a-zA-Z]/g;
const TRYCLOUDFLARE_REGEX = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/i;

export interface HostedTunnelOptions {
  readonly localPort: number;
  readonly cacheDirectory?: string;
  readonly startupTimeoutMs?: number;
}

export interface HostedTunnelInstance {
  readonly origin: string;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

/**
 * Returns the default cache directory for Auto-Mate tools on the current platform.
 * Windows: %LOCALAPPDATA%/AutoMate/tools
 */
export function getDefaultCacheDirectory(): string {
  if (process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'AutoMate', 'tools');
  }
  return join(homedir(), '.local', 'share', 'AutoMate', 'tools');
}

/**
 * Verifies that the specified executable matches the expected file size
 * and cryptographic SHA-256 fingerprint.
 */
export async function verifyExecutableFingerprint(exePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(exePath);
    if (fileStat.size !== CLOUDFLARED_WINDOWS_AMD64.size) {
      return false;
    }

    const fileHandle = await open(exePath, 'r');
    try {
      const hash = createHash('sha256');
      const buf = Buffer.alloc(128 * 1024);
      while (true) {
        const { bytesRead } = await fileHandle.read(buf, 0, buf.length, null);
        if (bytesRead === 0) break;
        hash.update(buf.subarray(0, bytesRead));
      }
      const digest = hash.digest('hex').toLowerCase();
      return digest === CLOUDFLARED_WINDOWS_AMD64.sha256.toLowerCase();
    } finally {
      await fileHandle.close();
    }
  } catch {
    return false;
  }
}

/**
 * Ensures the pinned official cloudflared binary is available and verified.
 * If missing, downloads it with bounded size checks and SHA-256 verification.
 * Cleans up temporary partial files on any failure.
 */
export async function ensureCloudflaredExecutable(options?: { cacheDirectory?: string }): Promise<string> {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error(
      `UNSUPPORTED_PLATFORM: Hosted tunnel currently supports Windows x64 only (detected platform=${process.platform}, arch=${process.arch}).`
    );
  }

  const cacheDir = options?.cacheDirectory ? resolve(options.cacheDirectory) : getDefaultCacheDirectory();
  const targetExe = join(cacheDir, 'cloudflared.exe');

  // 1. Check if executable already exists in target cache directory
  if (await verifyExecutableFingerprint(targetExe)) {
    return targetExe;
  }

  // If a corrupted file exists, remove it
  try {
    const s = await stat(targetExe);
    if (s.size > 0) {
      await unlink(targetExe).catch(() => {});
    }
  } catch {}

  await mkdir(cacheDir, { recursive: true });

  // 2. Check repo-local cache fallback (.local/cloudflared/cloudflared.exe) if target was default cache
  if (!options?.cacheDirectory) {
    const repoLocalExe = join(process.cwd(), '.local', 'cloudflared', 'cloudflared.exe');
    if (await verifyExecutableFingerprint(repoLocalExe)) {
      const tmpCopy = join(cacheDir, `cloudflared.exe.tmp.${Date.now()}.${randomBytes(4).toString('hex')}`);
      try {
        await copyFile(repoLocalExe, tmpCopy);
        if (await verifyExecutableFingerprint(tmpCopy)) {
          await rename(tmpCopy, targetExe);
          return targetExe;
        }
      } catch {
        // Fall back to download if copy fails
      } finally {
        await unlink(tmpCopy).catch(() => {});
      }
    }
  }

  // 3. Download official binary with exact size bound and SHA-256 check
  const tempDownload = join(
    cacheDir,
    `cloudflared.exe.download.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`
  );

  try {
    const response = await fetch(CLOUDFLARED_WINDOWS_AMD64.url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Auto-Mate-Hosted-Tunnel',
      },
    });

    if (!response.ok) {
      throw new Error(
        `DOWNLOAD_FAILED: HTTP status ${response.status} ${response.statusText} from ${CLOUDFLARED_WINDOWS_AMD64.url}`
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('DOWNLOAD_FAILED: Response body stream is unavailable.');
    }

    const fileHandle = await open(tempDownload, 'w', 0o700);
    const hash = createHash('sha256');
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          totalBytes += value.byteLength;
          if (totalBytes > CLOUDFLARED_WINDOWS_AMD64.size) {
            throw new Error(
              `DOWNLOAD_SIZE_EXCEEDED: Download exceeded pinned asset size ${CLOUDFLARED_WINDOWS_AMD64.size} bytes.`
            );
          }
          hash.update(value);
          await fileHandle.write(value, 0, value.byteLength);
        }
      }
    } finally {
      await fileHandle.close();
    }

    if (totalBytes !== CLOUDFLARED_WINDOWS_AMD64.size) {
      throw new Error(
        `DOWNLOAD_SIZE_MISMATCH: Downloaded ${totalBytes} bytes, expected exact ${CLOUDFLARED_WINDOWS_AMD64.size} bytes.`
      );
    }

    const computedHash = hash.digest('hex').toLowerCase();
    if (computedHash !== CLOUDFLARED_WINDOWS_AMD64.sha256.toLowerCase()) {
      throw new Error(
        `DOWNLOAD_INTEGRITY_MISMATCH: Computed SHA-256 ${computedHash} did not match pinned ${CLOUDFLARED_WINDOWS_AMD64.sha256}.`
      );
    }

    // Atomically move verified binary into place
    await rename(tempDownload, targetExe);
    return targetExe;
  } catch (err) {
    await unlink(tempDownload).catch(() => {});
    throw err;
  }
}

/**
 * Opens a Cloudflare QuickTunnel exposing the local port via an HTTPS trycloudflare.com URL.
 * Automatically verifies executable fingerprint before execution.
 * Isolates configuration to prevent touching or reading ~/.cloudflared.
 */
export async function openHostedTunnel(options: HostedTunnelOptions): Promise<HostedTunnelInstance> {
  if (!options || typeof options !== 'object') {
    throw new Error('INVALID_OPTIONS: Options object is required.');
  }

  const localPort = Number(options.localPort);
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw new Error(`INVALID_LOCAL_PORT: Invalid local port ${options.localPort}. Port must be 1-65535.`);
  }

  const timeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

  // 1. Resolve and verify binary fingerprint before execution
  const exePath = await ensureCloudflaredExecutable({ cacheDirectory: options.cacheDirectory });
  const verified = await verifyExecutableFingerprint(exePath);
  if (!verified) {
    throw new Error('EXECUTABLE_INTEGRITY_FAILED: cloudflared binary fingerprint check failed before execution.');
  }

  // 2. Write an isolated owned configuration file to avoid touching user ~/.cloudflared
  const cacheDir = options.cacheDirectory ? resolve(options.cacheDirectory) : getDefaultCacheDirectory();
  await mkdir(cacheDir, { recursive: true });
  const isolatedConfigPath = join(
    cacheDir,
    `automate-tunnel-config.${Date.now()}.${randomBytes(4).toString('hex')}.yml`
  );
  await writeFile(
    isolatedConfigPath,
    '# Auto-Mate isolated tunnel configuration\nwarp-routing:\n  enabled: false\n',
    { encoding: 'utf8', mode: 0o600 }
  );

  const cleanupConfigFile = async () => {
    await unlink(isolatedConfigPath).catch(() => {});
  };

  // 3. Spawn child cloudflared QuickTunnel
  const args = [
    'tunnel',
    '--config',
    isolatedConfigPath,
    '--url',
    `http://127.0.0.1:${localPort}`,
    '--no-autoupdate',
    '--protocol',
    'http2',
  ];

  // Strip cloudflare credentials/tokens from environment to ensure isolated ephemeral tunnel
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.TUNNEL_TOKEN;
  delete childEnv.TUNNEL_ORIGIN_CERT;
  delete childEnv.TUNNEL_CRED_FILE;

  let child: ChildProcess;
  try {
    child = spawn(exePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: childEnv,
    });
  } catch (err) {
    await cleanupConfigFile();
    throw err;
  }

  let isStarted = false;
  let isClosing = false;
  let originFound: string | null = null;

  const MAX_LOG_LINES = 60;
  const boundedLogs: string[] = [];

  function recordLog(rawLine: string) {
    const clean = rawLine.replace(ANSI_REGEX, '').trim();
    if (!clean) return;
    if (boundedLogs.length >= MAX_LOG_LINES) {
      boundedLogs.shift();
    }
    boundedLogs.push(clean);
  }

  const { promise: closedPromise, resolve: closedResolve } = Promise.withResolvers<void>();
  const { promise: startupPromise, resolve: startupResolve, reject: startupReject } = Promise.withResolvers<string>();

  const startupTimer = setTimeout(() => {
    if (!isStarted) {
      cleanupChild();
      startupReject(
        new Error(
          `TUNNEL_STARTUP_TIMEOUT: Cloudflare QuickTunnel did not report an HTTPS origin within ${timeoutMs}ms. Logs:\n${boundedLogs.join('\n')}`
        )
      );
    }
  }, timeoutMs);

  function processChunk(chunk: Buffer) {
    const text = chunk.toString('utf8');
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      recordLog(line);
      if (!isStarted) {
        const match = line.match(TRYCLOUDFLARE_REGEX);
        if (match) {
          try {
            const parsed = new URL(match[0]);
            if (parsed.protocol === 'https:' && parsed.hostname.endsWith('.trycloudflare.com')) {
              originFound = parsed.origin;
              isStarted = true;
              clearTimeout(startupTimer);
              startupResolve(originFound);
            }
          } catch {
            // Ignore malformed URL matches
          }
        }
      }
    }
  }

  child.stdout?.on('data', processChunk);
  child.stderr?.on('data', processChunk);

  child.once('error', (err) => {
    if (!isStarted) {
      clearTimeout(startupTimer);
      startupReject(err);
    }
  });

  child.once('exit', (code, signal) => {
    clearTimeout(startupTimer);
    cleanupConfigFile().catch(() => {});

    if (!isStarted) {
      startupReject(
        new Error(
          `TUNNEL_PROCESS_EXIT_BEFORE_START: cloudflared exited prematurely (code=${code}, signal=${signal}). Logs:\n${boundedLogs.join('\n')}`
        )
      );
    }

    closedResolve();
  });

  function cleanupChild() {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        try {
          child.kill();
        } catch {}
      }
    }
  }

  let finalOrigin: string;
  try {
    finalOrigin = await startupPromise;
  } catch (err) {
    cleanupChild();
    await cleanupConfigFile();
    throw err;
  }

  return {
    origin: finalOrigin,
    closed: closedPromise,
    async close(): Promise<void> {
      if (isClosing) return closedPromise;
      isClosing = true;
      clearTimeout(startupTimer);

      cleanupChild();

      // Ensure force-kill fallback if process does not exit in 5 seconds
      const forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {
            try {
              child.kill();
            } catch {}
          }
        }
      }, 5000);
      forceKillTimer.unref?.();

      await closedPromise;
      await cleanupConfigFile();
    },
  };
}
