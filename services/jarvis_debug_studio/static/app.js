let currentTraceId = null;
let currentTrace = null;
let selectedEvent = null;
let activeTab = 'input';
let liveSource = null;
let lastDebugStatus = null;
let lastToolboxCheck = null;
let lastNpmProbeResult = null;
let lastIngestionProbeResult = null;
let refreshPaused = false;
let refreshIntervalMs = 5000;
let refreshTimer = null;
const inFlight = new Set();
let consecutiveFetchErrors = 0;

const $ = (id) => document.getElementById(id);
const fmt = (v) => v === undefined || v === null || v === '' ? '—' : v;
const pretty = (v) => typeof v === 'string' ? v : JSON.stringify(v ?? {}, null, 2);
const short = (s, n=72) => String(s ?? '—').length > n ? String(s).slice(0, n) + '…' : String(s ?? '—');
function badge(status){ return `<span class="badge ${status || 'unknown'}">${status || 'unknown'}</span>`; }
function serviceBadge(status){ return `<span class="svc-dot ${status === 'online' ? 'online' : 'offline'}"></span>${status === 'online' ? 'online' : 'offline'}`; }
const BROWSER_URL = 'http://192.168.11.206:4318';
const DOCKER_INTERNAL_URL = 'http://jarvis_debug_studio:8060';

async function api(path, options = {}){
  const key = `${options.method || 'GET'}:${path}`;
  if(inFlight.has(key)) return {items: []};
  inFlight.add(key);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let res;
  let text = '';
  try{
    res = await fetch(path, {...options, signal: controller.signal});
    text = await res.text();
  } finally {
    clearTimeout(timeout);
    inFlight.delete(key);
  }
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {raw: text}; }
  if(!res.ok) throw new Error(data.detail || data.message || text || res.statusText);
  return data;
}

async function loadServices(){
  const grid = $('service-grid');
  grid.innerHTML = '<div class="empty">Test des services…</div>';
  try{
    const data = await api('/api/services');
    $('service-summary').textContent = `${data.summary.online}/${data.summary.total} services en ligne · ${data.summary.offline} hors ligne`;
    grid.innerHTML = data.items.map(s => `
      <div class="service-card ${s.status}">
        <div class="service-top">
          <strong>${s.name}</strong>
          <span class="service-state">${serviceBadge(s.status)}</span>
        </div>
        <div class="service-meta">
          <div>${s.type || 'service'} · ${fmt(s.http_status)} · ${fmt(s.latency_ms)} ms</div>
          <div title="${s.url}">${short(s.url, 58)}</div>
          ${s.tools ? `<div class="tools">Outils: ${s.tools.map(t => `<code>${t}</code>`).join(' ')}</div>` : ''}
          ${s.error ? `<div class="svc-error">${s.error}</div>` : ''}
        </div>
      </div>`).join('');
  }catch(err){
    $('service-summary').textContent = 'Impossible de charger l’état des services.';
    grid.innerHTML = `<div class="empty error-text">${err.message}</div>`;
  }
}

async function runNpmProbe(){
  const out = $('probe-result');
  out.textContent = 'Appel manuel de npm_service en cours…';
  try{
    const data = await api('/api/probes/npm_service/list', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({intent:'list.services'})});
    lastNpmProbeResult = data;
    out.innerHTML = `Trace créée : <button class="linkbtn" onclick="loadTrace('${data.trace_id}')">${data.trace_id}</button> · ${data.ok ? 'OK' : 'Erreur'} · ${fmt(data.duration_ms)} ms`;
    await loadTraces();
    await loadTrace(data.trace_id);
    await loadDebugStatus();
  }catch(err){
    out.textContent = `Échec du test npm_service : ${err.message}`;
    lastNpmProbeResult = {ok:false, error: err.message};
  }
}

async function runIngestionProbe(){
  const out = $('probe-result');
  out.textContent = 'Test ingestion en cours…';
  try{
    const data = await api('/api/probes/send-test-trace', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({})});
    lastIngestionProbeResult = data;
    out.innerHTML = `Test ingestion : ${data.ok ? 'OK' : 'Erreur'} · ${fmt(data.duration_ms)} ms · status ${fmt(data.http_status)}`;
    await loadDebugStatus();
    await loadTraces();
  }catch(err){
    lastIngestionProbeResult = {ok:false, error: err.message};
    out.textContent = `Échec du test ingestion : ${err.message}`;
  }
}

async function loadDebugStatus(){
  const checks = $('debug-checks');
  const diagnosisBox = $('debug-diagnosis');
  const openwebuiBox = $('openwebui-proof');
  checks.innerHTML = '<div class="empty">Diagnostic en cours…</div>';
  diagnosisBox.innerHTML = '';
  openwebuiBox.innerHTML = '';
  try{
    const [status, toolbox] = await Promise.all([api('/api/debug/status'), api('/api/debug/toolbox-check')]);
    lastDebugStatus = status;
    lastToolboxCheck = toolbox;
    $('debug-summary').textContent = `Événements DB: ${status.events_count_db} · Traces DB: ${status.traces_count_db} · Reçus depuis démarrage: ${status.received_events_since_start}`;
    const rows = [
      ['Jarvis Debug Studio est-il online ?', status.debug_studio.online ? 'ok' : 'error', `port interne ${status.debug_studio.internal_port}`],
      ['Adresse navigateur', 'ok', BROWSER_URL],
      ['Adresse interne Docker', 'ok', DOCKER_INTERNAL_URL],
      ['Est-ce que /api/trace/event reçoit des événements ?', status.trace_ingestion.received_events_since_start > 0 ? 'ok' : 'warning', `reçus=${status.trace_ingestion.received_events_since_start}`],
      ['Est-ce que le fichier SQLite existe ?', status.storage.db_exists ? 'ok' : 'error', status.storage.db_path],
      ['Combien d’événements sont stockés (DB) ?', 'ok', String(status.events_count_db)],
      ['Dernier événement reçu en mémoire', status.last_received_event_memory ? 'ok' : 'warning', short(pretty(status.last_received_event_memory), 130)],
      ['Dernier événement DB', status.last_event_db ? 'ok' : 'warning', short(pretty(status.last_event_db), 130)],
      ['Dernière trace DB', status.last_trace_db ? 'ok' : 'warning', short(pretty(status.last_trace_db), 130)],
      ['Quelle est la valeur attendue de TRACE_ENABLED ?', 'ok', status.configuration_expected.TRACE_ENABLED],
      ['Quelle est la valeur attendue de TRACE_GATEWAY_URL ?', 'ok', status.configuration_expected.TRACE_GATEWAY_URL],
      ['Est-ce que toolbox_runner sait joindre Jarvis Debug Studio ?', toolbox.reachable ? 'ok' : 'error', toolbox.error || 'reachable'],
      ['Est-ce que le bouton Tester npm_service crée bien une trace ?', lastNpmProbeResult?.ok ? 'ok' : 'warning', lastNpmProbeResult ? (lastNpmProbeResult.trace_id || lastNpmProbeResult.error || 'test non concluant') : 'pas encore testé'],
      ['Dernier test manuel ingestion', lastIngestionProbeResult?.ok ? 'ok' : 'warning', lastIngestionProbeResult ? (lastIngestionProbeResult.error || `http_status=${fmt(lastIngestionProbeResult.http_status)}`) : 'pas encore testé'],
      ['Est-ce que les événements sont rejetés à cause d’un mauvais JSON ?', status.trace_ingestion.invalid_json_count > 0 ? 'warning' : 'ok', `invalid_json_count=${status.trace_ingestion.invalid_json_count}`],
    ];
    checks.innerHTML = rows.map(([label, level, value]) => `<div class="diag-row"><div class="diag-label">${label}</div><div>${badge(level)}</div><div class="diag-value">${value}</div></div>`).join('');
    diagnosisBox.innerHTML = status.diagnosis.map(d => `<div class="diag-item ${d.level}">${badge(d.level)} <strong>${d.message}</strong><div>${fmt(d.probable_cause)}</div><div class="muted">Action: ${fmt(d.action)}</div></div>`).join('');
    const openwebui = toolbox.openwebui_proof || {};
    const realCalls = toolbox.real_calls || {};
    const openwebuiText = `list_tools=${openwebui.openwebui_list_tools_seen ? 'true' : 'false'} · tool_call=${openwebui.openwebui_tool_call_seen ? 'true' : 'false'}`;
    openwebuiBox.innerHTML = `
      <div class="diag-item ${(openwebui.openwebui_list_tools_seen || openwebui.openwebui_tool_call_seen) ? 'ok' : 'warning'}">
        ${badge((openwebui.openwebui_list_tools_seen || openwebui.openwebui_tool_call_seen) ? 'ok' : 'warning')}
        <strong>${openwebuiText}</strong>
        <div>Dernier list_tools OpenWebUI: ${short(pretty(openwebui.last_openwebui_list_tools_call), 180)}</div>
        <div>Dernier vrai tool call OpenWebUI: ${short(pretty(openwebui.last_openwebui_tool_call), 180)}</div>
        <div>Dernier appel réel toolbox_runner (/debug/real-calls): ${short(pretty(realCalls.latest), 180)}</div>
      </div>
    `;
  }catch(err){
    $('debug-summary').textContent = 'Impossible de charger le diagnostic.';
    checks.innerHTML = `<div class="empty error-text">${err.message}</div>`;
  }
}

async function copyDebugReport(){
  const status = lastDebugStatus || await api('/api/debug/status');
  const toolbox = lastToolboxCheck || await api('/api/debug/toolbox-check');
  const report = [
    'AI Debug Report',
    `services_online=${status.debug_studio.online}`,
    `debug_studio_url_host=${BROWSER_URL}`,
    `debug_studio_url_internal=${DOCKER_INTERNAL_URL}`,
    `trace_gateway_expected=${status.configuration_expected.TRACE_GATEWAY_URL}`,
    `traces_count=${status.storage.traces_count}`,
    `events_count=${status.storage.events_count}`,
    `events_count_db=${status.events_count_db}`,
    `traces_count_db=${status.traces_count_db}`,
    `received_events_since_start=${status.received_events_since_start}`,
    `last_event=${JSON.stringify(status.last_event)}`,
    `last_event_db=${JSON.stringify(status.last_event_db)}`,
    `last_trace_db=${JSON.stringify(status.last_trace_db)}`,
    `last_received_event_memory=${JSON.stringify(status.last_received_event_memory)}`,
    `last_received_event_db=${JSON.stringify(status.last_received_event_db)}`,
    `toolbox_check=${JSON.stringify({reachable: toolbox.reachable, latency_ms: toolbox.latency_ms, tools: toolbox.tools?.available, error: toolbox.error})}`,
    `openwebui_proof=${JSON.stringify(toolbox.openwebui_proof || {})}`,
    `npm_probe=${JSON.stringify(lastNpmProbeResult || {ok:false, note:'not_run'})}`,
    `ingestion_probe=${JSON.stringify(lastIngestionProbeResult || {ok:false, note:'not_run'})}`,
  ].join('\n');
  const copied = await copyText(report);
  if(copied){
    $('debug-summary').textContent = 'Rapport copié';
    return;
  }
  $('debug-summary').textContent = 'Copie automatique impossible, rapport affiché ci-dessous.';
  $('detail-content').textContent = report;
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

async function loadTraces(){
  const params = new URLSearchParams();
  const q = $('search').value.trim();
  const status = $('status-filter').value;
  if(q) params.set('q', q);
  if(status) params.set('status', status);
  const list = $('trace-list');
  list.innerHTML = '<div class="empty">Chargement…</div>';
  try{
    const data = await api('/api/traces?' + params.toString());
    if(!data.items.length){
      list.innerHTML = `<div class="empty"><strong>Aucune trace.</strong><br><br>Ce n’est pas normal si tu viens d’appeler un outil.<br><br>Vérifie :<br>TRACE_ENABLED=true<br>TRACE_GATEWAY_URL=http://jarvis_debug_studio:8060<br><br>Consulte AI Debug Log puis clique sur <em>Tester npm_service</em>.</div>`;
      return;
    }
    list.innerHTML = data.items.map(t => `
      <div class="trace-card ${t.trace_id === currentTraceId ? 'active' : ''}" onclick="loadTrace('${t.trace_id.replaceAll("'", "\\'")}')">
        <div class="trace-top"><div class="trace-id" title="${t.trace_id}">${short(t.trace_id, 30)}</div>${badge(t.status)}</div>
        <div class="trace-meta">
          <div><span class="pill">tool</span>${fmt(t.tool)}</div>
          <div><span class="pill">events</span>${t.events} · <span class="pill">durée</span>${fmt(t.observed_duration_ms)} ms</div>
          <div>${fmt(t.last_at)}</div>
          ${t.explanation ? `<div class="explain">${short(t.explanation, 120)}</div>` : ''}
        </div>
      </div>`).join('');
  }catch(err){
    list.innerHTML = `<div class="empty error-text">${err.message}</div>`;
  }
}
async function deleteAllTraces(){
  if(!confirm('Confirmer suppression de toutes les traces ?')) return;
  await api('/api/traces', {method:'DELETE'});
  await loadTraces(); await loadDebugStatus();
}
async function deleteCurrentTrace(){
  if(!currentTraceId) return;
  await api('/api/traces/' + encodeURIComponent(currentTraceId), {method:'DELETE'});
  currentTraceId = null; currentTrace = null;
  await loadTraces(); await loadDebugStatus();
}
async function purgeOldTraces(){
  const days = Number(prompt('Supprimer les traces plus anciennes que (jours):', '7') || '7');
  await api('/api/traces/purge', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({older_than_days: days})});
  await loadTraces(); await loadDebugStatus();
}
function scheduleRefresh(){
  if(refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    if(refreshPaused || document.visibilityState === 'hidden') return;
    try{
      await Promise.all([loadServices(), loadDebugStatus(), loadTraces()]);
      consecutiveFetchErrors = 0;
      refreshIntervalMs = 5000;
    }catch{
      consecutiveFetchErrors += 1;
      if(consecutiveFetchErrors >= 3) refreshIntervalMs = refreshIntervalMs < 15000 ? 15000 : 30000;
    }finally{
      scheduleRefresh();
    }
  }, Math.max(5000, refreshIntervalMs));
}

async function loadTrace(id){
  currentTraceId = id;
  const data = await api('/api/traces/' + encodeURIComponent(id));
  currentTrace = data;
  selectedEvent = null;
  document.querySelectorAll('.trace-card').forEach(e => e.classList.toggle('active', e.textContent.includes(id)));
  $('trace-title').innerHTML = `${id} ${badge(data.status)}`;
  $('trace-summary').textContent = `${fmt(data.tool)} · ${data.events.length} événements`;
  renderTimeline();
  if(data.events.length) selectEvent(data.events[0].id);
}

function renderTimeline(){
  const box = $('timeline');
  if(!currentTrace || !currentTrace.events.length){
    box.innerHTML = '<div class="empty">Aucun événement.</div>';
    return;
  }
  box.innerHTML = currentTrace.events.map(ev => `
    <div class="event ${ev.status}" data-id="${ev.id}" onclick="selectEvent(${ev.id})">
      <div class="dot"></div>
      <div class="event-card">
        <div class="event-head"><span class="phase">${ev.phase}</span>${badge(ev.status)}</div>
        <div class="event-sub">${fmt(ev.service)} · ${fmt(ev.tool)} · ${fmt(ev.duration_ms)} ms</div>
        <div class="time">${fmt(ev.timestamp)}</div>
        ${ev.error_code ? `<div class="error-text">${ev.error_code}: ${short(ev.error_message, 140)}</div>` : ''}
      </div>
    </div>`).join('');
}

function selectEvent(id){
  selectedEvent = currentTrace.events.find(e => e.id === id);
  document.querySelectorAll('.event').forEach(e => e.classList.toggle('selected', Number(e.dataset.id) === id));
  $('detail-title').textContent = selectedEvent ? `${selectedEvent.phase}` : 'Détail étape';
  renderDetail();
}

function renderDetail(){
  if(!selectedEvent){ $('detail-content').textContent = 'Clique sur une étape.'; return; }
  const ev = selectedEvent;
  let content = '';
  if(activeTab === 'input') content = pretty(ev.input);
  if(activeTab === 'output') content = pretty(ev.output);
  if(activeTab === 'code') content = ev.metadata?.code_preview || pretty({ file: ev.metadata?.file, entrypoint: ev.metadata?.entrypoint, command: ev.metadata?.command, function: ev.metadata?.function, manifest: ev.metadata?.manifest });
  if(activeTab === 'logs') content = pretty({ stdout: ev.metadata?.stdout || ev.output?.stdout, stderr: ev.metadata?.stderr || ev.output?.stderr, logs: ev.output?.logs });
  if(activeTab === 'error') content = pretty({ status: ev.status, error_code: ev.error_code, error_message: ev.error_message, explanation: ev.explanation });
  if(activeTab === 'meta') content = pretty(ev.metadata);
  $('detail-content').textContent = content || '—';
}

function startLive(){
  if(liveSource){ liveSource.close(); liveSource = null; $('live').textContent = 'Live: off'; $('live').classList.add('ghost'); return; }
  liveSource = new EventSource('/api/live');
  $('live').textContent = 'Live: on';
  $('live').classList.remove('ghost');
  liveSource.addEventListener('trace', ev => {
    const data = JSON.parse(ev.data);
    loadTraces();
    loadDebugStatus();
    if(data.trace_id === currentTraceId) loadTrace(currentTraceId);
  });
}

document.querySelectorAll('.tabs button').forEach(btn => btn.onclick = () => {
  activeTab = btn.dataset.tab;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b === btn));
  renderDetail();
});
$('refresh-all').onclick = async () => { await loadServices(); await loadDebugStatus(); await loadTraces(); };
$('toggle-refresh').onclick = () => {
  refreshPaused = !refreshPaused;
  $('toggle-refresh').textContent = refreshPaused ? 'Reprendre refresh' : 'Pause refresh';
};
$('delete-all-traces').onclick = deleteAllTraces;
$('delete-current-trace').onclick = deleteCurrentTrace;
$('purge-traces').onclick = purgeOldTraces;
$('refresh-services').onclick = loadServices;
$('probe-npm').onclick = runNpmProbe;
$('probe-ingestion').onclick = runIngestionProbe;
$('debug-probe-npm').onclick = runNpmProbe;
$('debug-probe-ingestion').onclick = runIngestionProbe;
$('refresh-debug').onclick = loadDebugStatus;
$('copy-debug-report').onclick = copyDebugReport;
$('search').oninput = () => { clearTimeout(window.__searchTimer); window.__searchTimer = setTimeout(loadTraces, 250); };
$('status-filter').onchange = loadTraces;
$('live').onclick = startLive;

loadServices();
loadDebugStatus();
loadTraces();
scheduleRefresh();
  params.set('limit', '50');
  params.set('offset', '0');
