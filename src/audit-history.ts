import { open, lstat, opendir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import { join } from 'node:path';
import {
  type JournalRow,
  type PolicyReason,
  isAuditEvent,
  isPolicyReason,
} from './audit';

export type HistoryErrorCode =
  | 'INVALID_HISTORY_REQUEST'
  | 'HISTORY_INVALID'
  | 'HISTORY_TOO_LARGE'
  | 'HISTORY_LIMIT'
  | 'HISTORY_UNAVAILABLE';

export class HistoryError extends Error {
  readonly code: HistoryErrorCode;

  constructor(code: HistoryErrorCode) {
    super(code);
    this.name = 'HistoryError';
    this.code = code;
  }
}

export type SessionSummary = Readonly<{
  id: string;
  modifiedAt: string;
  sizeBytes: number;
}>;

export type SessionsPage = Readonly<{
  sessions: readonly SessionSummary[];
  offset: number;
  total: number;
  nextOffset: number | null;
}>;

export type EventsPage = Readonly<{
  id: string;
  session: string | null;
  events: readonly JournalRow[];
  offset: number;
  total: number;
  nextOffset: number | null;
  truncated: boolean;
}>;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

const MAX_DIR_ENTRIES = 4096;
const MAX_FILE_SIZE = 1024 * 1024; // 1 MiB
const MAX_COMPLETE_ROWS = 4096;
const SESSIONS_PAGE_SIZE = 20;
const EVENTS_PAGE_SIZE = 50;

export class LocalAuditHistory {
  readonly directory: string;

  constructor(directory: string) {
    if (!directory || typeof directory !== 'string') {
      throw new HistoryError('INVALID_HISTORY_REQUEST');
    }
    this.directory = directory;
  }

  async sessions(offset = 0): Promise<SessionsPage> {
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
      throw new HistoryError('INVALID_HISTORY_REQUEST');
    }

    let dir: Dir | null = null;
    try {
      dir = await opendir(this.directory);
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
        if (offset !== 0) {
          throw new HistoryError('INVALID_HISTORY_REQUEST');
        }
        return Object.freeze({
          sessions: Object.freeze([]),
          offset: 0,
          total: 0,
          nextOffset: null,
        });
      }
      throw new HistoryError('HISTORY_UNAVAILABLE');
    }

    const sessionList: Array<{ id: string; modifiedAt: string; sizeBytes: number; mtimeMs: number }> = [];
    let entryCount = 0;

    try {
      for await (const dirent of dir) {
        entryCount++;
        if (entryCount > MAX_DIR_ENTRIES) {
          throw new HistoryError('HISTORY_LIMIT');
        }

        // Canonical uuid.jsonl regular files only, symbolic links/directories ignored in listing
        if (dirent.isSymbolicLink() || !dirent.isFile()) {
          continue;
        }

        const name = dirent.name;
        if (!name.endsWith('.jsonl')) {
          continue;
        }

        const id = name.slice(0, -6);
        if (!isValidUuid(id)) {
          continue;
        }

        const filePath = join(this.directory, name);
        try {
          const st = await lstat(filePath);
          if (st.isSymbolicLink() || !st.isFile()) {
            continue;
          }
          sessionList.push({
            id,
            modifiedAt: st.mtime.toISOString(),
            sizeBytes: st.size,
            mtimeMs: st.mtimeMs,
          });
        } catch (err: unknown) {
          if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
            continue;
          }
          throw new HistoryError('HISTORY_UNAVAILABLE');
        }
      }
    } catch (error) {
      if (error instanceof HistoryError) throw error;
      throw new HistoryError('HISTORY_UNAVAILABLE');
    } finally {
      await dir.close().catch(() => {});
    }

    // Newest mtime first with deterministic id tie-break
    sessionList.sort((a, b) => {
      const diff = b.mtimeMs - a.mtimeMs;
      if (diff !== 0) return diff;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });

    const total = sessionList.length;
    if (offset > total) {
      throw new HistoryError('INVALID_HISTORY_REQUEST');
    }

    const page = sessionList.slice(offset, offset + SESSIONS_PAGE_SIZE).map(s => Object.freeze({
      id: s.id,
      modifiedAt: s.modifiedAt,
      sizeBytes: s.sizeBytes,
    }));

    const nextOffset = offset + page.length < total ? offset + page.length : null;

    return Object.freeze({
      sessions: Object.freeze(page),
      offset,
      total,
      nextOffset,
    });
  }

  async events(id: string, offset = 0): Promise<EventsPage> {
    if (typeof id !== 'string' || !isValidUuid(id)) {
      throw new HistoryError('INVALID_HISTORY_REQUEST');
    }

    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
      throw new HistoryError('INVALID_HISTORY_REQUEST');
    }

    const filePath = join(this.directory, `${id}.jsonl`);

    let st;
    try {
      st = await lstat(filePath);
    } catch {
      throw new HistoryError('HISTORY_UNAVAILABLE');
    }

    // Symbolic links and directories refused in events
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new HistoryError('HISTORY_INVALID');
    }

    let handle: FileHandle | null = null;
    try {
      try {
        handle = await open(filePath, 'r');
      } catch {
        throw new HistoryError('HISTORY_UNAVAILABLE');
      }

      const fdStat = await handle.stat();
      if (!fdStat.isFile()) {
        throw new HistoryError('HISTORY_INVALID');
      }

      const snapshotSize = fdStat.size;
      if (snapshotSize > MAX_FILE_SIZE) {
        throw new HistoryError('HISTORY_TOO_LARGE');
      }

      if (snapshotSize === 0) {
        if (offset > 0) {
          throw new HistoryError('INVALID_HISTORY_REQUEST');
        }
        return Object.freeze({
          id,
          session: null,
          events: Object.freeze([]),
          offset: 0,
          total: 0,
          nextOffset: null,
          truncated: false,
        });
      }

      const buffer = Buffer.allocUnsafe(snapshotSize);
      let bytesRead = 0;
      while (bytesRead < snapshotSize) {
        const { bytesRead: chunk } = await handle.read(buffer, bytesRead, snapshotSize - bytesRead, bytesRead);
        if (chunk === 0) {
          break;
        }
        bytesRead += chunk;
      }

      if (bytesRead < snapshotSize) {
        // Reject shrunken snapshot
        throw new HistoryError('HISTORY_UNAVAILABLE');
      }

      const endsWithNewline = buffer[snapshotSize - 1] === 0x0A;
      let completePrefix: Buffer;
      let truncated: boolean;

      if (endsWithNewline) {
        truncated = false;
        completePrefix = buffer;
      } else {
        truncated = true;
        const lastNewlineIndex = buffer.lastIndexOf(0x0A);
        completePrefix = buffer.subarray(0, lastNewlineIndex + 1);
      }

      let allRows: JournalRow[] = [];
      let expectedSession: string | null = null;

      if (completePrefix.length > 0) {
        let text: string;
        try {
          const decoder = new TextDecoder('utf-8', { fatal: true });
          text = decoder.decode(completePrefix);
        } catch {
          throw new HistoryError('HISTORY_INVALID');
        }

        const lines = text.split('\n');
        lines.pop(); // The committed prefix ends with a newline.

        if (lines.length > MAX_COMPLETE_ROWS) {
          throw new HistoryError('HISTORY_TOO_LARGE');
        }

        allRows = new Array(lines.length);

        for (let i = 0; i < lines.length; i++) {
          const rawLine = lines[i]!;
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
          if (!line) {
            throw new HistoryError('HISTORY_INVALID');
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            throw new HistoryError('HISTORY_INVALID');
          }

          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new HistoryError('HISTORY_INVALID');
          }

          const rowObj = parsed as Record<string, unknown>;
          const keys = Object.keys(rowObj);
          const hasReason = Object.hasOwn(rowObj, 'reason');

          if (hasReason) {
            if (keys.length !== 7) throw new HistoryError('HISTORY_INVALID');
          } else {
            if (keys.length !== 6) throw new HistoryError('HISTORY_INVALID');
          }

          if (
            !Object.hasOwn(rowObj, 'version') ||
            !Object.hasOwn(rowObj, 'session') ||
            !Object.hasOwn(rowObj, 'sequence') ||
            !Object.hasOwn(rowObj, 'at') ||
            !Object.hasOwn(rowObj, 'task') ||
            !Object.hasOwn(rowObj, 'event')
          ) {
            throw new HistoryError('HISTORY_INVALID');
          }

          if (rowObj.version !== 1) {
            throw new HistoryError('HISTORY_INVALID');
          }

          if (typeof rowObj.session !== 'string' || !isValidUuid(rowObj.session)) {
            throw new HistoryError('HISTORY_INVALID');
          }

          if (expectedSession === null) {
            expectedSession = rowObj.session;
          } else if (rowObj.session !== expectedSession) {
            throw new HistoryError('HISTORY_INVALID');
          }

          if (
            typeof rowObj.sequence !== 'number' ||
            !Number.isSafeInteger(rowObj.sequence) ||
            rowObj.sequence !== i + 1
          ) {
            throw new HistoryError('HISTORY_INVALID');
          }

          if (
            typeof rowObj.at !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(rowObj.at) ||
            Number.isNaN(Date.parse(rowObj.at)) ||
            new Date(rowObj.at).toISOString() !== rowObj.at
          ) {
            throw new HistoryError('HISTORY_INVALID');
          }

          if (
            rowObj.task !== null &&
            (typeof rowObj.task !== 'string' || !isValidUuid(rowObj.task))
          ) {
            throw new HistoryError('HISTORY_INVALID');
          }

          if (!isAuditEvent(rowObj.event)) {
            throw new HistoryError('HISTORY_INVALID');
          }

          let reason: PolicyReason | undefined;
          if (hasReason) {
            if (!isPolicyReason(rowObj.reason)) {
              throw new HistoryError('HISTORY_INVALID');
            }
            reason = rowObj.reason;
          }

          // Privacy projection: project only strictly validated fields
          const projectedRow: JournalRow = {
            version: 1,
            session: rowObj.session,
            sequence: rowObj.sequence,
            at: rowObj.at,
            task: rowObj.task,
            event: rowObj.event,
            ...(reason !== undefined ? { reason } : {}),
          };

          allRows[i] = Object.freeze(projectedRow);
        }
      }

      const total = allRows.length;
      if (offset > total) {
        throw new HistoryError('INVALID_HISTORY_REQUEST');
      }

      const page = allRows.slice(offset, offset + EVENTS_PAGE_SIZE);
      const nextOffset = offset + page.length < total ? offset + page.length : null;

      return Object.freeze({
        id,
        session: expectedSession,
        events: Object.freeze(page),
        offset,
        total,
        nextOffset,
        truncated,
      });
    } catch (error) {
      if (error instanceof HistoryError) throw error;
      throw new HistoryError('HISTORY_UNAVAILABLE');
    } finally {
      if (handle !== null) {
        await handle.close().catch(() => {});
      }
    }
  }
}
