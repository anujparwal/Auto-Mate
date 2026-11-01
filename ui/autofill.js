'use strict';
(() => {
  const byId = id => document.getElementById(id);
  const make = (tag, value, className) => {
    const node = document.createElement(tag); node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  const activePhases = new Set(['review', 'filling', 'filled']);
  const secretInputs = ['save-username', 'save-password', 'save-cardholder', 'save-card-number', 'save-month', 'save-year', 'save-var-val'];
  const phases = { idle: 'Ready', inspecting: 'Inspecting website', review: 'Awaiting field approval',
    filling: 'Authenticating / filling', filled: 'Filled · Review in protected browser', stopped: 'Stopped', failed: 'Stopped · Owner attention required' };
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
    byId('fill').disabled = !review || !selected.size || (infoMode ? !infoFieldsReady() : !byId('record-id').value.trim());
    byId('fill').textContent = infoMode ? 'Approve selected fields & fill' : 'Approve selected fields & authenticate';
    byId('deny').disabled = !['review', 'filled'].includes(state.phase) || state.busy;
    byId('record-id').disabled = !review;
    byId('duration').disabled = !review;
    byId('example-login').disabled = state.busy;
    byId('example-card').disabled = state.busy;
    byId('record-id').hidden = infoMode;
    document.querySelector('label[for="record-id"]').hidden = infoMode;
    byId('record-selection-status').hidden = infoMode;
    byId('information-banner').hidden = !infoMode || !review;
    if (infoMode && review) {
      const info = state.information || {};
      byId('info-load-catalog').disabled = state.busy;
      byId('info-plan').disabled = state.busy || !info.catalogLoaded || info.catalogStale;
      byId('info-consent').disabled = state.busy;
    }
    for (const id of ['vault-origin', 'vault-kind', 'vault-record-id', ...secretInputs]) byId(id).disabled = state.busy;
    byId('vault-use-origin').disabled = state.busy || !state.origin;
    byId('vault-list').disabled = state.busy || !originInput();
    byId('save-record').disabled = state.busy || !originInput() || !byId('vault-record-id').value.trim();
    byId('vault-use-record').disabled = !review || originInput() !== state.origin || byId('vault-kind').value !== state.kind || !byId('vault-record-id').value.trim();
    for (const checkbox of byId('fields').querySelectorAll('input')) checkbox.disabled = !review;
  }
  async function send(command) {
    state.busy = true; buttons();
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
  for (const id of ['website-url', 'record-kind', 'record-id', 'vault-record-id']) byId(id).addEventListener('input', buttons);
  byId('record-kind').addEventListener('change', buttons);
  byId('vault-origin').addEventListener('input', renderVault);
  byId('vault-kind').addEventListener('change', () => { clearSecrets(); switchVaultKind(); buttons(); });
  byId('vault-use-origin').addEventListener('click', () => {
    byId('vault-origin').value = state.origin || '';
    if (byId('vault-kind').value !== state.kind) { clearSecrets(); byId('vault-kind').value = state.kind; switchVaultKind(); }
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
        origin,
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
    if (state.kind === 'information') {
      void send({ action: 'information-fill', fields: [...selected], durationSeconds: Number(byId('duration').value) });
    } else {
      void send({ action: 'fill', recordId: byId('record-id').value, fields: [...selected], durationSeconds: Number(byId('duration').value) });
    }
  });
  byId('deny').addEventListener('click', () => { void send({ action: 'deny' }); });
  byId('stop').addEventListener('click', () => { clearFrame(); clearVaultForm(); void send({ action: 'stop' }); });
  byId('vault-lock').addEventListener('click', () => { clearFrame(); clearVaultForm(); void send({ action: 'vault-lock' }); });
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
  byId('dialog-save-check').addEventListener('change', () => {
    byId('dialog-save-details').hidden = !byId('dialog-save-check').checked;
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
    byId('info-dialog').close();
    void send({ action: 'information-provide', requestId: req.id, value: val, save });
  });
  byId('dialog-skip').addEventListener('click', () => {
    const req = state.information?.request;
    if (!req) return;
    byId('info-dialog').close();
    void send({ action: 'information-skip', requestId: req.id });
  });

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
    if (state.kind !== 'information' || !info) {
      byId('information-banner').hidden = true;
      if (byId('info-dialog').open) byId('info-dialog').close();
      return;
    }
    byId('information-banner').hidden = false;
    byId('info-consent-row').hidden = info.mode === 'reviewed';
    byId('info-plan-controls').hidden = !info.catalogLoaded;
    byId('info-catalog-details').hidden = !info.catalogLoaded;
    byId('info-catalog-count').textContent = info.variables?.length || 0;

    // Render catalog list
    if (info.catalogLoaded) {
      const list = byId('info-catalog-list');
      const items = document.createDocumentFragment();
      for (const v of info.variables || []) {
        const card = make('div', '', 'info-variable-item');
        const header = make('div', '', 'info-variable-header');
        header.append(make('strong', v.name), make('span', v.scope + ' · ' + v.kind, 'info-variable-scope'));
        const desc = make('p', v.description, 'info-variable-desc');
        card.append(header, desc);
        items.append(card);
      }
      if (!info.variables?.length) {
        items.append(make('p', 'No variables found in vault for this scope. You can save named variables in the Vault column or provide them when the agent requests them.', 'info-variable-desc'));
      }
      list.replaceChildren(items);
    }

    // Missing info dialog
    const dialog = byId('info-dialog');
    if (info.request) {
      const req = info.request;
      byId('dialog-title').textContent = 'Information needed for: ' + req.field.label;
      byId('dialog-prompt').textContent = 'The agent needs this ' + req.field.kind + ' information' + (req.field.required ? ' (required by website)' : '') + '. Enter it below:';
      const container = byId('dialog-input-container');
      container.replaceChildren();
      if (req.field.options?.length) {
        const select = document.createElement('select');
        select.id = 'dialog-value-input';
        select.required = true;
        const empty = make('option', 'Select an option...');
        empty.value = '';
        select.append(empty);
        for (const opt of req.field.options) {
          const optEl = make('option', opt);
          optEl.value = opt;
          select.append(optEl);
        }
        container.append(select);
      } else {
        const input = document.createElement('input');
        input.id = 'dialog-value-input';
        input.type = req.field.kind === 'password' ? 'password' : 'text';
        input.required = true;
        input.autocomplete = 'off';
        input.maxLength = 4096;
        input.placeholder = 'Enter ' + req.field.label;
        container.append(input);
      }
      byId('dialog-save-check').checked = false;
      byId('dialog-save-details').hidden = true;
      byId('dialog-var-name').value = req.field.label;
      byId('dialog-var-desc').value = req.field.label + ' for ' + (req.field.kind === 'username' ? 'login' : 'registration');
      byId('dialog-var-scope').value = (req.field.kind === 'username' || req.field.kind === 'password') ? 'site' : 'profile';
      byId('dialog-var-scope').disabled = (req.field.kind === 'username' || req.field.kind === 'password');
      if (!dialog.open) dialog.showModal();
    } else {
      if (dialog.open) dialog.close();
    }
  }
  function renderState(next) {
    if (next.revision < revision) return;
    const inspected = state.phase === 'inspecting' && next.phase === 'review';
    const wasStopped = state.phase === 'stopped';
    state = next;
    if (inspected) { byId('website-url').value = state.url; byId('record-kind').value = state.kind; }
    if (revision !== state.revision) {
      revision = state.revision; selected.clear(); byId('record-id').value = ''; clearFrame();
      byId('record-selection-status').textContent = 'Selecting a record ID does not approve any disclosure.';
    }
    if (state.phase === 'stopped' && !wasStopped) clearVaultForm();
    if (state.vault?.locked) localVaultLock = false;
    byId('phase').textContent = phases[state.phase] || 'Unavailable';
    byId('destination').textContent = state.origin ? 'Approved destination: ' + state.origin : 'No website open';
    byId('message').textContent = state.message || '';
    byId('error').textContent = state.error || ''; byId('error').hidden = !state.error;
    renderFields(); renderVault();
    renderInformation();
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
})();
