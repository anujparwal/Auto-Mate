import type { Browser, BrowserContext, Page } from 'playwright';
import { httpsOrigin, PolicyBroker, PolicyError } from './policy';
import type { FieldRequest, OwnerFrame, VerifiedField } from './preview-contract';
import { captureOwnerFrame, fillVerifiedField, verifyDomField, verifyFieldRequests } from './preview-capture';
import type { InformationField, InformationFieldKind } from './information-contract';

interface DiscoveredField {
  readonly id: string;
  readonly label: string;
  readonly kind: InformationFieldKind;
  readonly required: boolean;
  readonly options?: string[];
  readonly fieldSelector: string;
  readonly requestSelector: string;
}

interface DiscoveryResult {
  readonly fields: readonly DiscoveredField[];
}

/** Executed entirely within the worker page context. Never reads or leaks form values. */
function discoverInformationFields({ origin }: { origin: string }): DiscoveryResult {
  if (window !== window.top || location.origin !== origin) {
    return { fields: [] };
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

  const rawElements = Array.from(document.querySelectorAll('input, select, textarea')) as HTMLElement[];
  const candidates: Array<{
    control: HTMLElement;
    source: HTMLElement;
    label: string;
    kind: InformationFieldKind;
    required: boolean;
    options?: string[];
    fieldSelector: string;
    requestSelector: string;
  }> = [];

  for (const control of rawElements) {
    if (!isVisible(control)) continue;
    const isInput = control instanceof HTMLInputElement;
    const isSelect = control instanceof HTMLSelectElement;
    const isTextarea = control instanceof HTMLTextAreaElement;
    if (!isInput && !isSelect && !isTextarea) continue;

    if (isInput) {
      const type = (control.type || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file', 'color', 'range'].includes(type)) continue;
      if (!['text', 'email', 'tel', 'url', 'password', 'date', 'number', 'search'].includes(type)) continue;
      if (control.readOnly || control.disabled) continue;
    }
    if (isSelect) {
      if (control.multiple || control.disabled) continue;
    }
    if (isTextarea) {
      if (control.readOnly || control.disabled) continue;
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

    // Refuse authentication challenges, card security codes, OTP/TOTP, PINs, CAPTCHAs, and sensitive payment controls
    if (/\b(cvv|cvc|csc|security[-_ ]?code|card[-_ ]?verification|otp|totp|one[-_ ]?time|passcode|pin|captcha|challenge|routing|iban|bank[-_ ]?account|card[-_ ]?number|cc[-_ ]?num|credit[-_ ]?card)\b/i.test(fullText)) {
      continue;
    }

    let kind: InformationFieldKind;
    let options: string[] | undefined;

    if (isSelect) {
      kind = 'select';
      const enabledOptions = Array.from(control.options).filter(opt => !opt.disabled &&
        !(opt.parentElement instanceof HTMLOptGroupElement && opt.parentElement.disabled));
      const labels = enabledOptions.map(opt => opt.textContent?.trim() || opt.label?.trim() || '').filter(t => t.length > 0);
      options = Array.from(new Set(labels));
    } else if (isTextarea) {
      kind = 'text';
    } else if (isInput) {
      const type = (control.type || 'text').toLowerCase();
      if (type === 'password') {
        kind = 'password';
      } else if (type === 'email') {
        kind = 'email';
      } else if (type === 'tel') {
        kind = 'tel';
      } else if (type === 'url') {
        kind = 'url';
      } else if (type === 'date') {
        kind = 'date';
      } else if (type === 'number') {
        kind = 'number';
      } else {
        if (ac === 'username' || /\b(username|user[-_ ]?name|login[-_ ]?id|user[-_ ]?id|handle)\b/i.test(fullText) || /^(user\s*name|username|login)$/i.test(sourceText.trim())) {
          kind = 'username';
        } else {
          kind = 'text';
        }
      }
    } else {
      continue;
    }

    const required = Boolean((control as HTMLInputElement).required || control.getAttribute('aria-required') === 'true');
    const fieldSelector = computeUniqueSelector(control);
    const requestSelector = computeUniqueSelector(source);
    if (!fieldSelector || !requestSelector) continue;

    candidates.push({
      control,
      source,
      label: sourceText,
      kind,
      required,
      options,
      fieldSelector,
      requestSelector,
    });
  }

  // Filter out duplicates and ambiguous mappings
  // 1. Same control referenced more than once
  const controlCounts = new Map<HTMLElement, number>();
  // 2. Same source label element referenced by multiple controls
  const sourceCounts = new Map<HTMLElement, number>();
  // 3. Duplicate label strings (ambiguous for user/dialog)
  const labelCounts = new Map<string, number>();

  for (const c of candidates) {
    controlCounts.set(c.control, (controlCounts.get(c.control) ?? 0) + 1);
    sourceCounts.set(c.source, (sourceCounts.get(c.source) ?? 0) + 1);
    const normalizedLabel = c.label.toLowerCase();
    labelCounts.set(normalizedLabel, (labelCounts.get(normalizedLabel) ?? 0) + 1);
  }

  const uniqueCandidates = candidates.filter(c => {
    if ((controlCounts.get(c.control) ?? 0) !== 1) return false;
    if ((sourceCounts.get(c.source) ?? 0) !== 1) return false;
    if ((labelCounts.get(c.label.toLowerCase()) ?? 0) !== 1) return false;
    return true;
  });

  const fields: DiscoveredField[] = uniqueCandidates.map((c, idx) => ({
    id: `info-field-${idx + 1}`,
    label: c.label,
    kind: c.kind,
    required: c.required,
    ...(c.options !== undefined ? { options: c.options } : {}),
    fieldSelector: c.fieldSelector,
    requestSelector: c.requestSelector,
  }));

  return { fields };
}

export class InformationSession {
  readonly origin: string;
  readonly url: string;
  readonly page: Page;
  readonly closed: Promise<void>;
  readonly fields: readonly { metadata: InformationField; verified: VerifiedField }[];

  readonly #context: BrowserContext;
  #state: 'review' | 'filling' | 'filled' | 'stopped' | 'failed' = 'review';
  #error: string | undefined = undefined;
  #resolveClosed!: () => void;
  #activePolicy?: PolicyBroker;
  #activeTask?: string;
  #signal?: AbortSignal;
  #abortListener?: () => void;
  #isClosed = false;
  #closing?: Promise<void>;

  private constructor(
    context: BrowserContext,
    page: Page,
    origin: string,
    url: string,
    fields: readonly { metadata: InformationField; verified: VerifiedField }[],
  ) {
    this.#context = context;
    this.page = page;
    this.origin = origin;
    this.url = url;
    this.fields = Object.freeze([...fields]);

    const { promise, resolve } = Promise.withResolvers<void>();
    this.closed = promise;
    this.#resolveClosed = resolve;

    this.#context.on('close', () => {
      this.#handleContextClosed();
    });
    this.page.on('close', () => {
      void this.close().catch(() => {});
    });
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

  static async open(
    browser: Browser,
    url: string,
    options?: { prepare?: (page: Page) => Promise<void>; signal?: AbortSignal },
  ): Promise<InformationSession> {
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

      await context.routeWebSocket('**/*', socket => {
        socket.close({ code: 1008, reason: 'Policy blocked' });
      });

      const page = await context.newPage();
      page.on('popup', popup => {
        void popup.close().catch(() => {});
      });

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

      const discovery: DiscoveryResult = await page.evaluate(discoverInformationFields, { origin });

      if (aborted || options?.signal?.aborted) {
        await context.close().catch(() => {});
        throw new Error('TASK_STOPPED');
      }

      if (!discovery.fields.length) {
        await context.close().catch(() => {});
        throw new Error('UNSUPPORTED_FORM');
      }

      const fieldRequests: readonly FieldRequest[] = Object.freeze(
        discovery.fields.map(f => ({
          id: f.id,
          credential: 'information:value',
          name: f.label,
          category: 'red' as const,
          fieldSelector: f.fieldSelector,
          requestSelector: f.requestSelector,
        })),
      );

      const verifiedFields = await verifyFieldRequests(page, origin, fieldRequests);

      if (aborted || options?.signal?.aborted) {
        await context.close().catch(() => {});
        throw new Error('TASK_STOPPED');
      }

      const verifiedMap = new Map(verifiedFields.map(vf => [vf.request.id, vf]));
      const items = discovery.fields.map(f => {
        const verified = verifiedMap.get(f.id);
        if (!verified) throw new Error('VERIFICATION_FAILED');
        const metadata: InformationField = {
          id: f.id,
          label: f.label,
          kind: f.kind,
          required: f.required,
          ...(f.options ? { options: Object.freeze([...f.options]) } : {}),
        };
        return Object.freeze({ metadata: Object.freeze(metadata), verified });
      });

      if (options?.signal) {
        options.signal.removeEventListener('abort', onInspectionAbort);
      }

      return new InformationSession(context, page, origin, parsed.href, items);
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

  async fill(
    policy: PolicyBroker,
    task: string,
    handle: string,
    selected: readonly string[],
    getValue: (fieldId: string) => Promise<string>,
  ): Promise<void> {
    if (this.#state !== 'review') {
      this.#state = 'failed';
      this.#error = 'INVALID_STATE';
      return;
    }

    let signal: AbortSignal | undefined;
    try {
      signal = policy.executionSignal(handle, task);
      this.#activePolicy = policy;
      this.#activeTask = task;
      this.#signal = signal;

      const onAbort = () => {
        this.#state = 'stopped';
        this.#error = 'TASK_STOPPED';
        void this.close().catch(() => {});
      };
      this.#abortListener = onAbort;
      signal.addEventListener('abort', onAbort, { once: true });

      if (
        !Array.isArray(selected) ||
        !selected.length ||
        new Set(selected).size !== selected.length ||
        selected.some(s => typeof s !== 'string')
      ) {
        throw new Error('INVALID_SELECTION');
      }

      const selectedItems: Array<{ metadata: InformationField; verified: VerifiedField }> = [];
      for (const id of selected) {
        const item = this.fields.find(f => f.metadata.id === id);
        if (!item) throw new Error('INVALID_SELECTION');
        selectedItems.push(item);
      }

      const checkAuthority = () => {
        if (signal!.aborted || this.#isClosed) throw new Error('TASK_STOPPED');
        for (const item of selectedItems) {
          const request = item.verified.request;
          if (policy.category(request.credential) !== 'red') throw new Error('CATEGORY_MISMATCH');
          policy.authorize(handle, task, this.origin, 'fill', request.credential);
        }
      };

      this.#state = 'filling';
      checkAuthority();

      const verified = selectedItems.map(item => item.verified);
      await captureOwnerFrame(this.page, this.origin, verified);
      checkAuthority();

      for (const item of selectedItems) {
        checkAuthority();

        // 1. Verify DOM evidence before calling host getValue
        await verifyDomField(this.page, this.origin, item.verified);
        checkAuthority();

        // 2. Call host callback only for this approved selected field
        const rawValue = await getValue(item.metadata.id);
        if (typeof rawValue !== 'string') throw new Error('INVALID_VALUE');

        // 3. Immediately recheck authority after awaiting host callback
        checkAuthority();

        // 4. Verify DOM evidence after awaiting host callback
        await verifyDomField(this.page, this.origin, item.verified);
        checkAuthority();

        // 5. If select, resolve allowed option label or exact value
        let valueToFill = rawValue;
        if (item.metadata.kind === 'select') {
          const options = await item.verified.field.evaluate(element => {
            if (!(element instanceof HTMLSelectElement)) return null;
            return Array.from(element.options)
              .filter(
                opt =>
                  !opt.disabled &&
                  !(opt.parentElement instanceof HTMLOptGroupElement && opt.parentElement.disabled),
              )
              .map(opt => ({
                value: opt.value,
                text: opt.textContent?.trim() || opt.label?.trim() || '',
              }));
          });
          if (!options) throw new Error('UNSUPPORTED_SELECT');
          const matches = options.filter(
            opt => opt.value === rawValue || opt.text.toLowerCase() === rawValue.toLowerCase(),
          );
          if (matches.length !== 1) throw new Error('UNSUPPORTED_SELECT');
          valueToFill = matches[0]!.value;
        }

        // 6. Write value with synchronous inspection right before setter
        checkAuthority();
        await fillVerifiedField(this.page, this.origin, item.verified, valueToFill);
        checkAuthority();
      }

      this.#state = 'filled';
    } catch (fault) {
      const stopped = signal?.aborted || this.#isClosed;
      this.#state = stopped ? 'stopped' : 'failed';
      const code = fault instanceof Error ? fault.message : '';
      this.#error = stopped
        ? 'TASK_STOPPED'
        : ['VAULT_AUTHENTICATION_REQUIRED', 'SESSION_UNAVAILABLE', 'AUDIT_UNAVAILABLE', 'UNSUPPORTED_SELECT', 'INVALID_SELECTION'].includes(code)
          ? code
          : 'AUTOFILL_FAILED';
      try {
        await this.close();
      } catch {
        this.#error = 'BROWSER_CLOSE_FAILED';
      }
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
}
