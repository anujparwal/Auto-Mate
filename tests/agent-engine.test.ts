import { expect, test } from 'bun:test';
import { fixtureEmail, fixtureOrigin, fixturePassword, lastObservation, workspaceFixture, type CompletionBody } from './workspace-fixture';
import type { BrowserObservation } from '../src/agent-types';

test('private dialogs and explicit permissions fill real nodes while parallel public evaluators record quoted notes', async () => {
  let observed: BrowserObservation;
  const fixture = await workspaceFixture((body, step) => {
    if (step === -1) {
      const input = JSON.parse(body.messages[1]!.content) as { page: BrowserObservation };
      const evidence = input.page.text.includes('1499') ? 'Price Rs 1499. Battery 12 hours.' : 'Price Rs 1899. Battery 10 hours.';
      return { findings: [{ claim: evidence, evidence }] };
    }
    if (step === 0) return { tool: 'navigate', args: { url: fixtureOrigin + '/login' } };
    if (step === 1) { observed = lastObservation(body); return { tool: 'request_information', args: { fieldId: observed.fields.find(field => field.kind === 'email')!.id } }; }
    if (step === 2) return { tool: 'request_information', args: { fieldId: observed.fields.find(field => field.kind === 'password')!.id } };
    if (step === 3) return { tool: 'click', args: { actionId: observed.actions.find(action => action.label === 'Login')!.id } };
    if (step === 4) return { tool: 'spawn_subagents', args: { tasks: [{ name: 'A', goal: 'Price and battery', url: fixtureOrigin + '/product-a' }, { name: 'B', goal: 'Price and battery', url: fixtureOrigin + '/product-b' }] } };
    return { tool: 'finish_task', args: { answer: 'Speaker A has the lower quoted price and longer quoted battery life. No purchase was made.' } };
  }, { knownPassword: true });
  try {
    await fixture.engine.command({ action: 'workspace-send', prompt: 'Compare the two public speakers after logging in.' });
    const needed = await fixture.wait(state => !!state.request);
    expect(await fixture.page.locator('#email').inputValue()).toBe('');
    await fixture.engine.command({ action: 'workspace-provide', requestId: needed.request!.id, value: fixtureEmail, save: true, name: 'Email', description: 'Fixture email', scope: 'site' });
    const fillPermission = await fixture.wait(state => state.permission?.type === 'variable');
    expect(await fixture.page.locator('#password').inputValue()).toBe('');
    await fixture.engine.command({ action: 'workspace-permission', permissionId: fillPermission.permission!.id, allow: true });
    const clickPermission = await fixture.wait(state => state.permission?.type === 'action');
    expect(await fixture.page.locator('#email').inputValue()).toBe(fixtureEmail);
    expect(await fixture.page.locator('#password').inputValue()).toBe(fixturePassword);
    expect(await fixture.page.getAttribute('body', 'data-clicked')).toBeNull();
    await fixture.engine.command({ action: 'workspace-permission', permissionId: clickPermission.permission!.id, allow: true });
    await fixture.wait(state => state.phase === 'idle');
    expect(await fixture.page.getAttribute('body', 'data-clicked')).toBe('yes');
    expect(fixture.state.notes.map(note => note.topic).sort()).toEqual(['A', 'B']);
    expect(fixture.state.notes.every(note => note.sourceUrl.startsWith(fixtureOrigin + '/product-'))).toBe(true);
    expect(fixture.researchCookies).toEqual(['', '']);
    const sent = fixture.bodies.join('\n');
    expect(sent).not.toContain(fixtureEmail);
    expect(sent).not.toContain(fixturePassword);
    expect(fixture.state.request).toBeUndefined();
    expect(fixture.state.permission).toBeUndefined();
  } finally { await fixture.close(); }
});

test('Stop cancels a pending information dialog and closes the actual browser before stale input can be accepted', async () => {
  const fixture = await workspaceFixture((body, step) => step === 0
    ? { tool: 'navigate', args: { url: fixtureOrigin + '/login' } }
    : { tool: 'request_information', args: { fieldId: lastObservation(body).fields.find(field => field.kind === 'email')!.id } });
  try {
    await fixture.engine.command({ action: 'workspace-send', prompt: 'Sign in' });
    const waiting = await fixture.wait(state => !!state.request);
    const page = fixture.page;
    await fixture.engine.stop();
    expect(page.isClosed()).toBe(true);
    expect(fixture.state.request).toBeUndefined();
    expect(fixture.state.grants).toEqual([]);
    await expect(fixture.engine.command({ action: 'workspace-provide', requestId: waiting.request!.id, value: fixtureEmail, save: false })).rejects.toThrow();
    expect(fixture.bodies.join('\n')).not.toContain(fixtureEmail);
  } finally { await fixture.close(); }
});

test('a denied existing-variable permission leaves the field untouched and does not expose its value', async () => {
  const fixture = await workspaceFixture((body, step) => {
    if (step === 0) return { tool: 'navigate', args: { url: fixtureOrigin + '/login' } };
    if (step === 1) return { tool: 'request_information', args: { fieldId: lastObservation(body).fields.find(field => field.kind === 'password')!.id } };
    return { tool: 'finish_task', args: { answer: 'User denied the disclosure.' } };
  }, { knownPassword: true });
  try {
    await fixture.engine.command({ action: 'workspace-send', prompt: 'Fill the password' });
    const waiting = await fixture.wait(state => !!state.permission);
    await fixture.engine.command({ action: 'workspace-permission', permissionId: waiting.permission!.id, allow: false });
    await fixture.wait(state => state.phase === 'idle');
    expect(await fixture.page.locator('#password').inputValue()).toBe('');
    expect(fixture.bodies.join('\n')).not.toContain(fixturePassword);
  } finally { await fixture.close(); }
});

test('a named variable-group grant authorizes host fills for one task without authorizing the website click', async () => {
  let observed: BrowserObservation;
  const fixture = await workspaceFixture((body, step) => {
    if (step === 0) return { tool: 'navigate', args: { url: fixtureOrigin + '/login' } };
    if (step === 1) { observed = lastObservation(body); return { tool: 'request_information', args: { fieldId: observed.fields.find(field => field.kind === 'email')!.id } }; }
    if (step === 2) return { tool: 'request_information', args: { fieldId: observed.fields.find(field => field.kind === 'password')!.id } };
    if (step === 3) return { tool: 'click', args: { actionId: observed.actions[0]!.id } };
    return { tool: 'finish_task', args: { answer: 'No click was permitted.' } };
  }, { knownPassword: true, knownEmail: true });
  try {
    await fixture.engine.command({ action: 'workspace-settings', settings: { ...fixture.state.settings, model: { ...fixture.state.settings.model }, groups: [{ id: 'login', name: 'Login details', variables: ['Email', 'Password'] }] } });
    await fixture.engine.command({ action: 'workspace-grant', origin: fixtureOrigin, group: 'login' });
    await fixture.engine.command({ action: 'workspace-send', prompt: 'Use my approved login details.' });
    const waiting = await fixture.wait(state => !!state.permission || !!state.request);
    expect(waiting.permission?.type).toBe('action');
    expect(await fixture.page.locator('#email').inputValue()).toBe(fixtureEmail);
    expect(await fixture.page.locator('#password').inputValue()).toBe(fixturePassword);
    expect(await fixture.page.getAttribute('body', 'data-clicked')).toBeNull();
    await fixture.engine.stop();
    expect(fixture.state.grants).toEqual([]);
  } finally { await fixture.close(); }
});

for (const viaPopup of [false, true]) test(`revoking a ${viaPopup ? 'popup-created' : 'preapproved'} grant during retrieval closes the browser before late disclosure`, async () => {
  const read = Promise.withResolvers<void>();
  const fixture = await workspaceFixture((body, step) => {
    if (step === 0) return { tool: 'navigate', args: { url: fixtureOrigin + '/login' } };
    if (step === 1) return { tool: 'request_information', args: { fieldId: lastObservation(body).fields.find(field => field.kind === 'password')!.id } };
    return { tool: 'finish_task', args: { answer: 'Finished' } };
  }, { knownPassword: true, gateRead: read.promise });
  try {
    if (!viaPopup) await fixture.engine.command({ action: 'workspace-grant', origin: fixtureOrigin, names: ['Password'] });
    await fixture.engine.command({ action: 'workspace-send', prompt: 'Fill approved password' });
    if (viaPopup) {
      await fixture.wait(state => state.permission?.type === 'variable');
      await fixture.engine.command({ action: 'workspace-grant', origin: fixtureOrigin, names: ['Password'] });
    }
    const grant = fixture.state.grants[0]!;
    await fixture.readStarted;
    const closed = fixture.page.waitForEvent('close', { timeout: 3000 });
    const revoking = fixture.engine.command({ action: 'workspace-revoke', grantId: grant.id });
    try { await closed; expect(fixture.page.isClosed()).toBe(true); }
    finally { read.resolve(); await revoking; }
  } finally {
    read.resolve();
    await fixture.close();
  }
  expect(fixture.bodies.join('\n')).not.toContain(fixturePassword);
});

test('a follow-up cancels a waiting disclosure and retains the earlier conversation without retaining its browser authority', async () => {
  const fixture = await workspaceFixture((body, step) => {
    if (step === 0) return { tool: 'navigate', args: { url: fixtureOrigin + '/login' } };
    if (step === 1) return { tool: 'request_information', args: { fieldId: lastObservation(body).fields.find(field => field.kind === 'email')!.id } };
    const context = body.messages.map(message => message.content).join('\n');
    return { tool: 'finish_task', args: { answer: context.includes('First goal: compare speakers') && context.includes('Cancel login and explain next steps') ? 'Login cancelled; I can continue researching public speaker specifications.' : 'Conversation context was lost.' } };
  });
  try {
    await fixture.engine.command({ action: 'workspace-send', prompt: 'First goal: compare speakers' });
    const waiting = await fixture.wait(state => !!state.request);
    const oldPage = fixture.page;
    await fixture.engine.command({ action: 'workspace-send', prompt: 'Cancel login and explain next steps' });
    const finished = await fixture.wait(state => state.phase === 'idle');
    expect(oldPage.isClosed()).toBe(true);
    expect(finished.request).toBeUndefined();
    expect(finished.grants).toEqual([]);
    expect(finished.messages.at(-1)?.content).toBe('Login cancelled; I can continue researching public speaker specifications.');
    await expect(fixture.engine.command({ action: 'workspace-provide', requestId: waiting.request!.id, value: fixtureEmail, save: false })).rejects.toThrow();
  } finally { await fixture.close(); }
});

for (const throughLink of [false, true]) test(`a ${throughLink ? 'link click' : 'navigation tool call'} after private filling cannot bypass action approval`, async () => {
  let observed: BrowserObservation;
  const fixture = await workspaceFixture((body, step) => {
    if (step === 0) return { tool: 'navigate', args: { url: fixtureOrigin + '/login' } };
    if (step === 1) { observed = lastObservation(body); return { tool: 'request_information', args: { fieldId: observed.fields.find(field => field.kind === 'password')!.id } }; }
    if (step === 2) return throughLink ? { tool: 'click', args: { actionId: observed.actions.find(action => action.kind === 'link')!.id } } : { tool: 'navigate', args: { url: fixtureOrigin + '/product-a' } };
    return { tool: 'finish_task', args: { answer: 'Navigation was declined. No product request was made.' } };
  }, { knownPassword: true });
  try {
    await fixture.engine.command({ action: 'workspace-send', prompt: 'Fill password, then open product details.' });
    const filling = await fixture.wait(state => state.permission?.type === 'variable');
    await fixture.engine.command({ action: 'workspace-permission', permissionId: filling.permission!.id, allow: true });
    const navigating = await fixture.wait(state => state.permission?.type === 'action');
    expect(fixture.page.url()).toBe(fixtureOrigin + '/login');
    expect(fixture.researchCookies).toEqual([]);
    await fixture.engine.command({ action: 'workspace-permission', permissionId: navigating.permission!.id, allow: false });
    await fixture.wait(state => state.phase === 'idle');
    expect(fixture.page.url()).toBe(fixtureOrigin + '/login');
    expect(fixture.researchCookies).toEqual([]);
  } finally { await fixture.close(); }
});

test('source notes accept exact evidence, discard unsupported interpretations and reject invented quotes', async () => {
  const fixture = await workspaceFixture((body, step) => {
    if (step === -1) {
      const input = JSON.parse(body.messages[1]!.content);
      return input.page.url.endsWith('/product-a')
        ? { findings: [{ claim: 'Fabricated power: 999W', evidence: 'Price Rs 1499. Battery 12 hours.' }] }
        : { findings: [{ evidence: 'Battery 999 hours.' }] };
    }
    if (step === 0) return { tool: 'navigate', args: { url: fixtureOrigin + '/login' } };
    if (step === 1) return { tool: 'spawn_subagents', args: { tasks: [{ name: 'Speaker A', goal: 'Record specifications', url: fixtureOrigin + '/product-a' }, { name: 'Speaker B', goal: 'Record specifications', url: fixtureOrigin + '/product-b' }] } };
    return { tool: 'finish_task', args: { answer: 'Only supported source quotes were recorded.' } };
  });
  try {
    await fixture.engine.command({ action: 'workspace-send', prompt: 'Verify the speaker specifications.' });
    const completed = await fixture.wait(state => state.phase === 'idle');
    expect(completed.notes.map(({ content, sourceUrl }) => ({ content, sourceUrl }))).toEqual([{ content: 'Price Rs 1499. Battery 12 hours.', sourceUrl: fixtureOrigin + '/product-a' }]);
    expect(fixture.bodies.join('\n')).not.toContain('Fabricated power: 999W');
    expect(fixture.bodies.join('\n')).not.toContain('Battery 999 hours.');
  } finally { await fixture.close(); }
});
