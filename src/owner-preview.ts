import type { Browser, BrowserContext, Page } from 'playwright';
import { captureOwnerFrame } from './preview-capture';
import type { Annotation, FieldRequest, PreviewPhase, VerifiedField, WorkflowObserver } from './preview-contract';
import { httpsOrigin, type Layer } from './policy';
import { LocalAuditHistory, HistoryError, type HistoryErrorCode, isValidUuid } from './audit-history';
import { setTimeout as delay } from 'node:timers/promises';
import type { TaskPlanner } from './task-planner';

declare global {
  interface Window {
    autoMateOwnerUpdate: (data: unknown) => void;
    autoMateAuditHistory?: (command: unknown) => Promise<unknown>;
    autoMateOwnerCommand?: (command: unknown) => Promise<void>;
    autoMatePlanTask?: (command: unknown) => Promise<void>;
  }
}

const OWNER_ORIGIN = 'https://owner-preview.auto-mate.invalid';

function isTerminal(phase: PreviewPhase | 'ready'): boolean {
  return phase === 'completed' || phase === 'takeover' || phase === 'stopped' || phase === 'denied';
}

export type OwnerApprovalSummary = Readonly<{
  origin: string;
  credentials: readonly Readonly<{ name: string; category: Layer }>[];
}>;

export type OwnerApprovalChoice = Readonly<{
  layers: readonly Layer[];
  durationSeconds: number;
}>;

export type OwnerOptions = Readonly<{
  approval: OwnerApprovalSummary;
  history: LocalAuditHistory;
  planner?: TaskPlanner;
  onApprove: (approval: OwnerApprovalChoice) => void;
  onDeny: () => void;
  onStop: () => void;
  onFault: () => void;
  demoDelayMs?: number;
}>;

export type SafeRequest = Pick<FieldRequest, 'id' | 'name' | 'category'>;

const VALID_LAYERS: Record<Layer, true> = { yellow: true, orange: true, red: true };

function validateAndFreezeApprovalSummary(summary: unknown): OwnerApprovalSummary {
  if (typeof summary !== 'object' || summary === null || Array.isArray(summary)) {
    throw new Error('INVALID_APPROVAL_SUMMARY');
  }
  if (!('origin' in summary) || typeof summary.origin !== 'string' || !summary.origin) {
    throw new Error('INVALID_APPROVAL_SUMMARY');
  }
  let origin: string;
  try {
    origin = httpsOrigin(summary.origin);
  } catch {
    throw new Error('INVALID_APPROVAL_SUMMARY');
  }
  if (!('credentials' in summary) || !Array.isArray(summary.credentials) || !summary.credentials.length) {
    throw new Error('INVALID_APPROVAL_SUMMARY');
  }
  const credentials = summary.credentials.map(c => {
    if (typeof c !== 'object' || c === null || Array.isArray(c)) {
      throw new Error('INVALID_APPROVAL_SUMMARY');
    }
    if (!('name' in c) || typeof c.name !== 'string' || !c.name.trim()) {
      throw new Error('INVALID_APPROVAL_SUMMARY');
    }
    if (!('category' in c) || typeof c.category !== 'string' || !Object.hasOwn(VALID_LAYERS, c.category)) {
      throw new Error('INVALID_APPROVAL_SUMMARY');
    }
    return Object.freeze({
      name: c.name.trim(),
      category: c.category as Layer,
    });
  });
  return Object.freeze({
    origin,
    credentials: Object.freeze(credentials),
  });
}

type ApproveCommand = {
  readonly action: 'approve';
  readonly layers: readonly Layer[];
  readonly durationSeconds: 60 | 300 | 900;
};
type DenyCommand = { readonly action: 'deny' };
type StopCommand = { readonly action: 'stop' };
type OwnerCommand = ApproveCommand | DenyCommand | StopCommand;

function parseOwnerCommand(raw: unknown): OwnerCommand {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('OWNER_COMMAND_DENIED');
  }
  const keys = Object.keys(raw);

  if ('action' in raw && raw.action === 'approve') {
    if (keys.length !== 3 || !('layers' in raw) || !('durationSeconds' in raw)) {
      throw new Error('OWNER_COMMAND_DENIED');
    }
    if (!Array.isArray(raw.layers) || raw.layers.length === 0) {
      throw new Error('OWNER_COMMAND_DENIED');
    }
    const seen = new Set<Layer>();
    for (const item of raw.layers) {
      if (typeof item !== 'string' || !Object.hasOwn(VALID_LAYERS, item)) {
        throw new Error('OWNER_COMMAND_DENIED');
      }
      seen.add(item as Layer);
    }
    const dur = raw.durationSeconds;
    if (typeof dur !== 'number' || (dur !== 60 && dur !== 300 && dur !== 900)) {
      throw new Error('OWNER_COMMAND_DENIED');
    }
    return {
      action: 'approve',
      layers: Object.freeze(Array.from(seen)),
      durationSeconds: dur,
    };
  }

  if ('action' in raw && raw.action === 'deny') {
    if (keys.length !== 1) throw new Error('OWNER_COMMAND_DENIED');
    return { action: 'deny' };
  }

  if ('action' in raw && raw.action === 'stop') {
    if (keys.length !== 1) throw new Error('OWNER_COMMAND_DENIED');
    return { action: 'stop' };
  }

  throw new Error('OWNER_COMMAND_DENIED');
}

const VALID_HISTORY_CODES: Record<HistoryErrorCode, true> = {
  INVALID_HISTORY_REQUEST: true,
  HISTORY_INVALID: true,
  HISTORY_TOO_LARGE: true,
  HISTORY_LIMIT: true,
  HISTORY_UNAVAILABLE: true,
};

type AuditHistorySessionsCommand = {
  readonly action: 'sessions';
  readonly offset: number;
};

type AuditHistoryEventsCommand = {
  readonly action: 'events';
  readonly id: string;
  readonly offset: number;
};

type AuditHistoryCommand = AuditHistorySessionsCommand | AuditHistoryEventsCommand;

function parseAuditHistoryCommand(raw: unknown): AuditHistoryCommand | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj: Record<string, unknown> = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (!Object.hasOwn(obj, 'action') || typeof obj.action !== 'string') {
    return null;
  }
  const action = obj.action;
  if (action === 'sessions') {
    if (keys.length !== 2) return null;
    if (!Object.hasOwn(obj, 'offset')) return null;
    const offset = obj.offset;
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || Object.is(offset, -0)) {
      return null;
    }
    return { action: 'sessions', offset };
  }
  if (action === 'events') {
    if (keys.length !== 3) return null;
    if (!Object.hasOwn(obj, 'id') || !Object.hasOwn(obj, 'offset')) return null;
    const id = obj.id;
    const offset = obj.offset;
    if (!isValidUuid(id)) {
      return null;
    }
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || Object.is(offset, -0)) {
      return null;
    }
    return { action: 'events', id, offset };
  }
  return null;
}

/** Trusted local owner channel. No listener, no HTTP server, no model-visible browser handle. */
export class OwnerPreview implements WorkflowObserver {
  #worker?: Page;
  #origin = '';
  #fields: readonly VerifiedField[] = [];
  #evidence: readonly Pick<Annotation, 'id' | 'sourceText' | 'association'>[] = [];
  #requests: readonly SafeRequest[] = [];
  #fieldStates: Record<string, PreviewPhase> = Object.create(null);
  #events: string[] = [];
  #phase: PreviewPhase | 'ready' = 'ready';
  #timer?: NodeJS.Timeout;
  #pending?: Promise<void>;
  #scene = 0;
  #failed = false;
  #closed = false;
  #started = false;
  #approval: OwnerApprovalSummary;
  #history: LocalAuditHistory;
  #approvalError?: string;
  #planReady = false;
  #planning = false;
  #plannerAbort?: AbortController;
  #plannerError?: string;
  #closure = Promise.withResolvers<void>();
  readonly closed = this.#closure.promise;

  private constructor(readonly page: Page, private context: BrowserContext, private options: OwnerOptions, approval: OwnerApprovalSummary) {
    this.#approval = approval;
    this.#history = options.history;
    this.#origin = approval.origin;
    this.#planReady = !options.planner;
  }

  static async open(browser: Browser, options: OwnerOptions): Promise<OwnerPreview> {
    const approval = validateAndFreezeApprovalSummary(options.approval);
    if (
      !options.history ||
      typeof options.history !== 'object' ||
      typeof options.history.sessions !== 'function' ||
      typeof options.history.events !== 'function'
    ) {
      throw new Error('INVALID_OWNER_OPTIONS');
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 920 }, acceptDownloads: false, serviceWorkers: 'block' });
    try {
      const assets = new Map<string, { contentType: string; body: string }>();
      for (const [path, file, contentType] of [
        ['/', 'owner-preview.html', 'text/html; charset=utf-8'],
        ['/owner-preview.css', 'owner-preview.css', 'text/css; charset=utf-8'],
        ['/owner-preview.js', 'owner-preview.js', 'text/javascript; charset=utf-8'],
      ] as const) assets.set(path, { body: await Bun.file(new URL('../ui/' + file, import.meta.url)).text(), contentType });
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        const asset = url.origin === OWNER_ORIGIN ? assets.get(url.pathname) : undefined;
        if (!asset || route.request().method() !== 'GET') { await route.abort('blockedbyclient'); return; }
        await route.fulfill({ ...asset, headers: {
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        } });
      });
      const page = await context.newPage();
      const preview = new OwnerPreview(page, context, options, approval);
      await page.exposeBinding('autoMatePlanTask', async (source, raw: unknown) => {
        if (source.page !== page || source.frame !== page.mainFrame() || new URL(page.url()).origin !== OWNER_ORIGIN)
          throw new Error('OWNER_COMMAND_DENIED');
        if (!options.planner || preview.#started || preview.#planReady || preview.#planning || preview.#closed || isTerminal(preview.#phase))
          throw new Error('OWNER_COMMAND_DENIED');
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 2 ||
          !('prompt' in raw) || typeof raw.prompt !== 'string' || !raw.prompt.trim() || raw.prompt.length > 2000 ||
          !('allowCloud' in raw) || typeof raw.allowCloud !== 'boolean')
          throw new Error('OWNER_COMMAND_DENIED');
        if (options.planner.mode === 'cloud' && !raw.allowCloud)
          throw new Error('OWNER_COMMAND_DENIED');
        const controller = new AbortController();
        preview.#plannerAbort = controller;
        preview.#planning = true;
        preview.#plannerError = undefined;
        try {
          await preview.#publish();
          const plan = await options.planner.plan(raw.prompt, controller.signal);
          if (controller.signal.aborted || preview.#closed || isTerminal(preview.#phase)) return;
          if (plan.workflow !== 'synthetic-registration') throw new Error('PLANNER_INVALID_RESPONSE');
          preview.#planReady = true;
          preview.#events.push('Reviewed synthetic registration selected. Owner category approval is still required.');
        } catch (error) {
          if (controller.signal.aborted || preview.#closed || isTerminal(preview.#phase)) return;
          const code = error instanceof Error ? error.message : '';
          preview.#plannerError = code === 'UNSUPPORTED_TASK'
            ? 'Unsupported task. This prototype supports synthetic registration only.'
            : code === 'INVALID_TASK' ? 'Enter a task of at most 2,000 characters.'
            : code === 'PLANNER_INVALID_RESPONSE' ? 'The model returned an invalid plan. No execution was authorized.'
            : 'Planner unavailable. Check the local provider configuration and try again.';
        } finally {
          preview.#planning = false;
          if (preview.#plannerAbort === controller) preview.#plannerAbort = undefined;
          if (!preview.#closed) await preview.#publish().catch(() => {});
        }
      });
      await page.exposeBinding('autoMateOwnerCommand', async (source, rawCommand: unknown) => {
        if (source.page !== page || source.frame !== page.mainFrame() || new URL(page.url()).origin !== OWNER_ORIGIN)
          throw new Error('OWNER_COMMAND_DENIED');
        const cmd = parseOwnerCommand(rawCommand);

        if (cmd.action === 'approve') {
          if (preview.#started || !preview.#planReady || preview.#planning || isTerminal(preview.#phase)) {
            throw new Error('OWNER_COMMAND_DENIED');
          }
          preview.#started = true;
          preview.#approvalError = undefined;
          try {
            const result: unknown = options.onApprove({
              layers: cmd.layers,
              durationSeconds: cmd.durationSeconds,
            });
            if (result !== undefined) {
              if (typeof result === 'object' && result !== null && 'then' in result) {
                void Promise.resolve(result).catch(() => {});
              }
              throw new Error('ASYNC_APPROVAL_UNSUPPORTED');
            }
            await preview.#publish();
          } catch (err: unknown) {
            // Only a scope rejection is retryable; other faults terminate this owner task.
            let code = '';
            if (err && typeof err === 'object') {
              if ('code' in err && typeof err.code === 'string') {
                code = err.code;
              } else if ('message' in err && typeof err.message === 'string') {
                code = err.message;
              }
            }

            if (code === 'CATEGORY_DENIED') {
              preview.#started = false;
              preview.#approvalError = 'Choose every requested category to run the task.';
            } else if (code === 'AUDIT_UNAVAILABLE') {
              preview.#approvalError = 'Local audit unavailable; no task started.';
              try { options.onFault(); } catch {}
            } else {
              preview.#approvalError = 'Task authorization unavailable; no task started.';
              try { options.onFault(); } catch {}
            }
            if (code !== 'CATEGORY_DENIED') {
              await preview.state('takeover');
              return;
            }
            await preview.#publish();
          }
        } else if (cmd.action === 'deny') {
          if (preview.#started || isTerminal(preview.#phase)) {
            throw new Error('OWNER_COMMAND_DENIED');
          }
          preview.#phase = 'denied';
          preview.#plannerAbort?.abort();
          preview.#started = true;
          preview.#stopTimer();
          preview.#fields = [];
          preview.#scene++;
          preview.#events.push('Owner denied the task. No credential access granted.');
          preview.#events = preview.#events.slice(-30);
          try {
            options.onDeny();
          } catch {
            preview.#approvalError = 'Task denied; local audit could not confirm the event.';
          }
          await preview.#publish();
        } else if (cmd.action === 'stop') {
          if ((!preview.#started && !preview.#planning) || isTerminal(preview.#phase)) {
            throw new Error('OWNER_COMMAND_DENIED');
          }
          preview.#plannerAbort?.abort();
          try {
            options.onStop();
          } catch {}
          await preview.state('stopped');
        }
      });
      await page.exposeBinding('autoMateAuditHistory', async (source, rawCommand: unknown) => {
        if (source.page !== page || source.frame !== page.mainFrame() || new URL(page.url()).origin !== OWNER_ORIGIN)
          throw new Error('OWNER_COMMAND_DENIED');
        const cmd = parseAuditHistoryCommand(rawCommand);
        if (!cmd) {
          return { ok: false, code: 'INVALID_HISTORY_REQUEST' } as const;
        }
        try {
          if (cmd.action === 'sessions') {
            const pageData = await preview.#history.sessions(cmd.offset);
            return { ok: true, kind: 'sessions', page: pageData } as const;
          } else {
            const pageData = await preview.#history.events(cmd.id, cmd.offset);
            return { ok: true, kind: 'events', page: pageData } as const;
          }
        } catch (err: unknown) {
          let code: HistoryErrorCode = 'HISTORY_UNAVAILABLE';
          if (err instanceof HistoryError && Object.hasOwn(VALID_HISTORY_CODES, err.code)) {
            code = err.code;
          } else if (
            err &&
            typeof err === 'object' &&
            'code' in err &&
            typeof err.code === 'string' &&
            Object.hasOwn(VALID_HISTORY_CODES, err.code)
          ) {
            code = err.code as HistoryErrorCode;
          }
          return { ok: false, code } as const;
        }
      });
      page.on('popup', popup => { void popup.close(); });
      page.on('close', () => {
        preview.#closed = true;
        preview.#plannerAbort?.abort();
        preview.#stopTimer();
        if (!isTerminal(preview.#phase)) {
          try { options.onStop(); } catch {}
        }
        preview.#closure.resolve();
      });
      await page.goto(OWNER_ORIGIN, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.autoMateOwnerUpdate === 'function');
      await preview.#publish();
      return preview;
    } catch {
      await context.close().catch(() => {});
      throw new Error('OWNER_PREVIEW_UNAVAILABLE');
    }
  }

  async requested(page: Page, origin: string, requests: readonly FieldRequest[]): Promise<void> {
    if (isTerminal(this.#phase)) throw new Error('OWNER_TASK_NOT_ACTIVE');
    if (this.#closed || this.#failed) throw new Error('OWNER_PREVIEW_UNAVAILABLE');
    this.#worker = page; this.#origin = origin; this.#fields = []; this.#scene++;
    this.#evidence = [];
    this.#requests = requests.map(({ id, name, category }) => ({ id, name, category }));
    for (const request of requests) this.#fieldStates[request.id] = 'requested';
    this.#phase = 'requested';
    this.#events.push('Website loaded. Checking requesting text against target fields.');
    await this.#publish();
    await this.#capture();
    this.#schedule();
  }

  async verified(page: Page, origin: string, fields: readonly VerifiedField[]): Promise<void> {
    if (isTerminal(this.#phase)) throw new Error('OWNER_TASK_NOT_ACTIVE');
    if (this.#closed || this.#failed) throw new Error('OWNER_PREVIEW_UNAVAILABLE');
    this.#worker = page; this.#origin = origin; this.#fields = fields; this.#scene++;
    this.#evidence = fields.map(field => ({ id: field.request.id, sourceText: field.sourceText, association: field.association }));
    for (const field of fields) this.#fieldStates[field.request.id] = 'verified';
    this.#phase = 'verified';
    this.#events.push('Deterministic code verified the label-to-field associations.');
    await this.#publish();
    await this.#capture();
    await this.#demoDelay();
  }

  async state(phase: PreviewPhase, fieldId?: string): Promise<void> {
    if (this.#closed) throw new Error('OWNER_PREVIEW_UNAVAILABLE');
    if (this.#failed && phase === 'stopped') phase = 'takeover';
    if (this.#phase === 'stopped' && phase !== 'stopped') throw new Error('OWNER_TASK_STOPPED');
    if (this.#phase === 'denied') throw new Error('OWNER_TASK_STOPPED');
    if (this.#failed && !isTerminal(phase)) throw new Error('OWNER_PREVIEW_UNAVAILABLE');
    this.#phase = phase;
    const request = this.#requests.find(item => item.id === fieldId);
    if (request) this.#fieldStates[request.id] = phase;
    if (phase === 'takeover' || phase === 'stopped' || phase === 'denied') {
      for (const item of this.#requests) if (this.#fieldStates[item.id] !== 'filled') this.#fieldStates[item.id] = phase;
    }
    const messages: Partial<Record<PreviewPhase, string>> = {
      filling: `${request?.name ?? 'Protected field'}: preparing fill; authorization rechecked before insertion.`,
      filled: `${request?.name ?? 'Protected field'}: filled. Value hidden in the observer.`,
      submitting: 'Submitting the approved registration.',
      completed: 'Registration completed. Closing the protected browser.',
      takeover: 'Association or execution could not be verified. No further credential use permitted.',
      stopped: 'Task stopped. Further authorization revoked; the protected browser is closing.',
      denied: 'Owner denied the task. No credential access granted.',
    };
    if (messages[phase]) this.#events.push(messages[phase]!);
    this.#events = this.#events.slice(-30);
    if (phase === 'submitting' || isTerminal(phase)) { this.#fields = []; this.#scene++; }
    if (phase === 'submitting' || isTerminal(phase)) this.#stopTimer();
    await this.#publish();
    if (!this.#failed && phase !== 'stopped' && phase !== 'takeover' && phase !== 'denied') await this.#capture();
    if (!isTerminal(phase)) await this.#demoDelay();
  }

  async close(): Promise<void> {
    this.#plannerAbort?.abort();
    if (!this.#closed && !isTerminal(this.#phase)) {
      try { this.options.onStop(); } catch {}
    }
    this.#closed = true;
    this.#stopTimer();
    try { await this.context.close(); }
    catch { throw new Error('OWNER_PREVIEW_UNAVAILABLE'); }
    finally { this.#closure.resolve(); }
  }

  async #demoDelay(): Promise<void> {
    const duration = this.options.demoDelayMs ?? 0;
    if (duration > 0) await delay(duration);
    if (this.#failed || this.#closed || isTerminal(this.#phase)) throw new Error('OWNER_PREVIEW_UNAVAILABLE');
  }

  async #send(update: unknown): Promise<void> {
    if (this.#closed || new URL(this.page.url()).origin !== OWNER_ORIGIN) throw new Error('OWNER_PREVIEW_UNAVAILABLE');
    await this.page.evaluate(data => {
      window.autoMateOwnerUpdate(data);
    }, update);
  }

  async #publish(): Promise<void> {
    const terminal = isTerminal(this.#phase);
    await this.#send({ kind: 'state', state: {
      phase: this.#phase,
      origin: this.#origin,
      approval: this.#approval,
      operationScope: 'Fill fields and submit this registration once',
      requests: this.#requests,
      evidence: this.#evidence,
      fieldStates: this.#fieldStates,
      events: this.#events,
      approvalError: this.#approvalError,
      taskEntry: this.options.planner ? {
        mode: this.options.planner.mode,
        model: this.options.planner.model,
        status: this.#planning ? 'planning' : this.#planReady ? 'ready' : 'idle',
        error: this.#plannerError,
      } : undefined,
      canStart: this.#planReady && !this.#planning && !this.#started && !terminal,
      canDeny: !this.#started && !terminal,
      canStop: (this.#planning || this.#started) && !terminal,
    } });
  }

  async #capture(): Promise<void> {
    if (!this.#worker || this.#worker.isClosed() || this.#closed || this.#failed || this.#phase === 'stopped' || this.#phase === 'takeover' || this.#phase === 'denied') return;
    if (this.#pending) { await this.#pending; return; }
    const scene = this.#scene;
    const fields = this.#fields;
    this.#pending = (async () => {
      try {
        const frame = await captureOwnerFrame(this.#worker!, this.#origin, fields);
        if (scene === this.#scene && !this.#closed && !this.#failed && this.#phase !== 'stopped' && this.#phase !== 'takeover' && this.#phase !== 'denied') {
          await this.#send({ kind: 'frame', frame });
        }
      } catch {
        if (scene !== this.#scene || this.#closed || isTerminal(this.#phase)) return;
        this.#failed = true;
        this.#stopTimer();
        try { this.options.onFault(); } catch {}
        await this.#send({ kind: 'fault' }).catch(() => {});
        throw new Error('OWNER_PREVIEW_EVIDENCE_CHANGED');
      }
    })();
    try { await this.#pending; } finally { this.#pending = undefined; }
  }

  #schedule(): void {
    this.#stopTimer();
    if (this.#closed || this.#failed || this.#phase === 'submitting' || isTerminal(this.#phase)) return;
    this.#timer = setTimeout(() => {
      void this.#capture().then(() => this.#schedule()).catch(() => {});
    }, 300);
  }

  #stopTimer(): void { clearTimeout(this.#timer); this.#timer = undefined; }
}
