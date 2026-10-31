import { describe, expect, test } from 'bun:test';
import { PolicyBroker, httpsOrigin } from '../src/policy';
const request = () => ({ task: 'signup', origin: 'https://accounts.example.test', credentials: ['registration-email', 'registration-password'], operations: ['fill', 'submit'] as const, durationSeconds: 60, maxSubmissions: 1 });
describe('authorization boundary', () => {
  test('binds credential, exact origin and task, then prevents observation', () => {
    const broker = new PolicyBroker();
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
    const broker = new PolicyBroker(() => now);
    const grant = broker.approve(request());
    now = 60000;
    expect(() => broker.authorize(grant, 'signup', request().origin, 'fill', 'registration-email')).toThrow('GRANT_EXPIRED');
  });
  test('block and stop revoke existing authority', () => {
    const broker = new PolicyBroker();
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
    const broker = new PolicyBroker();
    const grant = broker.approve({ ...request(), credentials });
    credentials.push('bank-card');
    expect(() => broker.authorize(grant, 'signup', request().origin, 'fill', 'bank-card')).toThrow('CREDENTIAL_DENIED');
  });
  test('rejects ambiguous destination strings', () => {
    for (const value of ['http://example.test', 'https://user:pass@example.test', 'https://example.test/path', 'https://example.test/?secret=x', 'javascript:alert(1)']) expect(() => httpsOrigin(value)).toThrow('INVALID_ORIGIN');
  });
});
