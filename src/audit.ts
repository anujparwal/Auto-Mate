import { openSync, writeSync, fsyncSync, closeSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { type Audit, PolicyError } from './policy';

const ALLOWED_EVENTS: Readonly<Record<string, true>> = {
  approved: true, approval_denied: true, fill_authorized: true, submit_authorized: true,
  denied: true, completed: true, takeover: true, revoked: true, stopped_all: true,
};
const ALLOWED_REASONS: Readonly<Record<string, true>> = {
  INVALID_ORIGIN: true, INVALID_GRANT: true, GRANT_EXPIRED: true, DESTINATION_DENIED: true,
  TASK_NOT_ACTIVE: true, OPERATION_DENIED: true, CREDENTIAL_DENIED: true, CATEGORY_DENIED: true,
  SUBMISSION_LIMIT: true, DENIED: true, DESTINATION_BLOCKED: true, TASK_ALREADY_EXISTS: true,
  INVALID_TASK: true, AUDIT_UNAVAILABLE: true,
};

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
    if (typeof event.event !== 'string' || !Object.hasOwn(ALLOWED_EVENTS, event.event)) {
      this.#fault();
      throw new PolicyError('AUDIT_UNAVAILABLE');
    }
    if (event.reason !== undefined && (typeof event.reason !== 'string' || !Object.hasOwn(ALLOWED_REASONS, event.reason))) {
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

    const row: {
      version: 1;
      session: string;
      sequence: number;
      at: string;
      task: string | null;
      event: string;
      reason?: string;
    } = {
      version: 1,
      session: this.#session,
      sequence: ++this.#sequence,
      at: new Date().toISOString(),
      task: taskUuid,
      event: event.event,
    };
    if (event.reason !== undefined) {
      row.reason = event.reason;
    }

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
