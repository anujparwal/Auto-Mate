import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentNote, WorkspaceStore, WorkspaceStoredData } from './agent-types';
import { validateWorkspaceSettings } from './agent-settings';
import { PolicyError } from './policy';

export const SYNTHETIC_WORKSPACE_ROOT = resolve(tmpdir(), 'AutoMate-Synthetic');
export const MAX_NOTES = 500;
export const MAX_NOTE_CONTENT_BYTES = 64 * 1024; // 64 KiB
const MAX_STDOUT_BYTES = 2 * 1024 * 1024; // 2 MiB
const MAX_STDERR_BYTES = 64 * 1024; // 64 KiB
const TIMEOUT_MS = 90_000; // 90s

export interface WindowsWorkspaceStoreOptions {
  directory?: string;
  assertActive?: () => void;
  synthetic?: boolean;
  requireAuth?: boolean;
}

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

export function validateNotes(notes: unknown): AgentNote[] {
  if (notes === undefined || notes === null) {
    return [];
  }
  if (!Array.isArray(notes)) {
    throw new PolicyError('INVALID_NOTES');
  }
  if (notes.length > MAX_NOTES) {
    throw new PolicyError('NOTES_LIMIT_EXCEEDED');
  }

  const validated: AgentNote[] = [];
  for (const n of notes) {
    if (!n || typeof n !== 'object') {
      throw new PolicyError('INVALID_NOTE');
    }
    const raw = n as Record<string, unknown>;
    if (typeof raw.id !== 'string' || !raw.id.trim()) {
      throw new PolicyError('INVALID_NOTE_ID');
    }
    if (typeof raw.topic !== 'string' || raw.topic.length > 256) {
      throw new PolicyError('INVALID_NOTE_TOPIC');
    }
    if (typeof raw.content !== 'string' || Buffer.byteLength(raw.content, 'utf-8') > MAX_NOTE_CONTENT_BYTES) {
      throw new PolicyError('INVALID_NOTE_CONTENT');
    }
    if (typeof raw.timestamp !== 'number' || !Number.isFinite(raw.timestamp)) {
      throw new PolicyError('INVALID_NOTE_TIMESTAMP');
    }
    if (typeof raw.sourceUrl !== 'string' || raw.sourceUrl.length > 2048) {
      throw new PolicyError('INVALID_NOTE_SOURCE_URL');
    }
    validated.push({
      id: raw.id.trim(),
      topic: raw.topic,
      content: raw.content,
      timestamp: raw.timestamp,
      sourceUrl: raw.sourceUrl,
      ...(typeof raw.agent === 'string' ? { agent: raw.agent } : {}),
    });
  }
  return validated;
}

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
          try {
            await reader.cancel();
          } catch {}
          throw new PolicyError('WORKSPACE_PROTOCOL_FAILED');
        }
        if (keep) chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return keep ? new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) : '';
}

interface BrokerResponse {
  success: boolean;
  action?: string;
  missing?: boolean;
  data?: unknown;
  error?: string;
}

async function invokeWorkspaceBroker(
  payload: Record<string, unknown>,
  options: WindowsWorkspaceStoreOptions
): Promise<BrokerResponse> {
  if (process.platform !== 'win32') {
    throw new PolicyError('WINDOWS_REQUIRED');
  }

  const scriptPath = resolve(import.meta.dir, '../platforms/windows/workspace.ps1');
  const args = [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-Broker',
  ];

  if (options.directory) {
    args.push('-WorkspacePath', resolve(options.directory));
  }
  if (options.synthetic) {
    args.push('-Synthetic');
  }

  const tempBase = options.synthetic ? dirname(SYNTHETIC_WORKSPACE_ROOT) : undefined;
  const env = tempBase ? { ...process.env, TEMP: tempBase, TMP: tempBase } : undefined;

  const child = Bun.spawn(args, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env });
  try {
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  } catch {
    // Child stdin write failed; proceed to collect exit/stderr
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill();
    } catch {}
  }, TIMEOUT_MS);

  let stdoutText = '';
  let stderrText = '';
  try {
    stdoutText = await readBounded(child.stdout, MAX_STDOUT_BYTES, true);
    stderrText = await readBounded(child.stderr, MAX_STDERR_BYTES, true);
  } finally {
    clearTimeout(timer);
  }

  await child.exited;
  if (timedOut) {
    throw new PolicyError('WORKSPACE_TIMEOUT');
  }

  let result: BrokerResponse;
  try {
    result = JSON.parse(stdoutText.trim()) as BrokerResponse;
  } catch {
    if (stderrText.includes('WORKSPACE_CORRUPTED') || stdoutText.includes('WORKSPACE_CORRUPTED')) {
      throw new PolicyError('WORKSPACE_CORRUPTED');
    }
    throw new PolicyError('WORKSPACE_PROTOCOL_FAILED');
  }

  if (!result.success) {
    if (result.error === 'WORKSPACE_CORRUPTED' || String(result.error).includes('WORKSPACE_CORRUPTED')) {
      throw new PolicyError('WORKSPACE_CORRUPTED');
    }
    if (
      result.error === 'WORKSPACE_AUTHENTICATION_REQUIRED' ||
      String(result.error).includes('WORKSPACE_AUTHENTICATION_REQUIRED')
    ) {
      throw new PolicyError('WORKSPACE_AUTHENTICATION_REQUIRED');
    }
    throw new PolicyError('WORKSPACE_OPERATION_FAILED');
  }

  return result;
}

export function openWindowsWorkspaceStore(options: WindowsWorkspaceStoreOptions = {}): WorkspaceStore {
  const mutex = new AsyncMutex();

  return {
    async load(): Promise<WorkspaceStoredData | null> {
      options.assertActive?.();
      return await mutex.runExclusive(async () => {
        options.assertActive?.();
        const res = await invokeWorkspaceBroker(
          { action: 'load', requireAuth: options.requireAuth ?? false },
          options
        );
        options.assertActive?.();
        if (res.missing) {
          return null;
        }

        const rawData = res.data;
        if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData) || !('settings' in rawData) || !('notes' in rawData)) {
          throw new PolicyError('WORKSPACE_CORRUPTED');
        }

        const settings = validateWorkspaceSettings(rawData.settings, undefined, false);
        const notes = validateNotes(rawData.notes);
        return { settings, notes };
      });
    },

    async save(data: WorkspaceStoredData): Promise<void> {
      options.assertActive?.();
      if (!data || typeof data !== 'object') {
        throw new PolicyError('INVALID_WORKSPACE_DATA');
      }

      const settings = validateWorkspaceSettings(data.settings, undefined, false);
      const notes = validateNotes(data.notes);

      await mutex.runExclusive(async () => {
        options.assertActive?.();
        await invokeWorkspaceBroker(
          { action: 'save', data: { settings, notes } },
          options
        );
        options.assertActive?.();
      });
    },
  };
}
