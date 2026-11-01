import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Page } from 'playwright';
import { openHostedServer, type HostedServerInstance } from '../src/hosted-server';
import { openAutofillApp, type AutofillApp, type AutofillAppState } from '../src/autofill-owner';
import { InformationPlanner } from '../src/information-planner';
import type { InformationPlanningClient } from '../src/information-flow';
const REG_KEY = 'super-secret-invite-registration-key-16';

interface AuthResponse {
  username: string;
  csrfToken: string;
}

function extractCookie(res: Response): string {
  const header = res.headers.get('set-cookie') ?? '';
  return header.split(';')[0] ?? '';
}

interface TestServerContext {
  server: HostedServerInstance;
  tempDir: string;
  apps: AutofillApp[];
  latestState?: AutofillAppState;
  onState?: (state: AutofillAppState) => void;
}

async function createTestServer(options: {
  publicOrigin?: string;
  sessionTtlMs?: number;
  maxSessions?: number;
  disconnectGraceMs?: number;
  clock?: () => number;
  prepareWebsite?: (page: Page) => Promise<void>;
  informationPlanner?: InformationPlanningClient;
} = {}): Promise<TestServerContext> {
  const tempDir = await mkdtemp(join(tmpdir(), 'automate-hosted-server-'));
  const viewer = await chromium.launch({ headless: true, chromiumSandbox: true });
  const apps: AutofillApp[] = [];
  let latestState: AutofillAppState | undefined;
  let onState: ((state: AutofillAppState) => void) | undefined;
  const server = await openHostedServer({
    ...options, dataDirectory: tempDir, registrationKey: REG_KEY, viewer,
    appFactory: async appOptions => {
      const app = await openAutofillApp({ ...appOptions, onUpdate: update => {
        appOptions.onUpdate?.(update);
        if (update && typeof update === 'object' && 'kind' in update && update.kind === 'state' && 'state' in update) {
          // This callback is the in-process trusted owner engine's typed state projection.
          latestState = update.state as AutofillAppState;
          onState?.(latestState);
        }
      } });
      apps.push(app); return app;
    },
  });
  const close = server.close.bind(server);
  server.close = async () => { try { await close(); } finally { await viewer.close(); } };
  return { server, tempDir, apps, get latestState() { return latestState; }, get onState() { return onState; }, set onState(callback) { onState = callback; } };
}

describe('openHostedServer security and lifecycle', () => {
  let ctx: TestServerContext | null = null;

  afterEach(async () => {
    if (ctx) {
      await ctx.server.close();
      await rm(ctx.tempDir, { recursive: true, force: true });
      ctx = null;
    }
  });

  test('two-phase bootstrap: returns 503 until activated with valid HTTPS origin', async () => {
    ctx = await createTestServer(); // publicOrigin undefined initially

    const port = ctx.server.port;
    expect(port).toBeGreaterThan(0);

    // Initial request before activation must return 503
    const preActivateRes = await fetch(`http://127.0.0.1:${port}/login`);
    expect(preActivateRes.status).toBe(503);
    const preActivateJson = await preActivateRes.json();
    expect(preActivateJson.error).toBe('SERVICE_INITIALIZING');

    // Reject invalid origin (non-HTTPS and non-loopback)
    expect(() => {
      ctx!.server.activatePublicOrigin('http://insecure-domain.example.com');
    }).toThrow();

    // Reject origin with trailing path
    expect(() => {
      ctx!.server.activatePublicOrigin('https://valid.example.com/some/path');
    }).toThrow();

    // Activate with valid loopback smoke origin
    const validOrigin = `http://127.0.0.1:${port}`;
    ctx.server.activatePublicOrigin(validOrigin);

    // Second activation attempt must fail (strictly one-shot)
    expect(() => {
      ctx!.server.activatePublicOrigin(validOrigin);
    }).toThrow();

    // After activation, /login is served
    const postActivateRes = await fetch(`http://127.0.0.1:${port}/login`);
    expect(postActivateRes.status).toBe(200);
    expect(await postActivateRes.text()).toContain('Auto-Mate');
  });

  test('validates Host header and rejects spoofed or unexpected Host', async () => {
    ctx = await createTestServer();
    const port = ctx.server.port;
    ctx.server.activatePublicOrigin(`http://127.0.0.1:${port}`);

    // Request with valid Host header
    const validRes = await fetch(`http://127.0.0.1:${port}/login`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(validRes.status).toBe(200);

    // Request with spoofed Host header
    const spoofedRes = await fetch(`http://127.0.0.1:${port}/login`, {
      headers: { Host: 'evil-attacker.example.com' },
    });
    expect(spoofedRes.status).toBe(400);
    expect(await spoofedRes.text()).toContain('Host header mismatch');
  });

  test('enforces Origin and CSRF validation on mutating API requests', async () => {
    ctx = await createTestServer();
    const port = ctx.server.port;
    const origin = `http://127.0.0.1:${port}`;
    ctx.server.activatePublicOrigin(origin);

    // Cross-origin POST request must be rejected
    const crossOriginRes = await fetch(`http://127.0.0.1:${port}/api/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example.com',
      },
      body: JSON.stringify({
        username: 'testuser',
        key: 'test-passphrase-key-12',
        registrationKey: REG_KEY,
      }),
    });
    expect(crossOriginRes.status).toBe(403);
    const crossOriginJson = await crossOriginRes.json();
    expect(crossOriginJson.error).toBe('FORBIDDEN');

    // Same-origin POST request with valid registration key succeeds
    const validRegisterRes = await fetch(`http://127.0.0.1:${port}/api/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      body: JSON.stringify({
        username: 'testuser',
        key: 'test-passphrase-key-12',
        registrationKey: REG_KEY,
      }),
    });
    expect(validRegisterRes.status).toBe(200);
    const registerData = (await validRegisterRes.json()) as AuthResponse;
    expect(registerData.username).toBe('testuser');
    expect(typeof registerData.csrfToken).toBe('string');

    const cookie = extractCookie(validRegisterRes);
    expect(cookie).toContain('automate_session=');
    expect(validRegisterRes.headers.get('set-cookie')).toContain('HttpOnly');
    expect(validRegisterRes.headers.get('set-cookie')).toContain('SameSite=Strict');

    // Command without CSRF header must be rejected
    const noCsrfRes = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        Cookie: cookie,
      },
      body: JSON.stringify({ action: 'inspect', url: 'https://example.com' }),
    });
    expect(noCsrfRes.status).toBe(403);
    expect((await noCsrfRes.json()).error).toBe('CSRF_INVALID');

    // Command with valid CSRF header succeeds and dispatches to app
    const validCommandRes = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        Cookie: cookie,
        'X-CSRF-Token': registerData.csrfToken,
      },
      body: JSON.stringify({ action: 'inspect', url: 'https://example.com' }),
    });
    expect(validCommandRes.status).toBe(200);
    expect((await validCommandRes.json()).ok).toBe(true);
  });

  test('handles login, logout, and session revocation cleanly', async () => {
    ctx = await createTestServer();
    const port = ctx.server.port;
    const origin = `http://127.0.0.1:${port}`;
    ctx.server.activatePublicOrigin(origin);

    // Register user
    await fetch(`${origin}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({
        username: 'alice',
        key: 'alice-secret-passphrase-12',
        registrationKey: REG_KEY,
      }),
    });

    // Login with wrong key fails (401)
    const badLoginRes = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({
        username: 'alice',
        key: 'wrong-passphrase-key-12',
      }),
    });
    expect(badLoginRes.status).toBe(401);

    // Login with correct key succeeds
    const loginRes = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({
        username: 'alice',
        key: 'alice-secret-passphrase-12',
      }),
    });
    expect(loginRes.status).toBe(200);
    const loginData = (await loginRes.json()) as AuthResponse;
    const cookie = extractCookie(loginRes);

    // Check GET /api/session
    const sessionRes = await fetch(`${origin}/api/session`, {
      headers: { Cookie: cookie },
    });
    expect(sessionRes.status).toBe(200);
    const sessionData = await sessionRes.json();
    expect(sessionData.username).toBe('alice');
    expect(sessionData.csrfToken).toBe(loginData.csrfToken);

    // Logout
    const logoutRes = await fetch(`${origin}/api/logout`, {
      method: 'POST',
      headers: {
        Origin: origin,
        Cookie: cookie,
        'X-CSRF-Token': loginData.csrfToken,
      },
    });
    expect(logoutRes.status).toBe(200);

    // Subsequent access with old cookie returns 401
    const postLogoutRes = await fetch(`${origin}/api/session`, {
      headers: { Cookie: cookie },
    });
    expect(postLogoutRes.status).toBe(401);
  });

  test('enforces fixed session TTL and revokes expired sessions', async () => {
    let time = 1_000;
    ctx = await createTestServer({ sessionTtlMs: 150, clock: () => time });
    const port = ctx.server.port;
    const origin = `http://127.0.0.1:${port}`;
    ctx.server.activatePublicOrigin(origin);

    const regRes = await fetch(`${origin}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({
        username: 'bob',
        key: 'bob-secret-passphrase-12',
        registrationKey: REG_KEY,
      }),
    });
    const cookie = extractCookie(regRes);

    // Session is immediately valid
    const check1 = await fetch(`${origin}/api/session`, { headers: { Cookie: cookie } });
    expect(check1.status).toBe(200);

    time += 151;

    // Session is now expired -> 401
    const check2 = await fetch(`${origin}/api/session`, { headers: { Cookie: cookie } });
    expect(check2.status).toBe(401);
  });

  test('enforces single active session per account by closing old session on replaced login', async () => {
    ctx = await createTestServer();
    const port = ctx.server.port;
    const origin = `http://127.0.0.1:${port}`;
    ctx.server.activatePublicOrigin(origin);

    // Register user
    const regRes = await fetch(`${origin}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({
        username: 'carol',
        key: 'carol-passphrase-key-12',
        registrationKey: REG_KEY,
      }),
    });
    const firstCookie = extractCookie(regRes);

    // Verify first session works
    const check1 = await fetch(`${origin}/api/session`, { headers: { Cookie: firstCookie } });
    expect(check1.status).toBe(200);

    // Re-login as carol (e.g. from another browser tab or device)
    const loginRes = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({
        username: 'carol',
        key: 'carol-passphrase-key-12',
      }),
    });
    expect(loginRes.status).toBe(200);
    const secondCookie = extractCookie(loginRes);

    // Second session works
    const check2 = await fetch(`${origin}/api/session`, { headers: { Cookie: secondCookie } });
    expect(check2.status).toBe(200);

    // First session MUST have been closed and revoked (returns 401)
    const checkOld = await fetch(`${origin}/api/session`, { headers: { Cookie: firstCookie } });
    expect(checkOld.status).toBe(401);
  });


  test('a late polling reconnect revokes the actual website before returning state', async () => {
    let time = 1_000;
    ctx = await createTestServer({
      disconnectGraceMs: 5000, clock: () => time,
      prepareWebsite: async page => {
        await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><label for="name">Full name</label><input id="name"><button type="button">Continue</button>' }));
      },
    });
    const origin = `http://127.0.0.1:${ctx.server.port}`;
    ctx.server.activatePublicOrigin(origin);
    const registration = await fetch(origin + '/api/register', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'poll-user', key: 'fictitious-poll-key-123', registrationKey: REG_KEY }),
    });
    expect(registration.status).toBe(200);
    const cookie = extractCookie(registration);
    const auth: AuthResponse = await registration.json();
    const initial = await (await fetch(origin + '/api/updates?after=0', { headers: { Cookie: cookie } })).json();
    expect(initial.updates.find((update: { kind: string }) => update.kind === 'state').state.authenticationMode).toBe('user-key');
    const response = await fetch(origin + '/api/command', {
      method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrfToken },
      body: JSON.stringify({ action: 'inspect', revision: ctx.latestState!.revision, url: 'https://hosted-fixture.test/form', kind: 'information' }),
    });
    expect(response.status).toBe(200);
    expect(ctx.latestState?.phase).toBe('review');
    const worker = ctx.apps[0]!.page.context().browser()!.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('https://hosted-fixture.test/'))!;
    expect(worker.isClosed()).toBe(false);
    time += 5001;
    const afterDisconnect = await (await fetch(origin + '/api/updates?after=0', { headers: { Cookie: cookie } })).json();
    expect(worker.isClosed()).toBe(true);
    expect(ctx.latestState?.fields).toEqual([]);
    expect(afterDisconnect.updates.find((update: { kind: string }) => update.kind === 'state').state.phase).toBe('stopped');
  }, 20_000);

  test('protected-page model boundary refuses external plan and asks missing info locally after approved DOM change', async () => {
    let providerCalls = 0;
    const providerServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        providerCalls++;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({}) } }],
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    try {
      const planner = new InformationPlanner({
        mode: 'local',
        endpoint: `http://127.0.0.1:${providerServer.port}/v1/chat/completions`,
        model: 'boundary-fixture-model',
      });

      let time = 10_000;
      ctx = await createTestServer({
        clock: () => time,
        informationPlanner: planner,
        prepareWebsite: async page => {
          await page.route('**/*', route =>
            route.fulfill({
              contentType: 'text/html',
              body: `<!doctype html><html><head><title>Boundary</title></head><body><label id="name-label" for="name">Full name</label><input id="name"><button id="btn" type="button" onclick="document.getElementById('name-label').textContent='PRIVATE-LABEL'">Continue</button></body></html>`,
            })
          );
        },
      });

      const origin = `http://127.0.0.1:${ctx.server.port}`;
      ctx.server.activatePublicOrigin(origin);

      const registration = await fetch(origin + '/api/register', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'boundary-user', key: 'boundary-key-12345', registrationKey: REG_KEY }),
      });
      expect(registration.status).toBe(200);
      const cookie = extractCookie(registration);
      const auth: AuthResponse = await registration.json();

      const inspectRes = await fetch(origin + '/api/command', {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrfToken },
        body: JSON.stringify({ action: 'inspect', revision: ctx.latestState!.revision, url: 'https://hosted-fixture.test/form', kind: 'information' }),
      });
      expect(inspectRes.status).toBe(200);
      expect(ctx.latestState?.phase).toBe('review');
      expect(ctx.latestState?.modelObservationAllowed).toBe(true);

      const worker = ctx.apps[0]!.page.context().browser()!.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('https://hosted-fixture.test/'))!;
      expect(worker.isClosed()).toBe(false);

      const initialLabel = await worker.$eval('#name-label', el => el.textContent);
      expect(initialLabel).toBe('Full name');

      const continueBtn = ctx.latestState!.websiteActions.find(a => a.label === 'Continue')!;
      expect(continueBtn).toBeDefined();

      // 1. Request alone has NO DOM effect
      const reqRes = await fetch(origin + '/api/command', {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrfToken },
        body: JSON.stringify({
          action: 'website-click-request',
          revision: ctx.latestState!.revision,
          buttonId: continueBtn.id,
          durationSeconds: 60,
        }),
      });
      expect(reqRes.status).toBe(200);
      expect(ctx.latestState?.pendingPermission?.actionId).toBe(continueBtn.id);

      const labelAfterReq = await worker.$eval('#name-label', el => el.textContent);
      expect(labelAfterReq).toBe('Full name');
      expect(ctx.latestState?.modelObservationAllowed).toBe(true);

      // 2. Approval changes DOM, modelObservationAllowed=false
      const approveRes = await fetch(origin + '/api/command', {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrfToken },
        body: JSON.stringify({
          action: 'website-click-approve',
          revision: ctx.latestState!.revision,
          permissionId: ctx.latestState!.pendingPermission!.id,
        }),
      });
      expect(approveRes.status).toBe(200);

      const labelAfterApprove = await worker.$eval('#name-label', el => el.textContent);
      expect(labelAfterApprove).toBe('PRIVATE-LABEL');
      expect(ctx.latestState?.modelObservationAllowed).toBe(false);

      const catalogRes = await fetch(origin + '/api/command', {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrfToken },
        body: JSON.stringify({
          action: 'information-catalog',
          revision: ctx.latestState!.revision,
        }),
      });
      expect(catalogRes.status).toBe(200);
      // 3. External plan refused with zero HTTP provider calls
      const externalPlanRes = await fetch(origin + '/api/command', {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrfToken },
        body: JSON.stringify({
          action: 'information-plan',
          revision: ctx.latestState!.revision,
          shareMetadata: true,
        }),
      });
      await externalPlanRes.arrayBuffer();
      expect(ctx.latestState?.information?.planned).toBe(false);
      expect(ctx.latestState?.information?.request).toBeUndefined();
      expect(providerCalls).toBe(0);

      // 4. Explicit information-plan-local still asks missing info

      const localPlanRes = await fetch(origin + '/api/command', {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrfToken },
        body: JSON.stringify({
          action: 'information-plan-local',
          revision: ctx.latestState!.revision,
        }),
      });
      expect(localPlanRes.status).toBe(200);
      expect(providerCalls).toBe(0);
      expect(ctx.latestState?.information?.request).toBeDefined();
      expect(ctx.latestState?.information?.request?.field.label).toBe('PRIVATE-LABEL');

      // 5. Stopping session clears latestFrame and does not return stale preview
      const stopRes = await fetch(origin + '/api/command', {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrfToken },
        body: JSON.stringify({
          action: 'stop',
          revision: ctx.latestState!.revision,
        }),
      });
      expect(stopRes.status).toBe(200);
      expect(ctx.latestState?.phase).toBe('stopped');

      interface UpdatesPayload {
        sequence: number;
        updates: Array<{ kind: string }>;
      }
      const updatesRes = await fetch(origin + '/api/updates?after=0', { headers: { Cookie: cookie } });
      const updatesJson: UpdatesPayload = await updatesRes.json();
      const frames = updatesJson.updates.filter(u => u.kind === 'frame');
      expect(frames.length).toBe(0);
    } finally {
      providerServer.stop(true);
    }
  }, 20_000);
});
