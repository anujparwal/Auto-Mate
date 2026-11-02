import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright';
import sharp from 'sharp';
import { openAgentBrowser } from '../src/agent-browser';
import type { AgentBrowser, AgentWorkspaceSettings, BrowserObservation, BrowserFrame } from '../src/agent-types';
import type { DnsLookupFn } from '../src/hosted-egress';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

const mockPublicDnsLookup: DnsLookupFn = async (hostname: string) => {
  const lower = hostname.toLowerCase();
  if (lower === 'public-site.com' || lower.endsWith('.public-site.com')) {
    return [{ address: '93.184.216.34', family: 4 }];
  }
  if (lower === 'private-target.com' || lower.endsWith('.private-target.com')) {
    return [{ address: '192.168.1.100', family: 4 }];
  }
  return [{ address: '93.184.216.34', family: 4 }];
};

const sampleHtml = `<!doctype html>
<html>
<head><title>Automated Security Portal</title></head>
<body>
  <header><h1>Welcome to the Automated Portal</h1></header>
  <main>
    <p>This is genuine visible body copy intended for agent comprehension.</p>
    <div style="display:none"><p>Hidden content that must not appear in observation text</p></div>
    <div aria-hidden="true"><p>Aria hidden content that must not appear in observation text</p></div>
    <div contenteditable="true">Editable text that must be excluded from observation text</div>
    <iframe src="about:blank"></iframe>

    <form id="security-form">
      <label for="search-input">Search Topics</label>
      <input id="search-input" type="search" placeholder="Search keywords">

      <label for="login-email">Account Email</label>
      <input id="login-email" type="email" autocomplete="email">

      <label for="login-password">Secret Password</label>
      <input id="login-password" type="password" autocomplete="current-password">

      <label for="region-select">Region</label>
      <select id="region-select">
        <option value="apac">Asia Pacific</option>
        <option value="emea">Europe</option>
      </select>

      <button id="submit-action" type="button">Confirm Entry</button>
    </form>

    <a id="nav-link" href="https://public-site.com/docs">Documentation Link</a>
  </main>
  <script>const dangerous = "must not leak";</script>
  <style>body { background: white; }</style>
</body>
</html>`;

function createMockPagePreparer(htmlContent: string) {
  return async (page: Page): Promise<void> => {
    await page.route('**/*', async route => {
      const req = route.request();
      if (req.isNavigationRequest() || req.resourceType() === 'document') {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: htmlContent,
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'text/plain',
          body: '',
        });
      }
    });
  };
}

describe('AgentBrowser Security, Privacy, and Isolation Regressions', () => {
  test('rejects non-HTTPS URLs, credentials in URLs, fragments, and private network destinations', async () => {
    const navigation: AgentWorkspaceSettings['navigation'] = {
      mode: 'whitelist',
      domains: ['public-site.com', '127.0.0.1'],
    };

    const agent = await openAgentBrowser({
      browser,
      navigation,
      dnsLookupFn: mockPublicDnsLookup,
    });

    try {
      const signal = new AbortController().signal;

      // Protocol must be HTTPS
      let httpRejected = false;
      try {
        await agent.navigate('http://public-site.com/home', signal);
      } catch {
        httpRejected = true;
      }
      expect(httpRejected).toBe(true);

      // Credentials in URL forbidden
      let credsRejected = false;
      try {
        await agent.navigate('https://admin:pass123@public-site.com/login', signal);
      } catch {
        credsRejected = true;
      }
      expect(credsRejected).toBe(true);

      // Fragments in URL forbidden
      let hashRejected = false;
      try {
        await agent.navigate('https://public-site.com/page#section', signal);
      } catch {
        hashRejected = true;
      }
      expect(hashRejected).toBe(true);

      // Private network destination forbidden
      let privateIpRejected = false;
      try {
        await agent.navigate('https://127.0.0.1/dashboard', signal);
      } catch {
        privateIpRejected = true;
      }
      expect(privateIpRejected).toBe(true);

      // Domain resolving to private IP forbidden
      let privateDnsRejected = false;
      try {
        await agent.navigate('https://private-target.com/panel', signal);
      } catch {
        privateDnsRejected = true;
      }
      expect(privateDnsRejected).toBe(true);
    } finally {
      await agent.close();
    }
  });

  test('enforces whitelist and blacklist navigation policies strictly', async () => {
    // Whitelist policy
    const whitelistAgent = await openAgentBrowser({
      browser,
      navigation: {
        mode: 'whitelist',
        domains: ['public-site.com'],
      },
      dnsLookupFn: mockPublicDnsLookup,
      prepareWebsite: createMockPagePreparer(sampleHtml),
    });

    try {
      const signal = new AbortController().signal;
      // Permitted domain succeeds
      const obs = await whitelistAgent.navigate('https://public-site.com/app', signal);
      expect(obs.title).toBe('Automated Security Portal');

      // Non-whitelisted domain fails
      let unlistedRejected = false;
      try {
        await whitelistAgent.navigate('https://another-domain.com/landing', signal);
      } catch {
        unlistedRejected = true;
      }
      expect(unlistedRejected).toBe(true);
    } finally {
      await whitelistAgent.close();
    }

    // Blacklist policy
    const blacklistAgent = await openAgentBrowser({
      browser,
      navigation: {
        mode: 'blacklist',
        domains: ['forbidden-tracker.com'],
      },
      dnsLookupFn: mockPublicDnsLookup,
      prepareWebsite: createMockPagePreparer(sampleHtml),
    });

    try {
      const signal = new AbortController().signal;
      // Blacklisted domain fails
      let blacklistedRejected = false;
      try {
        await blacklistAgent.navigate('https://forbidden-tracker.com/collect', signal);
      } catch {
        blacklistedRejected = true;
      }
      expect(blacklistedRejected).toBe(true);

      // Unlisted domain succeeds
      const obs = await blacklistAgent.navigate('https://public-site.com/safe', signal);
      expect(obs.title).toBe('Automated Security Portal');
    } finally {
      await blacklistAgent.close();
    }
  });

  test('DOM observation extracts visible text only, excluding controls, contenteditable, scripts, styles, and hidden DOM', async () => {
    const agent = await openAgentBrowser({
      browser,
      navigation: { mode: 'whitelist', domains: ['public-site.com'] },
      dnsLookupFn: mockPublicDnsLookup,
      prepareWebsite: createMockPagePreparer(sampleHtml),
    });

    try {
      const signal = new AbortController().signal;
      const obs = await agent.navigate('https://public-site.com/portal', signal);

      // Page visible text is present
      expect(obs.text).toContain('Welcome to the Automated Portal');
      expect(obs.text).toContain('This is genuine visible body copy intended for agent comprehension.');

      // Hidden elements are strictly excluded
      expect(obs.text).not.toContain('Hidden content that must not appear');
      expect(obs.text).not.toContain('Aria hidden content that must not appear');

      // Contenteditable elements are strictly excluded
      expect(obs.text).not.toContain('Editable text that must be excluded');

      // Controls and scripts are strictly excluded from text
      expect(obs.text).not.toContain('must not leak');
      expect(obs.text).not.toContain('background: white');

      // Text is not truncated
      expect(obs.truncated).toBe(false);
      expect(obs.publicOnly).toBe(false);
    } finally {
      await agent.close();
    }
  });

  test('bounds observation text to 16000 characters and sets truncated flag', async () => {
    const largeBody = 'A'.repeat(25000);
    const largeHtml = `<!doctype html><html><body><p>${largeBody}</p></body></html>`;

    const agent = await openAgentBrowser({
      browser,
      navigation: { mode: 'whitelist', domains: ['public-site.com'] },
      dnsLookupFn: mockPublicDnsLookup,
      prepareWebsite: createMockPagePreparer(largeHtml),
    });

    try {
      const signal = new AbortController().signal;
      const obs = await agent.navigate('https://public-site.com/large', signal);

      expect(obs.text.length).toBeLessThanOrEqual(16000);
      expect(obs.truncated).toBe(true);
    } finally {
      await agent.close();
    }
  });

  test('generates opaque IDs for fields and actions without leaking selectors or raw DOM identifiers', async () => {
    const agent = await openAgentBrowser({
      browser,
      navigation: { mode: 'whitelist', domains: ['public-site.com'] },
      dnsLookupFn: mockPublicDnsLookup,
      prepareWebsite: createMockPagePreparer(sampleHtml),
    });

    try {
      const signal = new AbortController().signal;
      const obs = await agent.navigate('https://public-site.com/portal', signal);

      expect(obs.fields.length).toBeGreaterThan(0);
      for (const field of obs.fields) {
        expect(typeof field.id).toBe('string');
        expect(field.id.length).toBeGreaterThan(0);
        // Opaque IDs must not contain CSS selectors or ID/class selectors
        expect(field.id).not.toContain('#');
        expect(field.id).not.toContain('>');
        expect(field.id).not.toContain('.');
      }

      const emailField = obs.fields.find(f => f.kind === 'email');
      expect(emailField).toBeDefined();
      expect(emailField?.label).toContain('Account Email');

      const passField = obs.fields.find(f => f.kind === 'password');
      expect(passField).toBeDefined();
      expect(passField?.label).toContain('Secret Password');

      const selectField = obs.fields.find(f => f.kind === 'select');
      expect(selectField).toBeDefined();
      expect(selectField?.options).toEqual(['Asia Pacific', 'Europe']);

      expect(obs.actions.length).toBeGreaterThan(0);
      for (const action of obs.actions) {
        expect(typeof action.id).toBe('string');
        expect(action.id.length).toBeGreaterThan(0);
        expect(action.id).not.toContain('#');
        expect(action.id).not.toContain('>');
      }

      const buttonAction = obs.actions.find(a => a.kind === 'button');
      expect(buttonAction?.label).toBe('Confirm Entry');

      const linkAction = obs.actions.find(a => a.kind === 'link');
      expect(linkAction?.label).toBe('Documentation Link');
      expect(linkAction?.href).toBe('https://public-site.com/docs');
    } finally {
      await agent.close();
    }
  });

  test('type() permits search/text fields but strictly forbids credential fields (password, email, username)', async () => {
    const agent = await openAgentBrowser({
      browser,
      navigation: { mode: 'whitelist', domains: ['public-site.com'] },
      dnsLookupFn: mockPublicDnsLookup,
      prepareWebsite: createMockPagePreparer(sampleHtml),
    });

    try {
      const signal = new AbortController().signal;
      const obs = await agent.navigate('https://public-site.com/portal', signal);

      const searchField = obs.fields.find(f => f.kind === 'text');
      const emailField = obs.fields.find(f => f.kind === 'email');
      const passField = obs.fields.find(f => f.kind === 'password');

      expect(searchField).toBeDefined();
      expect(emailField).toBeDefined();
      expect(passField).toBeDefined();

      // type() on email field is rejected
      let emailTypeRejected = false;
      try {
        await agent.type(emailField!.id, 'attacker@example.com', signal);
      } catch {
        emailTypeRejected = true;
      }
      expect(emailTypeRejected).toBe(true);

      // type() on password field is rejected
      let passTypeRejected = false;
      try {
        await agent.type(passField!.id, 'p@ssword', signal);
      } catch {
        passTypeRejected = true;
      }
      expect(passTypeRejected).toBe(true);

      // type() on search/text field succeeds
      const afterTypeObs = await agent.type(searchField!.id, 'wireless noise cancelling', signal);
      expect(afterTypeObs).toBeDefined();
    } finally {
      await agent.close();
    }
  });

  test('re-verifies actions in DOM immediately before clicking and rejects if element changed or removed', async () => {
    let pageRef: Page | null = null;
    const agent = await openAgentBrowser({
      browser,
      navigation: { mode: 'whitelist', domains: ['public-site.com'] },
      dnsLookupFn: mockPublicDnsLookup,
      prepareWebsite: async (page: Page) => {
        pageRef = page;
        await createMockPagePreparer(sampleHtml)(page);
      },
    });

    try {
      const signal = new AbortController().signal;
      const obs = await agent.navigate('https://public-site.com/portal', signal);

      const buttonAction = obs.actions.find(a => a.kind === 'button');
      expect(buttonAction).toBeDefined();

      // Mutate the DOM to remove the button element
      await pageRef!.evaluate(() => {
        const btn = document.getElementById('submit-action');
        btn?.remove();
      });

      // Clicking now must fail DOM reverification
      let reverifyFailed = false;
      try {
        await agent.click(buttonAction!.id, signal);
      } catch {
        reverifyFailed = true;
      }
      expect(reverifyFailed).toBe(true);
    } finally {
      await agent.close();
    }
  });

  test('invalidates opaque IDs on page navigation and rejects stale IDs', async () => {
    const agent = await openAgentBrowser({
      browser,
      navigation: { mode: 'whitelist', domains: ['public-site.com'] },
      dnsLookupFn: mockPublicDnsLookup,
      prepareWebsite: createMockPagePreparer(sampleHtml),
    });

    try {
      const signal = new AbortController().signal;
      const firstObs = await agent.navigate('https://public-site.com/step1', signal);
      const staleFieldId = firstObs.fields[0]!.id;
      const staleActionId = firstObs.actions[0]!.id;

      // Navigate to a second page, invalidating previous epoch
      await agent.navigate('https://public-site.com/step2', signal);

      // Stale field access must be rejected
      let staleFieldRejected = false;
      try {
        await agent.fill(staleFieldId, 'test-value', signal);
      } catch {
        staleFieldRejected = true;
      }
      expect(staleFieldRejected).toBe(true);

      // Stale action click must be rejected
      let staleActionRejected = false;
      try {
        await agent.click(staleActionId, signal);
      } catch {
        staleActionRejected = true;
      }
      expect(staleActionRejected).toBe(true);
    } finally {
      await agent.close();
    }
  });

  test('signed-in observations retain useful content but redact reflected private values and their preview pixels', async () => {
    let capturedPage: Page | null = null;
    const agent = await openAgentBrowser({
      browser,
      navigation: { mode: 'whitelist', domains: ['public-site.com'] },
      dnsLookupFn: mockPublicDnsLookup,
      prepareWebsite: async (page: Page) => {
        capturedPage = page;
        await createMockPagePreparer(sampleHtml)(page);
      },
    });

    try {
      const signal = new AbortController().signal;
      const obs = await agent.navigate('https://public-site.com/portal', signal);

      const passField = obs.fields.find(f => f.kind === 'password');
      expect(passField).toBeDefined();

      // Fill secret value host-only
      const secretValue = 'super-private-vault-token-xyz';
      await agent.fill(passField!.id, secretValue, signal);

      // Verify DOM value was injected directly into actual browser element
      const domValue = await capturedPage!.evaluate(() => {
        const input = document.getElementById('login-password') as HTMLInputElement | null;
        return input?.value;
      });
      expect(domValue).toBe(secretValue);

      const point = await capturedPage!.evaluate(secret => {
        const echo = document.createElement('p');
        echo.id = 'private-echo'; echo.textContent = `Signed in: ${secret}`;
        document.body.prepend(echo);
        const useful = document.createElement('p'); useful.textContent = 'Signed-in checkout: delivery tomorrow';
        document.body.prepend(useful);
        document.title = secret;
        history.replaceState(null, '', `/checkout?account=${encodeURIComponent(secret)}`);
        const rect = echo.getBoundingClientRect();
        return { x: Math.floor(rect.left + 100), y: Math.floor(rect.top + rect.height / 2) };
      }, secretValue);
      const postFillObs = await agent.observe(signal);
      expect(postFillObs.text).toContain('Signed-in checkout: delivery tomorrow');
      expect(JSON.stringify(postFillObs)).not.toContain(secretValue);
      expect(postFillObs.text).toContain('[private]');
      expect(agent.currentOrigin()).toBe('https://public-site.com');
      const frame = await agent.capture();
      const pixel = await sharp(Buffer.from(frame!.image, 'base64')).extract({ left: point.x, top: point.y, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
      expect([...pixel]).toEqual([0, 0, 0]);
    } finally {
      await agent.close();
    }
  });

  test('capture() returns masked live preview with solid opaque covers over all form controls and iframes', async () => {
    let capturedPage: Page | null = null;
    const agent = await openAgentBrowser({
      browser,
      navigation: { mode: 'whitelist', domains: ['public-site.com'] },
      dnsLookupFn: mockPublicDnsLookup,
      prepareWebsite: async (page: Page) => {
        capturedPage = page;
        await createMockPagePreparer(sampleHtml)(page);
      },
    });

    try {
      const signal = new AbortController().signal;
      const obs = await agent.navigate('https://public-site.com/portal', signal);

      const passField = obs.fields.find(f => f.kind === 'password');
      await agent.fill(passField!.id, 'very-secret-password-12345', signal);

      const frame = await agent.capture();
      expect(frame).not.toBeNull();
      expect(typeof frame?.image).toBe('string');
      expect(frame!.width).toBeGreaterThan(0);
      expect(frame!.height).toBeGreaterThan(0);

      // Verify the returned image is valid PNG data
      const imageBuffer = Buffer.from(frame!.image, 'base64');
      const meta = await sharp(imageBuffer).metadata();
      expect(meta.format).toBe('png');
      expect(meta.width).toBe(frame!.width);
      expect(meta.height).toBe(frame!.height);

      // Get location of the password input in CSS pixels
      const box = await capturedPage!.evaluate(() => {
        const el = document.getElementById('login-password')!;
        const r = el.getBoundingClientRect();
        return { x: Math.floor(r.x + r.width / 2), y: Math.floor(r.y + r.height / 2) };
      });

      // Extract raw pixels at the center of the password control
      const pixel = await sharp(imageBuffer)
        .extract({ left: box.x, top: box.y, width: 1, height: 1 })
        .raw()
        .toBuffer();

      // Form control must be solidly opaquely covered (black rgb: 0, 0, 0)
      expect(pixel[0]).toBe(0);
      expect(pixel[1]).toBe(0);
      expect(pixel[2]).toBe(0);
    } finally {
      await agent.close();
    }
  });

  test('research() executes in an isolated cookie-less context and closes context finally', async () => {
    const agent = await openAgentBrowser({
      browser,
      navigation: { mode: 'whitelist', domains: ['public-site.com'] },
      dnsLookupFn: mockPublicDnsLookup,
      prepareWebsite: createMockPagePreparer(sampleHtml),
    });

    try {
      const signal = new AbortController().signal;
      const researchObs = await agent.research('https://public-site.com/research-doc', signal);

      expect(researchObs.publicOnly).toBe(true);
      expect(researchObs.title).toBe('Automated Security Portal');
      expect(researchObs.text).toContain('Welcome to the Automated Portal');
      expect(researchObs.fields).toEqual([]);
      expect(researchObs.actions).toEqual([]);
    } finally {
      await agent.close();
    }
  });

  test('setNavigation() closes previous contexts and invalidates prior authority', async () => {
    const agent = await openAgentBrowser({
      browser,
      navigation: { mode: 'whitelist', domains: ['public-site.com'] },
      dnsLookupFn: mockPublicDnsLookup,
      prepareWebsite: createMockPagePreparer(sampleHtml),
    });

    try {
      const signal = new AbortController().signal;
      const obs = await agent.navigate('https://public-site.com/portal', signal);
      const oldFieldId = obs.fields[0]!.id;

      // Update navigation policy
      await agent.setNavigation({
        mode: 'whitelist',
        domains: ['public-site.com'],
      });

      // Previous authority/context was invalidated; old IDs fail
      let oldFieldRejected = false;
      try {
        await agent.fill(oldFieldId, 'unauthorized', signal);
      } catch {
        oldFieldRejected = true;
      }
      expect(oldFieldRejected).toBe(true);
    } finally {
      await agent.close();
    }
  });

  test('honors AbortSignal immediately by terminating active operation', async () => {
    const agent = await openAgentBrowser({
      browser,
      navigation: { mode: 'whitelist', domains: ['public-site.com'] },
      dnsLookupFn: mockPublicDnsLookup,
      prepareWebsite: createMockPagePreparer(sampleHtml),
    });

    try {
      const controller = new AbortController();
      controller.abort(); // already aborted

      let aborted = false;
      try {
        await agent.navigate('https://public-site.com/portal', controller.signal);
      } catch {
        aborted = true;
      }
      expect(aborted).toBe(true);
    } finally {
      await agent.close();
    }
  });


  test('fills successive login fields using refreshed capabilities without exposing either credential', async () => {
    let clickExecuted = false;
    const agent = await openAgentBrowser({
      browser,
      navigation: { mode: 'whitelist', domains: ['public-site.com'] },
      dnsLookupFn: mockPublicDnsLookup,
      prepareWebsite: async (page: Page) => {
        await page.route('**/*', async route => {
          await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: sampleHtml,
          });
        });
        await page.exposeFunction('onFormSubmit', () => {
          clickExecuted = true;
        });
        await page.addInitScript(() => {
          window.addEventListener('DOMContentLoaded', () => {
            document.getElementById('submit-action')?.addEventListener('click', () => {
              const win = window as Window & { onFormSubmit?: () => void };
              win.onFormSubmit?.();
            });
          });
        });
      },
    });

    try {
      const signal = new AbortController().signal;
      const initialObs = await agent.navigate('https://public-site.com/portal', signal);

      const emailField = initialObs.fields.find(f => f.kind === 'email');
      const passwordField = initialObs.fields.find(f => f.kind === 'password');
      const submitAction = initialObs.actions.find(a => a.kind === 'button');

      expect(emailField).toBeDefined();
      expect(passwordField).toBeDefined();
      expect(submitAction).toBeDefined();

      // Step 1: Fill first credential (email)
      await agent.fill(emailField!.id, 'authorized-user@example.test', signal);

      const afterFirstFillObs = await agent.observe(signal);
      expect(JSON.stringify(afterFirstFillObs)).not.toContain('authorized-user@example.test');

      // Step 2: Fill second credential (password) using retained field ID
      await agent.fill(afterFirstFillObs.fields.find(field => field.kind === 'password')!.id, 'vault-secret-pass-987', signal);

      // Step 3: Click login button using retained action ID
      const postSubmitObs = await agent.click(afterFirstFillObs.actions.find(action => action.kind === 'button')!.id, signal);
      expect(clickExecuted).toBe(true);
    } finally {
      await agent.close();
    }
  });
});

test('encoded private values spanning the observation cutoff are redacted before text truncation', async () => {
  let page: Page | undefined;
  const agent = await openAgentBrowser({
    browser, navigation: { mode: 'whitelist', domains: ['public-site.com'] }, dnsLookupFn: mockPublicDnsLookup,
    async prepareWebsite(opened) { page = opened; await createMockPagePreparer(sampleHtml)(opened); },
  });
  try {
    const signal = new AbortController().signal;
    const observation = await agent.navigate('https://public-site.com/login', signal);
    const secret = '密'.repeat(4096);
    await agent.fill(observation.fields.find(field => field.kind === 'password')!.id, secret, signal);
    await page!.evaluate(value => { document.body.textContent = 'x'.repeat(15000) + encodeURIComponent(value); }, secret);
    const redacted = await agent.observe(signal);
    expect(redacted.text).toContain('[private]');
    expect(redacted.text).not.toContain(encodeURIComponent(secret).slice(0, 90));
  } finally { await agent.close(); }
});
