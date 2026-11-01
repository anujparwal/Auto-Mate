import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalAuditJournal } from './audit';
import { PolicyBroker, httpsOrigin, type Layer } from './policy';
import { AutofillSession } from './autofill';
import { WindowsAutofillVault } from './windows-vault';
import { parseVaultRecord } from './vault-record';
import { WindowsSessionProtection, type SessionProtection } from './windows-session';
import { AUTOFILL_FIELDS, type AutofillField, type AutofillVault, type VaultEntry, type VaultKind, type VaultRecord } from './autofill-contract';
import { InformationSession } from './information-session';
import { WindowsInformationVault } from './information-vault';
import { InformationPlanner } from './information-planner';
import { InformationFlow, type InformationOwnerState, type InformationPlanningClient } from './information-flow';
import type { InformationVariableInput, InformationVault } from './information-contract';

declare global {
  interface Window {
    autoMateAutofillUpdate: (data: unknown) => void;
    autoMateAutofill?: (command: unknown) => Promise<void>;
  }
}

const OWNER_ORIGIN = 'https://autofill-owner.auto-mate.invalid';
type Phase = 'idle' | 'inspecting' | 'review' | 'filling' | 'filled' | 'stopped' | 'failed';

export interface OwnerVaultState {
  readonly origin?: string;
  readonly entries: readonly VaultEntry[];
  readonly locked: boolean;
  readonly message: string;
  readonly error: string;
}

export interface AutofillAppField {
  readonly id: string;
  readonly name: string;
  readonly category: Layer;
  readonly sourceText: string;
  readonly association: string;
}

export interface AutofillAppState {
  readonly phase: Phase;
  readonly busy: boolean;
  readonly revision: number;
  readonly kind: VaultKind | 'information';
  readonly message: string;
  readonly error: string;
  readonly origin?: string;
  readonly url?: string;
  readonly fields: readonly AutofillAppField[];
  readonly vault: OwnerVaultState;
  readonly information?: InformationOwnerState;
}

export interface AutofillApp {
  readonly page: Page;
  readonly closed: Promise<void>;
  readonly auditPath: string;
  close(): Promise<void>;
}
export interface AutofillAppOptions {
  viewer?: Browser;
  vault?: AutofillVault;
  protection?: SessionProtection;
  auditDirectory?: string;
  informationVault?: InformationVault;
  informationPlanner?: InformationPlanningClient;
  /** Reviewed integration fixtures only; never accepted through owner/model commands. */
  prepareWebsite?: (page: Page) => Promise<void>;
}
function ownerError(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (code === 'VAULT_AUTHENTICATION_REQUIRED') return 'Windows Hello did not verify access. No further fields will be filled. Configure Hello and retry with a new inspection.';
  if (code === 'SESSION_UNAVAILABLE') return 'Workstation session protection is unavailable or inactive. Vault access is blocked; active website authority has been removed.';
  if (code === 'AUDIT_UNAVAILABLE') return 'Local audit unavailable. All execution is stopped; restart after restoring audit access.';
  if (code === 'INVALID_OWNER_COMMAND') return 'The request no longer matches this inspected website or its approved fields. Inspect again before trying a new disclosure.';
  if (code === 'INVALID_URL') return 'Enter an HTTPS page URL without embedded credentials or a fragment.';
  if (code === 'UNSUPPORTED_FORM') return 'No uniquely supported, visible, explicitly labelled fields were found for this record type. Embedded and ambiguous forms are not autofilled.';
  if (code === 'VERIFICATION_FAILED') return 'The requesting text and field relationship could not be verified. No vault data was read.';
  if (code === 'SETUP_FAILED') return 'The website could not be loaded under exact-origin HTTPS isolation. Off-origin redirects, unavailable resources, and browser/TLS failures are not bypassed.';
  if (code === 'INFORMATION_CATALOG_REQUIRED') return 'Authenticate and refresh the variable catalog before planning. Review its names and descriptions before sharing them.';
  if (code === 'INFORMATION_CONSENT_REQUIRED') return 'Explicitly consent before sending field labels and variable metadata to the configured model.';
  if (code === 'PLANNER_CONFIGURATION') return 'The model endpoint, model name, or API configuration is invalid. No model request was made.';
  if (code === 'PLANNER_UNAVAILABLE') return 'The configured model is unavailable. No values were sent and no automatic fallback was used.';
  if (code === 'PLANNER_INVALID_RESPONSE') return 'The model returned an invalid or unsafe field mapping. No disclosure was approved.';
  if (code === 'BROWSER_CLOSE_FAILED') return 'Browser closure could not be confirmed. Close the protected browser now; execution authority has been removed.';
  return 'Operation unavailable or unsupported. No further disclosure is permitted. Check the record type, record ID, and supported labelled fields, then inspect again.';
}
function vaultErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (code === 'VAULT_AUTHENTICATION_REQUIRED') return 'Windows Hello did not verify access. Authentication is required to unlock or modify the vault.';
  if (code === 'SESSION_UNAVAILABLE') return 'Workstation session protection is unavailable or inactive. Vault access is blocked.';
  return 'Vault operation failed. Verify workstation authentication and try again.';
}
function recordId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 320 || value.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('INVALID_OWNER_COMMAND');
  }
  return value;
}
function exactKeys(command: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(command).length !== keys.length || keys.some(key => !Object.hasOwn(command, key))) throw new Error('INVALID_OWNER_COMMAND');
}

/** Local authenticated-owner surface. No model bindings, remote preview listener, or secret-returning renderer APIs. */
export async function openAutofillApp(options: AutofillAppOptions = {}): Promise<AutofillApp> {
  const informationPlanner = options.informationPlanner ?? InformationPlanner.fromEnvironment();
  const directory = options.auditDirectory ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'AutoMate', 'audit') : undefined);
  if (!directory) throw new Error('AUDIT_UNAVAILABLE');
  const journal = new LocalAuditJournal(directory);
  const catalog = { ...Object.fromEntries(Object.entries(AUTOFILL_FIELDS).map(([field, definition]) => ['autofill:' + field, definition.category])),
    'information:value': 'red' as const };
  const policy = new PolicyBroker(catalog, journal.append);
  const vault = options.vault ?? new WindowsAutofillVault();
  let viewer: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let session: AutofillSession | InformationSession | undefined;
  let protection: SessionProtection | undefined;
  const information = new InformationFlow(options.informationVault ?? new WindowsInformationVault(), informationPlanner, () => {
    if (!protection) throw new Error('SESSION_UNAVAILABLE');
    protection.assertActive();
  });
  let inspection: AbortController | undefined;
  let phase: Phase = 'idle';
  let kind: VaultKind | 'information' = 'login';
  let vaultEntries: readonly VaultEntry[] = [];
  let vaultOrigin: string | undefined;
  let vaultLocked = true;
  let vaultMessage = '';
  let vaultError = '';
  let busy = false;
  let revision = 0;
  let message = '';
  let error = '';
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let pending: Promise<void> | undefined;
  let operation: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const closure = Promise.withResolvers<void>();

  async function publish(): Promise<void> {
    if (!page || closed || page.isClosed()) return;
    const current = session;
    const state: AutofillAppState = {
      phase,
      busy,
      revision,
      kind,
      message,
      error,
      origin: current?.origin,
      url: current?.url,
      fields: current instanceof InformationSession
        ? current.fields.map(candidate => ({ id: candidate.metadata.id, name: candidate.metadata.label, category: 'red',
          sourceText: candidate.verified.sourceText, association: candidate.verified.association }))
        : current?.fields.map(candidate => ({
          id: candidate.field, name: candidate.verified.request.name, category: candidate.verified.request.category,
          sourceText: candidate.verified.sourceText, association: candidate.verified.association,
        })) ?? [],
      vault: {
        origin: vaultOrigin,
        entries: vaultEntries,
        locked: vaultLocked,
        message: vaultMessage,
        error: vaultError,
      },
      information: kind === 'information' ? information.state : undefined,
    };
    await page.evaluate(data => {
      window.autoMateAutofillUpdate(data);
    }, { kind: 'state', state });
  }
  async function stop(denied = false): Promise<void> {
    revision++;
    inspection?.abort();
    information.clear();
    vaultLocked = true;
    vaultEntries = [];
    vaultOrigin = undefined;
    vaultMessage = '';
    const current = session;
    session = undefined;
    if (denied && current?.state === 'review') {
      try { policy.denyApproval(randomUUID(), current.origin); } catch { error = ownerError(new Error('AUDIT_UNAVAILABLE')); }
    }
    try { policy.stopAll(); } catch { error = ownerError(new Error('AUDIT_UNAVAILABLE')); }
    phase = 'stopped';
    message = denied ? 'Owner denied disclosure. The website is closing.' : 'Authority removed. The protected website is closing; prior disclosures cannot be undone.';
    await publish().catch(() => {});
    try { await current?.close(); }
    catch {
      error = 'Browser closure could not be confirmed. Close the protected browser now; execution authority has been revoked.';
      await publish().catch(() => {});
    }
  }
  function inactive(): void {
    vaultLocked = true;
    vaultEntries = [];
    vaultOrigin = undefined;
    vaultMessage = '';
    error = ownerError(new Error('SESSION_UNAVAILABLE'));
    void stop().catch(() => {});
  }
  async function capture(): Promise<void> {
    if (closed || !session || !['review', 'filling', 'filled'].includes(phase)) return;
    const current = session; const snapshot = revision;
    if (current.state === 'stopped' || current.state === 'failed') {
      if (current.error) error = ownerError(new Error(current.error));
      await stop(); return;
    }
    try {
      const frame = await current.capture();
      if (session !== current || snapshot !== revision || closed || !page || page.isClosed()) return;
      await page.evaluate(data => {
        window.autoMateAutofillUpdate(data);
      }, { kind: 'frame', frame, revision: snapshot });
    } catch {
      if (session !== current || snapshot !== revision || closed) return;
      error = 'The website or its verified evidence changed. Further autofill is stopped.';
      await stop();
    }
  }
  async function closeResources(): Promise<void> {
    if (closed) return;
    closed = true;
    inspection?.abort();
    information.clear();
    clearInterval(timer);
    vaultLocked = true;
    vaultEntries = [];
    vaultOrigin = undefined;
    let failed = false;
    try { policy.stopAll(); } catch { failed = true; }
    try { protection?.close(); } catch { failed = true; }
    try { await session?.close(); } catch { failed = true; }
    // Native operations already started must settle; a completed write cannot be rolled back.
    await operation?.catch(() => {});
    await pending?.catch(() => {});
    try { await context?.close(); } catch { failed = true; }
    if (!options.viewer) { try { await viewer?.close(); } catch { failed = true; } }
    try { journal.close(); } catch { failed = true; }
    closure.resolve();
    if (failed) throw new Error('AUTOFILL_CLEANUP_FAILED');
  }
  function close(): Promise<void> {
    closing ??= closeResources();
    return closing;
  }
  async function dispatch(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_OWNER_COMMAND');
    const command = raw as Record<string, unknown>;
    if (typeof command.action !== 'string' || !Number.isSafeInteger(command.revision)) throw new Error('INVALID_OWNER_COMMAND');
    if (command.action === 'stop') {
      exactKeys(command, ['action', 'revision']);
      await stop();
      return;
    }
    if (closed) throw new Error('INVALID_OWNER_COMMAND');
    if (command.action === 'vault-lock') {
      exactKeys(command, ['action', 'revision']);
      await stop();
      vaultMessage = 'Vault is locked. Active website authority has been removed.';
      vaultError = '';
      await publish();
      return;
    }
    if (busy || command.revision !== revision) throw new Error('INVALID_OWNER_COMMAND');
    busy = true;
    error = '';
    const snapshot = revision;
    try {
      if (command.action === 'inspect') {
        exactKeys(command, ['action', 'revision', 'url', 'kind']);
        if (typeof command.url !== 'string' || command.url.length > 2048 || !['login', 'card', 'information'].includes(command.kind as string)) throw new Error('INVALID_OWNER_COMMAND');
        const previous = session;
        session = undefined;
        inspection?.abort();
        information.clear();
        await previous?.close();
        if (closed || snapshot !== revision) return;
        revision++;
        vaultLocked = true;
        vaultEntries = [];
        vaultOrigin = undefined;
        vaultMessage = '';
        kind = command.kind as VaultKind | 'information';
        phase = 'inspecting';
        message = 'Loading the selected website without reading the vault.';
        const controller = new AbortController();
        inspection = controller;
        const inspectRevision = revision;
        await publish();
        const opened = kind === 'information'
          ? await InformationSession.open(viewer!, command.url, { signal: controller.signal, prepare: options.prepareWebsite })
          : await AutofillSession.open(viewer!, command.url, kind, { signal: controller.signal, prepare: options.prepareWebsite });
        if (closed || controller.signal.aborted || inspectRevision !== revision) { await opened.close(); return; }
        session = opened;
        if (opened instanceof InformationSession) information.attach(opened.origin, opened.fields.map(field => field.metadata));
        phase = 'review';
        message = 'Verify the exact destination and requesting text. Choose a record and explicitly check each field you approve.';
        void opened.closed.then(async () => {
          if (session !== opened || closed) return;
          session = undefined;
          revision++;
          information.clear();
          vaultLocked = true;
          vaultEntries = [];
          vaultOrigin = undefined;
          vaultMessage = '';
          phase = opened.state === 'failed' ? 'failed' : 'stopped';
          message = 'The protected website closed. Inspect again for a fresh authorization.';
          if (opened.error) error = ownerError(new Error(opened.error));
          await publish().catch(() => {});
        });
      } else if (command.action === 'vault-list') {
        exactKeys(command, ['action', 'revision', 'origin']);
        if (typeof command.origin !== 'string') throw new Error('INVALID_OWNER_COMMAND');
        let canonical: string;
        try {
          canonical = httpsOrigin(command.origin);
        } catch {
          throw new Error('INVALID_OWNER_COMMAND');
        }
        if (!protection) throw new Error('SESSION_UNAVAILABLE');
        try {
          protection.assertActive();
          vaultError = '';
          await publish();
          const listed = await vault.list(canonical);
          protection.assertActive();
          if (snapshot !== revision || closed) return;
          vaultEntries = listed.map(entry => Object.freeze({
            origin: entry.origin,
            recordId: entry.recordId,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
          }));
          vaultOrigin = canonical;
          vaultLocked = false;
          vaultMessage = 'Record identities are visible only in this owner window. Values remain hidden.';
          vaultError = '';
        } catch (vaultFault) {
          if (snapshot !== revision || closed) return;
          if (vaultFault instanceof Error && vaultFault.message === 'SESSION_UNAVAILABLE') {
            vaultLocked = true;
            vaultEntries = [];
            vaultOrigin = undefined;
            throw vaultFault;
          }
          vaultLocked = true;
          vaultEntries = [];
          vaultOrigin = undefined;
          vaultMessage = '';
          vaultError = vaultErrorMessage(vaultFault);
        }
      } else if (command.action === 'vault-save') {
        exactKeys(command, ['action', 'revision', 'origin', 'recordId', 'record']);
        if (typeof command.origin !== 'string') throw new Error('INVALID_OWNER_COMMAND');
        let canonical: string;
        try {
          canonical = httpsOrigin(command.origin);
        } catch {
          throw new Error('INVALID_OWNER_COMMAND');
        }
        const id = recordId(command.recordId);
        let record: VaultRecord;
        try {
          record = parseVaultRecord(command.record);
        } catch {
          throw new Error('INVALID_OWNER_COMMAND');
        }
        if (!protection) throw new Error('SESSION_UNAVAILABLE');
        try {
          protection.assertActive();
          vaultError = '';
          await publish();
          await vault.save(canonical, id, record);
          protection.assertActive();
          if (snapshot !== revision || closed) return;
          vaultMessage = 'The record was saved encrypted for this exact origin. No website field has been filled.';
          vaultError = '';
        } catch (vaultFault) {
          if (snapshot !== revision || closed) return;
          if (vaultFault instanceof Error && vaultFault.message === 'SESSION_UNAVAILABLE') {
            vaultLocked = true;
            vaultEntries = [];
            vaultOrigin = undefined;
            throw vaultFault;
          }
          vaultMessage = '';
          vaultError = vaultErrorMessage(vaultFault);
        }
      } else if (command.action === 'information-save') {
        exactKeys(command, ['action', 'revision', 'variable']);
        if (!command.variable || typeof command.variable !== 'object' || Array.isArray(command.variable)) throw new Error('INVALID_OWNER_COMMAND');
        const input = command.variable as Record<string, unknown>;
        exactKeys(input, ['name', 'description', 'value', 'kind', 'scope', 'origin']);
        if (Object.values(input).some(value => typeof value !== 'string')) throw new Error('INVALID_OWNER_COMMAND');
        await information.save(input as unknown as InformationVariableInput);
        if (snapshot !== revision || closed) return;
        vaultMessage = 'Named variable saved encrypted. Refresh the catalog to review its current name and description.';
        vaultError = '';
      } else if (command.action.startsWith('information-')) {
        const current = session;
        if (!(current instanceof InformationSession) || current.state !== 'review' || phase !== 'review') throw new Error('INVALID_OWNER_COMMAND');
        if (!protection) throw new Error('SESSION_UNAVAILABLE');
        protection.assertActive();
        if (command.action === 'information-catalog') {
          exactKeys(command, ['action', 'revision']);
          await current.capture();
          if (snapshot !== revision || session !== current || closed) return;
          await information.loadCatalog();
          message = 'Review all variable names and descriptions. Values remain hidden; credentials for another site cannot be used here.';
        } else if (command.action === 'information-plan') {
          exactKeys(command, ['action', 'revision', 'shareMetadata']);
          if (typeof command.shareMetadata !== 'boolean') throw new Error('INVALID_OWNER_COMMAND');
          await current.capture();
          if (snapshot !== revision || session !== current || closed) return;
          message = 'Planning field-to-variable links only. No saved or entered values are sent to the model.';
          await publish();
          await information.plan(command.shareMetadata);
          message = 'Supply any requested information locally, or skip a field. Then explicitly approve each disclosure; nothing is preselected.';
        } else if (command.action === 'information-provide') {
          exactKeys(command, ['action', 'revision', 'requestId', 'value', 'save']);
          if (typeof command.requestId !== 'string' || typeof command.value !== 'string') throw new Error('INVALID_OWNER_COMMAND');
          let save: { name: string; description: string; scope: 'profile' | 'site' } | null = null;
          if (command.save !== null) {
            if (!command.save || typeof command.save !== 'object' || Array.isArray(command.save)) throw new Error('INVALID_OWNER_COMMAND');
            const rawSave = command.save as Record<string, unknown>;
            exactKeys(rawSave, ['name', 'description', 'scope']);
            if (typeof rawSave.name !== 'string' || typeof rawSave.description !== 'string' || !['profile', 'site'].includes(rawSave.scope as string)) throw new Error('INVALID_OWNER_COMMAND');
            save = rawSave as unknown as typeof save;
          }
          await information.provide(command.requestId, command.value, save);
        } else if (command.action === 'information-skip') {
          exactKeys(command, ['action', 'revision', 'requestId']);
          if (typeof command.requestId !== 'string') throw new Error('INVALID_OWNER_COMMAND');
          information.skip(command.requestId);
        } else if (command.action === 'information-request') {
          exactKeys(command, ['action', 'revision', 'fieldId']);
          if (typeof command.fieldId !== 'string') throw new Error('INVALID_OWNER_COMMAND');
          information.request(command.fieldId);
        } else if (command.action === 'information-choose') {
          exactKeys(command, ['action', 'revision', 'fieldId', 'variableId']);
          if (typeof command.fieldId !== 'string' || typeof command.variableId !== 'string') throw new Error('INVALID_OWNER_COMMAND');
          information.choose(command.fieldId, command.variableId);
        } else if (command.action === 'information-fill') {
          exactKeys(command, ['action', 'revision', 'fields', 'durationSeconds']);
          if (!Array.isArray(command.fields) || !command.fields.length || command.fields.some(field => typeof field !== 'string' || !information.ready(field)) ||
              new Set(command.fields).size !== command.fields.length || ![60, 300, 900].includes(command.durationSeconds as number)) throw new Error('INVALID_OWNER_COMMAND');
          await current.capture();
          if (snapshot !== revision || session !== current || closed) return;
          protection.assertActive();
          const task = randomUUID();
          const grant = policy.approve({ task, origin: current.origin, credentials: ['information:value'], layers: ['red'],
            operations: ['fill'], durationSeconds: command.durationSeconds as number, maxSubmissions: 0 });
          phase = 'filling'; message = 'Authenticating and rechecking only your explicitly approved fields.';
          await publish();
          try { await current.fill(policy, task, grant, command.fields as string[], field => information.value(field)); }
          finally { information.forgetEnteredValues(); }
          if (snapshot !== revision || session !== current || closed) return;
          const sessionState = current.state as string;
          phase = sessionState === 'filled' ? 'filled' : sessionState === 'stopped' ? 'stopped' : 'failed';
          if (current.error) error = ownerError(new Error(current.error));
          message = phase === 'filled' ? 'Approved fields filled. The app has not submitted the form or created an account. Review the protected browser.' : 'No further fields will be filled. Inspect again for fresh approval.';
        } else throw new Error('INVALID_OWNER_COMMAND');
      } else {
        const current = session;
        if (!current || (current.state !== 'review' && command.action !== 'deny')) throw new Error('INVALID_OWNER_COMMAND');
        if (command.action === 'deny') {
          exactKeys(command, ['action', 'revision']);
          await stop(true);
          return;
        }
        if (!protection) throw new Error('SESSION_UNAVAILABLE');
        protection.assertActive();
        if (command.action === 'fill') {
          if (!(current instanceof AutofillSession) || kind === 'information') throw new Error('INVALID_OWNER_COMMAND');
          exactKeys(command, ['action', 'revision', 'recordId', 'fields', 'durationSeconds']);
          const id = recordId(command.recordId);
          if (!Array.isArray(command.fields) || !command.fields.length || command.fields.some(field => typeof field !== 'string') ||
              new Set(command.fields).size !== command.fields.length || ![60, 300, 900].includes(command.durationSeconds as number)) throw new Error('INVALID_OWNER_COMMAND');
          const selected = command.fields as AutofillField[];
          const candidates = selected.map(field => current.fields.find(candidate => candidate.field === field));
          if (candidates.some(candidate => !candidate)) throw new Error('INVALID_OWNER_COMMAND');
          const credentials = candidates.map(candidate => candidate!.verified.request.credential);
          const layers = [...new Set(candidates.map(candidate => candidate!.verified.request.category))];
          await current.capture();
          protection.assertActive();
          if (session !== current || snapshot !== revision || closed) return;
          const task = randomUUID();
          const grant = policy.approve({ task, origin: current.origin, credentials, layers, operations: ['fill'],
            durationSeconds: command.durationSeconds as number, maxSubmissions: 0 });
          phase = 'filling';
          message = 'Approved fields only. Waiting for Windows Hello and rechecking evidence before disclosure.';
          await publish();
          const protectedVault: AutofillVault = {
            list: origin => vault.list(origin),
            save: (origin, recordId, record) => vault.save(origin, recordId, record),
            read: async (origin, recordId, requestedKind) => {
              protection!.assertActive();
              const record = await vault.read(origin, recordId, requestedKind);
              protection!.assertActive();
              return record;
            },
          };
          const result = await current.fill(policy, grant, task, protectedVault, id, kind, selected);
          if (session !== current || snapshot !== revision || closed) return;
          phase = result === 'filled' ? 'filled' : result === 'stopped' ? 'stopped' : 'failed';
          if (current.error) error = ownerError(new Error(current.error));
          message = result === 'filled' ? 'Selected fields filled. Review the protected browser; the app has not clicked any submit or payment control. Stop or close when finished.' : 'No further fields will be filled. Inspect again before retrying.';
        } else throw new Error('INVALID_OWNER_COMMAND');
      }
    } finally {
      busy = false;
      await publish().catch(() => {});
    }
  }
  try {
    viewer = options.viewer ?? await chromium.launch({ headless: false });
    protection = options.protection ?? await WindowsSessionProtection.open(inactive);
    context = await viewer.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: false, serviceWorkers: 'block' });
    const assets = new Map<string, { contentType: string; body: string }>();
    for (const [path, file, contentType] of [
      ['/', 'autofill.html', 'text/html; charset=utf-8'], ['/autofill.js', 'autofill.js', 'text/javascript; charset=utf-8'],
      ['/autofill.css', 'autofill.css', 'text/css; charset=utf-8'], ['/owner-preview.css', 'owner-preview.css', 'text/css; charset=utf-8'],
    ] as const) assets.set(path, { body: await Bun.file(new URL('../ui/' + file, import.meta.url)).text(), contentType });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url()); const asset = url.origin === OWNER_ORIGIN ? assets.get(url.pathname) : undefined;
      if (!asset || route.request().method() !== 'GET') { await route.abort('blockedbyclient'); return; }
      await route.fulfill({ ...asset, headers: {
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      } });
    });
    page = await context.newPage();
    await page.exposeBinding('autoMateAutofill', async (source, raw: unknown) => {
      if (source.page !== page || source.frame !== page!.mainFrame() || new URL(page!.url()).origin !== OWNER_ORIGIN) throw new Error('INVALID_OWNER_COMMAND');
      // Rejected concurrent requests must not replace the operation awaited by shutdown.
      const isInterrupt = raw !== null && typeof raw === 'object' && 'action' in raw && (raw.action === 'stop' || raw.action === 'vault-lock');
      if (busy && !isInterrupt) return;
      const running = dispatch(raw).catch(async fault => {
        error = ownerError(fault);
        if ((fault instanceof Error && ['AUDIT_UNAVAILABLE', 'SESSION_UNAVAILABLE'].includes(fault.message)) || phase === 'filling') await stop();
        if (phase === 'inspecting') phase = 'failed';
        await publish().catch(() => {});
      });
      if (!isInterrupt) operation = running;
      await running;
      if (operation === running) operation = undefined;
    });
    page.on('popup', popup => { void popup.close(); });
    page.on('close', () => { void close().catch(() => {}); });
    await page.goto(OWNER_ORIGIN, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.autoMateAutofillUpdate === 'function');
    await publish();
    timer = setInterval(() => { if (!pending) { pending = capture().finally(() => { pending = undefined; }); void pending.catch(() => {}); } }, 500);
    timer.unref();
    return { page, closed: closure.promise, auditPath: journal.path, close };
  } catch { await close(); throw new Error('AUTOFILL_APP_UNAVAILABLE'); }
}
