import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser } from 'playwright';
import { WebsiteActions } from '../src/website-actions';
import { InformationSession } from '../src/information-session';
import { AutofillSession } from '../src/autofill';
import { PolicyBroker } from '../src/policy';

const origin = 'https://action-test.auto-mate.test';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

test('discovers supported visible buttons and performs an explicit click', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();

  let clicked = false;
  await page.exposeFunction('onButtonClicked', () => {
    clicked = true;
  });

  const html = `<!doctype html>
  <html>
  <body style="margin:40px;font:16px sans-serif">
    <button id="main-btn" type="button" onclick="window.onButtonClicked()">Confirm Transfer</button>
    <input id="sub-input" type="submit" value="Submit Form">
    <input id="rst-input" type="reset" value="Reset Fields">
  </body>
  </html>`;

  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(origin + '/page');

  try {
    const actions = await WebsiteActions.discover(page, origin);
    expect(actions.actions.length).toBe(3);

    const confirmAction = actions.actions.find(a => a.label === 'Confirm Transfer');
    expect(confirmAction).toBeDefined();
    expect(confirmAction?.kind).toBe('button');

    const submitAction = actions.actions.find(a => a.label === 'Submit Form');
    expect(submitAction).toBeDefined();
    expect(submitAction?.kind).toBe('submit');

    const resetAction = actions.actions.find(a => a.label === 'Reset Fields');
    expect(resetAction).toBeDefined();
    expect(resetAction?.kind).toBe('reset');

    // Verify confirmAction
    await actions.verify(confirmAction!.id);

    // Click confirmAction
    await actions.click(confirmAction!.id, new AbortController().signal, () => {});
    expect(clicked).toBe(true);
  } finally {
    await context.close();
  }
});

test('rejects stale label when DOM label mutates after discovery', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();

  const html = `<!doctype html>
  <html>
  <body style="margin:40px">
    <button id="target" type="button">Initial Label</button>
  </body>
  </html>`;

  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(origin + '/stale-label');

  try {
    const actions = await WebsiteActions.discover(page, origin);
    const action = actions.actions[0]!;

    // Mutate label in DOM
    await page.evaluate(() => {
      document.getElementById('target')!.textContent = 'Mutated Label';
    });

    let verifyError: Error | undefined;
    try {
      await actions.verify(action.id);
    } catch (err) {
      verifyError = err as Error;
    }
    expect(verifyError?.message).toBe('VERIFICATION_FAILED');

    let clickError: Error | undefined;
    try {
      await actions.click(action.id, new AbortController().signal, () => {});
    } catch (err) {
      clickError = err as Error;
    }
    expect(clickError?.message).toBe('VERIFICATION_FAILED');
  } finally {
    await context.close();
  }
});

test('rejects stale node when button is removed or replaced in DOM', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();

  const html = `<!doctype html>
  <html>
  <body style="margin:40px">
    <button id="target" type="button">Same Label</button>
  </body>
  </html>`;

  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(origin + '/stale-node');

  try {
    const actions = await WebsiteActions.discover(page, origin);
    const action = actions.actions[0]!;

    // Replace the DOM node with a new element sharing the same attributes
    await page.evaluate(() => {
      const oldBtn = document.getElementById('target')!;
      const newBtn = document.createElement('button');
      newBtn.id = 'target';
      newBtn.type = 'button';
      newBtn.textContent = 'Same Label';
      oldBtn.replaceWith(newBtn);
    });

    let verifyError: Error | undefined;
    try {
      await actions.verify(action.id);
    } catch (err) {
      verifyError = err as Error;
    }
    expect(verifyError?.message).toBe('VERIFICATION_FAILED');

    let clickError: Error | undefined;
    try {
      await actions.click(action.id, new AbortController().signal, () => {});
    } catch (err) {
      clickError = err as Error;
    }
    expect(clickError?.message).toBe('VERIFICATION_FAILED');
  } finally {
    await context.close();
  }
});

test('rejects disabled button and fieldset disabled button', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();

  const html = `<!doctype html>
  <html>
  <body style="margin:40px">
    <button id="dyn-disabled" type="button">Disable Me</button>
    <fieldset disabled>
      <button id="static-disabled" type="button">Inside Fieldset</button>
    </fieldset>
  </body>
  </html>`;

  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(origin + '/disabled-test');

  try {
    const actions = await WebsiteActions.discover(page, origin);
    // Button in disabled fieldset should not be discovered
    expect(actions.actions.find(a => a.label === 'Inside Fieldset')).toBeUndefined();

    const action = actions.actions.find(a => a.label === 'Disable Me')!;
    expect(action).toBeDefined();

    // Disable in DOM
    await page.evaluate(() => {
      (document.getElementById('dyn-disabled') as HTMLButtonElement).disabled = true;
    });

    let verifyError: Error | undefined;
    try {
      await actions.verify(action.id);
    } catch (err) {
      verifyError = err as Error;
    }
    expect(verifyError?.message).toBe('VERIFICATION_FAILED');

    let clickError: Error | undefined;
    try {
      await actions.click(action.id, new AbortController().signal, () => {});
    } catch (err) {
      clickError = err as Error;
    }
    expect(clickError?.message).toBe('VERIFICATION_FAILED');
  } finally {
    await context.close();
  }
});

test('rejects cross-origin calls and off-origin page navigation', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();

  const html = `<!doctype html>
  <html>
  <body style="margin:40px">
    <button id="btn" type="button">Click Me</button>
  </body>
  </html>`;

  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(origin + '/origin-check');

  try {
    // Attempting discover with mismatched origin throws ORIGIN_MISMATCH
    let mismatchError: Error | undefined;
    try {
      await WebsiteActions.discover(page, 'https://different-origin.test');
    } catch (err) {
      mismatchError = err as Error;
    }
    expect(mismatchError?.message).toBe('ORIGIN_MISMATCH');

    const actions = await WebsiteActions.discover(page, origin);
    const action = actions.actions[0]!;

    // Navigate page off-origin
    await page.goto('https://different-origin.test/other');

    let verifyError: Error | undefined;
    try {
      await actions.verify(action.id);
    } catch (err) {
      verifyError = err as Error;
    }
    expect(verifyError?.message).toBe('ORIGIN_MISMATCH');

    let clickError: Error | undefined;
    try {
      await actions.click(action.id, new AbortController().signal, () => {});
    } catch (err) {
      clickError = err as Error;
    }
    expect(clickError?.message).toBe('ORIGIN_MISMATCH');
  } finally {
    await context.close();
  }
});

test('rejects click when aborted before click or assertActive fails', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();

  let clicked = false;
  await page.exposeFunction('clickedHandler', () => {
    clicked = true;
  });

  const html = `<!doctype html>
  <html>
  <body style="margin:40px">
    <button id="btn" type="button" onclick="window.clickedHandler()">Safe Action</button>
  </body>
  </html>`;

  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(origin + '/stopped-test');

  try {
    const actions = await WebsiteActions.discover(page, origin);
    const action = actions.actions[0]!;

    // 1. Signal already aborted
    const controller = new AbortController();
    controller.abort();

    let stopError: Error | undefined;
    try {
      await actions.click(action.id, controller.signal, () => {});
    } catch (err) {
      stopError = err as Error;
    }
    expect(stopError?.message).toBe('TASK_STOPPED');
    expect(clicked).toBe(false);

    // 2. assertActive throws
    let guardError: Error | undefined;
    try {
      await actions.click(action.id, new AbortController().signal, () => {
        throw new Error('GUARD_INACTIVE');
      });
    } catch (err) {
      guardError = err as Error;
    }
    expect(guardError?.message).toBe('GUARD_INACTIVE');
    expect(clicked).toBe(false);
  } finally {
    await context.close();
  }
});

test('rejects ambiguous, unlabelled, iframe, download, and file controls', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();

  const html = `<!doctype html>
  <html>
  <body style="margin:40px">
    <!-- Ambiguous duplicates: both should be omitted -->
    <button id="dup1" type="button">Duplicate</button>
    <button id="dup2" type="button">Duplicate</button>

    <!-- Unlabelled: omitted -->
    <button id="empty" type="button"></button>
    <button id="whitespace" type="button">   </button>

    <!-- Download: omitted -->
    <button id="dl" type="button" download>Download File</button>
    <form download>
      <button id="form-dl" type="button">Form Download</button>
    </form>

    <!-- File control: omitted -->
    <input id="file" type="file">

    <!-- Unique valid button: included -->
    <button id="valid" type="button">Unique Valid Action</button>

    <!-- Frame: omitted -->
    <iframe srcdoc="<button id='iframe-btn'>Iframe Button</button>"></iframe>
  </body>
  </html>`;

  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(origin + '/rejections');

  try {
    const actions = await WebsiteActions.discover(page, origin);
    expect(actions.actions.length).toBe(1);
    expect(actions.actions[0]!.label).toBe('Unique Valid Action');
  } finally {
    await context.close();
  }
});

test('InformationSession open allowEmptyFields support', async () => {
  const emptyPageHtml = `<!doctype html>
  <html>
  <body style="margin:40px">
    <h1>Welcome without Forms</h1>
    <button id="continue-btn" type="button">Continue</button>
  </body>
  </html>`;

  // Default allowEmptyFields = false throws UNSUPPORTED_FORM
  let openError: Error | undefined;
  try {
    await InformationSession.open(browser, origin + '/no-forms-default', {
      prepare: async page => {
        await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: emptyPageHtml }));
      },
    });
  } catch (err) {
    openError = err as Error;
  }
  expect(openError?.message).toBe('UNSUPPORTED_FORM');

  // allowEmptyFields = true succeeds with empty fields array and review state
  const session = await InformationSession.open(browser, origin + '/no-forms-allowed', {
    allowEmptyFields: true,
    prepare: async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: emptyPageHtml }));
    },
  });

  try {
    expect(session.state).toBe('review');
    expect(session.fields.length).toBe(0);

    // Can discover buttons on this page
    const actions = await WebsiteActions.discover(session.page, origin);
    expect(actions.actions.length).toBe(1);
    expect(actions.actions[0]!.label).toBe('Continue');
  } finally {
    await session.close();
  }
});

test('InformationSession releaseForOwnerAction and refreshAfterOwnerAction with no reuse of old field evidence', async () => {
  const page1Html = `<!doctype html>
  <html>
  <body style="margin:40px">
    <form id="f1" method="post" action="/result">
      <label for="step1-field">Step 1 Field</label>
      <input id="step1-field" name="step1" required>
      <button id="next-btn" type="submit">Submit Step</button>
    </form>
  </body>
  </html>`;

  const page2Html = `<!doctype html>
  <html>
  <body style="margin:40px">
    <form id="f2" method="post" action="/finish">
      <label for="step2-field">Step 2 Field</label>
      <input id="step2-field" name="step2" required>
      <button id="done-btn" type="submit">Finalize</button>
    </form>
  </body>
  </html>`;

  let currentPage = 1;
  const session = await InformationSession.open(browser, origin + '/multi-step', {
    prepare: async page => {
      await page.route('**/*', route => {
        const body = currentPage === 1 ? page1Html : page2Html;
        route.fulfill({ contentType: 'text/html', body });
      });
    },
  });

  const policy = new PolicyBroker({ 'information:value': 'red' }, () => {});

  try {
    expect(session.fields.length).toBe(1);
    expect(session.fields[0]!.metadata.label).toBe('Step 1 Field');
    const oldFieldHandle = session.fields[0]!.verified.field;

    const grantHandle = policy.approve({
      task: 'step1-task',
      origin,
      credentials: ['information:value'],
      layers: ['red'],
      operations: ['fill'],
      durationSeconds: 60,
      maxSubmissions: 0,
    });

    await session.fill(policy, 'step1-task', grantHandle, [session.fields[0]!.metadata.id], async () => 'value1');
    expect(session.state).toBe('filled');

    // Release for owner action: detaches abort listener and finishes fill task
    session.releaseForOwnerAction();

    // Verify fill authority is gone and attempting fill after release fails
    await session.fill(policy, 'step1-task', grantHandle, [session.fields[0]!.metadata.id], async () => 'value2');
    expect(session.state).toBe('failed');

    // Simulate navigation to page 2
    currentPage = 2;
    await session.page.goto(origin + '/result', { waitUntil: 'domcontentloaded' });

    // Refresh after owner action
    await session.refreshAfterOwnerAction();

    expect(session.state).toBe('review');
    expect(session.fields.length).toBe(1);
    expect(session.fields[0]!.metadata.label).toBe('Step 2 Field');
    // Verify old field handle is not reused
    expect(session.fields[0]!.verified.field).not.toBe(oldFieldHandle);
  } finally {
    await session.close();
  }
});

test('InformationSession refreshAfterOwnerAction allows empty field list and rejects off-origin navigation', async () => {
  const formHtml = `<!doctype html>
  <html>
  <body style="margin:40px">
    <form method="post">
      <label for="initial">Initial Field</label>
      <input id="initial" required>
    </form>
  </body>
  </html>`;

  const successHtml = `<!doctype html>
  <html>
  <body style="margin:40px">
    <h2>Operation Complete</h2>
    <button id="finish" type="button">Finish</button>
  </body>
  </html>`;

  let current = formHtml;
  const session = await InformationSession.open(browser, origin + '/empty-nav', {
    prepare: async page => {
      await page.route('**/*', route => {
        route.fulfill({ contentType: 'text/html', body: current });
      });
    },
  });

  try {
    expect(session.fields.length).toBe(1);

    // Switch to page with no forms
    current = successHtml;
    await session.page.goto(origin + '/success', { waitUntil: 'domcontentloaded' });

    await session.refreshAfterOwnerAction();
    expect(session.state).toBe('review');
    expect(session.fields.length).toBe(0);

    // Now test off-origin redirect fails closed
    await session.page.goto('https://evil-redirect.test/logout');

    let refreshError: Error | undefined;
    try {
      await session.refreshAfterOwnerAction();
    } catch (err) {
      refreshError = err as Error;
    }
    expect(refreshError?.message).toBe('ORIGIN_MISMATCH');
  } finally {
    await session.close();
  }
});

test('AutofillSession releaseForOwnerAction and refreshAfterOwnerAction', async () => {
  const form1 = `<!doctype html>
  <html>
  <body style="margin:40px">
    <form method="post">
      <label for="usr">Username</label>
      <input id="usr" autocomplete="username">
      <label for="pwd">Password</label>
      <input id="pwd" type="password" autocomplete="current-password">
    </form>
  </body>
  </html>`;

  const form2 = `<!doctype html>
  <html>
  <body style="margin:40px">
    <p>Thank you for logging in.</p>
  </body>
  </html>`;

  let current = form1;
  const session = await AutofillSession.open(browser, origin + '/autofill-refresh', 'login', {
    prepare: async page => {
      await page.route('**/*', route => {
        route.fulfill({ contentType: 'text/html', body: current });
      });
    },
  });

  try {
    expect(session.fields.length).toBe(2);

    // Call releaseForOwnerAction
    session.releaseForOwnerAction();

    // Navigate to page 2 (empty fields)
    current = form2;
    await session.page.goto(origin + '/autofill-done', { waitUntil: 'domcontentloaded' });

    await session.refreshAfterOwnerAction();
    expect(session.state).toBe('review');
    expect(session.fields.length).toBe(0);
  } finally {
    await session.close();
  }
});

test('recognizes identity-transformed icon labels without trusting displaced labels', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('**/*', route => route.fulfill({
    contentType: 'text/html',
    body: `<button type="button" id="login" onclick="document.body.dataset.clicked='yes'"><i style="display:inline-block;transform:translate(0,0)">Login</i></button>
      <button type="button"><i style="display:inline-block;transform:translate(2px,0)">Displaced</i></button>`,
  }));
  await page.goto(origin + '/icon-label');
  try {
    const actions = await WebsiteActions.discover(page, origin);
    expect(actions.actions.map(action => action.label)).toEqual(['Login']);
    await actions.click(actions.actions[0]!.id, new AbortController().signal, () => {});
    expect(await page.getAttribute('body', 'data-clicked')).toBe('yes');
    await page.locator('#login i').evaluate(el => { el.style.transform = 'translate(2px,0)'; });
    await expect(actions.verify(actions.actions[0]!.id)).rejects.toThrow();
  } finally {
    await context.close();
  }
});

test('excludes unsafe form destinations and rechecks a changed submit target', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('**/*', route => route.fulfill({
    contentType: 'text/html',
    body: `<form action="/continue">
      <button id="safe" onclick="document.body.dataset.clicked='yes'">Continue</button>
      <button formtarget="_blank">New window</button>
      <button formaction="https://other.example/submit">Other origin</button>
      <button formaction="https://user:pass@action-test.auto-mate.test/submit">URL credentials</button>
      <button formaction="http://[">Malformed destination</button>
    </form>`,
  }));
  await page.goto(origin + '/destinations');
  try {
    const actions = await WebsiteActions.discover(page, origin);
    expect(actions.actions.map(action => action.label)).toEqual(['Continue']);
    const action = actions.actions[0]!;
    await page.locator('#safe').evaluate(el => { el.setAttribute('formtarget', '_blank'); });
    await expect(actions.click(action.id, new AbortController().signal, () => {})).rejects.toThrow();
    await page.locator('#safe').evaluate(el => {
      el.setAttribute('formtarget', '_self');
      el.setAttribute('formaction', 'https://other.example/submit');
    });
    await expect(actions.click(action.id, new AbortController().signal, () => {})).rejects.toThrow();
    expect(await page.getAttribute('body', 'data-clicked')).toBeNull();
    expect(page.url()).toBe(origin + '/destinations');
    expect(context.pages()).toEqual([page]);
  } finally {
    await context.close();
  }
});

test('aborting a queued real click closes its browser context before returning', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let clicked = false;
  await page.exposeFunction('recordClick', () => { clicked = true; });
  await page.route('**/*', route => route.fulfill({
    contentType: 'text/html',
    body: `<style>@keyframes moving {from{left:10px}to{left:410px}}</style>
      <button type="button" style="position:absolute;top:40px;animation:moving 2s linear infinite alternate" onclick="window.recordClick()">Moving action</button>`,
  }));
  await page.goto(origin + '/queued-click');
  const actions = await WebsiteActions.discover(page, origin);
  expect(actions.actions.map(action => action.label)).toEqual(['Moving action']);
  const controller = new AbortController();
  const queued = Promise.withResolvers<void>();
  let checks = 0;
  const operation = actions.click(actions.actions[0]!.id, controller.signal, () => {
    // Coordinate cancellation after verification, before Playwright can settle the moving button.
    if (++checks === 3) queued.resolve();
  });
  const outcome = operation.then(() => undefined, error => error as unknown);
  try {
    await queued.promise;
    controller.abort();
    expect(await outcome).toBeInstanceOf(Error);
    expect(page.isClosed()).toBe(true);
    expect(context.pages()).toEqual([]);
    expect(clicked).toBe(false);
  } finally {
    await context.close();
  }
});
