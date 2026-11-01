import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { join } from 'node:path';
import { AgentEngine } from './agent-engine';
import { openAgentBrowser } from './agent-browser';
import { defaultWorkspaceSettings } from './agent-settings';
import { openWindowsWorkspaceStore } from './workspace-store';
import { WindowsInformationVault } from './information-vault';
import { WindowsSessionProtection, type SessionProtection } from './windows-session';
import { openHostedEgressProxy, HOSTED_CHROMIUM_ARGS, type HostedEgressProxy, type DnsLookupFn } from './hosted-egress';
import { LocalAuditJournal } from './audit';
import type { InformationVault } from './information-contract';
import type { AgentBrowser, WorkspaceState, BrowserFrame, WorkspaceStore } from './agent-types';

declare global {
  interface Window {
    autoMateAutofillUpdate: (data: unknown) => void;
    autoMateAutofill?: (command: unknown) => Promise<void>;
  }
}
const OWNER_ORIGIN = 'https://autofill-owner.auto-mate.invalid';
export interface AutofillApp {
  readonly page: Page;
  readonly closed: Promise<void>;
  readonly auditPath: string;
  command(raw: unknown): Promise<void>;
  close(): Promise<void>;
}
export interface AutofillAppOptions {
  viewer?: Browser;
  informationVault?: InformationVault;
  workspaceStore?: WorkspaceStore;
  protection?: SessionProtection;
  auditDirectory?: string;
  authenticationMode?: 'windows-hello' | 'user-key';
  modelProxy?: string;
  onUpdate?: (update: unknown) => void;
  /** Trusted integration fixture only, never user/model supplied code. */
  prepareWebsite?: (page: Page) => Promise<void>;
  dnsLookupFn?: DnsLookupFn;
}

/** One trusted workspace/controller shared by the desktop binding and hosted authenticated transport. */
export async function openAutofillApp(options: AutofillAppOptions = {}): Promise<AutofillApp> {
  const hosted = options.authenticationMode === 'user-key';
  if (hosted && (!options.viewer || !options.informationVault || !options.workspaceStore || !options.protection || !options.onUpdate)) throw Error('WORKSPACE_CONFIGURATION');
  const directory = options.auditDirectory ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'AutoMate', 'audit') : undefined);
  if (!directory) throw Error('AUDIT_UNAVAILABLE');
  const journal = new LocalAuditJournal(directory);
  let viewer = options.viewer;
  let proxy: HostedEgressProxy | undefined;
  let ownerContext: BrowserContext | undefined;
  let page: Page | undefined;
  let browser: AgentBrowser | undefined;
  let protection = options.protection;
  let engine: AgentEngine | undefined;
  let initialization: Promise<AgentEngine> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let sequence = 0;
  const closure = Promise.withResolvers<void>();
  const updates = new Set<Promise<void>>();
  let state: WorkspaceState | undefined;

  function publish(update: { kind: 'workspace'; state: WorkspaceState } | { kind: 'workspace-frame'; frame: BrowserFrame | null }): void {
    if (closed) return;
    options.onUpdate?.(update);
    if (!page || page.isClosed()) return;
    const pending = page.evaluate(data => window.autoMateAutofillUpdate(data), update);
    updates.add(pending);
    void pending.finally(() => updates.delete(pending)).catch(() => {
      if (!closed) void close();
    });
  }
  async function initialize(): Promise<AgentEngine> {
    if (initialization) return initialization;
    initialization = (async () => {
      if (!browser || !protection) throw Error('WORKSPACE_UNAVAILABLE');
      const assertActive = () => { if (closed) throw Error('WORKSPACE_CLOSED'); protection!.assertActive(); };
      const opened = await AgentEngine.open({
        browser, hosted, assertActive,
        vault: options.informationVault ?? new WindowsInformationVault(),
        store: options.workspaceStore ?? openWindowsWorkspaceStore({ assertActive }),
        modelProxy: options.modelProxy ?? (proxy ? `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@127.0.0.1:${proxy.port}` : undefined),
        onState(next) { state = next; publish({ kind: 'workspace', state: next }); },
        onFrame(frame) { publish({ kind: 'workspace-frame', frame }); },
        audit(event, task) { journal.append({ event, task, sequence: ++sequence, origin: OWNER_ORIGIN }); },
      });
      if (closed) { await opened.close(); throw Error('WORKSPACE_CLOSED'); }
      engine = opened;
      return opened;
    })();
    try { return await initialization; }
    catch (fault) { initialization = undefined; throw fault; }
  }
  async function command(raw: unknown): Promise<void> {
    if (closed) throw Error('WORKSPACE_CLOSED');
    if (!raw || typeof raw !== 'object' || !('action' in raw) || typeof raw.action !== 'string' || !raw.action.startsWith('workspace-')) throw Error('INVALID_WORKSPACE_COMMAND');
    if (raw.action === 'workspace-stop' && !engine) { await browser?.close(); return; }
    await (await initialize()).command(raw);
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      const failures: unknown[] = [];
      try { await engine?.close(); } catch (fault) { failures.push(fault); }
      if (initialization) { try { await initialization; } catch { /* A failed initialization created no active controller. */ } }
      try { await browser?.close(); } catch (fault) { failures.push(fault); }
      await Promise.allSettled([...updates]);
      try { await ownerContext?.close(); } catch (fault) { failures.push(fault); }
      if (!options.viewer) { try { await viewer?.close(); } catch (fault) { failures.push(fault); } }
      try { await proxy?.close(); } catch (fault) { failures.push(fault); }
      protection?.close();
      journal.close(); closure.resolve();
      if (failures.length) throw new AggregateError(failures, 'WORKSPACE_CLEANUP_FAILED');
    })();
    return closing;
  }
  try {
    if (!viewer) {
      proxy = await openHostedEgressProxy();
      viewer = await chromium.launch({ headless: false, chromiumSandbox: true, args: [...HOSTED_CHROMIUM_ARGS], proxy: { server: `http://127.0.0.1:${proxy.port}`, username: proxy.username, password: proxy.password } });
    }
    protection ??= await WindowsSessionProtection.open(() => { void engine?.stop().catch(() => close()); });
    browser = await openAgentBrowser({ browser: viewer, navigation: defaultWorkspaceSettings().navigation, prepareWebsite: options.prepareWebsite, dnsLookupFn: options.dnsLookupFn });
    ownerContext = await viewer.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: false, serviceWorkers: 'block' });
    const assets = new Map<string, { contentType: string; body: string }>();
    for (const [path, file, contentType] of [
      ['/', 'autofill.html', 'text/html; charset=utf-8'], ['/autofill.js', 'autofill.js', 'text/javascript; charset=utf-8'],
      ['/autofill.css', 'autofill.css', 'text/css; charset=utf-8'], ['/owner-preview.css', 'owner-preview.css', 'text/css; charset=utf-8'],
    ] as const) assets.set(path, { body: await Bun.file(new URL('../ui/' + file, import.meta.url)).text(), contentType });
    await ownerContext.route('**/*', async route => {
      const url = new URL(route.request().url()); const asset = url.origin === OWNER_ORIGIN ? assets.get(url.pathname) : undefined;
      if (!asset || route.request().method() !== 'GET') { await route.abort('blockedbyclient'); return; }
      await route.fulfill({ ...asset, headers: {
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      } });
    });
    page = await ownerContext.newPage();
    await page.exposeBinding('autoMateAutofill', async (source, raw: unknown) => {
      if (source.page !== page || source.frame !== page!.mainFrame() || new URL(page!.url()).origin !== OWNER_ORIGIN) throw Error('INVALID_WORKSPACE_COMMAND');
      await command(raw);
    });
    page.on('popup', popup => { void popup.close(); });
    page.on('close', () => { void close().catch(() => console.error('WORKSPACE_CLEANUP_FAILED')); });
    await page.goto(OWNER_ORIGIN, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.autoMateAutofillUpdate === 'function');
    // Hosted browsers have no local human; initialize their account-scoped workspace immediately.
    if (hosted) await initialize();
    if (state) publish({ kind: 'workspace', state });
    return { page, command, closed: closure.promise, auditPath: journal.path, close };
  } catch (fault) { await close(); throw new Error('WORKSPACE_APP_UNAVAILABLE', { cause: fault }); }
}
