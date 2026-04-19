const state = {
  selectedTraceId: null,
  flows: [],
  stream: null
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
  traceHeader: document.getElementById('traceHeader'),
  traceSteps: document.getElementById('traceSteps'),
  traceDetails: document.getElementById('traceDetails'),
  waterfallWrap: document.getElementById('waterfallWrap'),
  servicesWrap: document.getElementById('servicesWrap')
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

function logStep(step, details) {
  const ts = new Date().toISOString();
  if (details === undefined) {
    console.log(`[JarvisTraceMonitor][${ts}] ${step}`);
    return;
  }
  console.log(`[JarvisTraceMonitor][${ts}] ${step}`, details);
}

function logError(step, error) {
  const ts = new Date().toISOString();
  console.error(`[JarvisTraceMonitor][${ts}] ${step}`, error);
}

async function api(path) {
  logStep('API request started', { path });
  const startedAt = performance.now();
  try {
    const res = await fetch(path);
    const latencyMs = Math.round(performance.now() - startedAt);
    logStep('API response received', { path, status: res.status, ok: res.ok, latencyMs });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${path}`);
    }
    const data = await res.json();
    logStep('API response parsed', {
      path,
      topLevelKeys: data && typeof data === 'object' ? Object.keys(data) : [],
      itemCount: Array.isArray(data?.items) ? data.items.length : undefined
    });
    return data;
  } catch (error) {
    logError('API request failed', { path, error: error.message });
    throw error;
  }
}

function renderFlows(items) {
  if (!items.length) {
    els.flows.innerHTML = `
      <article class="empty-state">
        <strong>Aucun flux pour le moment.</strong>
        <p>Injectez des événements via <code>POST /api/events</code>, ou lancez <code>npm run seed</code> puis rafraîchissez.</p>
      </article>
    `;
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
  const path = `/api/flows?${query.toString()}`;
  try {
    const data = await api(path);
    state.flows = data.items;
    logStep('loadFlows render', { count: data.items.length });
    renderFlows(data.items);
  } catch (error) {
    logError('loadFlows failed', error);
  }
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
    const data = await api(`/api/flows/${traceId}`);
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
    const data = await api(`/api/flows/${traceId}/waterfall`);
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
    const data = await api('/api/services');
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
}

function bindUI() {
  logStep('bindUI started');
  els.tabs.forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));
  els.refreshFlows.addEventListener('click', loadFlows);

  state.stream = new EventSource('/api/stream');
  state.stream.addEventListener('open', () => {
    logStep('SSE stream connected', { readyState: state.stream.readyState });
  });
  state.stream.addEventListener('ready', (event) => {
    logStep('SSE ready event', event.data);
  });
  state.stream.addEventListener('error', (event) => {
    logError('SSE stream error', {
      readyState: state.stream.readyState,
      eventType: event.type
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

logStep('App initialization');
bindUI();
loadFlows();
setInterval(() => {
  logStep('Periodic refresh triggered');
  loadFlows();
}, 5000);
