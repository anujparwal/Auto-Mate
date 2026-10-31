import { randomUUID } from 'node:crypto';

export type Layer = 'yellow' | 'orange' | 'red';
export type Operation = 'fill' | 'submit';
export type State = 'normal' | 'protected' | 'takeover' | 'completed' | 'stopped';
export type Audit = Readonly<{ sequence: number; task: string; event: string; origin: string; reason?: string }>;
export type AuditSink = (event: Audit) => void;
export type GrantRequest = Readonly<{
  task: string; origin: string; credentials: readonly string[];
  layers: readonly Layer[];
  operations: readonly Operation[]; durationSeconds: number; maxSubmissions: number;
}>;
type Grant = {
  handle: string;
  request: GrantRequest;
  deadline: number;
  remaining: number;
  epoch: number;
  controller: AbortController;
  timer?: NodeJS.Timeout;
};

function isValidLayer(value: unknown): value is Layer {
  return value === 'yellow' || value === 'orange' || value === 'red';
}

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
  #catalog = new Map<string, Layer>();
  #grants = new Map<string, Grant>();
  #states = new Map<string, State>();
  #blocked = new Set<string>();
  #events: Audit[] = [];
  #epoch = 0;
  #sink: AuditSink;
  #faulted = false;

  constructor(
    credentials: Readonly<Record<string, Layer>>,
    sink: AuditSink,
    private readonly clock: () => number = () => performance.now(),
  ) {
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
      throw new PolicyError('INVALID_CATALOG');
    }
    for (const [cred, layer] of Object.entries(credentials)) {
      if (!cred || typeof cred !== 'string') throw new PolicyError('INVALID_CATALOG');
      if (!isValidLayer(layer)) throw new PolicyError('INVALID_LAYER');
      this.#catalog.set(cred, layer);
    }
    if (typeof sink !== 'function') {
      throw new PolicyError('INVALID_SINK');
    }
    this.#sink = sink;
  }

  category(credential: string): Layer {
    if (this.#faulted) throw new PolicyError('AUDIT_UNAVAILABLE');
    const layer = this.#catalog.get(credential);
    if (!layer) throw new PolicyError('CREDENTIAL_DENIED');
    return layer;
  }

  setCredentialLayer(credential: string, layer: Layer): void {
    if (this.#faulted) throw new PolicyError('AUDIT_UNAVAILABLE');
    if (!isValidLayer(layer)) throw new PolicyError('INVALID_LAYER');
    const current = this.#catalog.get(credential);
    if (!current) throw new PolicyError('CREDENTIAL_DENIED');
    if (current === layer) return;
    this.#catalog.set(credential, layer);
    const affected: string[] = [];
    for (const [handle, grant] of this.#grants) {
      if (grant.request.credentials.includes(credential)) {
        this.#states.set(grant.request.task, 'stopped');
        affected.push(handle);
      }
    }
    // Every affected task loses authority before any synchronous abort listener runs.
    for (const handle of affected) this.revoke(handle);
  }

  approve(input: GrantRequest): string {
    if (this.#faulted) throw new PolicyError('AUDIT_UNAVAILABLE');
    if (!input || typeof input !== 'object') throw new PolicyError('INVALID_GRANT');
    const origin = httpsOrigin(input.origin);
    if (!input.task || typeof input.task !== 'string' ||
      !Number.isInteger(input.durationSeconds) || input.durationSeconds < 1 || input.durationSeconds > 900 ||
      !Number.isInteger(input.maxSubmissions) || input.maxSubmissions < 0 || input.maxSubmissions > 1 ||
      !Array.isArray(input.credentials) || !input.credentials.length || input.credentials.some(x => typeof x !== 'string' || !x) ||
      !Array.isArray(input.layers) || !input.layers.length || input.layers.some(x => !isValidLayer(x)) ||
      !Array.isArray(input.operations) || !input.operations.length || input.operations.some(x => x !== 'fill' && x !== 'submit'))
      throw new PolicyError('INVALID_GRANT');
    if (this.#blocked.has(origin)) throw new PolicyError('DESTINATION_BLOCKED');
    if (this.#states.has(input.task)) throw new PolicyError('TASK_ALREADY_EXISTS');

    const approvedLayers = new Set<Layer>(input.layers);
    for (const cred of input.credentials) {
      const layer = this.#catalog.get(cred);
      if (!layer) throw new PolicyError('CREDENTIAL_DENIED');
      if (!approvedLayers.has(layer)) throw new PolicyError('CATEGORY_DENIED');
    }

    const request = Object.freeze({
      task: input.task,
      origin,
      credentials: Object.freeze([...new Set(input.credentials)]),
      layers: Object.freeze([...new Set(input.layers)]),
      operations: Object.freeze([...new Set(input.operations)]),
      durationSeconds: input.durationSeconds,
      maxSubmissions: input.maxSubmissions,
    });
    const handle = randomUUID();
    this.#record(input.task, 'approved', origin);
    const controller = new AbortController();
    const grant: Grant = {
      handle,
      request,
      deadline: this.clock() + input.durationSeconds * 1000,
      remaining: input.maxSubmissions,
      epoch: this.#epoch,
      controller,
    };
    this.#grants.set(handle, grant);
    this.#states.set(input.task, 'normal');
    this.#scheduleExpiry(grant);
    return handle;
  }

  denyApproval(task: string, origin: string): void {
    if (this.#faulted) throw new PolicyError('AUDIT_UNAVAILABLE');
    const normalizedOrigin = httpsOrigin(origin);
    if (!task || typeof task !== 'string') throw new PolicyError('INVALID_TASK');
    if (this.#states.has(task)) throw new PolicyError('TASK_ALREADY_EXISTS');

    this.#record(task, 'approval_denied', normalizedOrigin);
    this.#states.set(task, 'stopped');
  }

  authorize(handle: string, task: string, originInput: string, operation: Operation, credential?: string): void {
    if (this.#faulted) throw new PolicyError('AUDIT_UNAVAILABLE');
    const grant = this.#grants.get(handle);
    let origin = '';
    try {
      origin = httpsOrigin(originInput);
      if (!grant || grant.request.task !== task || grant.epoch !== this.#epoch) throw new PolicyError('INVALID_GRANT');
      if (!['normal', 'protected'].includes(this.state(task))) throw new PolicyError('TASK_NOT_ACTIVE');
      if (this.clock() >= grant.deadline) {
        this.#expire(grant);
        throw new PolicyError('GRANT_EXPIRED');
      }
      if (this.#blocked.has(origin) || origin !== grant.request.origin) throw new PolicyError('DESTINATION_DENIED');
      if (!grant.request.operations.includes(operation)) throw new PolicyError('OPERATION_DENIED');

      if (operation === 'fill') {
        if (!credential || !grant.request.credentials.includes(credential)) throw new PolicyError('CREDENTIAL_DENIED');
        const layer = this.#catalog.get(credential);
        if (!layer) throw new PolicyError('CREDENTIAL_DENIED');
        if (!grant.request.layers.includes(layer)) throw new PolicyError('CATEGORY_DENIED');
      }

      if (operation === 'submit') {
        for (const cred of grant.request.credentials) {
          const layer = this.#catalog.get(cred);
          if (!layer) throw new PolicyError('CREDENTIAL_DENIED');
          if (!grant.request.layers.includes(layer)) throw new PolicyError('CATEGORY_DENIED');
        }
        if (grant.remaining === 0) throw new PolicyError('SUBMISSION_LIMIT');
      }
    } catch (error) {
      if (!this.#faulted && !(error instanceof PolicyError && error.code === 'GRANT_EXPIRED')) {
        this.#record(task, 'denied', origin, error instanceof PolicyError ? error.code : 'DENIED');
      }
      throw error;
    }

    this.#record(task, operation === 'fill' ? 'fill_authorized' : 'submit_authorized', origin);

    if (operation === 'submit') {
      grant.remaining--;
    }
    this.#states.set(task, 'protected');
  }
  executionSignal(handle: string, task: string): AbortSignal {
    if (this.#faulted) throw new PolicyError('AUDIT_UNAVAILABLE');
    if (!handle || typeof handle !== 'string' || !task || typeof task !== 'string') {
      throw new PolicyError('INVALID_GRANT');
    }
    const grant = this.#grants.get(handle);
    if (!grant || grant.request.task !== task || grant.epoch !== this.#epoch) {
      throw new PolicyError('INVALID_GRANT');
    }
    if (!['normal', 'protected'].includes(this.state(task))) {
      throw new PolicyError('TASK_NOT_ACTIVE');
    }
    if (this.clock() >= grant.deadline) {
      this.#expire(grant);
      throw new PolicyError('GRANT_EXPIRED');
    }
    return grant.controller.signal;
  }


  state(task: string): State { return this.#states.get(task) ?? 'stopped'; }
  canObserve(task: string): boolean {
    if (this.#faulted) return false;
    return this.state(task) === 'normal';
  }
  finish(task: string, outcome: 'completed' | 'takeover'): void {
    if (this.#faulted) throw new PolicyError('AUDIT_UNAVAILABLE');
    if (!['normal', 'protected'].includes(this.state(task))) throw new PolicyError('TASK_NOT_ACTIVE');
    for (const grant of this.#grants.values()) {
      if (grant.request.task === task) {
        if (grant.timer) {
          clearTimeout(grant.timer);
          grant.timer = undefined;
        }
      }
    }
    this.#states.set(task, outcome);
    this.#record(task, outcome, '');
  }
  revoke(handle: string): void {
    const grant = this.#grants.get(handle);
    if (grant) {
      if (grant.timer) {
        clearTimeout(grant.timer);
        grant.timer = undefined;
      }
      this.#states.set(grant.request.task, 'stopped');
      this.#grants.delete(handle);
      let abortError: unknown;
      try {
        grant.controller.abort();
      } catch (err) {
        abortError = err;
      }
      if (!this.#faulted) {
        try {
          this.#record(grant.request.task, 'revoked', grant.request.origin);
        } catch (auditErr) {
          if (!abortError) abortError = auditErr;
        }
      }
      if (abortError) throw abortError;
    }
  }
  stopAll(): void {
    this.#epoch++;
    const grantsToAbort = [...this.#grants.values()];
    this.#grants.clear();
    for (const grant of grantsToAbort) {
      if (grant.timer) {
        clearTimeout(grant.timer);
        grant.timer = undefined;
      }
    }
    for (const task of this.#states.keys()) this.#states.set(task, 'stopped');
    let firstError: unknown;
    for (const grant of grantsToAbort) {
      try {
        grant.controller.abort();
      } catch (err) {
        if (!firstError) firstError = err;
      }
    }
    if (!this.#faulted) {
      try {
        this.#record('', 'stopped_all', '');
      } catch (err) {
        if (!firstError) firstError = err;
      }
    }
    if (firstError) throw firstError;
  }
  block(origin: string): void {
    const normalized = httpsOrigin(origin);
    this.#blocked.add(normalized);
    for (const [handle, grant] of [...this.#grants.entries()]) {
      if (grant.request.origin === normalized) this.revoke(handle);
    }
  }
  audit(): readonly Audit[] { return Object.freeze(this.#events.map(event => Object.freeze({ ...event }))); }

  #record(task: string, event: string, origin: string, reason?: string): void {
    if (this.#faulted) {
      throw new PolicyError('AUDIT_UNAVAILABLE');
    }
    const auditEvent: Audit = Object.freeze({
      sequence: this.#events.length + 1,
      task,
      event,
      origin,
      ...(reason ? { reason } : {}),
    });
    try {
      const result: unknown = this.#sink(auditEvent);
      if (result !== undefined) {
        if (typeof result === 'object' && result !== null && 'then' in result) {
          const thenFn = result.then;
          if (typeof thenFn === 'function') {
            Promise.resolve(result).catch(() => {});
          }
        }
        this.#fault();
        throw new PolicyError('AUDIT_UNAVAILABLE');
      }
    } catch {
      this.#fault();
      throw new PolicyError('AUDIT_UNAVAILABLE');
    }
    this.#events.push(auditEvent);
  }

  #scheduleExpiry(grant: Grant): void {
    const delay = Math.max(0, grant.deadline - this.clock());
    const timer = setTimeout(() => {
      this.#handleExpiryTimer(grant);
    }, delay);
    timer.unref?.();
    grant.timer = timer;
  }

  #handleExpiryTimer(grant: Grant): void {
    if (this.#faulted || this.#grants.get(grant.handle) !== grant || grant.epoch !== this.#epoch) {
      return;
    }
    if (!['normal', 'protected'].includes(this.state(grant.request.task))) {
      return;
    }
    const now = this.clock();
    if (now < grant.deadline) {
      const delay = Math.max(0, grant.deadline - now);
      const timer = setTimeout(() => {
        this.#handleExpiryTimer(grant);
      }, delay);
      timer.unref?.();
      grant.timer = timer;
      return;
    }
    try {
      this.#expire(grant);
    } catch {
      // Fail-safe: timer callbacks must not leave unhandled errors.
      // An audit failure permanently faults and stops all grants.
    }
  }

  #expire(grant: Grant): void {
    if (grant.timer) {
      clearTimeout(grant.timer);
      grant.timer = undefined;
    }
    this.#states.set(grant.request.task, 'stopped');
    this.#grants.delete(grant.handle);
    let abortError: unknown;
    try {
      grant.controller.abort();
    } catch (err) {
      abortError = err;
    }
    if (!this.#faulted) {
      try {
        this.#record(grant.request.task, 'grant_expired', grant.request.origin, 'GRANT_EXPIRED');
      } catch (auditErr) {
        if (!abortError) abortError = auditErr;
      }
    }
    if (abortError) throw abortError;
  }

  #fault(): void {
    this.#faulted = true;
    this.#epoch++;
    const grantsToAbort = [...this.#grants.values()];
    this.#grants.clear();
    for (const grant of grantsToAbort) {
      if (grant.timer) {
        clearTimeout(grant.timer);
        grant.timer = undefined;
      }
    }
    for (const task of this.#states.keys()) {
      this.#states.set(task, 'stopped');
    }
    for (const grant of grantsToAbort) {
      try {
        grant.controller.abort();
      } catch {
        // Listener errors must not prevent faulting remaining grants
      }
    }
  }
}
