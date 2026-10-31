import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PolicyBroker, type Layer } from '../src/policy';
import { LocalAuditJournal } from '../src/audit';

const defaultCatalog: Record<string, Layer> = {
  'registration-email': 'yellow',
  'registration-password': 'red',
};

const makeRequest = (task = 'signup') => ({
  task,
  origin: 'https://accounts.example.test',
  credentials: ['registration-email', 'registration-password'],
  layers: ['yellow', 'red'] as Layer[],
  operations: ['fill', 'submit'] as const,
  durationSeconds: 60,
  maxSubmissions: 1,
});

describe('LocalAuditJournal and PolicyBroker durable audit', () => {
  test('persists privacy-safe serialized audit events with opaque task correlation across events', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'audit-privacy-'));
    try {
      const journal = new LocalAuditJournal(tempDir);
      const broker = new PolicyBroker(defaultCatalog, journal.append);

      const grant = broker.approve(makeRequest('task-privacy'));
      broker.authorize(grant, 'task-privacy', 'https://accounts.example.test', 'fill', 'registration-email');
      broker.authorize(grant, 'task-privacy', 'https://accounts.example.test', 'submit');
      broker.finish('task-privacy', 'completed');
      const extraInput = {
        sequence: 999, task: 'task-privacy', origin: 'https://accounts.example.test',
        event: 'denied', reason: 'CREDENTIAL_DENIED', password: 'private-value-must-not-persist',
      };
      journal.append(extraInput);
      journal.close();

      const raw = readFileSync(journal.path, 'utf-8');
      const lines = raw.trim().split('\n').map(line => JSON.parse(line));

      expect(lines.length).toBe(5);
      expect(lines[0].sequence).toBe(1);
      expect(lines[1].sequence).toBe(2);
      expect(lines[2].sequence).toBe(3);
      expect(lines[3].sequence).toBe(4);
      expect(lines[4].sequence).toBe(5);

      const session = lines[0].session;
      const opaqueTask = lines[0].task;
      expect(typeof session).toBe('string');
      expect(typeof opaqueTask).toBe('string');

      for (const row of lines) {
        expect(row.version).toBe(1);
        expect(row.session).toBe(session);
        expect(row.task).toBe(opaqueTask);
        expect(new Date(row.at).toISOString()).toBe(row.at);
      }

      expect(lines[0].event).toBe('approved');
      expect(lines[1].event).toBe('fill_authorized');
      expect(lines[2].event).toBe('submit_authorized');
      expect(lines[3].event).toBe('completed');
      expect(lines[4].event).toBe('denied');
      expect(lines[4].reason).toBe('CREDENTIAL_DENIED');
      expect(Object.keys(lines[4]).sort()).toEqual(['at', 'event', 'reason', 'sequence', 'session', 'task', 'version']);

      // Verify privacy: no raw task identifiers, credentials, origins, or layer names
      expect(raw).not.toContain('task-privacy');
      expect(raw).not.toContain('registration-email');
      expect(raw).not.toContain('registration-password');
      expect(raw).not.toContain('https://accounts.example.test');
      expect(raw).not.toContain('yellow');
      expect(raw).not.toContain('red');
      expect(raw).not.toContain('private-value-must-not-persist');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('isolates separate sessions into independent files with distinct session UUIDs', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'audit-sessions-'));
    try {
      const journal1 = new LocalAuditJournal(tempDir);
      const journal2 = new LocalAuditJournal(tempDir);
      expect(journal1.path).not.toBe(journal2.path);

      const broker1 = new PolicyBroker(defaultCatalog, journal1.append);
      const broker2 = new PolicyBroker(defaultCatalog, journal2.append);

      broker1.approve(makeRequest('same-task'));
      broker2.approve(makeRequest('same-task'));

      journal1.close();
      journal2.close();

      const row1 = JSON.parse(readFileSync(journal1.path, 'utf-8').trim());
      const row2 = JSON.parse(readFileSync(journal2.path, 'utf-8').trim());

      expect(row1.session).not.toBe(row2.session);
      expect(row1.task).not.toBe(row2.task);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('refuses invalid event and reason and faults journal permanently', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'audit-refusal-'));
    try {
      const journal1 = new LocalAuditJournal(tempDir);
      expect(() => {
        journal1.append({ sequence: 1, task: 't', event: 'constructor', origin: 'https://accounts.example.test' });
      }).toThrow('AUDIT_UNAVAILABLE');

      // Subsequent valid event is rejected because journal is faulted
      expect(() => {
        journal1.append({ sequence: 2, task: 't', event: 'approved', origin: 'https://accounts.example.test' });
      }).toThrow('AUDIT_UNAVAILABLE');
      journal1.close();

      const journal2 = new LocalAuditJournal(tempDir);
      expect(() => {
        journal2.append({ sequence: 1, task: 't', event: 'denied', origin: 'https://accounts.example.test', reason: 'toString' });
      }).toThrow('AUDIT_UNAVAILABLE');

      expect(() => {
        journal2.append({ sequence: 2, task: 't', event: 'approved', origin: 'https://accounts.example.test' });
      }).toThrow('AUDIT_UNAVAILABLE');
      journal2.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('append after close is rejected and close is idempotent', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'audit-close-'));
    try {
      const journal = new LocalAuditJournal(tempDir);
      journal.close();
      journal.close(); // Idempotent

      expect(() => {
        journal.append({ sequence: 1, task: 't', event: 'approved', origin: 'https://accounts.example.test' });
      }).toThrow('AUDIT_UNAVAILABLE');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('real closed-journal failure on broker approval fails closed and locks out broker', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'audit-broker-approval-'));
    try {
      const journal = new LocalAuditJournal(tempDir);
      const broker = new PolicyBroker(defaultCatalog, journal.append);

      journal.close();

      expect(() => broker.approve(makeRequest('closed-approve'))).toThrow('AUDIT_UNAVAILABLE');
      expect(broker.canObserve('closed-approve')).toBe(false);
      expect(() => broker.approve(makeRequest('retry-approve'))).toThrow('AUDIT_UNAVAILABLE');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('real closed-journal failure on authorization fails closed and globally revokes other grants', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'audit-broker-auth-'));
    try {
      const journal = new LocalAuditJournal(tempDir);
      const broker = new PolicyBroker(defaultCatalog, journal.append);

      const grant1 = broker.approve(makeRequest('active-task-1'));
      const grant2 = broker.approve(makeRequest('active-task-2'));

      expect(broker.state('active-task-1')).toBe('normal');
      expect(broker.state('active-task-2')).toBe('normal');

      // Close journal to simulate write/fsync failure on credential use
      journal.close();

      expect(() => {
        broker.authorize(grant1, 'active-task-1', 'https://accounts.example.test', 'fill', 'registration-email');
      }).toThrow('AUDIT_UNAVAILABLE');

      expect(broker.state('active-task-1')).toBe('stopped');
      expect(broker.state('active-task-2')).toBe('stopped');
      expect(broker.canObserve('active-task-1')).toBe(false);
      expect(broker.canObserve('active-task-2')).toBe(false);

      expect(() => {
        broker.authorize(grant2, 'active-task-2', 'https://accounts.example.test', 'submit');
      }).toThrow('AUDIT_UNAVAILABLE');

      expect(() => broker.approve(makeRequest('future-task'))).toThrow('AUDIT_UNAVAILABLE');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('real closed-journal failure on submit authorization stops task without decrementing', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'audit-broker-submit-'));
    try {
      const journal = new LocalAuditJournal(tempDir);
      const broker = new PolicyBroker(defaultCatalog, journal.append);

      const grant = broker.approve(makeRequest('submit-task'));
      broker.authorize(grant, 'submit-task', 'https://accounts.example.test', 'fill', 'registration-email');

      journal.close();

      expect(() => {
        broker.authorize(grant, 'submit-task', 'https://accounts.example.test', 'submit');
      }).toThrow('AUDIT_UNAVAILABLE');

      expect(broker.state('submit-task')).toBe('stopped');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('denyApproval persists approval_denied and terminates task without grant', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'audit-deny-'));
    try {
      const journal = new LocalAuditJournal(tempDir);
      const broker = new PolicyBroker(defaultCatalog, journal.append);

      broker.denyApproval('denied-task', 'https://accounts.example.test');

      expect(broker.state('denied-task')).toBe('stopped');
      expect(broker.canObserve('denied-task')).toBe(false);
      expect(() => broker.approve(makeRequest('denied-task'))).toThrow('TASK_ALREADY_EXISTS');

      journal.close();

      const raw = readFileSync(journal.path, 'utf-8');
      const row = JSON.parse(raw.trim());

      expect(row.event).toBe('approval_denied');
      expect(typeof row.task).toBe('string');
      expect(raw).not.toContain('denied-task');
      expect(raw).not.toContain('https://accounts.example.test');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('null task handling for stopped_all in journal', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'audit-stop-all-'));
    try {
      const journal = new LocalAuditJournal(tempDir);
      const broker = new PolicyBroker(defaultCatalog, journal.append);

      broker.stopAll();
      journal.close();

      const row = JSON.parse(readFileSync(journal.path, 'utf-8').trim());
      expect(row.event).toBe('stopped_all');
      expect(row.task).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
