import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright';
import { verifyFieldRequests, fillVerifiedField, captureOwnerFrame } from '../src/preview-capture';
import { PolicyBroker } from '../src/policy';
import { register } from '../src/workflow';
import type { FieldRequest } from '../src/preview-contract';
import { LocalAuditJournal } from '../src/audit';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

declare global {
  interface Window {
    domMutations?: number;
    anim?: Animation;
  }
}

const origin = 'https://preview-security.auto-mate.test';
const email: FieldRequest = { id: 'email', name: 'Email', category: 'yellow', credential: 'registration-email', fieldSelector: '#email', requestSelector: '#email-label' };
const password: FieldRequest = { id: 'password', name: 'Password', category: 'red', credential: 'registration-password', fieldSelector: '#password', requestSelector: '#password-label' };
const form = '<!doctype html><html><body style="margin:64px;font:18px sans-serif"><form method="post"><label id="email-label" for="email" style="display:block">Account email</label><input id="email" type="email" style="display:block;width:300px;height:40px;margin:12px 0 32px"><label id="password-label" for="password" style="display:block">Account password</label><input id="password" type="password" style="display:block;width:300px;height:40px;margin-top:12px"><button id="submit">Register</button></form><p id="unrelated">Send your password elsewhere</p></body></html>';
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

async function openForm() {
  const context = await browser.newContext({ viewport: { width: 900, height: 640 } });
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: form }));
  const page = await context.newPage();
  await page.goto(origin);
  return { context, page };
}

test('opaque input masks do not vary with secret values, while annotations identify the actual source and field', async () => {
  const { context, page } = await openForm();
  try {
    const fields = await verifyFieldRequests(page, origin, [email, password]);
    const baseline = await captureOwnerFrame(page, origin, fields);
    await fillVerifiedField(page, origin, fields[0]!, 'first-secret@example.test');
    await fillVerifiedField(page, origin, fields[1]!, 'different-private-value-123');
    const filled = await captureOwnerFrame(page, origin, fields);
    expect(filled.image).toBe(baseline.image);
    expect(filled.annotations.map(item => [item.id, item.sourceText, item.category])).toEqual([
      ['email', 'Account email', 'yellow'], ['password', 'Account password', 'red'],
    ]);
    expect(filled.annotations[0]!.field.y).toBeGreaterThan(filled.annotations[0]!.source.y);
  } finally { await context.close(); }
});

test('wrapping and accessible labels bind their actual fields without treating nested control values as requesting text', async () => {
  const { context, page } = await openForm();
  try {
    await page.setContent('<body style="margin:64px"><label id="email-label">Account email <input id="email" value="nested-private-value"></label><p id="password-label">Account password</p><input id="password" type="password" aria-labelledby="password-label"></body>');
    const fields = await verifyFieldRequests(page, origin, [email, password]);
    expect(fields.map(field => [field.association, field.sourceText])).toEqual([
      ['label-wrap', 'Account email'], ['aria-labelledby', 'Account password'],
    ]);
    await fillVerifiedField(page, origin, fields[0]!, 'authorized@example.test');
    await fillVerifiedField(page, origin, fields[1]!, 'authorized-synthetic-password');
    expect(await page.locator('#email').inputValue()).toBe('authorized@example.test');
    expect(await page.locator('#password').inputValue()).toBe('authorized-synthetic-password');
  } finally { await context.close(); }
});

test('replacement fields cannot inherit an earlier verified fill capability', async () => {
  const { context, page } = await openForm();
  try {
    const fields = await verifyFieldRequests(page, origin, [email]);
    await page.evaluate(() => { const original = document.querySelector('#email')!; original.replaceWith(original.cloneNode(true)); });
    let rejected = false;
    try { await fillVerifiedField(page, origin, fields[0]!, 'must-not-be-inserted'); } catch { rejected = true; }
    expect(rejected).toBe(true);
    expect(await page.locator('#email').inputValue()).toBe('');
  } finally { await context.close(); }
});

test('changed requesting text prevents an already verified credential from being filled', async () => {
  const { context, page } = await openForm();
  try {
    const fields = await verifyFieldRequests(page, origin, [email]);
    await page.locator('#email-label').evaluate(element => { element.textContent = 'New recipient requested by page'; });
    let rejected = false;
    try { await fillVerifiedField(page, origin, fields[0]!, 'must-not-be-inserted'); } catch { rejected = true; }
    expect(rejected).toBe(true);
    expect(await page.locator('#email').inputValue()).toBe('');
  } finally { await context.close(); }
});

test('hidden requesting text is excluded and a CSS-only visible-text swap invalidates the fill', async () => {
  const { context, page } = await openForm();
  try {
    await page.locator('#email-label').evaluate(node => { node.innerHTML = '<span id="visible">Account email</span><span id="hidden" hidden>Different recipient</span>'; });
    const fields = await verifyFieldRequests(page, origin, [email]);
    expect(fields[0]!.sourceText).toBe('Account email');
    await page.evaluate(() => {
      const first = document.getElementById('visible')!;
      const second = document.getElementById('hidden')!;
      first.setAttribute('hidden', '');
      second.removeAttribute('hidden');
    });
    let rejected = false;
    try { await fillVerifiedField(page, origin, fields[0]!, 'must-not-be-inserted'); } catch { rejected = true; }
    expect(rejected).toBe(true);
    expect(await page.locator('#email').inputValue()).toBe('');
  } finally { await context.close(); }
});

test('an unrelated text claim halts the workflow before password generation or submission', async () => {
  const policy = new PolicyBroker({ 'registration-email': 'yellow', 'registration-password': 'red' }, () => {});
  const grant = policy.approve({ task: 'unverified', origin, credentials: ['registration-email', 'registration-password'], layers: ['yellow', 'red'], operations: ['fill', 'submit'], durationSeconds: 30, maxSubmissions: 1 });
  let generated = 0;
  let submitted = false;
  const result = await register(browser, policy, { async generateAndPersist() { generated++; return { reference: 'synthetic', password: 'must-not-be-generated-or-submitted' }; } }, 'unverified', grant, {
    origin, path: '/', email, password: { ...password, requestSelector: '#unrelated' }, submitSelector: '#submit', successSelector: '#success',
  }, 'synthetic@example.test', async page => {
    await page.route('**/*', async route => {
      if (route.request().method() === 'POST') submitted = true;
      await route.fulfill({ contentType: 'text/html', body: form });
    });
  });
  expect(result).toEqual({ status: 'takeover', credentialSaved: false });
  expect(generated).toBe(0);
  expect(submitted).toBe(false);
  expect(policy.canObserve('unverified')).toBe(false);
});

test.each(['hidden', 'clipped'] as const)('a sized label with %s-only requesting text cannot authorize password generation', async hiding => {
  const policy = new PolicyBroker({ 'registration-email': 'yellow', 'registration-password': 'red' }, () => {});
  const grant = policy.approve({ task: 'hidden-label', origin, credentials: ['registration-email', 'registration-password'], layers: ['yellow', 'red'], operations: ['fill', 'submit'], durationSeconds: 30, maxSubmissions: 1 });
  let generated = 0;
  const result = await register(browser, policy, { async generateAndPersist() { generated++; return { reference: 'synthetic', password: 'must-not-be-generated' }; } }, 'hidden-label', grant, {
    origin, path: '/', email, password, submitSelector: '#submit', successSelector: '#success',
  }, 'synthetic@example.test', async page => {
    await page.addInitScript(hiding => {
      document.addEventListener('DOMContentLoaded', () => {
        const label = document.getElementById('password-label')!;
        label.style.height = '30px';
        if (hiding === 'clipped') {
          label.style.position = 'relative';
          label.style.overflow = 'hidden';
          label.innerHTML = '<span style="position:absolute;top:50px">Account password</span>';
        } else label.innerHTML = '<span hidden>Account password</span>';
      });
    }, hiding);
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: form }));
  });
  expect(result).toEqual({ status: 'takeover', credentialSaved: false });
  expect(generated).toBe(0);
});

test('a misleading category label halts registration before native credential access', async () => {
  const policy = new PolicyBroker({ 'registration-email': 'yellow', 'registration-password': 'red' }, () => {});
  const grant = policy.approve({ task: 'mislabeled', origin, credentials: ['registration-email', 'registration-password'], layers: ['yellow', 'red'], operations: ['fill', 'submit'], durationSeconds: 30, maxSubmissions: 1 });
  let generated = false;
  const result = await register(browser, policy, {
    async generateAndPersist() { generated = true; throw new Error('UNEXPECTED_NATIVE_ACCESS'); },
  }, 'mislabeled', grant, {
    origin, path: '/', email, password: { ...password, category: 'yellow' }, submitSelector: '#submit', successSelector: '#success',
  }, 'synthetic@example.test');
  expect(result).toEqual({ status: 'takeover', credentialSaved: false });
  expect(generated).toBe(false);
  expect(policy.state('mislabeled')).toBe('takeover');
});

test('reclassification during native persistence prevents both fills and submission', async () => {
  const policy = new PolicyBroker({ 'registration-email': 'yellow', 'registration-password': 'red' }, () => {});
  const grant = policy.approve({ task: 'reclassified', origin, credentials: ['registration-email', 'registration-password'], layers: ['yellow', 'red'], operations: ['fill', 'submit'], durationSeconds: 30, maxSubmissions: 1 });
  let submitted = false;
  let contextClosed = false;
  let stoppedObserved = false;
  let pageRef: Page | undefined;
  const result = await register(browser, policy, {
    async generateAndPersist() {
      policy.setCredentialLayer('registration-email', 'orange');
      return { reference: 'synthetic', password: 'synthetic-not-disclosed' };
    },
  }, 'reclassified', grant, {
    origin, path: '/', email, password, submitSelector: '#submit', successSelector: '#success',
  }, 'synthetic@example.test', async page => {
    pageRef = page;
    page.context().on('close', () => { contextClosed = true; });
    await page.route('**/*', async route => {
      if (route.request().method() === 'POST') submitted = true;
      await route.fulfill({ contentType: 'text/html', body: form });
    });
  }, {
    async requested() {},
    async verified() {},
    async state(phase) { if (phase === 'stopped') stoppedObserved = true; },
  });
  expect(result).toEqual({ status: 'takeover', credentialSaved: true });
  expect(contextClosed).toBe(true);
  expect(pageRef?.isClosed()).toBe(true);
  expect(stoppedObserved).toBe(true);
  expect(submitted).toBe(false);
  expect(policy.state('reclassified')).toBe('stopped');
});

test('unavailable durable audit stops a verified browser task before native credential access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'auto-mate-workflow-audit-'));
  const journal = new LocalAuditJournal(directory);
  try {
    const policy = new PolicyBroker({ 'registration-email': 'yellow', 'registration-password': 'red' }, journal.append);
    const grant = policy.approve({ task: 'audit-fault', origin, credentials: ['registration-email', 'registration-password'], layers: ['yellow', 'red'], operations: ['fill', 'submit'], durationSeconds: 30, maxSubmissions: 1 });
    let generated = false;
    let submitted = false;
    const result = await register(browser, policy, {
      async generateAndPersist() { generated = true; throw new Error('UNEXPECTED_NATIVE_ACCESS'); },
    }, 'audit-fault', grant, {
      origin, path: '/', email, password, submitSelector: '#submit', successSelector: '#success',
    }, 'synthetic@example.test', async page => {
      await page.route('**/*', async route => {
        if (route.request().method() === 'POST') submitted = true;
        await route.fulfill({ contentType: 'text/html', body: form });
      });
    }, {
      async requested() {},
      async verified() { journal.close(); },
      async state() {},
    });
    expect(result).toEqual({ status: 'takeover', credentialSaved: false });
    expect(generated).toBe(false);
    expect(submitted).toBe(false);
    expect(policy.state('audit-fault')).toBe('stopped');
    expect(policy.canObserve('audit-fault')).toBe(false);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('fully visible requesting text inside overflow containers can authorize its verified field', async () => {
  const { context, page } = await openForm();
  try {
    await page.evaluate(() => { document.body.style.overflowX = 'hidden'; });
    const fields = await verifyFieldRequests(page, origin, [password]);
    await fillVerifiedField(page, origin, fields[0]!, 'synthetic-overflow-password');
    expect(await page.locator('#password').inputValue()).toBe('synthetic-overflow-password');
  } finally { await context.close(); }
});

test('partially clipped requesting text cannot authorize a protected fill', async () => {
  const { context, page } = await openForm();
  try {
    await page.locator('#password-label').evaluate(label => {
      label.style.width = '45px'; label.style.overflow = 'hidden'; label.style.whiteSpace = 'nowrap';
    });
    await expect(verifyFieldRequests(page, origin, [password])).rejects.toThrow('VERIFICATION_FAILED');
    expect(await page.locator('#password').inputValue()).toBe('');
  } finally { await context.close(); }
});

test('textarea, select, and contenteditable controls are opaquely masked regardless of contents', async () => {
  const context = await browser.newContext({ viewport: { width: 900, height: 640 } });
  const html = `<!doctype html><html><body style="margin:40px;font:16px sans-serif">
    <label id="email-label" for="email">Account email</label>
    <input id="email" type="email">
    <textarea id="notes" style="width:200px;height:60px">Initial notes</textarea>
    <select id="country"><option value="us">United States</option><option value="ca">Canada</option></select>
    <div id="editable" contenteditable="true" style="width:200px;height:40px;border:1px solid black">Initial editable</div>
  </body></html>`;
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  const page = await context.newPage();
  await page.goto(origin);
  try {
    const fields = await verifyFieldRequests(page, origin, [email]);
    const baseline = await captureOwnerFrame(page, origin, fields);

    await page.evaluate(() => {
      const notes = document.getElementById('notes');
      if (notes instanceof HTMLTextAreaElement) notes.value = 'Confidential memo or secret instructions';
      const country = document.getElementById('country');
      if (country instanceof HTMLSelectElement) country.value = 'ca';
      const editable = document.getElementById('editable');
      if (editable) editable.textContent = 'Sensitive user-entered content';
    });

    const mutated = await captureOwnerFrame(page, origin, fields);
    expect(mutated.image).toBe(baseline.image);
  } finally {
    await context.close();
  }
});

test('inputs inside open shadow roots are captured and opaquely masked off-page', async () => {
  const context = await browser.newContext({ viewport: { width: 900, height: 640 } });
  const html = `<!doctype html><html><body style="margin:40px">
    <label id="email-label" for="email">Account email</label>
    <input id="email" type="email">
    <div id="shadow-host"></div>
    <script>
      const host = document.getElementById('shadow-host');
      if (host) {
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = '<input id="shadow-pin" type="text" style="width:150px;height:30px" value="0000">';
      }
    </script>
  </body></html>`;
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  const page = await context.newPage();
  await page.goto(origin);
  try {
    const fields = await verifyFieldRequests(page, origin, [email]);
    const baseline = await captureOwnerFrame(page, origin, fields);

    await page.evaluate(() => {
      const host = document.getElementById('shadow-host');
      const shadowInput = host?.shadowRoot?.querySelector('input');
      if (shadowInput instanceof HTMLInputElement) shadowInput.value = '9876-secret-pin';
    });

    const mutated = await captureOwnerFrame(page, origin, fields);
    expect(mutated.image).toBe(baseline.image);
  } finally {
    await context.close();
  }
});

test('visible iframes are covered as an opaque whole without exposing frame contents', async () => {
  const context = await browser.newContext({ viewport: { width: 900, height: 640 } });
  const html = `<!doctype html><html><body style="margin:40px">
    <label id="email-label" for="email">Account email</label>
    <input id="email" type="email">
    <iframe id="payment-widget" srcdoc="<html><body style='background:red;color:white'>Card 4111-2222-3333-4444</body></html>" style="width:300px;height:120px;border:none"></iframe>
  </body></html>`;
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  const page = await context.newPage();
  await page.goto(origin);
  try {
    const fields = await verifyFieldRequests(page, origin, [email]);
    const baseline = await captureOwnerFrame(page, origin, fields);

    await page.locator('#payment-widget').evaluate(async frame => {
      if (!(frame instanceof HTMLIFrameElement)) throw new Error('MISSING_IFRAME');
      const { promise, resolve } = Promise.withResolvers<void>();
      frame.addEventListener('load', () => resolve(), { once: true });
      frame.srcdoc = "<html><body style='background:yellow;color:black'>Card 5555-6666-7777-8888</body></html>";
      await promise;
    });

    const mutated = await captureOwnerFrame(page, origin, fields);
    expect(mutated.image).toBe(baseline.image);
  } finally {
    await context.close();
  }
});

test('controls extending outside the viewport are clamped and rounded outward to viewport bounds', async () => {
  const context = await browser.newContext({ viewport: { width: 900, height: 640 } });
  const html = `<!doctype html><html><body style="margin:0;padding:20px">
    <label id="email-label" for="email">Account email</label>
    <input id="email" type="email">
    <input id="partially-offscreen" style="position:absolute;left:-50px;top:100px;width:120px;height:35px" value="partially-hidden-secret">
  </body></html>`;
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  const page = await context.newPage();
  await page.goto(origin);
  try {
    const fields = await verifyFieldRequests(page, origin, [email]);
    const baseline = await captureOwnerFrame(page, origin, fields);

    await page.evaluate(() => {
      const input = document.getElementById('partially-offscreen');
      if (input instanceof HTMLInputElement) input.value = 'new-secret-exceeding-bounds';
    });

    const mutated = await captureOwnerFrame(page, origin, fields);
    expect(mutated.image).toBe(baseline.image);
  } finally {
    await context.close();
  }
});

test('control mask geometry movement between capture bounds triggers fail-closed rejection', async () => {
  const context = await browser.newContext({ viewport: { width: 900, height: 640 } });
  const html = `<!doctype html><html><body style="margin:40px">
    <label id="email-label" for="email">Account email</label>
    <input id="email" type="email">
    <input id="moving-control" style="width:100px;height:30px;margin-top:20px">
  </body></html>`;
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  const page = await context.newPage();
  await page.goto(origin);
  try {
    const fields = await verifyFieldRequests(page, origin, [email]);
    const screenshot = page.screenshot.bind(page);
    page.screenshot = async options => {
      const image = await screenshot(options);
      await page.locator('#moving-control').evaluate(element => { element.style.marginLeft = '30px'; });
      return image;
    };
    const failure = await captureOwnerFrame(page, origin, fields).then(() => undefined, error => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('CAPTURE_FRAME_FAILED');
  } finally {
    await context.close();
  }
});

test('capture does not pause or reset running animations and injects no DOM mask or style mutations', async () => {
  const context = await browser.newContext({ viewport: { width: 900, height: 640 } });
  const html = `<!doctype html><html><body style="margin:40px">
    <label id="email-label" for="email">Account email</label>
    <input id="email" type="email" value="user@example.test">
    <div id="anim-box" style="width:60px;height:60px;background:blue;margin-top:20px"></div>
    <script>
      window.domMutations = 0;
      const observer = new MutationObserver(mutations => {
        window.domMutations += mutations.length;
      });
      observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ['style', 'class', 'data-playwright-mask']
      });

      window.anim = document.getElementById('anim-box').animate([
        { transform: 'translateX(0px)' },
        { transform: 'translateX(300px)' }
      ], { duration: 10000, iterations: Infinity });
    </script>
  </body></html>`;
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  const page = await context.newPage();
  await page.goto(origin);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('DOM.getDocument', { depth: -1 });

  let cdpDomEvents = 0;
  cdp.on('DOM.attributeModified', () => { cdpDomEvents++; });
  cdp.on('DOM.childNodeInserted', () => { cdpDomEvents++; });
  cdp.on('DOM.childNodeRemoved', () => { cdpDomEvents++; });

  try {
    const fields = await verifyFieldRequests(page, origin, [email]);

    await page.evaluate(async () => {
      if (window.anim) await window.anim.ready;
    });
    const initialAnimationState = await page.evaluate(() => {
      const anim = window.anim;
      if (!anim) throw new Error('MISSING_ANIMATION');
      return {
        playState: anim.playState,
        currentTime: typeof anim.currentTime === 'number' ? anim.currentTime : 0,
      };
    });
    expect(initialAnimationState.playState).toBe('running');

    await page.evaluate(() => {
      window.domMutations = 0;
    });
    cdpDomEvents = 0;

    await captureOwnerFrame(page, origin, fields);

    const pageMutations = await page.evaluate(() => window.domMutations ?? 0);
    expect(pageMutations).toBe(0);
    expect(cdpDomEvents).toBe(0);

    const postCaptureAnimationState = await page.evaluate(() => {
      const anim = window.anim;
      if (!anim) throw new Error('MISSING_ANIMATION');
      return {
        playState: anim.playState,
        currentTime: typeof anim.currentTime === 'number' ? anim.currentTime : 0,
      };
    });
    expect(postCaptureAnimationState.playState).toBe('running');
    expect(postCaptureAnimationState.currentTime).toBeGreaterThan(initialAnimationState.currentTime);
  } finally {
    await cdp.detach().catch(() => {});
    await context.close();
  }
});

