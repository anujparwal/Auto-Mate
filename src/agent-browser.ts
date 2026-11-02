import type { Browser, BrowserContext, Page, Route } from 'playwright';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import type {
  AgentBrowser,
  AgentWorkspaceSettings,
  BrowserAction,
  BrowserField,
  BrowserObservation,
} from './agent-types';
import type { InformationFieldKind } from './information-contract';
import { resolvePublicDestination } from './hosted-egress';
import type { DnsLookupFn } from './hosted-egress';

export interface OpenAgentBrowserOptions {
  browser: Browser;
  navigation: AgentWorkspaceSettings['navigation'];
  prepareWebsite?: (page: Page) => Promise<void>;
  dnsLookupFn?: DnsLookupFn;
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface InspectedField {
  readonly key: string;
  readonly label: string;
  readonly kind: InformationFieldKind;
  readonly required: boolean;
  readonly options?: string[];
  readonly selector: string;
  readonly tagName: string;
  readonly nameAttr: string;
  readonly idAttr: string;
}

interface InspectedAction {
  readonly key: string;
  readonly label: string;
  readonly kind: 'link' | 'button';
  readonly href?: string;
  readonly selector: string;
  readonly tagName: string;
}

interface DomInspectionResult {
  readonly title: string;
  readonly url: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly fields: InspectedField[];
  readonly actions: InspectedAction[];
}


const CONTROL_LOCATOR_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const IFRAME_LOCATOR_SELECTOR = 'iframe';
const MAX_TEXT_CHARS = 16000;

function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().trim();
  const d = domain.toLowerCase().trim().replace(/^\./, '');
  return h === d || h.endsWith('.' + d);
}

export function validateTargetUrl(rawUrl: string, policy: AgentWorkspaceSettings['navigation']): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`URL_POLICY_VIOLATION: Invalid URL "${rawUrl}"`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`URL_POLICY_VIOLATION: Protocol must be HTTPS, got "${parsed.protocol}"`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('URL_POLICY_VIOLATION: Credentials in URL are forbidden');
  }

  if (parsed.hash) {
    throw new Error('URL_POLICY_VIOLATION: URL fragments are forbidden');
  }

  const hostname = parsed.hostname;
  if (policy.mode === 'whitelist') {
    const isWhitelisted = policy.domains.some(domain => hostMatchesDomain(hostname, domain));
    if (!isWhitelisted) {
      throw new Error(`URL_POLICY_VIOLATION: Domain "${hostname}" is not permitted by whitelist policy`);
    }
  } else if (policy.mode === 'blacklist') {
    const isBlacklisted = policy.domains.some(domain => hostMatchesDomain(hostname, domain));
    if (isBlacklisted) {
      throw new Error(`URL_POLICY_VIOLATION: Domain "${hostname}" is blocked by blacklist policy`);
    }
  }

  return parsed;
}

async function assertPublicDestination(
  hostname: string,
  cache: Map<string, Promise<string>>,
  lookupFn?: DnsLookupFn
): Promise<string> {
  const normalized = hostname.toLowerCase().trim();
  let existing = cache.get(normalized);
  if (!existing) {
    existing = resolvePublicDestination(normalized, lookupFn);
    cache.set(normalized, existing);
  }
  return existing;
}

async function gatherMasks(page: Page, selector: string): Promise<readonly Rect[]> {
  return page.locator(selector).evaluateAll(elements => {
    const rects: Rect[] = [];
    for (const element of elements) {
      const box = element.getBoundingClientRect();
      if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) {
        throw new Error('EVIDENCE_INVALID');
      }
      if (box.width > 0 && box.height > 0) {
        rects.push({ x: box.x, y: box.y, width: box.width, height: box.height });
      }
    }
    return rects;
  });
}

function validateMaskGeometry(before: readonly Rect[], after: readonly Rect[]): void {
  if (before.length !== after.length) {
    throw new Error('MASK_GEOMETRY_MISMATCH: Control count changed during capture');
  }
  for (let i = 0; i < before.length; i++) {
    const b = before[i]!;
    const a = after[i]!;
    if (
      Math.abs(b.x - a.x) > 1 ||
      Math.abs(b.y - a.y) > 1 ||
      Math.abs(b.width - a.width) > 1 ||
      Math.abs(b.height - a.height) > 1
    ) {
      throw new Error('MASK_GEOMETRY_MISMATCH: Element shifted during capture');
    }
  }
}

function unionRects(before: readonly Rect[], after: readonly Rect[]): readonly Rect[] {
  const result: Rect[] = [];
  for (let i = 0; i < before.length; i++) {
    const b = before[i]!;
    const a = after[i]!;
    const minX = Math.min(b.x, a.x);
    const minY = Math.min(b.y, a.y);
    const maxX = Math.max(b.x + b.width, a.x + a.width);
    const maxY = Math.max(b.y + b.height, a.y + a.height);
    result.push(Object.freeze({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }));
  }
  return Object.freeze(result);
}

function composeRedactionSvg(
  viewportWidth: number,
  viewportHeight: number,
  controls: readonly Rect[],
  frames: readonly Rect[]
): Buffer {
  if (
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    throw new Error('INVALID_VIEWPORT');
  }
  const rectElements: string[] = [];
  const targets = controls.concat(frames);
  for (const target of targets) {
    if (
      !Number.isFinite(target.x) ||
      !Number.isFinite(target.y) ||
      !Number.isFinite(target.width) ||
      !Number.isFinite(target.height)
    ) {
      throw new Error('INVALID_RECT');
    }
    const left = Math.max(0, Math.min(viewportWidth, Math.floor(target.x)));
    const top = Math.max(0, Math.min(viewportHeight, Math.floor(target.y)));
    const right = Math.max(0, Math.min(viewportWidth, Math.ceil(target.x + target.width)));
    const bottom = Math.max(0, Math.min(viewportHeight, Math.ceil(target.y + target.height)));
    const width = right - left;
    const height = bottom - top;
    if (width > 0 && height > 0) {
      rectElements.push(`<rect x="${left}" y="${top}" width="${width}" height="${height}" fill="#000000"/>`);
    }
  }
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${viewportWidth}" height="${viewportHeight}">${rectElements.join('')}</svg>`,
    'utf-8'
  );
}

/** Executed in page context: gathers visible text, fields, and actions. */
function inPageInspectDom(): DomInspectionResult {
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
    if (document.documentElement) {
      parts.unshift(document.documentElement.tagName.toLowerCase());
    }
    const selector = parts.join(' > ');
    if (document.querySelectorAll(selector).length === 1 && document.querySelectorAll(selector)[0] === el) {
      return selector;
    }
    return '';
  }

  function hasVisibility(el: HTMLElement): boolean {
    if ('checkVisibility' in el && typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    return true;
  }

  function isVisible(el: HTMLElement): boolean {
    if (!el.isConnected || el.ownerDocument !== document) return false;
    if (el.hasAttribute('hidden')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) {
      return false;
    }
    if (!hasVisibility(el)) {
      return false;
    }
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    return true;
  }

  // 1. Visible text extraction (excluding all controls, contenteditable, scripts, styles, iframes)
  const BLOCK_TAGS: Record<string, true> = {
    address: true, article: true, aside: true, blockquote: true, canvas: true, dd: true, div: true,
    dl: true, dt: true, fieldset: true, figcaption: true, figure: true, footer: true, form: true,
    h1: true, h2: true, h3: true, h4: true, h5: true, h6: true, header: true, hr: true, li: true, main: true,
    nav: true, noscript: true, ol: true, p: true, pre: true, section: true, table: true, tfoot: true,
    ul: true, video: true, tr: true, td: true, th: true,
  };

  const EXCLUDED_TAGS: Record<string, true> = {
    script: true, style: true, noscript: true, template: true, svg: true, iframe: true, frame: true,
    object: true, embed: true, input: true, textarea: true, select: true, button: true,
  };

  const textParts: string[] = [];
  // Keep enough trailing text to match a percent-encoded 4096-code-unit value before the 16k model cutoff.
  const MAX_LIMIT = 65536;
  let runningLen = 0;
  let truncated = false;

  function walk(node: Node): void {
    if (truncated) return;

    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();

      if (EXCLUDED_TAGS[tag]) return;
      if (el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '') {
        return;
      }
      if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) {
        return;
      }
      if (!hasVisibility(el)) {
        return;
      }

      const isBlock = Boolean(BLOCK_TAGS[tag]);
      if (isBlock && textParts.length > 0 && !textParts[textParts.length - 1]?.endsWith('\n')) {
        textParts.push('\n');
      }

      for (let child = el.firstChild; child; child = child.nextSibling) {
        walk(child);
        if (truncated) return;
      }

      if (isBlock && textParts.length > 0 && !textParts[textParts.length - 1]?.endsWith('\n')) {
        textParts.push('\n');
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      const rawVal = node.nodeValue;
      if (!rawVal) return;
      const clean = rawVal.replace(/\s+/g, ' ');
      if (clean.trim().length > 0) {
        textParts.push(clean);
        runningLen += clean.length;
        if (runningLen >= MAX_LIMIT) {
          truncated = true;
        }
      }
    }
  }

  if (document.body) {
    walk(document.body);
  }

  let fullText = textParts.join('').replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
  if (fullText.length > MAX_LIMIT) {
    fullText = fullText.slice(0, MAX_LIMIT);
    truncated = true;
  }

  // 2. Discover visible form fields
  const fields: InspectedField[] = [];
  const fieldElements = Array.from(document.querySelectorAll('input, textarea, select')) as HTMLElement[];
  for (const el of fieldElements) {
    if (!isVisible(el)) continue;

    const tag = el.tagName.toLowerCase();
    let kind: InformationFieldKind = 'text';
    let options: string[] | undefined;

    if (tag === 'textarea') {
      kind = 'text';
    } else if (tag === 'select') {
      kind = 'select';
      const selectEl = el as HTMLSelectElement;
      options = Array.from(selectEl.options).map(o => o.text.trim()).filter(Boolean);
    } else if (tag === 'input') {
      const inputEl = el as HTMLInputElement;
      const type = (inputEl.type || 'text').toLowerCase();
      if (['hidden', 'submit', 'reset', 'button', 'image', 'file', 'checkbox', 'radio', 'color', 'range'].includes(type)) continue;

      if (type === 'password') kind = 'password';
      else if (type === 'email') kind = 'email';
      else if (type === 'tel') kind = 'tel';
      else if (type === 'url') kind = 'url';
      else if (type === 'number') kind = 'number';
      else if (type === 'date') kind = 'date';
      else {
        const autocomplete = (inputEl.getAttribute('autocomplete') || '').toLowerCase();
        const combined = `${inputEl.id} ${inputEl.name} ${inputEl.placeholder}`.toLowerCase();
        if (autocomplete === 'username' || /(user_?name|login|handle)/i.test(combined)) {
          kind = 'username';
        } else if (autocomplete.includes('password') || /(pass(word)?|pin)/i.test(combined)) {
          kind = 'password';
        } else if (autocomplete === 'email' || /email/i.test(combined)) {
          kind = 'email';
        } else if (autocomplete === 'tel' || /(phone|mobile)/i.test(combined)) {
          kind = 'tel';
        } else {
          kind = 'text';
        }
      }
    }

    const selector = computeUniqueSelector(el);
    if (!selector) continue;

    let label = '';
    if (el.id) {
      const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (labelEl) label = labelEl.textContent?.trim() || '';
    }
    if (!label) {
      const parentLabel = el.closest('label');
      if (parentLabel) {
        const clone = parentLabel.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('input, textarea, select').forEach(n => n.remove());
        label = clone.textContent?.trim() || '';
      }
    }
    if (!label) {
      const labelledby = el.getAttribute('aria-labelledby');
      if (labelledby) {
        const ref = document.getElementById(labelledby);
        if (ref) label = ref.textContent?.trim() || '';
      }
    }
    if (!label) label = el.getAttribute('aria-label') || '';
    if (!label) label = (el as HTMLInputElement).placeholder || '';
    if (!label) label = (el as HTMLInputElement).name || '';
    if (!label) label = 'Field';

    const required = (el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true';

    fields.push({
      key: String(fields.length),
      label,
      kind,
      required,
      options,
      selector,
      tagName: tag,
      nameAttr: (el as HTMLInputElement).name || '',
      idAttr: el.id || '',
    });
  }

  // 3. Discover visible actions (links and buttons)
  const actions: InspectedAction[] = [];
  const actionElements = Array.from(document.querySelectorAll('a[href], button, input[type="button"], input[type="submit"], input[type="reset"], [role="button"]')) as HTMLElement[];
  for (const el of actionElements) {
    if (!isVisible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const selector = computeUniqueSelector(el);
    if (!selector) continue;

    let kind: 'link' | 'button' = 'button';
    let href: string | undefined;
    let label = '';

    if (tag === 'a' && el.hasAttribute('href')) {
      kind = 'link';
      const rawHref = el.getAttribute('href') || '';
      if (rawHref.startsWith('javascript:') || rawHref === '#') continue;
      try {
        const resolved = new URL(rawHref, location.href);
        if (resolved.protocol !== 'https:') continue;
        href = resolved.href;
      } catch {
        continue;
      }
      label = el.textContent?.trim() || el.getAttribute('aria-label') || el.getAttribute('title') || '';
    } else {
      kind = 'button';
      if (tag === 'input') {
        label = (el as HTMLInputElement).value || el.getAttribute('aria-label') || '';
      } else {
        label = el.textContent?.trim() || el.getAttribute('aria-label') || el.getAttribute('title') || '';
      }
    }

    if (!label && kind === 'button') label = 'Button';
    if (!label && kind === 'link') label = href || 'Link';

    actions.push({
      key: String(actions.length),
      label,
      kind,
      href,
      selector,
      tagName: tag,
    });
  }

  return {
    title: document.title || '',
    url: location.href,
    text: fullText,
    truncated,
    fields,
    actions,
  };
}

export async function openAgentBrowser(options: OpenAgentBrowserOptions): Promise<AgentBrowser> {
  let policy = structuredClone(options.navigation);
  const contexts = new Set<BrowserContext>();
  const dnsCache = new Map<string, Promise<string>>();
  let main: Page | undefined;
  let epoch = 0;
  type Binding = { handle: import('playwright').ElementHandle<HTMLElement>; signature: InspectedField | InspectedAction; epoch: number; origin: string };
  const fields = new Map<string, Binding>();
  const actions = new Map<string, Binding>();
  const privateVariants = new Set<string>();
  let privatePattern: RegExp | undefined;
  function redact(value: string): string {
    return privatePattern ? value.normalize('NFKC').replace(privatePattern, '[private]') : value;
  }
  function remember(value: string): void {
    if (!value) return;
    for (const variant of [value, value.normalize('NFKC'), encodeURIComponent(value), encodeURI(value), JSON.stringify(value).slice(1, -1)]) privateVariants.add(variant);
    const alternatives = [...privateVariants].sort((a, b) => b.length - a.length).map(variant => Array.from(variant.replace(/\s/g, '')).map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*')).filter(Boolean);
    privatePattern = new RegExp(alternatives.join('|'), 'giu');
  }
  function safeUrl(value: string): string {
    const cleaned = redact(value);
    try { new URL(cleaned); return cleaned; } catch { return 'https://private-origin.invalid/'; }
  }

  async function closeContexts(): Promise<void> {
    ++epoch;
    main = undefined; fields.clear(); actions.clear(); privateVariants.clear(); privatePattern = undefined;
    const results = await Promise.allSettled([...contexts].map(context => context.close()));
    contexts.clear();
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(item => item.reason), 'BROWSER_CLOSE_FAILED');
  }
  async function validate(url: string): Promise<URL> {
    const target = validateTargetUrl(url, policy);
    await assertPublicDestination(target.hostname.replace(/^\[|\]$/g, ''), dnsCache, options.dnsLookupFn);
    return target;
  }
  function check(signal: AbortSignal, generation: number): void {
    if (signal.aborted || generation !== epoch) throw Error('OPERATION_ABORTED');
  }
  async function createPage(signal: AbortSignal): Promise<Page> {
    if (signal.aborted) throw Error('OPERATION_ABORTED');
    const context = await options.browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1280, height: 800 } });
    contexts.add(context);
    context.on('close', () => contexts.delete(context));
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.route('**/*', async route => {
      try {
        const request = route.request(), url = new URL(request.url());
        if (url.protocol !== 'https:' || url.username || url.password) throw Error('NAVIGATION_BLOCKED');
        await assertPublicDestination(url.hostname.replace(/^\[|\]$/g, ''), dnsCache, options.dnsLookupFn);
        if (request.isNavigationRequest()) validateTargetUrl(url.href, policy);
        await route.continue();
      } catch { await route.abort('blockedbyclient').catch(() => {}); }
    });
    const page = await context.newPage();
    page.on('popup', popup => { void popup.close().catch(() => {}); });
    page.on('download', download => { void download.cancel().catch(() => {}); });
    if (options.prepareWebsite) await options.prepareWebsite(page);
    if (signal.aborted) { await context.close(); throw Error('OPERATION_ABORTED'); }
    return page;
  }
  async function ensureMain(signal: AbortSignal): Promise<Page> {
    if (!main || main.isClosed()) {
      main = await createPage(signal);
      main.on('framenavigated', frame => {
        if (frame === main?.mainFrame()) { fields.clear(); actions.clear(); }
      });
    }
    return main;
  }
  async function abortable<T>(signal: AbortSignal, operation: (generation: number) => Promise<T>): Promise<T> {
    if (signal.aborted) throw Error('OPERATION_ABORTED');
    const generation = epoch;
    let closure: Promise<void> | undefined;
    const abort = () => { closure = closeContexts(); void closure.catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await operation(generation); check(signal, generation); return result;
    } finally { signal.removeEventListener('abort', abort); await closure; }
  }
  async function matches(binding: Binding): Promise<boolean> {
    if (!main || binding.epoch !== epoch) return false;
    return binding.handle.evaluate((element, { signature, origin }) => {
      if (location.origin !== origin || !element.isConnected || element.ownerDocument !== document || window !== window.top) return false;
      if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0 || box.top < 0 || box.left < 0 || box.right > innerWidth || box.bottom > innerHeight) return false;
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      if (!hit || (hit !== element && !element.contains(hit))) return false;
      if (element.tagName.toLowerCase() !== signature.tagName || element.closest('[inert],fieldset[disabled]') || element.hasAttribute('disabled')) return false;
      if ('nameAttr' in signature) {
        const field = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        if (field.name !== signature.nameAttr || field.id !== signature.idAttr || ('readOnly' in field && field.readOnly)) return false;
        const labels = 'labels' in field ? Array.from(field.labels ?? []) : [];
        let label = labels.map(item => {
          const clone = item.cloneNode(true) as HTMLElement;
          clone.querySelectorAll('input,textarea,select').forEach(control => control.remove());
          return clone.textContent?.trim() || '';
        }).filter(Boolean)[0] || '';
        if (!label) {
          const ref = field.getAttribute('aria-labelledby');
          if (ref) label = document.getElementById(ref)?.textContent?.trim() || '';
        }
        label ||= field.getAttribute('aria-label') || field.getAttribute('placeholder') || field.name || 'Field';
        return label === signature.label;
      }
      const label = element instanceof HTMLInputElement ? element.value || element.getAttribute('aria-label') || '' : element.textContent?.trim() || element.getAttribute('aria-label') || element.getAttribute('title') || '';
      if (label !== signature.label) return false;
      if (signature.kind === 'link') return element instanceof HTMLAnchorElement && element.href === signature.href;
      if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) {
        const formTarget = element.getAttribute('formtarget') || element.form?.target || '_self';
        if (formTarget !== '_self') return false;
      }
      return true;
    }, { signature: binding.signature, origin: binding.origin }).catch(() => false);
  }
  async function bind(inspection: DomInspectionResult): Promise<{ fields: BrowserField[]; actions: BrowserAction[] }> {
    await Promise.all([...fields.values(), ...actions.values()].map(binding => binding.handle.dispose().catch(() => {})));
    fields.clear(); actions.clear();
    const projected = { fields: [] as BrowserField[], actions: [] as BrowserAction[] };
    if (!main || main.isClosed()) return projected;
    for (const item of inspection.fields.slice(0, 100)) {
      const elements = await main.$$(item.selector);
      if (elements.length !== 1) { await Promise.all(elements.map(element => element.dispose())); continue; }
      const binding: Binding = { handle: elements[0] as import('playwright').ElementHandle<HTMLElement>, signature: item, epoch, origin: new URL(inspection.url).origin };
      if (!await matches(binding)) { await binding.handle.dispose(); continue; }
      const id = randomBytes(16).toString('hex'); fields.set(id, binding);
      projected.fields.push({ id, label: item.label, kind: item.kind, required: item.required, ...(item.options ? { options: item.options.slice(0, 256) } : {}) });
    }
    for (const item of inspection.actions.slice(0, 100)) {
      const elements = await main.$$(item.selector);
      if (elements.length !== 1) { await Promise.all(elements.map(element => element.dispose())); continue; }
      const binding: Binding = { handle: elements[0] as import('playwright').ElementHandle<HTMLElement>, signature: item, epoch, origin: new URL(inspection.url).origin };
      if (!await matches(binding)) { await binding.handle.dispose(); continue; }
      const id = randomBytes(16).toString('hex'); actions.set(id, binding);
      projected.actions.push({ id, label: item.label, kind: item.kind, ...('href' in item && item.href ? { href: item.href } : {}) });
    }
    return projected;
  }
  async function reflectedMasks(page: Page): Promise<Rect[]> {
    if (!privatePattern) return [];
    // Gather page text without ever sending the host's private-value list into page JavaScript.
    const records = await page.evaluate(() => {
      const result: { text: string; rects: { x: number; y: number; width: number; height: number }[] }[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null; let count = 0; let size = 0;
      while ((node = walker.nextNode())) {
        if (++count > 20000) throw Error('PREVIEW_TEXT_LIMIT');
        const parent = node.parentElement;
        if (!parent || parent.closest('script,style,noscript,template,input,textarea,select,[contenteditable]')) continue;
        const style = getComputedStyle(parent);
        if (style.visibility !== 'visible' || style.display === 'none') continue;
        const range = document.createRange(); range.selectNodeContents(node);
        const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth).map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }));
        if (!rects.length) continue;
        const text = (node.textContent ?? '').normalize('NFKC');
        size += text.length;
        if (size > 262144) throw Error('PREVIEW_TEXT_LIMIT');
        result.push({ text, rects });
      }
      return result;
    });
    const text = records.map(record => record.text).join('');
    const ranges: { start: number; end: number; rects: Rect[] }[] = [];
    let offset = 0;
    for (const record of records) {
      ranges.push({ start: offset, end: offset + record.text.length, rects: record.rects });
      offset += record.text.length;
    }
    const masked = new Set<Rect>();
    privatePattern.lastIndex = 0;
    for (const match of text.matchAll(privatePattern)) {
      for (const range of ranges) if (range.start < match.index + match[0].length && range.end > match.index) for (const rect of range.rects) masked.add(rect);
    }
    return [...masked];
  }
  async function inspect(signal: AbortSignal): Promise<BrowserObservation> {
    const page = await ensureMain(signal);
    const inspection = await page.evaluate(inPageInspectDom);
    const projected = await bind(inspection);
    return {
      url: safeUrl(inspection.url), title: redact(inspection.title).slice(0, 300),
      text: redact(inspection.text).slice(0, MAX_TEXT_CHARS),
      fields: projected.fields.map(field => ({ ...field, label: redact(field.label).slice(0, 200), ...(field.options ? { options: field.options.map(option => redact(option).slice(0, 512)) } : {}) })),
      actions: projected.actions.map(action => ({ ...action, label: redact(action.label).slice(0, 200), href: action.href && redact(action.href) === action.href ? action.href : undefined })),
      publicOnly: false, truncated: inspection.truncated || inspection.text.length > MAX_TEXT_CHARS,
    };
  }
  const driver: AgentBrowser = {
    async navigate(url, signal) {
      await validate(url);
      return abortable(signal, async generation => {
        const page = await ensureMain(signal); check(signal, generation);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        check(signal, generation); return inspect(signal);
      });
    },
    async observe(signal) { return abortable(signal, () => inspect(signal)); },
    async click(actionId, signal) {
      return abortable(signal, async generation => {
        const binding = actions.get(actionId);
        if (!binding || !await matches(binding)) throw Error('ACTION_VERIFICATION_FAILED');
        check(signal, generation);
        const action = binding.signature as InspectedAction;
        if (action.kind === 'link' && action.href) {
          await validate(action.href); check(signal, generation);
          await main!.goto(action.href, { waitUntil: 'domcontentloaded', timeout: 25000 });
        } else {
          await binding.handle.click({ timeout: 5000 });
          await main!.waitForLoadState('domcontentloaded', { timeout: 5000 });
        }
        check(signal, generation); return inspect(signal);
      });
    },
    async type(fieldId, value, signal) {
      return abortable(signal, async generation => {
        const binding = fields.get(fieldId);
        if (!binding || !await matches(binding)) throw Error('FIELD_VERIFICATION_FAILED');
        const field = binding.signature as InspectedField;
        if (field.kind !== 'text' || !/search|keyword|query|\bq\b/i.test(`${field.label} ${field.nameAttr} ${field.idAttr}`)) throw Error('TYPE_FORBIDDEN');
        check(signal, generation);
        await binding.handle.fill(value, { timeout: 5000 });
        check(signal, generation); return inspect(signal);
      });
    },
    async fill(fieldId, value, signal) {
      await abortable(signal, async generation => {
        const binding = fields.get(fieldId);
        if (!binding || !await matches(binding)) throw Error('FIELD_VERIFICATION_FAILED');
        check(signal, generation);
        remember(value);
        // Native setter and events run in one synchronous page evaluation; value never returns.
        await binding.handle.evaluate((element, secret) => {
          if (!element.isConnected || element.closest('[inert],fieldset[disabled]')) throw Error('FIELD_VERIFICATION_FAILED');
          if (element instanceof HTMLSelectElement) {
            const matches = Array.from(element.options).filter(option => !option.disabled && (option.value === secret || option.text.trim() === secret));
            if (matches.length !== 1) throw Error('INVALID_SELECT_VALUE');
            secret = matches[0]!.value;
          }
          if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) throw Error('INVALID_FIELD');
          if (element.disabled || ('readOnly' in element && element.readOnly)) throw Error('INVALID_FIELD');
          const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, secret);
          if (element.value !== secret) throw Error('FIELD_VALUE_REJECTED');
          element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
        }, value);
        check(signal, generation);
      });
    },
    async scroll(direction, signal) {
      return abortable(signal, async generation => {
        const page = await ensureMain(signal);
        await page.evaluate(sign => scrollBy(0, sign * innerHeight * 0.75), direction === 'down' ? 1 : -1);
        check(signal, generation); return inspect(signal);
      });
    },
    async research(url, signal) {
      await validate(url);
      return abortable(signal, async generation => {
        const page = await createPage(signal);
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
          check(signal, generation);
          const inspection = await page.evaluate(inPageInspectDom);
          // Research workers have no interaction capabilities or cookies from the main browser.
          return { url: safeUrl(inspection.url), title: redact(inspection.title).slice(0, 300), text: redact(inspection.text).slice(0, MAX_TEXT_CHARS), fields: [], actions: [], publicOnly: true, truncated: inspection.truncated || inspection.text.length > MAX_TEXT_CHARS };
        } finally { await page.context().close(); }
      });
    },
    async capture() {
      const page = main;
      if (!page || page.isClosed()) return null;
      try {
        const before = await gatherMasks(page, `${CONTROL_LOCATOR_SELECTOR},${IFRAME_LOCATOR_SELECTOR}`);
        const reflectedBefore = await reflectedMasks(page);
        const raw = await page.screenshot({ type: 'png', scale: 'css', timeout: 5000, mask: [page.locator(CONTROL_LOCATOR_SELECTOR), page.locator(IFRAME_LOCATOR_SELECTOR)], maskColor: '#000000' });
        const after = await gatherMasks(page, `${CONTROL_LOCATOR_SELECTOR},${IFRAME_LOCATOR_SELECTOR}`);
        const reflectedAfter = await reflectedMasks(page);
        validateMaskGeometry(before, after);
        const metadata = await sharp(raw).metadata();
        if (!metadata.width || !metadata.height) return null;
        const image = await sharp(raw).composite([{ input: composeRedactionSvg(metadata.width, metadata.height, unionRects(before, after), [...reflectedBefore, ...reflectedAfter]), top: 0, left: 0 }]).png().toBuffer();
        return { image: image.toString('base64'), width: metadata.width, height: metadata.height };
      } catch { return null; }
    },
    currentOrigin() { try { return main && !main.isClosed() ? new URL(main.url()).origin : undefined; } catch { return undefined; } },
    redact,
    async setNavigation(next) { await closeContexts(); policy = structuredClone(next); dnsCache.clear(); },
    close: closeContexts,
  };
  return driver;
}
