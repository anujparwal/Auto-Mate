import type { Browser, Page } from 'playwright';
import { PolicyBroker, PolicyError, httpsOrigin } from './policy';
import type { FieldRequest, WorkflowObserver } from './preview-contract';
import { verifyFieldRequests, fillVerifiedField } from './preview-capture';

export interface Registration {
  readonly origin: string;
  readonly path: string;
  readonly email: FieldRequest;
  readonly password: FieldRequest;
  readonly submitSelector: string;
  readonly successSelector: string;
}
/** Trusted native boundary. Never expose implementations or return values to model tools. */
export interface PasswordStore {
  generateAndPersist(origin: string): Promise<{ reference: string; password: string }>;
}
export type WorkflowResult = Readonly<{ status: 'completed' | 'takeover'; credentialSaved: boolean }>;

/** Only trusted, reviewed workflow definitions may be passed here. No model-authored selectors. */
export async function register(
  browser: Browser,
  policy: PolicyBroker,
  store: PasswordStore,
  task: string,
  grant: string,
  workflow: Registration,
  email: string,
  prepare?: (page: Page) => Promise<void>,
  observer?: WorkflowObserver,
): Promise<WorkflowResult> {
  const origin = httpsOrigin(workflow.origin);
  const target = new URL(workflow.path, origin);
  if (target.origin !== origin) throw new PolicyError('INVALID_WORKFLOW');
  if (
    !workflow.email ||
    !workflow.password ||
    workflow.email.credential !== 'registration-email' ||
    workflow.password.credential !== 'registration-password' ||
    workflow.email.id === workflow.password.id
  ) {
    throw new PolicyError('INVALID_WORKFLOW');
  }

  // Snapshot reviewed descriptors so asynchronous callbacks cannot relabel later fills.
  const requests: readonly FieldRequest[] = Object.freeze([
    Object.freeze({ ...workflow.email }), Object.freeze({ ...workflow.password }),
  ]);
  const checkCategories = () => {
    for (const request of requests) {
      if (policy.category(request.credential) !== request.category) throw new PolicyError('CATEGORY_MISMATCH');
    }
  };
  const authorizeFill = (request: FieldRequest) => {
    checkCategories();
    policy.authorize(grant, task, origin, 'fill', request.credential);
  };

  // No persistent profile, downloads, tracing, video or model-visible page reference.
  const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
  let saved = false;
  let password: string | undefined;
  try {
    checkCategories();
    await context.route('**/*', route => {
      const request = route.request();
      let allowed = false;
      try { allowed = new URL(request.url()).origin === origin; } catch { /* denied */ }
      return allowed ? route.continue() : route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('popup', popup => { void popup.close(); });
    if (prepare) await prepare(page); // Trusted integration fixture only; never an agent tool.
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 15000 });

    checkCategories();
    if (observer) await observer.requested(page, origin, requests);

    const verifiedFields = await verifyFieldRequests(page, origin, requests);
    const emailField = verifiedFields.find(f => f.request.credential === 'registration-email');
    const passwordField = verifiedFields.find(f => f.request.credential === 'registration-password');
    if (!emailField || !passwordField || verifiedFields.length !== 2) {
      throw new PolicyError('UNSUPPORTED_FORM');
    }

    checkCategories();
    if (observer) await observer.verified(page, origin, verifiedFields);

    // Enter protected mode BEFORE generating or inserting any sensitive data.
    authorizeFill(emailField.request);
    authorizeFill(passwordField.request);
    const generated = await store.generateAndPersist(origin);
    password = generated.password;
    saved = true;
    // Revalidate after asynchronous native persistence (grant may have expired/revoked).
    authorizeFill(passwordField.request);

    // Fill email
    if (observer) await observer.state('filling', emailField.request.id);
    authorizeFill(emailField.request);
    await fillVerifiedField(page, origin, emailField, email);
    if (observer) await observer.state('filled', emailField.request.id);

    // Fill password
    if (observer) await observer.state('filling', passwordField.request.id);
    authorizeFill(passwordField.request);
    await fillVerifiedField(page, origin, passwordField, password);
    password = undefined;
    if (observer) await observer.state('filled', passwordField.request.id);

    // Submission
    if (observer) await observer.state('submitting');
    checkCategories();
    policy.authorize(grant, task, origin, 'submit');
    await page.evaluate(({ expectedOrigin, selector }) => {
      if (location.origin !== expectedOrigin) throw new Error('DESTINATION_CHANGED');
      const button = document.querySelector(selector);
      if (!(button instanceof HTMLButtonElement) || button.disabled) throw new Error('UNSUPPORTED_SUBMIT');
      const form = button.form;
      if (!form || new URL(form.action, location.href).origin !== expectedOrigin || form.method.toLowerCase() !== 'post')
        throw new Error('UNSUPPORTED_FORM');
      button.click();
    }, { expectedOrigin: origin, selector: workflow.submitSelector });
    await page.locator(workflow.successSelector).waitFor({ state: 'visible', timeout: 10000 });
    if (new URL(page.url()).origin !== origin) throw new PolicyError('DESTINATION_CHANGED');
    policy.finish(task, 'completed');
    if (observer) await observer.state('completed');
    return Object.freeze({ status: 'completed', credentialSaved: true });
  } catch {
    // No raw browser errors: they can contain page values and submitted data.
    const isStopped = policy.state(task) === 'stopped';
    if (observer) {
      try {
        await observer.state(isStopped ? 'stopped' : 'takeover');
      } catch {
        /* safe ignore */
      }
    }
    if (['normal', 'protected'].includes(policy.state(task))) policy.finish(task, 'takeover');
    return Object.freeze({ status: 'takeover', credentialSaved: saved });
  } finally {
    password = undefined; // JS strings cannot be reliably zeroized; documented limitation.
    await context.close();
  }
}

