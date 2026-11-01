import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { InformationSession } from '../src/information-session';
import { PolicyBroker } from '../src/policy';

const origin = 'https://info-test.auto-mate.test';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

const registrationFormHtml = `<!doctype html>
<html>
<body style="margin:64px;font:18px sans-serif">
  <form id="signup-form" method="post" action="/register">
    <div style="margin-bottom:16px">
      <label id="fullname-label" for="fullname">Full Name</label>
      <input id="fullname" type="text" name="fullname" required style="display:block;width:300px;height:40px">
    </div>
    <div style="margin-bottom:16px">
      <label id="username-label" for="username">Choose Username</label>
      <input id="username" type="text" name="username" autocomplete="username" style="display:block;width:300px;height:40px">
    </div>
    <div style="margin-bottom:16px">
      <label id="bio-label" for="bio">Profile Biography</label>
      <textarea id="bio" name="bio" style="display:block;width:300px;height:80px"></textarea>
    </div>
    <div style="margin-bottom:16px">
      <label id="country-label" for="country">Country</label>
      <select id="country" name="country" style="display:block;width:300px;height:40px">
        <option value="">Select country</option>
        <option value="us">United States</option>
        <option value="ca">Canada</option>
        <option value="uk">United Kingdom</option>
      </select>
    </div>
    <button id="register-btn" type="submit">Create Account</button>
  </form>
</body>
</html>`;

test('discovers full name, username, textarea, and select options with public metadata only', async () => {
  const session = await InformationSession.open(browser, origin + '/signup', {
    prepare: async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: registrationFormHtml }));
    },
  });

  try {
    expect(session.origin).toBe(origin);
    expect(session.url).toBe(origin + '/signup');
    expect(session.state).toBe('review');
    expect(session.error).toBeUndefined();

    // Verify discovered fields
    const metadata = session.fields.map(f => f.metadata);
    expect(metadata.length).toBe(4);

    const nameField = metadata.find(m => m.label === 'Full Name');
    expect(nameField).toBeDefined();
    expect(nameField?.kind).toBe('text');
    expect(nameField?.required).toBe(true);

    const userField = metadata.find(m => m.label === 'Choose Username');
    expect(userField).toBeDefined();
    expect(userField?.kind).toBe('username');
    expect(userField?.required).toBe(false);

    const bioField = metadata.find(m => m.label === 'Profile Biography');
    expect(bioField).toBeDefined();
    expect(bioField?.kind).toBe('text');
    expect(bioField?.required).toBe(false);

    const countryField = metadata.find(m => m.label === 'Country');
    expect(countryField).toBeDefined();
    expect(countryField?.kind).toBe('select');
    expect(countryField?.options).toEqual(['Select country', 'United States', 'Canada', 'United Kingdom']);

    // Opaque stable IDs without private DOM handles in metadata
    for (const f of metadata) {
      expect(typeof f.id).toBe('string');
      expect(f.id.length).toBeGreaterThan(0);
    }

    // Capture baseline frame with masked preview
    const frame = await session.capture();
    expect(frame.annotations.length).toBe(4);
    expect(frame.width).toBe(1280);
    expect(frame.height).toBe(1000);
    expect(typeof frame.image).toBe('string');
  } finally {
    await session.close();
  }
});

test('fills full name, new username, textarea, and select options without submitting form', async () => {
  const policy = new PolicyBroker({
    'information:value': 'red',
  }, () => {});

  const session = await InformationSession.open(browser, origin + '/signup', {
    prepare: async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: registrationFormHtml }));
    },
  });

  try {
    const nameField = session.fields.find(f => f.metadata.label === 'Full Name')!;
    const userField = session.fields.find(f => f.metadata.label === 'Choose Username')!;
    const bioField = session.fields.find(f => f.metadata.label === 'Profile Biography')!;
    const countryField = session.fields.find(f => f.metadata.label === 'Country')!;

    const selectedIds = [nameField.metadata.id, userField.metadata.id, bioField.metadata.id, countryField.metadata.id];

    const grantHandle = policy.approve({
      task: 'info-fill-task',
      origin,
      credentials: ['information:value'],
      layers: ['red'],
      operations: ['fill'],
      durationSeconds: 60,
      maxSubmissions: 0,
    });

    const valuesByFieldId: Record<string, string> = {
      [nameField.metadata.id]: 'Ada Lovelace',
      [userField.metadata.id]: 'adalovelace',
      [bioField.metadata.id]: 'First computer programmer.\nWriting algorithms for the Analytical Engine.',
      [countryField.metadata.id]: 'United Kingdom',
    };

    await session.fill(policy, 'info-fill-task', grantHandle, selectedIds, async fieldId => {
      return valuesByFieldId[fieldId] ?? '';
    });

    expect(session.state).toBe('filled');
    expect(session.error).toBeUndefined();

    // Verify DOM inputs
    expect(await session.page.inputValue('#fullname')).toBe('Ada Lovelace');
    expect(await session.page.inputValue('#username')).toBe('adalovelace');
    expect(await session.page.inputValue('#bio')).toBe(
      'First computer programmer.\nWriting algorithms for the Analytical Engine.',
    );
    // Select matched by option label 'United Kingdom' resolved to option value 'uk'
    expect(await session.page.inputValue('#country')).toBe('uk');

    // Form was NOT submitted
    expect(session.page.url()).toBe(origin + '/signup');
  } finally {
    await session.close();
  }
});

test('resolves host callback only for selected fields, leaving unselected untouched', async () => {
  const policy = new PolicyBroker({
    'information:value': 'red',
  }, () => {});

  const session = await InformationSession.open(browser, origin + '/signup', {
    prepare: async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: registrationFormHtml }));
    },
  });

  try {
    const nameField = session.fields.find(f => f.metadata.label === 'Full Name')!;
    const bioField = session.fields.find(f => f.metadata.label === 'Profile Biography')!;
    const unselectedUserField = session.fields.find(f => f.metadata.label === 'Choose Username')!;

    const selectedIds = [nameField.metadata.id, bioField.metadata.id];
    const requestedFieldIds: string[] = [];

    const grantHandle = policy.approve({
      task: 'partial-fill-task',
      origin,
      credentials: ['information:value'],
      layers: ['red'],
      operations: ['fill'],
      durationSeconds: 60,
      maxSubmissions: 0,
    });

    await session.fill(policy, 'partial-fill-task', grantHandle, selectedIds, async fieldId => {
      requestedFieldIds.push(fieldId);
      if (fieldId === nameField.metadata.id) return 'Grace Hopper';
      if (fieldId === bioField.metadata.id) return 'Pioneer of computer programming';
      return '';
    });

    expect(session.state).toBe('filled');
    // Only selected field IDs were requested from the host callback
    expect(requestedFieldIds).toEqual([nameField.metadata.id, bioField.metadata.id]);
    expect(requestedFieldIds.includes(unselectedUserField.metadata.id)).toBe(false);

    // Selected fields filled
    expect(await session.page.inputValue('#fullname')).toBe('Grace Hopper');
    expect(await session.page.inputValue('#bio')).toBe('Pioneer of computer programming');

    // Unselected fields remain unmolested
    expect(await session.page.inputValue('#username')).toBe('');
    expect(await session.page.inputValue('#country')).toBe('');
  } finally {
    await session.close();
  }
});

test('refuses and omits CVV, PIN, OTP, TOTP, CAPTCHA, and card number challenges', async () => {
  const challengeFormHtml = `<!doctype html>
<html>
<body style="margin:64px;font:18px sans-serif">
  <form id="challenge-form" method="post" action="/verify">
    <div style="margin-bottom:16px">
      <label id="name-label" for="name">Legal Name</label>
      <input id="name" type="text" name="name" style="display:block;width:300px;height:40px">
    </div>
    <div style="margin-bottom:16px">
      <label id="cvv-label" for="cvv">CVV</label>
      <input id="cvv" type="text" name="cvv" autocomplete="cc-csc" style="display:block;width:300px;height:40px">
    </div>
    <div style="margin-bottom:16px">
      <label id="otp-label" for="otp">One-Time Password (OTP)</label>
      <input id="otp" type="text" name="otp" style="display:block;width:300px;height:40px">
    </div>
    <div style="margin-bottom:16px">
      <label id="pin-label" for="pin">ATM PIN</label>
      <input id="pin" type="password" name="pin" style="display:block;width:300px;height:40px">
    </div>
    <div style="margin-bottom:16px">
      <label id="captcha-label" for="captcha">Enter Captcha</label>
      <input id="captcha" type="text" name="captcha" style="display:block;width:300px;height:40px">
    </div>
    <div style="margin-bottom:16px">
      <label id="cc-label" for="cc-number">Credit Card Number</label>
      <input id="cc-number" type="text" name="card_number" style="display:block;width:300px;height:40px">
    </div>
    <button id="verify-btn" type="submit">Submit</button>
  </form>
</body>
</html>`;

  const session = await InformationSession.open(browser, origin + '/challenge', {
    prepare: async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: challengeFormHtml }));
    },
  });

  try {
    // Only the safe Legal Name field is discovered; all security challenges are omitted
    expect(session.fields.length).toBe(1);
    expect(session.fields[0]?.metadata.label).toBe('Legal Name');
    expect(session.fields[0]?.metadata.kind).toBe('text');
  } finally {
    await session.close();
  }
});

test('DOM replacement or label change before/during value resolution produces no fill', async () => {
  const policy = new PolicyBroker({
    'information:value': 'red',
  }, () => {});

  const session = await InformationSession.open(browser, origin + '/tamper', {
    prepare: async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: registrationFormHtml }));
    },
  });

  try {
    const nameField = session.fields.find(f => f.metadata.label === 'Full Name')!;
    const grantHandle = policy.approve({
      task: 'tamper-task',
      origin,
      credentials: ['information:value'],
      layers: ['red'],
      operations: ['fill'],
      durationSeconds: 60,
      maxSubmissions: 0,
    });

    // Tamper with the label text DURING host value resolution
    await session.fill(policy, 'tamper-task', grantHandle, [nameField.metadata.id], async () => {
      await session.page.evaluate(() => {
        const label = document.getElementById('fullname-label');
        if (label) label.textContent = 'Changed Malicious Label';
      });
      return 'Attacker Name';
    });

    // Fill fails closed; session transitions to failed state and closes
    expect(session.state).toBe('failed');

    // Input was NOT filled
    const value = await session.page.inputValue('#fullname').catch(() => '');
    expect(value).not.toBe('Attacker Name');
  } finally {
    await session.close();
  }
});

test('stopped or revoked authority during value resolution produces no fill', async () => {
  const policy = new PolicyBroker({
    'information:value': 'red',
  }, () => {});

  const session = await InformationSession.open(browser, origin + '/revoke', {
    prepare: async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: registrationFormHtml }));
    },
  });

  try {
    const nameField = session.fields.find(f => f.metadata.label === 'Full Name')!;
    const grantHandle = policy.approve({
      task: 'revoke-task',
      origin,
      credentials: ['information:value'],
      layers: ['red'],
      operations: ['fill'],
      durationSeconds: 60,
      maxSubmissions: 0,
    });

    // Revoke authority DURING host value resolution
    await session.fill(policy, 'revoke-task', grantHandle, [nameField.metadata.id], async () => {
      policy.stopAll();
      return 'Should Never Fill';
    });

    // State becomes stopped; context closed
    expect(session.state).toBe('stopped');
    expect(session.error).toBe('TASK_STOPPED');

    // Input was NOT filled
    const value = await session.page.inputValue('#fullname').catch(() => '');
    expect(value).not.toBe('Should Never Fill');
  } finally {
    await session.close();
  }
});

test('setup cancellation closes context during pending prepare', async () => {
  const controller = new AbortController();

  let prepareStarted = false;
  const sessionPromise = InformationSession.open(browser, origin + '/cancel', {
    signal: controller.signal,
    prepare: async () => {
      prepareStarted = true;
      await delay(2000);
    },
  });

  while (!prepareStarted) {
    await delay(10);
  }

  // Cancel while prepare is actively in progress
  controller.abort();

  let failedError: Error | undefined;
  try {
    await sessionPromise;
  } catch (err) {
    failedError = err as Error;
  }

  expect(failedError).toBeDefined();
  expect(failedError?.message).toBe('TASK_STOPPED');
});

test('ambiguous or invalid select option match fails closed without fill', async () => {
  const policy = new PolicyBroker({
    'information:value': 'red',
  }, () => {});

  const session = await InformationSession.open(browser, origin + '/badselect', {
    prepare: async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: registrationFormHtml }));
    },
  });

  try {
    const countryField = session.fields.find(f => f.metadata.label === 'Country')!;
    const grantHandle = policy.approve({
      task: 'bad-select-task',
      origin,
      credentials: ['information:value'],
      layers: ['red'],
      operations: ['fill'],
      durationSeconds: 60,
      maxSubmissions: 0,
    });

    // Attempt to supply an invalid / non-existent option
    await session.fill(policy, 'bad-select-task', grantHandle, [countryField.metadata.id], async () => {
      return 'Atlantis';
    });

    expect(session.state).toBe('failed');
    expect(session.error).toBe('UNSUPPORTED_SELECT');

    const value = await session.page.inputValue('#country').catch(() => '');
    expect(value).toBe('');
  } finally {
    await session.close();
  }
});
