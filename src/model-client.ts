export type PlannerMode = 'reviewed' | 'local' | 'cloud';

export interface PlannerConfig {
  mode: PlannerMode;
  endpoint?: string;
  model?: string;
  apiKey?: string;
}

export type PlannerErrorCode =
  | 'INVALID_TASK'
  | 'INVALID_PLAN_INPUT'
  | 'UNSUPPORTED_TASK'
  | 'PLANNER_UNAVAILABLE'
  | 'PLANNER_INVALID_RESPONSE'
  | 'PLANNER_CONFIGURATION';

export class PlannerError extends Error {
  constructor(public override readonly message: PlannerErrorCode) {
    super(message);
    this.name = 'PlannerError';
  }
}

export interface ValidatedPlannerConfig {
  readonly mode: PlannerMode;
  readonly model?: string;
  readonly endpoint?: string;
  readonly apiKey?: string;
}

export function validatePlannerConfig(config?: PlannerConfig): ValidatedPlannerConfig {
  const mode = config?.mode ?? 'reviewed';
  if (mode !== 'reviewed' && mode !== 'local' && mode !== 'cloud') {
    throw new PlannerError('PLANNER_CONFIGURATION');
  }

  if (mode === 'reviewed') {
    return Object.freeze({
      mode,
      model: config?.model?.trim() || undefined,
    });
  }

  const rawEndpoint = config?.endpoint;
  if (!rawEndpoint || typeof rawEndpoint !== 'string' || rawEndpoint.trim().length === 0) {
    throw new PlannerError('PLANNER_CONFIGURATION');
  }

  const rawModel = config?.model;
  if (!rawModel || typeof rawModel !== 'string' || rawModel.trim().length === 0) {
    throw new PlannerError('PLANNER_CONFIGURATION');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawEndpoint.trim());
  } catch {
    throw new PlannerError('PLANNER_CONFIGURATION');
  }

  if (
    parsedUrl.username !== '' ||
    parsedUrl.password !== '' ||
    parsedUrl.search !== '' ||
    parsedUrl.hash !== ''
  ) {
    throw new PlannerError('PLANNER_CONFIGURATION');
  }

  if (mode === 'cloud') {
    if (parsedUrl.protocol !== 'https:') {
      throw new PlannerError('PLANNER_CONFIGURATION');
    }
    const rawApiKey = config?.apiKey;
    if (rawApiKey !== undefined && (typeof rawApiKey !== 'string' || !rawApiKey.trim())) {
      throw new PlannerError('PLANNER_CONFIGURATION');
    }
    return Object.freeze({
      mode,
      model: rawModel.trim(),
      endpoint: parsedUrl.href,
      apiKey: rawApiKey?.trim(),
    });
  }

  // mode === 'local'
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new PlannerError('PLANNER_CONFIGURATION');
  }
  const hostname = parsedUrl.hostname.toLowerCase();
  const isLoopback =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1';
  if (!isLoopback) {
    throw new PlannerError('PLANNER_CONFIGURATION');
  }

  let apiKey: string | undefined;
  if (config?.apiKey !== undefined) {
    if (typeof config.apiKey !== 'string') {
      throw new PlannerError('PLANNER_CONFIGURATION');
    }
    const trimmed = config.apiKey.trim();
    apiKey = trimmed.length > 0 ? trimmed : undefined;
  }

  return Object.freeze({
    mode,
    model: rawModel.trim(),
    endpoint: parsedUrl.href,
    apiKey,
  });
}

export function parsePlannerConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): PlannerConfig {
  const rawMode = env.AUTOMATE_PLANNER?.trim();
  let mode: PlannerMode = 'reviewed';
  if (rawMode) {
    if (rawMode === 'reviewed' || rawMode === 'local' || rawMode === 'cloud') {
      mode = rawMode;
    } else {
      throw new PlannerError('PLANNER_CONFIGURATION');
    }
  }

  const endpoint = env.AUTOMATE_MODEL_ENDPOINT?.trim();
  const model = env.AUTOMATE_MODEL?.trim();
  const apiKey = env.AUTOMATE_MODEL_API_KEY?.trim();

  return {
    mode,
    endpoint: endpoint || undefined,
    model: model || undefined,
    apiKey: apiKey || undefined,
  };
}

export interface ChatCompletionRequest {
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly messages: readonly {
    readonly role: 'system' | 'user' | 'assistant';
    readonly content: string;
  }[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxStreamBytes?: number;
  readonly maxContentChars?: number;
}

export async function requestChatCompletion(
  options: ChatCompletionRequest
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxStreamBytes = options.maxStreamBytes ?? 32 * 1024;
  const maxContentChars = options.maxContentChars ?? 4096;

  if (options.signal?.aborted) {
    throw new PlannerError('PLANNER_UNAVAILABLE');
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const requestBody = JSON.stringify({
    model: options.model,
    messages: options.messages,
    temperature: options.temperature ?? 0,
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (options.apiKey) {
    headers['Authorization'] = `Bearer ${options.apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(options.endpoint, {
      method: 'POST',
      headers,
      body: requestBody,
      redirect: 'manual',
      signal: combinedSignal,
    });
  } catch {
    throw new PlannerError('PLANNER_UNAVAILABLE');
  }

  if (
    (response.status >= 300 && response.status < 400) ||
    response.redirected ||
    response.type === 'opaqueredirect'
  ) {
    await response.body?.cancel().catch(() => {});
    throw new PlannerError('PLANNER_INVALID_RESPONSE');
  }

  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    if (response.status >= 400) {
      throw new PlannerError('PLANNER_UNAVAILABLE');
    }
    throw new PlannerError('PLANNER_INVALID_RESPONSE');
  }

  if (!response.body) {
    throw new PlannerError('PLANNER_INVALID_RESPONSE');
  }

  const reader = response.body.getReader();
  let totalBytes = 0;
  const chunks: Uint8Array[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxStreamBytes) {
          await reader.cancel().catch(() => {});
          throw new PlannerError('PLANNER_INVALID_RESPONSE');
        }
        chunks.push(value);
      }
    }
  } catch (err) {
    if (err instanceof PlannerError) throw err;
    throw new PlannerError('PLANNER_UNAVAILABLE');
  } finally {
    reader.releaseLock();
  }
  if (combinedSignal.aborted) throw new PlannerError('PLANNER_UNAVAILABLE');

  const bodyBuffer = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBuffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bodyBuffer);
  } catch {
    throw new PlannerError('PLANNER_INVALID_RESPONSE');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new PlannerError('PLANNER_INVALID_RESPONSE');
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PlannerError('PLANNER_INVALID_RESPONSE');
  }

  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new PlannerError('PLANNER_INVALID_RESPONSE');
  }

  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== 'object' || Array.isArray(firstChoice)) {
    throw new PlannerError('PLANNER_INVALID_RESPONSE');
  }

  const message = (firstChoice as Record<string, unknown>).message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new PlannerError('PLANNER_INVALID_RESPONSE');
  }

  const content = (message as Record<string, unknown>).content;
  if (typeof content !== 'string') {
    throw new PlannerError('PLANNER_INVALID_RESPONSE');
  }

  if (content.length > maxContentChars) {
    throw new PlannerError('PLANNER_INVALID_RESPONSE');
  }

  return content;
}
