import type { Browser, Page } from 'playwright';
import { PolicyBroker, PolicyError, httpsOrigin } from './policy';

export interface Registration {
  readonly origin: string;
  readonly path: string;
  readonly emailSelector: string;
  readonly passwordSelector: string;
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
  browser: Browser, policy: PolicyBroker, store: PasswordStore,
  task: string, grant: string, workflow: Registration, email: string,
  prepare?: (page: Page) => Promise<void>,
): Promise<WorkflowResult> {
  const origin = httpsOrigin(workflow.origin);
  const target = new URL(workflow.path, origin);
  if (target.origin !== origin) throw new PolicyError('INVALID_WORKFLOW');
  // No persistent profile, downloads, tracing, video or model-visible page reference.
  const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
  let saved = false;
  let password: string | undefined;
  try {
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
    // Enter protected mode BEFORE generating or inserting any sensitive data.
    policy.authorize(grant, task, origin, 'fill', 'registration-email');
    policy.authorize(grant, task, origin, 'fill', 'registration-password');
    const generated = await store.generateAndPersist(origin);
    password = generated.password;
    saved = true;
    // Revalidate after asynchronous native persistence (grant may have expired/revoked).
    policy.authorize(grant, task, origin, 'fill', 'registration-password');
    await page.evaluate(({ expectedOrigin, emailSelector, passwordSelector, emailValue, passwordValue }) => {
      if (location.origin !== expectedOrigin) throw new Error('DESTINATION_CHANGED');
      const emailField = document.querySelector(emailSelector);
      const passwordField = document.querySelector(passwordSelector);
      if (!(emailField instanceof HTMLInputElement) || !(passwordField instanceof HTMLInputElement) ||
        passwordField.type !== 'password' || emailField.disabled || passwordField.disabled)
        throw new Error('UNSUPPORTED_FORM');
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(emailField, emailValue);
      setValue.call(passwordField, passwordValue);
      emailField.dispatchEvent(new Event('input', { bubbles: true }));
      passwordField.dispatchEvent(new Event('input', { bubbles: true }));
    }, { expectedOrigin: origin, emailSelector: workflow.emailSelector, passwordSelector: workflow.passwordSelector, emailValue: email, passwordValue: password });
    password = undefined;
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
    return Object.freeze({ status: 'completed', credentialSaved: true });
  } catch {
    // No raw browser errors: they can contain page values and submitted data.
    if (['normal', 'protected'].includes(policy.state(task))) policy.finish(task, 'takeover');
    return Object.freeze({ status: 'takeover', credentialSaved: saved });
  } finally {
    password = undefined; // JS strings cannot be reliably zeroized; documented limitation.
    await context.close();
  }
}
