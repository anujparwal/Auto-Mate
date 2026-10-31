import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PolicyBroker, type Layer } from '../src/policy';
import { LocalAuditJournal } from '../src/audit';
import { LocalAuditHistory } from '../src/audit-history';

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

function validRow(
  session: string,
  sequence: number,
  task: string | null = null,
  event = 'approved',
  reason?: string,
): string {
  const obj: Record<string, unknown> = {
    version: 1,
    session,
    sequence,
    at: new Date('2026-10-31T12:00:00.000Z').toISOString(),
    task,
    event,
  };
  if (reason !== undefined) {
    obj.reason = reason;
  }
  return JSON.stringify(obj) + '\n';
}

describe('LocalAuditHistory shared reader contract', () => {
  test('real LocalAuditJournal roundtrip and privacy projection', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'audit-hist-roundtrip-'));
    try {
      const journal = new LocalAuditJournal(tempDir);
      const broker = new PolicyBroker(defaultCatalog, journal.append);

      const grant = broker.approve(makeRequest('task-privacy'));
      broker.authorize(grant, 'task-privacy', 'https://accounts.example.test', 'fill', 'registration-email');
      broker.authorize(grant, 'task-privacy', 'https://accounts.example.test', 'submit');
      broker.denyApproval('denied-task', 'https://accounts.example.test');
      broker.stopAll();
      journal.close();

      const history = new LocalAuditHistory(tempDir);
      const sessionsPage = await history.sessions();

      expect(sessionsPage.total).toBe(1);
      expect(sessionsPage.sessions.length).toBe(1);
      expect(sessionsPage.offset).toBe(0);
      expect(sessionsPage.nextOffset).toBeNull();

      const sessionSummary = sessionsPage.sessions[0]!;
      expect(new Date(sessionSummary.modifiedAt).toISOString()).toBe(sessionSummary.modifiedAt);

      const eventsPage = await history.events(sessionSummary.id);
      expect(eventsPage.id).toBe(sessionSummary.id);
      expect(eventsPage.session).toBe(eventsPage.events[0]!.session);
      expect(eventsPage.total).toBe(5);
      expect(eventsPage.events.length).toBe(5);
      expect(eventsPage.truncated).toBe(false);
      expect(eventsPage.offset).toBe(0);
      expect(eventsPage.nextOffset).toBeNull();

      const events = eventsPage.events;
      expect(events[0]!.event).toBe('approved');
      expect(events[1]!.event).toBe('fill_authorized');
      expect(events[2]!.event).toBe('submit_authorized');
      expect(events[3]!.event).toBe('approval_denied');
      expect(events[4]!.event).toBe('stopped_all');
      expect(events[4]!.task).toBeNull();

      const stringifiedEvents = JSON.stringify(events);
      expect(stringifiedEvents).not.toContain('task-privacy');
      expect(stringifiedEvents).not.toContain('registration-email');
      expect(stringifiedEvents).not.toContain('registration-password');
      expect(stringifiedEvents).not.toContain('https://accounts.example.test');
      expect(stringifiedEvents).not.toContain('yellow');
      expect(stringifiedEvents).not.toContain('red');

      for (let i = 0; i < events.length; i++) {
        const row = events[i]!;
        expect(row.version).toBe(1);
        expect(row.session).toBe(events[0]!.session);
        expect(row.sequence).toBe(i + 1);
        expect(new Date(row.at).toISOString()).toBe(row.at);
        if (row.reason !== undefined) {
          expect(Object.keys(row).sort()).toEqual(['at', 'event', 'reason', 'sequence', 'session', 'task', 'version']);
        } else {
          expect(Object.keys(row).sort()).toEqual(['at', 'event', 'sequence', 'session', 'task', 'version']);
        }
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('multi-page sequences and session ordering', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'audit-hist-paging-'));
    try {
      const idA = '00000000-0000-4000-8000-000000000001';
      const idB = '00000000-0000-4000-8000-000000000002';
      const idC = '00000000-0000-4000-8000-000000000003';

      writeFileSync(join(tempDir, `${idA}.jsonl`), validRow(idB, 1));
      writeFileSync(join(tempDir, `${idB}.jsonl`), validRow(idB, 1));
      writeFileSync(join(tempDir, `${idC}.jsonl`), validRow(idC, 1));

      // idA older mtime (1000s), idB and idC newer mtime (2000s)
      utimesSync(join(tempDir, `${idA}.jsonl`), new Date(1000000), new Date(1000000));
      utimesSync(join(tempDir, `${idB}.jsonl`), new Date(2000000), new Date(2000000));
      utimesSync(join(tempDir, `${idC}.jsonl`), new Date(2000000), new Date(2000000));

      const history = new LocalAuditHistory(tempDir);
      const orderingPage = await history.sessions();

      expect(orderingPage.total).toBe(3);
      // Newest mtime first; equal mtimes sorted deterministically by id
      expect(orderingPage.sessions.map(s => s.id)).toEqual([idB, idC, idA]);
      // Existing journals use independent file and inner-session UUIDs.
      expect((await history.events(idA)).session).toBe(idB);

      // Multi-page sessions: create 25 files total
      for (let i = 4; i <= 25; i++) {
        const hex = i.toString(16).padStart(12, '0');
        const id = `00000000-0000-4000-8000-${hex}`;
        writeFileSync(join(tempDir, `${id}.jsonl`), validRow(id, 1));
      }

      const p1Sessions = await history.sessions(0);
      expect(p1Sessions.total).toBe(25);
      expect(p1Sessions.sessions.length).toBe(20);
      expect(p1Sessions.offset).toBe(0);
      expect(p1Sessions.nextOffset).toBe(20);

      const p2Sessions = await history.sessions(20);
      expect(p2Sessions.total).toBe(25);
      expect(p2Sessions.sessions.length).toBe(5);
      expect(p2Sessions.offset).toBe(20);
      expect(p2Sessions.nextOffset).toBeNull();

      const p3Sessions = await history.sessions(25);
      expect(p3Sessions.total).toBe(25);
      expect(p3Sessions.sessions.length).toBe(0);
      expect(p3Sessions.offset).toBe(25);
      expect(p3Sessions.nextOffset).toBeNull();

      await expect(history.sessions(26)).rejects.toMatchObject({ code: 'INVALID_HISTORY_REQUEST' });

      // Multi-page events: write 55 rows into idA
      const eventId = '00000000-0000-4000-8000-000000000099';
      let eventRows = '';
      for (let seq = 1; seq <= 55; seq++) {
        eventRows += validRow(eventId, seq);
      }
      writeFileSync(join(tempDir, `${eventId}.jsonl`), eventRows);

      const p1Events = await history.events(eventId, 0);
      expect(p1Events.total).toBe(55);
      expect(p1Events.events.length).toBe(50);
      expect(p1Events.events[0]!.sequence).toBe(1);
      expect(p1Events.events[49]!.sequence).toBe(50);
      expect(p1Events.offset).toBe(0);
      expect(p1Events.nextOffset).toBe(50);

      const p2Events = await history.events(eventId, 50);
      expect(p2Events.total).toBe(55);
      expect(p2Events.events.length).toBe(5);
      expect(p2Events.events[0]!.sequence).toBe(51);
      expect(p2Events.events[4]!.sequence).toBe(55);
      expect(p2Events.offset).toBe(50);
      expect(p2Events.nextOffset).toBeNull();

      const p3Events = await history.events(eventId, 55);
      expect(p3Events.total).toBe(55);
      expect(p3Events.events.length).toBe(0);
      expect(p3Events.offset).toBe(55);
      expect(p3Events.nextOffset).toBeNull();

      await expect(history.events(eventId, 56)).rejects.toMatchObject({ code: 'INVALID_HISTORY_REQUEST' });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('entire-file refusal when a later complete row has extra/private properties or changed identity/sequence', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'audit-hist-refusal-'));
    try {
      const history = new LocalAuditHistory(tempDir);

      // Case A: later row has extra unprojected / private properties
      const idA = '11111111-1111-4111-8111-111111111111';
      const fileA =
        validRow(idA, 1) +
        JSON.stringify({
          version: 1,
          session: idA,
          sequence: 2,
          at: new Date('2026-10-31T12:00:01.000Z').toISOString(),
          task: null,
          event: 'completed',
          origin: 'https://leak.test',
        }) +
        '\n';
      writeFileSync(join(tempDir, `${idA}.jsonl`), fileA);

      await expect(history.events(idA, 0)).rejects.toMatchObject({ code: 'HISTORY_INVALID' });

      // Case B: later row has changed identity (different session UUID)
      const idB = '22222222-2222-4222-8222-222222222222';
      const fileB =
        validRow(idB, 1) +
        validRow('33333333-3333-4333-8333-333333333333', 2);
      writeFileSync(join(tempDir, `${idB}.jsonl`), fileB);

      await expect(history.events(idB, 0)).rejects.toMatchObject({ code: 'HISTORY_INVALID' });

      // Case C: sequence jump / non-consecutive
      const idC = '44444444-4444-4444-8444-444444444444';
      const fileC = validRow(idC, 1) + validRow(idC, 3);
      writeFileSync(join(tempDir, `${idC}.jsonl`), fileC);

      await expect(history.events(idC, 0)).rejects.toMatchObject({ code: 'HISTORY_INVALID' });

      // Case D: sequence not starting at 1
      const idD = '55555555-5555-4555-8555-555555555555';
      const fileD = validRow(idD, 2);
      writeFileSync(join(tempDir, `${idD}.jsonl`), fileD);

      await expect(history.events(idD, 0)).rejects.toMatchObject({ code: 'HISTORY_INVALID' });

      // Case E: invalid timestamp in later row
      const idE = '66666666-6666-4666-8666-666666666666';
      const fileE =
        validRow(idE, 1) +
        JSON.stringify({
          version: 1,
          session: idE,
          sequence: 2,
          at: '2026-10-31 12:00:00',
          task: null,
          event: 'completed',
        }) +
        '\n';
      writeFileSync(join(tempDir, `${idE}.jsonl`), fileE);

      await expect(history.events(idE, 0)).rejects.toMatchObject({ code: 'HISTORY_INVALID' });

      // Case F: empty line in middle
      const idF = '77777777-7777-4777-8777-777777777777';
      const fileF = validRow(idF, 1) + '\n' + validRow(idF, 2);
      writeFileSync(join(tempDir, `${idF}.jsonl`), fileF);

      await expect(history.events(idF, 0)).rejects.toMatchObject({ code: 'HISTORY_INVALID' });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('incomplete final-row warning with unchanged file bytes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'audit-hist-incomplete-'));
    try {
      const history = new LocalAuditHistory(tempDir);
      const id = '88888888-8888-4888-8888-888888888888';
      const filePath = join(tempDir, `${id}.jsonl`);

      const row1 = validRow(id, 1);
      const incompleteRow2 = '{"version":1,"session":"' + id + '","sequence":2,"at":"2026-10-31T12:00:00.000Z"';
      writeFileSync(filePath, row1 + incompleteRow2);

      const fileBytesBefore = readFileSync(filePath);

      const page = await history.events(id);
      expect(page.truncated).toBe(true);
      expect(page.total).toBe(1);
      expect(page.events.length).toBe(1);
      expect(page.events[0]!.sequence).toBe(1);

      const fileBytesAfter = readFileSync(filePath);
      expect(fileBytesAfter.equals(fileBytesBefore)).toBe(true);

      // Entire file is incomplete row without newline
      const idEmptyRows = '99999999-9999-4999-8999-999999999999';
      const emptyRowsPath = join(tempDir, `${idEmptyRows}.jsonl`);
      writeFileSync(emptyRowsPath, '{"version":1');

      const emptyRowsBytesBefore = readFileSync(emptyRowsPath);
      const incompletePage = await history.events(idEmptyRows);
      expect(incompletePage.session).toBeNull();
      expect(incompletePage.total).toBe(0);
      expect(incompletePage.events.length).toBe(0);
      expect(incompletePage.truncated).toBe(true);

      const emptyRowsBytesAfter = readFileSync(emptyRowsPath);
      expect(emptyRowsBytesAfter.equals(emptyRowsBytesBefore)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('path traversal, malformed requests, and inherited allowlist names', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'audit-hist-security-'));
    try {
      const history = new LocalAuditHistory(tempDir);
      const validId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      writeFileSync(join(tempDir, `${validId}.jsonl`), validRow(validId, 1));

      // Path traversal attempts
      await expect(history.events('../secret')).rejects.toMatchObject({ code: 'INVALID_HISTORY_REQUEST' });
      await expect(history.events('..\\secret')).rejects.toMatchObject({ code: 'INVALID_HISTORY_REQUEST' });
      await expect(history.events(`${validId}/../secret`)).rejects.toMatchObject({ code: 'INVALID_HISTORY_REQUEST' });
      await expect(history.events(`${validId}:stream`)).rejects.toMatchObject({ code: 'INVALID_HISTORY_REQUEST' });
      await expect(history.events('')).rejects.toMatchObject({ code: 'INVALID_HISTORY_REQUEST' });
      await expect(history.events('not-a-uuid')).rejects.toMatchObject({ code: 'INVALID_HISTORY_REQUEST' });
      // Uppercase UUID refused
      await expect(history.events(validId.toUpperCase())).rejects.toMatchObject({ code: 'INVALID_HISTORY_REQUEST' });

      // Malformed offset
      await expect(history.events(validId, -1)).rejects.toMatchObject({ code: 'INVALID_HISTORY_REQUEST' });
      await expect(history.events(validId, 1.5)).rejects.toMatchObject({ code: 'INVALID_HISTORY_REQUEST' });
      await expect(history.events(validId, NaN)).rejects.toMatchObject({ code: 'INVALID_HISTORY_REQUEST' });
      await expect(history.sessions(-1)).rejects.toMatchObject({ code: 'INVALID_HISTORY_REQUEST' });
      await expect(history.sessions(1.5)).rejects.toMatchObject({ code: 'INVALID_HISTORY_REQUEST' });
      await expect(history.sessions(NaN)).rejects.toMatchObject({ code: 'INVALID_HISTORY_REQUEST' });

      // Inherited Object property names in allowlist
      const idProto = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      writeFileSync(join(tempDir, `${idProto}.jsonl`), validRow(idProto, 1, null, 'toString'));
      await expect(history.events(idProto)).rejects.toMatchObject({ code: 'HISTORY_INVALID' });

      const idReason = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      writeFileSync(join(tempDir, `${idReason}.jsonl`), validRow(idReason, 1, null, 'denied', 'valueOf'));
      await expect(history.events(idReason)).rejects.toMatchObject({ code: 'HISTORY_INVALID' });

      // Refusal of subdirectories named uuid.jsonl
      const dirAsFile = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      mkdirSync(join(tempDir, `${dirAsFile}.jsonl`));
      const sessions = await history.sessions();
      expect(sessions.sessions.some(s => s.id === dirAsFile)).toBe(false);
      await expect(history.events(dirAsFile)).rejects.toMatchObject({ code: 'HISTORY_INVALID' });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('size and row bound refusal', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'audit-hist-bounds-'));
    try {
      const history = new LocalAuditHistory(tempDir);

      // Oversize file (> 1 MiB)
      const bigId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      const bigPath = join(tempDir, `${bigId}.jsonl`);
      const largeBuffer = Buffer.alloc(1024 * 1024 + 10, 0x20);
      writeFileSync(bigPath, largeBuffer);
      await expect(history.events(bigId)).rejects.toMatchObject({ code: 'HISTORY_TOO_LARGE' });

      // Over 4096 complete rows
      const manyRowsId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      const manyRowsPath = join(tempDir, `${manyRowsId}.jsonl`);
      let rows4097 = '';
      for (let i = 1; i <= 4097; i++) {
        rows4097 += validRow(manyRowsId, i);
      }
      writeFileSync(manyRowsPath, rows4097);
      await expect(history.events(manyRowsId)).rejects.toMatchObject({ code: 'HISTORY_TOO_LARGE' });

      // Directory entries > 4096 entries
      const bigDir = mkdtempSync(join(tmpdir(), 'audit-hist-bigdir-'));
      try {
        for (let i = 0; i <= 4096; i++) {
          writeFileSync(join(bigDir, `dummy-${i}.txt`), 'x');
        }
        const bigHistory = new LocalAuditHistory(bigDir);
        await expect(bigHistory.sessions()).rejects.toMatchObject({ code: 'HISTORY_LIMIT' });
      } finally {
        rmSync(bigDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('empty or missing directory and empty file', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'audit-hist-empty-'));
    try {
      // Missing directory
      const missingDir = join(tempDir, 'does-not-exist');
      const missingHistory = new LocalAuditHistory(missingDir);
      const emptySessions = await missingHistory.sessions();
      expect(emptySessions).toEqual({ sessions: [], offset: 0, total: 0, nextOffset: null });

      // Nonexistent file
      const validUuid = '12345678-1234-4234-8234-123456789abc';
      await expect(missingHistory.events(validUuid)).rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' });

      // Empty directory
      const history = new LocalAuditHistory(tempDir);
      const emptyListing = await history.sessions();
      expect(emptyListing).toEqual({ sessions: [], offset: 0, total: 0, nextOffset: null });

      // Empty file (0 bytes)
      const emptyId = '87654321-4321-4321-8321-cba987654321';
      writeFileSync(join(tempDir, `${emptyId}.jsonl`), '');
      const emptyEventPage = await history.events(emptyId);
      expect(emptyEventPage).toEqual({
        id: emptyId,
        session: null,
        events: [],
        offset: 0,
        total: 0,
        nextOffset: null,
        truncated: false,
      });

      // Offset > 0 on empty file is rejected
      await expect(history.events(emptyId, 1)).rejects.toMatchObject({ code: 'INVALID_HISTORY_REQUEST' });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('live append refresh', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'audit-hist-live-'));
    try {
      const journal = new LocalAuditJournal(tempDir);
      const broker = new PolicyBroker(defaultCatalog, journal.append);

      const grant = broker.approve(makeRequest('live-task'));
      broker.authorize(grant, 'live-task', 'https://accounts.example.test', 'fill', 'registration-email');

      const history = new LocalAuditHistory(tempDir);
      const sessions = await history.sessions();
      expect(sessions.total).toBe(1);
      const journalId = sessions.sessions[0]!.id;

      const snapshot1 = await history.events(journalId);
      expect(snapshot1.total).toBe(2);
      expect(snapshot1.events.length).toBe(2);

      // Append 3rd event while history instance is alive
      broker.authorize(grant, 'live-task', 'https://accounts.example.test', 'submit');

      const snapshot2 = await history.events(journalId);
      expect(snapshot2.total).toBe(3);
      expect(snapshot2.events.length).toBe(3);
      expect(snapshot2.events[2]!.sequence).toBe(3);
      expect(snapshot2.events[2]!.event).toBe('submit_authorized');

      journal.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
