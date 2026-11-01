import { describe, expect, test } from 'bun:test';
import { InformationFlow } from '../src/information-flow';
import type { InformationField, InformationPlanInput, InformationVariable, InformationVariableInput, InformationVault } from '../src/information-contract';

class FakeInformationVault implements InformationVault {
  variables: InformationVariable[] = [];
  savedInputs: InformationVariableInput[] = [];
  authenticatedOrigins: string[] = [];
  cleared = false;

  async catalog(_origin: string): Promise<readonly InformationVariable[]> {
    return this.variables;
  }
  async save(input: InformationVariableInput): Promise<void> {
    this.savedInputs.push(input);
    this.variables.push({
      id: 'var-' + input.name,
      name: input.name,
      description: input.description,
      kind: input.kind,
      scope: input.scope,
      available: true,
    });
  }
  async read(id: string, _origin: string): Promise<string> {
    const v = this.variables.find(item => item.id === id);
    if (!v) throw new Error('UNKNOWN_VARIABLE');
    return 'value-for-' + v.name;
  }
  async authenticate(origin: string): Promise<void> {
    this.authenticatedOrigins.push(origin);
  }
  clear(): void {
    this.cleared = true;
  }
}

describe('InformationFlow state machine and missing information dialog handling', () => {
  const origin = 'https://signup.example.test';
  const fields: readonly InformationField[] = [
    { id: 'f-name', label: 'Full Name', kind: 'text', required: true },
    { id: 'f-user', label: 'Choose Username', kind: 'username', required: true },
    { id: 'f-email', label: 'Email Address', kind: 'email', required: true },
  ];

  test('demands catalog review before planning and exposes catalog names and descriptions without values', async () => {
    const vault = new FakeInformationVault();
    vault.variables = [
      { id: 'v1', name: 'Email Address', description: 'Personal primary email', kind: 'email', scope: 'profile', available: true },
    ];
    const planner = {
      mode: 'reviewed' as const,
      async plan(_input: InformationPlanInput) {
        return [
          { fieldId: 'f-name', variableId: null },
          { fieldId: 'f-user', variableId: null },
          { fieldId: 'f-email', variableId: 'v1' },
        ];
      },
    };
    const flow = new InformationFlow(vault, planner, () => {});
    flow.attach(origin, fields);

    // Planning before catalog is rejected
    await expect(flow.plan(false)).rejects.toThrow('INFORMATION_CATALOG_REQUIRED');

    // Load catalog
    await flow.loadCatalog();
    expect(flow.state.catalogLoaded).toBe(true);
    expect(flow.state.variables.length).toBe(1);
    expect(flow.state.variables[0]?.name).toBe('Email Address');
    expect(flow.state.variables[0]?.description).toBe('Personal primary email');
    // Ensure no value property is leaked
    expect('value' in flow.state.variables[0]!).toBe(false);

    // Plan
    await flow.plan(false);
    expect(flow.state.planned).toBe(true);

    // The email field is mapped to v1
    const emailMapping = flow.state.mappings.find(m => m.fieldId === 'f-email');
    expect(emailMapping?.variableId).toBe('v1');
    // While missing requests are pending, ready is false
    expect(flow.ready('f-email')).toBe(false);
    // Missing fields (name, username) request information via dialog
    expect(flow.state.request).toBeDefined();
    expect(flow.state.request?.field.id).toBe('f-name');
    expect(flow.ready('f-name')).toBe(false);

    // Provide missing name through dialog
    const req1 = flow.state.request!;
    await flow.provide(req1.id, 'Ada Lovelace', {
      name: 'Full Name',
      description: 'Legal first and last name',
      scope: 'profile',
    });

    // Saved to vault as profile variable
    expect(vault.savedInputs.length).toBe(1);
    expect(vault.savedInputs[0]?.name).toBe('Full Name');
    expect(vault.savedInputs[0]?.value).toBe('Ada Lovelace');
    expect(vault.savedInputs[0]?.scope).toBe('profile');

    // Next missing field is requested automatically: username
    expect(flow.state.request).toBeDefined();
    expect(flow.state.request?.field.id).toBe('f-user');

    // User chooses to skip username
    const req2 = flow.state.request!;
    flow.skip(req2.id);

    // No more missing requests
    expect(flow.state.request).toBeUndefined();

    // Resolving value for entered name authenticates one-off entered data
    const nameVal = await flow.value('f-name');
    expect(nameVal).toBe('Ada Lovelace');
    expect(vault.authenticatedOrigins).toContain(origin);

    // Resolving value for email reads from vault via trusted read
    const emailVal = await flow.value('f-email');
    expect(emailVal).toBe('value-for-Email Address');

    // Skipped field is not ready
    expect(flow.ready('f-user')).toBe(false);
    await expect(flow.value('f-user')).rejects.toThrow('INVALID_OWNER_COMMAND');
  });

  test('clearing removes all entered values, active requests, and invalidates vault', () => {
    const vault = new FakeInformationVault();
    const planner = {
      mode: 'reviewed' as const,
      async plan() { return []; },
    };
    const flow = new InformationFlow(vault, planner, () => {});
    flow.attach(origin, fields);
    flow.clear();
    expect(vault.cleared).toBe(true);
    expect(flow.state.catalogLoaded).toBe(false);
    expect(flow.state.planned).toBe(false);
    expect(flow.state.request).toBeUndefined();
  });
});
