import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultWorkspaceSettings } from '../src/agent-settings';
import type { AgentNote, WorkspaceStoredData } from '../src/agent-types';
import { HostedAccounts } from '../src/hosted-accounts';
import { PolicyError } from '../src/policy';
import {
  openWindowsWorkspaceStore,
  SYNTHETIC_WORKSPACE_ROOT,
  validateNotes,
} from '../src/workspace-store';

describe('WorkspaceStore (Windows DPAPI & Hosted AES-GCM)', () => {
  let testDir: string;

  beforeEach(async () => {
    await mkdir(SYNTHETIC_WORKSPACE_ROOT, { recursive: true });
    testDir = await mkdtemp(join(SYNTHETIC_WORKSPACE_ROOT, 'test-workspace-'));
  });

  afterEach(async () => {
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  describe('validateNotes', () => {
    test('validates notes and enforces limits', () => {
      const validNotes: AgentNote[] = [
        {
          id: 'n1',
          topic: 'Research',
          content: 'Found relevant article',
          timestamp: 123456789,
          sourceUrl: 'https://example.com/page',
          agent: 'Researcher',
        },
      ];
      const validated = validateNotes(validNotes);
      expect(validated).toEqual(validNotes);

      // Empty or undefined notes returns empty array
      expect(validateNotes(undefined)).toEqual([]);
      expect(validateNotes(null)).toEqual([]);

      // Invalid note
      expect(() => validateNotes([{ topic: 'missing id' }])).toThrow(PolicyError);

      // Exceeding notes limit
      const tooMany = Array.from({ length: 501 }, (_, i) => ({
        id: `id_${i}`,
        topic: 'Topic',
        content: 'Content',
        timestamp: Date.now(),
        sourceUrl: 'https://example.com',
      }));
      expect(() => validateNotes(tooMany)).toThrow('NOTES_LIMIT_EXCEEDED');
    });
  });

  describe('openWindowsWorkspaceStore (Desktop DPAPI)', () => {
    test('returns null when workspace file does not exist (missing distinction)', async () => {
      const store = openWindowsWorkspaceStore({
        directory: testDir,
        synthetic: true,
      });

      const data = await store.load();
      expect(data).toBeNull();
    });

    test('saves and loads encrypted workspace settings and notes', async () => {
      const store = openWindowsWorkspaceStore({
        directory: testDir,
        synthetic: true,
      });

      const payload: WorkspaceStoredData = {
        settings: {
          ...defaultWorkspaceSettings(),
          model: {
            mode: 'cloud',
            preset: 'openai',
            endpoint: 'https://api.openai.com/v1/chat/completions',
            model: 'gpt-4o-mini',
            apiKey: 'sk-super-secret-api-key-999',
          },
          memory: {
            enabled: true,
            content: 'Confidential memory data about the user',
          },
        },
        notes: [
          {
            id: 'note-01',
            topic: 'Credentials info',
            content: 'Encrypted notes content should not be plaintext on disk',
            timestamp: 1700000000000,
            sourceUrl: 'https://example.org/secure',
          },
        ],
      };

      await store.save(payload);

      // 1. Inspect file on disk to guarantee NO plaintext secrets
      const rawFile = await readFile(join(testDir, 'workspace.json'), 'utf-8');
      expect(rawFile).not.toContain('sk-super-secret-api-key-999');
      expect(rawFile).not.toContain('Confidential memory data about the user');
      expect(rawFile).not.toContain('Encrypted notes content should not be plaintext on disk');

      // Envelope structure
      const envelope = JSON.parse(rawFile);
      expect(envelope.version).toBe(1);
      expect(typeof envelope.cipherText).toBe('string');

      // 2. Load via store and verify data integrity
      const loaded = await store.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.settings.model.apiKey).toBe('sk-super-secret-api-key-999');
      expect(loaded!.settings.memory.content).toBe('Confidential memory data about the user');
      expect(loaded!.notes).toHaveLength(1);
      expect(loaded!.notes[0]!.id).toBe('note-01');
      expect(loaded!.notes[0]!.content).toBe(
        'Encrypted notes content should not be plaintext on disk'
      );
    });

    test('detects corrupted workspace file and throws WORKSPACE_CORRUPTED (no silent fallback)', async () => {
      const store = openWindowsWorkspaceStore({
        directory: testDir,
        synthetic: true,
      });

      // Write invalid/corrupt envelope
      await writeFile(join(testDir, 'workspace.json'), '{ "version": 1, "cipherText": "not-valid-base64-or-dpapi" }', 'utf-8');

      await expect(store.load()).rejects.toThrow('WORKSPACE_CORRUPTED');

      // Write garbage json
      await writeFile(join(testDir, 'workspace.json'), '<<< corrupt json >>>', 'utf-8');
      await expect(store.load()).rejects.toThrow('WORKSPACE_CORRUPTED');
    });

    test('enforces assertActive revocation check', async () => {
      let active = true;
      const store = openWindowsWorkspaceStore({
        directory: testDir,
        synthetic: true,
        assertActive: () => {
          if (!active) throw new PolicyError('SESSION_REVOKED');
        },
      });

      const payload: WorkspaceStoredData = {
        settings: defaultWorkspaceSettings(),
        notes: [],
      };
      await store.save(payload);
      expect(await store.load()).not.toBeNull();

      // Revoke
      active = false;
      await expect(store.load()).rejects.toThrow('SESSION_REVOKED');
      await expect(store.save(payload)).rejects.toThrow('SESSION_REVOKED');
    });
  });

  describe('HostedAccountSession.workspaceStore (Hosted AES-GCM & Scrypt)', () => {
    const regKey = 'registration-key-secret-1234';

    test('returns null when account workspace does not exist', async () => {
      const accounts = await HostedAccounts.open({
        directory: testDir,
        registrationKey: regKey,
      });

      const session = await accounts.register('alice01', 'secure-password-1234', regKey);
      try {
        const data = await session.workspaceStore.load();
        expect(data).toBeNull();
      } finally {
        await session.close();
      }
    });

    test('encrypts workspace at rest with per-account scrypt-derived AES-GCM and persists across sessions', async () => {
      const accounts = await HostedAccounts.open({
        directory: testDir,
        registrationKey: regKey,
      });

      const session = await accounts.register('bob_hosted', 'secure-password-1234', regKey);
      const payload: WorkspaceStoredData = {
        settings: {
          ...defaultWorkspaceSettings(),
          model: {
            mode: 'cloud',
            preset: 'groq',
            endpoint: 'https://api.groq.com/openai/v1/chat/completions',
            model: 'llama-3.3-70b-versatile',
            apiKey: 'gsk_hosted_secret_key_12345',
          },
          memory: {
            enabled: true,
            content: 'Hosted persistent private memory',
          },
        },
        notes: [
          {
            id: 'hnote-1',
            topic: 'Hosted Topic',
            content: 'Secret hosted note content',
            timestamp: 1699999999000,
            sourceUrl: 'https://groq.example.com',
          },
        ],
      };

      await session.workspaceStore.save(payload);

      // Inspect disk file directly: verify NO plaintext at rest
      const workspaceFile = join(testDir, `${session.accountId}.workspace`);
      const rawEncrypted = await readFile(workspaceFile, 'utf-8');
      expect(rawEncrypted).not.toContain('gsk_hosted_secret_key_12345');
      expect(rawEncrypted).not.toContain('Hosted persistent private memory');
      expect(rawEncrypted).not.toContain('Secret hosted note content');

      const envelope = JSON.parse(rawEncrypted);
      expect(envelope.version).toBe(1);
      expect(typeof envelope.iv).toBe('string');
      expect(typeof envelope.authTag).toBe('string');
      expect(typeof envelope.ciphertext).toBe('string');

      await session.close();

      // Reopen session via unlock
      const reopened = await accounts.unlock('bob_hosted', 'secure-password-1234');
      try {
        const loaded = await reopened.workspaceStore.load();
        expect(loaded).not.toBeNull();
        expect(loaded!.settings.model.apiKey).toBe('gsk_hosted_secret_key_12345');
        expect(loaded!.settings.memory.content).toBe('Hosted persistent private memory');
        expect(loaded!.notes).toHaveLength(1);
        expect(loaded!.notes[0]!.content).toBe('Secret hosted note content');
      } finally {
        await reopened.close();
      }
    });

    test('hosted workspace rejects local models on save to prevent SSRF', async () => {
      const accounts = await HostedAccounts.open({
        directory: testDir,
        registrationKey: regKey,
      });

      const session = await accounts.register('charlie01', 'secure-password-1234', regKey);
      try {
        const invalidPayload: WorkspaceStoredData = {
          settings: {
            ...defaultWorkspaceSettings(),
            model: {
              mode: 'local',
              preset: 'ollama',
              endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
              model: 'llama3.2',
            },
          },
          notes: [],
        };

        await expect(session.workspaceStore.save(invalidPayload)).rejects.toThrow(
          'LOCAL_MODEL_FORBIDDEN_IN_HOSTED'
        );
      } finally {
        await session.close();
      }
    });

    test('detects tampered workspace ciphertext and fails closed with WORKSPACE_CORRUPTED', async () => {
      const accounts = await HostedAccounts.open({
        directory: testDir,
        registrationKey: regKey,
      });

      const session = await accounts.register('tamper_test', 'secure-password-1234', regKey);
      const payload: WorkspaceStoredData = {
        settings: defaultWorkspaceSettings(),
        notes: [],
      };
      await session.workspaceStore.save(payload);

      const workspaceFile = join(testDir, `${session.accountId}.workspace`);
      // Tamper with ciphertext
      const parsed = JSON.parse(await readFile(workspaceFile, 'utf-8'));
      parsed.ciphertext = Buffer.from('corrupted-ciphertext').toString('base64');
      await writeFile(workspaceFile, JSON.stringify(parsed), 'utf-8');

      await expect(session.workspaceStore.load()).rejects.toThrow('WORKSPACE_CORRUPTED');
      await session.close();
    });

    test('revokes workspaceStore operations immediately upon session close', async () => {
      const accounts = await HostedAccounts.open({
        directory: testDir,
        registrationKey: regKey,
      });

      const session = await accounts.register('revocation_test', 'secure-password-1234', regKey);
      await session.close();

      await expect(session.workspaceStore.load()).rejects.toThrow('SESSION_CLOSED');
      await expect(
        session.workspaceStore.save({
          settings: defaultWorkspaceSettings(),
          notes: [],
        })
      ).rejects.toThrow('SESSION_CLOSED');
    });

    test('guarantees complete workspace isolation between accounts', async () => {
      const accounts = await HostedAccounts.open({
        directory: testDir,
        registrationKey: regKey,
      });

      const userA = await accounts.register('user_a', 'secure-password-1234', regKey);
      const userB = await accounts.register('user_b', 'secure-password-1234', regKey);

      await userA.workspaceStore.save({
        settings: {
          ...defaultWorkspaceSettings(),
          memory: { enabled: true, content: 'User A private memories' },
        },
        notes: [],
      });

      // User B has no workspace yet
      expect(await userB.workspaceStore.load()).toBeNull();

      await userB.workspaceStore.save({
        settings: {
          ...defaultWorkspaceSettings(),
          memory: { enabled: true, content: 'User B distinct memories' },
        },
        notes: [],
      });

      const loadedA = await userA.workspaceStore.load();
      const loadedB = await userB.workspaceStore.load();

      expect(loadedA!.settings.memory.content).toBe('User A private memories');
      expect(loadedB!.settings.memory.content).toBe('User B distinct memories');

      await userA.close();
      await userB.close();
    });
  });
});
