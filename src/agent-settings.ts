import { randomUUID } from 'node:crypto';
import type {
  AgentWorkspaceSettings,
  ModelProviderPreset,
  ModelSettings,
} from './agent-types';
import { validatePlannerConfig } from './model-client';
import { PolicyError } from './policy';

export const MAX_MEMORY_BYTES = 32 * 1024; // 32 KiB
export const MAX_GROUPS = 32;
export const MAX_GROUP_VARIABLES = 32;

export const PRESET_CONFIGS: Readonly<
  Record<
    Exclude<ModelProviderPreset, 'custom'>,
    { mode: 'cloud' | 'local'; endpoint: string; defaultModel: string }
  >
> = Object.freeze({
  openai: Object.freeze({
    mode: 'cloud',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
  }),
  groq: Object.freeze({
    mode: 'cloud',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'llama-3.3-70b-versatile',
  }),
  openrouter: Object.freeze({
    mode: 'cloud',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct',
  }),
  ollama: Object.freeze({
    mode: 'local',
    endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
    defaultModel: 'llama3.2',
  }),
  lmstudio: Object.freeze({
    mode: 'local',
    endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
    defaultModel: 'qwen2.5-7b-instruct',
  }),
});

export function normalizeChatEndpoint(rawUrl: string): string {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new PolicyError('INVALID_MODEL_ENDPOINT');
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new PolicyError('INVALID_MODEL_ENDPOINT');
  }

  if (parsed.username || parsed.password) {
    throw new PolicyError('INVALID_MODEL_ENDPOINT');
  }
  if (parsed.search) {
    throw new PolicyError('INVALID_MODEL_ENDPOINT');
  }
  if (parsed.hash) {
    throw new PolicyError('INVALID_MODEL_ENDPOINT');
  }

  let cleanPath = parsed.pathname.replace(/\/+$/, '');
  if (cleanPath.endsWith('/v1/chat/completions')) {
    // Already normalized with /v1/chat/completions
  } else if (cleanPath.endsWith('/chat/completions')) {
    // Keep custom versioned paths like /v2/chat/completions
  } else if (cleanPath.endsWith('/v1')) {
    cleanPath += '/chat/completions';
  } else if (cleanPath === '') {
    cleanPath = '/v1/chat/completions';
  } else {
    cleanPath += '/v1/chat/completions';
  }

  parsed.pathname = cleanPath;
  return parsed.toString();
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isLoopbackHost(h)) return true;
  if (h === '0.0.0.0' || h === '::') return true;

  const ipv4Match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (ipv4Match) {
    const oct1 = parseInt(ipv4Match[1]!, 10);
    const oct2 = parseInt(ipv4Match[2]!, 10);
    if (oct1 === 10) return true;
    if (oct1 === 127) return true;
    if (oct1 === 0) return true;
    if (oct1 === 172 && oct2 >= 16 && oct2 <= 31) return true;
    if (oct1 === 192 && oct2 === 168) return true;
    if (oct1 === 169 && oct2 === 254) return true;
    if (oct1 === 100 && oct2 >= 64 && oct2 <= 127) return true;
  }
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) return true;
  return false;
}

export function validateDomain(domain: unknown): string {
  if (typeof domain !== 'string') {
    throw new PolicyError('INVALID_DOMAIN');
  }
  const trimmed = domain.trim().toLowerCase();
  if (
    !trimmed ||
    trimmed.length > 253 ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes(':') ||
    trimmed.includes('?') ||
    trimmed.includes('#') ||
    trimmed.includes('@') ||
    trimmed.includes('*') ||
    trimmed.includes(' ') ||
    trimmed.startsWith('.') ||
    trimmed.endsWith('.')
  ) {
    throw new PolicyError('INVALID_DOMAIN');
  }

  const labels = trimmed.split('.');
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) {
      throw new PolicyError('INVALID_DOMAIN');
    }
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
      throw new PolicyError('INVALID_DOMAIN');
    }
  }
  return trimmed;
}

export function validateNavigation(
  nav: unknown,
  previous?: AgentWorkspaceSettings['navigation']
): AgentWorkspaceSettings['navigation'] {
  if (nav === undefined) {
    return previous ? { mode: previous.mode, domains: [...previous.domains] } : { mode: 'blacklist', domains: [] };
  }
  if (!nav || typeof nav !== 'object') {
    throw new PolicyError('INVALID_NAVIGATION');
  }
  const raw = nav as Record<string, unknown>;
  const mode = raw.mode !== undefined ? raw.mode : (previous?.mode ?? 'blacklist');
  if (mode !== 'whitelist' && mode !== 'blacklist') {
    throw new PolicyError('INVALID_NAVIGATION_MODE');
  }

  const rawDomains = raw.domains !== undefined ? raw.domains : (previous?.domains ?? []);
  if (!Array.isArray(rawDomains)) {
    throw new PolicyError('INVALID_DOMAINS');
  }

  const seen = new Set<string>();
  const validatedDomains: string[] = [];
  for (const d of rawDomains) {
    const valid = validateDomain(d);
    if (!seen.has(valid)) {
      seen.add(valid);
      validatedDomains.push(valid);
    }
  }

  return { mode, domains: validatedDomains };
}

export function validateMemory(
  mem: unknown,
  previous?: AgentWorkspaceSettings['memory']
): AgentWorkspaceSettings['memory'] {
  if (mem === undefined) {
    return previous ? { enabled: previous.enabled, content: previous.content } : { enabled: false, content: '' };
  }
  if (!mem || typeof mem !== 'object') {
    throw new PolicyError('INVALID_MEMORY');
  }
  const raw = mem as Record<string, unknown>;
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new PolicyError('INVALID_MEMORY');
  const enabled = raw.enabled !== undefined ? raw.enabled as boolean : (previous?.enabled ?? false);
  const content = raw.content !== undefined ? raw.content : (previous?.content ?? '');
  if (typeof content !== 'string') {
    throw new PolicyError('INVALID_MEMORY');
  }
  if (Buffer.byteLength(content, 'utf-8') > MAX_MEMORY_BYTES) {
    throw new PolicyError('MEMORY_LIMIT_EXCEEDED');
  }
  return { enabled, content };
}

export function validateGroups(
  groups: unknown,
  previous?: AgentWorkspaceSettings['groups']
): AgentWorkspaceSettings['groups'] {
  if (groups === undefined) {
    return previous ? previous.map((g) => ({ id: g.id, name: g.name, variables: [...g.variables] })) : [];
  }
  if (!Array.isArray(groups)) {
    throw new PolicyError('INVALID_GROUPS');
  }
  if (groups.length > MAX_GROUPS) {
    throw new PolicyError('GROUPS_LIMIT_EXCEEDED');
  }

  const validated: { id: string; name: string; variables: string[] }[] = [];
  const seenGroupIds = new Set<string>();

  for (const g of groups) {
    if (!g || typeof g !== 'object') {
      throw new PolicyError('INVALID_GROUP');
    }
    const raw = g as Record<string, unknown>;
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : randomUUID();
    if (seenGroupIds.has(id)) {
      throw new PolicyError('DUPLICATE_GROUP_ID');
    }
    seenGroupIds.add(id);

    if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.trim().length > 64) {
      throw new PolicyError('INVALID_GROUP_NAME');
    }
    const name = raw.name.trim();

    if (!Array.isArray(raw.variables)) {
      throw new PolicyError('INVALID_GROUP_VARIABLES');
    }
    if (raw.variables.length > MAX_GROUP_VARIABLES) {
      throw new PolicyError('GROUP_VARIABLES_LIMIT_EXCEEDED');
    }

    const seenVars = new Set<string>();
    const variables: string[] = [];
    for (const v of raw.variables) {
      if (typeof v !== 'string' || !v.trim() || v.trim().length > 128) {
        throw new PolicyError('INVALID_VARIABLE_NAME');
      }
      const trimmedV = v.trim();
      if (!seenVars.has(trimmedV)) {
        seenVars.add(trimmedV);
        variables.push(trimmedV);
      }
    }

    validated.push({ id, name, variables });
  }

  return validated;
}

export function validateModelSettings(
  input: unknown,
  previous?: ModelSettings,
  hosted?: boolean
): ModelSettings {
  if (input === undefined) {
    if (previous) return { ...previous };
    throw new PolicyError('INVALID_MODEL_SETTINGS');
  }
  if (!input || typeof input !== 'object') {
    throw new PolicyError('INVALID_MODEL_SETTINGS');
  }

  const raw = input as Record<string, unknown>;

  const preset = (raw.preset !== undefined ? raw.preset : previous?.preset) as ModelProviderPreset | undefined;
  if (
    preset !== 'openai' &&
    preset !== 'groq' &&
    preset !== 'openrouter' &&
    preset !== 'ollama' &&
    preset !== 'lmstudio' &&
    preset !== 'custom'
  ) {
    throw new PolicyError('INVALID_MODEL_PRESET');
  }

  let mode: 'local' | 'cloud';
  if (preset === 'custom') {
    const rawMode = raw.mode !== undefined ? raw.mode : (previous?.preset === 'custom' ? previous.mode : undefined);
    if (rawMode !== 'local' && rawMode !== 'cloud') {
      throw new PolicyError('INVALID_MODEL_MODE');
    }
    mode = rawMode;
  } else {
    mode = PRESET_CONFIGS[preset].mode;
    if (raw.mode !== undefined && raw.mode !== mode) {
      throw new PolicyError('INVALID_MODEL_MODE');
    }
  }

  if (hosted && mode === 'local') {
    throw new PolicyError('LOCAL_MODEL_FORBIDDEN_IN_HOSTED');
  }

  let rawEndpoint: string;
  if (raw.endpoint !== undefined && typeof raw.endpoint === 'string' && raw.endpoint.trim()) {
    rawEndpoint = raw.endpoint.trim();
  } else if (previous?.preset === preset && previous?.endpoint) {
    rawEndpoint = previous.endpoint;
  } else if (preset !== 'custom') {
    rawEndpoint = PRESET_CONFIGS[preset].endpoint;
  } else {
    throw new PolicyError('INVALID_MODEL_ENDPOINT');
  }

  const normalizedEndpoint = normalizeChatEndpoint(rawEndpoint);
  const parsedUrl = new URL(normalizedEndpoint);

  if (mode === 'cloud') {
    if (parsedUrl.protocol !== 'https:') {
      throw new PolicyError('CLOUD_ENDPOINT_REQUIRES_HTTPS');
    }
    if (isPrivateOrLocalHost(parsedUrl.hostname)) {
      throw new PolicyError('CLOUD_ENDPOINT_CANNOT_BE_PRIVATE');
    }
  } else {
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new PolicyError('INVALID_LOCAL_ENDPOINT_PROTOCOL');
    }
    if (!isLoopbackHost(parsedUrl.hostname)) {
      throw new PolicyError('LOCAL_ENDPOINT_MUST_BE_LOOPBACK');
    }
  }

  let model: string;
  if (raw.model !== undefined && typeof raw.model === 'string' && raw.model.trim()) {
    model = raw.model.trim();
  } else if (previous?.preset === preset && previous?.model) {
    model = previous.model;
  } else if (preset !== 'custom') {
    model = PRESET_CONFIGS[preset].defaultModel;
  } else {
    throw new PolicyError('INVALID_MODEL');
  }

  let apiKey: string | undefined;
  if (raw.apiKey === null || (typeof raw.apiKey === 'string' && raw.apiKey.trim() === '')) {
    apiKey = undefined;
  } else if (typeof raw.apiKey === 'string' && raw.apiKey.trim().length > 0) {
    apiKey = raw.apiKey.trim();
  } else if (raw.apiKey === undefined) {
    if (previous && previous.preset === preset && previous.endpoint === normalizedEndpoint) {
      apiKey = previous.apiKey;
    } else {
      apiKey = undefined;
    }
  } else {
    throw new PolicyError('INVALID_API_KEY');
  }

  try {
    validatePlannerConfig({
      mode,
      endpoint: normalizedEndpoint,
      model,
      apiKey,
    });
  } catch (err) {
    if (err instanceof PolicyError) throw err;
    throw new PolicyError('PLANNER_CONFIGURATION');
  }

  return {
    mode,
    preset,
    endpoint: normalizedEndpoint,
    model,
    ...(apiKey !== undefined ? { apiKey } : {}),
  };
}

export function defaultWorkspaceSettings(): AgentWorkspaceSettings {
  return {
    model: {
      mode: 'cloud',
      preset: 'openai',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4o-mini',
    },
    navigation: {
      mode: 'blacklist',
      domains: [],
    },
    memory: {
      enabled: false,
      content: '',
    },
    groups: [],
  };
}

export function validateWorkspaceSettings(
  input: unknown,
  previous?: AgentWorkspaceSettings,
  hosted?: boolean
): AgentWorkspaceSettings {
  if (input === undefined || input === null) {
    if (previous) {
      if (hosted && previous.model.mode === 'local') {
        throw new PolicyError('LOCAL_MODEL_FORBIDDEN_IN_HOSTED');
      }
      return previous;
    }
    const def = defaultWorkspaceSettings();
    if (hosted && def.model.mode === 'local') {
      throw new PolicyError('LOCAL_MODEL_FORBIDDEN_IN_HOSTED');
    }
    return def;
  }

  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new PolicyError('INVALID_SETTINGS');
  }

  const raw = input as Record<string, unknown>;

  const modelInput = raw.model !== undefined ? raw.model : previous?.model;
  if (!modelInput && !previous?.model) {
    // If no model given at all, use default
    raw.model = defaultWorkspaceSettings().model;
  }

  const model = validateModelSettings(raw.model, previous?.model, hosted);
  const navigation = validateNavigation(raw.navigation, previous?.navigation);
  const memory = validateMemory(raw.memory, previous?.memory);
  const groups = validateGroups(raw.groups, previous?.groups);

  return {
    model,
    navigation,
    memory,
    groups,
  };
}

export function sanitizeWorkspaceSettingsForState(
  settings: AgentWorkspaceSettings
): Omit<AgentWorkspaceSettings, 'model'> & {
  model: Omit<ModelSettings, 'apiKey'> & { keyConfigured: boolean };
} {
  const { apiKey, ...modelRest } = settings.model;
  return {
    navigation: {
      mode: settings.navigation.mode,
      domains: [...settings.navigation.domains],
    },
    memory: {
      enabled: settings.memory.enabled,
      content: settings.memory.content,
    },
    groups: settings.groups.map((g) => ({
      id: g.id,
      name: g.name,
      variables: [...g.variables],
    })),
    model: {
      ...modelRest,
      keyConfigured: typeof apiKey === 'string' && apiKey.trim().length > 0,
    },
  };
}
