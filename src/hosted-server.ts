import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, type Browser, type Page } from 'playwright';
import { openHostedEgressProxy, HOSTED_CHROMIUM_ARGS, type HostedEgressProxy } from './hosted-egress';
import { openAutofillApp, type AutofillApp, type AutofillAppOptions } from './autofill-owner';
import type { SessionProtection } from './windows-session';
import { HostedAccounts, HostedAccountSession } from './hosted-accounts';

export { HostedAccountSession };

export interface HostedAccountsStore {
  register(username: string, key: string, registrationKey: string): Promise<HostedAccountSession>;
  unlock(username: string, key: string): Promise<HostedAccountSession>;
}

export interface HostedAccountsFactory {
  open(options: { directory: string; registrationKey: string }): Promise<HostedAccountsStore>;
}

export interface HostedServerOptions {
  host?: string;
  publicOrigin?: string;
  port?: number;
  dataDirectory: string;
  registrationKey?: string;
  viewer?: Browser;
  headless?: boolean;
  egressProxy?: HostedEgressProxy;
  accounts?: HostedAccountsStore;
  accountsFactory?: HostedAccountsFactory;
  sessionTtlMs?: number;
  maxSessions?: number;
  disconnectGraceMs?: number;
  clock?: () => number;
  prepareWebsite?: (page: Page) => Promise<void>;
  appFactory?: (options: AutofillAppOptions) => Promise<AutofillApp>;
}

export interface HostedServerInstance {
  readonly url: string;
  readonly port: number;
  activatePublicOrigin(origin: string): void;
  close(): Promise<void>;
}

interface ActiveSession {
  readonly token: string;
  readonly csrfToken: string;
  readonly accountId: string;
  readonly username: string;
  readonly expiresAt: number;
  readonly accountSession: HostedAccountSession;
  readonly app: AutofillApp;
  latestState?: unknown;
  latestFrame?: unknown;
  sequence: number;
  stateSequence: number;
  frameSequence: number;
  lastPollAt: number;
  disconnected: boolean;
  watchdog?: NodeJS.Timeout;
  isClosed: boolean;
  close(): Promise<void>;
  broadcast(update: unknown): void;
}

const UI_DIR = join(import.meta.dir, '..', 'ui');

function validateOriginString(originStr: string): string {
  let url: URL;
  try {
    url = new URL(originStr);
  } catch {
    throw new Error(`INVALID_PUBLIC_ORIGIN: Invalid URL "${originStr}"`);
  }

  if (url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('INVALID_PUBLIC_ORIGIN');
  }

  const isLoopback =
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname === '[::1]';

  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('INVALID_PUBLIC_ORIGIN');
  }

  return url.origin;
}

function parseCookies(header: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!header) return map;
  const parts = header.split(';');
  for (const part of parts) {
    const [rawKey, rawVal] = part.split('=');
    if (rawKey && rawVal !== undefined) {
      map.set(rawKey.trim(), decodeURIComponent(rawVal.trim()));
    }
  }
  return map;
}

async function readRequestBody(req: http.IncomingMessage, maxBytes = 65536): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let total = 0;
  const chunks: Buffer[] = [];

  req.on('data', (chunk: Buffer) => {
    total += chunk.length;
    if (total > maxBytes) {
      req.destroy();
      reject(new Error('PAYLOAD_TOO_LARGE'));
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    resolve(Buffer.concat(chunks).toString('utf-8'));
  });

  req.on('error', err => reject(err));
  return promise;
}


export async function openHostedServer(options: HostedServerOptions): Promise<HostedServerInstance> {
  const clock = options.clock ?? Date.now;
  let activePublicOrigin: string | undefined = options.publicOrigin
    ? validateOriginString(options.publicOrigin)
    : undefined;

  const accountsStore = options.accounts ?? await (options.accountsFactory ?? HostedAccounts).open({
    directory: options.dataDirectory,
    registrationKey: options.registrationKey ?? '',
  });

  let egressProxy: HostedEgressProxy | undefined = options.egressProxy;
  let ownEgressProxy = false;
  if (!egressProxy && !options.appFactory) {
    egressProxy = await openHostedEgressProxy();
    ownEgressProxy = true;
  }

  let sharedViewer: Browser | undefined = options.viewer;
  let ownViewer = false;
  if (!sharedViewer && !options.appFactory && egressProxy) {
    sharedViewer = await chromium.launch({
      headless: options.headless ?? true,
      chromiumSandbox: true,
      args: [...HOSTED_CHROMIUM_ARGS],
      proxy: {
        server: `http://127.0.0.1:${egressProxy.port}`,
        username: egressProxy.username,
        password: egressProxy.password,
      },
    });
    ownViewer = true;
  }

  const sessionTtlMs = options.sessionTtlMs ?? 60 * 60 * 1000; // 1 hour default
  const maxSessions = options.maxSessions ?? 4;
  const disconnectGraceMs = options.disconnectGraceMs ?? 5000;
  const appFactory = options.appFactory ?? openAutofillApp;

  const sessionsByToken = new Map<string, ActiveSession>();
  const sessionsByAccount = new Map<string, ActiveSession>();
  const closingSessions = new Set<Promise<void>>();

  const reportCleanupFailure = () => { console.error('HOSTED_SESSION_CLEANUP_FAILED'); };

  // Rate limiting / concurrency guards
  let activeAuthOperations = 0;
  const maxAuthConcurrency = 2;
  const failedAttempts = new Map<string, number[]>(); // ip/user -> timestamps

  function recordFailedAttempt(key: string): void {
    if (!failedAttempts.has(key) && failedAttempts.size >= 1024) failedAttempts.delete(failedAttempts.keys().next().value!);
    const now = clock();
    const list = failedAttempts.get(key) ?? [];
    const recent = list.filter(t => now - t < 300_000); // last 5 minutes
    recent.push(now);
    failedAttempts.set(key, recent);
  }

  function isRateLimited(key: string): boolean {
    const now = clock();
    const list = failedAttempts.get(key) ?? [];
    const recent = list.filter(t => now - t < 300_000);
    failedAttempts.set(key, recent);
    return recent.length >= 5;
  }

  function resetFailedAttempts(key: string): void {
    failedAttempts.delete(key);
  }

  let isClosing = false;
  let creationQueue: Promise<void> = Promise.resolve();
  function createSession(account: HostedAccountSession): Promise<ActiveSession> {
    const running = creationQueue.then(() => createSessionExclusive(account));
    creationQueue = running.then(() => {}, () => {});
    return running;
  }
  async function stopDisconnected(session: ActiveSession): Promise<void> {
    if (session.disconnected || clock() - session.lastPollAt <= disconnectGraceMs) return;
    session.disconnected = true;
    try { await session.app.command({ action: 'workspace-stop' }); }
    catch { await session.close(); }
  }

  async function createSessionExclusive(accountSession: HostedAccountSession): Promise<ActiveSession> {
    if (isClosing) { await accountSession.close(); throw new Error('HOSTED_SERVER_CLOSING'); }
    // If account already has an active session, replace it immediately
    const existing = sessionsByAccount.get(accountSession.accountId);
    if (existing) {
      await existing.close();
    }

    // Check session capacity
    if (sessionsByAccount.size >= maxSessions) {
      await accountSession.close();
      throw new Error('SESSION_CAPACITY_REACHED');
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    let expiresAt = clock() + sessionTtlMs;

    const userAuditDir = join(options.dataDirectory, 'users', accountSession.accountId, 'audit');
    await mkdir(userAuditDir, { recursive: true });

    let appInstance: AutofillApp | undefined;
    let protectionClosed = false;
    let closingSession: Promise<void> | undefined;

    const protection: SessionProtection = {
      assertActive() {
        if (protectionClosed || clock() >= expiresAt) {
          throw new Error('HOSTED_SESSION_EXPIRED');
        }
        accountSession.assertActive();
      },
      close() { protectionClosed = true; },
    };

    const session: ActiveSession = {
      token,
      csrfToken,
      accountId: accountSession.accountId,
      username: accountSession.username,
      get expiresAt() { return expiresAt; },
      accountSession,
      get app() {
        if (!appInstance) throw new Error('APP_NOT_INITIALIZED');
        return appInstance;
      },
      sequence: 0, stateSequence: 0, frameSequence: 0, lastPollAt: clock(), disconnected: false,
      isClosed: false,
      broadcast(update: unknown) {
        if (session.isClosed || !update || typeof update !== 'object' || !('kind' in update)) return;
        if (update.kind === 'workspace') {
          session.latestState = update;
          session.stateSequence = ++session.sequence;
          const state = 'state' in update && update.state && typeof update.state === 'object' ? update.state : undefined;
          if (state && 'phase' in state && (state.phase === 'stopped' || state.phase === 'failed')) {
            session.latestFrame = undefined;
            session.frameSequence = 0;
          }
        } else if (update.kind === 'workspace-frame') {
          session.latestFrame = update;
          session.frameSequence = ++session.sequence;
        }
      },
      close() {
        if (closingSession) return closingSession;
        session.isClosed = true;
        protectionClosed = true;
        clearInterval(session.watchdog);
        session.latestFrame = undefined;
        session.frameSequence = 0;
        sessionsByToken.delete(token);
        if (sessionsByAccount.get(accountSession.accountId) === session) sessionsByAccount.delete(accountSession.accountId);
        closingSession = (async () => {
          let failed = false;
          try { await appInstance?.close(); } catch { failed = true; }
          try { await accountSession.close(); } catch { failed = true; }
          if (failed) throw new Error('HOSTED_SESSION_CLEANUP_FAILED');
        })();
        closingSessions.add(closingSession);
        void closingSession.then(
          () => closingSessions.delete(closingSession!),
          () => closingSessions.delete(closingSession!),
        );
        closingSession.catch(reportCleanupFailure);
        return closingSession;
      },
    };

    try {
      appInstance = await appFactory({
        viewer: sharedViewer,
        informationVault: accountSession.informationVault,
        workspaceStore: accountSession.workspaceStore,
        modelProxy: egressProxy ? `http://${encodeURIComponent(egressProxy.username)}:${encodeURIComponent(egressProxy.password)}@127.0.0.1:${egressProxy.port}` : undefined,
        auditDirectory: userAuditDir,
        protection,
        prepareWebsite: options.prepareWebsite,
        authenticationMode: 'user-key',
        onUpdate: (update: unknown) => {
          session.broadcast(update);
        },
      });
    } catch (err) {
      await accountSession.close();
      throw err;
    }
    if (isClosing) { await session.close(); throw new Error('HOSTED_SERVER_CLOSING'); }
    expiresAt = clock() + sessionTtlMs;
    session.lastPollAt = clock();
    void appInstance.closed.then(() => session.close()).catch(reportCleanupFailure);
    session.watchdog = setInterval(() => {
      if (clock() >= expiresAt) { void session.close().catch(reportCleanupFailure); return; }
      void stopDisconnected(session).catch(reportCleanupFailure);
    }, Math.min(1000, disconnectGraceMs));
    session.watchdog.unref();
    sessionsByToken.set(token, session);
    sessionsByAccount.set(accountSession.accountId, session);

    return session;
  }

  function getAuthenticatedSession(req: http.IncomingMessage): ActiveSession | null {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.get('automate_session');
    if (!token) return null;

    const session = sessionsByToken.get(token);
    if (!session) return null;

    if (clock() >= session.expiresAt) {
      void session.close().catch(reportCleanupFailure);
      return null;
    }

    try {
      session.accountSession.assertActive();
    } catch {
      void session.close().catch(reportCleanupFailure);
      return null;
    }

    return session;
  }

  async function loadUiAsset(filename: string): Promise<string | null> {
    try {
      return await readFile(join(UI_DIR, filename), 'utf-8');
    } catch {
      return null;
    }
  }

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (isClosing) { res.writeHead(503); res.end(); return; }
    // Platform probes disclose no account state and cannot bypass app/auth host validation.
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(activePublicOrigin ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify({ status: activePublicOrigin ? 'ready' : 'initializing' }));
      return;
    }
    // 1. Two-phase bootstrap check: reject auth/app requests if tunnel origin is not activated yet
    if (!activePublicOrigin) {
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'SERVICE_INITIALIZING', message: 'Hosted server waiting for public tunnel activation' }));
      return;
    }

    // 2. Host header validation
    const reqHost = req.headers.host;
    const expectedUrl = new URL(activePublicOrigin);
    const expectedHost = expectedUrl.host;
    const isLoopbackSmoke =
      expectedUrl.hostname === '127.0.0.1' ||
      expectedUrl.hostname === 'localhost' ||
      expectedUrl.hostname === '[::1]';

    const boundAddress = server.address() as net.AddressInfo | null;
    const boundPortStr = boundAddress ? String(boundAddress.port) : '';


    const hostMatches =
      reqHost === expectedHost ||
      (isLoopbackSmoke &&
        (reqHost === `127.0.0.1:${boundPortStr}` || reqHost === `localhost:${boundPortStr}`));

    if (!reqHost || !hostMatches) {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Bad Request: Host header mismatch');
      return;
    }

    const method = req.method ?? 'GET';
    const parsedReqUrl = new URL(req.url ?? '/', activePublicOrigin);
    const pathname = parsedReqUrl.pathname;

    // Security headers for all responses
    const isHttps = activePublicOrigin.startsWith('https:');
    const baseHeaders: Record<string, string> = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
    };

    // 3. Mutating requests Origin and CSRF validation
    const isMutating = method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
    if (isMutating) {
      const originHeader = req.headers.origin;
      const refererHeader = req.headers.referer;

      let validOrigin = false;
      if (originHeader) {
        validOrigin = originHeader === activePublicOrigin;
      } else if (refererHeader) {
        try {
          validOrigin = new URL(refererHeader).origin === activePublicOrigin;
        } catch {
          validOrigin = false;
        }
      }

      if (!validOrigin) {
        res.writeHead(403, { ...baseHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'FORBIDDEN', message: 'Cross-origin request rejected' }));
        return;
      }
    }

    // 4. Route Handling

    // Static / Public assets
    if (method === 'GET' && pathname === '/owner-preview.css') {
      const content = await loadUiAsset('owner-preview.css');
      if (content !== null) {
        res.writeHead(200, { ...baseHeaders, 'Content-Type': 'text/css; charset=utf-8' });
        res.end(content);
      } else {
        res.writeHead(404, baseHeaders);
        res.end('Not Found');
      }
      return;
    }

    if (method === 'GET' && pathname === '/login') {
      const existing = getAuthenticatedSession(req);
      if (existing) {
        res.writeHead(302, { ...baseHeaders, Location: '/' });
        res.end();
        return;
      }
      const content = await loadUiAsset('hosted-login.html');
      if (content === null) { res.writeHead(503, baseHeaders); res.end('Required application asset unavailable'); return; }
      res.writeHead(200, { ...baseHeaders, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
      return;
    }

    if (method === 'GET' && pathname === '/hosted-login.js') {
      const content = await loadUiAsset('hosted-login.js');
      if (content === null) { res.writeHead(503, baseHeaders); res.end('Required application asset unavailable'); return; }
      res.writeHead(200, { ...baseHeaders, 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(content);
      return;
    }

    // POST /api/register
    if (method === 'POST' && pathname === '/api/register') {
      const clientIp = req.socket.remoteAddress ?? 'unknown';
      if (isRateLimited(clientIp)) {
        res.writeHead(429, { ...baseHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' }));
        return;
      }

      if (activeAuthOperations >= maxAuthConcurrency) {
        res.writeHead(429, { ...baseHeaders, 'Content-Type': 'application/json', 'Retry-After': '1' });
        res.end(JSON.stringify({ error: 'BUSY', message: 'Server auth busy. Retry shortly.' }));
        return;
      }

      activeAuthOperations++;
      try {
        const rawBody = await readRequestBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          res.writeHead(400, { ...baseHeaders, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'INVALID_JSON' }));
          return;
        }

        if (
          !parsed ||
          typeof parsed !== 'object' ||
          !('username' in parsed) ||
          !('key' in parsed) ||
          typeof parsed.username !== 'string' ||
          typeof parsed.key !== 'string'
        ) {
          res.writeHead(400, { ...baseHeaders, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'INVALID_INPUT', message: 'Missing username or key' }));
          return;
        }

        const username = parsed.username;
        const key = parsed.key;
        const regKey = typeof (parsed as Record<string, unknown>).registrationKey === 'string' ? (parsed as Record<string, unknown>).registrationKey as string : '';

        if (options.registrationKey && options.registrationKey.length > 0 && options.registrationKey !== 'none') {
          const providedBuf = Buffer.from(regKey);
          const expectedBuf = Buffer.from(options.registrationKey);
          if (
            providedBuf.length !== expectedBuf.length ||
            !crypto.timingSafeEqual(providedBuf, expectedBuf)
          ) {
            recordFailedAttempt(clientIp);
            res.writeHead(403, { ...baseHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'INVALID_REGISTRATION_KEY', message: 'Registration code rejected' }));
            return;
          }
        }

        let accountSession: HostedAccountSession;
        try {
          accountSession = await accountsStore.register(username, key, regKey);
        } catch (err: unknown) {
          recordFailedAttempt(clientIp);
          const msg = err instanceof Error ? err.message : 'Registration failed';
          const status = msg === 'ACCOUNT_ALREADY_EXISTS' ? 409 : 400;
          res.writeHead(status, { ...baseHeaders, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'REGISTRATION_FAILED', message: msg }));
          return;
        }

        let session: ActiveSession;
        try {
          session = await createSession(accountSession);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Session creation failed';
          const status = msg === 'SESSION_CAPACITY_REACHED' ? 429 : 503;
          res.writeHead(status, { ...baseHeaders, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'SESSION_FAILED', message: msg }));
          return;
        }

        resetFailedAttempts(clientIp);
        const cookie = `automate_session=${session.token}; Path=/; HttpOnly; SameSite=Strict${isHttps ? '; Secure' : ''}`;
        res.writeHead(200, {
          ...baseHeaders,
          'Set-Cookie': cookie,
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ username: session.username, csrfToken: session.csrfToken }));
      } finally {
        activeAuthOperations--;
      }
      return;
    }

    // POST /api/login
    if (method === 'POST' && pathname === '/api/login') {
      const clientIp = req.socket.remoteAddress ?? 'unknown';
      if (isRateLimited(clientIp)) {
        res.writeHead(429, { ...baseHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' }));
        return;
      }

      if (activeAuthOperations >= maxAuthConcurrency) {
        res.writeHead(429, { ...baseHeaders, 'Content-Type': 'application/json', 'Retry-After': '1' });
        res.end(JSON.stringify({ error: 'BUSY', message: 'Server auth busy. Retry shortly.' }));
        return;
      }

      activeAuthOperations++;
      try {
        const rawBody = await readRequestBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          res.writeHead(400, { ...baseHeaders, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'INVALID_JSON' }));
          return;
        }

        if (
          !parsed ||
          typeof parsed !== 'object' ||
          !('username' in parsed) ||
          !('key' in parsed) ||
          typeof parsed.username !== 'string' ||
          typeof parsed.key !== 'string'
        ) {
          res.writeHead(400, { ...baseHeaders, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'INVALID_INPUT', message: 'Missing username or key' }));
          return;
        }

        const username = parsed.username;
        const key = parsed.key;

        let accountSession: HostedAccountSession;
        try {
          accountSession = await accountsStore.unlock(username, key);
        } catch {
          recordFailedAttempt(clientIp);
          recordFailedAttempt(username);
          res.writeHead(401, { ...baseHeaders, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'AUTHENTICATION_FAILED', message: 'Invalid username or key' }));
          return;
        }

        let session: ActiveSession;
        try {
          session = await createSession(accountSession);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Session creation failed';
          const status = msg === 'SESSION_CAPACITY_REACHED' ? 429 : 503;
          res.writeHead(status, { ...baseHeaders, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'SESSION_FAILED', message: msg }));
          return;
        }

        resetFailedAttempts(clientIp);
        resetFailedAttempts(username);
        const cookie = `automate_session=${session.token}; Path=/; HttpOnly; SameSite=Strict${isHttps ? '; Secure' : ''}`;
        res.writeHead(200, {
          ...baseHeaders,
          'Set-Cookie': cookie,
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ username: session.username, csrfToken: session.csrfToken }));
      } finally {
        activeAuthOperations--;
      }
      return;
    }

    // Authenticated endpoints check
    const currentSession = getAuthenticatedSession(req);

    // Unauthenticated handling
    if (!currentSession) {
      if (pathname.startsWith('/api/')) {
        res.writeHead(401, { ...baseHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
        return;
      }
      // Redirect HTML requests to /login
      res.writeHead(302, { ...baseHeaders, Location: '/login' });
      res.end();
      return;
    }

    // GET /api/session
    if (method === 'GET' && pathname === '/api/session') {
      res.writeHead(200, { ...baseHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ username: currentSession.username, csrfToken: currentSession.csrfToken }));
      return;
    }

    // POST /api/logout
    if (method === 'POST' && pathname === '/api/logout') {
      const csrfHeader = req.headers['x-csrf-token'];
      if (!csrfHeader || csrfHeader !== currentSession.csrfToken) {
        res.writeHead(403, { ...baseHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'CSRF_INVALID' }));
        return;
      }

      await currentSession.close();
      const clearCookie = `automate_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict${isHttps ? '; Secure' : ''}`;
      res.writeHead(200, {
        ...baseHeaders,
        'Set-Cookie': clearCookie,
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/command
    if (method === 'POST' && pathname === '/api/command') {
      const csrfHeader = req.headers['x-csrf-token'];
      if (!csrfHeader || csrfHeader !== currentSession.csrfToken) {
        res.writeHead(403, { ...baseHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'CSRF_INVALID' }));
        return;
      }

      const rawBody = await readRequestBody(req);
      let parsedCommand: unknown;
      try {
        parsedCommand = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { ...baseHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'INVALID_JSON' }));
        return;
      }

      try {
        await currentSession.app.command(parsedCommand);
        res.writeHead(200, { ...baseHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Command failed';
        res.writeHead(500, { ...baseHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'COMMAND_FAILED', message: msg }));
      }
      return;
    }

    // Complete JSON responses work through QuickTunnel, which does not support SSE.
    if (method === 'GET' && pathname === '/api/updates') {
      const after = Number(parsedReqUrl.searchParams.get('after') ?? '0');
      if (!Number.isSafeInteger(after) || after < 0 || after > currentSession.sequence) {
        res.writeHead(400, { ...baseHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'INVALID_CURSOR' })); return;
      }
      await stopDisconnected(currentSession);
      currentSession.lastPollAt = clock();
      currentSession.disconnected = false;
      const pendingUpdates: { sequence: number; update: unknown }[] = [];
      if (currentSession.latestState && currentSession.stateSequence > after) pendingUpdates.push({ sequence: currentSession.stateSequence, update: currentSession.latestState });
      if (currentSession.latestFrame && currentSession.frameSequence > after) pendingUpdates.push({ sequence: currentSession.frameSequence, update: currentSession.latestFrame });
      pendingUpdates.sort((left, right) => left.sequence - right.sequence);
      res.writeHead(200, { ...baseHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sequence: currentSession.sequence, updates: pendingUpdates.map(item => item.update) }));
      return;
    }

    // Authenticated UI assets
    if (method === 'GET' && (pathname === '/' || pathname === '/autofill.html')) {
      const content = await loadUiAsset('autofill.html');
      if (content !== null) {
        res.writeHead(200, { ...baseHeaders, 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      } else {
        res.writeHead(404, baseHeaders);
        res.end('Not Found');
      }
      return;
    }

    if (method === 'GET' && pathname === '/autofill.js') {
      const content = await loadUiAsset('autofill.js');
      if (content !== null) {
        res.writeHead(200, { ...baseHeaders, 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end(content);
      } else {
        res.writeHead(404, baseHeaders);
        res.end('Not Found');
      }
      return;
    }

    if (method === 'GET' && pathname === '/autofill.css') {
      const content = await loadUiAsset('autofill.css');
      if (content !== null) {
        res.writeHead(200, { ...baseHeaders, 'Content-Type': 'text/css; charset=utf-8' });
        res.end(content);
      } else {
        res.writeHead(404, baseHeaders);
        res.end('Not Found');
      }
      return;
    }

    res.writeHead(404, baseHeaders);
    res.end('Not Found');
  }
  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof URIError ? 400 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify({ error: 'REQUEST_FAILED' }));
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 15_000;

  const { promise: listenPromise, resolve: listenResolve, reject: listenReject } = Promise.withResolvers<void>();
  const bindHost = options.host ?? (process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1'));
  server.listen(options.port ?? 0, bindHost, () => listenResolve());
  server.once('error', listenReject);
  await listenPromise;

  const boundAddress = server.address() as net.AddressInfo;
  const boundPort = boundAddress.port;

  return {
    get url() {
      return activePublicOrigin ?? `http://127.0.0.1:${boundPort}`;
    },
    port: boundPort,
    activatePublicOrigin(origin: string) {
      if (activePublicOrigin && options.publicOrigin) {
        throw new Error('PUBLIC_ORIGIN_ALREADY_ACTIVATED: Origin was already set at startup');
      }
      if (activePublicOrigin) {
        throw new Error('PUBLIC_ORIGIN_ALREADY_ACTIVATED: activatePublicOrigin is one-shot');
      }
      activePublicOrigin = validateOriginString(origin);
    },
    async close() {
      if (isClosing) return;
      isClosing = true;
      await creationQueue;

      // Close all user sessions
      const sessions = Array.from(sessionsByToken.values());
      for (const s of sessions) {
        void s.close().catch(reportCleanupFailure);
      }
      sessionsByToken.clear();
      sessionsByAccount.clear();

      let cleanupError: unknown;
      while (closingSessions.size > 0) {
        const batch = Array.from(closingSessions);
        const results = await Promise.allSettled(batch);
        for (const res of results) {
          if (res.status === 'rejected' && !cleanupError) {
            cleanupError = res.reason;
          }
        }
      }

      // Close shared viewer if owned
      if (ownViewer && sharedViewer) {
        try {
          await sharedViewer.close();
        } catch {}
      }

      // Close egress proxy if owned
      if (ownEgressProxy && egressProxy) {
        try {
          await egressProxy.close();
        } catch {}
      }

      // Close server
      const { promise: closePromise, resolve: closeResolve } = Promise.withResolvers<void>();
      server.close(() => closeResolve());
      await closePromise;

      if (cleanupError) {
        throw cleanupError;
      }
    },
  };
}
