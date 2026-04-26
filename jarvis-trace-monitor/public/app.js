const state = {
  selectedTraceId: null,
  flows: [],
  stream: null,
  healthzAvailable: null,
  pollTimer: null,
  streamReady: false,
  debugLogs: [],
  debugSnapshot: null
};

const els = {
  tabs: document.querySelectorAll('.tab'),
  panels: document.querySelectorAll('.panel'),
  flows: document.getElementById('flows'),
  qFilter: document.getElementById('qFilter'),
  serviceFilter: document.getElementById('serviceFilter'),
  toolFilter: document.getElementById('toolFilter'),
  statusFilter: document.getElementById('statusFilter'),
  refreshFlows: document.getElementById('refreshFlows'),
  engineStatus: document.getElementById('engineStatus'),
  traceHeader: document.getElementById('traceHeader'),
  traceSteps: document.getElementById('traceSteps'),
  traceDetails: document.getElementById('traceDetails'),
  waterfallWrap: document.getElementById('waterfallWrap'),
  servicesWrap: document.getElementById('servicesWrap'),
  refreshDebug: document.getElementById('refreshDebug'),
  debugStatus: document.getElementById('debugStatus'),
  debugSummary: document.getElementById('debugSummary'),
  debugConsole: document.getElementById('debugConsole'),
  debugPayload: document.getElementById('debugPayload')
};

function statusBadge(value, clsPrefix = 'status') {
  return `<span class="badge ${clsPrefix}-${value || 'received'}">${value || 'received'}</span>`;
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function fmtDate(ts) {
  return ts ? new Date(ts).toLocaleTimeString() : '-';
}

function fmtSince(ms) {
  if (ms === null || ms === undefined) return 'jamais';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60000)} min`;
}

function logStep(step, details) {
  const ts = new Date().toISOString();
  const payload = { ts, level: 'info', step, details: details || null };
  state.debugLogs.push(payload);
  if (state.debugLogs.length > 300) {
    state.debugLogs.shift();
  }
  if (details === undefined) {
    console.log(`[JarvisTraceMonitor][${ts}] ${step}`);
    renderDebugConsole();
    return;
  }
  console.log(`[JarvisTraceMonitor][${ts}] ${step}`, details);
  renderDebugConsole();
}

function logError(step, error) {
  const ts = new Date().toISOString();
  const payload = { ts, level: 'error', step, details: error || null };
  state.debugLogs.push(payload);
  if (state.debugLogs.length > 300) {
    state.debugLogs.shift();
  }
  console.error(`[JarvisTraceMonitor][${ts}] ${step}`, error);
  renderDebugConsole();
}

async function api(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(normalizedPath, window.location.href);
  logStep('API request started', { path, resolvedUrl: url.href });
  const startedAt = performance.now();
  try {
    const res = await fetch(normalizedPath);
    const latencyMs = Math.round(performance.now() - startedAt);
    logStep('API response received', {
      path,
      resolvedUrl: url.href,
      status: res.status,
      ok: res.ok,
      latencyMs
    });
    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      logError('API non-OK response payload', {
        path,
        resolvedUrl: url.href,
        status: res.status,
        bodyPreview: errorBody.slice(0, 300)
      });
      throw new Error(`HTTP ${res.status} for ${path}${errorBody ? ` — ${errorBody.slice(0, 120)}` : ''}`);
    }
    const data = await res.json();
    logStep('API response parsed', {
      path,
      topLevelKeys: data && typeof data === 'object' ? Object.keys(data) : [],
      itemCount: Array.isArray(data?.items) ? data.items.length : undefined
    });
    return data;
  } catch (error) {
    logError('API request failed', {
      path,
      resolvedUrl: url.href,
      error: error.message,
      online: navigator.onLine
    });
    throw error;
  }
}

function getRuntimeContext() {
  const now = new Date();
  return {
    timestamp_iso: now.toISOString(),
    location: {
      href: window.location.href,
      origin: window.location.origin,
      protocol: window.location.protocol,
      host: window.location.host,
      pathname: window.location.pathname
    },
    user_agent: navigator.userAgent,
    language: navigator.language,
    languages: navigator.languages,
    online: navigator.onLine,
    visibility_state: document.visibilityState,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  };
}

function renderDebugConsole() {
  if (!els.debugConsole) return;
  const lines = state.debugLogs
    .map((entry) => {
      const suffix = entry.details ? ` ${JSON.stringify(entry.details)}` : '';
      return `[${entry.ts}] ${entry.level.toUpperCase()} ${entry.step}${suffix}`;
    })
    .join('\n');
  els.debugConsole.textContent = lines || 'Aucune entrée pour le moment…';
}

function renderDebugSummary(snapshot, fetchError = null) {
  if (!els.debugSummary || !els.debugStatus) return;

  if (fetchError || !snapshot) {
    els.debugStatus.textContent = `Diagnostic échoué: ${fetchError?.message || 'erreur inconnue'}`;
    els.debugSummary.innerHTML = `
      <article class="empty-state">
        <strong>Impossible de charger le diagnostic backend.</strong>
        <p>Erreur: ${fetchError?.message || 'N/A'}</p>
        <p>Vérifiez l'URL et l'état du backend. Tous les détails restent visibles ci-dessous.</p>
      </article>
    `;
    return;
  }

  const envCount = Array.isArray(snapshot?.backend?.env_keys) ? snapshot.backend.env_keys.length : 0;
  const endpoints = snapshot?.connectivity?.endpoints || [];
  const failing = endpoints.filter((endpoint) => endpoint.ok === false).length;
  const statusCls = failing ? 'status-error' : 'status-completed';
  els.debugStatus.innerHTML = `Diagnostic chargé à ${fmtDate(snapshot.generated_at)} · ${statusBadge(failing ? 'error' : 'completed')} (${failing} endpoint(s) en erreur)`;
  els.debugSummary.innerHTML = `
    <table class="table">
      <tbody>
        <tr><th>URL actuelle</th><td>${snapshot.client.location.href}</td></tr>
        <tr><th>Chemin backend</th><td>${snapshot.backend.cwd}</td></tr>
        <tr><th>Node version</th><td>${snapshot.backend.node_version}</td></tr>
        <tr><th>Variables d'env</th><td><span class="badge ${statusCls}">${envCount}</span></td></tr>
        <tr><th>Routes exposées</th><td>${(snapshot.backend.routes || []).join(', ')}</td></tr>
      </tbody>
    </table>
  `;
}

async function loadDebugData() {
  const startedAt = performance.now();
  els.debugStatus.textContent = 'Collecte du diagnostic en cours…';
  const client = getRuntimeContext();
  const endpointChecks = ['/api/status', '/healthz', '/api/services', '/api/flows?status=&service=&tool=&q='];
  const connectivity = [];

  for (const endpoint of endpointChecks) {
    const resolvedUrl = new URL(endpoint, window.location.href).href;
    try {
      const res = await fetch(endpoint);
      connectivity.push({
        path: endpoint,
        resolved_url: resolvedUrl,
        status: res.status,
        ok: res.ok
      });
    } catch (error) {
      connectivity.push({
        path: endpoint,
        resolved_url: resolvedUrl,
        status: null,
        ok: false,
        error: error.message
      });
    }
  }

  try {
    const backend = await api('/api/debug/web-tool');
    const snapshot = {
      generated_at: new Date().toISOString(),
      latency_ms: Math.round(performance.now() - startedAt),
      client,
      connectivity: { endpoints: connectivity },
      frontend_state: {
        selected_trace_id: state.selectedTraceId,
        stream_ready: state.streamReady,
        flows_count: state.flows.length,
        healthz_available: state.healthzAvailable
      },
      backend
    };
    state.debugSnapshot = snapshot;
    renderDebugSummary(snapshot);
    els.debugPayload.textContent = JSON.stringify(snapshot, null, 2);
    logStep('loadDebugData rendered', {
      endpoints: connectivity.length,
      backendRoutes: backend.routes?.length || 0
    });
  } catch (error) {
    state.debugSnapshot = {
      generated_at: new Date().toISOString(),
      client,
      connectivity: { endpoints: connectivity },
      frontend_state: {
        selected_trace_id: state.selectedTraceId,
        stream_ready: state.streamReady,
        flows_count: state.flows.length,
        healthz_available: state.healthzAvailable
      },
      error: error.message
    };
    renderDebugSummary(null, error);
    els.debugPayload.textContent = JSON.stringify(state.debugSnapshot, null, 2);
    logError('loadDebugData failed', { error: error.message });
  }
}

async function postJson(path, payload) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(normalizedPath, window.location.href);
  logStep('API POST request started', { path, resolvedUrl: url.href, payload });
  const startedAt = performance.now();
  const res = await fetch(normalizedPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const latencyMs = Math.round(performance.now() - startedAt);
  logStep('API POST response received', {
    path,
    resolvedUrl: url.href,
    status: res.status,
    ok: res.ok,
    latencyMs
  });
  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} for ${path}${errorBody ? ` — ${errorBody.slice(0, 120)}` : ''}`);
  }
  return res.json();
}

async function injectSampleTrace() {
  const traceId = `ui-seed-${Date.now()}`;
  const startedAt = Date.now();
  const service = 'jarvis-trace-monitor-ui';
  const common = {
    trace_id: traceId,
    service,
    severity: 'info',
    metadata: { source: 'ui-seed-button' }
  };

  await postJson('/api/events', {
    ...common,
    event: 'flow.received',
    summary: 'Seed UI: trace reçue',
    ts: new Date(startedAt).toISOString()
  });
  await postJson('/api/events', {
    ...common,
    event: 'flow.completed',
    summary: 'Seed UI: trace terminée',
    status: 'completed',
    ts: new Date(startedAt + 250).toISOString(),
    duration_ms: 250
  });
  logStep('injectSampleTrace done', { traceId });
  await loadFlows();
  await loadTrace(traceId);
  activateTab('trace');
}

function summarizeFlowsStatus(flows) {
  const lastActivityTs = flows
    .map((flow) => flow.last_ts)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  const sinceLastEventMs = lastActivityTs ? Math.max(Date.now() - new Date(lastActivityTs).getTime(), 0) : null;
  const runningFlows = flows.filter((flow) => flow.status === 'running').length;

  return {
    estimated_total_events: flows.length,
    traces_total: flows.length,
    running_flows: runningFlows,
    last_event_ts: lastActivityTs,
    since_last_event_ms: sinceLastEventMs
  };
}

async function loadMonitorStatus(flows = []) {
  if (state.healthzAvailable === null) {
    try {
      const health = await api('/healthz');
      state.healthzAvailable = Boolean(health?.ok);
    } catch (healthError) {
      state.healthzAvailable = false;
      logError('loadMonitorStatus /healthz failed', { error: healthError.message });
    }
  }

  const events = summarizeFlowsStatus(flows);
  return {
    engine: { running: state.healthzAvailable === true, uptime_ms: null },
    stream: { sse_clients: null },
    events: {
      total: events.estimated_total_events,
      traces_total: events.traces_total,
      running_flows: events.running_flows,
      since_last_event_ms: events.since_last_event_ms,
      last_event_ts: events.last_event_ts
    },
    degraded: true,
    degraded_reason: 'Mode compatibilité: statut reconstruit depuis /api/flows + /healthz'
  };
}

function renderFlows(items, monitorStatus = null) {
  if (!items.length) {
    const noEventYet = monitorStatus?.events?.total === 0;
    const runningFlows = monitorStatus?.events?.running_flows || 0;
    const engineRunning = monitorStatus?.engine?.running;
    els.flows.innerHTML = `
      <article class="empty-state">
        <strong>Aucun flux pour le moment.</strong>
        <p>${engineRunning ? 'Le moteur tourne bien.' : 'Le moteur ne répond pas correctement.'}
        ${noEventYet ? 'Aucun événement n’a encore été ingéré.' : `Événements observés: ${monitorStatus?.events?.total || 0}.`}
        ${runningFlows ? `Flux en cours détectés: ${runningFlows}.` : ''}</p>
        <p>Injectez des événements via <code>POST /api/events</code>, ou lancez <code>npm run seed</code> puis rafraîchissez.</p>
        <button id="seedFromUiBtn">Injecter un exemple depuis l'UI</button>
      </article>
    `;
    const seedBtn = document.getElementById('seedFromUiBtn');
    if (seedBtn) {
      seedBtn.addEventListener('click', async () => {
        seedBtn.disabled = true;
        seedBtn.textContent = 'Injection en cours…';
        try {
          await injectSampleTrace();
          seedBtn.textContent = 'Exemple injecté ✓';
        } catch (error) {
          logError('injectSampleTrace failed', { error: error.message });
          seedBtn.textContent = `Échec: ${error.message}`;
          seedBtn.disabled = false;
        }
      });
    }
    return;
  }

  els.flows.innerHTML = items
    .map((flow) => `
      <article class="card" data-trace-id="${flow.trace_id}">
        <div><strong>${flow.trace_id}</strong> ${statusBadge(flow.status)}</div>
        <div class="muted">${flow.entry_service} → ${flow.current_service}${flow.tool ? ` · tool:${flow.tool}` : ''}</div>
        <div>Durée: ${fmtDuration(flow.duration_ms)}</div>
        <div>Dernier: ${flow.last_summary}</div>
        <div class="muted">Début ${fmtDate(flow.start_ts)} · Dernière activité ${fmtDate(flow.last_ts)}</div>
      </article>
    `)
    .join('');

  els.flows.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('click', () => {
      loadTrace(card.dataset.traceId);
      activateTab('trace');
    });
  });
}

async function loadFlows() {
  logStep('loadFlows started');
  const query = new URLSearchParams({
    status: els.statusFilter.value,
    service: els.serviceFilter.value,
    tool: els.toolFilter.value,
    q: els.qFilter.value
  });
  const path = `api/flows?${query.toString()}`;
  try {
    const data = await api(path);
    const monitorStatus = await loadMonitorStatus(data.items);
    state.flows = data.items;
    renderEngineStatus(monitorStatus);
    logStep('loadFlows render', { count: data.items.length });
    renderFlows(data.items, monitorStatus);
  } catch (error) {
    logError('loadFlows failed', error);
    renderEngineStatus(null, error);
  }
}

function renderEngineStatus(status, error = null) {
  if (error || !status) {
    els.engineStatus.className = 'engine-status error';
    const statusHint = error?.message?.includes('404')
      ? 'endpoint backend introuvable (proxy/version backend?)'
      : 'erreur inconnue';
    els.engineStatus.textContent = `Moteur indisponible: ${error?.message || statusHint}`;
    logError('renderEngineStatus degraded', {
      reason: error?.message || 'status not returned',
      location: window.location.href
    });
    return;
  }

  const running = status.engine?.running;
  const className = status.degraded ? 'warn' : running ? 'ok' : 'warn';
  const uptime = fmtDuration(status.engine?.uptime_ms);
  const sseClients = status.stream?.sse_clients ?? '?';
  const totalEvents = status.events?.total ?? '?';
  const tracesTotal = status.events?.traces_total ?? '?';
  const lastEvent = status.events?.last_event_ts ? fmtDate(status.events.last_event_ts) : 'aucun';
  const sinceLast = fmtSince(status.events?.since_last_event_ms);

  els.engineStatus.className = `engine-status ${className}`;
  els.engineStatus.innerHTML = `
    <strong>Moteur:</strong> ${running ? 'en marche' : 'arrêté'} ·
    <strong>Uptime:</strong> ${uptime} ·
    <strong>SSE:</strong> ${sseClients} client(s) ·
    <strong>Événements:</strong> ${totalEvents} (${tracesTotal} trace(s)) ·
    <strong>Dernier événement:</strong> ${lastEvent} (${sinceLast})
    ${status.degraded ? `<br/><span class="muted">${status.degraded_reason || 'Statut partiel'}</span>` : ''}
  `;
}

function renderTrace(flow, events) {
  const insights = (flow.insights || []).join(' | ');
  els.traceHeader.innerHTML = `<strong>${flow.trace_id}</strong> ${statusBadge(flow.status)}${insights ? ` · ${insights}` : ''}`;

  els.traceSteps.innerHTML = events
    .map((evt, index) => `
      <button class="step" data-index="${index}">
        ${evt.service}<br/><small>${evt.event}</small>
      </button>
      ${index < events.length - 1 ? '<span class="arrow">→</span>' : ''}
    `)
    .join('');

  els.traceSteps.querySelectorAll('.step').forEach((step) => {
    step.addEventListener('click', () => {
      const evt = events[Number(step.dataset.index)];
      els.traceDetails.textContent = JSON.stringify(evt, null, 2);
    });
  });

  if (events.length) {
    els.traceDetails.textContent = JSON.stringify(events[0], null, 2);
  }
}

async function loadTrace(traceId) {
  logStep('loadTrace started', { traceId });
  state.selectedTraceId = traceId;
  try {
    const data = await api(`api/flows/${traceId}`);
    logStep('loadTrace render', { traceId, events: data.events.length });
    renderTrace(data.flow, data.events);
    loadWaterfall(traceId);
  } catch (error) {
    logError('loadTrace failed', { traceId, error: error.message });
    els.traceHeader.innerHTML = `<strong>${traceId}</strong> <span class="badge status-error">error</span>`;
    els.traceDetails.textContent = `Impossible de charger la trace ${traceId}: ${error.message}`;
  }
}

async function loadWaterfall(traceId = state.selectedTraceId) {
  logStep('loadWaterfall started', { traceId });
  if (!traceId) {
    els.waterfallWrap.textContent = 'Sélectionnez un flux dans la vue Live pour afficher le waterfall.';
    return;
  }

  try {
    const data = await api(`api/flows/${traceId}/waterfall`);
    const items = data.items;
    if (!items.length) {
      els.waterfallWrap.innerHTML = `<p class="empty-state">Aucun segment waterfall pour cette trace.</p>`;
      return;
    }
    const minStart = Math.min(...items.map((item) => new Date(item.start_ts).getTime()));
    const maxEnd = Math.max(...items.map((item) => new Date(item.end_ts).getTime()));
    const total = Math.max(maxEnd - minStart, 1);

    els.waterfallWrap.innerHTML = `<h3>${traceId}</h3>` + items
      .map((item) => {
        const left = ((new Date(item.start_ts).getTime() - minStart) / total) * 100;
        const width = Math.max((item.duration_ms / total) * 100, 1);
        return `
          <div class="water-row">
            <div class="water-label">${item.label} · ${item.start_event} → ${item.end_event} · ${fmtDuration(item.duration_ms)}</div>
            <div class="water-track">
              <div class="water-bar" style="left:${left}%;width:${width}%"></div>
            </div>
          </div>
        `;
      })
      .join('');
    logStep('loadWaterfall rendered', { traceId, segments: items.length });
  } catch (error) {
    logError('loadWaterfall failed', { traceId, error: error.message });
    els.waterfallWrap.innerHTML = `<p class="empty-state">Erreur waterfall: ${error.message}</p>`;
  }
}

async function loadServices() {
  logStep('loadServices started');
  try {
    const data = await api('api/services');
    if (!data.items.length) {
      els.servicesWrap.innerHTML = `
        <p class="empty-state">
          Aucun service observé pour l'instant. Dès qu'un événement est ingéré, l'état des services s'affichera ici.
        </p>
      `;
      return;
    }

    els.servicesWrap.innerHTML = `
      <table class="table">
        <thead>
          <tr>
            <th>Service</th>
            <th>État</th>
            <th>Dernière activité</th>
            <th>Événements (10m)</th>
            <th>Erreurs (10m)</th>
            <th>Latence moyenne</th>
          </tr>
        </thead>
        <tbody>
          ${data.items
            .map(
              (svc) => `
                <tr>
                  <td>${svc.service}</td>
                  <td>${statusBadge(svc.health, 'health')}</td>
                  <td>${fmtDate(svc.last_activity_ts)}</td>
                  <td>${svc.recent_event_count}</td>
                  <td>${svc.recent_error_count}</td>
                  <td>${fmtDuration(svc.avg_latency_ms)}</td>
                </tr>
              `
            )
            .join('')}
        </tbody>
      </table>
    `;
    logStep('loadServices rendered', { count: data.items.length });
  } catch (error) {
    logError('loadServices failed', error);
    els.servicesWrap.innerHTML = `<p class="empty-state">Erreur chargement services: ${error.message}</p>`;
  }
}

function activateTab(tabId) {
  els.tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  els.panels.forEach((panel) => panel.classList.toggle('active', panel.id === tabId));

  if (tabId === 'services') loadServices();
  if (tabId === 'waterfall') loadWaterfall();
  if (tabId === 'debug') loadDebugData();
}

function bindUI() {
  logStep('bindUI started');
  els.tabs.forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));
  els.refreshFlows.addEventListener('click', loadFlows);
  els.refreshDebug.addEventListener('click', loadDebugData);

  const streamPath = 'api/stream';
  const streamUrl = new URL(streamPath, window.location.href);
  logStep('SSE stream initialization', { path: streamPath, resolvedUrl: streamUrl.href });
  state.stream = new EventSource(streamPath);
  state.stream.addEventListener('open', () => {
    state.streamReady = true;
    schedulePolling();
    logStep('SSE stream connected', { readyState: state.stream.readyState });
  });
  state.stream.addEventListener('ready', (event) => {
    logStep('SSE ready event', event.data);
  });
  state.stream.addEventListener('error', (event) => {
    state.streamReady = false;
    schedulePolling();
    logError('SSE stream error', {
      readyState: state.stream.readyState,
      eventType: event.type,
      resolvedUrl: streamUrl.href
    });
  });
  state.stream.addEventListener('event_ingested', (event) => {
    logStep('SSE event_ingested received', event.data);
    loadFlows();
    if (state.selectedTraceId) {
      loadTrace(state.selectedTraceId);
    }
    if (document.getElementById('services').classList.contains('active')) {
      loadServices();
    }
  });
}

function schedulePolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
  }
  const pollEveryMs = state.streamReady ? 30000 : 5000;
  logStep('Polling schedule updated', { pollEveryMs, streamReady: state.streamReady });
  state.pollTimer = setInterval(() => {
    logStep('Periodic refresh triggered');
    loadFlows();
  }, pollEveryMs);
}

logStep('App initialization');
bindUI();
loadFlows();
schedulePolling();
