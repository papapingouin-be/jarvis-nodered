let currentTraceId = null;
let currentTrace = null;
let selectedEvent = null;
let activeTab = 'input';
let liveSource = null;

const $ = (id) => document.getElementById(id);
const fmt = (v) => v === undefined || v === null || v === '' ? '—' : v;
const pretty = (v) => typeof v === 'string' ? v : JSON.stringify(v ?? {}, null, 2);
const short = (s, n=72) => String(s ?? '—').length > n ? String(s).slice(0, n) + '…' : String(s ?? '—');
function badge(status){ return `<span class="badge ${status || 'unknown'}">${status || 'unknown'}</span>`; }
function serviceBadge(status){ return `<span class="svc-dot ${status === 'online' ? 'online' : 'offline'}"></span>${status === 'online' ? 'online' : 'offline'}`; }

async function api(path, options){
  const res = await fetch(path, options);
  const text = await res.text();
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
    out.innerHTML = `Trace créée : <button class="linkbtn" onclick="loadTrace('${data.trace_id}')">${data.trace_id}</button> · ${data.ok ? 'OK' : 'Erreur'} · ${fmt(data.duration_ms)} ms`;
    await loadTraces();
    await loadTrace(data.trace_id);
  }catch(err){
    out.textContent = `Échec du test npm_service : ${err.message}`;
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
      list.innerHTML = `<div class="empty"><strong>Aucune trace.</strong><br><br>Ce n’est pas normal si tu viens d’appeler un outil.<br><br>Vérifie :<br>TRACE_ENABLED=true<br>TRACE_GATEWAY_URL=http://jarvis_debug_studio:4318<br><br>Ou clique sur <em>Tester npm_service</em>.</div>`;
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
    if(data.trace_id === currentTraceId) loadTrace(currentTraceId);
  });
}

document.querySelectorAll('.tabs button').forEach(btn => btn.onclick = () => {
  activeTab = btn.dataset.tab;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b === btn));
  renderDetail();
});
$('refresh-all').onclick = async () => { await loadServices(); await loadTraces(); };
$('refresh-services').onclick = loadServices;
$('probe-npm').onclick = runNpmProbe;
$('search').oninput = () => { clearTimeout(window.__searchTimer); window.__searchTimer = setTimeout(loadTraces, 250); };
$('status-filter').onchange = loadTraces;
$('live').onclick = startLive;

loadServices();
loadTraces();
