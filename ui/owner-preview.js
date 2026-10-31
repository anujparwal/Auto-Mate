'use strict';
(() => {
  const byId = id => document.getElementById(id);
  const phaseNames = {
    ready: 'Pending approval',
    requested: 'Checking requests',
    verified: 'Associations verified',
    filling: 'Preparing protected fill',
    filled: 'Field filled',
    submitting: 'Submitting',
    completed: 'Completed',
    takeover: 'Paused · Owner attention required',
    stopped: 'Stopped',
    denied: 'Denied by owner',
  };
  const fieldNames = {
    requested: 'Requested · Not yet verified',
    verified: 'Verified · Waiting',
    filling: 'Filling · Value hidden',
    filled: 'Filled · Value hidden',
    takeover: 'Unverified or changed · Not authorized to continue',
    stopped: 'Stopped',
    denied: 'Denied',
  };
  const categoryNames = { yellow: 'Yellow', orange: 'Orange', red: 'Red' };
  const evidenceNames = {
    'label-for': 'Verified label → field',
    'label-wrap': 'Verified enclosing label',
    'aria-labelledby': 'Verified accessible label → field',
  };

  let current = { phase: 'ready', requests: [], evidence: [], events: [], fieldStates: {}, canStart: false, canDeny: false, canStop: false };
  let selected = null;
  let frameGeneration = 0;
  let lastFrameAt = 0;
  let terminal = false;
  const overlayNodes = new Map();

  function isTerminal(phase) {
    return phase === 'completed' || phase === 'takeover' || phase === 'stopped' || phase === 'denied';
  }

  const text = (tag, content, className) => {
    const node = document.createElement(tag);
    node.textContent = content;
    if (className) node.className = className;
    return node;
  };

  function getSelectedLayers() {
    const layers = [];
    for (const name of ['yellow', 'orange', 'red']) {
      const el = byId('category-' + name);
      if (el && el.checked) layers.push(name);
    }
    return layers;
  }

  function updateApproveButtonState() {
    const approveBtn = byId('approve');
    if (!approveBtn) return;
    const canStart = Boolean(current.canStart && !terminal);
    const hasSelection = getSelectedLayers().length > 0;
    approveBtn.disabled = !canStart || !hasSelection;
  }

  for (const name of ['yellow', 'orange', 'red']) {
    const el = byId('category-' + name);
    if (el) el.addEventListener('change', updateApproveButtonState);
  }

  async function sendCommand(cmd) {
    byId('approve').disabled = true;
    byId('deny').disabled = true;
    try {
      if (typeof window.autoMateOwnerCommand !== 'function') throw new Error('OWNER_BRIDGE_UNAVAILABLE');
      await window.autoMateOwnerCommand(cmd);
    } catch {
      byId('phase').textContent = 'Owner connection unavailable';
      byId('frame-shell').classList.add('stale');
      byId('frame-notice').textContent = 'No action was confirmed. Close this window and restart the local preview.';
    }
  }

  byId('approve').addEventListener('click', () => {
    const layers = getSelectedLayers();
    const durationSeconds = Number(byId('duration').value);
    void sendCommand({ action: 'approve', layers, durationSeconds });
  });

  byId('deny').addEventListener('click', () => {
    void sendCommand({ action: 'deny' });
  });

  byId('stop').addEventListener('click', () => {
    void sendCommand({ action: 'stop' });
  });

  function select(id) {
    selected = selected === id ? null : id;
    for (const [key, node] of overlayNodes) node.classList.toggle('selected', key.startsWith(selected + ':'));
    for (const row of byId('requests').children) row.classList.toggle('active', row.dataset.id === selected);
  }

  function renderState(state) {
    current = state;
    terminal = isTerminal(state.phase);

    const dest = state.approval?.origin || state.origin || 'Waiting for a task';
    byId('origin').textContent = dest;
    byId('approval-destination').textContent = state.approval?.origin || state.origin || '—';

    if (state.operationScope) {
      byId('approval-scope').textContent = state.operationScope;
    }

    byId('phase').textContent = phaseNames[state.phase] || 'Paused';
    byId('approval-badge').textContent = terminal ? phaseNames[state.phase] :
      (state.canStart ? 'Owner approval required' : 'Approved for this task');

    const errorEl = byId('approval-error');
    if (errorEl) {
      if (state.approvalError) {
        errorEl.textContent = state.approvalError;
        errorEl.hidden = false;
      } else {
        errorEl.textContent = '';
        errorEl.hidden = true;
      }
    }

    const canStart = Boolean(state.canStart && !terminal);
    const canDeny = Boolean(state.canDeny && !terminal);
    const canStop = Boolean(state.canStop && !terminal);

    byId('deny').disabled = !canDeny;
    byId('stop').disabled = !canStop;

    const inputsDisabled = !canStart;
    for (const name of ['yellow', 'orange', 'red']) {
      const el = byId('category-' + name);
      if (el) el.disabled = inputsDisabled;
    }
    const durEl = byId('duration');
    if (durEl) durEl.disabled = inputsDisabled;

    updateApproveButtonState();

    if (state.approval?.credentials && state.approval.credentials.length > 0) {
      const credFrag = document.createDocumentFragment();
      for (const cred of state.approval.credentials) {
        const item = text('div', '', 'approval-credential-item');
        item.append(text('strong', cred.name), text('span', categoryNames[cred.category] || cred.category, 'category ' + cred.category));
        credFrag.append(item);
      }
      byId('approval-credentials').replaceChildren(credFrag);
    }

    const requestsList = state.requests || [];
    byId('request-count').textContent = requestsList.length + (requestsList.length === 1 ? ' field' : ' fields');
    const rows = document.createDocumentFragment();
    requestsList.forEach((request, index) => {
      const row = text('article', '', 'request-row');
      row.dataset.id = request.id;
      row.classList.toggle('active', selected === request.id);
      const heading = text('div', '', 'request-title');
      const button = text('button', '');
      button.type = 'button';
      button.setAttribute('aria-label', 'Highlight request and field for ' + request.name);
      button.append(text('span', String(index + 1), 'pair-number ' + request.category), document.createTextNode(request.name));
      button.addEventListener('click', () => select(request.id));
      heading.append(button, text('span', categoryNames[request.category] || 'Unknown', 'category ' + request.category));
      row.append(heading, text('p', 'Website request · Untrusted text', 'website-label'));
      const evidence = (state.evidence || []).find(item => item.id === request.id);
      row.append(text('blockquote', evidence ? '“' + evidence.sourceText + '”' : 'Association not verified'));
      row.append(text('p', evidence ? evidenceNames[evidence.association] : 'No structurally verified label-to-field link.', 'evidence'));
      const status = (state.fieldStates && state.fieldStates[request.id]) || 'requested';
      row.append(text('p', fieldNames[status] || status, 'request-state'));
      rows.append(row);
    });
    if (!requestsList.length) {
      rows.append(text('p', 'Verified text-to-field links will appear here once approved. Nearby text alone is not evidence.', 'waiting'));
    }
    byId('requests').replaceChildren(rows);

    const events = document.createDocumentFragment();
    const eventList = (state.events && state.events.length) ? state.events : ['Waiting for owner approval.'];
    eventList.forEach(event => events.append(text('li', event)));
    byId('activity').replaceChildren(events);
    byId('activity').scrollTop = byId('activity').scrollHeight;

    if (terminal) {
      frameGeneration++;
      if (state.phase === 'denied') {
        byId('freshness').textContent = 'Task denied';
        byId('frame-notice').textContent = 'Task denied by owner. No credentials were accessed and no worker navigation occurred.';
        byId('frame-shell').classList.add('stale');
        byId('overlay').replaceChildren();
        overlayNodes.clear();
      } else if (state.phase === 'completed') {
        byId('freshness').textContent = 'Final captured frame';
        byId('frame-notice').textContent = 'Task complete. This is the final captured frame; no model received this view.';
      } else {
        byId('freshness').textContent = 'Final captured frame';
        byId('frame-notice').textContent = 'Execution halted. The last captured frame is not a live page. Start a new task to continue.';
        byId('frame-shell').classList.add('stale');
        byId('overlay').replaceChildren();
        overlayNodes.clear();
      }
    }
  }

  async function renderFrame(frame) {
    if (current.phase === 'stopped' || current.phase === 'takeover' || current.phase === 'denied') return;
    const generation = ++frameGeneration;
    const image = byId('frame');
    byId('overlay').style.visibility = 'hidden';
    image.src = 'data:image/png;base64,' + frame.image;
    try { await image.decode(); } catch { return; }
    if (generation !== frameGeneration || current.phase === 'stopped' || current.phase === 'takeover' || current.phase === 'denied') return;
    lastFrameAt = performance.now();
    byId('canvas').hidden = false;
    byId('empty').hidden = true;
    byId('frame-shell').classList.remove('stale');
    byId('freshness').textContent = terminal ? 'Final captured frame' : 'Live · ' + new Date(frame.capturedAt).toLocaleTimeString();
    const active = new Set();
    const requestsList = current.requests || [];
    for (const annotation of frame.annotations) {
      const index = requestsList.findIndex(request => request.id === annotation.id);
      if (index < 0 || !categoryNames[annotation.category]) continue;
      for (const role of ['source', 'field']) {
        const key = annotation.id + ':' + role;
        active.add(key);
        let node = overlayNodes.get(key);
        if (!node) {
          node = text('div', '', 'annotation ' + role + ' ' + annotation.category);
          node.append(text('span', String(index + 1), 'marker'));
          byId('overlay').append(node);
          overlayNodes.set(key, node);
        }
        const rect = annotation[role];
        node.style.left = (100 * rect.x / frame.width) + '%';
        node.style.top = (100 * rect.y / frame.height) + '%';
        node.style.width = (100 * rect.width / frame.width) + '%';
        node.style.height = (100 * rect.height / frame.height) + '%';
        node.classList.toggle('selected', selected === annotation.id);
      }
    }
    for (const [key, node] of overlayNodes) {
      if (!active.has(key)) {
        node.remove();
        overlayNodes.delete(key);
      }
    }
    byId('overlay').style.visibility = 'visible';
  }

  window.autoMateOwnerUpdate = update => {
    if (update.kind === 'state') renderState(update.state);
    if (update.kind === 'frame') void renderFrame(update.frame);
    if (update.kind === 'fault') {
      frameGeneration++;
      byId('frame-shell').classList.add('stale');
      byId('freshness').textContent = 'Preview paused';
      byId('frame-notice').textContent = 'The page or its verified evidence changed. Execution has been halted; old annotations are hidden.';
    }
  };

  setInterval(() => {
    if (!terminal && lastFrameAt && performance.now() - lastFrameAt > 2500) {
      byId('frame-shell').classList.add('stale');
      byId('freshness').textContent = 'Stale · No current frame';
    }
  }, 500);
})();
