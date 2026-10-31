import type { ElementHandle, Page } from 'playwright';
import { httpsOrigin } from './policy';
import type { Annotation, Association, FieldRequest, OwnerFrame, Rect, VerifiedField } from './preview-contract';

interface DomPair {
  field: HTMLInputElement;
  source: HTMLElement;
  request: FieldRequest;
  expected?: { association: Association; sourceText: string };
  value?: string;
}
interface DocumentEvidence {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  annotations: Annotation[];
}

/** Serialized into the worker page: keep every validation and the final setter in this function. */
function inspectDocument({ origin, pairs }: { origin: string; pairs: readonly DomPair[] }): DocumentEvidence {
  if (location.origin !== origin || window !== window.top) throw new Error('EVIDENCE_INVALID');
  const seenFields = new Set<Element>();
  const seenSources = new Set<Element>();
  const annotations: Annotation[] = [];
  function visibleRect(element: HTMLElement): Rect {
    const box = element.getBoundingClientRect();
    if (!element.isConnected || element.ownerDocument !== document ||
        !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
        box.width <= 0 || box.height <= 0 || box.left < 0 || box.top < 0 ||
        box.right > innerWidth || box.bottom > innerHeight) throw new Error('EVIDENCE_INVALID');
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (!hit || (hit !== element && !element.contains(hit))) throw new Error('EVIDENCE_INVALID');
    return { x: box.left, y: box.top, width: box.width, height: box.height };
  }
  for (const pair of pairs) {
    const { field, source, request } = pair;
    if (!(field instanceof HTMLInputElement) || !(source instanceof HTMLElement) || field.disabled || field.readOnly ||
        ['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file'].includes(field.type) ||
        (request.credential === 'registration-password' && field.type !== 'password')) throw new Error('EVIDENCE_INVALID');
    const selectedFields = document.querySelectorAll(request.fieldSelector);
    const selectedSources = document.querySelectorAll(request.requestSelector);
    if (selectedFields.length !== 1 || selectedFields[0] !== field || selectedSources.length !== 1 || selectedSources[0] !== source ||
        seenFields.has(field) || seenSources.has(source)) throw new Error('EVIDENCE_INVALID');
    seenFields.add(field); seenSources.add(source);
    const fieldRect = visibleRect(field);
    const sourceRect = visibleRect(source);
    let association: Association | undefined;
    if (source instanceof HTMLLabelElement) {
      if (source.htmlFor && source.htmlFor === field.id && source.control === field &&
          document.querySelectorAll('#' + CSS.escape(field.id)).length === 1) association = 'label-for';
      else if (!source.htmlFor && source.contains(field) && field.closest('label') === source && source.control === field)
        association = 'label-wrap';
    }
    if (!association && source.id && field.getAttribute('aria-labelledby')?.split(/\s+/).includes(source.id) &&
        document.querySelectorAll('#' + CSS.escape(source.id)).length === 1) association = 'aria-labelledby';
    if (!association) throw new Error('EVIDENCE_INVALID');
    // Only rendered Text nodes qualify. Hidden descendants and control values are not requesting text.
    const textParts: string[] = [];
    const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || parent.closest('input,textarea,select,[contenteditable]') ||
          !parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      // Range rectangles do not account for ancestor clipping. Unsupported clipping fails closed.
      let clipped = false;
      for (let ancestor: HTMLElement | null = parent; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible' || style.clip !== 'auto' ||
            style.clipPath !== 'none' || style.maskImage !== 'none' ||
            /(?:^|\s)(?:paint|strict|content)(?:\s|$)/.test(style.contain)) {
          clipped = true;
          break;
        }
      }
      if (clipped) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = range.getClientRects();
      let rendered = false;
      for (let index = 0; index < rects.length; index++) {
        const rect = rects.item(index);
        if (rect && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
            rect.left < innerWidth && rect.top < innerHeight) { rendered = true; break; }
      }
      if (rendered) textParts.push(node.textContent ?? '');
    }
    const sourceText = textParts.join(' ').replace(/\s+/g, ' ').trim();
    if (!sourceText || sourceText.length > 200 || (pair.expected &&
        (pair.expected.sourceText !== sourceText || pair.expected.association !== association))) throw new Error('EVIDENCE_INVALID');
    annotations.push({ id: request.id, name: request.name, category: request.category, sourceText, association, source: sourceRect, field: fieldRect });
  }
  // All supplied evidence is validated before any value is inserted. No asynchronous gap to the native setter.
  for (const pair of pairs) {
    if (pair.value === undefined) continue;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('EVIDENCE_INVALID');
    setter.call(pair.field, pair.value);
    pair.field.dispatchEvent(new Event('input', { bubbles: true }));
    pair.field.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { width: innerWidth, height: innerHeight, scrollX, scrollY, annotations };
}

/** Untrusted proposals become capabilities only after structural validation. No nearest-text inference. */
export async function verifyFieldRequests(page: Page, origin: string, requests: readonly FieldRequest[]): Promise<readonly VerifiedField[]> {
  const handles: ElementHandle[] = [];
  try {
    const canonical = httpsOrigin(origin);
    if (!requests.length || new URL(page.url()).origin !== canonical) throw new Error('EVIDENCE_INVALID');
    const ids = new Set<string>();
    const pairs = [];
    for (const input of requests) {
      if (!input.id || !input.name || !input.credential || ids.has(input.id) ||
          !['yellow', 'orange', 'red'].includes(input.category)) throw new Error('EVIDENCE_INVALID');
      ids.add(input.id);
      const request = Object.freeze({ ...input });
      const matches = await page.$$(request.fieldSelector);
      handles.push(...matches);
      if (matches.length !== 1 || !matches[0]) throw new Error('EVIDENCE_INVALID');
      const sources = await page.$$(request.requestSelector);
      handles.push(...sources);
      if (sources.length !== 1 || !sources[0]) throw new Error('EVIDENCE_INVALID');
      // Runtime node-type validation occurs in inspectDocument before these typed handles are used.
      const field = matches[0] as ElementHandle<HTMLInputElement>;
      const source = sources[0] as ElementHandle<HTMLElement>;
      pairs.push({ field, source, request });
    }
    const evidence = await page.evaluate(inspectDocument, { origin: canonical, pairs });
    return Object.freeze(pairs.map((pair, index) => {
      const annotation = evidence.annotations[index];
      if (!annotation) throw new Error('EVIDENCE_INVALID');
      return Object.freeze({ ...pair, association: annotation.association, sourceText: annotation.sourceText });
    }));
  } catch {
    await Promise.all(handles.map(handle => handle.dispose().catch(() => {})));
    throw new Error('VERIFICATION_FAILED');
  }
}

/** Reuses the same DOM validator inside the synchronous browser operation that writes the value. */
export async function fillVerifiedField(page: Page, origin: string, field: VerifiedField, value: string): Promise<void> {
  try {
    if (typeof value !== 'string') throw new Error('EVIDENCE_INVALID');
    await page.evaluate(inspectDocument, { origin: httpsOrigin(origin), pairs: [{
      field: field.field, source: field.source, request: field.request,
      expected: { association: field.association, sourceText: field.sourceText }, value,
    }] });
  } catch { throw new Error('FILL_VERIFIED_FIELD_FAILED'); }
}

/** Owner-only pixels, not a model-safe redaction channel. All regular controls are opaquely masked. */
export async function captureOwnerFrame(page: Page, origin: string, fields: readonly VerifiedField[]): Promise<OwnerFrame> {
  try {
    const canonical = httpsOrigin(origin);
    const pairs = fields.map(field => ({ field: field.field, source: field.source, request: field.request,
      expected: { association: field.association, sourceText: field.sourceText } }));
    const before = await page.evaluate(inspectDocument, { origin: canonical, pairs });
    const image = await page.screenshot({ type: 'png', scale: 'css', animations: 'disabled', caret: 'hide', timeout: 5000,
      mask: page.frames().map(frame => frame.locator('input,textarea,select,[contenteditable]:not([contenteditable="false"])')),
      maskColor: '#000000' });
    const after = await page.evaluate(inspectDocument, { origin: canonical, pairs });
    if (before.width !== after.width || before.height !== after.height || before.scrollX !== after.scrollX || before.scrollY !== after.scrollY)
      throw new Error('EVIDENCE_INVALID');
    for (const [index, first] of before.annotations.entries()) {
      const last = after.annotations[index];
      if (!last) throw new Error('EVIDENCE_INVALID');
      for (const role of ['source', 'field'] as const) for (const property of ['x', 'y', 'width', 'height'] as const)
        if (Math.abs(first[role][property] - last[role][property]) > 1) throw new Error('EVIDENCE_INVALID');
    }
    return Object.freeze({ image: image.toString('base64'), width: before.width, height: before.height,
      annotations: Object.freeze(before.annotations), capturedAt: Date.now() });
  } catch { throw new Error('CAPTURE_FRAME_FAILED'); }
}
