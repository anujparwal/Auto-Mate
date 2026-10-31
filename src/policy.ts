import { randomUUID } from 'node:crypto';

export type Layer = 'yellow' | 'orange' | 'red';
export type Operation = 'fill' | 'submit';
export type State = 'normal' | 'protected' | 'takeover' | 'completed' | 'stopped';
export type Audit = Readonly<{ sequence: number; task: string; event: string; origin: string; reason?: string }>;
export type GrantRequest = Readonly<{
  task: string; origin: string; credentials: readonly string[];
  operations: readonly Operation[]; durationSeconds: number; maxSubmissions: number;
}>;
type Grant = { request: GrantRequest; deadline: number; remaining: number; epoch: number };

export class PolicyError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PolicyError'; }
}
export function httpsOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new PolicyError('INVALID_ORIGIN'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new PolicyError('INVALID_ORIGIN');
  return url.origin;
}

/** Trusted owner component. Never export this instance into model tool bindings. */
export class PolicyBroker {
  #grants = new Map<string, Grant>();
  #states = new Map<string, State>();
  #blocked = new Set<string>();
  #events: Audit[] = [];
  #epoch = 0;
  constructor(private readonly clock: () => number = () => performance.now()) {}

  approve(input: GrantRequest): string {
    const origin = httpsOrigin(input.origin);
    if (!input.task || !Number.isInteger(input.durationSeconds) || input.durationSeconds < 1 || input.durationSeconds > 900 ||
      !Number.isInteger(input.maxSubmissions) || input.maxSubmissions < 0 || input.maxSubmissions > 1 ||
      !input.credentials.length || input.credentials.some(x => !x) || !input.operations.length ||
      input.operations.some(x => x !== 'fill' && x !== 'submit')) throw new PolicyError('INVALID_GRANT');
    if (this.#blocked.has(origin)) throw new PolicyError('DESTINATION_BLOCKED');
    if (this.#states.has(input.task)) throw new PolicyError('TASK_ALREADY_EXISTS');
    const request = Object.freeze({ ...input, origin, credentials: Object.freeze([...new Set(input.credentials)]), operations: Object.freeze([...new Set(input.operations)]) });
    const handle = randomUUID();
    this.#grants.set(handle, { request, deadline: this.clock() + input.durationSeconds * 1000, remaining: input.maxSubmissions, epoch: this.#epoch });
    this.#states.set(input.task, 'normal');
    this.#record(input.task, 'approved', origin);
    return handle;
  }

  authorize(handle: string, task: string, originInput: string, operation: Operation, credential?: string): void {
    const grant = this.#grants.get(handle);
    let origin = '';
    try {
      origin = httpsOrigin(originInput);
      if (!grant || grant.request.task !== task || grant.epoch !== this.#epoch) throw new PolicyError('INVALID_GRANT');
      if (this.clock() >= grant.deadline) throw new PolicyError('GRANT_EXPIRED');
      if (this.#blocked.has(origin) || origin !== grant.request.origin) throw new PolicyError('DESTINATION_DENIED');
      if (!['normal', 'protected'].includes(this.state(task))) throw new PolicyError('TASK_NOT_ACTIVE');
      if (!grant.request.operations.includes(operation)) throw new PolicyError('OPERATION_DENIED');
      if (operation === 'fill' && (!credential || !grant.request.credentials.includes(credential))) throw new PolicyError('CREDENTIAL_DENIED');
      if (operation === 'submit' && grant.remaining === 0) throw new PolicyError('SUBMISSION_LIMIT');
      if (operation === 'submit') grant.remaining--;
      this.#states.set(task, 'protected');
      this.#record(task, operation === 'fill' ? 'fill_authorized' : 'submit_authorized', origin);
    } catch (error) {
      this.#record(task, 'denied', origin, error instanceof PolicyError ? error.code : 'DENIED');
      throw error;
    }
  }

  state(task: string): State { return this.#states.get(task) ?? 'stopped'; }
  canObserve(task: string): boolean { return this.state(task) === 'normal'; }
  finish(task: string, outcome: 'completed' | 'takeover'): void {
    if (!['normal', 'protected'].includes(this.state(task))) throw new PolicyError('TASK_NOT_ACTIVE');
    this.#states.set(task, outcome);
    this.#record(task, outcome, '');
  }
  revoke(handle: string): void {
    const grant = this.#grants.get(handle);
    if (grant) { this.#states.set(grant.request.task, 'stopped'); this.#record(grant.request.task, 'revoked', grant.request.origin); }
    this.#grants.delete(handle);
  }
  stopAll(): void {
    this.#epoch++;
    this.#grants.clear();
    for (const task of this.#states.keys()) this.#states.set(task, 'stopped');
    this.#record('', 'stopped_all', '');
  }
  block(origin: string): void {
    const normalized = httpsOrigin(origin);
    this.#blocked.add(normalized);
    for (const [handle, grant] of this.#grants) if (grant.request.origin === normalized) this.revoke(handle);
  }
  audit(): readonly Audit[] { return Object.freeze(this.#events.map(event => Object.freeze({ ...event }))); }
  #record(task: string, event: string, origin: string, reason?: string): void {
    this.#events.push(Object.freeze({ sequence: this.#events.length + 1, task, event, origin, ...(reason ? { reason } : {}) }));
  }
}
