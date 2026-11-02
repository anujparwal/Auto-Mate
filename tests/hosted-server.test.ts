import { afterEach, expect, test } from 'bun:test';
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openHostedServer, type HostedServerOptions } from '../src/hosted-server';
import { openAutofillApp, type AutofillApp } from '../src/autofill-owner';
import type { WorkspaceState } from '../src/agent-types';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function createServer(options: Pick<HostedServerOptions, 'clock' | 'sessionTtlMs' | 'disconnectGraceMs' | 'registrationKey'> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'AutoMate-gateway-'));
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const apps: AutofillApp[] = [];
  const server = await openHostedServer({ ...options, dataDirectory: directory, viewer: browser, appFactory: async settings => { const app = await openAutofillApp(settings); apps.push(app); return app; } });
  cleanups.push(async () => { try { await server.close(); } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); } });
  const origin = `http://127.0.0.1:${server.port}`;
  async function register(username: string, key = 'qa-account-passphrase-123') {
    const response = await fetch(origin + '/api/register', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, key }) });
    expect(response.status).toBe(200);
    const data = await response.json() as { csrfToken: string; username: string };
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    return { data, cookie, response, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': data.csrfToken } };
  }
  async function state(cookie: string): Promise<WorkspaceState> {
    const response = await fetch(origin + '/api/updates?after=0', { headers: { Cookie: cookie } });
    const data = await response.json() as { updates: { kind: string; state?: WorkspaceState }[] };
    return data.updates.find(update => update.kind === 'workspace')!.state!;
  }
  return { server, apps, origin, register, state };
}

test('bootstrap fails closed until HTTPS origin activation, and forged forwarded Host cannot bypass the boundary', async () => {
  const { server, origin } = await createServer();
  expect((await fetch(origin + '/login')).status).toBe(503);
  expect((await fetch(origin + '/healthz', { headers: { Host: 'platform-probe.internal' } })).status).toBe(503);
  expect(() => server.activatePublicOrigin('http://external.example')).toThrow();
  expect(() => server.activatePublicOrigin('https://external.example/path')).toThrow();
  server.activatePublicOrigin(origin);
  expect((await fetch(origin + '/login')).status).toBe(200);
  const health = await fetch(origin + '/healthz', { headers: { Host: 'platform-probe.internal' } });
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: 'ready' });
  expect(health.headers.get('set-cookie')).toBeNull();
  expect((await fetch(origin + '/login', { headers: { Host: 'evil.example', 'X-Forwarded-Host': new URL(origin).host } })).status).toBe(400);
});

test('open account registration preserves Origin, CSRF, authenticated workspace and cookie protections', async () => {
  const fixture = await createServer(); fixture.server.activatePublicOrigin(fixture.origin);
  const cross = await fetch(fixture.origin + '/api/register', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'csrf-user', key: 'qa-passphrase-12345' }) });
  expect(cross.status).toBe(403);
  const user = await fixture.register('csrf-user');
  expect(user.response.headers.get('set-cookie')).toContain('HttpOnly');
  expect(user.response.headers.get('set-cookie')).toContain('SameSite=Strict');
  const noCsrf = await fetch(fixture.origin + '/api/command', { method: 'POST', headers: { Origin: fixture.origin, Cookie: user.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'workspace-stop' }) });
  expect(noCsrf.status).toBe(403);
  const stopped = await fetch(fixture.origin + '/api/command', { method: 'POST', headers: user.headers, body: JSON.stringify({ action: 'workspace-stop' }) });
  expect(stopped.status).toBe(200);
  expect((await fixture.state(user.cookie)).phase).toBe('stopped');
  expect((await fetch(fixture.origin + '/api/session')).status).toBe(401);
});

test('wrong key rejects access; a replacement login revokes its prior session; logout closes the account owner', async () => {
  const fixture = await createServer(); fixture.server.activatePublicOrigin(fixture.origin);
  const first = await fixture.register('login-user');
  const bad = await fetch(fixture.origin + '/api/login', { method: 'POST', headers: { Origin: fixture.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'login-user', key: 'wrong-key-passphrase' }) });
  expect(bad.status).toBe(401);
  const login = await fetch(fixture.origin + '/api/login', { method: 'POST', headers: { Origin: fixture.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'login-user', key: 'qa-account-passphrase-123' }) });
  expect(login.status).toBe(200);
  const current = await login.json() as { csrfToken: string };
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  expect((await fetch(fixture.origin + '/api/session', { headers: { Cookie: first.cookie } })).status).toBe(401);
  expect(fixture.apps[0]!.page.isClosed()).toBe(true);
  const logout = await fetch(fixture.origin + '/api/logout', { method: 'POST', headers: { Origin: fixture.origin, Cookie: cookie, 'X-CSRF-Token': current.csrfToken } });
  expect(logout.status).toBe(200);
  expect((await fetch(fixture.origin + '/api/session', { headers: { Cookie: cookie } })).status).toBe(401);
  expect(fixture.apps[1]!.page.isClosed()).toBe(true);
});

test('session deadline is fixed and closes the owner, independent of polling activity', async () => {
  let clock = 1000;
  const fixture = await createServer({ clock: () => clock, sessionTtlMs: 150 }); fixture.server.activatePublicOrigin(fixture.origin);
  const user = await fixture.register('expiry-user');
  clock += 149;
  expect((await fetch(fixture.origin + '/api/session', { headers: { Cookie: user.cookie } })).status).toBe(200);
  clock += 2;
  expect((await fetch(fixture.origin + '/api/session', { headers: { Cookie: user.cookie } })).status).toBe(401);
  await fixture.server.close();
  expect(fixture.apps[0]!.page.isClosed()).toBe(true);
});

test('account metadata is isolated, secrets stay out of snapshots, and a late polling reconnect revokes task grants', async () => {
  let clock = 1000;
  const fixture = await createServer({ clock: () => clock, disconnectGraceMs: 5000 }); fixture.server.activatePublicOrigin(fixture.origin);
  const alice = await fixture.register('alice'), bob = await fixture.register('bob');
  const secret = 'private-profile-value-731';
  const save = await fetch(fixture.origin + '/api/command', { method: 'POST', headers: alice.headers, body: JSON.stringify({ action: 'workspace-save-variable', input: { name: 'Display Name', description: 'Preferred display name', kind: 'text', value: secret, scope: 'profile', origin: 'https://example.com' } }) });
  expect(save.status).toBe(200);
  const granted = await fetch(fixture.origin + '/api/command', { method: 'POST', headers: alice.headers, body: JSON.stringify({ action: 'workspace-grant', origin: 'https://example.com', names: ['Display Name'] }) });
  expect(granted.status).toBe(200);
  const before = await fixture.state(alice.cookie);
  expect(before.grants[0]!.names).toEqual(['Display Name']);
  expect(before.grants[0]!.origin).toBe('https://example.com');
  expect(JSON.stringify(before)).not.toContain(secret);
  expect((await fixture.state(bob.cookie)).variables).toEqual([]);
  clock += 5001;
  const after = await fixture.state(alice.cookie);
  expect(after.phase).toBe('stopped'); expect(after.grants).toEqual([]);
});
