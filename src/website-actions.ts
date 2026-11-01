import type { ElementHandle, Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { httpsOrigin } from './policy';

export interface WebsiteAction {
  readonly id: string;
  readonly label: string;
  readonly kind: 'button' | 'submit' | 'reset';
}

interface DiscoveredButton {
  readonly selector: string;
  readonly label: string;
  readonly kind: 'button' | 'submit' | 'reset';
}

interface DiscoveryResult {
  readonly candidates: readonly DiscoveredButton[];
}

interface BoundAction {
  readonly action: WebsiteAction;
  readonly handle: ElementHandle<HTMLButtonElement | HTMLInputElement>;
  readonly selector: string;
  readonly origin: string;
  readonly label: string;
  readonly kind: 'button' | 'submit' | 'reset';
}

/** Executed entirely within the worker page context. */
function discoverDocumentButtons({ origin }: { origin: string }): DiscoveryResult {
  if (window !== window.top || location.origin !== origin) {
    return { candidates: [] };
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
    if (
      !element.isConnected ||
      element.ownerDocument !== document ||
      !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
      box.width <= 0 ||
      box.height <= 0 ||
      box.left < 0 ||
      box.top < 0 ||
      box.right > innerWidth ||
      box.bottom > innerHeight
    ) {
      return false;
    }
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
      if (
        !parent ||
        !node.textContent?.trim() ||
        parent.closest('input,textarea,select,[contenteditable]') ||
        !parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      ) {
        continue;
      }
      let left = 0;
      let top = 0;
      let right = innerWidth;
      let bottom = innerHeight;
      let unsupported = false;
      for (let ancestor: HTMLElement | null = parent; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (
          style.clip !== 'auto' ||
          style.clipPath !== 'none' ||
          style.maskImage !== 'none' ||
          (style.transform !== 'none' && !new DOMMatrixReadOnly(style.transform).isIdentity) ||
          style.perspective !== 'none' ||
          (style.zoom !== '1' && style.zoom !== 'normal') ||
          /(?:^|\s)(?:paint|strict|content)(?:\s|$)/.test(style.contain)
        ) {
          unsupported = true;
          break;
        }
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
          const box = ancestor.getBoundingClientRect();
          const x = box.left + ancestor.clientLeft;
          const y = box.top + ancestor.clientTop;
          if (style.overflowX !== 'visible') {
            left = Math.max(left, x);
            right = Math.min(right, x + ancestor.clientWidth);
          }
          if (style.overflowY !== 'visible') {
            top = Math.max(top, y);
            bottom = Math.min(bottom, y + ancestor.clientHeight);
          }
        }
      }
      if (unsupported) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
      const rendered =
        rects.length > 0 &&
        rects.every(rect => {
          if (rect.left < left || rect.right > right || rect.top < top || rect.bottom > bottom) return false;
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return !!hit && (hit === parent || parent.contains(hit) || hit === source || source.contains(hit));
        });
      if (rendered) textParts.push(node.textContent ?? '');
    }
    const sourceText = textParts.join(' ').replace(/\s+/g, ' ').trim();
    if (!sourceText || sourceText.length > 200) return null;
    return sourceText;
  }

  function extractButtonLabel(el: HTMLElement): string | null {
    if (el instanceof HTMLButtonElement) {
      let label = extractSourceText(el);
      if (!label) {
        const labelledby = el.getAttribute('aria-labelledby')?.trim();
        if (labelledby && !labelledby.includes(' ')) {
          const target = document.getElementById(labelledby);
          if (target && document.querySelectorAll('#' + CSS.escape(labelledby)).length === 1 && isVisible(target)) {
            label = extractSourceText(target);
          }
        }
      }
      if (!label || label.length > 200) return null;
      return label;
    }
    if (el instanceof HTMLInputElement) {
      let label = (el.value || '').replace(/\s+/g, ' ').trim();
      if (!label) {
        const labelledby = el.getAttribute('aria-labelledby')?.trim();
        if (labelledby && !labelledby.includes(' ')) {
          const target = document.getElementById(labelledby);
          if (target && document.querySelectorAll('#' + CSS.escape(labelledby)).length === 1 && isVisible(target)) {
            label = extractSourceText(target) || '';
          }
        }
      }
      if (!label || label.length > 200) return null;
      return label;
    }
    return null;
  }

  const rawElements = Array.from(document.querySelectorAll('button, input')) as HTMLElement[];
  const candidates: Array<{
    element: HTMLElement;
    selector: string;
    label: string;
    kind: 'button' | 'submit' | 'reset';
  }> = [];

  for (const el of rawElements) {
    if (!(el instanceof HTMLButtonElement) && !(el instanceof HTMLInputElement)) continue;
    if (el.disabled || !!el.closest('fieldset[disabled]')) continue;
    if (el instanceof HTMLInputElement && el.readOnly) continue;
    if (el instanceof HTMLInputElement && el.type.toLowerCase() === 'file') continue;

    // Reject downloads
    if (el.hasAttribute('download') || el.hasAttribute('formdownload') || !!el.form?.hasAttribute('download')) {
      continue;
    }

    let kind: 'button' | 'submit' | 'reset';
    if (el instanceof HTMLButtonElement) {
      const type = (el.type || 'submit').toLowerCase();
      if (!['button', 'submit', 'reset'].includes(type)) continue;
      kind = type as 'button' | 'submit' | 'reset';
    } else {
      const type = el.type.toLowerCase();
      if (!['button', 'submit', 'reset'].includes(type)) continue;
      kind = type as 'button' | 'submit' | 'reset';
    }
    const target = el.getAttribute('formtarget') || el.form?.getAttribute('target') || '_self';
    if (target.trim().toLowerCase() !== '_self') continue;
    if (kind === 'submit') {
      try {
        const destination = new URL(el.hasAttribute('formaction') ? el.formAction : el.form?.action || location.href);
        if (destination.origin !== origin || destination.username || destination.password) continue;
      } catch {
        continue;
      }
    }

    if (!isVisible(el)) continue;

    const label = extractButtonLabel(el);
    if (!label) continue;

    const selector = computeUniqueSelector(el);
    if (!selector) continue;

    candidates.push({ element: el, selector, label, kind });
  }

  // Filter out duplicate or ambiguous labels and duplicate elements
  const labelCounts = new Map<string, number>();
  const elementCounts = new Map<HTMLElement, number>();

  for (const c of candidates) {
    const norm = c.label.toLowerCase();
    labelCounts.set(norm, (labelCounts.get(norm) ?? 0) + 1);
    elementCounts.set(c.element, (elementCounts.get(c.element) ?? 0) + 1);
  }

  const uniqueCandidates = candidates.filter(c => {
    if ((labelCounts.get(c.label.toLowerCase()) ?? 0) > 1) return false;
    if ((elementCounts.get(c.element) ?? 0) > 1) return false;
    return true;
  });

  return {
    candidates: uniqueCandidates.map(c => ({
      selector: c.selector,
      label: c.label,
      kind: c.kind,
    })),
  };
}

export class WebsiteActions {
  readonly actions: readonly WebsiteAction[];
  readonly #page: Page;
  readonly #origin: string;
  readonly #actionsMap: Map<string, BoundAction>;

  private constructor(
    page: Page,
    origin: string,
    actions: readonly WebsiteAction[],
    actionsMap: Map<string, BoundAction>,
  ) {
    this.#page = page;
    this.#origin = origin;
    this.actions = Object.freeze([...actions]);
    this.#actionsMap = actionsMap;
  }

  static async discover(page: Page, origin: string): Promise<WebsiteActions> {
    const canonical = httpsOrigin(origin);
    if (new URL(page.url()).origin !== canonical) {
      throw new Error('ORIGIN_MISMATCH');
    }

    const discovery: DiscoveryResult = await page.evaluate(discoverDocumentButtons, { origin: canonical });

    const actions: WebsiteAction[] = [];
    const actionsMap = new Map<string, BoundAction>();

    for (const candidate of discovery.candidates) {
      const matches = await page.$$(candidate.selector);
      if (matches.length !== 1 || !matches[0]) {
        await Promise.all(matches.map(m => m.dispose().catch(() => {})));
        continue;
      }

      const handle = matches[0] as ElementHandle<HTMLButtonElement | HTMLInputElement>;
      const id = randomUUID();
      const action: WebsiteAction = Object.freeze({
        id,
        label: candidate.label,
        kind: candidate.kind,
      });

      actions.push(action);
      actionsMap.set(id, {
        action,
        handle,
        selector: candidate.selector,
        origin: canonical,
        label: candidate.label,
        kind: candidate.kind,
      });
    }

    return new WebsiteActions(page, canonical, actions, actionsMap);
  }

  async verify(id: string): Promise<void> {
    const bound = this.#actionsMap.get(id);
    if (!bound) {
      throw new Error('ACTION_NOT_FOUND');
    }

    if (new URL(this.#page.url()).origin !== this.#origin) {
      throw new Error('ORIGIN_MISMATCH');
    }

    let reason: string | false = 'ok';
    try {
      reason = await bound.handle.evaluate(
        (el, expected) => {
          if (window !== window.top) return 'not-top-window';
          if (location.origin !== expected.origin) return 'origin-mismatch:' + location.origin;
          if (!el.isConnected || el.ownerDocument !== document) return 'not-connected';

          const isButton = el instanceof HTMLButtonElement;
          const isInput = el instanceof HTMLInputElement;
          if (!isButton && !isInput) return false;

          if (el.disabled || !!el.closest('fieldset[disabled]')) return false;
          if (isInput && el.readOnly) return false;
          if (isInput && el.type.toLowerCase() === 'file') return false;

          if (el.hasAttribute('download') || el.hasAttribute('formdownload') || !!el.form?.hasAttribute('download')) {
            return 'download-attr';
          }

          const currentKind = isButton ? (el.type || 'submit').toLowerCase() : el.type.toLowerCase();
          if (currentKind !== expected.expectedKind) return 'kind-mismatch:' + currentKind;
          const target = el.getAttribute('formtarget') || el.form?.getAttribute('target') || '_self';
          if (target.trim().toLowerCase() !== '_self') return 'target-not-self';
          if (currentKind === 'submit') {
            const destination = new URL(el.hasAttribute('formaction') ? el.formAction : el.form?.action || location.href);
            if (destination.origin !== expected.origin || destination.username || destination.password) return 'form-destination-changed';
          }
          function isVisible(element: HTMLElement): boolean {
            const box = element.getBoundingClientRect();
            if (
              !element.isConnected ||
              element.ownerDocument !== document ||
              !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
              box.width <= 0 ||
              box.height <= 0 ||
              box.left < 0 ||
              box.top < 0 ||
              box.right > innerWidth ||
              box.bottom > innerHeight
            ) {
              return false;
            }
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            if (!hit || (hit !== element && !element.contains(hit))) return false;
            return true;
          }
          if (!isVisible(el)) return 'not-visible';
          function extractSourceText(source: HTMLElement): string | null {
            const textParts: string[] = [];
            const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const node = walker.currentNode;
              const parent = node.parentElement;
              if (
                !parent ||
                !node.textContent?.trim() ||
                parent.closest('input,textarea,select,[contenteditable]') ||
                !parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
              ) {
                continue;
              }
              let left = 0;
              let top = 0;
              let right = innerWidth;
              let bottom = innerHeight;
              let unsupported = false;
              for (let ancestor: HTMLElement | null = parent; ancestor; ancestor = ancestor.parentElement) {
                const style = getComputedStyle(ancestor);
                if (
                  style.clip !== 'auto' ||
                  style.clipPath !== 'none' ||
                  style.maskImage !== 'none' ||
                  (style.transform !== 'none' && !new DOMMatrixReadOnly(style.transform).isIdentity) ||
                  style.perspective !== 'none' ||
                  (style.zoom !== '1' && style.zoom !== 'normal') ||
                  /(?:^|\s)(?:paint|strict|content)(?:\s|$)/.test(style.contain)
                ) {
                  unsupported = true;
                  break;
                }
                if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
                  const box = ancestor.getBoundingClientRect();
                  const x = box.left + ancestor.clientLeft;
                  const y = box.top + ancestor.clientTop;
                  if (style.overflowX !== 'visible') {
                    left = Math.max(left, x);
                    right = Math.min(right, x + ancestor.clientWidth);
                  }
                  if (style.overflowY !== 'visible') {
                    top = Math.max(top, y);
                    bottom = Math.min(bottom, y + ancestor.clientHeight);
                  }
                }
              }
              if (unsupported) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
              const rendered =
                rects.length > 0 &&
                rects.every(rect => {
                  if (rect.left < left || rect.right > right || rect.top < top || rect.bottom > bottom) return false;
                  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                  return !!hit && (hit === parent || parent.contains(hit) || hit === source || source.contains(hit));
                });
              if (rendered) textParts.push(node.textContent ?? '');
            }
            const sourceText = textParts.join(' ').replace(/\s+/g, ' ').trim();
            if (!sourceText || sourceText.length > 200) return null;
            return sourceText;
          }

          function extractButtonLabel(element: HTMLElement): string | null {
            if (element instanceof HTMLButtonElement) {
              let label = extractSourceText(element);
              if (!label) {
                const labelledby = element.getAttribute('aria-labelledby')?.trim();
                if (labelledby && !labelledby.includes(' ')) {
                  const target = document.getElementById(labelledby);
                  if (target && document.querySelectorAll('#' + CSS.escape(labelledby)).length === 1 && isVisible(target)) {
                    label = extractSourceText(target);
                  }
                }
              }
              if (!label || label.length > 200) return null;
              return label;
            }
            if (element instanceof HTMLInputElement) {
              let label = (element.value || '').replace(/\s+/g, ' ').trim();
              if (!label) {
                const labelledby = element.getAttribute('aria-labelledby')?.trim();
                if (labelledby && !labelledby.includes(' ')) {
                  const target = document.getElementById(labelledby);
                  if (target && document.querySelectorAll('#' + CSS.escape(labelledby)).length === 1 && isVisible(target)) {
                    label = extractSourceText(target) || '';
                  }
                }
              }
              if (!label || label.length > 200) return null;
              return label;
            }
            return null;
          }

          const currentLabel = extractButtonLabel(el);
          if (currentLabel !== expected.expectedLabel) return 'label-mismatch:' + currentLabel;
          // Check ambiguity across document
          const allButtons = Array.from(document.querySelectorAll('button, input')) as HTMLElement[];
          let matches = 0;
          for (const other of allButtons) {
            if (other !== el) {
              if (!(other instanceof HTMLButtonElement) && !(other instanceof HTMLInputElement)) continue;
              if (other.disabled || !!other.closest('fieldset[disabled]')) continue;
              if (other instanceof HTMLInputElement && other.readOnly) continue;
              if (other instanceof HTMLInputElement && other.type.toLowerCase() === 'file') continue;
              if (other.hasAttribute('download') || other.hasAttribute('formdownload') || !!other.form?.hasAttribute('download')) {
                continue;
              }
              const oKind = other instanceof HTMLButtonElement ? (other.type || 'submit').toLowerCase() : other.type.toLowerCase();
              if (!['button', 'submit', 'reset'].includes(oKind)) continue;
              if (!isVisible(other)) continue;
              const oLabel = extractButtonLabel(other);
              if (oLabel && oLabel.toLowerCase() === expected.expectedLabel.toLowerCase()) {
                matches++;
              }
            }
          }
          if (matches > 0) return 'ambiguous:' + matches;

          const query = document.querySelectorAll(expected.expectedSelector);
          if (query.length !== 1 || query[0] !== el) return 'selector-mismatch:' + query.length + ':' + expected.expectedSelector;

          return 'ok';
        },
        {
          origin: bound.origin,
          expectedLabel: bound.label,
          expectedKind: bound.kind,
          expectedSelector: bound.selector,
        },
      );
    } catch {
      reason = 'eval-exception';
    }

    if (reason !== 'ok') {
      throw new Error('VERIFICATION_FAILED');
    }
  }

  async click(id: string, signal: AbortSignal, assertActive: () => void): Promise<void> {
    if (signal.aborted) throw new Error('TASK_STOPPED');
    assertActive();

    const bound = this.#actionsMap.get(id);
    if (!bound) throw new Error('ACTION_NOT_FOUND');

    if (new URL(this.#page.url()).origin !== this.#origin) {
      throw new Error('ORIGIN_MISMATCH');
    }

    // Re-verify exact node/label/type/origin in DOM before click
    await this.verify(id);

    // Re-verify after await
    if (signal.aborted) throw new Error('TASK_STOPPED');
    assertActive();
    if (new URL(this.#page.url()).origin !== this.#origin) {
      throw new Error('ORIGIN_MISMATCH');
    }

    // Signal/guard recheck immediately before real Playwright click; one attempt, no retries.
    if (signal.aborted) throw new Error('TASK_STOPPED');
    assertActive();

    const { promise: abortPromise, reject } = Promise.withResolvers<never>();
    let abortClosure: Promise<void> | undefined;
    const onAbort = () => {
      abortClosure = this.#page.context().close();
      void abortClosure.catch(() => {});
      reject(new Error('TASK_STOPPED'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      await Promise.race([
        bound.handle.click({ timeout: 10000 }),
        abortPromise,
      ]);
    } catch (err) {
      if (signal.aborted) throw new Error('TASK_STOPPED');
      throw err;
    } finally {
      signal.removeEventListener('abort', onAbort);
      await abortClosure;
    }
  }

  async dispose(): Promise<void> {
    for (const bound of this.#actionsMap.values()) {
      await bound.handle.dispose().catch(() => {});
    }
    this.#actionsMap.clear();
  }
}
