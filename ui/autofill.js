'use strict';
(() => {
  const byId = id => document.getElementById(id);
  const make = (tag, value, className) => {
    const node = document.createElement(tag); node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  const activePhases = new Set(['review', 'filling', 'filled']);
  const secretInputs = ['save-username', 'save-password', 'save-cardholder', 'save-card-number', 'save-month', 'save-year'];
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
  function buttons() {
    const review = canReview();
    byId('inspect').disabled = state.busy;
    byId('website-url').disabled = state.busy;
    byId('record-kind').disabled = state.busy;
    byId('fill').disabled = !review || !selected.size || !byId('record-id').value.trim();
    byId('deny').disabled = !['review', 'filled'].includes(state.phase) || state.busy;
    byId('record-id').disabled = !review;
    byId('duration').disabled = !review;
    byId('example-login').disabled = state.busy;
    byId('example-card').disabled = state.busy;
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
  }
  function clearVaultForm() {
    clearSecrets(); localVaultLock = true;
    byId('vault-origin').value = ''; byId('vault-record-id').value = ''; byId('vault-kind').value = 'login';
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
    const record = byId('vault-kind').value === 'card' ? {
      version: 1, kind: 'card', cardholder: byId('save-cardholder').value, cardNumber: byId('save-card-number').value,
      expiryMonth: byId('save-month').value, expiryYear: byId('save-year').value,
    } : { version: 1, kind: 'login', username: byId('save-username').value, password: byId('save-password').value };
    const origin = byId('vault-origin').value; const recordId = byId('vault-record-id').value;
    clearSecrets();
    void send({ action: 'vault-save', origin, recordId, record });
  });
  byId('fill').addEventListener('click', () => {
    void send({ action: 'fill', recordId: byId('record-id').value, fields: [...selected], durationSeconds: Number(byId('duration').value) });
  });
  byId('deny').addEventListener('click', () => { void send({ action: 'deny' }); });
  byId('stop').addEventListener('click', () => { clearFrame(); clearVaultForm(); void send({ action: 'stop' }); });
  byId('vault-lock').addEventListener('click', () => { clearFrame(); clearVaultForm(); void send({ action: 'vault-lock' }); });
  for (const [id, kind, url] of [
    ['example-login', 'login', 'https://the-internet.herokuapp.com/login'],
    ['example-card', 'card', 'https://autofill.me/form/credit-card-simple'],
  ]) byId(id).addEventListener('click', () => { byId('website-url').value = url; byId('record-kind').value = kind; buttons(); });

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
    const signature = JSON.stringify([revision, state.fields]);
    if (signature === fieldsSignature) return;
    fieldsSignature = signature;
    const choices = document.createDocumentFragment();
    (state.fields || []).forEach((field, index) => {
      const row = make('label', '', 'field-choice'); const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.value = field.id; checkbox.checked = selected.has(field.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(field.id); else selected.delete(field.id);
        row.classList.toggle('selected', checkbox.checked); buttons();
      });
      row.classList.toggle('selected', checkbox.checked);
      row.append(checkbox, make('strong', (index + 1) + '. ' + field.name), make('span', field.category, 'category ' + field.category),
        make('blockquote', '“' + field.sourceText + '”'), make('p', 'Verified ' + field.association + ' · Website text is untrusted'));
      choices.append(row);
    });
    if (!state.fields?.length) choices.append(make('p', 'No supported verified fields. Inspect a website first.', 'waiting'));
    byId('fields').replaceChildren(choices);
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
