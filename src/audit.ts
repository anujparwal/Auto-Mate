import { openSync, writeSync, fsyncSync, closeSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { type Audit, PolicyError } from './policy';

export type AuditEvent =
  | 'approved'
  | 'approval_denied'
  | 'grant_expired'
  | 'fill_authorized'
  | 'submit_authorized'
  | 'denied'
  | 'completed'
  | 'takeover'
  | 'revoked'
  | 'stopped_all';

export type PolicyReason =
  | 'INVALID_ORIGIN'
  | 'INVALID_GRANT'
  | 'GRANT_EXPIRED'
  | 'DESTINATION_DENIED'
  | 'TASK_NOT_ACTIVE'
  | 'OPERATION_DENIED'
  | 'CREDENTIAL_DENIED'
  | 'CATEGORY_DENIED'
  | 'SUBMISSION_LIMIT'
  | 'DENIED'
  | 'DESTINATION_BLOCKED'
  | 'TASK_ALREADY_EXISTS'
  | 'INVALID_TASK'
  | 'AUDIT_UNAVAILABLE';

const ALLOWED_EVENTS: Readonly<Record<AuditEvent, true>> = {
  approved: true, approval_denied: true, fill_authorized: true, submit_authorized: true,
  denied: true, completed: true, takeover: true, revoked: true, stopped_all: true,
  grant_expired: true,
};
const ALLOWED_REASONS: Readonly<Record<PolicyReason, true>> = {
  INVALID_ORIGIN: true, INVALID_GRANT: true, GRANT_EXPIRED: true, DESTINATION_DENIED: true,
  TASK_NOT_ACTIVE: true, OPERATION_DENIED: true, CREDENTIAL_DENIED: true, CATEGORY_DENIED: true,
  SUBMISSION_LIMIT: true, DENIED: true, DESTINATION_BLOCKED: true, TASK_ALREADY_EXISTS: true,
  INVALID_TASK: true, AUDIT_UNAVAILABLE: true,
};

export function isAuditEvent(value: unknown): value is AuditEvent {
  return typeof value === 'string' && Object.hasOwn(ALLOWED_EVENTS, value);
}

export function isPolicyReason(value: unknown): value is PolicyReason {
  return typeof value === 'string' && Object.hasOwn(ALLOWED_REASONS, value);
}

export type JournalRow = Readonly<{
  version: 1;
  session: string;
  sequence: number;
  at: string;
  task: string | null;
  event: AuditEvent;
  reason?: PolicyReason;
}>;

export class LocalAuditJournal {
  readonly path: string;
  #fd: number | null = null;
  #session = randomUUID();
  #sequence = 0;
  #taskMap = new Map<string, string>();
  #closed = false;
  #faulted = false;

  constructor(directory: string) {
    if (!directory || typeof directory !== 'string') {
      throw new PolicyError('AUDIT_UNAVAILABLE');
    }
    let fd: number | null = null;
    try {
      mkdirSync(directory, { recursive: true });
      const filename = `${randomUUID()}.jsonl`;
      this.path = join(directory, filename);
      fd = openSync(this.path, 'wx', 0o600);
      this.#fd = fd;
    } catch {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
      this.#fd = null;
      throw new PolicyError('AUDIT_UNAVAILABLE');
    }
  }

  append = (event: Audit): void => {
    if (this.#closed || this.#faulted || this.#fd === null) {
      throw new PolicyError('AUDIT_UNAVAILABLE');
    }
    if (!event || typeof event !== 'object') {
      this.#fault();
      throw new PolicyError('AUDIT_UNAVAILABLE');
    }
    if (!isAuditEvent(event.event)) {
      this.#fault();
      throw new PolicyError('AUDIT_UNAVAILABLE');
    }
    if (event.reason !== undefined && !isPolicyReason(event.reason)) {
      this.#fault();
      throw new PolicyError('AUDIT_UNAVAILABLE');
    }
    if (typeof event.task !== 'string') {
      this.#fault();
      throw new PolicyError('AUDIT_UNAVAILABLE');
    }

    let taskUuid: string | null = null;
    if (event.task.length > 0) {
      let mapped = this.#taskMap.get(event.task);
      if (!mapped) {
        mapped = randomUUID();
        this.#taskMap.set(event.task, mapped);
      }
      taskUuid = mapped;
    }

    const row: JournalRow = {
      version: 1,
      session: this.#session,
      sequence: ++this.#sequence,
      at: new Date().toISOString(),
      task: taskUuid,
      event: event.event,
      ...(event.reason !== undefined ? { reason: event.reason } : {}),
    };

    try {
      const line = JSON.stringify(row) + '\n';
      this.#writeSyncFull(Buffer.from(line, 'utf-8'));
    } catch {
      this.#fault();
      throw new PolicyError('AUDIT_UNAVAILABLE');
    }
    return undefined;
  };

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#fd !== null) {
      const fd = this.#fd;
      this.#fd = null;
      try {
        closeSync(fd);
      } catch {
        this.#faulted = true;
        throw new PolicyError('AUDIT_UNAVAILABLE');
      }
    }
  }

  #writeSyncFull(buffer: Buffer): void {
    if (this.#fd === null) throw new Error('FD_CLOSED');
    let offset = 0;
    while (offset < buffer.byteLength) {
      const written = writeSync(this.#fd, buffer, offset, buffer.byteLength - offset);
      if (written <= 0) throw new Error('WRITE_FAILED');
      offset += written;
    }
    fsyncSync(this.#fd);
  }

  #fault(): void {
    this.#faulted = true;
    if (this.#fd !== null) {
      const fd = this.#fd;
      this.#fd = null;
      try {
        closeSync(fd);
      } catch {
        // closing must not leak original OS messages
      }
    }
  }
}
