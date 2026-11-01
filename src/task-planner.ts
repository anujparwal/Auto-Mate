export type PlannerMode = 'reviewed' | 'local' | 'cloud';

export type TaskPlan = Readonly<{ workflow: 'synthetic-registration' }>;

export interface PlannerConfig {
  mode: PlannerMode;
  endpoint?: string;
  model?: string;
  apiKey?: string;
}

export type PlannerErrorCode =
  | 'INVALID_TASK'
  | 'UNSUPPORTED_TASK'
  | 'PLANNER_UNAVAILABLE'
  | 'PLANNER_INVALID_RESPONSE'
  | 'PLANNER_CONFIGURATION';

export class TaskPlannerError extends Error {
  constructor(public override readonly message: PlannerErrorCode) {
    super(message);
    this.name = 'TaskPlannerError';
  }
}

export class TaskPlanner {
  readonly mode: PlannerMode;
  readonly model?: string;

  readonly #endpoint?: string;
  readonly #apiKey?: string;

  static readonly #MAX_STREAM_BYTES = 32 * 1024; // 32KiB
  static readonly #MAX_CONTENT_CHARS = 4096;
  static readonly #TIMEOUT_MS = 30_000;

  static readonly #SYSTEM_PROMPT =
    'You are an automation planning assistant. Your role is to determine if the user request corresponds to the single supported reviewed workflow: "synthetic-registration".\n' +
    'If the user request is asking to perform synthetic registration, respond strictly with JSON: {"workflow":"synthetic-registration"}\n' +
    'If the request is for any other task, is ambiguous, unsupported, or asks for arbitrary actions, respond strictly with JSON: {"workflow":"unsupported"}\n' +
    'Never include explanations, markdown, or extra JSON fields. You do not determine origins, credentials, selectors, or policies.';

  constructor(config?: PlannerConfig) {
    const mode = config?.mode ?? 'reviewed';
    if (mode !== 'reviewed' && mode !== 'local' && mode !== 'cloud') {
      throw new TaskPlannerError('PLANNER_CONFIGURATION');
    }
    this.mode = mode;

    if (mode === 'reviewed') {
      this.model = config?.model;
      this.#endpoint = undefined;
      this.#apiKey = undefined;
      return;
    }

    const rawEndpoint = config?.endpoint;
    if (!rawEndpoint || typeof rawEndpoint !== 'string' || rawEndpoint.trim().length === 0) {
      throw new TaskPlannerError('PLANNER_CONFIGURATION');
    }

    const rawModel = config?.model;
    if (!rawModel || typeof rawModel !== 'string' || rawModel.trim().length === 0) {
      throw new TaskPlannerError('PLANNER_CONFIGURATION');
    }
    this.model = rawModel.trim();

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawEndpoint.trim());
    } catch {
      throw new TaskPlannerError('PLANNER_CONFIGURATION');
    }

    if (
      parsedUrl.username !== '' ||
      parsedUrl.password !== '' ||
      parsedUrl.search !== '' ||
      parsedUrl.hash !== ''
    ) {
      throw new TaskPlannerError('PLANNER_CONFIGURATION');
    }

    if (mode === 'cloud') {
      if (parsedUrl.protocol !== 'https:') {
        throw new TaskPlannerError('PLANNER_CONFIGURATION');
      }
      const rawApiKey = config?.apiKey;
      if (!rawApiKey || typeof rawApiKey !== 'string' || rawApiKey.trim().length === 0) {
        throw new TaskPlannerError('PLANNER_CONFIGURATION');
      }
      this.#apiKey = rawApiKey.trim();
      this.#endpoint = parsedUrl.href;
    } else {
      // mode === 'local'
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new TaskPlannerError('PLANNER_CONFIGURATION');
      }
      const hostname = parsedUrl.hostname.toLowerCase();
      const isLoopback =
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '[::1]' ||
        hostname === '::1';
      if (!isLoopback) {
        throw new TaskPlannerError('PLANNER_CONFIGURATION');
      }

      if (config?.apiKey !== undefined) {
        if (typeof config.apiKey !== 'string') {
          throw new TaskPlannerError('PLANNER_CONFIGURATION');
        }
        const trimmed = config.apiKey.trim();
        this.#apiKey = trimmed.length > 0 ? trimmed : undefined;
      } else {
        this.#apiKey = undefined;
      }
      this.#endpoint = parsedUrl.href;
    }
  }

  static fromEnvironment(env: Record<string, string | undefined> = process.env): TaskPlanner {
    const rawMode = env.AUTOMATE_PLANNER?.trim();
    let mode: PlannerMode = 'reviewed';
    if (rawMode) {
      if (rawMode === 'reviewed' || rawMode === 'local' || rawMode === 'cloud') {
        mode = rawMode;
      } else {
        throw new TaskPlannerError('PLANNER_CONFIGURATION');
      }
    }

    const endpoint = env.AUTOMATE_MODEL_ENDPOINT?.trim();
    const model = env.AUTOMATE_MODEL?.trim();
    const apiKey = env.AUTOMATE_MODEL_API_KEY?.trim();

    return new TaskPlanner({
      mode,
      endpoint: endpoint || undefined,
      model: model || undefined,
      apiKey: apiKey || undefined,
    });
  }

  async plan(prompt: string, signal?: AbortSignal): Promise<TaskPlan> {
    if (
      typeof prompt !== 'string' ||
      prompt.length === 0 ||
      prompt.trim().length === 0 ||
      prompt.length > 2000
    ) {
      throw new TaskPlannerError('INVALID_TASK');
    }

    if (signal?.aborted) {
      throw new TaskPlannerError('PLANNER_UNAVAILABLE');
    }

    if (this.mode === 'reviewed') {
      if (prompt.trim() !== 'Run synthetic registration') {
        throw new TaskPlannerError('UNSUPPORTED_TASK');
      }
      return Object.freeze({ workflow: 'synthetic-registration' });
    }

    return this.#requestChatCompletion(prompt, signal);
  }

  async #requestChatCompletion(prompt: string, signal?: AbortSignal): Promise<TaskPlan> {
    const timeoutSignal = AbortSignal.timeout(TaskPlanner.#TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const requestBody = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: TaskPlanner.#SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (this.#apiKey) {
      headers['Authorization'] = `Bearer ${this.#apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(this.#endpoint!, {
        method: 'POST',
        headers,
        body: requestBody,
        redirect: 'manual',
        signal: combinedSignal,
      });
    } catch {
      throw new TaskPlannerError('PLANNER_UNAVAILABLE');
    }

    if (
      (response.status >= 300 && response.status < 400) ||
      response.redirected ||
      response.type === 'opaqueredirect'
    ) {
      await response.body?.cancel().catch(() => {});
      throw new TaskPlannerError('PLANNER_INVALID_RESPONSE');
    }

    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      if (response.status >= 400) {
        throw new TaskPlannerError('PLANNER_UNAVAILABLE');
      }
      throw new TaskPlannerError('PLANNER_INVALID_RESPONSE');
    }

    if (!response.body) {
      throw new TaskPlannerError('PLANNER_INVALID_RESPONSE');
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
          if (totalBytes > TaskPlanner.#MAX_STREAM_BYTES) {
            await reader.cancel().catch(() => {});
            throw new TaskPlannerError('PLANNER_INVALID_RESPONSE');
          }
          chunks.push(value);
        }
      }
    } catch (err) {
      if (err instanceof TaskPlannerError) throw err;
      throw new TaskPlannerError('PLANNER_UNAVAILABLE');
    } finally {
      reader.releaseLock();
    }
    if (combinedSignal.aborted) throw new TaskPlannerError('PLANNER_UNAVAILABLE');

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
      throw new TaskPlannerError('PLANNER_INVALID_RESPONSE');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new TaskPlannerError('PLANNER_INVALID_RESPONSE');
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TaskPlannerError('PLANNER_INVALID_RESPONSE');
    }

    const choices = (payload as Record<string, unknown>).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new TaskPlannerError('PLANNER_INVALID_RESPONSE');
    }

    const firstChoice = choices[0];
    if (!firstChoice || typeof firstChoice !== 'object' || Array.isArray(firstChoice)) {
      throw new TaskPlannerError('PLANNER_INVALID_RESPONSE');
    }

    const message = (firstChoice as Record<string, unknown>).message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new TaskPlannerError('PLANNER_INVALID_RESPONSE');
    }

    const content = (message as Record<string, unknown>).content;
    if (typeof content !== 'string') {
      throw new TaskPlannerError('PLANNER_INVALID_RESPONSE');
    }

    if (content.length > TaskPlanner.#MAX_CONTENT_CHARS) {
      throw new TaskPlannerError('PLANNER_INVALID_RESPONSE');
    }

    const trimmedContent = content.trim();

    let parsedContent: unknown;
    try {
      parsedContent = JSON.parse(trimmedContent);
    } catch {
      throw new TaskPlannerError('PLANNER_INVALID_RESPONSE');
    }

    if (
      typeof parsedContent !== 'object' ||
      parsedContent === null ||
      Array.isArray(parsedContent)
    ) {
      throw new TaskPlannerError('PLANNER_INVALID_RESPONSE');
    }

    const keys = Object.keys(parsedContent);
    if (keys.length !== 1 || keys[0] !== 'workflow') {
      throw new TaskPlannerError('PLANNER_INVALID_RESPONSE');
    }


    const workflow = (parsedContent as Record<string, unknown>).workflow;
    if (workflow === 'synthetic-registration') {
      return Object.freeze({ workflow: 'synthetic-registration' });
    }

    if (workflow === 'unsupported') {
      throw new TaskPlannerError('UNSUPPORTED_TASK');
    }

    throw new TaskPlannerError('PLANNER_INVALID_RESPONSE');
  }
}
