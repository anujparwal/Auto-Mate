import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { PolicyBroker } from '../src/policy';
import { register, type PasswordStore, type Registration } from '../src/workflow';
import type { FieldRequest, WorkflowObserver } from '../src/preview-contract';

const origin = 'https://workflow-cancel.auto-mate.test';
const email: FieldRequest = {
  id: 'email',
  name: 'Email',
  category: 'yellow',
  credential: 'registration-email',
  fieldSelector: '#email',
  requestSelector: '#email-label',
};
const password: FieldRequest = {
  id: 'password',
  name: 'Password',
  category: 'red',
  credential: 'registration-password',
  fieldSelector: '#password',
  requestSelector: '#password-label',
};
const formHtml = `<!doctype html><html><body style="margin:64px;font:18px sans-serif">
  <form method="post">
    <label id="email-label" for="email">Account email</label>
    <input id="email" type="email" style="display:block;width:300px;height:40px;margin:12px 0 32px">
    <label id="password-label" for="password">Account password</label>
    <input id="password" type="password" style="display:block;width:300px;height:40px;margin-top:12px">
    <button id="submit">Register</button>
  </form>
  <div id="success" style="display:none">Success</div>
</body></html>`;

const workflow: Registration = {
  origin,
  path: '/',
  email,
  password,
  submitSelector: '#submit',
  successSelector: '#success',
};

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

test('blocked navigation closes context promptly before route release', async () => {
  const policy = new PolicyBroker({ 'registration-email': 'yellow', 'registration-password': 'red' }, () => {});
  const grant = policy.approve({
    task: 'blocked-nav',
    origin,
    credentials: ['registration-email', 'registration-password'],
    layers: ['yellow', 'red'],
    operations: ['fill', 'submit'],
    durationSeconds: 30,
    maxSubmissions: 1,
  });

  const { promise: navStarted, resolve: markNavStarted } = Promise.withResolvers<void>();
  const { promise: navGate, resolve: releaseNav } = Promise.withResolvers<void>();
  const { promise: contextClosedPromise, resolve: markContextClosed } = Promise.withResolvers<void>();

  let nativeAccessed = false;
  let pageRef: Page | undefined;
  const store: PasswordStore = {
    async generateAndPersist() {
      nativeAccessed = true;
      return { reference: 'ref', password: 'secret' };
    },
  };

  const registerPromise = register(browser, policy, store, 'blocked-nav', grant, workflow, 'synthetic@example.test', async page => {
    pageRef = page;
    page.context().on('close', () => markContextClosed());
    await page.route('**/*', async route => {
      markNavStarted();
      await navGate;
      try {
        await route.fulfill({ contentType: 'text/html', body: formHtml });
      } catch {
        /* route may fail if context was closed */
      }
    });
  });

  await navStarted;
  policy.stopAll();

  await contextClosedPromise;
  expect(pageRef?.isClosed()).toBe(true);

  // Release route after context is already confirmed closed
  releaseNav();

  const result = await registerPromise;
  expect(result).toEqual({ status: 'takeover', credentialSaved: false });
  expect(nativeAccessed).toBe(false);
  expect(policy.state('blocked-nav')).toBe('stopped');
});

test('pending native persistence closes context before resolving store and later returns confirmed saved with no submission', async () => {
  const policy = new PolicyBroker({ 'registration-email': 'yellow', 'registration-password': 'red' }, () => {});
  const grant = policy.approve({
    task: 'pending-native',
    origin,
    credentials: ['registration-email', 'registration-password'],
    layers: ['yellow', 'red'],
    operations: ['fill', 'submit'],
    durationSeconds: 30,
    maxSubmissions: 1,
  });

  const { promise: storeStarted, resolve: markStoreStarted } = Promise.withResolvers<void>();
  const { promise: storeGate, resolve: releaseStore } = Promise.withResolvers<void>();
  const { promise: contextClosedPromise, resolve: markContextClosed } = Promise.withResolvers<void>();

  let submitted = false;
  let storeResolved = false;
  let pageRef: Page | undefined;
  let stoppedObserved = false;

  const store: PasswordStore = {
    async generateAndPersist() {
      markStoreStarted();
      await storeGate;
      storeResolved = true;
      return { reference: 'ref-native-1', password: 'generated-secret-value' };
    },
  };

  const observer: WorkflowObserver = {
    async requested() {},
    async verified() {},
    async state(phase) {
      if (phase === 'stopped') stoppedObserved = true;
    },
  };

  const registerPromise = register(browser, policy, store, 'pending-native', grant, workflow, 'synthetic@example.test', async page => {
    pageRef = page;
    page.context().on('close', () => markContextClosed());
    await page.route('**/*', async route => {
      if (route.request().method() === 'POST') submitted = true;
      await route.fulfill({ contentType: 'text/html', body: formHtml });
    });
  }, observer);

  await storeStarted;
  policy.revoke(grant);

  await contextClosedPromise;
  expect(pageRef?.isClosed()).toBe(true);
  expect(storeResolved).toBe(false);

  // Now release native store persistence
  releaseStore();

  const result = await registerPromise;
  expect(result).toEqual({ status: 'takeover', credentialSaved: true });
  expect(storeResolved).toBe(true);
  expect(stoppedObserved).toBe(true);
  expect(submitted).toBe(false);
  expect(policy.state('pending-native')).toBe('stopped');
});

test('expiry closes pending browser context promptly without user action', async () => {
  const policy = new PolicyBroker({ 'registration-email': 'yellow', 'registration-password': 'red' }, () => {});
  const grant = policy.approve({
    task: 'expiring-workflow',
    origin,
    credentials: ['registration-email', 'registration-password'],
    layers: ['yellow', 'red'],
    operations: ['fill', 'submit'],
    durationSeconds: 1,
    maxSubmissions: 1,
  });

  const { promise: navStarted, resolve: markNavStarted } = Promise.withResolvers<void>();
  const { promise: contextClosedPromise, resolve: markContextClosed } = Promise.withResolvers<void>();

  let nativeAccessed = false;
  let pageRef: Page | undefined;
  let stoppedObserved = false;

  const store: PasswordStore = {
    async generateAndPersist() {
      nativeAccessed = true;
      return { reference: 'ref', password: 'secret' };
    },
  };

  const observer: WorkflowObserver = {
    async requested() {},
    async verified() {},
    async state(phase) {
      if (phase === 'stopped') stoppedObserved = true;
    },
  };

  const registerPromise = register(browser, policy, store, 'expiring-workflow', grant, workflow, 'synthetic@example.test', async page => {
    pageRef = page;
    page.context().on('close', () => markContextClosed());
    await page.route('**/*', async () => {
      markNavStarted();
      // Keep route pending; active deadline timer must expire and close context
    });
  }, observer);

  await navStarted;

  await contextClosedPromise;
  expect(pageRef?.isClosed()).toBe(true);

  const result = await registerPromise;
  expect(result).toEqual({ status: 'takeover', credentialSaved: false });
  expect(nativeAccessed).toBe(false);
  expect(stoppedObserved).toBe(true);
  expect(policy.state('expiring-workflow')).toBe('stopped');
});

test('unrelated task remains usable after cancellation of another task', async () => {
  const policy = new PolicyBroker({ 'registration-email': 'yellow', 'registration-password': 'red' }, () => {});
  const grantA = policy.approve({
    task: 'task-a',
    origin,
    credentials: ['registration-email', 'registration-password'],
    layers: ['yellow', 'red'],
    operations: ['fill', 'submit'],
    durationSeconds: 30,
    maxSubmissions: 1,
  });
  const grantB = policy.approve({
    task: 'task-b',
    origin,
    credentials: ['registration-email', 'registration-password'],
    layers: ['yellow', 'red'],
    operations: ['fill', 'submit'],
    durationSeconds: 30,
    maxSubmissions: 1,
  });

  const { promise: navAStarted, resolve: markNavAStarted } = Promise.withResolvers<void>();
  const { promise: contextAClosedPromise, resolve: markContextAClosed } = Promise.withResolvers<void>();

  const storeA: PasswordStore = {
    async generateAndPersist() {
      return { reference: 'ref-a', password: 'secret-a' };
    },
  };

  const regAPromise = register(browser, policy, storeA, 'task-a', grantA, workflow, 'userA@example.test', async page => {
    page.context().on('close', () => markContextAClosed());
    await page.route('**/*', async () => {
      markNavAStarted();
    });
  });

  await navAStarted;
  policy.revoke(grantA);
  await contextAClosedPromise;
  const resultA = await regAPromise;
  expect(resultA.status).toBe('takeover');
  expect(policy.state('task-a')).toBe('stopped');

  // Task B proceeds and completes cleanly
  let submittedB = false;
  let savedB = false;
  const storeB: PasswordStore = {
    async generateAndPersist() {
      savedB = true;
      return { reference: 'ref-b', password: 'secret-b' };
    },
  };

  const resultB = await register(browser, policy, storeB, 'task-b', grantB, workflow, 'userB@example.test', async page => {
    await page.route('**/*', async route => {
      if (route.request().method() === 'POST') {
        submittedB = true;
        await route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><html><body><div id="success">Done</div></body></html>',
        });
      } else {
        await route.fulfill({ contentType: 'text/html', body: formHtml });
      }
    });
  });

  expect(resultB).toEqual({ status: 'completed', credentialSaved: true });
  expect(savedB).toBe(true);
  expect(submittedB).toBe(true);
  expect(policy.state('task-b')).toBe('completed');
});

test('successful registration/final observer state completes rather than being aborted by finish', async () => {
  const policy = new PolicyBroker({ 'registration-email': 'yellow', 'registration-password': 'red' }, () => {});
  const grant = policy.approve({
    task: 'successful-task',
    origin,
    credentials: ['registration-email', 'registration-password'],
    layers: ['yellow', 'red'],
    operations: ['fill', 'submit'],
    durationSeconds: 30,
    maxSubmissions: 1,
  });

  let submitted = false;
  let saved = false;
  let pageRef: Page | undefined;
  let contextClosedDuringCompleted = true;
  let capturedAtCompleted = false;

  const store: PasswordStore = {
    async generateAndPersist() {
      saved = true;
      return { reference: 'ref-success', password: 'password-123' };
    },
  };

  const observer: WorkflowObserver = {
    async requested() {},
    async verified() {},
    async state(phase) {
      if (phase === 'completed' && pageRef) {
        contextClosedDuringCompleted = pageRef.isClosed();
        capturedAtCompleted = true;
      }
    },
  };

  const result = await register(browser, policy, store, 'successful-task', grant, workflow, 'success@example.test', async page => {
    pageRef = page;
    await page.route('**/*', async route => {
      if (route.request().method() === 'POST') {
        submitted = true;
        await route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><html><body><div id="success">Done</div></body></html>',
        });
      } else {
        await route.fulfill({ contentType: 'text/html', body: formHtml });
      }
    });
  }, observer);

  expect(result).toEqual({ status: 'completed', credentialSaved: true });
  expect(saved).toBe(true);
  expect(submitted).toBe(true);
  expect(capturedAtCompleted).toBe(true);
  expect(contextClosedDuringCompleted).toBe(false);
  expect(pageRef?.isClosed()).toBe(true);
  expect(policy.state('successful-task')).toBe('completed');
});

test('cancellation arriving before context creation halts registration cleanly', async () => {
  const policy = new PolicyBroker({ 'registration-email': 'yellow', 'registration-password': 'red' }, () => {});
  const grant = policy.approve({
    task: 'pre-cancelled',
    origin,
    credentials: ['registration-email', 'registration-password'],
    layers: ['yellow', 'red'],
    operations: ['fill', 'submit'],
    durationSeconds: 30,
    maxSubmissions: 1,
  });

  policy.revoke(grant);

  let nativeAccessed = false;
  const store: PasswordStore = {
    async generateAndPersist() {
      nativeAccessed = true;
      return { reference: 'ref', password: 'secret' };
    },
  };

  let stoppedObserved = false;
  const observer: WorkflowObserver = {
    async requested() {},
    async verified() {},
    async state(phase) {
      if (phase === 'stopped') stoppedObserved = true;
    },
  };

  const result = await register(browser, policy, store, 'pre-cancelled', grant, workflow, 'user@example.test', undefined, observer);
  expect(result).toEqual({ status: 'takeover', credentialSaved: false });
  expect(nativeAccessed).toBe(false);
  expect(stoppedObserved).toBe(true);
  expect(policy.state('pre-cancelled')).toBe('stopped');
});

test('cancellation arriving during asynchronous context creation closes newly returned context immediately', async () => {
  const policy = new PolicyBroker({ 'registration-email': 'yellow', 'registration-password': 'red' }, () => {});
  const grant = policy.approve({
    task: 'cancel-during-ctx',
    origin,
    credentials: ['registration-email', 'registration-password'],
    layers: ['yellow', 'red'],
    operations: ['fill', 'submit'],
    durationSeconds: 30,
    maxSubmissions: 1,
  });

  const { promise: contextCreationStarted, resolve: markContextCreationStarted } = Promise.withResolvers<void>();
  const { promise: contextGate, resolve: releaseContext } = Promise.withResolvers<void>();

  let nativeAccessed = false;
  let pageCreated = false;
  let closedContext: BrowserContext | undefined;

  const store: PasswordStore = {
    async generateAndPersist() {
      nativeAccessed = true;
      return { reference: 'ref', password: 'secret' };
    },
  };

  const origNewContext = browser.newContext.bind(browser);
  const browserProxy = new Proxy(browser, {
    get(target, prop, receiver) {
      if (prop === 'newContext') {
        return async (...args: Parameters<Browser['newContext']>) => {
          markContextCreationStarted();
          await contextGate;
          const ctx = await origNewContext(...args);
          closedContext = ctx;
          return ctx;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const regPromise = register(browserProxy, policy, store, 'cancel-during-ctx', grant, workflow, 'user@example.test', async () => {
    pageCreated = true;
  });

  await contextCreationStarted;
  policy.revoke(grant);
  releaseContext();

  const result = await regPromise;
  expect(result).toEqual({ status: 'takeover', credentialSaved: false });
  expect(nativeAccessed).toBe(false);
  expect(pageCreated).toBe(false);
  expect(closedContext).toBeDefined();
  expect(closedContext?.pages().length).toBe(0);
  expect(policy.state('cancel-during-ctx')).toBe('stopped');
});

test('teardown errors return a bounded takeover without falsely reporting completion', async () => {
  const policy = new PolicyBroker({ 'registration-email': 'yellow', 'registration-password': 'red' }, () => {});
  const grant = policy.approve({ task: 'close-failure', origin, credentials: ['registration-email', 'registration-password'], layers: ['yellow', 'red'], operations: ['fill', 'submit'], durationSeconds: 30, maxSubmissions: 1 });
  const originalNewContext = browser.newContext.bind(browser);
  let contextClosed = false;
  const controlledBrowser = new Proxy(browser, {
    get(target, property, receiver) {
      if (property !== 'newContext') return Reflect.get(target, property, receiver);
      return async (...args: Parameters<Browser['newContext']>) => {
        const context = await originalNewContext(...args);
        const originalClose = context.close.bind(context);
        context.on('close', () => { contextClosed = true; });
        context.close = async () => {
          await originalClose();
          throw new Error('Synthetic private teardown diagnostic that must not escape');
        };
        return context;
      };
    },
  });
  try {
    const result = await register(controlledBrowser, policy, {
      async generateAndPersist() { return { reference: 'synthetic', password: 'synthetic-test-password' }; },
    }, 'close-failure', grant, workflow, 'synthetic@example.test', async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: route.request().method() === 'POST' ? '<h1 id="success">Done</h1>' : formHtml }));
    });
    expect(result).toEqual({ status: 'takeover', credentialSaved: true });
    expect(contextClosed).toBe(true);
  } finally {
    policy.stopAll();
  }
});
