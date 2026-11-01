import type { ElementHandle, Page } from 'playwright';
import sharp from 'sharp';
import { httpsOrigin } from './policy';
import type { Annotation, Association, FieldRequest, OwnerFrame, Rect, VerifiedField } from './preview-contract';

interface DomPair {
  field: HTMLInputElement | HTMLSelectElement;
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
    const input = field instanceof HTMLInputElement;
    const select = field instanceof HTMLSelectElement;
    if ((!input && !select) || !(source instanceof HTMLElement) || field.disabled ||
        (input && (field.readOnly || ['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file'].includes(field.type))) ||
        (select && field.multiple) ||
        (['registration-password', 'autofill:password'].includes(request.credential) && (!input || field.type !== 'password')))
      throw new Error('EVIDENCE_INVALID');
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
      if (!parent || !node.textContent?.trim() || parent.closest('input,textarea,select,[contenteditable]') ||
          !parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      // Accept whole text nodes only when every fragment fits the viewport and each overflow clip.
      // Nonrectangular clipping, transforms, masking, and paint containment remain unsupported.
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
    if (!sourceText || sourceText.length > 200 || (pair.expected &&
        (pair.expected.sourceText !== sourceText || pair.expected.association !== association))) throw new Error('EVIDENCE_INVALID');
    annotations.push({ id: request.id, name: request.name, category: request.category, sourceText, association, source: sourceRect, field: fieldRect });
  }
  // All supplied evidence is validated before any value is inserted. No asynchronous gap to the native setter.
  for (const pair of pairs) {
    if (pair.value === undefined) continue;
    if (pair.field instanceof HTMLSelectElement) {
      const options = Array.from(pair.field.options).filter(option => option.value === pair.value);
      if (options.length !== 1 || options[0]!.disabled || options[0]!.parentElement instanceof HTMLOptGroupElement &&
          options[0]!.parentElement.disabled) throw new Error('EVIDENCE_INVALID');
    }
    const prototype = pair.field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
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
      const field = matches[0] as ElementHandle<HTMLInputElement | HTMLSelectElement>;
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

const CONTROL_LOCATOR_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const IFRAME_LOCATOR_SELECTOR = 'iframe';

async function gatherMasks(page: Page, selector: string): Promise<readonly Rect[]> {
  // One read-only layout snapshot also includes controls in open shadow roots.
  return page.locator(selector).evaluateAll(elements => {
    const rects: Rect[] = [];
    for (const element of elements) {
      const box = element.getBoundingClientRect();
      if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) throw new Error('EVIDENCE_INVALID');
      if (box.width > 0 && box.height > 0) rects.push({ x: box.x, y: box.y, width: box.width, height: box.height });
    }
    return rects;
  });
}

function validateMaskGeometry(before: readonly Rect[], after: readonly Rect[]): void {
  if (before.length !== after.length) {
    throw new Error('EVIDENCE_INVALID');
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
      throw new Error('EVIDENCE_INVALID');
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
    throw new Error('EVIDENCE_INVALID');
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
      throw new Error('EVIDENCE_INVALID');
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

/** Owner-only pixels, not a model-safe redaction channel. All regular controls and visible iframes are opaquely masked in host memory. */
export async function captureOwnerFrame(page: Page, origin: string, fields: readonly VerifiedField[]): Promise<OwnerFrame> {
  try {
    const canonical = httpsOrigin(origin);
    const pairs = fields.map(field => ({
      field: field.field,
      source: field.source,
      request: field.request,
      expected: { association: field.association, sourceText: field.sourceText },
    }));

    const before = await page.evaluate(inspectDocument, { origin: canonical, pairs });
    const [beforeControls, beforeFrames] = await Promise.all([
      gatherMasks(page, CONTROL_LOCATOR_SELECTOR),
      gatherMasks(page, IFRAME_LOCATOR_SELECTOR),
    ]);

    const rawBuffer = await page.screenshot({
      type: 'png',
      scale: 'css',
      animations: 'allow',
      caret: 'initial',
      timeout: 5000,
    });

    const after = await page.evaluate(inspectDocument, { origin: canonical, pairs });
    const [afterControls, afterFrames] = await Promise.all([
      gatherMasks(page, CONTROL_LOCATOR_SELECTOR),
      gatherMasks(page, IFRAME_LOCATOR_SELECTOR),
    ]);

    if (
      before.width !== after.width ||
      before.height !== after.height ||
      before.scrollX !== after.scrollX ||
      before.scrollY !== after.scrollY
    ) {
      throw new Error('EVIDENCE_INVALID');
    }

    for (const [index, first] of before.annotations.entries()) {
      const last = after.annotations[index];
      if (!last) throw new Error('EVIDENCE_INVALID');
      for (const role of ['source', 'field'] as const) {
        for (const property of ['x', 'y', 'width', 'height'] as const) {
          if (Math.abs(first[role][property] - last[role][property]) > 1) {
            throw new Error('EVIDENCE_INVALID');
          }
        }
      }
    }

    validateMaskGeometry(beforeControls, afterControls);
    validateMaskGeometry(beforeFrames, afterFrames);

    const imageMeta = await sharp(rawBuffer).metadata();
    if (
      !imageMeta.width ||
      !imageMeta.height ||
      imageMeta.width !== before.width ||
      imageMeta.height !== before.height
    ) {
      throw new Error('EVIDENCE_INVALID');
    }

    const mergedControls = unionRects(beforeControls, afterControls);
    const mergedFrames = unionRects(beforeFrames, afterFrames);
    const svgBuffer = composeRedactionSvg(imageMeta.width, imageMeta.height, mergedControls, mergedFrames);

    const redacted = await sharp(rawBuffer)
      .composite([{ input: svgBuffer, top: 0, left: 0 }])
      .png()
      .toBuffer();

    return Object.freeze({
      image: redacted.toString('base64'),
      width: before.width,
      height: before.height,
      annotations: Object.freeze(before.annotations),
      capturedAt: Date.now(),
    });
  } catch {
    throw new Error('CAPTURE_FRAME_FAILED');
  }
}
