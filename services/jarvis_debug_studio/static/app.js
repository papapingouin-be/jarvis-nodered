let currentTraceId = null;
let currentTrace = null;
let selectedEvent = null;
let activeTab = 'input';
let liveSource = null;

const $ = (id) => document.getElementById(id);
const fmt = (v) => v === undefined || v === null || v === '' ? '—' : v;
const pretty = (v) => typeof v === 'string' ? v : JSON.stringify(v ?? {}, null, 2);

function badge(status){ return `<span class="badge ${status || 'ok'}">${status || 'ok'}</span>`; }
function timeShort(ts){ try { return new Date(ts).toLocaleTimeString(); } catch { return ts || ''; } }

async function loadTraces(){
  const q = $('search').value.trim();
  const status = $('status-filter').value;
  const params = new URLSearchParams({ limit: '150' });
  if(q) params.set('q', q);
  if(status) params.set('status', status);
  const r = await fetch('/api/traces?' + params.toString());
  const data = await r.json();
  renderTraces(data.items || []);
}

function renderTraces(items){
  const el = $('trace-list');
  if(!items.length){ el.innerHTML = '<div class="empty">Aucune trace.</div>'; return; }
  el.innerHTML = items.map(t => `
    <div class="trace-card ${t.trace_id === currentTraceId ? 'active' : ''}" data-trace-id="${t.trace_id}">
      <div class="trace-top"><div class="trace-id">${t.trace_id}</div>${badge(t.status)}</div>
      <div class="trace-meta">
        <span class="pill">tool: <b>${fmt(t.tool)}</b></span><span class="pill">events: ${t.events}</span><br/>
        <span class="pill">last: ${timeShort(t.last_at)}</span><span class="pill">durée obs.: ${fmt(t.observed_duration_ms)} ms</span>
        ${t.error_code ? `<br/><span class="pill">error: ${t.error_code}</span>` : ''}
      </div>
    </div>`).join('');
  el.querySelectorAll('.trace-card').forEach(card => card.onclick = () => loadTrace(card.dataset.traceId));
}

async function loadTrace(traceId){
  currentTraceId = traceId;
  const r = await fetch('/api/traces/' + encodeURIComponent(traceId));
  currentTrace = await r.json();
  selectedEvent = null;
  renderTrace();
  loadTraces();
}

function renderTrace(){
  $('trace-title').textContent = `Trace ${currentTrace.trace_id}`;
  $('trace-summary').innerHTML = `${badge(currentTrace.status)} <span class="pill">tool: <b>${fmt(currentTrace.tool)}</b></span> <span class="pill">events: ${currentTrace.events.length}</span>`;
  const tl = $('timeline');
  tl.innerHTML = currentTrace.events.map(ev => `
    <div class="event ${ev.status}" data-id="${ev.id}">
      <div class="dot"></div>
      <div class="event-card">
        <div class="event-head"><div class="phase">${ev.phase}</div><div class="time">${timeShort(ev.timestamp)} · ${fmt(ev.duration_ms)} ms</div></div>
        <div class="event-sub">${fmt(ev.service)} ${ev.tool ? '· ' + ev.tool : ''} ${ev.error_code ? '· ' + ev.error_code : ''}</div>
      </div>
    </div>`).join('');
  tl.querySelectorAll('.event').forEach(node => node.onclick = () => selectEvent(Number(node.dataset.id)));
  if(currentTrace.events.length) selectEvent(currentTrace.events[0].id);
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
  if(activeTab === 'code') content = ev.metadata?.code_preview || pretty({ file: ev.metadata?.file, entrypoint: ev.metadata?.entrypoint, command: ev.metadata?.command, function: ev.metadata?.function });
  if(activeTab === 'logs') content = pretty({ stdout: ev.metadata?.stdout || ev.output?.stdout, stderr: ev.metadata?.stderr || ev.output?.stderr, logs: ev.output?.logs });
  if(activeTab === 'error') content = pretty({ status: ev.status, error_code: ev.error_code, error_message: ev.error_message, explanation: ev.explanation });
  if(activeTab === 'meta') content = pretty(ev.metadata);
  $('detail-content').textContent = content || '—';
}

document.querySelectorAll('.tabs button').forEach(btn => btn.onclick = () => {
  activeTab = btn.dataset.tab;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b === btn));
  renderDetail();
});
$('refresh').onclick = loadTraces;
$('search').oninput = () => { clearTimeout(window.__searchTimer); window.__searchTimer = setTimeout(loadTraces, 250); };
$('status-filter').onchange = loadTraces;
$('live').onclick = () => {
  if(liveSource){ liveSource.close(); liveSource = null; $('live').textContent = 'Live: off'; $('live').classList.add('ghost'); return; }
  liveSource = new EventSource('/api/live');
  $('live').textContent = 'Live: on'; $('live').classList.remove('ghost');
  liveSource.addEventListener('trace', ev => {
    const data = JSON.parse(ev.data);
    loadTraces();
    if(data.trace_id === currentTraceId) loadTrace(currentTraceId);
  });
};
loadTraces();
