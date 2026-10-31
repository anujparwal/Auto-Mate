import { describe, expect, test } from 'bun:test';
import { PolicyBroker, httpsOrigin, type Layer, type AuditSink, type Audit } from '../src/policy';

const noopSink: AuditSink = () => {};

const defaultCatalog = (): Record<string, Layer> => ({
  'registration-email': 'yellow',
  'registration-password': 'red',
});

const request = () => ({
  task: 'signup',
  origin: 'https://accounts.example.test',
  credentials: ['registration-email', 'registration-password'],
  layers: ['yellow', 'red'] as Layer[],
  operations: ['fill', 'submit'] as const,
  durationSeconds: 60,
  maxSubmissions: 1,
});

describe('authorization boundary', () => {
  test('binds credential, exact origin and task, then prevents observation', () => {
    const broker = new PolicyBroker(defaultCatalog(), noopSink);
    const grant = broker.approve(request());
    expect(() => broker.authorize(grant, 'other', request().origin, 'fill', 'registration-email')).toThrow('INVALID_GRANT');
    expect(() => broker.authorize(grant, 'signup', 'https://accounts.example.test.evil.test', 'fill', 'registration-email')).toThrow('DESTINATION_DENIED');
    expect(() => broker.authorize(grant, 'signup', request().origin, 'fill', 'bank-card')).toThrow('CREDENTIAL_DENIED');
    expect(broker.canObserve('signup')).toBe(true);
    broker.authorize(grant, 'signup', request().origin, 'fill', 'registration-email');
    expect(broker.canObserve('signup')).toBe(false);
    broker.authorize(grant, 'signup', request().origin, 'submit');
    expect(() => broker.authorize(grant, 'signup', request().origin, 'submit')).toThrow('SUBMISSION_LIMIT');
    broker.finish('signup', 'completed');
    expect(broker.canObserve('signup')).toBe(false);
    expect(() => broker.authorize(grant, 'signup', request().origin, 'fill', 'registration-email')).toThrow('TASK_NOT_ACTIVE');
  });

  test('rechecks expiry at execution, including exact deadline', () => {
    let now = 0;
    const broker = new PolicyBroker(defaultCatalog(), noopSink, () => now);
    try {
      const grant = broker.approve(request());
      now = 60000;
      expect(() => broker.authorize(grant, 'signup', request().origin, 'fill', 'registration-email')).toThrow('GRANT_EXPIRED');
      expect(broker.state('signup')).toBe('stopped');
      const last = broker.audit().at(-1);
      expect(last?.event).toBe('grant_expired');
      expect(last?.reason).toBe('GRANT_EXPIRED');
    } finally {
      broker.stopAll();
    }
  });

  test('block and stop revoke existing authority', () => {
    const broker = new PolicyBroker(defaultCatalog(), noopSink);
    const grant = broker.approve(request());
    broker.block(request().origin);
    expect(broker.state('signup')).toBe('stopped');
    expect(() => broker.authorize(grant, 'signup', request().origin, 'fill', 'registration-email')).toThrow('INVALID_GRANT');
    expect(() => broker.approve({ ...request(), task: 'new' })).toThrow('DESTINATION_BLOCKED');
    const other = broker.approve({ ...request(), task: 'other', origin: 'https://other.example.test' });
    broker.stopAll();
    expect(() => broker.authorize(other, 'other', 'https://other.example.test', 'submit')).toThrow('INVALID_GRANT');
  });

  test('caller cannot broaden approved grant by mutating input', () => {
    const credentials = ['registration-email'];
    const layers: Layer[] = ['yellow'];
    const broker = new PolicyBroker(defaultCatalog(), noopSink);
    const grant = broker.approve({ ...request(), credentials, layers });
    credentials.push('bank-card');
    expect(() => broker.authorize(grant, 'signup', request().origin, 'fill', 'bank-card')).toThrow('CREDENTIAL_DENIED');
  });

  test('rejects ambiguous destination strings', () => {
    for (const value of ['http://example.test', 'https://user:pass@example.test', 'https://example.test/path', 'https://example.test/?secret=x', 'javascript:alert(1)']) {
      expect(() => httpsOrigin(value)).toThrow('INVALID_ORIGIN');
    }
  });

  test('rejects approval when credential category is outside approved layers', () => {
    const broker = new PolicyBroker(defaultCatalog(), noopSink);
    expect(() =>
      broker.approve({
        ...request(),
        credentials: ['registration-email', 'registration-password'],
        layers: ['yellow'],
      }),
    ).toThrow('CATEGORY_DENIED');
  });

  test('rejects unknown credential references at approval, query, and reassignment', () => {
    const broker = new PolicyBroker({ 'known-token': 'yellow' }, noopSink);
    expect(() => broker.category('missing-token')).toThrow('CREDENTIAL_DENIED');
    expect(() => broker.setCredentialLayer('missing-token', 'orange')).toThrow('CREDENTIAL_DENIED');
    expect(() =>
      broker.approve({
        ...request(),
        credentials: ['missing-token'],
        layers: ['yellow'],
      }),
    ).toThrow('CREDENTIAL_DENIED');
  });

  test('enforces explicit nonhierarchical layers with no implicit inclusion', () => {
    const broker = new PolicyBroker({
      'item-yellow': 'yellow',
      'item-orange': 'orange',
      'item-red': 'red',
    }, noopSink);

    expect(() =>
      broker.approve({
        ...request(),
        credentials: ['item-yellow'],
        layers: ['red'],
      }),
    ).toThrow('CATEGORY_DENIED');

    expect(() =>
      broker.approve({
        ...request(),
        credentials: ['item-orange'],
        layers: ['red'],
      }),
    ).toThrow('CATEGORY_DENIED');

    expect(() =>
      broker.approve({
        ...request(),
        credentials: ['item-red'],
        layers: ['yellow', 'orange'],
      }),
    ).toThrow('CATEGORY_DENIED');

    const grantRed = broker.approve({
      ...request(),
      task: 'red-only',
      credentials: ['item-red'],
      layers: ['red'],
    });
    broker.authorize(grantRed, 'red-only', request().origin, 'fill', 'item-red');
    expect(broker.state('red-only')).toBe('protected');
  });

  test('supports trusted-owner Orange custom reassignment and subsequent approval', () => {
    const broker = new PolicyBroker({ 'custom-token': 'yellow' }, noopSink);
    expect(broker.category('custom-token')).toBe('yellow');

    broker.setCredentialLayer('custom-token', 'orange');
    expect(broker.category('custom-token')).toBe('orange');

    expect(() =>
      broker.approve({
        ...request(),
        task: 'under-yellow',
        credentials: ['custom-token'],
        layers: ['yellow'],
      }),
    ).toThrow('CATEGORY_DENIED');

    const grant = broker.approve({
      ...request(),
      task: 'under-orange',
      credentials: ['custom-token'],
      layers: ['orange'],
    });

    broker.setCredentialLayer('custom-token', 'orange');
    expect(broker.state('under-orange')).toBe('normal');
    broker.authorize(grant, 'under-orange', request().origin, 'fill', 'custom-token');
    expect(broker.state('under-orange')).toBe('protected');
  });

  test('invalidates only affected grants when a credential layer changes', () => {
    const broker = new PolicyBroker({
      'cred-primary': 'yellow',
      'cred-secondary': 'orange',
    }, noopSink);
    const grantA = broker.approve({
      ...request(),
      task: 'task-primary',
      credentials: ['cred-primary'],
      layers: ['yellow'],
    });
    const grantB = broker.approve({
      ...request(),
      task: 'task-secondary',
      credentials: ['cred-secondary'],
      layers: ['orange'],
    });

    broker.setCredentialLayer('cred-primary', 'red');

    expect(broker.state('task-primary')).toBe('stopped');
    expect(() => broker.authorize(grantA, 'task-primary', request().origin, 'fill', 'cred-primary')).toThrow('INVALID_GRANT');

    expect(broker.state('task-secondary')).toBe('normal');
    broker.authorize(grantB, 'task-secondary', request().origin, 'fill', 'cred-secondary');
    expect(broker.state('task-secondary')).toBe('protected');
  });

  test('caller catalog changes cannot downgrade a credential or register new authority', () => {
    const catalog: Record<string, Layer> = { 'session-key': 'red' };
    const broker = new PolicyBroker(catalog, noopSink);
    catalog['session-key'] = 'yellow';
    catalog['injected-key'] = 'yellow';
    expect(() => broker.approve({ ...request(), credentials: ['session-key'], layers: ['yellow'] })).toThrow('CATEGORY_DENIED');
    expect(() => broker.approve({ ...request(), credentials: ['injected-key'], layers: ['yellow'] })).toThrow('CREDENTIAL_DENIED');
    const grant = broker.approve({ ...request(), credentials: ['session-key'], layers: ['red'] });
    broker.authorize(grant, 'signup', request().origin, 'fill', 'session-key');
    expect(broker.state('signup')).toBe('protected');
  });

  test('rejects invalid runtime category inputs in catalog, setter, and grant request', () => {
    expect(() => new PolicyBroker(null as unknown as Record<string, Layer>, noopSink)).toThrow('INVALID_CATALOG');
    expect(() => new PolicyBroker({ '': 'yellow' } as unknown as Record<string, Layer>, noopSink)).toThrow('INVALID_CATALOG');
    expect(() => new PolicyBroker({ 'cred': 'blue' as unknown as Layer }, noopSink)).toThrow('INVALID_LAYER');
    expect(() => new PolicyBroker({ 'cred': 'constructor' as unknown as Layer }, noopSink)).toThrow('INVALID_LAYER');
    expect(() => new PolicyBroker({ 'cred': 'yellow' }, null as unknown as AuditSink)).toThrow('INVALID_SINK');

    const broker = new PolicyBroker({ 'cred': 'yellow' }, noopSink);

    expect(() => broker.setCredentialLayer('cred', 'purple' as unknown as Layer)).toThrow('INVALID_LAYER');
    expect(() => broker.setCredentialLayer('cred', '' as unknown as Layer)).toThrow('INVALID_LAYER');

    expect(() => broker.approve({ ...request(), layers: ['invalid-layer' as unknown as Layer] })).toThrow('INVALID_GRANT');
    expect(() => broker.approve({ ...request(), layers: [] })).toThrow('INVALID_GRANT');
  });

  test('rechecks category scope on submit and prevents bypass', () => {
    const broker = new PolicyBroker({
      'registration-email': 'yellow',
      'registration-password': 'red',
    }, noopSink);

    expect(() =>
      broker.approve({
        ...request(),
        credentials: ['registration-email', 'registration-password'],
        layers: ['yellow'],
        operations: ['submit'],
      }),
    ).toThrow('CATEGORY_DENIED');

    const grant = broker.approve({
      ...request(),
      credentials: ['registration-email', 'registration-password'],
      layers: ['yellow', 'red'],
      operations: ['submit'],
    });
    broker.authorize(grant, 'signup', request().origin, 'submit');
    expect(broker.state('signup')).toBe('protected');
    broker.setCredentialLayer('registration-password', 'orange');
    expect(() => broker.authorize(grant, 'signup', request().origin, 'submit')).toThrow('INVALID_GRANT');
  });

  test('ensures failed approval does not consume task name', () => {
    const broker = new PolicyBroker({ 'registration-email': 'yellow' }, noopSink);

    expect(() =>
      broker.approve({
        ...request(),
        task: 'retryable-signup',
        credentials: ['registration-email'],
        layers: ['red'],
      }),
    ).toThrow('CATEGORY_DENIED');

    expect(() =>
      broker.approve({
        ...request(),
        task: 'retryable-signup',
        credentials: ['unknown-cred'],
        layers: ['yellow'],
      }),
    ).toThrow('CREDENTIAL_DENIED');

    const grant = broker.approve({
      ...request(),
      task: 'retryable-signup',
      credentials: ['registration-email'],
      layers: ['yellow'],
    });
    broker.authorize(grant, 'retryable-signup', request().origin, 'fill', 'registration-email');
    expect(broker.state('retryable-signup')).toBe('protected');

    expect(() =>
      broker.approve({
        ...request(),
        task: 'retryable-signup',
        credentials: ['registration-email'],
        layers: ['yellow'],
      }),
    ).toThrow('TASK_ALREADY_EXISTS');
  });

  test('audit events omit credentials, layer mappings, and secrets', () => {
    const broker = new PolicyBroker({ 'secret-api-token': 'red' }, noopSink);
    const grant = broker.approve({
      ...request(),
      task: 'audit-privacy',
      credentials: ['secret-api-token'],
      layers: ['red'],
    });
    broker.authorize(grant, 'audit-privacy', request().origin, 'fill', 'secret-api-token');
    broker.setCredentialLayer('secret-api-token', 'orange');

    const records = broker.audit();
    for (const record of records) {
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain('secret-api-token');
      expect(serialized).not.toContain('red');
      expect(serialized).not.toContain('orange');
    }
  });

  test('denyApproval validates origin and task, records denial and marks stopped without grant', () => {
    const events: Audit[] = [];
    const broker = new PolicyBroker(defaultCatalog(), (e) => { events.push(e); });

    expect(() => broker.denyApproval('', 'https://accounts.example.test')).toThrow('INVALID_TASK');
    expect(() => broker.denyApproval('denied-task', 'http://insecure.test')).toThrow('INVALID_ORIGIN');

    broker.denyApproval('denied-task', 'https://accounts.example.test');
    expect(broker.state('denied-task')).toBe('stopped');
    expect(broker.canObserve('denied-task')).toBe(false);

    expect(events.length).toBe(1);
    expect(events[0]!.event).toBe('approval_denied');
    expect(events[0]!.task).toBe('denied-task');
    expect(events[0]!.origin).toBe('https://accounts.example.test');

    expect(() => broker.denyApproval('denied-task', 'https://accounts.example.test')).toThrow('TASK_ALREADY_EXISTS');
    expect(() => broker.approve({ ...request(), task: 'denied-task' })).toThrow('TASK_ALREADY_EXISTS');
  });


  test('sink failure during denial logging does not loop recursively and faults broker', () => {
    let failSink = false;
    const broker = new PolicyBroker(defaultCatalog(), () => {
      if (failSink) throw new Error('journal full');
    });

    const grant = broker.approve(request());
    failSink = true;

    expect(() => broker.authorize(grant, 'signup', 'https://evil.example.test', 'fill', 'registration-email')).toThrow('AUDIT_UNAVAILABLE');
    expect(broker.state('signup')).toBe('stopped');
  });

  test('async sink rejection is consumed while permanently faulting the broker', async () => {
    const asyncSink = async () => { throw new Error('private filesystem diagnostics'); };
    const broker = new PolicyBroker(defaultCatalog(), asyncSink as unknown as AuditSink);

    expect(() => broker.approve(request())).toThrow('AUDIT_UNAVAILABLE');
    expect(broker.canObserve('signup')).toBe(false);
    await Promise.resolve();
    expect(() => broker.approve({ ...request(), task: 'later' })).toThrow('AUDIT_UNAVAILABLE');
  });

  test('non-undefined sink return is rejected and permanently faults broker', () => {
    const badSink = () => 42;
    const broker = new PolicyBroker(defaultCatalog(), badSink as unknown as AuditSink);

    expect(() => broker.approve(request())).toThrow('AUDIT_UNAVAILABLE');
  });

  test.each(['revoke', 'stopAll'] as const)('%s revokes authority even if logging fails', operation => {
    let failRevoke = false;
    const broker = new PolicyBroker(defaultCatalog(), (e) => {
      if (failRevoke && (e.event === 'revoked' || e.event === 'stopped_all')) {
        throw new Error('disk detached');
      }
    });

    const grant = broker.approve(request());
    failRevoke = true;

    expect(() => operation === 'revoke' ? broker.revoke(grant) : broker.stopAll()).toThrow('AUDIT_UNAVAILABLE');
    expect(broker.state('signup')).toBe('stopped');
    expect(() => broker.authorize(grant, 'signup', request().origin, 'fill', 'registration-email')).toThrow('AUDIT_UNAVAILABLE');
  });

  test('executionSignal validates binding and returns stable signal without granting authority or exposing secrets', () => {
    const broker = new PolicyBroker(defaultCatalog(), noopSink);
    try {
      const grant = broker.approve(request());
      expect(() => broker.executionSignal('unknown-handle', 'signup')).toThrow('INVALID_GRANT');
      expect(() => broker.executionSignal(grant, 'other-task')).toThrow('INVALID_GRANT');
      expect(() => broker.executionSignal('', 'signup')).toThrow('INVALID_GRANT');
      expect(() => broker.executionSignal(grant, '')).toThrow('INVALID_GRANT');

      const signal1 = broker.executionSignal(grant, 'signup');
      const signal2 = broker.executionSignal(grant, 'signup');
      expect(signal1).toBe(signal2);
      expect(signal1.aborted).toBe(false);

      expect(broker.canObserve('signup')).toBe(true);
      expect(broker.state('signup')).toBe('normal');
      const events = broker.audit();
      expect(events.some(e => e.event === 'fill_authorized' || e.event === 'submit_authorized')).toBe(false);
    } finally {
      broker.stopAll();
    }
  });

  test('aborts only affected grants on credential reclassification, destination block, and revoke', () => {
    const catalog: Record<string, Layer> = {
      'email-cred': 'yellow',
      'pwd-cred': 'red',
      'pin-cred': 'orange',
    };
    const broker = new PolicyBroker(catalog, noopSink);
    try {
      const grantPwd = broker.approve({
        ...request(),
        task: 'task-pwd',
        origin: 'https://site-a.example.test',
        credentials: ['pwd-cred'],
        layers: ['red'],
      });
      const grantEmail = broker.approve({
        ...request(),
        task: 'task-email',
        origin: 'https://site-b.example.test',
        credentials: ['email-cred'],
        layers: ['yellow'],
      });
      const grantPin = broker.approve({
        ...request(),
        task: 'task-pin',
        origin: 'https://site-c.example.test',
        credentials: ['pin-cred'],
        layers: ['orange'],
      });

      const signalPwd = broker.executionSignal(grantPwd, 'task-pwd');
      const signalEmail = broker.executionSignal(grantEmail, 'task-email');
      const signalPin = broker.executionSignal(grantPin, 'task-pin');

      broker.setCredentialLayer('pwd-cred', 'orange');
      expect(signalPwd.aborted).toBe(true);
      expect(signalEmail.aborted).toBe(false);
      expect(signalPin.aborted).toBe(false);
      expect(broker.state('task-pwd')).toBe('stopped');
      expect(broker.state('task-email')).toBe('normal');

      broker.block('https://site-b.example.test');
      expect(signalEmail.aborted).toBe(true);
      expect(signalPin.aborted).toBe(false);
      expect(broker.state('task-email')).toBe('stopped');
      expect(broker.state('task-pin')).toBe('normal');

      broker.revoke(grantPin);
      expect(signalPin.aborted).toBe(true);
      expect(broker.state('task-pin')).toBe('stopped');
    } finally {
      broker.stopAll();
    }
  });

  test('stopAll and audit fault globally abort active signals with reentrancy safety', () => {
    let reentrantApproved = '';
    let reentrantAuthorizeThrew = false;

    const broker = new PolicyBroker(defaultCatalog(), noopSink);
    try {
      const grant1 = broker.approve({ ...request(), task: 'task-1' });
      const grant2 = broker.approve({ ...request(), task: 'task-2' });

      const signal1 = broker.executionSignal(grant1, 'task-1');
      const signal2 = broker.executionSignal(grant2, 'task-2');

      signal1.addEventListener('abort', () => {
        try {
          broker.authorize(grant1, 'task-1', request().origin, 'fill', 'registration-email');
        } catch {
          reentrantAuthorizeThrew = true;
        }
        reentrantApproved = broker.approve({ ...request(), task: 'task-reentrant' });
      });

      broker.stopAll();

      expect(signal1.aborted).toBe(true);
      expect(signal2.aborted).toBe(true);
      expect(broker.state('task-1')).toBe('stopped');
      expect(broker.state('task-2')).toBe('stopped');
      expect(reentrantAuthorizeThrew).toBe(true);
      expect(reentrantApproved).not.toBe('');
      expect(broker.state('task-reentrant')).toBe('normal');
      const signalReentrant = broker.executionSignal(reentrantApproved, 'task-reentrant');
      expect(signalReentrant.aborted).toBe(false);

      let failSink = false;
      const faultBroker = new PolicyBroker(defaultCatalog(), () => {
        if (failSink) throw new Error('disk full');
      });
      try {
        const faultGrant = faultBroker.approve({ ...request(), task: 'fault-task' });
        const faultSignal = faultBroker.executionSignal(faultGrant, 'fault-task');
        failSink = true;
        expect(() => faultBroker.authorize(faultGrant, 'fault-task', 'https://bad.test', 'fill', 'registration-email')).toThrow('AUDIT_UNAVAILABLE');
        expect(faultSignal.aborted).toBe(true);
        expect(faultBroker.state('fault-task')).toBe('stopped');
        expect(() => faultBroker.executionSignal(faultGrant, 'fault-task')).toThrow('AUDIT_UNAVAILABLE');
      } finally {
        faultBroker.stopAll();
      }
    } finally {
      broker.stopAll();
    }
  });

  // Deliberately exercises real 1-second scheduled expiry against platform clock per spec
  test('real scheduled expiry with 1-second duration aborts signal and logs event', async () => {
    const broker = new PolicyBroker(defaultCatalog(), noopSink);
    try {
      const grant = broker.approve({ ...request(), durationSeconds: 1 });
      const signal = broker.executionSignal(grant, 'signup');
      expect(signal.aborted).toBe(false);

      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const deadlineTimer = setTimeout(() => reject(new Error('timeout waiting for expiry')), 3000);
      signal.addEventListener('abort', () => {
        clearTimeout(deadlineTimer);
        resolve();
      }, { once: true });

      await promise;

      expect(signal.aborted).toBe(true);
      expect(broker.state('signup')).toBe('stopped');
      const last = broker.audit().at(-1);
      expect(last?.event).toBe('grant_expired');
      expect(last?.reason).toBe('GRANT_EXPIRED');
      expect(last?.task).toBe('signup');
      expect(() => broker.authorize(grant, 'signup', request().origin, 'fill', 'registration-email')).toThrow('INVALID_GRANT');
    } finally {
      broker.stopAll();
    }
  });

  test('fake-clock overdue lookup triggers expiry, aborts signal, and cleans up', () => {
    let fakeNow = 1000;
    const broker = new PolicyBroker(defaultCatalog(), noopSink, () => fakeNow);
    try {
      const grant = broker.approve({ ...request(), durationSeconds: 10 });
      const signal = broker.executionSignal(grant, 'signup');
      expect(signal.aborted).toBe(false);

      fakeNow = 11001;
      expect(() => broker.executionSignal(grant, 'signup')).toThrow('GRANT_EXPIRED');
      expect(signal.aborted).toBe(true);
      expect(broker.state('signup')).toBe('stopped');
      const last = broker.audit().at(-1);
      expect(last?.event).toBe('grant_expired');
      expect(last?.reason).toBe('GRANT_EXPIRED');

      expect(() => broker.executionSignal(grant, 'signup')).toThrow('INVALID_GRANT');
    } finally {
      broker.stopAll();
    }
  });

  // Deliberately exercises clock rescheduling and timer callback unhandled error safety against platform clock
  test('reschedules timer if clock indicates deadline not reached, and catches audit failure safely', async () => {
    let customClock = 0;
    const broker = new PolicyBroker(defaultCatalog(), noopSink, () => customClock);
    try {
      const grant = broker.approve({ ...request(), durationSeconds: 1 });
      const signal = broker.executionSignal(grant, 'signup');
      customClock = 500;

      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const timeout = setTimeout(() => reject(new Error('reschedule timeout')), 3500);

      const stepTimer = setTimeout(() => {
        customClock = 1500;
      }, 1100);

      signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        clearTimeout(stepTimer);
        resolve();
      }, { once: true });

      await promise;
      expect(signal.aborted).toBe(true);
    } finally {
      broker.stopAll();
    }

    let failExpiryAudit = false;
    const faultBroker = new PolicyBroker(defaultCatalog(), (event) => {
      if (failExpiryAudit && event.event === 'grant_expired') {
        throw new Error('journal disk unmounted');
      }
    });
    try {
      const grant = faultBroker.approve({ ...request(), durationSeconds: 1 });
      const signal = faultBroker.executionSignal(grant, 'signup');
      failExpiryAudit = true;

      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const timeout = setTimeout(() => reject(new Error('fault expiry timeout')), 3000);
      signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });

      await promise;
      expect(signal.aborted).toBe(true);
      expect(faultBroker.state('signup')).toBe('stopped');
      expect(() => faultBroker.approve({ ...request(), task: 'after-fault' })).toThrow('AUDIT_UNAVAILABLE');
    } finally {
      faultBroker.stopAll();
    }
  });
  // Deliberately exercises that finish clears platform timer so it does not fire past the 1-second window
  test('finish clears timer and releases resources without aborting successful signal', async () => {
    let fakeNow = 1000;
    const broker = new PolicyBroker(defaultCatalog(), noopSink, () => fakeNow);
    try {
      const grant = broker.approve({ ...request(), durationSeconds: 1 });
      const signal = broker.executionSignal(grant, 'signup');
      broker.authorize(grant, 'signup', request().origin, 'fill', 'registration-email');
      broker.authorize(grant, 'signup', request().origin, 'submit');
      broker.finish('signup', 'completed');

      expect(signal.aborted).toBe(false);
      expect(broker.state('signup')).toBe('completed');

      fakeNow = 50000;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(() => resolve(), 1200);
      await promise;

      expect(signal.aborted).toBe(false);
      const audit = broker.audit();
      expect(audit.some(e => e.event === 'grant_expired')).toBe(false);

      expect(() => broker.authorize(grant, 'signup', request().origin, 'fill', 'registration-email')).toThrow('TASK_NOT_ACTIVE');
      expect(() => broker.executionSignal(grant, 'signup')).toThrow('TASK_NOT_ACTIVE');
    } finally {
      broker.stopAll();
    }
  });
  test('reclassification removes every affected authority before abort callbacks run', () => {
    const broker = new PolicyBroker(defaultCatalog(), noopSink);
    try {
      const first = broker.approve({ ...request(), task: 'first', credentials: ['registration-email'], layers: ['yellow', 'orange'] });
      const second = broker.approve({ ...request(), task: 'second', credentials: ['registration-email'], layers: ['yellow', 'orange'] });
      const firstSignal = broker.executionSignal(first, 'first');
      const secondSignal = broker.executionSignal(second, 'second');
      let authorizedDuringAbort = false;
      firstSignal.addEventListener('abort', () => {
        try {
          broker.authorize(second, 'second', request().origin, 'fill', 'registration-email');
          authorizedDuringAbort = true;
        } catch { /* The whole affected set must already be inactive. */ }
      }, { once: true });
      broker.setCredentialLayer('registration-email', 'orange');
      expect(authorizedDuringAbort).toBe(false);
      expect(firstSignal.aborted).toBe(true);
      expect(secondSignal.aborted).toBe(true);
    } finally {
      broker.stopAll();
    }
  });
});
