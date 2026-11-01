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

  function updatePlanButtonState() {
    const entry = current.taskEntry;
    byId('plan-task').disabled = !entry || terminal || entry.status !== 'idle' ||
      !byId('task-prompt').value.trim() || (entry.mode === 'cloud' && !byId('cloud-consent').checked);
  }
  byId('task-prompt').addEventListener('input', updatePlanButtonState);
  byId('cloud-consent').addEventListener('change', updatePlanButtonState);
  byId('plan-task').addEventListener('click', async () => {
    byId('plan-task').disabled = true;
    byId('task-prompt').disabled = true;
    try {
      await window.autoMatePlanTask({
        prompt: byId('task-prompt').value,
        allowCloud: byId('cloud-consent').checked,
      });
    } catch {
      byId('planner-error').textContent = 'Task request was not accepted. No execution was authorized.';
      byId('planner-error').hidden = false;
      byId('task-prompt').disabled = terminal || current.taskEntry?.status !== 'idle';
      updatePlanButtonState();
    }
  });

  function select(id) {
    selected = selected === id ? null : id;
    for (const [key, node] of overlayNodes) node.classList.toggle('selected', key.startsWith(selected + ':'));
    for (const row of byId('requests').children) row.classList.toggle('active', row.dataset.id === selected);
  }

  function renderState(state) {
    current = state;
    terminal = isTerminal(state.phase);

    const entry = state.taskEntry;
    byId('task-entry').hidden = !entry;
    if (entry) {
      const reviewed = entry.mode === 'reviewed';
      const cloud = entry.mode === 'cloud';
      byId('privacy-boundary').textContent = reviewed
        ? 'Local only · No AI connected'
        : 'Preview stays local · Only your task instruction goes to AI';
      byId('description').textContent = reviewed
        ? 'Working prototype · Reviewed command · No AI connected'
        : 'Working prototype · ' + (cloud ? 'Cloud' : 'Local') + ' model planning · Synthetic execution only';
      byId('planner-mode').textContent = reviewed ? 'Reviewed command · Offline' : (cloud ? 'Cloud' : 'Local') + ' model';
      byId('planner-privacy').textContent = reviewed
        ? 'No model request is made. Enter “Run synthetic registration” to select the reviewed workflow. Other commands are unsupported.'
        : 'Only your task instruction is sent to the configured ' + (cloud ? 'cloud' : 'loopback local') +
          ' provider. Never include secrets. Website content, preview frames, vault data, and approval controls are not sent. Provider retention is outside this app’s control.';
      byId('cloud-consent-row').hidden = !cloud;
      byId('task-prompt').disabled = terminal || entry.status !== 'idle';
      byId('cloud-consent').disabled = terminal || entry.status !== 'idle';
      byId('plan-task').textContent = reviewed ? 'Review task' : 'Ask model to plan';
      byId('planner-status').textContent = terminal ? 'Task ended. Restart the app for a new task.' :
        entry.status === 'planning' ? 'Planning · No execution authority granted' :
        entry.status === 'ready' ? 'Plan ready · Owner approval required' : 'Waiting for a task instruction';
      byId('planner-error').textContent = entry.error || '';
      byId('planner-error').hidden = !entry.error;
      byId('task-plan').hidden = entry.status !== 'ready';
      updatePlanButtonState();
    }

    const dest = state.approval?.origin || state.origin || 'Waiting for a task';
    byId('origin').textContent = dest;
    byId('approval-destination').textContent = state.approval?.origin || state.origin || '—';

    if (state.operationScope) {
      byId('approval-scope').textContent = state.operationScope;
    }

    byId('phase').textContent = !terminal && entry && entry.status !== 'ready'
      ? (entry.status === 'planning' ? 'Planning' : 'Awaiting task') : phaseNames[state.phase] || 'Paused';
    byId('approval-badge').textContent = terminal ? phaseNames[state.phase] :
      (entry && entry.status !== 'ready' ? 'Plan required before approval' :
        state.canStart ? 'Owner approval required' : 'Approved for this task');

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

  // ── Audit History Viewer ──────────────────────────────────────────
  const SESSIONS_PER_PAGE = 20;
  const EVENTS_PER_PAGE = 50;

  const historyErrorLabels = {
    INVALID_HISTORY_REQUEST: 'Invalid audit history request.',
    HISTORY_INVALID: 'Audit journal is invalid or corrupted.',
    HISTORY_TOO_LARGE: 'Audit journal exceeds maximum permitted size.',
    HISTORY_LIMIT: 'Audit directory entry limit exceeded.',
    HISTORY_UNAVAILABLE: 'Audit history is currently unavailable.',
  };

  const auditEventLabels = {
    approved: 'Task approved',
    approval_denied: 'Approval denied',
    grant_expired: 'Permission expired',
    fill_authorized: 'Fill authorized',
    submit_authorized: 'Submit authorized',
    denied: 'Operation denied',
    completed: 'Task completed',
    takeover: 'Owner takeover',
    revoked: 'Access revoked',
    stopped_all: 'Stopped all',
  };

  let historyLoaded = false;
  let sessionRequestGen = 0;
  let eventRequestGen = 0;
  let currentSessionOffset = 0;
  let sessionNextOffset = null;
  let selectedSessionId = null;
  let currentEventOffset = 0;
  let eventNextOffset = null;

  function formatTimestamp(iso) {
    if (!iso || typeof iso !== 'string') return '—';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
    } catch {
      return iso;
    }
  }

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || bytes < 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function sendHistoryCommand(cmd) {
    if (typeof window.autoMateAuditHistory !== 'function') {
      return { ok: false, code: 'HISTORY_UNAVAILABLE' };
    }
    try {
      const res = await window.autoMateAuditHistory(cmd);
      if (!res || typeof res !== 'object') {
        return { ok: false, code: 'HISTORY_UNAVAILABLE' };
      }
      return res;
    } catch {
      return { ok: false, code: 'HISTORY_UNAVAILABLE' };
    }
  }

  async function loadSessions(offset = 0) {
    const gen = ++sessionRequestGen;
    const refreshBtn = byId('history-sessions-refresh');
    const prevBtn = byId('history-sessions-prev');
    const nextBtn = byId('history-sessions-next');
    const errorEl = byId('history-sessions-error');
    const rangeEl = byId('history-sessions-range');
    const countEl = byId('history-sessions-count');
    const listEl = byId('history-sessions-list');

    if (refreshBtn) refreshBtn.disabled = true;
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;

    const res = await sendHistoryCommand({ action: 'sessions', offset });
    if (gen !== sessionRequestGen) return;

    if (refreshBtn) refreshBtn.disabled = false;

    if (!res.ok) {
      currentSessionOffset = 0;
      resetHistorySelection();
      sessionNextOffset = null;
      const code = res.code && Object.hasOwn(historyErrorLabels, res.code) ? res.code : 'HISTORY_UNAVAILABLE';
      if (errorEl) {
        errorEl.textContent = historyErrorLabels[code];
        errorEl.hidden = false;
      }
      if (rangeEl) rangeEl.textContent = 'Error loading sessions';
      if (countEl) countEl.textContent = '—';
      if (listEl) {
        listEl.replaceChildren(text('p', 'Unable to display audit sessions.', 'history-empty'));
      }
      return;
    }

    if (errorEl) {
      errorEl.hidden = true;
      errorEl.textContent = '';
    }
    historyLoaded = true;
    currentSessionOffset = res.page.offset;
    sessionNextOffset = res.page.nextOffset;

    const total = res.page.total;
    if (countEl) countEl.textContent = String(total);

    if (total === 0 || !res.page.sessions.length) {
      if (rangeEl) rangeEl.textContent = total === 0 ? '0 sessions' : 'No sessions on this page';
      if (listEl) {
        listEl.replaceChildren(text('p', 'No audit sessions found.', 'history-empty'));
      }
      resetHistorySelection();
      if (prevBtn) prevBtn.disabled = res.page.offset === 0;
      if (nextBtn) nextBtn.disabled = true;
      return;
    }

    const start = res.page.offset + 1;
    const end = res.page.offset + res.page.sessions.length;
    if (rangeEl) rangeEl.textContent = `Showing ${start}–${end} of ${total}`;

    if (prevBtn) prevBtn.disabled = res.page.offset === 0;
    if (nextBtn) nextBtn.disabled = sessionNextOffset === null;

    if (listEl) {
      const items = res.page.sessions.map(sess => {
        const item = document.createElement('div');
        const isSelected = sess.id === selectedSessionId;
        item.className = 'history-session-item' + (isSelected ? ' selected' : '');
        item.setAttribute('role', 'button');
        item.setAttribute('tabindex', '0');
        item.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
        item.dataset.sessionId = sess.id;

        const tokenRow = document.createElement('div');
        tokenRow.className = 'session-token-row';
        const tokenEl = text('span', sess.id.slice(0, 8) + '…', 'session-token');
        tokenEl.title = sess.id;
        const sizeEl = text('span', formatBytes(sess.sizeBytes), 'session-size');
        tokenRow.appendChild(tokenEl);
        tokenRow.appendChild(sizeEl);

        const timeRow = document.createElement('div');
        timeRow.className = 'session-time-row';
        const timeEl = text('span', formatTimestamp(sess.modifiedAt), 'session-time');
        timeRow.appendChild(timeEl);

        item.appendChild(tokenRow);
        item.appendChild(timeRow);

        const onSelect = () => {
          selectSession(sess.id);
        };

        item.addEventListener('click', onSelect);
        item.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        });

        return item;
      });

      listEl.replaceChildren(...items);
    }
  }

  function clearEventsView() {
    const tbody = byId('history-events-tbody');
    if (tbody) tbody.replaceChildren();
    const warningEl = byId('history-events-warning');
    if (warningEl) warningEl.hidden = true;
    const errorEl = byId('history-events-error');
    if (errorEl) {
      errorEl.hidden = true;
      errorEl.textContent = '';
    }
    const rangeEl = byId('history-events-range');
    if (rangeEl) rangeEl.textContent = 'Loading events…';
    const prevBtn = byId('history-events-prev');
    if (prevBtn) prevBtn.disabled = true;
    const nextBtn = byId('history-events-next');
    if (nextBtn) nextBtn.disabled = true;
    const refreshBtn = byId('history-events-refresh');
    if (refreshBtn) refreshBtn.disabled = (selectedSessionId === null);
  }

  function resetHistorySelection() {
    selectedSessionId = null;
    currentEventOffset = 0;
    eventNextOffset = null;
    eventRequestGen++;
    clearEventsView();
    byId('history-selected-token').textContent = 'No session selected';
    byId('history-selected-token').removeAttribute('title');
    byId('history-events-range').textContent = 'No session selected';
  }

  function selectSession(id) {
    selectedSessionId = id;
    currentEventOffset = 0;
    eventNextOffset = null;

    const listEl = byId('history-sessions-list');
    if (listEl) {
      for (const child of listEl.querySelectorAll('.history-session-item')) {
        const isSel = child.dataset.sessionId === id;
        child.classList.toggle('selected', isSel);
        child.setAttribute('aria-pressed', isSel ? 'true' : 'false');
      }
    }

    clearEventsView();

    const tokenDisplay = byId('history-selected-token');
    if (tokenDisplay) {
      tokenDisplay.textContent = id.slice(0, 8) + '…';
      tokenDisplay.title = id;
    }

    void loadEvents(id, 0);
  }

  async function loadEvents(id, offset = 0) {
    const gen = ++eventRequestGen;
    const refreshBtn = byId('history-events-refresh');
    const prevBtn = byId('history-events-prev');
    const nextBtn = byId('history-events-next');
    const errorEl = byId('history-events-error');
    const warningEl = byId('history-events-warning');
    const rangeEl = byId('history-events-range');
    const tbody = byId('history-events-tbody');

    if (refreshBtn) refreshBtn.disabled = true;
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;

    const res = await sendHistoryCommand({ action: 'events', id, offset });
    if (gen !== eventRequestGen) return;

    if (refreshBtn) refreshBtn.disabled = false;

    if (!res.ok) {
      currentEventOffset = 0;
      eventNextOffset = null;
      if (tbody) tbody.replaceChildren();
      if (warningEl) warningEl.hidden = true;
      const code = res.code && Object.hasOwn(historyErrorLabels, res.code) ? res.code : 'HISTORY_UNAVAILABLE';
      if (errorEl) {
        errorEl.textContent = historyErrorLabels[code];
        errorEl.hidden = false;
      }
      if (rangeEl) rangeEl.textContent = 'Error loading events';
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      return;
    }

    if (errorEl) {
      errorEl.hidden = true;
      errorEl.textContent = '';
    }
    currentEventOffset = res.page.offset;
    eventNextOffset = res.page.nextOffset;

    if (warningEl) {
      warningEl.hidden = !res.page.truncated;
    }

    const total = res.page.total;
    if (total === 0 || !res.page.events.length) {
      if (rangeEl) rangeEl.textContent = '0 events';
      if (tbody) {
        const tr = document.createElement('tr');
        const td = text('td', 'No events recorded in this session.', 'history-empty');
        td.colSpan = 5;
        tr.appendChild(td);
        tbody.replaceChildren(tr);
      }
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      return;
    }

    const start = res.page.offset + 1;
    const end = res.page.offset + res.page.events.length;
    if (rangeEl) rangeEl.textContent = `Showing ${start}–${end} of ${total}`;

    if (prevBtn) prevBtn.disabled = res.page.offset === 0;
    if (nextBtn) nextBtn.disabled = eventNextOffset === null;

    if (tbody) {
      const rows = res.page.events.map(ev => {
        const tr = document.createElement('tr');

        const tdSeq = text('td', '#' + ev.sequence, 'col-seq');
        const tdTime = text('td', formatTimestamp(ev.at), 'col-time');
        tdTime.title = ev.at;

        const eventLabel = Object.hasOwn(auditEventLabels, ev.event)
          ? auditEventLabels[ev.event]
          : ev.event;
        const tdEvent = document.createElement('td');
        tdEvent.className = 'col-event';
        const eventBadge = text('span', eventLabel, 'event-badge event-' + ev.event);
        tdEvent.appendChild(eventBadge);

        const tdTask = document.createElement('td');
        tdTask.className = 'col-task';
        if (ev.task) {
          const taskCode = text('code', ev.task.slice(0, 8) + '…', 'history-token');
          taskCode.title = ev.task;
          tdTask.appendChild(taskCode);
        } else {
          tdTask.textContent = '—';
        }

        const tdReason = document.createElement('td');
        tdReason.className = 'col-reason';
        if (ev.reason) {
          const reasonCode = text('code', ev.reason, 'reason-code');
          tdReason.appendChild(reasonCode);
        } else {
          tdReason.textContent = '—';
        }

        tr.appendChild(tdSeq);
        tr.appendChild(tdTime);
        tr.appendChild(tdEvent);
        tr.appendChild(tdTask);
        tr.appendChild(tdReason);
        return tr;
      });

      tbody.replaceChildren(...rows);
    }
  }

  const detailsEl = byId('history-details');
  if (detailsEl) {
    detailsEl.addEventListener('toggle', () => {
      if (detailsEl.open && !historyLoaded) {
        void loadSessions(0);
      }
    });
  }

  const sessionsRefreshBtn = byId('history-sessions-refresh');
  if (sessionsRefreshBtn) {
    sessionsRefreshBtn.addEventListener('click', () => {
      void loadSessions(currentSessionOffset);
    });
  }

  const sessionsPrevBtn = byId('history-sessions-prev');
  if (sessionsPrevBtn) {
    sessionsPrevBtn.addEventListener('click', () => {
      void loadSessions(Math.max(0, currentSessionOffset - SESSIONS_PER_PAGE));
    });
  }

  const sessionsNextBtn = byId('history-sessions-next');
  if (sessionsNextBtn) {
    sessionsNextBtn.addEventListener('click', () => {
      if (sessionNextOffset !== null) {
        void loadSessions(sessionNextOffset);
      }
    });
  }

  const eventsRefreshBtn = byId('history-events-refresh');
  if (eventsRefreshBtn) {
    eventsRefreshBtn.addEventListener('click', () => {
      if (selectedSessionId) {
        void loadEvents(selectedSessionId, currentEventOffset);
      }
    });
  }

  const eventsPrevBtn = byId('history-events-prev');
  if (eventsPrevBtn) {
    eventsPrevBtn.addEventListener('click', () => {
      if (selectedSessionId) {
        void loadEvents(selectedSessionId, Math.max(0, currentEventOffset - EVENTS_PER_PAGE));
      }
    });
  }

  const eventsNextBtn = byId('history-events-next');
  if (eventsNextBtn) {
    eventsNextBtn.addEventListener('click', () => {
      if (selectedSessionId && eventNextOffset !== null) {
        void loadEvents(selectedSessionId, eventNextOffset);
      }
    });
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
