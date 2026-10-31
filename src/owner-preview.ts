import type { Browser, BrowserContext, Page } from 'playwright';
import { captureOwnerFrame } from './preview-capture';
import type { Annotation, FieldRequest, PreviewPhase, VerifiedField, WorkflowObserver } from './preview-contract';
import { httpsOrigin, type Layer } from './policy';
import { setTimeout as delay } from 'node:timers/promises';

declare global {
  interface Window { autoMateOwnerUpdate: (data: unknown) => void }
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
  #approvalError?: string;
  #closure = Promise.withResolvers<void>();
  readonly closed = this.#closure.promise;

  private constructor(readonly page: Page, private context: BrowserContext, private options: OwnerOptions, approval: OwnerApprovalSummary) {
    this.#approval = approval;
    this.#origin = approval.origin;
  }

  static async open(browser: Browser, options: OwnerOptions): Promise<OwnerPreview> {
    const approval = validateAndFreezeApprovalSummary(options.approval);
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
      await page.exposeBinding('autoMateOwnerCommand', async (source, rawCommand: unknown) => {
        if (source.page !== page || source.frame !== page.mainFrame() || new URL(page.url()).origin !== OWNER_ORIGIN)
          throw new Error('OWNER_COMMAND_DENIED');
        const cmd = parseOwnerCommand(rawCommand);

        if (cmd.action === 'approve') {
          if (preview.#started || isTerminal(preview.#phase)) {
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
          if (!preview.#started || isTerminal(preview.#phase)) {
            throw new Error('OWNER_COMMAND_DENIED');
          }
          try {
            options.onStop();
          } catch {}
          await preview.state('stopped');
        }
      });
      page.on('popup', popup => { void popup.close(); });
      page.on('close', () => {
        preview.#closed = true;
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
      stopped: 'Owner stopped the task. Further authorization revoked.',
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
      canStart: !this.#started && !terminal,
      canDeny: !this.#started && !terminal,
      canStop: this.#started && !terminal,
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
