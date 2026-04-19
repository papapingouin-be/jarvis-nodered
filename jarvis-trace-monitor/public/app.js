const state = {
  selectedTraceId: null,
  flows: []
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

async function api(path) {
  const res = await fetch(path);
  return res.json();
}

function renderFlows(items) {
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
  const query = new URLSearchParams({
    status: els.statusFilter.value,
    service: els.serviceFilter.value,
    tool: els.toolFilter.value,
    q: els.qFilter.value
  });
  const data = await api(`/api/flows?${query.toString()}`);
  state.flows = data.items;
  renderFlows(data.items);
}

function renderTrace(flow, events) {
  els.traceHeader.innerHTML = `<strong>${flow.trace_id}</strong> ${statusBadge(flow.status)} · ${flow.insights.join(' | ')}`;

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
  state.selectedTraceId = traceId;
  const data = await api(`/api/flows/${traceId}`);
  renderTrace(data.flow, data.events);
  loadWaterfall(traceId);
}

async function loadWaterfall(traceId = state.selectedTraceId) {
  if (!traceId) {
    els.waterfallWrap.textContent = 'Sélectionnez un flux dans la vue Live pour afficher le waterfall.';
    return;
  }

  const data = await api(`/api/flows/${traceId}/waterfall`);
  const items = data.items;
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
}

async function loadServices() {
  const data = await api('/api/services');
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
}

function activateTab(tabId) {
  els.tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  els.panels.forEach((panel) => panel.classList.toggle('active', panel.id === tabId));

  if (tabId === 'services') loadServices();
  if (tabId === 'waterfall') loadWaterfall();
}

function bindUI() {
  els.tabs.forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));
  els.refreshFlows.addEventListener('click', loadFlows);

  const stream = new EventSource('/api/stream');
  stream.addEventListener('event_ingested', () => {
    loadFlows();
    if (state.selectedTraceId) {
      loadTrace(state.selectedTraceId);
    }
    if (document.getElementById('services').classList.contains('active')) {
      loadServices();
    }
  });
}

bindUI();
loadFlows();
setInterval(loadFlows, 5000);
