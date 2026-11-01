import { chromium, type Page } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostedAccounts } from '../src/hosted-accounts';
import { AgentEngine } from '../src/agent-engine';
import { openAgentBrowser } from '../src/agent-browser';
import type { BrowserObservation, WorkspaceState } from '../src/agent-types';
import type { InformationVault } from '../src/information-contract';
import type { WorkspaceStoredData, WorkspaceStore } from '../src/agent-types';

export const fixtureOrigin = 'https://workspace-fixture.example.com';
export const fixtureEmail = 'private-owner-742@example.test';
export const fixturePassword = 'private-value-not-for-model-859';
export interface CompletionBody { messages: { role: string; content: string }[]; model: string }
export function lastObservation(body: CompletionBody): BrowserObservation {
  for (let index = body.messages.length - 1; index >= 0; index--) {
    const content = body.messages[index]!.content;
    if (!content.startsWith('UNTRUSTED TOOL RESULT')) continue;
    const start = content.indexOf(': ') + 2;
    try {
      const parsed = JSON.parse(content.slice(start).split('\nVariable metadata')[0]!) as BrowserObservation;
      if (Array.isArray(parsed.fields) && Array.isArray(parsed.actions)) return parsed;
    } catch { /* A prior non-observation tool result is expected. */ }
  }
  throw Error('No browser observation in request');
}
export async function workspaceFixture(plan: (body: CompletionBody, parentStep: number) => unknown | Promise<unknown>, options: { knownPassword?: boolean; knownEmail?: boolean; gateRead?: Promise<void> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'AutoMate-workspace-'));
  const accounts = await HostedAccounts.open({ directory, registrationKey: 'fixture-registration-not-a-real-key' });
  const account = await accounts.register('workspace-user', 'test-account-passphrase-long', 'fixture-registration-not-a-real-key');
  if (options.knownPassword) await account.informationVault.save({ name: 'Password', description: 'Fixture website password', value: fixturePassword, kind: 'password', scope: 'site', origin: fixtureOrigin });
  if (options.knownEmail) await account.informationVault.save({ name: 'Email', description: 'Fixture website email', value: fixtureEmail, kind: 'email', scope: 'site', origin: fixtureOrigin });
  const browser = await chromium.launch({ headless: true });
  const bodies: string[] = [];
  let parentStep = 0;
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const raw = await request.text(); bodies.push(raw);
    const body = JSON.parse(raw) as CompletionBody;
    const isEvaluator = body.messages[0]?.content.includes('read-only evidence evaluator');
    const action = await plan(body, isEvaluator ? -1 : parentStep++);
    return Response.json({ choices: [{ message: { content: JSON.stringify(action) } }] });
  } });
  let mainPage: Page | undefined;
  const researchCookies: string[] = [];
  const driver = await openAgentBrowser({ browser, navigation: { mode: 'blacklist', domains: [] }, dnsLookupFn: async () => [{ address: '93.184.216.34', family: 4 }], async prepareWebsite(page) {
    if (!mainPage) mainPage = page;
    await page.route(fixtureOrigin + '/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/product')) {
        researchCookies.push(route.request().headers().cookie ?? '');
        const privateEcho = route.request().headers().cookie?.includes('signed=1') ? `${fixtureEmail} ${fixturePassword}` : '';
        await route.fulfill({ contentType: 'text/html', body: `<h1>${path === '/product-a' ? 'Speaker A' : 'Speaker B'}</h1><p>${path === '/product-a' ? 'Price Rs 1499. Battery 12 hours.' : 'Price Rs 1899. Battery 10 hours.'}</p><p>${privateEcho}</p>` });
      } else await route.fulfill({ contentType: 'text/html', body: `<body style="font:16px sans-serif;margin:30px"><p>Public sign-in page</p><label for="email">Email</label><input id="email" type="email"><label for="password">Password</label><input id="password" type="password"><button id="login" type="button" onclick="document.body.dataset.clicked='yes';document.cookie='signed=1;path=/';document.getElementById('echo').textContent=document.getElementById('email').value+' '+document.getElementById('password').value">Login</button><a href="/product-a">Product details</a><p id="echo"></p></body>` });
    });
  } });
  const readStarted = Promise.withResolvers<void>();
  const vault: InformationVault = {
    catalog: target => account.informationVault.catalog(target), save: input => account.informationVault.save(input), clear: () => account.informationVault.clear(), authenticate: target => account.informationVault.authenticate(target),
    async read(id, target) { readStarted.resolve(); await options.gateRead; return account.informationVault.read(id, target); },
  };
  let stored: WorkspaceStoredData | null = null;
  const store: WorkspaceStore = { async load() { return stored; }, async save(data) { stored = structuredClone(data); } };
  let state: WorkspaceState | undefined;
  const listeners = new Set<(state: WorkspaceState) => void>();
  const engine = await AgentEngine.open({ browser: driver, vault, store, hosted: false, assertActive: () => account.assertActive(), onFrame() {}, onState(next) { state = next; for (const listener of listeners) listener(next); } });
  await engine.command({ action: 'workspace-settings', settings: { model: { preset: 'custom', mode: 'local', endpoint: `http://127.0.0.1:${provider.port}/v1/chat/completions`, model: 'protocol-fixture' }, navigation: { mode: 'blacklist', domains: [] }, memory: { enabled: false, content: '' }, groups: [] } });
  return {
    engine, driver, account, browser, bodies, researchCookies,
    readStarted: readStarted.promise,
    get state() { if (!state) throw Error('State unavailable'); return state; },
    get page() { if (!mainPage) throw Error('Main page unavailable'); return mainPage; },
    wait(predicate: (state: WorkspaceState) => boolean): Promise<WorkspaceState> {
      if (state && predicate(state)) return Promise.resolve(state);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { listeners.delete(listener); reject(Error('Workspace transition timeout')); }, 15000);
        const listener = (next: WorkspaceState) => { if (predicate(next)) { clearTimeout(timeout); listeners.delete(listener); resolve(next); } };
        listeners.add(listener);
      });
    },
    async close() { try { await engine.close(); } finally { provider.stop(true); await browser.close(); await account.close(); await rm(directory, { recursive: true, force: true }); } },
  };
}
