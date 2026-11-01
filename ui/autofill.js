'use strict';
(() => {
  const byId = id => document.getElementById(id);
  const isNative = typeof window.autoMateAutofill === 'function';

  let csrfToken = '';
  let updateSequence = 0;
  let pollTimer = null;
  let isPolling = false;
  let isBusy = false;
  let clearApiKeyRequested = false;
  let localSettingsDraft = null;
  let connectionReady = isNative;
  let pollController;
  let pollEpoch = 0;
  let frameGeneration = 0;
  let activeRequestId = '';
  let commandCount = 0;

  let localState = {
    phase: 'idle',
    messages: [],
    notes: [],
    settings: {
      model: { mode: 'cloud', preset: 'openai', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o', keyConfigured: false },
      navigation: { mode: 'blacklist', domains: [] },
      memory: { enabled: false, content: '' },
      groups: []
    },
    variables: [],
    grants: [],
    origin: '',
    error: ''
  };

  const PROVIDER_PRESETS = {
    openai: {
      mode: 'cloud',
      endpoint: 'https://api.openai.com/v1',
      models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'gpt-4-turbo']
    },
    groq: {
      mode: 'cloud',
      endpoint: 'https://api.groq.com/openai/v1',
      models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768']
    },
    openrouter: {
      mode: 'cloud',
      endpoint: 'https://openrouter.ai/api/v1',
      models: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-chat']
    },
    ollama: {
      mode: 'local',
      endpoint: 'http://localhost:11434/v1',
      models: ['llama3.2', 'llama3.1', 'qwen2.5:7b', 'mistral', 'deepseek-r1']
    },
    lmstudio: {
      mode: 'local',
      endpoint: 'http://localhost:1234/v1',
      models: []
    },
    custom: {
      mode: 'cloud',
      endpoint: '',
      models: []
    }
  };

  // Error Banner handling
  function showError(msg) {
    const banner = byId('global-error-banner');
    const text = byId('global-error-text');
    if (banner && text) {
      if (msg) {
        text.textContent = msg;
        banner.hidden = false;
      } else {
        banner.hidden = true;
        text.textContent = '';
      }
    }
  }

  // Unified Command Transport
  async function sendCommand(command) {
    commandCount++; isBusy = true;
    updateControls();
    showError('');
    try {
      if (!connectionReady && !['workspace-init', 'workspace-stop'].includes(command.action)) throw new Error('Connection unavailable. Wait for the workspace to reconnect.');
      if (isNative) {
        await window.autoMateAutofill(command);
      } else {
        const response = await fetch('/api/command', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken
          },
          body: JSON.stringify(command),
          signal: AbortSignal.timeout(30000)
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.message || body.error || `Command failed (${response.status})`);
        }
      }
      return true;
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      commandCount--; isBusy = commandCount > 0;
      updateControls();
    }
  }

  // Incoming Update Handler (workspace state or frame)
  function handleIncomingUpdate(update) {
    if (!update || typeof update !== 'object') return;

    if (document.visibilityState === 'hidden') return;
    if (update.kind === 'workspace') {
      if (update.state && typeof update.state === 'object') {
        renderWorkspaceState(update.state);
      }
    } else if (update.kind === 'workspace-frame') {
      void renderFrame(update.frame ?? null);
    }
  }

  // Expose binding immediately for native Playwright detection
  window.autoMateAutofillUpdate = handleIncomingUpdate;

  // Polling for Hosted Mode
  function disconnect(message) {
    connectionReady = false;
    updateSequence = 0;
    clearSensitiveFields();
    clearFrame(message);
    activeRequestId = '';
    for (const id of ['permission-modal', 'credential-modal', 'add-variable-modal', 'settings-modal']) {
      const dialog = byId(id); if (dialog?.open) dialog.close();
    }
    updateControls();
  }
  async function pollUpdates() {
    if (isPolling || document.visibilityState === 'hidden' || isNative) return;
    isPolling = true;
    const epoch = pollEpoch;
    const controller = new AbortController(); pollController = controller;
    try {
      const res = await fetch(`/api/updates?after=${updateSequence}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
      if (epoch !== pollEpoch || document.visibilityState === 'hidden') return;
      if (res.status === 401) { disconnect('Session expired.'); window.location.replace('/login'); return; }
      if (!res.ok) throw new Error(`Workspace disconnected (HTTP ${res.status}).`);
      const data = await res.json();
      if (epoch !== pollEpoch || document.visibilityState === 'hidden') return;
      if (typeof data.sequence !== 'number' || !Array.isArray(data.updates)) throw new Error('Invalid workspace update.');
      connectionReady = true;
      updateSequence = data.sequence;
      for (const update of data.updates) handleIncomingUpdate(update);
      updateControls();
    } catch {
      if (epoch === pollEpoch && document.visibilityState !== 'hidden') disconnect('Connection lost. Controls locked; the host stops unattended sessions after five seconds.');
    } finally {
      if (pollController === controller) pollController = undefined;
      isPolling = false;
    }
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(pollUpdates, 500);
    pollUpdates();
  }

  // Security: Clear sensitive fields and frame on blur/hide
  function clearSensitiveFields() {
    const secretIds = ['cred-value-input', 'new-var-val', 'setting-model-apikey'];
    for (const id of secretIds) {
      const el = byId(id);
      if (el) el.value = '';
    }
  }

  function clearFrame(message = 'No live browser preview. Send an instruction to start.') {
    ++frameGeneration;
    const img = byId('frame-image'); if (img) img.removeAttribute('src');
    const canvas = byId('canvas'); if (canvas) canvas.hidden = true;
    const empty = byId('frame-empty'); if (empty) { empty.hidden = false; empty.textContent = message; }
  }

  document.addEventListener('visibilitychange', () => {
    ++pollEpoch; pollController?.abort();
    if (document.visibilityState === 'hidden') {
      disconnect('Preview paused while this window is in the background.');
    } else if (isNative) {
      connectionReady = true;
      sendCommand({ action: 'workspace-init' });
    } else {
      updateSequence = 0; pollUpdates();
    }
  });

  // Message sanitization (strip model reasoning / CoT)
  function cleanText(raw) {
    if (!raw) return '';
    return raw
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/```thought[\s\S]*?```/gi, '')
      .trim();
  }

  function renderMessages(messages) {
    const container = byId('chat-messages');
    if (!container) return;

    const intro = container.querySelector('.chat-bubble.intro');
    container.replaceChildren();
    if (intro) container.appendChild(intro);

    for (const msg of messages) {
      const text = cleanText(msg.content);
      if (!text && msg.role === 'assistant') continue;

      const bubble = document.createElement('div');
      bubble.className = `chat-bubble ${msg.role}`;
      bubble.dataset.messageId = msg.id;

      if (msg.role === 'subagent') {
        const meta = document.createElement('div');
        meta.className = 'bubble-meta';
        meta.textContent = `Subagent: ${msg.agent || 'Evaluator'}`;
        bubble.appendChild(meta);
      } else if (msg.role === 'tool') {
        const meta = document.createElement('div');
        meta.className = 'bubble-meta';
        meta.textContent = 'Browser Action';
        bubble.appendChild(meta);
      }

      const p = document.createElement('p');
      p.textContent = text;
      bubble.appendChild(p);

      container.appendChild(bubble);
    }

    container.scrollTop = container.scrollHeight;
  }

  // DOM-safe plain text notes rendering
  function renderNotes(notes) {
    const container = byId('notes-space-list');
    if (!container) return;
    container.replaceChildren();

    if (!notes || notes.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-hint';
      p.textContent = 'No notes taken yet.';
      container.appendChild(p);
      return;
    }

    for (const note of notes) {
      const card = document.createElement('article');
      card.className = 'note-card item-card';

      const header = document.createElement('div');
      header.className = 'note-header';

      const topic = document.createElement('strong');
      topic.className = 'note-topic';
      topic.textContent = note.topic || 'Note';
      header.appendChild(topic);

      if (note.agent) {
        const agentBadge = document.createElement('span');
        agentBadge.className = 'badge agent-badge';
        agentBadge.textContent = note.agent;
        header.appendChild(agentBadge);
      }

      if (note.timestamp) {
        const time = document.createElement('time');
        time.className = 'note-time';
        time.textContent = new Date(note.timestamp).toLocaleTimeString();
        header.appendChild(time);
      }
      card.appendChild(header);

      const body = document.createElement('p');
      body.className = 'note-content';
      body.textContent = note.content;
      card.appendChild(body);

      if (note.sourceUrl) {
        const footer = document.createElement('div');
        footer.className = 'note-footer';

        const label = document.createElement('span');
        label.textContent = 'Source: ';
        footer.appendChild(label);

        const link = document.createElement('a');
        link.className = 'note-source-link';
        link.href = note.sourceUrl;
        link.textContent = note.sourceUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        footer.appendChild(link);

        card.appendChild(footer);
      }

      container.appendChild(card);
    }
  }

  // Vault Variables rendering (Names/descriptions visible; values NEVER rendered)
  function renderVariables(variables, activeOrigin) {
    const container = byId('vault-variables-list');
    if (!container) return;
    container.replaceChildren();

    if (!variables || variables.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-hint';
      p.textContent = 'No variables stored in vault yet. Click "+ Add Variable" to save encrypted credentials.';
      container.appendChild(p);
      return;
    }

    for (const v of variables) {
      const card = document.createElement('div');
      card.className = 'item-card variable-card';

      const info = document.createElement('div');
      info.className = 'item-card-info';

      const titleRow = document.createElement('div');
      titleRow.className = 'variable-title-row';

      const name = document.createElement('strong');
      name.textContent = v.name;
      titleRow.appendChild(name);

      const kindBadge = document.createElement('span');
      kindBadge.className = `badge kind-badge kind-${v.kind}`;
      kindBadge.textContent = v.kind;
      titleRow.appendChild(kindBadge);

      const scopeBadge = document.createElement('span');
      scopeBadge.className = `badge scope-badge scope-${v.scope}`;
      scopeBadge.textContent = v.scope === 'site' ? 'Site-bound' : 'Shared profile';
      titleRow.appendChild(scopeBadge);

      if (v.available === false) {
        const unavail = document.createElement('span');
        unavail.className = 'badge';
        unavail.textContent = 'Unavailable';
        titleRow.appendChild(unavail);
      }

      info.appendChild(titleRow);

      const desc = document.createElement('p');
      desc.className = 'variable-desc';
      desc.textContent = v.description;
      info.appendChild(desc);

      card.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'item-card-actions';

      if (activeOrigin) {
        const grantBtn = document.createElement('button');
        grantBtn.type = 'button';
        grantBtn.className = 'compact-button';
        grantBtn.textContent = 'Grant to site';
        grantBtn.disabled = v.available === false;
        grantBtn.title = `Grant this variable to ${activeOrigin}`;
        grantBtn.addEventListener('click', () => {
          sendCommand({ action: 'workspace-grant', origin: activeOrigin, names: [v.name] });
        });
        actions.appendChild(grantBtn);
      }

      card.appendChild(actions);
      container.appendChild(card);
    }
  }

  // Active Grants rendering
  function renderGrants(grants) {
    const container = byId('ongoing-permissions-list');
    if (!container) return;
    container.replaceChildren();

    if (!grants || grants.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-hint';
      p.textContent = 'No ongoing permissions granted yet.';
      container.appendChild(p);
      return;
    }

    for (const grant of grants) {
      const card = document.createElement('div');
      card.className = 'item-card grant-card';

      const info = document.createElement('div');
      info.className = 'item-card-info';

      const origin = document.createElement('strong');
      origin.textContent = grant.origin;
      info.appendChild(origin);

      const vars = document.createElement('p');
      vars.className = 'grant-variables-text';
      vars.textContent = `Variables: ${grant.names.join(', ')}`;
      info.appendChild(vars);

      if (grant.group) {
        const groupSpan = document.createElement('span');
        groupSpan.className = 'badge group-badge';
        groupSpan.textContent = `Group: ${grant.group}`;
        info.appendChild(groupSpan);
      }

      if (grant.task) {
        const taskSpan = document.createElement('span');
        taskSpan.className = 'grant-task-text';
        taskSpan.textContent = `Task: ${grant.task}`;
        info.appendChild(taskSpan);
      }

      card.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'item-card-actions';

      const revokeBtn = document.createElement('button');
      revokeBtn.type = 'button';
      revokeBtn.className = 'compact-button danger-btn';
      revokeBtn.textContent = 'Revoke';
      revokeBtn.title = 'Revoke variable permissions for this site';
      revokeBtn.addEventListener('click', () => {
        sendCommand({ action: 'workspace-revoke', grantId: grant.id });
      });
      actions.appendChild(revokeBtn);

      card.appendChild(actions);
      container.appendChild(card);
    }
  }

  // Quick Grant selection options
  function updateQuickGrantOptions(variables, groups, activeOrigin) {
    const select = byId('quick-grant-select');
    const btn = byId('quick-grant-submit-btn');
    const label = byId('quick-grant-origin-label');
    if (!select || !btn) return;

    if (label) {
      label.textContent = activeOrigin ? `Grant to active site (${activeOrigin}):` : 'Grant to site (No active site):';
    }

    const prevVal = select.value;
    select.replaceChildren();

    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '-- Select Variable or Group --';
    select.appendChild(defaultOpt);

    if (groups && groups.length > 0) {
      const groupOptGroup = document.createElement('optgroup');
      groupOptGroup.label = 'Variable Groups';
      for (const g of groups) {
        const opt = document.createElement('option');
        opt.value = `group:${g.id}`;
        opt.textContent = `Group: ${g.name} (${g.variables.length} vars)`;
        groupOptGroup.appendChild(opt);
      }
      select.appendChild(groupOptGroup);
    }

    if (variables && variables.length > 0) {
      const varOptGroup = document.createElement('optgroup');
      varOptGroup.label = 'Individual Variables';
      for (const v of variables) {
        const opt = document.createElement('option');
        opt.value = `var:${v.name}`;
        opt.disabled = v.available === false;
        opt.textContent = `${v.name} (${v.kind})`;
        varOptGroup.appendChild(opt);
      }
      select.appendChild(varOptGroup);
    }

    if (prevVal) select.value = prevVal;
    btn.disabled = !activeOrigin || !select.value;
  }

  // Pending Permission Modal (WorkspacePermission)
  function handlePermissionModal(perm) {
    const dialog = byId('permission-modal');
    if (!dialog) return;

    dialog.oncancel = event => {
      event.preventDefault();
      if (perm) sendCommand({ action: 'workspace-permission', permissionId: perm.id, allow: false });
    };
    if (!perm) {
      if (dialog.open) dialog.close();
      return;
    }

    byId('perm-origin').textContent = perm.origin;
    byId('perm-title').textContent = perm.type === 'variable' ? 'Variable Permission Requested' : 'Action Permission Requested';
    byId('perm-type-badge').textContent = perm.type;
    byId('perm-label').textContent = perm.label;
    byId('perm-desc').textContent = perm.description;

    const metaBox = byId('perm-meta');
    metaBox.replaceChildren();
    if (perm.variableName) {
      const pVar = document.createElement('p');
      pVar.textContent = `Variable: ${perm.variableName}${perm.variableDescription ? ` (${perm.variableDescription})` : ''}`;
      metaBox.appendChild(pVar);
    }
    if (perm.kind) {
      const pKind = document.createElement('p');
      pKind.textContent = `Kind: ${perm.kind}`;
      metaBox.appendChild(pKind);
    }
    if (perm.fieldId) {
      const pField = document.createElement('p');
      pField.textContent = `Field ID: ${perm.fieldId}`;
      metaBox.appendChild(pField);
    }

    const controls = byId('perm-grant-controls');
    const selector = byId('perm-grant-scope');
    selector.replaceChildren();
    const grantable = perm.type === 'variable' && localState.variables.filter(variable => variable.available && variable.name === perm.variableName).length === 1;
    controls.hidden = !grantable;
    byId('perm-allow-btn').textContent = perm.type === 'variable' ? 'Allow this fill once' : 'Allow this action once';
    if (grantable) {
      const individual = document.createElement('option'); individual.value = ''; individual.textContent = `Only ${perm.variableName}`; selector.appendChild(individual);
      for (const group of localState.settings.groups.filter(group => group.variables.includes(perm.variableName))) {
        const option = document.createElement('option'); option.value = group.id; option.textContent = `Group: ${group.name}`;
        option.disabled = group.variables.some(name => localState.variables.filter(variable => variable.available && variable.name === name).length !== 1);
        selector.appendChild(option);
      }
      byId('perm-grant-btn').onclick = async () => {
        const command = { action: 'workspace-grant', origin: perm.origin, ...(selector.value ? { group: selector.value } : { names: [perm.variableName] }) };
        if (await sendCommand(command)) dialog.close();
      };
    }
    byId('perm-allow-btn').onclick = () => {
      sendCommand({ action: 'workspace-permission', permissionId: perm.id, allow: true });
      dialog.close();
    };

    byId('perm-deny-btn').onclick = () => {
      sendCommand({ action: 'workspace-permission', permissionId: perm.id, allow: false });
      dialog.close();
    };

    byId('perm-stop-btn').onclick = () => {
      sendCommand({ action: 'workspace-stop' });
      dialog.close();
    };

    if (!dialog.open) {
      dialog.showModal();
    }
  }

  // Unknown Information Request Modal (WorkspaceInformationRequest)
  function handleInformationRequestModal(req) {
    const dialog = byId('credential-modal');
    if (!dialog) return;

    dialog.oncancel = event => { event.preventDefault(); clearSensitiveFields(); sendCommand({ action: 'workspace-stop' }); };
    dialog.onclose = () => { byId('cred-value-input').value = ''; };
    if (!req) {
      activeRequestId = '';
      byId('cred-value-input').value = '';
      if (dialog.open) dialog.close();
      return;
    }

    byId('cred-origin-banner').textContent = req.origin;
    const nameInput = byId('cred-name-input');
    const descInput = byId('cred-desc-input');
    const valInput = byId('cred-value-input');
    const scopeSelect = byId('cred-var-scope');
    const scopeNotice = byId('cred-scope-notice');
    const saveCheck = byId('cred-save-check');

    if (activeRequestId !== req.id) {
      activeRequestId = req.id;
      nameInput.value = req.name || req.fieldId;
      descInput.value = req.description || `Value for field ${req.fieldId}`;
      valInput.value = '';
      saveCheck.checked = true;
      scopeSelect.value = 'site';
    }
    valInput.type = 'password';

    const isCredential = req.kind === 'password' || req.kind === 'username';
    if (isCredential) {
      scopeSelect.value = 'site';
      scopeSelect.disabled = true;
      scopeNotice.textContent = 'Usernames and passwords must be restricted to this site.';
    } else {
      scopeSelect.disabled = false;
      scopeNotice.textContent = '';
    }

    byId('credential-form').onsubmit = (e) => {
      e.preventDefault();
      const value = valInput.value;
      const name = nameInput.value.trim();
      const desc = descInput.value.trim();
      const scope = scopeSelect.value;
      const save = saveCheck.checked;

      valInput.value = '';
      dialog.close();

      sendCommand({
        action: 'workspace-provide',
        requestId: req.id,
        value,
        save,
        name,
        description: desc,
        scope
      });
    };

    byId('cred-skip-btn').onclick = () => {
      valInput.value = '';
      dialog.close();
      sendCommand({ action: 'workspace-skip', requestId: req.id });
    };

    byId('cred-stop-btn').onclick = () => {
      valInput.value = '';
      dialog.close();
      sendCommand({ action: 'workspace-stop' });
    };

    if (!dialog.open) {
      dialog.showModal();
    }
  }

  async function renderFrame(frame) {
    if (document.visibilityState === 'hidden' || !connectionReady) return;
    if (!frame || typeof frame.image !== 'string' || !frame.image.startsWith('iVBORw0KGgo') || !/^[A-Za-z0-9+/=]+$/.test(frame.image)) { clearFrame(); return; }
    const generation = ++frameGeneration;
    const next = new Image(); next.src = 'data:image/png;base64,' + frame.image;
    try { await next.decode(); } catch { if (generation === frameGeneration) clearFrame('Preview image could not be verified.'); return; }
    if (generation !== frameGeneration || document.visibilityState === 'hidden' || !connectionReady) return;
    byId('frame-image').src = next.src;
    byId('canvas').hidden = false;
    byId('frame-empty').hidden = true;
  }

  // Workspace State update orchestrator
  function renderWorkspaceState(state) {
    localState = state;

    // Status Badge
    const badge = byId('agent-status-badge');
    if (badge) {
      const phaseNames = {
        idle: 'Ready',
        running: 'Working...',
        waiting: 'Waiting for approval',
        stopped: 'Stopped',
        failed: 'Attention required'
      };
      badge.textContent = phaseNames[state.phase] || state.phase;
      badge.className = `status-badge ${state.phase}`;
    }

    // Active Origin Badge
    const originBadge = byId('active-origin-badge');
    if (originBadge) {
      if (state.origin) {
        originBadge.hidden = false;
        originBadge.textContent = state.origin;
      } else {
        originBadge.hidden = true;
      }
    }

    // Error
    if (state.error) {
      showError(state.error);
    }

    // Messages
    if (Array.isArray(state.messages)) {
      renderMessages(state.messages);
    }

    // Notes
    if (Array.isArray(state.notes)) {
      renderNotes(state.notes);
    }

    // Variables
    if (Array.isArray(state.variables)) {
      renderVariables(state.variables, state.origin);
    }

    // Grants
    if (Array.isArray(state.grants)) {
      renderGrants(state.grants);
    }

    // Quick Grant
    updateQuickGrantOptions(state.variables, state.settings?.groups, state.origin);

    // Dialogs
    handlePermissionModal(state.permission);
    handleInformationRequestModal(state.request);

    updateControls();
  }

  function updateControls() {
    const isRunning = localState.phase === 'running';
    const isWaiting = localState.phase === 'waiting';

    const sendBtn = byId('chat-send-btn');
    const stopBtn = byId('chat-stop-btn');
    const promptInput = byId('chat-prompt-input');

    if (sendBtn) sendBtn.disabled = isBusy || !connectionReady;
    if (promptInput) { promptInput.disabled = !connectionReady; promptInput.placeholder = isRunning || isWaiting ? 'Follow up — stops the current task first' : 'What should the agent do? Never paste secrets here.'; }
    if (stopBtn) stopBtn.disabled = !(isRunning || isWaiting || isBusy || localState.origin);
  }

  // Tabs
  function setupTabs() {
    const tabs = [
      { btn: byId('tab-variables-btn'), panel: byId('tab-variables-panel') },
      { btn: byId('tab-permissions-btn'), panel: byId('tab-permissions-panel') },
      { btn: byId('tab-notes-btn'), panel: byId('tab-notes-panel') }
    ];

    tabs.forEach(({ btn, panel }) => {
      if (!btn || !panel) return;
      btn.addEventListener('click', () => {
        tabs.forEach(t => {
          t.btn.classList.remove('active');
          t.panel.hidden = true;
        });
        btn.classList.add('active');
        panel.hidden = false;
      });
    });
  }

  // Quick Grant
  function setupQuickGrant() {
    const select = byId('quick-grant-select');
    const btn = byId('quick-grant-submit-btn');

    select?.addEventListener('change', () => {
      btn.disabled = !localState.origin || !select.value;
    });

    btn?.addEventListener('click', () => {
      const val = select.value;
      if (!val || !localState.origin) return;

      if (val.startsWith('group:')) {
        const groupId = val.slice(6);
        const group = (localState.settings?.groups || []).find(g => g.id === groupId);
        if (group) {
          sendCommand({
            action: 'workspace-grant',
            origin: localState.origin,
            names: group.variables,
            group: group.id
          });
        }
      } else if (val.startsWith('var:')) {
        const varName = val.slice(4);
        sendCommand({
          action: 'workspace-grant',
          origin: localState.origin,
          names: [varName]
        });
      }

      select.value = '';
      btn.disabled = true;
    });
  }

  // Chat Form & Stop Action
  function setupChat() {
    const form = byId('chat-form');
    const input = byId('chat-prompt-input');
    const stopBtn = byId('chat-stop-btn');

    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const prompt = input.value.trim();
      if (!prompt) return;
      input.value = '';
      sendCommand({ action: 'workspace-send', prompt });
    });

    stopBtn?.addEventListener('click', () => {
      sendCommand({ action: 'workspace-stop' });
    });
  }

  // Add Variable Modal
  function setupAddVariableModal() {
    const dialog = byId('add-variable-modal');
    const form = byId('add-variable-form');
    const kindSelect = byId('new-var-kind');
    const scopeSelect = byId('new-var-scope');
    const originInput = byId('new-var-origin');
    const originStar = byId('origin-required-star');
    const originHint = byId('new-var-origin-hint');

    dialog.addEventListener('close', () => { byId('new-var-val').value = ''; });
    byId('open-add-var-btn')?.addEventListener('click', () => {
      byId('new-var-name').value = '';
      byId('new-var-desc').value = '';
      byId('new-var-val').value = '';
      if (localState.origin) {
        originInput.value = localState.origin;
      }
      updateScopeRules();
      dialog.showModal();
    });

    byId('close-add-var-btn')?.addEventListener('click', () => {
      byId('new-var-val').value = '';
      dialog.close();
    });

    byId('close-add-var-x')?.addEventListener('click', () => {
      byId('new-var-val').value = '';
      dialog.close();
    });

    byId('new-var-use-current-origin')?.addEventListener('click', () => {
      if (localState.origin) {
        originInput.value = localState.origin;
      }
    });

    function updateScopeRules() {
      const kind = kindSelect.value;
      const isCred = kind === 'password' || kind === 'username';
      if (isCred) {
        scopeSelect.value = 'site';
        const profileOpt = scopeSelect.querySelector('option[value="profile"]');
        if (profileOpt) profileOpt.disabled = true;
      } else {
        const profileOpt = scopeSelect.querySelector('option[value="profile"]');
        if (profileOpt) profileOpt.disabled = false;
      }

      const isSite = scopeSelect.value === 'site';
      originInput.required = isSite;
      if (originStar) originStar.hidden = !isSite;
      if (originHint) {
        originHint.textContent = isSite ? 'Mandatory for site-bound variables (e.g. https://amazon.in)' : 'Optional for shared profile variables';
      }
    }

    kindSelect.addEventListener('change', updateScopeRules);
    scopeSelect.addEventListener('change', updateScopeRules);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = byId('new-var-name').value.trim();
      const description = byId('new-var-desc').value.trim();
      const valInput = byId('new-var-val');
      const value = valInput.value;
      const kind = kindSelect.value;
      const scope = scopeSelect.value;
      const origin = originInput.value.trim() || (scope === 'profile' ? 'https://profile.auto-mate.invalid' : '');

      if (scope === 'site' && !origin) {
        showError('Origin URL is mandatory for site-bound variables.');
        return;
      }

      valInput.value = '';
      dialog.close();

      sendCommand({
        action: 'workspace-save-variable',
        input: {
          name,
          description,
          value,
          kind,
          scope,
          origin
        }
      });
    });
  }

  // Settings Modal
  function setupSettingsModal() {
    const dialog = byId('settings-modal');
    const presetSelect = byId('setting-model-preset');
    const modeSelect = byId('setting-model-mode');
    const endpointInput = byId('setting-model-endpoint');
    const apiKeyInput = byId('setting-model-apikey');
    const modelNameInput = byId('setting-model-name');
    const datalist = byId('model-presets-datalist');
    const clearKeyBtn = byId('setting-clear-apikey-btn');
    dialog.addEventListener('close', () => { apiKeyInput.value = ''; });
    if (!isNative) {
      for (const value of ['ollama', 'lmstudio']) presetSelect.querySelector(`option[value="${value}"]`).disabled = true;
      modeSelect.querySelector('option[value="local"]').disabled = true;
    }
    const keyStatus = byId('setting-key-status');

    function updateDatalist(presetKey) {
      const preset = PROVIDER_PRESETS[presetKey];
      datalist.replaceChildren();
      if (preset && preset.models) {
        for (const m of preset.models) {
          const opt = document.createElement('option');
          opt.value = m;
          datalist.appendChild(opt);
        }
      }
    }

    presetSelect.addEventListener('change', () => {
      const presetKey = presetSelect.value;
      const preset = PROVIDER_PRESETS[presetKey];
      if (preset) {
        modeSelect.value = preset.mode;
        endpointInput.value = preset.endpoint;
        updateDatalist(presetKey);
        modelNameInput.value = '';
        modelNameInput.placeholder = 'Enter the exact model ID served by this provider';
      }
    });

    clearKeyBtn.addEventListener('click', () => {
      clearApiKeyRequested = true;
      apiKeyInput.value = '';
      apiKeyInput.placeholder = 'API key will be removed on Save';
      keyStatus.textContent = 'To be cleared';
      keyStatus.className = 'key-status-badge';
    });

    byId('open-settings-btn')?.addEventListener('click', () => {
      clearApiKeyRequested = false;
      apiKeyInput.value = '';

      const s = localState.settings;
      if (s && s.model) {
        presetSelect.value = s.model.preset || 'openai';
        modeSelect.value = s.model.mode || 'cloud';
        endpointInput.value = s.model.endpoint || '';
        modelNameInput.value = s.model.model || '';
        updateDatalist(presetSelect.value);

        if (s.model.keyConfigured) {
          keyStatus.textContent = 'Configured on host';
          keyStatus.className = 'key-status-badge configured';
          apiKeyInput.placeholder = '●●●●●●●● (Leave blank to keep unchanged)';
        } else {
          keyStatus.textContent = 'Not configured';
          keyStatus.className = 'key-status-badge';
          apiKeyInput.placeholder = 'sk-... (Enter API key)';
        }
      }

      if (s && s.navigation) {
        const radios = document.getElementsByName('nav-mode');
        for (const r of radios) {
          r.checked = r.value === s.navigation.mode;
        }
        byId('setting-nav-domains').value = (s.navigation.domains || []).join(', ');
      }

      if (s && s.memory) {
        byId('setting-memory-toggle').checked = !!s.memory.enabled;
        byId('setting-memory-content').value = s.memory.content || '';
      }

      localSettingsDraft = {
        groups: s.groups ? JSON.parse(JSON.stringify(s.groups)) : []
      };
      renderSettingsGroups(localSettingsDraft.groups);
      populateGroupVarChecklist(localState.variables);

      dialog.showModal();
    });

    byId('close-settings-btn')?.addEventListener('click', () => {
      apiKeyInput.value = '';
      dialog.close();
    });

    byId('close-settings-x')?.addEventListener('click', () => {
      apiKeyInput.value = '';
      dialog.close();
    });

    byId('settings-form')?.addEventListener('submit', (e) => {
      e.preventDefault();

      const mode = modeSelect.value;
      const preset = presetSelect.value;
      const endpoint = endpointInput.value.trim();
      const model = modelNameInput.value.trim();

      const modelSettings = {
        mode,
        preset,
        endpoint,
        model
      };

      if (clearApiKeyRequested) {
        modelSettings.apiKey = '';
      } else if (apiKeyInput.value.trim()) {
        modelSettings.apiKey = apiKeyInput.value.trim();
      }

      apiKeyInput.value = '';

      let navMode = 'blacklist';
      const radios = document.getElementsByName('nav-mode');
      for (const r of radios) {
        if (r.checked) navMode = r.value;
      }

      const domainList = byId('setting-nav-domains').value
        .split(/[,\n]/)
        .map(d => d.trim())
        .filter(Boolean);

      const memoryEnabled = byId('setting-memory-toggle').checked;
      const memoryContent = byId('setting-memory-content').value;

      const newSettings = {
        model: modelSettings,
        navigation: {
          mode: navMode,
          domains: domainList
        },
        memory: {
          enabled: memoryEnabled,
          content: memoryContent
        },
        groups: localSettingsDraft ? localSettingsDraft.groups : (localState.settings.groups || [])
      };

      dialog.close();
      sendCommand({ action: 'workspace-settings', settings: newSettings });
    });

    byId('add-group-btn')?.addEventListener('click', () => {
      const nameInput = byId('new-group-name');
      const groupName = nameInput.value.trim();
      if (!groupName) {
        showError('Please enter a group name.');
        return;
      }

      const checkedVars = [];
      const checkboxes = byId('new-group-variables-select').querySelectorAll('input[type="checkbox"]:checked');
      for (const cb of checkboxes) {
        checkedVars.push(cb.value);
      }

      if (checkedVars.length === 0) {
        showError('Please select at least one variable for this group.');
        return;
      }

      if (!localSettingsDraft) localSettingsDraft = { groups: [] };
      localSettingsDraft.groups.push({
        id: 'grp_' + Date.now(),
        name: groupName,
        variables: checkedVars
      });

      nameInput.value = '';
      for (const cb of checkboxes) cb.checked = false;
      renderSettingsGroups(localSettingsDraft.groups);
    });
  }

  function renderSettingsGroups(groups) {
    const container = byId('settings-groups-list');
    if (!container) return;
    container.replaceChildren();

    if (!groups || groups.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-hint';
      p.textContent = 'No variable groups configured.';
      container.appendChild(p);
      return;
    }

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const item = document.createElement('div');
      item.className = 'group-item-card';

      const info = document.createElement('span');
      info.textContent = `${g.name} (${g.variables.length} vars: ${g.variables.join(', ')})`;
      item.appendChild(info);

      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'compact-button danger-btn';
      rmBtn.textContent = 'Remove';
      rmBtn.addEventListener('click', () => {
        groups.splice(i, 1);
        renderSettingsGroups(groups);
      });
      item.appendChild(rmBtn);

      container.appendChild(item);
    }
  }

  function populateGroupVarChecklist(variables) {
    const container = byId('new-group-variables-select');
    if (!container) return;
    container.replaceChildren();

    if (!variables || variables.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-hint';
      p.textContent = 'No variables available to select.';
      container.appendChild(p);
      return;
    }

    for (const v of variables) {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = v.name;
      label.appendChild(cb);
      const span = document.createElement('span');
      span.textContent = `${v.name} (${v.kind})`;
      label.appendChild(span);
      container.appendChild(label);
    }
  }

  // Hosted Mode Initialization
  async function initHosted() {
    try {
      const res = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) {
        if (res.status === 401) {
          window.location.replace('/login');
          return;
        }
        throw new Error(`Session request returned HTTP ${res.status}`);
      }
      const data = await res.json();
      csrfToken = data.csrfToken;

      const sessionBox = byId('hosted-session');
      if (sessionBox) sessionBox.hidden = false;
      const userBox = byId('hosted-user');
      if (userBox) userBox.textContent = data.username;

      byId('hosted-logout')?.addEventListener('click', async () => {
        try {
          await fetch('/api/logout', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'X-CSRF-Token': csrfToken }
          });
        } finally {
          window.location.replace('/login');
        }
      });

      await sendCommand({ action: 'workspace-init' });
      startPolling();
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  }

  // Native Mode Initialization
  function initNative() {
    sendCommand({ action: 'workspace-init' });
  }

  // App Entry Point
  function init() {
    byId('global-error-dismiss')?.addEventListener('click', () => showError(''));
    setupTabs();
    setupQuickGrant();
    setupChat();
    setupAddVariableModal();
    setupSettingsModal();

    if (isNative) {
      initNative();
    } else {
      initHosted();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();