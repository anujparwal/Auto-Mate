import {
  type PlannerMode,
  type PlannerConfig,
  type PlannerErrorCode,
  PlannerError,
  validatePlannerConfig,
  parsePlannerConfigFromEnv,
  requestChatCompletion,
} from './model-client';

export type TaskPlan = Readonly<{ workflow: 'synthetic-registration' }>;

export class TaskPlannerError extends PlannerError {
  constructor(message: PlannerErrorCode) {
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
    let validated;
    try {
      validated = validatePlannerConfig(config);
    } catch (err) {
      if (err instanceof PlannerError) {
        throw new TaskPlannerError(err.message);
      }
      throw err;
    }

    this.mode = validated.mode;
    this.model = validated.model;
    this.#endpoint = validated.endpoint;
    this.#apiKey = validated.apiKey;
  }

  static fromEnvironment(
    env: Record<string, string | undefined> = process.env
  ): TaskPlanner {
    try {
      const config = parsePlannerConfigFromEnv(env);
      return new TaskPlanner(config);
    } catch (err) {
      if (err instanceof PlannerError) {
        throw new TaskPlannerError(err.message);
      }
      throw err;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      mode: this.mode,
      ...(this.model ? { model: this.model } : {}),
    };
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

  async #requestChatCompletion(
    prompt: string,
    signal?: AbortSignal
  ): Promise<TaskPlan> {
    let content: string;
    try {
      content = await requestChatCompletion({
        endpoint: this.#endpoint!,
        apiKey: this.#apiKey,
        model: this.model!,
        messages: [
          { role: 'system', content: TaskPlanner.#SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
        signal,
        timeoutMs: TaskPlanner.#TIMEOUT_MS,
        maxStreamBytes: TaskPlanner.#MAX_STREAM_BYTES,
        maxContentChars: TaskPlanner.#MAX_CONTENT_CHARS,
      });
    } catch (err) {
      if (err instanceof PlannerError) {
        throw new TaskPlannerError(err.message);
      }
      throw err;
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
