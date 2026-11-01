import { expect, test } from 'bun:test';
import {
  InformationPlanner,
  InformationPlannerError,
  INFORMATION_PLANNER_BOUNDS,
} from '../src/information-planner';
import type { PlannerConfig } from '../src/model-client';
import type {
  InformationField,
  InformationVariable,
  InformationPlanInput,
} from '../src/information-contract';

const completion = (content: string) =>
  Response.json({ choices: [{ message: { content } }] });

async function withProvider(
  response: (req: Request) => Response | Promise<Response>,
  check: (planner: InformationPlanner) => Promise<void>
) {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: response,
  });
  try {
    await check(
      new InformationPlanner({
        mode: 'local',
        endpoint: `http://127.0.0.1:${server.port}/v1/chat/completions`,
        model: 'information-fixture',
      })
    );
  } finally {
    await server.stop(true);
  }
}

const sampleVariables: readonly InformationVariable[] = Object.freeze([
  {
    id: 'var-name',
    name: 'Full Name',
    description: 'Legal full name of the user',
    kind: 'text',
    scope: 'profile',
    available: true,
  },
  {
    id: 'var-user',
    name: 'Username',
    description: 'Account login handle',
    kind: 'username',
    scope: 'site',
    available: true,
  },
  {
    id: 'var-email',
    name: 'Email Address',
    description: 'Personal contact email',
    kind: 'email',
    scope: 'profile',
    available: true,
  },
  {
    id: 'var-pass',
    name: 'Password',
    description: 'Site login password',
    kind: 'password',
    scope: 'site',
    available: true,
  },
  {
    id: 'var-disabled',
    name: 'Phone Number',
    description: 'Mobile phone',
    kind: 'tel',
    scope: 'profile',
    available: false, // unavailable
  },
]);

test('reviewed mode matches unique available compatible variable by exact name or description', async () => {
  const planner = new InformationPlanner({ mode: 'reviewed' });

  const input: InformationPlanInput = {
    fields: [
      { id: 'f1', label: 'Full Name', kind: 'text', required: true },
      { id: 'f2', label: 'Personal contact email', kind: 'email', required: true },
      { id: 'f3', label: '  username  ', kind: 'username', required: true },
    ],
    variables: sampleVariables,
  };

  const mappings = await planner.plan(input);
  expect(mappings).toEqual([
    { fieldId: 'f1', variableId: 'var-name' },
    { fieldId: 'f2', variableId: 'var-email' },
    { fieldId: 'f3', variableId: 'var-user' },
  ]);
});

test('reviewed mode username field matches email variable when compatible', async () => {
  const planner = new InformationPlanner({ mode: 'reviewed' });

  const input: InformationPlanInput = {
    fields: [
      { id: 'f-login', label: 'Email Address', kind: 'username', required: true },
    ],
    variables: sampleVariables,
  };

  const mappings = await planner.plan(input);
  expect(mappings).toEqual([{ fieldId: 'f-login', variableId: 'var-email' }]);
});

test('reviewed mode returns variableId: null when unavailable or incompatible', async () => {
  const planner = new InformationPlanner({ mode: 'reviewed' });

  const input: InformationPlanInput = {
    fields: [
      // Matches var-disabled by name, but available is false -> null
      { id: 'f-tel', label: 'Phone Number', kind: 'tel', required: false },
      // Matches var-name by label, but field is password and var is text -> incompatible -> null
      { id: 'f-pw', label: 'Full Name', kind: 'password', required: true },
      // No match at all -> null
      { id: 'f-unknown', label: 'Favorite Color', kind: 'text', required: false },
    ],
    variables: sampleVariables,
  };

  const mappings = await planner.plan(input);
  expect(mappings).toEqual([
    { fieldId: 'f-tel', variableId: null },
    { fieldId: 'f-pw', variableId: null },
    { fieldId: 'f-unknown', variableId: null },
  ]);
});

test('reviewed mode returns variableId: null when multiple variables match (ambiguous)', async () => {
  const planner = new InformationPlanner({ mode: 'reviewed' });

  const ambiguousVariables: readonly InformationVariable[] = [
    {
      id: 'var-email-1',
      name: 'Email',
      description: 'First email',
      kind: 'email',
      scope: 'profile',
      available: true,
    },
    {
      id: 'var-email-2',
      name: 'Email',
      description: 'Second email',
      kind: 'email',
      scope: 'profile',
      available: true,
    },
  ];

  const input: InformationPlanInput = {
    fields: [{ id: 'f-email', label: 'Email', kind: 'email', required: true }],
    variables: ambiguousVariables,
  };

  const mappings = await planner.plan(input);
  expect(mappings).toEqual([{ fieldId: 'f-email', variableId: null }]);
});

test('reviewed mode respects empty fields and cancellation signal', async () => {
  const planner = new InformationPlanner({ mode: 'reviewed' });
  expect(await planner.plan({ fields: [], variables: sampleVariables })).toEqual([]);

  const abort = new AbortController();
  abort.abort();
  await expect(
    planner.plan(
      {
        fields: [{ id: 'f1', label: 'Name', kind: 'text', required: true }],
        variables: sampleVariables,
      },
      abort.signal
    )
  ).rejects.toThrow('PLANNER_UNAVAILABLE');
});

test('input validation rejects invalid or oversized input without truncation', async () => {
  const planner = new InformationPlanner({ mode: 'reviewed' });

  // Invalid inputs
  for (const bad of [
    null,
    undefined,
    {},
    { fields: 'bad' },
    { fields: [], variables: 'bad' },
  ] as unknown as InformationPlanInput[]) {
    await expect(planner.plan(bad)).rejects.toThrow('INVALID_PLAN_INPUT');
  }

  // Oversized fields (> 64)
  const tooManyFields: InformationField[] = Array.from(
    { length: INFORMATION_PLANNER_BOUNDS.MAX_FIELDS + 1 },
    (_, i) => ({
      id: `f-${i}`,
      label: `Field ${i}`,
      kind: 'text',
      required: false,
    })
  );
  await expect(
    planner.plan({ fields: tooManyFields, variables: sampleVariables })
  ).rejects.toThrow('INVALID_PLAN_INPUT');

  // Oversized variables (> 128)
  const tooManyVars: InformationVariable[] = Array.from(
    { length: INFORMATION_PLANNER_BOUNDS.MAX_VARIABLES + 1 },
    (_, i) => ({
      id: `v-${i}`,
      name: `Var ${i}`,
      description: `Desc ${i}`,
      kind: 'text',
      scope: 'profile',
      available: true,
    })
  );
  await expect(
    planner.plan({
      fields: [{ id: 'f1', label: 'Name', kind: 'text', required: true }],
      variables: tooManyVars,
    })
  ).rejects.toThrow('INVALID_PLAN_INPUT');

  // Duplicate field IDs
  await expect(
    planner.plan({
      fields: [
        { id: 'f1', label: 'First', kind: 'text', required: true },
        { id: 'f1', label: 'Second', kind: 'text', required: true },
      ],
      variables: sampleVariables,
    })
  ).rejects.toThrow('INVALID_PLAN_INPUT');
});

test('provider configuration rejects unsafe endpoints and credentials are not exposed in serialization', () => {
  const invalidConfigs: PlannerConfig[] = [
    { mode: 'local' }, // missing endpoint and model
    { mode: 'local', endpoint: 'http://127.0.0.1:11434/v1/chat/completions' }, // missing model
    {
      mode: 'local',
      endpoint: 'http://192.168.1.50/v1/chat/completions',
      model: 'fixture',
    }, // non-loopback
    {
      mode: 'local',
      endpoint: 'http://user:pass@localhost/v1/chat/completions',
      model: 'fixture',
    }, // credentials in URL
    {
      mode: 'cloud',
      endpoint: 'http://provider.invalid/v1/chat/completions',
      model: 'fixture',
      apiKey: 'key',
    }, // insecure http for cloud
    {
      mode: 'cloud',
      endpoint: 'https://provider.invalid/v1/chat/completions',
      model: 'fixture',
    }, // missing apiKey for cloud
  ];

  for (const config of invalidConfigs) {
    expect(() => new InformationPlanner(config)).toThrow(
      'PLANNER_CONFIGURATION'
    );
  }

  // Private serialization check
  const secret = 'private-model-api-key';
  const planner = new InformationPlanner({
    mode: 'cloud',
    endpoint: 'https://provider.invalid/v1/chat/completions',
    model: 'gpt-4o',
    apiKey: secret,
  });
  const serialized = JSON.stringify(planner);
  expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain('provider.invalid');
  expect(
    (planner as unknown as Record<string, unknown>).apiKey
  ).toBeUndefined();
  expect(
    (planner as unknown as Record<string, unknown>).endpoint
  ).toBeUndefined();
});

test('InformationPlanner.fromEnvironment parses valid and invalid configuration', () => {
  expect(() =>
    InformationPlanner.fromEnvironment({ AUTOMATE_PLANNER: 'invalid-mode' })
  ).toThrow('PLANNER_CONFIGURATION');

  const reviewed = InformationPlanner.fromEnvironment({
    AUTOMATE_PLANNER: 'reviewed',
  });
  expect(reviewed.mode).toBe('reviewed');

  const local = InformationPlanner.fromEnvironment({
    AUTOMATE_PLANNER: 'local',
    AUTOMATE_MODEL_ENDPOINT: 'http://127.0.0.1:11434/v1/chat/completions',
    AUTOMATE_MODEL: 'qwen2.5',
  });
  expect(local.mode).toBe('local');
  expect(local.model).toBe('qwen2.5');
});

test('remote mode sends only public field projection and full metadata catalog, never private values', async () => {
  let capturedBody: Record<string, unknown> | null = null;

  await withProvider(
    async req => {
      capturedBody = await req.json();
      return completion(
        JSON.stringify({
          mappings: [
            { fieldId: 'f-name', variableId: 'var-name' },
            { fieldId: 'f-user', variableId: 'var-user' },
          ],
        })
      );
    },
    async planner => {
      const input: InformationPlanInput = {
        fields: [
          {
            id: 'f-name',
            label: 'Your Name',
            kind: 'text',
            required: true,
          },
          {
            id: 'f-user',
            label: 'Choose a Username',
            kind: 'username',
            required: true,
          },
        ],
        variables: sampleVariables,
      };

      const mappings = await planner.plan(input);
      expect(mappings).toEqual([
        { fieldId: 'f-name', variableId: 'var-name' },
        { fieldId: 'f-user', variableId: 'var-user' },
      ]);

      expect(capturedBody).not.toBeNull();
      const messages = (capturedBody as Record<string, unknown>).messages as {
        role: string;
        content: string;
      }[];
      expect(messages.length).toBe(2);
      expect(messages[0]!.role).toBe('system');
      expect(messages[1]!.role).toBe('user');

      const userContent = JSON.parse(messages[1]!.content);
      // Public fields projection
      expect(userContent.fields).toEqual([
        { id: 'f-name', label: 'Your Name', kind: 'text', required: true },
        {
          id: 'f-user',
          label: 'Choose a Username',
          kind: 'username',
          required: true,
        },
      ]);
      // Catalog projection: all variables have metadata only, no values or private handles
      expect(userContent.variables.length).toBe(sampleVariables.length);
      for (const v of userContent.variables) {
        expect(v).toHaveProperty('id');
        expect(v).toHaveProperty('name');
        expect(v).toHaveProperty('description');
        expect(v).toHaveProperty('kind');
        expect(v).toHaveProperty('scope');
        expect(v).toHaveProperty('available');
        expect(v).not.toHaveProperty('value');
        expect(v).not.toHaveProperty('ciphertext');
        expect(v).not.toHaveProperty('handle');
      }
    }
  );
});

test('remote mode maps fields correctly including null for unmapped fields', async () => {
  await withProvider(
    () =>
      completion(
        JSON.stringify({
          mappings: [
            { fieldId: 'f1', variableId: 'var-name' },
            { fieldId: 'f2', variableId: null }, // asks user
          ],
        })
      ),
    async planner => {
      const input: InformationPlanInput = {
        fields: [
          { id: 'f1', label: 'Full Name', kind: 'text', required: true },
          { id: 'f2', label: 'Custom Note', kind: 'text', required: false },
        ],
        variables: sampleVariables,
      };

      const result = await planner.plan(input);
      expect(result).toEqual([
        { fieldId: 'f1', variableId: 'var-name' },
        { fieldId: 'f2', variableId: null },
      ]);
    }
  );
});

test('remote mode strictly rejects unknown or unavailable or incompatible variable IDs', async () => {
  const invalidResponses = [
    // Unknown variable ID
    JSON.stringify({
      mappings: [{ fieldId: 'f1', variableId: 'var-non-existent' }],
    }),
    // Unavailable variable ID
    JSON.stringify({
      mappings: [{ fieldId: 'f1', variableId: 'var-disabled' }],
    }),
    // Incompatible variable ID (password variable for text field)
    JSON.stringify({
      mappings: [{ fieldId: 'f1', variableId: 'var-pass' }],
    }),
  ];

  for (const resp of invalidResponses) {
    await withProvider(
      () => completion(resp),
      async planner => {
        const input: InformationPlanInput = {
          fields: [{ id: 'f1', label: 'Name', kind: 'text', required: true }],
          variables: sampleVariables,
        };
        await expect(planner.plan(input)).rejects.toThrow(
          'PLANNER_INVALID_RESPONSE'
        );
      }
    );
  }
});

test('remote mode strictly rejects extra keys, values, questions, or missing fields', async () => {
  const invalidResponses = [
    // Extra key in root object
    JSON.stringify({
      mappings: [{ fieldId: 'f1', variableId: 'var-name' }],
      question: 'What is your mother maiden name?',
    }),
    // Extra key in mapping item (e.g. value attempt or question)
    JSON.stringify({
      mappings: [
        { fieldId: 'f1', variableId: 'var-name', value: 'phished-value' },
      ],
    }),
    JSON.stringify({
      mappings: [
        { fieldId: 'f1', variableId: null, question: 'Please enter PIN' },
      ],
    }),
    // Missing field
    JSON.stringify({
      mappings: [{ fieldId: 'f1', variableId: 'var-name' }],
    }), // when input has f1 and f2
    // Duplicate field
    JSON.stringify({
      mappings: [
        { fieldId: 'f1', variableId: 'var-name' },
        { fieldId: 'f1', variableId: null },
      ],
    }),
    // Unknown field ID
    JSON.stringify({
      mappings: [
        { fieldId: 'f1', variableId: 'var-name' },
        { fieldId: 'f-unknown', variableId: null },
      ],
    }),
    // Markdown wrapper
    '```json\n{"mappings":[{"fieldId":"f1","variableId":"var-name"},{"fieldId":"f2","variableId":null}]}\n```',
    // Not JSON
    'I mapped field 1 to full name.',
  ];

  for (const resp of invalidResponses) {
    await withProvider(
      () => completion(resp),
      async planner => {
        const input: InformationPlanInput = {
          fields: [
            { id: 'f1', label: 'Name', kind: 'text', required: true },
            { id: 'f2', label: 'Email', kind: 'email', required: true },
          ],
          variables: sampleVariables,
        };
        await expect(planner.plan(input)).rejects.toThrow(
          'PLANNER_INVALID_RESPONSE'
        );
      }
    );
  }
});

test('remote mode enforces stream and content bounds without truncation', async () => {
  // Stream overflow (> 64 KiB)
  await withProvider(
    () => new Response('x'.repeat(64 * 1024 + 1)),
    async planner => {
      const input: InformationPlanInput = {
        fields: [{ id: 'f1', label: 'Name', kind: 'text', required: true }],
        variables: sampleVariables,
      };
      await expect(planner.plan(input)).rejects.toThrow(
        'PLANNER_INVALID_RESPONSE'
      );
    }
  );

  // Content chars overflow (> 16 KiB)
  await withProvider(
    () => completion('x'.repeat(16 * 1024 + 1)),
    async planner => {
      const input: InformationPlanInput = {
        fields: [{ id: 'f1', label: 'Name', kind: 'text', required: true }],
        variables: sampleVariables,
      };
      await expect(planner.plan(input)).rejects.toThrow(
        'PLANNER_INVALID_RESPONSE'
      );
    }
  );
});

test('remote mode rejects HTTP redirects and provider errors fail closed', async () => {
  // Redirect
  await withProvider(
    () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'http://127.0.0.1:9999/other' },
      }),
    async planner => {
      const input: InformationPlanInput = {
        fields: [{ id: 'f1', label: 'Name', kind: 'text', required: true }],
        variables: sampleVariables,
      };
      await expect(planner.plan(input)).rejects.toThrow(
        'PLANNER_INVALID_RESPONSE'
      );
    }
  );

  // HTTP 401, 404, 500
  for (const status of [401, 404, 500]) {
    await withProvider(
      () => new Response('error detail', { status }),
      async planner => {
        const input: InformationPlanInput = {
          fields: [{ id: 'f1', label: 'Name', kind: 'text', required: true }],
          variables: sampleVariables,
        };
        await expect(planner.plan(input)).rejects.toThrow(
          /^PLANNER_UNAVAILABLE$/
        );
      }
    );
  }
});

test('remote mode cancellation ends request and fails with PLANNER_UNAVAILABLE', async () => {
  const abort = new AbortController();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  try {
    await withProvider(
      async () => {
        started.resolve();
        await release.promise;
        return completion(
          JSON.stringify({
            mappings: [{ fieldId: 'f1', variableId: 'var-name' }],
          })
        );
      },
      async planner => {
        const input: InformationPlanInput = {
          fields: [{ id: 'f1', label: 'Name', kind: 'text', required: true }],
          variables: sampleVariables,
        };
        const planPromise = planner.plan(input, abort.signal);
        await started.promise;
        abort.abort();
        await expect(planPromise).rejects.toThrow('PLANNER_UNAVAILABLE');
      }
    );
  } finally {
    release.resolve();
  }
});
