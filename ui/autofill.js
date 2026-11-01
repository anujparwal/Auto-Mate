'use strict';
(() => {
  const byId = id => document.getElementById(id);
  const make = (tag, value, className) => {
    const node = document.createElement(tag); node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  const activePhases = new Set(['review', 'filling', 'filled', 'acting']);
  const secretInputs = ['save-username', 'save-password', 'save-cardholder', 'save-card-number', 'save-month', 'save-year', 'save-var-val'];
  const phases = { idle: 'Ready', inspecting: 'Inspecting website', review: 'Awaiting approval',
    filling: 'Authenticating / filling', filled: 'Filled · Review protected browser', acting: 'Executing approved click', stopped: 'Stopped', failed: 'Stopped · Owner attention required' };
  let state = { phase: 'idle', busy: false, fields: [], revision: 0, vault: { locked: true, entries: [] } };
  let revision = -1;
  let fieldsSignature = '';
  let recordsSignature = '';
  let localVaultLock = false;
  const selected = new Set();
  let generation = 0;
  let committedImage = '';
  let annotationSignature = '';
  let pendingImage = null;
  let pendingFrame = null;
  let pendingRevision = -1;
  let dialogRequestId = '';
  let catalogSignature = '';
  let actionsSignature = '';
  let localPermission = null;
  let permissionSignature = '';
  let csrfToken = '';
  let polling = false;
  let pollTimer;
  let pollController;
  let updateSequence = 0;
  let pollGeneration = 0;
  let connectionLost = false;
  const hostedTransport = typeof window.autoMateAutofill !== 'function';

  function originInput() {
    try {
      const url = new URL(byId('vault-origin').value);
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
      return url.origin;
    } catch { return null; }
  }
  function canReview() {
    return state.phase === 'review' && !state.busy && byId('website-url').value.trim() === state.url && byId('record-kind').value === state.kind;
  }
  function infoFieldsReady() {
    if (state.kind !== 'information') return true;
    if (state.information?.request) return false;
    if (!state.information?.planned) return false;
    for (const fieldId of selected) {
      const mapping = state.information.mappings?.find(m => m.fieldId === fieldId);
      if (!mapping || (!mapping.provided && !mapping.variableId)) return false;
    }
    return true;
  }
  function buttons() {
    const review = canReview();
    byId('inspect').disabled = state.busy;
    byId('website-url').disabled = state.busy;
    byId('record-kind').disabled = state.busy;
    const infoMode = state.kind === 'information';
    byId('fill').disabled = connectionLost || !review || !selected.size || (infoMode ? !infoFieldsReady() : !byId('record-id').value.trim());
    byId('fill').textContent = infoMode ? 'Approve selected fields & fill' : 'Approve selected fields & authenticate';
    byId('deny').disabled = !['review', 'filled'].includes(state.phase) || state.busy;
    byId('record-id').disabled = !review;
    byId('duration').disabled = !['review', 'filled'].includes(state.phase) || state.busy;
    byId('example-login').disabled = state.busy;
    byId('example-card').disabled = state.busy;
    byId('record-id').hidden = infoMode;
    document.querySelector('label[for="record-id"]').hidden = infoMode;
    byId('record-selection-status').hidden = infoMode;
    const info = state.information || {};
    byId('information-banner').hidden = !infoMode || !['review', 'filled'].includes(state.phase);
    byId('info-load-catalog').disabled = !review || !!info.request;
    const planBlocked = !review || !state.fields.length || !info.catalogLoaded || info.catalogStale || !!info.request;
    byId('info-plan').disabled = planBlocked || state.modelObservationAllowed === false || (info.mode !== 'reviewed' && !byId('info-consent').checked);
    byId('info-plan-local').disabled = planBlocked;
    byId('info-consent').disabled = !review || !!info.request || state.modelObservationAllowed === false;
    const variable = byId('vault-kind').value === 'variable';
    const credential = ['username', 'password'].includes(byId('save-var-kind').value);
    const profile = variable && !credential && byId('save-var-scope').value === 'profile';
    for (const id of ['vault-kind', 'vault-record-id', 'save-var-name', 'save-var-desc', 'save-var-kind', 'save-var-scope', ...secretInputs]) byId(id).disabled = state.busy;
    byId('vault-origin').disabled = state.busy || profile;
    byId('vault-origin').required = !profile;
    byId('vault-use-origin').disabled = state.busy || !state.origin || profile;
    byId('vault-list').disabled = state.busy || !originInput() || profile;
    byId('save-record').disabled = state.busy || (!profile && !originInput()) || (variable
      ? !byId('save-var-name').value.trim() || !byId('save-var-desc').value.trim() || !byId('save-var-val').value
      : !byId('vault-record-id').value.trim());
    byId('vault-use-record').disabled = !review || originInput() !== state.origin || byId('vault-kind').value !== state.kind || !byId('vault-record-id').value.trim();
    for (const control of byId('fields').querySelectorAll('input, select, button')) {
      const mapping = info.mappings?.find(item => item.fieldId === control.dataset.fieldId);
      control.disabled = !review || !!info.request || (control.type === 'checkbox' && infoMode && (!info.planned || (!mapping?.provided && !mapping?.variableId)));
    }
    for (const control of byId('website-actions').querySelectorAll('button')) control.disabled = state.busy || !['review', 'filled'].includes(state.phase) || !!state.pendingPermission || !!info.request;
    for (const control of byId('info-dialog-form').querySelectorAll('input, textarea, select, button')) {
      if (['dialog-cancel', 'dialog-skip'].includes(control.id)) control.disabled = state.busy && control.id !== 'dialog-cancel';
      else control.disabled = state.busy || (control.id === 'dialog-var-scope' && ['username', 'password'].includes(info.request?.field.kind));
    }
    byId('permission-deny').disabled = state.busy || connectionLost;
    byId('permission-stop').disabled = false;
    if (connectionLost) for (const control of document.querySelectorAll('input, select, textarea, button')) {
      if (!['stop', 'permission-stop', 'vault-lock', 'hosted-logout'].includes(control.id)) control.disabled = true;
    }
  }
  async function send(command) {
    state.busy = true; byId('error').textContent = ''; byId('error').hidden = true; buttons();
    try { await window.autoMateAutofill({ ...command, revision: state.revision }); }
    catch {
      byId('error').textContent = 'Owner connection unavailable. No action was confirmed; close this window.';
      byId('error').hidden = false;
    }
  }
  function clearSecrets() { for (const id of secretInputs) byId(id).value = ''; }
  function switchVaultKind() {
    byId('login-fields').hidden = byId('vault-kind').value !== 'login';
    byId('card-fields').hidden = byId('vault-kind').value !== 'card';
    byId('variable-fields').hidden = byId('vault-kind').value !== 'variable';
    const variable = byId('vault-kind').value === 'variable';
    byId('vault-record-id').required = !variable;
    byId('vault-record-id').hidden = variable;
    document.querySelector('label[for="vault-record-id"]').hidden = variable;
    for (const [group, active] of [['login-fields', !variable && byId('vault-kind').value === 'login'], ['card-fields', !variable && byId('vault-kind').value === 'card'], ['variable-fields', variable]]) {
      for (const input of byId(group).querySelectorAll('input')) input.required = active;
    }
    const credential = ['username', 'password'].includes(byId('save-var-kind').value);
    byId('save-var-scope').querySelector('option[value="profile"]').disabled = credential;
    if (credential) byId('save-var-scope').value = 'site';
    byId('save-var-val').type = byId('save-var-kind').value === 'password' ? 'password' : 'text';
  }
  function clearVaultForm() {
    clearSecrets(); localVaultLock = true;
    byId('vault-origin').value = ''; byId('vault-record-id').value = ''; byId('vault-kind').value = 'login';
    byId('save-var-name').value = ''; byId('save-var-desc').value = ''; byId('save-var-val').value = '';
    byId('save-var-kind').value = 'text'; byId('save-var-scope').value = 'profile';
    switchVaultKind(); byId('vault-column').scrollTop = 0; renderVault();
  }
  function renderVault() {
    const vault = state.vault || { locked: true, entries: [] };
    const visible = !localVaultLock && !vault.locked && vault.origin === originInput();
    byId('vault-status').textContent = visible ? 'Owner metadata visible' : 'Metadata locked';
    byId('vault-message').textContent = vault.message || '';
    byId('vault-error').textContent = vault.error || ''; byId('vault-error').hidden = !vault.error;
    const entries = visible ? vault.entries : [];
    const signature = JSON.stringify([visible, entries]);
    if (signature !== recordsSignature) {
      recordsSignature = signature;
      const options = document.createDocumentFragment(); const empty = make('option', visible ? 'Choose a record ID' : 'Metadata locked'); empty.value = ''; options.append(empty);
      for (const entry of entries) { const option = make('option', entry.recordId); option.value = entry.recordId; options.append(option); }
      byId('vault-records').replaceChildren(options);
    }
    byId('vault-records').disabled = state.busy || !visible || !entries.length;
    buttons();
  }
  byId('inspect-form').addEventListener('submit', event => {
    event.preventDefault(); selected.clear();
    void send({ action: 'inspect', url: byId('website-url').value, kind: byId('record-kind').value });
  });
  for (const id of ['website-url', 'record-kind', 'record-id', 'vault-record-id', 'save-var-name', 'save-var-desc', 'save-var-val']) byId(id).addEventListener('input', buttons);
  byId('record-kind').addEventListener('change', buttons);
  byId('vault-origin').addEventListener('input', renderVault);
  byId('vault-kind').addEventListener('change', () => { clearSecrets(); switchVaultKind(); buttons(); });
  for (const id of ['save-var-kind', 'save-var-scope']) byId(id).addEventListener('change', () => { switchVaultKind(); buttons(); });
  byId('vault-use-origin').addEventListener('click', () => {
    byId('vault-origin').value = state.origin || '';
    if (state.kind !== 'information' && byId('vault-kind').value !== state.kind) { clearSecrets(); byId('vault-kind').value = state.kind; switchVaultKind(); }
    renderVault();
  });
  byId('vault-list').addEventListener('click', () => {
    if (!byId('vault-origin').reportValidity()) return;
    void send({ action: 'vault-list', origin: byId('vault-origin').value });
  });
  byId('vault-records').addEventListener('change', () => { byId('vault-record-id').value = byId('vault-records').value; buttons(); });
  byId('vault-use-record').addEventListener('click', () => {
    byId('record-id').value = byId('vault-record-id').value;
    byId('record-selection-status').textContent = 'Record ID selected for this origin. No fields have been approved; choose each disclosure below.';
    buttons();
  });
  byId('save-form').addEventListener('submit', event => {
    event.preventDefault();
    const vKind = byId('vault-kind').value;
    const origin = byId('vault-origin').value;
    if (vKind === 'variable') {
      const variable = {
        name: byId('save-var-name').value.trim(),
        description: byId('save-var-desc').value.trim(),
        value: byId('save-var-val').value,
        kind: byId('save-var-kind').value,
        scope: byId('save-var-scope').value,
        origin: byId('save-var-scope').value === 'profile' ? 'https://profile.auto-mate.invalid' : origin,
      };
      clearSecrets();
      void send({ action: 'information-save', variable });
    } else {
      const record = vKind === 'card' ? {
        version: 1, kind: 'card', cardholder: byId('save-cardholder').value, cardNumber: byId('save-card-number').value,
        expiryMonth: byId('save-month').value, expiryYear: byId('save-year').value,
      } : { version: 1, kind: 'login', username: byId('save-username').value, password: byId('save-password').value };
      const rId = byId('vault-record-id').value;
      clearSecrets();
      void send({ action: 'vault-save', origin, recordId: rId, record });
    }
  });
  byId('fill').addEventListener('click', () => {
    const command = state.kind === 'information'
      ? { action: 'information-fill', fields: [...selected], durationSeconds: Number(byId('duration').value) }
      : { action: 'fill', recordId: byId('record-id').value, fields: [...selected], durationSeconds: Number(byId('duration').value) };
    if (state.authenticationMode === 'user-key') {
      localPermission = { command, revision: state.revision };
      renderPermission();
    } else void send(command);
  });
  byId('deny').addEventListener('click', () => { void send({ action: 'deny' }); });
  function stopFromUi(action = 'stop') { clearFrame(); clearVaultForm(); clearInformationDialog(); localPermission = null; permissionSignature = ''; byId('permission-dialog').close(); void send({ action }); }
  byId('stop').addEventListener('click', () => stopFromUi());
  byId('vault-lock').addEventListener('click', () => stopFromUi('vault-lock'));
  for (const [id, kind, url] of [
    ['example-login', 'login', 'https://the-internet.herokuapp.com/login'],
    ['example-card', 'card', 'https://autofill.me/form/credit-card-simple'],
  ]) byId(id).addEventListener('click', () => { byId('website-url').value = url; byId('record-kind').value = kind; buttons(); });
  byId('info-load-catalog').addEventListener('click', () => {
    void send({ action: 'information-catalog' });
  });
  byId('info-plan').addEventListener('click', () => {
    void send({ action: 'information-plan', shareMetadata: byId('info-consent').checked });
  });
  byId('info-plan-local').addEventListener('click', () => void send({ action: 'information-plan-local' }));
  byId('info-consent').addEventListener('change', buttons);
  byId('dialog-save-check').addEventListener('change', () => {
    byId('dialog-save-details').hidden = !byId('dialog-save-check').checked;
    for (const id of ['dialog-var-name', 'dialog-var-desc']) byId(id).required = byId('dialog-save-check').checked;
  });
  byId('info-dialog-form').addEventListener('submit', event => {
    event.preventDefault();
    const req = state.information?.request;
    if (!req) return;
    const valInput = byId('dialog-value-input');
    const val = valInput ? valInput.value : '';
    const save = byId('dialog-save-check').checked ? {
      name: byId('dialog-var-name').value.trim(),
      description: byId('dialog-var-desc').value.trim(),
      scope: byId('dialog-var-scope').value,
    } : null;
    if (valInput) valInput.value = '';
    byId('info-dialog').close();
    void send({ action: 'information-provide', requestId: req.id, value: val, save });
  });
  byId('dialog-skip').addEventListener('click', () => {
    const req = state.information?.request;
    if (!req) return;
    clearInformationDialog(false);
    void send({ action: 'information-skip', requestId: req.id });
  });
  byId('dialog-cancel').addEventListener('click', () => stopFromUi());
  byId('info-dialog').addEventListener('cancel', event => { event.preventDefault(); stopFromUi(); });
  function clearInformationDialog(reset = true) {
    const input = byId('dialog-value-input');
    if (input) input.value = '';
    byId('info-dialog').close();
    if (reset) { dialogRequestId = ''; byId('dialog-input-container').replaceChildren(); }
  }

  function cancelDecode() {
    generation++;
    if (pendingImage) { pendingImage.onload = null; pendingImage.onerror = null; pendingImage.src = ''; }
    pendingImage = null; pendingFrame = null;
  }
  function clearFrame() {
    cancelDecode(); committedImage = ''; annotationSignature = '';
    byId('canvas').hidden = true; byId('annotations').replaceChildren();
    byId('frame-image').removeAttribute('src'); byId('frame-empty').hidden = false;
    byId('frame-status').textContent = 'Waiting for inspection';
  }
  function renderFields() {
    const info = state.information;
    const signature = JSON.stringify([revision, state.fields, info?.mappings]);
    if (signature === fieldsSignature) return;
    fieldsSignature = signature;
    selected.clear();
    const choices = document.createDocumentFragment();
    (state.fields || []).forEach((field, index) => {
      const row = make('div', '', 'field-choice');
      const labelRow = make('label', '', 'field-label-row');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.value = field.id; checkbox.checked = selected.has(field.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(field.id); else selected.delete(field.id);
        row.classList.toggle('selected', checkbox.checked); buttons();
      });
      checkbox.dataset.fieldId = field.id;
      row.classList.toggle('selected', checkbox.checked);
      labelRow.append(checkbox, make('strong', (index + 1) + '. ' + field.name), make('span', field.category, 'category ' + field.category));
      row.append(labelRow, make('blockquote', '“' + field.sourceText + '”'), make('p', 'Verified ' + field.association + ' · Website text is untrusted'));

      if (state.kind === 'information') {
        const mapping = info?.mappings?.find(m => m.fieldId === field.id);
        const statusDiv = make('div', '', 'mapping-badge');
        if (!info?.planned) {
          statusDiv.textContent = 'Not yet mapped by Agent';
          statusDiv.classList.add('missing');
        } else if (mapping?.provided) {
          statusDiv.textContent = '✓ Ready: Value entered via dialog';
          statusDiv.classList.add('ready');
        } else if (mapping?.skipped) {
          statusDiv.textContent = 'Skipped by user';
          statusDiv.classList.add('skipped');
        } else if (mapping?.variableId) {
          const v = info.variables?.find(item => item.id === mapping.variableId);
          statusDiv.textContent = '✓ Mapped: ' + (v ? v.name + ' (' + v.description + ') [' + v.scope + ']' : mapping.variableId);
          statusDiv.classList.add('ready');
        } else {
          statusDiv.textContent = '⚠ Missing from vault: Agent needs this info';
          statusDiv.classList.add('missing');
        }
        row.append(statusDiv);

        if (info?.planned) {
          const actionsDiv = make('div', '', 'field-actions');
          const enterBtn = make('button', 'Enter value in dialog', 'compact-button');
          enterBtn.type = 'button';
          enterBtn.disabled = state.busy;
          enterBtn.addEventListener('click', () => {
            void send({ action: 'information-request', fieldId: field.id });
          });
          actionsDiv.append(enterBtn);

          if (mapping?.choices?.length) {
            const select = document.createElement('select');
            select.className = 'compact-button';
            select.disabled = state.busy;
            const defaultOpt = make('option', 'Or choose vault variable...');
            defaultOpt.value = '';
            select.append(defaultOpt);
            for (const varId of mapping.choices) {
              const v = info.variables?.find(item => item.id === varId);
              if (v) {
                const opt = make('option', v.name + ' (' + v.description + ')');
                opt.value = v.id;
                if (mapping.variableId === v.id) opt.selected = true;
                select.append(opt);
              }
            }
            select.addEventListener('change', () => {
              if (select.value) void send({ action: 'information-choose', fieldId: field.id, variableId: select.value });
            });
            actionsDiv.append(select);
          }
          row.append(actionsDiv);
        }
      }

      choices.append(row);
    });
    if (!state.fields?.length) choices.append(make('p', 'No supported verified fields. Inspect a website first.', 'waiting'));
    byId('fields').replaceChildren(choices);
  }
  function renderInformation() {
    const info = state.information;
    if (state.kind !== 'information' || !info || !activePhases.has(state.phase)) {
      byId('information-banner').hidden = true;
      clearInformationDialog();
      return;
    }
    byId('info-provider').textContent = info.mode === 'reviewed'
      ? 'Deterministic local mapping · No model request.'
      : 'Configured API model label: ' + info.model + '. Field labels and metadata are sent only with your consent.';
    if (state.modelObservationAllowed === false) byId('info-provider').textContent = 'This browser has interacted with the website and may contain private data. API planning is blocked. Use explicit local mapping, or inspect again for a fresh isolated browser.';
    byId('info-consent-row').hidden = info.mode === 'reviewed';
    byId('info-plan-controls').hidden = !info.catalogLoaded;
    byId('info-catalog-details').hidden = !info.catalogLoaded;
    byId('info-catalog-count').textContent = info.variables?.length || 0;
    const signature = JSON.stringify([state.revision, info.variables]);
    if (signature !== catalogSignature) {
      catalogSignature = signature;
      byId('info-consent').checked = false;
      const items = document.createDocumentFragment();
      for (const variable of info.variables || []) {
        const card = make('div', '', 'info-variable-item');
        const header = make('div', '', 'info-variable-header');
        header.append(make('strong', variable.name), make('span', variable.scope + ' · ' + variable.kind + (variable.available ? ' · Available' : ' · Other site, unavailable'), 'info-variable-scope'));
        card.append(header, make('p', variable.description, 'info-variable-desc'));
        items.append(card);
      }
      if (!info.variables?.length) items.append(make('p', 'No saved variables. Missing fields will ask you for information; entered values stay out of the model.', 'info-variable-desc'));
      byId('info-catalog-list').replaceChildren(items);
    }
    const request = info.request;
    if (!request) { clearInformationDialog(); return; }
    if (request.id !== dialogRequestId) {
      clearInformationDialog();
      dialogRequestId = request.id;
      byId('dialog-title').textContent = 'Information needed: ' + request.field.label;
      byId('dialog-prompt').textContent = 'Destination: ' + state.origin + '. Enter this ' + request.field.kind + ' information locally, or skip it. Providing information is not permission to fill the website.';
      const container = byId('dialog-input-container');
      const label = make('label', request.field.label);
      label.htmlFor = 'dialog-value-input';
      let input;
      if (request.field.options?.length) {
        input = document.createElement('select');
        const empty = make('option', 'Select an option…'); empty.value = ''; input.append(empty);
        for (const value of request.field.options) { const option = make('option', value); option.value = value; input.append(option); }
      } else {
        input = document.createElement(request.field.kind === 'text' ? 'textarea' : 'input');
        if (input.tagName === 'INPUT') input.type = ['password', 'email', 'tel', 'url', 'date', 'number'].includes(request.field.kind) ? request.field.kind : 'text';
        input.autocomplete = 'off';
        input.maxLength = 4096;
      }
      input.id = 'dialog-value-input'; input.required = true;
      container.replaceChildren(label, input);
      byId('dialog-save-check').checked = false;
      byId('dialog-save-details').hidden = true;
      for (const id of ['dialog-var-name', 'dialog-var-desc']) byId(id).required = false;
      byId('dialog-var-name').value = request.field.label.slice(0, 80);
      byId('dialog-var-desc').value = ('Information for ' + request.field.label).slice(0, 500);
      const credential = ['username', 'password'].includes(request.field.kind);
      byId('dialog-var-scope').value = credential ? 'site' : 'profile';
      byId('dialog-var-scope').disabled = credential;
    }
    if (!state.busy && !byId('info-dialog').open) { byId('info-dialog').showModal(); byId('dialog-value-input').focus(); }
  }
  function renderWebsiteActions() {
    const available = state.authenticationMode === 'user-key' && !!state.origin;
    byId('website-action-panel').hidden = !available;
    const signature = JSON.stringify([state.revision, state.websiteActions]);
    if (signature === actionsSignature) return;
    actionsSignature = signature;
    const controls = document.createDocumentFragment();
    for (const action of state.websiteActions || []) {
      const button = make('button', 'Request click: ' + action.label);
      button.type = 'button';
      button.addEventListener('click', () => void send({ action: 'website-click-request', buttonId: action.id, durationSeconds: Number(byId('duration').value) }));
      controls.append(button);
    }
    if (!state.websiteActions?.length) controls.append(make('p', 'No uniquely labelled, supported website buttons on this page.', 'approval-notice'));
    byId('website-actions').replaceChildren(controls);
  }
  function renderPermission() {
    const permission = state.pendingPermission;
    const dialog = byId('permission-dialog');
    if (localPermission && localPermission.revision !== state.revision) localPermission = null;
    const signature = permission?.id || (localPermission ? 'fill:' + localPermission.revision : '');
    if (!signature) { dialog.close(); permissionSignature = ''; return; }
    if (signature !== permissionSignature) {
      permissionSignature = signature;
      byId('permission-title').textContent = permission ? 'Allow this website button click?' : 'Allow these field disclosures?';
      byId('permission-body').textContent = permission
        ? `Website: ${permission.origin}
Button: “${permission.label}”
This may submit data, navigate, purchase, or delete. Unfilled entries and previous field approvals will be cleared. The protected browser lifetime becomes ${permission.durationSeconds} seconds. No replacement button will be clicked.`
        : `Website: ${state.origin}
Fields: ${state.fields.filter(field => localPermission.command.fields.includes(field.id)).map(field => field.name).join(', ')}
The website and its scripts can read these values immediately. The model will not receive them. This does not submit the form.`;
      if (!dialog.open) dialog.showModal();
      byId('permission-deny').focus();
    }
    byId('permission-approve').disabled = state.busy;
  }
  function denyPermission() {
    const permission = state.pendingPermission;
    localPermission = null; permissionSignature = ''; byId('permission-dialog').close();
    if (permission) void send({ action: 'website-click-deny', permissionId: permission.id });
  }
  byId('permission-deny').addEventListener('click', denyPermission);
  byId('permission-dialog').addEventListener('cancel', event => { event.preventDefault(); denyPermission(); });
  byId('permission-stop').addEventListener('click', () => stopFromUi());
  byId('permission-approve').addEventListener('click', () => {
    const permission = state.pendingPermission;
    const command = permission ? { action: 'website-click-approve', permissionId: permission.id } : localPermission?.command;
    localPermission = null; permissionSignature = ''; byId('permission-dialog').close();
    if (command) void send(command);
  });
  function renderState(next) {
    if (next.revision < revision) return;
    const inspected = state.phase === 'inspecting' && next.phase === 'review';
    const wasStopped = state.phase === 'stopped';
    state = next;
    if (inspected) { byId('website-url').value = state.url; byId('record-kind').value = state.kind; }
    if (revision !== state.revision) {
      revision = state.revision; selected.clear(); byId('record-id').value = ''; clearFrame();
      if (state.url && ['review', 'filled'].includes(state.phase)) byId('website-url').value = state.url;
      byId('vault-column').scrollTop = 0;
      clearInformationDialog(); byId('info-consent').checked = false; localPermission = null;
      byId('record-selection-status').textContent = 'Selecting a record ID does not approve any disclosure.';
    }
    if (state.phase === 'stopped' && !wasStopped) clearVaultForm();
    if (state.vault?.locked) localVaultLock = false;
    byId('phase').textContent = phases[state.phase] || 'Unavailable';
    byId('destination').textContent = state.origin ? 'Approved destination: ' + state.origin : 'No website open';
    byId('message').textContent = state.message || '';
    byId('error').textContent = state.error || ''; byId('error').hidden = !state.error;
    const hosted = state.authenticationMode === 'user-key';
    byId('authentication-notice').textContent = hosted
      ? 'Hosted development preview. Your key-authenticated session authorizes vault access; Windows Hello is not used. Trust the operator’s laptop. Every website click needs separate approval. Stop cannot undo values already disclosed.'
      : 'Local development preview. Windows Hello is required for vault operations. No website buttons are clicked automatically. Stop cannot undo disclosures.';
    byId('vault-authentication-notice').textContent = hosted
      ? 'Vault data is encrypted with your chosen key on the host. An active authenticated session is required for every operation. Sign out to close your browser and revoke access.'
      : 'Data stays in the native encrypted vault. Every save, listing, and retrieval requires Windows Hello.';
    renderFields(); renderVault();
    renderInformation();
    renderWebsiteActions(); renderPermission();
    if (!activePhases.has(state.phase)) {
      if (committedImage || pendingImage) clearFrame();
      byId('frame-status').textContent = state.phase === 'inspecting' ? 'Inspecting · No vault access' : 'Preview inactive';
    }
    buttons();
  }
  function renderAnnotations(frame) {
    const signature = JSON.stringify([frame.width, frame.height, frame.annotations]);
    if (signature === annotationSignature) return;
    annotationSignature = signature;
    const marks = document.createDocumentFragment();
    frame.annotations.forEach((annotation, index) => {
      for (const role of ['source', 'field']) {
        const box = annotation[role]; const node = make('div', '', 'autofill-mark ' + role + ' ' + annotation.category);
        node.style.left = (100 * box.x / frame.width) + '%'; node.style.top = (100 * box.y / frame.height) + '%';
        node.style.width = (100 * box.width / frame.width) + '%'; node.style.height = (100 * box.height / frame.height) + '%';
        node.append(make('span', String(index + 1))); marks.append(node);
      }
    });
    byId('annotations').replaceChildren(marks);
  }
  function renderFrame(update) {
    if (!activePhases.has(state.phase) || update.revision !== revision) return;
    const frame = update.frame;
    if (frame.image === committedImage) {
      if (pendingImage) cancelDecode();
      renderAnnotations(frame); return;
    }
    if (pendingFrame?.image === frame.image) { pendingFrame = frame; return; }
    cancelDecode();
    const token = generation; const image = new Image();
    pendingImage = image; pendingFrame = frame; pendingRevision = revision;
    image.onload = () => {
      if (token !== generation || pendingRevision !== revision || !activePhases.has(state.phase)) return;
      const decoded = pendingFrame;
      if (!decoded) return;
      const aspect = decoded.width + ' / ' + decoded.height;
      if (byId('frame-shell').style.aspectRatio !== aspect) byId('frame-shell').style.aspectRatio = aspect;
      byId('frame-image').src = image.src;
      committedImage = decoded.image;
      renderAnnotations(decoded);
      byId('canvas').hidden = false; byId('frame-empty').hidden = true;
      byId('frame-status').textContent = 'Live · Owner only';
      pendingImage = null; pendingFrame = null;
    };
    image.onerror = () => {
      if (token !== generation || pendingRevision !== revision || !activePhases.has(state.phase)) return;
      clearFrame(); void send({ action: 'stop' });
    };
    image.src = 'data:image/png;base64,' + frame.image;
  }
  window.autoMateAutofillUpdate = update => {
    if (update.kind === 'state') renderState(update.state);
    else if (update.kind === 'frame') renderFrame(update);
  };
  function stopPolling() { polling = false; pollGeneration++; clearTimeout(pollTimer); pollController?.abort(); }
  function resumePolling() {
    if (!hostedTransport || !csrfToken || document.hidden || polling) return;
    connectionLost = true; buttons(); updateSequence = 0;
    polling = true; pollGeneration++;
    void pollUpdates(pollGeneration);
  }
  async function pollUpdates(generation) {
    if (!polling || generation !== pollGeneration) return;
    const controller = new AbortController();
    pollController = controller;
    const deadline = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('/api/updates?after=' + updateSequence, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (response.status === 401) { stopPolling(); clearSecrets(); clearInformationDialog(); clearFrame(); window.location.replace('/login'); return; }
      if (!response.ok) throw new Error('HOSTED_CONNECTION_FAILED');
      const payload = await response.json();
      if (!polling || generation !== pollGeneration) return;
      if (!Number.isSafeInteger(payload.sequence) || payload.sequence < updateSequence || !Array.isArray(payload.updates)) throw new Error('HOSTED_UPDATE_INVALID');
      const reconnecting = connectionLost;
      connectionLost = false;
      for (const update of payload.updates) window.autoMateAutofillUpdate(update);
      updateSequence = payload.sequence;
      if (reconnecting && !payload.updates.length) { byId('error').textContent = state.error || ''; byId('error').hidden = !state.error; buttons(); }
    } catch {
      if (!polling || generation !== pollGeneration) return;
      connectionLost = true;
      clearSecrets(); clearInformationDialog(); clearFrame(); localPermission = null; permissionSignature = ''; byId('permission-dialog').close();
      byId('error').textContent = 'Host connection lost. Website authority is revoked after the reconnect grace period. No action is confirmed. Reconnecting…';
      byId('error').hidden = false; buttons();
    } finally {
      clearTimeout(deadline);
      if (polling && generation === pollGeneration) pollTimer = setTimeout(() => void pollUpdates(generation), 500);
    }
  }
  async function connectHosted() {
    if (!hostedTransport) return;
    const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) { window.location.replace('/login'); return; }
    if (!response.ok) throw new Error('HOSTED_CONNECTION_FAILED');
    const session = await response.json();
    csrfToken = session.csrfToken;
    byId('hosted-user').textContent = 'Signed in: ' + session.username;
    byId('hosted-session').hidden = false;
    window.autoMateAutofill = async command => {
      const result = await fetch('/api/command', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(command) });
      if (result.status === 401) { stopPolling(); clearSecrets(); clearInformationDialog(); clearFrame(); window.location.replace('/login'); }
      if (!result.ok) throw new Error('HOSTED_COMMAND_FAILED');
    };
    resumePolling();
  }
  document.addEventListener('visibilitychange', () => {
    if (!hostedTransport) return;
    if (document.hidden) {
      stopPolling(); connectionLost = true;
      clearSecrets(); clearInformationDialog(); clearFrame(); localPermission = null; permissionSignature = ''; byId('permission-dialog').close(); buttons();
    } else resumePolling();
  });
  byId('hosted-logout').addEventListener('click', async () => {
    stopPolling();
    clearSecrets(); clearInformationDialog(); clearFrame(); localPermission = null; byId('permission-dialog').close();
    try {
      const result = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken } });
      if (!result.ok && result.status !== 401) throw new Error('LOGOUT_FAILED');
      window.location.replace('/login');
    } catch { connectionLost = true; buttons(); byId('error').textContent = 'Sign-out could not be confirmed. Website authority expires without polling; contact the operator and do not leave this session unattended.'; byId('error').hidden = false; }
  });
  switchVaultKind();
  if (hostedTransport) { state.busy = true; buttons(); void connectHosted().catch(() => { byId('error').textContent = 'Cannot connect to the authenticated host. Reload or sign in again.'; byId('error').hidden = false; }); }
})();
