import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser } from 'playwright';
import { AutofillSession } from '../src/autofill';
import { PolicyBroker } from '../src/policy';
import type { AutofillVault, CardRecord, LoginRecord, VaultEntry, VaultKind, VaultRecord } from '../src/autofill-contract';

const origin = 'https://autofill-test.auto-mate.test';

const loginFormHtml = `<!doctype html>
<html>
<body style="margin:64px;font:18px sans-serif">
  <form id="login-form" method="post" action="/authenticate">
    <div style="margin-bottom:16px">
      <label id="user-label" for="username">Username</label>
      <input id="username" type="text" name="username" style="display:block;width:300px;height:40px">
    </div>
    <div style="margin-bottom:16px">
      <label id="pass-label" for="password">Password</label>
      <input id="password" type="password" name="password" style="display:block;width:300px;height:40px">
    </div>
    <button id="submit" type="submit">Login</button>
  </form>
</body>
</html>`;

const cardFormHtml = `<!doctype html>
<html>
<body style="margin:64px;font:18px sans-serif">
  <form id="card-form" method="post" action="/submit">
    <div style="margin-bottom:16px">
      <label id="cc-name-label" for="cc-name">Name on card</label>
      <input id="cc-name" type="text" name="cc-name" autocomplete="cc-name" style="display:block;width:300px;height:40px">
    </div>
    <div style="margin-bottom:16px">
      <label id="cc-number-label" for="cc-number">Credit card number</label>
      <input id="cc-number" type="text" name="cc-number" autocomplete="cc-number" style="display:block;width:300px;height:40px">
    </div>
    <div style="margin-bottom:16px">
      <label id="cc-csc-label" for="cc-csc">CVV</label>
      <input id="cc-csc" type="text" name="cc-csc" autocomplete="cc-csc" style="display:block;width:300px;height:40px">
    </div>
    <div style="margin-bottom:16px">
      <label id="cc-month-label" for="cc-exp-month">Expiry month</label>
      <select id="cc-exp-month" name="cc-exp-month" autocomplete="cc-exp-month" style="display:block;width:300px;height:40px">
        <option value="1">01</option>
        <option value="2">02</option>
        <option value="3">03</option>
        <option value="4">04</option>
        <option value="5">05</option>
        <option value="6">06</option>
        <option value="7">07</option>
        <option value="8">08</option>
        <option value="9">09</option>
        <option value="10">10</option>
        <option value="11">11</option>
        <option value="12">12</option>
      </select>
    </div>
    <div style="margin-bottom:16px">
      <label id="cc-year-label" for="cc-exp-year">Expiry year</label>
      <select id="cc-exp-year" name="cc-exp-year" autocomplete="cc-exp-year" style="display:block;width:300px;height:40px">
        <option value="2024">2024</option>
        <option value="2025">2025</option>
        <option value="2026">2026</option>
        <option value="2027">2027</option>
        <option value="2028">2028</option>
      </select>
    </div>
    <button id="pay" type="submit">Pay</button>
  </form>
</body>
</html>`;

class InMemoryVault implements AutofillVault {
  private records = new Map<string, VaultRecord>();
  readCount = 0;
  pendingRead?: { promise: Promise<void>; resolve: () => void };

  setRecord(recordOrigin: string, recordId: string, record: VaultRecord): void {
    this.records.set(`${recordOrigin}::${recordId}`, record);
  }

  async list(recordOrigin: string): Promise<readonly VaultEntry[]> {
    const entries: VaultEntry[] = [];
    for (const [key] of this.records.entries()) {
      if (key.startsWith(`${recordOrigin}::`)) {
        const recordId = key.split('::')[1]!;
        entries.push({
          origin: recordOrigin,
          recordId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    }
    return entries;
  }

  async save(recordOrigin: string, recordId: string, record: VaultRecord): Promise<void> {
    this.records.set(`${recordOrigin}::${recordId}`, record);
  }

  async read(recordOrigin: string, recordId: string, kind: VaultKind): Promise<VaultRecord> {
    this.readCount++;
    if (this.pendingRead) {
      await this.pendingRead.promise;
    }
    const record = this.records.get(`${recordOrigin}::${recordId}`);
    if (!record || record.kind !== kind) {
      throw new Error('VAULT_RECORD_NOT_FOUND');
    }
    return record;
  }
}

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

test('automatic discovery and filling only selected fields without form submission', async () => {
  const policy = new PolicyBroker({
    'autofill:username': 'yellow',
    'autofill:password': 'red',
  }, () => {});

  const vault = new InMemoryVault();
  const loginRecord: LoginRecord = {
    version: 1,
    kind: 'login',
    username: 'tomsmith',
    password: 'SuperSecretPassword!',
  };
  vault.setRecord(origin, 'login-1', loginRecord);

  const session = await AutofillSession.open(browser, origin + '/login', 'login', {
    prepare: async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: loginFormHtml }));
    },
  });

  try {
    expect(session.origin).toBe(origin);
    expect(session.url).toBe(origin + '/login');
    expect(session.state).toBe('review');
    expect(session.fields.map(c => c.field).sort()).toEqual(['password', 'username']);

    // Capture baseline frame
    const frame = await session.capture();
    expect(frame.annotations.length).toBe(2);

    const grant = policy.approve({
      task: 'autofill-login',
      origin,
      credentials: ['autofill:username'],
      layers: ['yellow'],
      operations: ['fill'],
      durationSeconds: 30,
      maxSubmissions: 1,
    });

    // Fill ONLY username
    const result = await session.fill(policy, grant, 'autofill-login', vault, 'login-1', 'login', ['username']);
    expect(result).toBe('filled');
    expect(session.state).toBe('filled');

    // Selected field is filled, unselected password is untouched
    const userVal = await session.page.inputValue('#username');
    const passVal = await session.page.inputValue('#password');
    expect(userVal).toBe('tomsmith');
    expect(passVal).toBe('');

    // Page was not submitted
    expect(session.page.url()).toBe(origin + '/login');
  } finally {
    await session.close();
  }
  expect(policy.state('autofill-login')).toBe('completed');
});

test('missing authority, empty selections, and unapproved credentials never read the vault', async () => {
  const cases: { selected: ('username' | 'password')[]; validGrant: boolean }[] = [
    { selected: [], validGrant: true },
    { selected: ['password'], validGrant: true },
    { selected: ['username'], validGrant: false },
  ];
  for (const scenario of cases) {
    const policy = new PolicyBroker({ 'autofill:username': 'yellow', 'autofill:password': 'red' }, () => {});
    const vault = new InMemoryVault();
    const session = await AutofillSession.open(browser, origin + '/login', 'login', {
      prepare: async page => { await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: loginFormHtml })); },
    });
    try {
      const grant = scenario.validGrant ? policy.approve({
        task: 'vault-untouched', origin, credentials: ['autofill:username'], layers: ['yellow'],
        operations: ['fill'], durationSeconds: 30, maxSubmissions: 0,
      }) : 'not-a-grant';
      expect(await session.fill(policy, grant, 'vault-untouched', vault, 'rec-1', 'login', scenario.selected)).toBe('failed');
      expect(vault.readCount).toBe(0);
      expect(session.page.isClosed()).toBe(true);
    } finally { await session.close(); }
  }
});

test('origin mismatch, credentials in URL, and non-HTTPS schemes are rejected', async () => {
  // HTTP scheme rejected
  await expect(AutofillSession.open(browser, 'http://insecure.test/login', 'login')).rejects.toThrow('INVALID_URL');

  // URL with credentials rejected
  await expect(AutofillSession.open(browser, 'https://user:pass@secure.test/login', 'login')).rejects.toThrow('INVALID_URL');

  // URL with fragment/hash rejected
  await expect(AutofillSession.open(browser, 'https://secure.test/login#section', 'login')).rejects.toThrow('INVALID_URL');

  // Origin mismatch between session and policy grant
  const policy = new PolicyBroker({
    'autofill:username': 'yellow',
  }, () => {});
  const foreignOrigin = 'https://other-site.auto-mate.test';
  const grant = policy.approve({
    task: 'origin-mismatch',
    origin: foreignOrigin,
    credentials: ['autofill:username'],
    layers: ['yellow'],
    operations: ['fill'],
    durationSeconds: 30,
    maxSubmissions: 1,
  });

  const vault = new InMemoryVault();
  const session = await AutofillSession.open(browser, origin + '/login', 'login', {
    prepare: async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: loginFormHtml }));
    },
  });

  try {
    const result = await session.fill(policy, grant, 'origin-mismatch', vault, 'rec-1', 'login', ['username']);
    expect(result).toBe('failed');
    expect(vault.readCount).toBe(0);
    expect(session.page.isClosed()).toBe(true);
  } finally {
    await session.close();
  }
});

test('replaced DOM evidence prevents secret disclosure', async () => {
  const policy = new PolicyBroker({
    'autofill:username': 'yellow',
    'autofill:password': 'red',
  }, () => {});

  const vault = new InMemoryVault();
  vault.setRecord(origin, 'login-rep', {
    version: 1,
    kind: 'login',
    username: 'tomsmith',
    password: 'SuperSecretPassword!',
  });

  const grant = policy.approve({
    task: 'replaced-dom',
    origin,
    credentials: ['autofill:username'],
    layers: ['yellow'],
    operations: ['fill'],
    durationSeconds: 30,
    maxSubmissions: 1,
  });

  const session = await AutofillSession.open(browser, origin + '/login', 'login', {
    prepare: async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: loginFormHtml }));
    },
  });

  try {
    // Replace username field in DOM before fill
    await session.page.evaluate(() => {
      const original = document.querySelector('#username')!;
      original.replaceWith(original.cloneNode(true));
    });

    const result = await session.fill(policy, grant, 'replaced-dom', vault, 'login-rep', 'login', ['username']);
    expect(result).toBe('failed');
    expect(session.state).toBe('failed');
    expect(vault.readCount).toBe(0);
    expect(session.page.isClosed()).toBe(true);
  } finally {
    await session.close();
  }
});

test('duplicate or ambiguous semantic candidates fail closed or are omitted', async () => {
  // Form with two password fields (duplicate semantic candidates)
  const duplicatePasswordForm = `<!doctype html>
  <html>
  <body style="margin:64px">
    <form>
      <label id="u-lbl" for="u">Username</label>
      <input id="u" type="text">
      <label id="p1-lbl" for="p1">Password</label>
      <input id="p1" type="password">
      <label id="p2-lbl" for="p2">Password</label>
      <input id="p2" type="password">
    </form>
  </body>
  </html>`;

  const session = await AutofillSession.open(browser, origin + '/duplicate', 'login', {
    prepare: async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: duplicatePasswordForm }));
    },
  });

  try {
    // Only username is discovered; ambiguous duplicate password is omitted
    expect(session.fields.map(c => c.field)).toEqual(['username']);
  } finally {
    await session.close();
  }

  // Unsupported form with only iframes fails closed
  const iframeOnlyForm = `<!doctype html><html><body><iframe src="/inner"></iframe></body></html>`;
  await expect(AutofillSession.open(browser, origin + '/iframe-only', 'login', {
    prepare: async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: iframeOnlyForm }));
    },
  })).rejects.toThrow('UNSUPPORTED_FORM');
});

test('card month and year selects fill matching options and CVV is never recognized', async () => {
  const policy = new PolicyBroker({
    'autofill:cardholder': 'red',
    'autofill:cardNumber': 'red',
    'autofill:expiryMonth': 'red',
    'autofill:expiryYear': 'red',
  }, () => {});

  const vault = new InMemoryVault();
  const cardRecord: CardRecord = {
    version: 1,
    kind: 'card',
    cardholder: 'Ada Lovelace',
    cardNumber: '4242424242424242',
    expiryMonth: '05',
    expiryYear: '2026',
  };
  vault.setRecord(origin, 'card-1', cardRecord);

  const session = await AutofillSession.open(browser, origin + '/card', 'card', {
    prepare: async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: cardFormHtml }));
    },
  });

  try {
    const discovered = session.fields.map(c => c.field).sort();
    expect(discovered).toEqual(['cardNumber', 'cardholder', 'expiryMonth', 'expiryYear']);

    // Ensure CVV is NEVER among discovered candidates
    expect(discovered.includes('expiry')).toBe(false);
    expect(session.fields.some(c => c.verified.request.id.toLowerCase().includes('cvv'))).toBe(false);

    const grant = policy.approve({
      task: 'autofill-card',
      origin,
      credentials: ['autofill:cardholder', 'autofill:cardNumber', 'autofill:expiryMonth', 'autofill:expiryYear'],
      layers: ['red'],
      operations: ['fill'],
      durationSeconds: 30,
      maxSubmissions: 1,
    });

    const result = await session.fill(policy, grant, 'autofill-card', vault, 'card-1', 'card', [
      'cardholder', 'cardNumber', 'expiryMonth', 'expiryYear',
    ]);
    expect(result).toBe('filled');

    // Check filled values
    expect(await session.page.inputValue('#cc-name')).toBe('Ada Lovelace');
    expect(await session.page.inputValue('#cc-number')).toBe('4242424242424242');
    expect(await session.page.inputValue('#cc-exp-month')).toBe('5');
    expect(await session.page.inputValue('#cc-exp-year')).toBe('2026');

    // CVV input remains completely untouched
    expect(await session.page.inputValue('#cc-csc')).toBe('');
  } finally {
    await session.close();
  }
});

test('Stop during pending native read closes context before reply and prevents late fill', async () => {
  const policy = new PolicyBroker({
    'autofill:username': 'yellow',
  }, () => {});

  const vault = new InMemoryVault();
  const { promise: readStarted, resolve: markReadStarted } = Promise.withResolvers<void>();
  const { promise: readGate, resolve: releaseReadGate } = Promise.withResolvers<void>();

  vault.pendingRead = {
    promise: readStarted.then(() => readGate),
    resolve: releaseReadGate,
  };

  const origRead = vault.read.bind(vault);
  vault.read = async (...args) => {
    markReadStarted();
    return origRead(...args);
  };

  vault.setRecord(origin, 'login-pause', {
    version: 1,
    kind: 'login',
    username: 'paused-user',
    password: 'secret-password',
  });

  const session = await AutofillSession.open(browser, origin + '/login', 'login', {
    prepare: async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: loginFormHtml }));
    },
  });

  const grant = policy.approve({
    task: 'stop-pending-read',
    origin,
    credentials: ['autofill:username'],
    layers: ['yellow'],
    operations: ['fill'],
    durationSeconds: 30,
    maxSubmissions: 1,
  });

  const fillPromise = session.fill(policy, grant, 'stop-pending-read', vault, 'login-pause', 'login', ['username']);

  // Wait until vault.read has been called and is paused
  await readStarted;

  // Revoke grant while native read is paused
  policy.revoke(grant);

  // Await context closure before unpausing native read
  await session.closed;
  expect(session.state).toBe('stopped');

  // Release the paused native read
  releaseReadGate();

  const fillResult = await fillPromise;
  expect(fillResult).toBe('stopped');
  expect(session.state).toBe('stopped');
});

test('real scheduled expiry closes filled context and cannot later finish completed', async () => {
  const policy = new PolicyBroker({
    'autofill:username': 'yellow',
  }, () => {});

  const vault = new InMemoryVault();
  vault.setRecord(origin, 'login-exp', {
    version: 1,
    kind: 'login',
    username: 'expiry-user',
    password: 'secret-password',
  });

  const session = await AutofillSession.open(browser, origin + '/login', 'login', {
    prepare: async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: loginFormHtml }));
    },
  });

  const grant = policy.approve({
    task: 'expiry-closes-context',
    origin,
    credentials: ['autofill:username'],
    layers: ['yellow'],
    operations: ['fill'],
    durationSeconds: 1, // 1 second scheduled expiry
    maxSubmissions: 1,
  });

  const result = await session.fill(policy, grant, 'expiry-closes-context', vault, 'login-exp', 'login', ['username']);
  expect(result).toBe('filled');
  expect(session.state).toBe('filled');

  // Wait for context to close due to grant expiry
  await session.closed;

  expect(session.state).toBe('stopped');
  expect(policy.state('expiry-closes-context')).toBe('stopped');

  // Close call on expired/stopped session cannot finish completed
  await session.close();
  expect(policy.state('expiry-closes-context')).toBe('stopped');
});

test('inspection signal cancellation closes pending navigation before page goto', async () => {
  const controller = new AbortController();
  controller.abort();

  await expect(AutofillSession.open(browser, origin + '/login', 'login', {
    signal: controller.signal,
  })).rejects.toThrow('TASK_STOPPED');
});

test('inspection signal cancellation aborts during pending prepare without waiting for prepare resolution', async () => {
  const controller = new AbortController();
  const previousContexts = browser.contexts();
  const { promise: prepareStarted, resolve: markPrepareStarted } = Promise.withResolvers<void>();
  const { promise: prepareGate, resolve: releasePrepareGate } = Promise.withResolvers<void>();

  const openPromise = AutofillSession.open(browser, origin + '/login', 'login', {
    signal: controller.signal,
    prepare: async page => {
      markPrepareStarted();
      await prepareGate;
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: loginFormHtml }));
    },
  });

  try {
    await prepareStarted;
    controller.abort();
    await expect(openPromise).rejects.toThrow('TASK_STOPPED');
    expect(browser.contexts()).toEqual(previousContexts);
  } finally {
    releasePrepareGate();
    await openPromise.catch(() => {});
  }
});

test('select elements cannot be mapped to cardholder, cardNumber, or combined expiry fields', async () => {
  const invalidSelectForm = `<!doctype html>
  <html>
  <body style="margin:64px">
    <form>
      <label for="cname">Name on card</label>
      <select id="cname" name="cc-name"><option value="Ada">Ada</option></select>
      <label for="cnum">Credit card number</label>
      <select id="cnum" name="cc-number"><option value="4242">4242</option></select>
      <label for="cexp">Expires</label>
      <select id="cexp" name="cc-exp"><option value="05/26">05/26</option></select>
    </form>
  </body>
  </html>`;

  await expect(AutofillSession.open(browser, origin + '/invalid-select', 'card', {
    prepare: async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: invalidSelectForm }));
    },
  })).rejects.toThrow('UNSUPPORTED_FORM');
}, 20000);

test('revocation dispatched by the final input event cannot be reported as successful filling', async () => {
  const policy = new PolicyBroker({ 'autofill:username': 'yellow' }, () => {});
  const vault = new InMemoryVault();
  vault.setRecord(origin, 'public', { version: 1, kind: 'login', username: 'test-user', password: 'test-password' });
  const session = await AutofillSession.open(browser, origin + '/login', 'login', {
    prepare: async page => { await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: loginFormHtml })); },
  });
  try {
    const grant = policy.approve({ task: 'last-fill-cancel', origin, credentials: ['autofill:username'],
      layers: ['yellow'], operations: ['fill'], durationSeconds: 30, maxSubmissions: 0 });
    session.page.on('console', message => {
      if (message.text() === 'test-revoke-final-fill') policy.revoke(grant);
    });
    await session.page.evaluate(() => {
      document.querySelector('#username')!.addEventListener('input', () => console.log('test-revoke-final-fill'));
    });
    expect(await session.fill(policy, grant, 'last-fill-cancel', vault, 'public', 'login', ['username'])).toBe('stopped');
    await session.closed;
    expect(session.state).toBe('stopped');
    expect(session.page.isClosed()).toBe(true);
  } finally { await session.close(); }
});

test('failed browser teardown is bounded and cannot falsely acknowledge a closed protected page', async () => {
  const session = await AutofillSession.open(browser, origin + '/login', 'login', {
    prepare: async page => { await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: loginFormHtml })); },
  });
  const context = session.page.context();
  const actualClose = context.close.bind(context);
  try {
    context.close = async () => { throw new Error('sensitive-browser-diagnostic'); };
    await expect(session.close()).rejects.toThrow(/^BROWSER_CLOSE_FAILED$/);
    expect(session.page.isClosed()).toBe(false);
    expect(session.state).toBe('failed');
  } finally {
    context.close = actualClose;
    await session.close();
  }
  expect(session.page.isClosed()).toBe(true);
});

test.each([
  ['login', '<label for="otp">One-time password</label><input id="otp" type="password" autocomplete="one-time-code">'],
  ['card', '<label for="account">Bank account number</label><input id="account" name="account-number">'],
] as const)('%s challenge fields cannot be mapped to saved login or card credentials', async (kind, html) => {
  await expect(AutofillSession.open(browser, origin + '/challenge', kind, {
    prepare: async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<body style="margin:64px">' + html }));
    },
  })).rejects.toThrow('UNSUPPORTED_FORM');
}, 20000);
