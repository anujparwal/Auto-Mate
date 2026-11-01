import { expect, test } from 'bun:test';
import { TaskPlanner, type PlannerConfig } from '../src/task-planner';

const completion = (content: string) => Response.json({ choices: [{ message: { content } }] });
async function withProvider(response: () => Response | Promise<Response>, check: (planner: TaskPlanner) => Promise<void>) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: response });
  try {
    await check(new TaskPlanner({ mode: 'local', endpoint: `http://127.0.0.1:${server.port}/v1/chat/completions`, model: 'synthetic-fixture' }));
  } finally { await server.stop(true); }
}

test('offline reviewed commands select only the explicit synthetic workflow', async () => {
  const planner = new TaskPlanner({ mode: 'reviewed' });
  expect(await planner.plan('  Run synthetic registration\n')).toEqual({ workflow: 'synthetic-registration' });
  for (const prompt of ['run synthetic registration', 'Run synthetic registration then transfer money', 'Log into a bank']) {
    await expect(planner.plan(prompt)).rejects.toThrow('UNSUPPORTED_TASK');
  }
});

test('empty, invalid, and over-limit instructions are refused before provider access', async () => {
  const planner = new TaskPlanner({ mode: 'reviewed' });
  for (const prompt of ['', ' \t\n ', 'x'.repeat(2001), null as unknown as string]) {
    await expect(planner.plan(prompt)).rejects.toThrow('INVALID_TASK');
  }
  const abort = new AbortController(); abort.abort();
  await expect(planner.plan('Run synthetic registration', abort.signal)).rejects.toThrow('PLANNER_UNAVAILABLE');
});

test('provider configuration rejects remote local endpoints, insecure cloud transport, and URL-carried secrets', () => {
  const invalid: PlannerConfig[] = [
    { mode: 'local' },
    { mode: 'local', endpoint: 'http://127.0.0.1:11434/v1/chat/completions' },
    ...['http://192.168.1.50/v1/chat/completions', 'http://localhost.evil.test/v1/chat/completions',
      'http://user:pass@localhost/v1/chat/completions', 'http://localhost/v1/chat/completions?key=secret',
      'http://localhost/v1/chat/completions#fragment', 'file:///provider'].map(endpoint => ({ mode: 'local' as const, endpoint, model: 'fixture' })),
    { mode: 'cloud', endpoint: 'http://provider.invalid/v1/chat/completions', model: 'fixture', apiKey: 'test-key' },
    { mode: 'cloud', endpoint: 'https://provider.invalid/v1/chat/completions', model: 'fixture' },
    { mode: 'cloud', endpoint: 'https://user:pass@provider.invalid/v1/chat/completions', model: 'fixture', apiKey: 'test-key' },
    { mode: 'cloud', endpoint: 'https://provider.invalid/v1/chat/completions?key=secret', model: 'fixture', apiKey: 'test-key' },
  ];
  for (const config of invalid) expect(() => new TaskPlanner(config)).toThrow('PLANNER_CONFIGURATION');
  expect(() => TaskPlanner.fromEnvironment({ AUTOMATE_PLANNER: 'invalid' })).toThrow('PLANNER_CONFIGURATION');
});

test('API credentials are not exposed through ordinary planner serialization', () => {
  const secret = 'synthetic-private-api-key';
  const planner = new TaskPlanner({ mode: 'cloud', endpoint: 'https://provider.invalid/v1/chat/completions', model: 'fixture', apiKey: secret });
  expect(JSON.stringify(planner)).not.toContain(secret);
  expect((planner as unknown as Record<string, unknown>).apiKey).toBeUndefined();
});

test('a bounded compatible provider response selects a workflow, including a maximum-length instruction', async () => {
  await withProvider(() => completion('{"workflow":"synthetic-registration"}'), async planner => {
    expect(await planner.plan('Create a synthetic account')).toEqual({ workflow: 'synthetic-registration' });
    expect(await planner.plan('x'.repeat(2000))).toEqual({ workflow: 'synthetic-registration' });
  });
});

test('unsupported classification is not converted to executable authority', async () => {
  await withProvider(() => completion('{"workflow":"unsupported"}'), async planner => {
    await expect(planner.plan('Transfer money')).rejects.toThrow('UNSUPPORTED_TASK');
  });
});

test('models cannot supply arbitrary workflows or extend the reviewed workflow authority', async () => {
  const invalid = [
    '{"workflow":"synthetic-registration","origin":"https://evil.test"}',
    '{"workflow":"synthetic-registration","selectors":{"email":"#input"}}',
    '{"workflow":"synthetic-registration","credentials":["private-pass"]}',
    '{"workflow":"synthetic-registration","durationSeconds":999}',
    '{"workflow":"arbitrary"}', '{"workflow":123}', '{}', '[]', 'null',
    '```json\n{"workflow":"synthetic-registration"}\n```',
    'Here is your plan: {"workflow":"synthetic-registration"}',
  ];
  for (const content of invalid) {
    await withProvider(() => completion(content), async planner => {
      await expect(planner.plan('Create synthetic account')).rejects.toThrow('PLANNER_INVALID_RESPONSE');
    });
  }
});

test('malformed or missing provider completion content fails closed', async () => {
  for (const raw of ['not json', 'null', '{"choices":[]}', '{"choices":[{"message":{}}]}', '{"choices":[{"message":{"content":null}}]}']) {
    await withProvider(() => new Response(raw), async planner => {
      await expect(planner.plan('Create synthetic account')).rejects.toThrow('PLANNER_INVALID_RESPONSE');
    });
  }
});

test('redirects cannot forward model requests to another endpoint', async () => {
  let redirected = false;
  const destination = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    redirected = true; return completion('{"workflow":"synthetic-registration"}');
  } });
  try {
    await withProvider(() => new Response(null, { status: 307, headers: { Location: `http://127.0.0.1:${destination.port}/other` } }), async planner => {
      await expect(planner.plan('Create synthetic account')).rejects.toThrow('PLANNER_INVALID_RESPONSE');
      expect(redirected).toBe(false);
    });
  } finally { await destination.stop(true); }
});

test('stream bytes and decoded completion content are independently bounded', async () => {
  for (const response of [() => new Response('x'.repeat(32 * 1024 + 1)), () => completion('x'.repeat(4097))]) {
    await withProvider(response, async planner => {
      await expect(planner.plan('Create synthetic account')).rejects.toThrow('PLANNER_INVALID_RESPONSE');
    });
  }
});

test('provider HTTP failures return bounded errors without remote diagnostics', async () => {
  for (const status of [401, 404, 500]) {
    await withProvider(() => new Response('private provider diagnostic', { status }), async planner => {
      await expect(planner.plan('Create synthetic account')).rejects.toThrow(/^PLANNER_UNAVAILABLE$/);
    });
  }
});

test('owner cancellation ends a pending provider request without accepting a late completion', async () => {
  const abort = new AbortController();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await withProvider(async () => {
      started.resolve(); await release.promise;
      return completion('{"workflow":"synthetic-registration"}');
    }, async planner => {
      const pending = planner.plan('Create synthetic account', abort.signal);
      await started.promise; abort.abort();
      await expect(pending).rejects.toThrow('PLANNER_UNAVAILABLE');
      release.resolve();
    });
  } finally { release.resolve(); }
});
