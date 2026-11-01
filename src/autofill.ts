import type { Browser, BrowserContext, Page } from 'playwright';
import { httpsOrigin, PolicyBroker, PolicyError } from './policy';
import type { AutofillCandidate, AutofillField, AutofillVault, VaultKind } from './autofill-contract';
import { AUTOFILL_FIELDS, fieldRequest } from './autofill-contract';
import type { FieldRequest, OwnerFrame, VerifiedField } from './preview-contract';
import { captureOwnerFrame, fillVerifiedField, verifyFieldRequests } from './preview-capture';
import { parseVaultRecord } from './vault-record';

interface DiscoveredFieldRequest {
  field: AutofillField;
  fieldSelector: string;
  requestSelector: string;
}

interface DiscoveryResult {
  requests: DiscoveredFieldRequest[];
}

/** Executed entirely within the worker page context. Never reads control values. */
function discoverDocumentFields({ kind, origin }: { kind: VaultKind; origin: string }): DiscoveryResult {
  if (window !== window.top || location.origin !== origin) {
    return { requests: [] };
  }

  function computeUniqueSelector(el: Element): string {
    if (el.id) {
      const escaped = '#' + CSS.escape(el.id);
      if (document.querySelectorAll(escaped).length === 1) return escaped;
    }
    const parts: string[] = [];
    let curr: Element | null = el;
    while (curr && curr.parentElement) {
      const parent: Element = curr.parentElement;
      const tag = curr.tagName.toLowerCase();
      const siblings = Array.from(parent.children).filter(c => c.tagName.toLowerCase() === tag);
      const index = siblings.indexOf(curr) + 1;
      parts.unshift(`${tag}:nth-of-type(${index})`);
      curr = parent;
    }
    parts.unshift(document.documentElement.tagName.toLowerCase());
    const selector = parts.join(' > ');
    if (document.querySelectorAll(selector).length !== 1 || document.querySelectorAll(selector)[0] !== el) {
      return '';
    }
    return selector;
  }

  function isVisible(element: HTMLElement): boolean {
    const box = element.getBoundingClientRect();
    if (!element.isConnected || element.ownerDocument !== document ||
        !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
        box.width <= 0 || box.height <= 0 || box.left < 0 || box.top < 0 ||
        box.right > innerWidth || box.bottom > innerHeight) return false;
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (!hit || (hit !== element && !element.contains(hit))) return false;
    return true;
  }

  function extractSourceText(source: HTMLElement): string | null {
    const textParts: string[] = [];
    const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || !node.textContent?.trim() || parent.closest('input,textarea,select,[contenteditable]') ||
          !parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      // Mirrors the closure-free validator in preview-capture: discovery cannot relax visible evidence.
      let left = 0; let top = 0; let right = innerWidth; let bottom = innerHeight;
      let unsupported = false;
      for (let ancestor: HTMLElement | null = parent; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.clip !== 'auto' || style.clipPath !== 'none' || style.maskImage !== 'none' ||
            style.transform !== 'none' || style.perspective !== 'none' ||
            (style.zoom !== '1' && style.zoom !== 'normal') ||
            /(?:^|\s)(?:paint|strict|content)(?:\s|$)/.test(style.contain)) {
          unsupported = true; break;
        }
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
          const box = ancestor.getBoundingClientRect();
          const x = box.left + ancestor.clientLeft; const y = box.top + ancestor.clientTop;
          if (style.overflowX !== 'visible') { left = Math.max(left, x); right = Math.min(right, x + ancestor.clientWidth); }
          if (style.overflowY !== 'visible') { top = Math.max(top, y); bottom = Math.min(bottom, y + ancestor.clientHeight); }
        }
      }
      if (unsupported) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
      const rendered = rects.length > 0 && rects.every(rect => {
        if (rect.left < left || rect.right > right || rect.top < top || rect.bottom > bottom) return false;
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return !!hit && (hit === parent || parent.contains(hit));
      });
      if (rendered) textParts.push(node.textContent ?? '');
    }
    const sourceText = textParts.join(' ').replace(/\s+/g, ' ').trim();
    if (!sourceText || sourceText.length > 200) return null;
    return sourceText;
  }

  function findLabelSource(field: HTMLElement): HTMLElement | null {
    if (field.id && document.querySelectorAll('#' + CSS.escape(field.id)).length === 1) {
      const labels = document.querySelectorAll('label[for="' + CSS.escape(field.id) + '"]');
      if (labels.length === 1) {
        const label = labels[0] as HTMLLabelElement;
        if (label.control === field && label.htmlFor === field.id) {
          return label;
        }
      }
    }
    const wrap = field.closest('label');
    if (wrap && !wrap.htmlFor && wrap.control === field && wrap.contains(field)) {
      return wrap;
    }
    const labelledby = field.getAttribute('aria-labelledby');
    if (labelledby) {
      const ids = labelledby.trim().split(/\s+/);
      if (ids.length === 1 && ids[0]) {
        const id = ids[0];
        if (document.querySelectorAll('#' + CSS.escape(id)).length === 1) {
          const src = document.getElementById(id);
          if (src) return src;
        }
      }
    }
    return null;
  }

  const controls = Array.from(document.querySelectorAll('input, select')) as Array<HTMLInputElement | HTMLSelectElement>;
  const rawCandidates: Array<{ field: AutofillField; control: HTMLElement; source: HTMLElement }> = [];

  for (const control of controls) {
    if (!isVisible(control)) continue;
    const isInput = control instanceof HTMLInputElement;
    const isSelect = control instanceof HTMLSelectElement;
    if (!isInput && !isSelect) continue;
    if (isInput) {
      const type = control.type.toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file'].includes(type)) continue;
      if (control.readOnly || control.disabled) continue;
    }
    if (isSelect) {
      if (control.multiple || control.disabled) continue;
    }

    const source = findLabelSource(control);
    if (!source || !isVisible(source)) continue;
    const sourceText = extractSourceText(source);
    if (!sourceText) continue;

    const ac = (control.getAttribute('autocomplete') ?? '').toLowerCase().trim();
    const id = (control.id || '').toLowerCase();
    const name = (control.getAttribute('name') || '').toLowerCase();
    const labelText = sourceText.toLowerCase();
    const placeholder = (control.getAttribute('placeholder') || '').toLowerCase();
    const ariaLabel = (control.getAttribute('aria-label') || '').toLowerCase();
    const fullText = `${ac} ${id} ${name} ${labelText} ${placeholder} ${ariaLabel}`;

    // Authentication challenges, card security codes, and bank-account fields are never mapped.
    if (/\b(cvv|cvc|csc|security[-_ ]?code|card[-_ ]?verification|otp|one[-_ ]?time|pin|routing|iban)\b/i.test(fullText)) continue;

    let matched: AutofillField | null = null;
    if (kind === 'login') {
      if (isInput && control.type === 'password') {
        if (ac === 'new-password' || /\b(new[-_ ]?password|confirm[-_ ]?password|retype|repeat|signup|register)\b/i.test(fullText)) {
          continue;
        }
        if (ac === 'current-password' || ac === 'password' || /\b(password|pass|pwd|userpassword|login[-_ ]?password)\b/i.test(fullText)) {
          matched = 'password';
        }
      } else if (isInput && control.type !== 'password') {
        if (ac === 'username' || ac === 'email' || control.type === 'email' ||
            /\b(username|user[-_ ]?name|login[-_ ]?id|user[-_ ]?id|email[-_ ]?address|email)\b/i.test(fullText) ||
            labelText === 'username' || labelText === 'email') {
          matched = 'username';
        }
      }
    } else if (kind === 'card') {
      if (isInput && (ac === 'cc-name' || /\b(cardholder|name\s+on\s+card|card\s+name|cardholders?\s+name|card\s+holder|cc[-_ ]?name|billing[-_ ]?name)\b/i.test(fullText))) {
        matched = 'cardholder';
      } else if (isInput && (ac === 'cc-number' || (/\b(card[-_ ]?(?:number|num)|cc[-_ ]?number)\b/i.test(fullText) && !/\b(holder|name)\b/i.test(fullText)))) {
        matched = 'cardNumber';
      } else if (ac === 'cc-exp-month' || /\b(exp[-_ ]?month|expiration[-_ ]?month|expiry[-_ ]?month|cc[-_ ]?exp[-_ ]?month)\b/i.test(fullText) || (/\bmonth\b/i.test(fullText) && /\b(exp|expir|valid)\b/i.test(fullText))) {
        matched = 'expiryMonth';
      } else if (ac === 'cc-exp-year' || /\b(exp[-_ ]?year|expiration[-_ ]?year|expiry[-_ ]?year|cc[-_ ]?exp[-_ ]?year)\b/i.test(fullText) || (/\byear\b/i.test(fullText) && /\b(exp|expir|valid)\b/i.test(fullText))) {
        matched = 'expiryYear';
      } else if (isInput && (ac === 'cc-exp' || /\b(exp(?:ir(?:y|ation))?[-_ ]?date|expires|valid[-_ ]?thru|mm\s*\/\s*yy)\b/i.test(fullText))) {
        matched = 'expiry';
      }
    }

    if (matched) {
      rawCandidates.push({ field: matched, control, source });
    }
  }

  const grouped = new Map<AutofillField, Array<{ control: HTMLElement; source: HTMLElement }>>();
  for (const c of rawCandidates) {
    const list = grouped.get(c.field) ?? [];
    list.push({ control: c.control, source: c.source });
    grouped.set(c.field, list);
  }

  // Reject / omit duplicates
  for (const [field, list] of grouped.entries()) {
    if (list.length > 1) {
      grouped.delete(field);
    }
  }

  // Ambiguity between single expiry and separate expiryMonth/expiryYear
  if (grouped.has('expiry') && (grouped.has('expiryMonth') || grouped.has('expiryYear'))) {
    grouped.delete('expiry');
  }

  const requests: DiscoveredFieldRequest[] = [];
  for (const [field, list] of grouped.entries()) {
    const entry = list[0]!;
    const fieldSelector = computeUniqueSelector(entry.control);
    const requestSelector = computeUniqueSelector(entry.source);
    if (!fieldSelector || !requestSelector) continue;
    requests.push({ field, fieldSelector, requestSelector });
  }

  return { requests };
}

/** Read only public option metadata. Never pass an expiry value to page code before the verified setter. */
async function controlValue(candidate: AutofillCandidate, value: string): Promise<string> {
  const options = await candidate.verified.field.evaluate(element => {
    if (!(element instanceof HTMLSelectElement)) return null;
    return Array.from(element.options).filter(option => !option.disabled &&
      !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled))
      .map(option => ({ value: option.value, text: option.textContent?.trim() ?? '' }));
  });
  if (!options) return value;
  if (candidate.field !== 'expiryMonth' && candidate.field !== 'expiryYear') throw new Error('UNSUPPORTED_SELECT');
  const number = Number(value);
  const year = candidate.field === 'expiryYear';
  const matches = options.filter(option => {
    if (!/^\d{1,4}$/.test(option.value)) return false;
    const optionNumber = Number(option.value);
    const canonical = year && option.value.length <= 2 ? 2000 + optionNumber : optionNumber;
    if (canonical !== number) return false;
    if (/^\d{1,4}$/.test(option.text)) {
      const labelNumber = Number(option.text);
      const labelCanonical = year && option.text.length <= 2 ? 2000 + labelNumber : labelNumber;
      if (labelCanonical !== number) return false;
    }
    return true;
  });
  if (matches.length !== 1) throw new Error('UNSUPPORTED_SELECT');
  return matches[0]!.value;
}

export class AutofillSession {
  readonly page: Page;
  readonly origin: string;
  readonly closed: Promise<void>;

  #url: string;
  #fields: readonly AutofillCandidate[];

  readonly #context: BrowserContext;
  readonly #kind: VaultKind;
  #state: 'review' | 'filling' | 'filled' | 'stopped' | 'failed' = 'review';
  #error: string | undefined = undefined;
  #resolveClosed!: () => void;
  #activePolicy?: PolicyBroker;
  #activeTask?: string;
  #signal?: AbortSignal;
  #abortListener?: () => void;
  #isClosed = false;
  #closing?: Promise<void>;
  #released = false;

  private constructor(
    context: BrowserContext,
    page: Page,
    origin: string,
    url: string,
    kind: VaultKind,
    fields: readonly AutofillCandidate[],
  ) {
    this.#context = context;
    this.page = page;
    this.origin = origin;
    this.#url = url;
    this.#kind = kind;
    this.#fields = Object.freeze([...fields]);

    const { promise, resolve } = Promise.withResolvers<void>();
    this.closed = promise;
    this.#resolveClosed = resolve;

    this.#context.on('close', () => {
      this.#handleContextClosed();
    });
    this.page.on('close', () => { void this.close().catch(() => {}); });
  }

  #handleContextClosed(): void {
    if (this.#isClosed) return;
    this.#isClosed = true;

    if (this.#abortListener && this.#signal) {
      this.#signal.removeEventListener('abort', this.#abortListener);
      this.#abortListener = undefined;
    }

    if (this.#activePolicy && this.#activeTask) {
      try {
        const taskState = this.#activePolicy.state(this.#activeTask);
        if (taskState === 'normal' || taskState === 'protected') {
          if (this.#state === 'filled') {
            this.#activePolicy.finish(this.#activeTask, 'completed');
          } else {
            this.#activePolicy.finish(this.#activeTask, 'takeover');
          }
        }
      } catch {
        /* safe ignore */
      }
    }

    if (this.#state === 'review' || this.#state === 'filling') {
      this.#state = 'stopped';
    }

    this.#resolveClosed();
  }

  get state(): 'review' | 'filling' | 'filled' | 'stopped' | 'failed' {
    return this.#state;
  }

  get error(): string | undefined {
    return this.#error;
  }
  get url(): string {
    return this.#url;
  }

  get fields(): readonly AutofillCandidate[] {
    return this.#fields;
  }


  static async open(
    browser: Browser,
    url: string,
    kind: VaultKind,
    options?: { prepare?: (page: Page) => Promise<void>; signal?: AbortSignal; allowEmptyFields?: boolean },
  ): Promise<AutofillSession> {
    if (!url || typeof url !== 'string') {
      throw new Error('INVALID_URL');
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('INVALID_URL');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
      throw new Error('INVALID_URL');
    }
    let origin: string;
    try {
      origin = httpsOrigin(parsed.origin);
    } catch {
      throw new Error('INVALID_URL');
    }

    let aborted = false;
    let context: BrowserContext | undefined;
    let abortClosure: Promise<void> | undefined;

    const onInspectionAbort = () => {
      aborted = true;
      if (context) {
        abortClosure = context.close();
        void abortClosure.catch(() => {});
      }
    };

    if (options?.signal) {
      if (options.signal.aborted) {
        throw new Error('TASK_STOPPED');
      }
      options.signal.addEventListener('abort', onInspectionAbort, { once: true });
    }

    try {
      context = await browser.newContext({
        viewport: { width: 1280, height: 1000 },
        acceptDownloads: false,
        serviceWorkers: 'block',
      });

      if (aborted || options?.signal?.aborted) {
        await context.close().catch(() => {});
        throw new Error('TASK_STOPPED');
      }

      await context.route('**/*', route => {
        const request = route.request();
        let allowed = false;
        try {
          allowed = new URL(request.url()).origin === origin;
        } catch {
          /* denied */
        }
        return allowed ? route.continue() : route.abort('blockedbyclient');
      });

      await context.routeWebSocket('**/*', socket => { socket.close({ code: 1008, reason: 'Policy blocked' }); });

      const page = await context.newPage();
      page.on('popup', popup => { void popup.close().catch(() => {}); });

      if (aborted || options?.signal?.aborted) {
        await context.close().catch(() => {});
        throw new Error('TASK_STOPPED');
      }

      if (options?.prepare) {
        const preparePromise = options.prepare(page);
        if (options?.signal) {
          const { promise: abortPromise, reject } = Promise.withResolvers<never>();
          const onAbort = () => reject(new Error('TASK_STOPPED'));
          if (aborted || options.signal.aborted) {
            onAbort();
          } else {
            options.signal.addEventListener('abort', onAbort, { once: true });
          }
          try {
            await Promise.race([preparePromise, abortPromise]);
          } finally {
            options.signal.removeEventListener('abort', onAbort);
          }
        } else {
          await preparePromise;
        }
      }

      if (aborted || options?.signal?.aborted) {
        await context.close().catch(() => {});
        throw new Error('TASK_STOPPED');
      }

      await page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: 15000 });

      if (aborted || options?.signal?.aborted) {
        await context.close().catch(() => {});
        throw new Error('TASK_STOPPED');
      }

      const discovery: DiscoveryResult = await page.evaluate(discoverDocumentFields, { kind, origin });

      if (aborted || options?.signal?.aborted) {
        await context.close().catch(() => {});
        throw new Error('TASK_STOPPED');
      }

      if (!discovery.requests.length) {
        if (!options?.allowEmptyFields) {
          await context.close().catch(() => {});
          throw new Error('UNSUPPORTED_FORM');
        }
      }

      let candidates: AutofillCandidate[] = [];
      if (discovery.requests.length) {
        const fieldRequests: readonly FieldRequest[] = Object.freeze(
          discovery.requests.map(req => fieldRequest(req.field, req.fieldSelector, req.requestSelector)),
        );

        const verifiedFields = await verifyFieldRequests(page, origin, fieldRequests);

        if (aborted || options?.signal?.aborted) {
          await context.close().catch(() => {});
          throw new Error('TASK_STOPPED');
        }

        candidates = verifiedFields.map(vf => ({
          field: vf.request.id as AutofillField,
          verified: vf,
        }));
      }
      if (options?.signal) {
        options.signal.removeEventListener('abort', onInspectionAbort);
      }

      return new AutofillSession(context, page, origin, parsed.href, kind, candidates);
    } catch (err) {
      if (context) {
        await (abortClosure ?? context.close()).catch(() => {});
      }
      if (options?.signal) {
        options.signal.removeEventListener('abort', onInspectionAbort);
      }
      if (aborted || options?.signal?.aborted) {
        throw new Error('TASK_STOPPED');
      }
      if (err instanceof PolicyError) throw err;
      if (err instanceof Error) {
        if (['INVALID_URL', 'ORIGIN_MISMATCH', 'UNSUPPORTED_FORM', 'VERIFICATION_FAILED', 'TASK_STOPPED'].includes(err.message)) {
          throw err;
        }
      }
      throw new Error('SETUP_FAILED');
    }
  }

  async fill(
    policy: PolicyBroker, grant: string, task: string, vault: AutofillVault,
    recordId: string, kind: VaultKind, selected: readonly AutofillField[],
  ): Promise<'filled' | 'stopped' | 'failed'> {
    if (this.#state !== 'review' || this.#released) return 'failed';
    let signal: AbortSignal | undefined;
    try {
      signal = policy.executionSignal(grant, task);
      this.#activePolicy = policy; this.#activeTask = task; this.#signal = signal;
      const onAbort = () => {
        this.#state = 'stopped'; this.#error = 'TASK_STOPPED';
        void this.close().catch(() => {});
      };
      this.#abortListener = onAbort;
      signal.addEventListener('abort', onAbort, { once: true });
      if (kind !== this.#kind || !Array.isArray(selected) || !selected.length ||
          new Set(selected).size !== selected.length) throw new Error('INVALID_SELECTION');
      const candidates = selected.map((field: AutofillField) => {
        const candidate = this.fields.find(item => item.field === field);
        if (!candidate || AUTOFILL_FIELDS[field]?.kind !== kind) throw new Error('INVALID_SELECTION');
        return candidate;
      });
      const check = () => {
        if (signal!.aborted || this.#isClosed || this.#released) throw new Error('TASK_STOPPED');
        for (const candidate of candidates) {
          const request = candidate.verified.request;
          if (policy.category(request.credential) !== AUTOFILL_FIELDS[candidate.field].category)
            throw new Error('CATEGORY_MISMATCH');
          policy.authorize(grant, task, this.origin, 'fill', request.credential);
        }
      };
      this.#state = 'filling';
      check();
      const verified = candidates.map(candidate => candidate.verified);
      await captureOwnerFrame(this.page, this.origin, verified);
      check();
      const record = parseVaultRecord(await vault.read(this.origin, recordId, kind));
      check();
      if (record.kind !== kind) throw new Error('RECORD_MISMATCH');
      await captureOwnerFrame(this.page, this.origin, verified);
      check();
      const values: Partial<Record<AutofillField, string>> = record.kind === 'login'
        ? { username: record.username, password: record.password }
        : { cardholder: record.cardholder, cardNumber: record.cardNumber, expiryMonth: record.expiryMonth,
          expiryYear: record.expiryYear, expiry: record.expiryMonth + '/' + record.expiryYear.slice(-2) };
      for (const candidate of candidates) {
        const rawValue = values[candidate.field];
        if (rawValue === undefined) throw new Error('RECORD_MISMATCH');
        const value = await controlValue(candidate, rawValue);
        check();
        await fillVerifiedField(this.page, this.origin, candidate.verified, value);
        check();
      }
      this.#state = 'filled';
      // Keep the grant alive: expiry/revocation must still close the filled protected page.
      return 'filled';
    } catch (fault) {
      const stopped = signal?.aborted || this.#isClosed;
      this.#state = stopped ? 'stopped' : 'failed';
      const code = fault instanceof Error ? fault.message : '';
      this.#error = stopped ? 'TASK_STOPPED' :
        ['VAULT_AUTHENTICATION_REQUIRED', 'SESSION_UNAVAILABLE', 'AUDIT_UNAVAILABLE'].includes(code) ? code : 'AUTOFILL_FAILED';
      try { await this.close(); } catch { this.#error = 'BROWSER_CLOSE_FAILED'; }
      return stopped ? 'stopped' : 'failed';
    }
  }

  async capture(): Promise<OwnerFrame> {
    try {
      const verifiedFields = this.fields.map(c => c.verified);
      return await captureOwnerFrame(this.page, this.origin, verifiedFields);
    } catch {
      this.#state = 'failed';
      this.#error = 'CAPTURE_FRAME_FAILED';
      await this.close();
      throw new Error('CAPTURE_FRAME_FAILED');
    }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    if (this.#isClosed) return Promise.resolve();
    this.#closing = this.#context.close().catch(() => {
      if (this.#state !== 'stopped') this.#state = 'failed';
      this.#error = 'BROWSER_CLOSE_FAILED';
      this.#closing = undefined;
      throw new Error('BROWSER_CLOSE_FAILED');
    });
    return this.#closing;
  }

  releaseForOwnerAction(): void {
    if (this.#state === 'filling') throw new Error('INVALID_STATE');
    this.#released = true;
    if (this.#abortListener && this.#signal) {
      this.#signal.removeEventListener('abort', this.#abortListener);
      this.#abortListener = undefined;
    }
    if (this.#activePolicy && this.#activeTask) {
      const taskState = this.#activePolicy.state(this.#activeTask);
      if (taskState === 'normal' || taskState === 'protected') this.#activePolicy.finish(this.#activeTask, 'completed');
      this.#activePolicy = undefined;
      this.#activeTask = undefined;
    }
    this.#signal = undefined;
  }

  async refreshAfterOwnerAction(): Promise<void> {
    if (this.#isClosed) throw new Error('SESSION_CLOSED');
    this.releaseForOwnerAction();

    let currentOrigin: string;
    try {
      const parsed = new URL(this.page.url());
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
        throw new Error('ORIGIN_MISMATCH');
      }
      currentOrigin = httpsOrigin(parsed.origin);
    } catch {
      await this.close().catch(() => {});
      throw new Error('ORIGIN_MISMATCH');
    }

    if (currentOrigin !== this.origin) {
      await this.close().catch(() => {});
      throw new Error('ORIGIN_MISMATCH');
    }

    for (const item of this.#fields) {
      void item.verified.field.dispose().catch(() => {});
      void item.verified.source.dispose().catch(() => {});
    }

    try {
      const discovery: DiscoveryResult = await this.page.evaluate(discoverDocumentFields, { kind: this.#kind, origin: this.origin });

      if (!discovery.requests.length) {
        this.#fields = Object.freeze([]);
      } else {
        const fieldRequests: readonly FieldRequest[] = Object.freeze(
          discovery.requests.map(req => fieldRequest(req.field, req.fieldSelector, req.requestSelector)),
        );

        const verifiedFields = await verifyFieldRequests(this.page, this.origin, fieldRequests);
        const candidates: AutofillCandidate[] = verifiedFields.map(vf => ({
          field: vf.request.id as AutofillField,
          verified: vf,
        }));
        this.#fields = Object.freeze(candidates);
      }

      this.#url = this.page.url();
      this.#state = 'review';
      this.#error = undefined;
      this.#released = false;
      this.#activePolicy = undefined;
      this.#activeTask = undefined;
      this.#signal = undefined;
      this.#abortListener = undefined;
    } catch (err) {
      this.#state = 'failed';
      this.#error = 'SETUP_FAILED';
      await this.close().catch(() => {});
      throw err;
    }
  }
}
