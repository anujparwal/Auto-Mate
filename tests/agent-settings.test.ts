import { describe, expect, test } from 'bun:test';
import {
  defaultWorkspaceSettings,
  normalizeChatEndpoint,
  sanitizeWorkspaceSettingsForState,
  validateDomain,
  validateWorkspaceSettings,
} from '../src/agent-settings';
import type { AgentWorkspaceSettings } from '../src/agent-types';
import { PolicyError } from '../src/policy';

describe('agent-settings', () => {

  describe('normalizeChatEndpoint', () => {
    test('normalizes root and base paths to /v1/chat/completions without double path', () => {
      expect(normalizeChatEndpoint('https://api.openai.com')).toBe(
        'https://api.openai.com/v1/chat/completions'
      );
      expect(normalizeChatEndpoint('https://api.openai.com/')).toBe(
        'https://api.openai.com/v1/chat/completions'
      );
      expect(normalizeChatEndpoint('https://api.openai.com/v1')).toBe(
        'https://api.openai.com/v1/chat/completions'
      );
      expect(normalizeChatEndpoint('https://api.openai.com/v1/')).toBe(
        'https://api.openai.com/v1/chat/completions'
      );
      expect(normalizeChatEndpoint('https://api.openai.com/v1/chat/completions')).toBe(
        'https://api.openai.com/v1/chat/completions'
      );
      expect(normalizeChatEndpoint('https://api.openai.com/v1/chat/completions/')).toBe(
        'https://api.openai.com/v1/chat/completions'
      );
      expect(normalizeChatEndpoint('http://127.0.0.1:11434')).toBe(
        'http://127.0.0.1:11434/v1/chat/completions'
      );
      expect(normalizeChatEndpoint('http://127.0.0.1:11434/v1')).toBe(
        'http://127.0.0.1:11434/v1/chat/completions'
      );
      expect(normalizeChatEndpoint('https://custom.ai/prefix/v1')).toBe(
        'https://custom.ai/prefix/v1/chat/completions'
      );
      expect(normalizeChatEndpoint('https://custom.ai/prefix/chat/completions')).toBe(
        'https://custom.ai/prefix/chat/completions'
      );
    });

    test('rejects credentials, query parameters, and fragments', () => {
      expect(() => normalizeChatEndpoint('https://user:pass@api.openai.com/v1')).toThrow(
        PolicyError
      );
      expect(() => normalizeChatEndpoint('https://api.openai.com/v1?token=123')).toThrow(
        PolicyError
      );
      expect(() => normalizeChatEndpoint('https://api.openai.com/v1#hash')).toThrow(
        PolicyError
      );
      expect(() => normalizeChatEndpoint('not-a-url')).toThrow(PolicyError);
    });
  });

  describe('validateDomain', () => {
    test('accepts valid domain labels and hostnames', () => {
      expect(validateDomain('example.com')).toBe('example.com');
      expect(validateDomain('sub.domain.example.co.uk')).toBe('sub.domain.example.co.uk');
      expect(validateDomain('LOCALHOST')).toBe('localhost');
      expect(validateDomain('  site.test  ')).toBe('site.test');
    });

    test('rejects URLs, paths, ports, wildcards, and userinfo', () => {
      expect(() => validateDomain('https://example.com')).toThrow(PolicyError);
      expect(() => validateDomain('example.com:8080')).toThrow(PolicyError);
      expect(() => validateDomain('example.com/path')).toThrow(PolicyError);
      expect(() => validateDomain('*.example.com')).toThrow(PolicyError);
      expect(() => validateDomain('user@example.com')).toThrow(PolicyError);
      expect(() => validateDomain('-example.com')).toThrow(PolicyError);
      expect(() => validateDomain('example-.com')).toThrow(PolicyError);
      expect(() => validateDomain('')).toThrow(PolicyError);
      expect(() => validateDomain(' ')).toThrow(PolicyError);
    });
  });

  describe('validateWorkspaceSettings - Model and Presets', () => {
    test('validates standard cloud presets with defaults', () => {
      const openai = validateWorkspaceSettings({
        model: { preset: 'openai' },
      });
      expect(openai.model.mode).toBe('cloud');
      expect(openai.model.preset).toBe('openai');
      expect(openai.model.endpoint).toBe('https://api.openai.com/v1/chat/completions');
      expect(openai.model.model).toBe('gpt-4o-mini');

      const groq = validateWorkspaceSettings({
        model: { preset: 'groq' },
      });
      expect(groq.model.mode).toBe('cloud');
      expect(groq.model.preset).toBe('groq');
      expect(groq.model.endpoint).toBe('https://api.groq.com/openai/v1/chat/completions');
      expect(groq.model.model).toBe('llama-3.3-70b-versatile');

      const openrouter = validateWorkspaceSettings({
        model: { preset: 'openrouter' },
      });
      expect(openrouter.model.mode).toBe('cloud');
      expect(openrouter.model.preset).toBe('openrouter');
      expect(openrouter.model.endpoint).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(openrouter.model.model).toBe('meta-llama/llama-3.3-70b-instruct');
    });

    test('validates local desktop presets', () => {
      const ollama = validateWorkspaceSettings({
        model: { preset: 'ollama' },
      });
      expect(ollama.model.mode).toBe('local');
      expect(ollama.model.preset).toBe('ollama');
      expect(ollama.model.endpoint).toBe('http://127.0.0.1:11434/v1/chat/completions');
      expect(ollama.model.model).toBe('llama3.2');

      const lmstudio = validateWorkspaceSettings({
        model: { preset: 'lmstudio' },
      });
      expect(lmstudio.model.mode).toBe('local');
      expect(lmstudio.model.preset).toBe('lmstudio');
      expect(lmstudio.model.endpoint).toBe('http://127.0.0.1:1234/v1/chat/completions');
      expect(lmstudio.model.model).toBe('qwen2.5-7b-instruct');
    });

    test('no silent fallback on invalid preset or model', () => {
      expect(() =>
        validateWorkspaceSettings({
          model: { preset: 'unsupported-provider' },
        })
      ).toThrow(PolicyError);

      expect(() =>
        validateWorkspaceSettings({
          model: { preset: 'custom', mode: 'cloud', endpoint: 'https://api.openai.com', model: '' },
        })
      ).toThrow(PolicyError);
    });

    test('cloud mode requires HTTPS and rejects private IP endpoints', () => {
      expect(() =>
        validateWorkspaceSettings({
          model: {
            preset: 'custom',
            mode: 'cloud',
            endpoint: 'http://api.openai.com/v1',
            model: 'test',
          },
        })
      ).toThrow('CLOUD_ENDPOINT_REQUIRES_HTTPS');

      expect(() =>
        validateWorkspaceSettings({
          model: {
            preset: 'custom',
            mode: 'cloud',
            endpoint: 'https://127.0.0.1:8000',
            model: 'test',
          },
        })
      ).toThrow('CLOUD_ENDPOINT_CANNOT_BE_PRIVATE');

      expect(() =>
        validateWorkspaceSettings({
          model: {
            preset: 'custom',
            mode: 'cloud',
            endpoint: 'https://10.0.0.1',
            model: 'test',
          },
        })
      ).toThrow('CLOUD_ENDPOINT_CANNOT_BE_PRIVATE');

      expect(() =>
        validateWorkspaceSettings({
          model: {
            preset: 'custom',
            mode: 'cloud',
            endpoint: 'https://192.168.1.1',
            model: 'test',
          },
        })
      ).toThrow('CLOUD_ENDPOINT_CANNOT_BE_PRIVATE');
    });

    test('desktop local mode allows only loopback endpoints', () => {
      // Loopback allowed
      const valid = validateWorkspaceSettings({
        model: {
          preset: 'custom',
          mode: 'local',
          endpoint: 'http://127.0.0.1:8080',
          model: 'local-test',
        },
      });
      expect(valid.model.endpoint).toBe('http://127.0.0.1:8080/v1/chat/completions');

      const localhostValid = validateWorkspaceSettings({
        model: {
          preset: 'custom',
          mode: 'local',
          endpoint: 'http://localhost:5000',
          model: 'local-test',
        },
      });
      expect(localhostValid.model.endpoint).toBe('http://localhost:5000/v1/chat/completions');

      // Non-loopback denied
      expect(() =>
        validateWorkspaceSettings({
          model: {
            preset: 'custom',
            mode: 'local',
            endpoint: 'http://192.168.1.100:8080',
            model: 'local-test',
          },
        })
      ).toThrow('LOCAL_ENDPOINT_MUST_BE_LOOPBACK');
    });

    test('hosted mode rejects local models to prevent SSRF', () => {
      // Ollama / LMStudio rejected in hosted
      expect(() =>
        validateWorkspaceSettings({ model: { preset: 'ollama' } }, undefined, true)
      ).toThrow('LOCAL_MODEL_FORBIDDEN_IN_HOSTED');

      expect(() =>
        validateWorkspaceSettings({ model: { preset: 'lmstudio' } }, undefined, true)
      ).toThrow('LOCAL_MODEL_FORBIDDEN_IN_HOSTED');

      expect(() =>
        validateWorkspaceSettings(
          {
            model: {
              preset: 'custom',
              mode: 'local',
              endpoint: 'http://127.0.0.1:8000',
              model: 'test',
            },
          },
          undefined,
          true
        )
      ).toThrow('LOCAL_MODEL_FORBIDDEN_IN_HOSTED');

      // Cloud preset allowed in hosted
      const hostedCloud = validateWorkspaceSettings(
        { model: { preset: 'openai', apiKey: 'sk-test-key' } },
        undefined,
        true
      );
      expect(hostedCloud.model.mode).toBe('cloud');
    });

    test('API key handling: optional, retain prior when omitted, null/empty clears', () => {
      const prior: AgentWorkspaceSettings = {
        ...defaultWorkspaceSettings(),
        model: {
          mode: 'cloud',
          preset: 'openai',
          endpoint: 'https://api.openai.com/v1/chat/completions',
          model: 'gpt-4o-mini',
          apiKey: 'sk-prior-key',
        },
      };

      // Omitted apiKey retains prior for same preset
      const retained = validateWorkspaceSettings(
        { model: { preset: 'openai', model: 'gpt-4o' } },
        prior
      );
      expect(retained.model.apiKey).toBe('sk-prior-key');

      // Omitted apiKey does NOT retain if preset changed
      const presetChanged = validateWorkspaceSettings(
        { model: { preset: 'groq' } },
        prior
      );
      expect(presetChanged.model.apiKey).toBeUndefined();
      const endpointChanged = validateWorkspaceSettings(
        { model: { preset: 'openai', endpoint: 'https://another-provider.example.com/v1' } }, prior
      );
      expect(endpointChanged.model.apiKey).toBeUndefined();

      // Explicit null clears key
      const clearedNull = validateWorkspaceSettings(
        { model: { preset: 'openai', apiKey: null } },
        prior
      );
      expect(clearedNull.model.apiKey).toBeUndefined();

      // Explicit empty string clears key
      const clearedEmpty = validateWorkspaceSettings(
        { model: { preset: 'openai', apiKey: '   ' } },
        prior
      );
      expect(clearedEmpty.model.apiKey).toBeUndefined();

      // Setting new key
      const updated = validateWorkspaceSettings(
        { model: { preset: 'openai', apiKey: '  sk-new-key  ' } },
        prior
      );
      expect(updated.model.apiKey).toBe('sk-new-key');
    });
  });

  describe('validateWorkspaceSettings - Navigation, Memory, Groups', () => {
    test('navigation defaults to blacklist and validates domains list', () => {
      const settings = validateWorkspaceSettings({
        navigation: {
          mode: 'whitelist',
          domains: ['example.com', 'api.service.org', 'example.com'], // duplicate
        },
      });
      expect(settings.navigation.mode).toBe('whitelist');
      expect(settings.navigation.domains).toEqual(['example.com', 'api.service.org']);
    });

    test('navigation rejects invalid modes and bad domains', () => {
      expect(() =>
        validateWorkspaceSettings({
          navigation: { mode: 'invalid-mode', domains: [] },
        })
      ).toThrow(PolicyError);

      expect(() =>
        validateWorkspaceSettings({
          navigation: { mode: 'whitelist', domains: ['https://example.com'] },
        })
      ).toThrow(PolicyError);
    });

    test('memory disabled by default, bounded to 32KiB', () => {
      const def = validateWorkspaceSettings({});
      expect(def.memory.enabled).toBe(false);
      expect(def.memory.content).toBe('');

      const validMem = validateWorkspaceSettings({
        memory: { enabled: true, content: 'Remember project notes.' },
      });
      expect(validMem.memory.enabled).toBe(true);
      expect(validMem.memory.content).toBe('Remember project notes.');

      expect(() => validateWorkspaceSettings({ memory: { enabled: 'false', content: 'Must not opt in accidentally' } })).toThrow();
      // Exceeding 32 KiB
      const hugeContent = 'a'.repeat(32 * 1024 + 1);
      expect(() =>
        validateWorkspaceSettings({
          memory: { enabled: true, content: hugeContent },
        })
      ).toThrow('MEMORY_LIMIT_EXCEEDED');
    });

    test('groups allows max 32 groups with max 32 variables each', () => {
      const validGroups = validateWorkspaceSettings({
        groups: [
          {
            name: 'Personal Vault',
            variables: ['username', 'email', 'phone'],
          },
        ],
      });
      expect(validGroups.groups).toHaveLength(1);
      expect(validGroups.groups[0]!.name).toBe('Personal Vault');
      expect(validGroups.groups[0]!.variables).toEqual(['username', 'email', 'phone']);

      // Too many groups
      const tooManyGroups = Array.from({ length: 33 }, (_, i) => ({
        name: `Group ${i}`,
        variables: ['var1'],
      }));
      expect(() =>
        validateWorkspaceSettings({ groups: tooManyGroups })
      ).toThrow('GROUPS_LIMIT_EXCEEDED');

      // Too many variables in a group
      const tooManyVars = Array.from({ length: 33 }, (_, i) => `var_${i}`);
      expect(() =>
        validateWorkspaceSettings({
          groups: [{ name: 'Huge Group', variables: tooManyVars }],
        })
      ).toThrow('GROUP_VARIABLES_LIMIT_EXCEEDED');

      // Invalid group name
      expect(() =>
        validateWorkspaceSettings({
          groups: [{ name: '', variables: ['var1'] }],
        })
      ).toThrow('INVALID_GROUP_NAME');
    });
  });

  describe('sanitizeWorkspaceSettingsForState', () => {
    test('never exposes apiKey in state snapshot and sets keyConfigured flag', () => {
      const settings: AgentWorkspaceSettings = {
        model: {
          mode: 'cloud',
          preset: 'openai',
          endpoint: 'https://api.openai.com/v1/chat/completions',
          model: 'gpt-4o-mini',
          apiKey: 'sk-secret-password-1234',
        },
        navigation: { mode: 'blacklist', domains: ['blocked.com'] },
        memory: { enabled: true, content: 'Private memories' },
        groups: [{ id: 'g1', name: 'Work', variables: ['work_email'] }],
      };

      const sanitized = sanitizeWorkspaceSettingsForState(settings);
      expect((sanitized.model as Record<string, unknown>).apiKey).toBeUndefined();
      expect(sanitized.model.keyConfigured).toBe(true);
      expect(sanitized.model.endpoint).toBe('https://api.openai.com/v1/chat/completions');
      expect(sanitized.navigation.domains).toEqual(['blocked.com']);

      const withoutKey: AgentWorkspaceSettings = {
        ...settings,
        model: {
          ...settings.model,
          apiKey: undefined,
        },
      };
      const sanitizedWithoutKey = sanitizeWorkspaceSettingsForState(withoutKey);
      expect((sanitizedWithoutKey.model as Record<string, unknown>).apiKey).toBeUndefined();
      expect(sanitizedWithoutKey.model.keyConfigured).toBe(false);
    });
  });
});
