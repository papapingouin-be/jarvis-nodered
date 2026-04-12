const els = {
  navButtons: [...document.querySelectorAll('.nav-btn')],
  views: [...document.querySelectorAll('.view')],
  dbPath: document.getElementById('dbPath'),
  flowEndpoint: document.getElementById('flowEndpoint'),
  devBackendUrl: document.getElementById('devBackendUrl'),
  healthDb: document.getElementById('healthDb'),
  healthRunner: document.getElementById('healthRunner'),
  healthDev: document.getElementById('healthDev'),
  healthLlm: document.getElementById('healthLlm'),
  kpiTools: document.getElementById('kpiTools'),
  kpiPyFiles: document.getElementById('kpiPyFiles'),
  kpiRuns: document.getElementById('kpiRuns'),
  dashboardRuns: document.getElementById('dashboardRuns'),
  toolList: document.getElementById('toolList'),
  toolSelect: document.getElementById('toolSelect'),
  toolSearch: document.getElementById('toolSearch'),
  runMode: document.getElementById('runMode'),
  toolInput: document.getElementById('toolInput'),
  toolOutput: document.getElementById('toolOutput'),
  toolDiagnostics: document.getElementById('toolDiagnostics'),
  toolTrace: document.getElementById('toolTrace'),
  validateInput: document.getElementById('validateInput'),
  runTool: document.getElementById('runTool'),
  explainRun: document.getElementById('explainRun'),
  builderWrap: document.getElementById('builderWrap'),
  btnLoadSample: document.getElementById('btnLoadSample'),
  quickNpmDirect: document.getElementById('quickNpmDirect'),
  quickNpmRunner: document.getElementById('quickNpmRunner'),
  quickFlow: document.getElementById('quickFlow'),
  flowPayload: document.getElementById('flowPayload'),
  flowResponse: document.getElementById('flowResponse'),
  flowSend: document.getElementById('flowSend'),
  flowReset: document.getElementById('flowReset'),
  codeFileList: document.getElementById('codeFileList'),
  codeFileSelect: document.getElementById('codeFileSelect'),
  codeLanguage: document.getElementById('codeLanguage'),
  codeEditor: document.getElementById('codeEditor'),
  loadCodeBtn: document.getElementById('loadCodeBtn'),
  lintCodeBtn: document.getElementById('lintCodeBtn'),
  saveCodeBtn: document.getElementById('saveCodeBtn'),
  lintResult: document.getElementById('lintResult'),
  codeMeta: document.getElementById('codeMeta'),
  cfgNamespace: document.getElementById('cfgNamespace'),
  loadNamespace: document.getElementById('loadNamespace'),
  sensitiveTable: document.getElementById('sensitiveTable'),
  dbTableSelect: document.getElementById('dbTableSelect'),
  loadTableBtn: document.getElementById('loadTableBtn'),
  dbTableWrap: document.getElementById('dbTableWrap'),
  refreshRuns: document.getElementById('refreshRuns'),
  runsList: document.getElementById('runsList'),
  runDetail: document.getElementById('runDetail'),
  llmQuestion: document.getElementById('llmQuestion'),
  llmExplain: document.getElementById('llmExplain'),
  llmOutput: document.getElementById('llmOutput'),
};

const storage = {
  dbPath: 'jarvis_db_path',
  flowEndpoint: 'jarvis_flow_endpoint',
  devBackendUrl: 'jarvis_dev_backend_url',
};

const state = {
  tools: [],
  pyFiles: [],
  currentTool: null,
  lastRun: null,
  runs: [],
  editorTab: 'json',
};

function loadSettings() {
  els.dbPath.value = localStorage.getItem(storage.dbPath) || '';
  els.flowEndpoint.value = localStorage.getItem(storage.flowEndpoint) || 'http://localhost:1880/jarvis/inbound';
  els.devBackendUrl.value = localStorage.getItem(storage.devBackendUrl) || 'proxy';
}

function saveSettings() {
  localStorage.setItem(storage.dbPath, els.dbPath.value.trim());
  localStorage.setItem(storage.flowEndpoint, els.flowEndpoint.value.trim());
  localStorage.setItem(storage.devBackendUrl, els.devBackendUrl.value.trim());
}

function pretty(v) { return JSON.stringify(v, null, 2); }

function logUi(...args) {
  const line = `[${new Date().toISOString()}] ` + args.map(v => typeof v === 'string' ? v : pretty(v)).join(' ');
  console.log('[DevLab]', ...args);
  if (els.toolDiagnostics) {
    const current = els.toolDiagnostics.textContent || '';
    if (current.length < 12000) {
      els.toolDiagnostics.textContent = (current ? current + "\n\n" : '') + line;
    }
  }
}

async function settled(label, fn) {
  try {
    const value = await fn();
    logUi(`${label}: ok`);
    return { ok: true, value };
  } catch (err) {
    logUi(`${label}: error`, err.message || String(err));
    return { ok: false, error: err };
  }
}

function setBadge(el, text, type = '') {
  el.textContent = text;
  el.className = `badge ${type}`.trim();
}

async function api(action, payload = {}) {
  logUi("api request", { action, payload });
  const res = await fetch('api.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, db_path: els.dbPath.value.trim(), ...payload }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    logUi("api error", { action, status: res.status, data });
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

async function devApi(path, body = null, method = 'POST', query = null) {
  const rawBase = els.devBackendUrl.value.trim();
  const proxyOverride = rawBase.startsWith('proxy:') ? rawBase.slice('proxy:'.length).trim() : null;
  const useProxy = rawBase === 'proxy' || rawBase === '' || rawBase.startsWith('proxy:');
  logUi('devApi request', { path, method, query, via: useProxy ? 'proxy' : rawBase, proxyOverride });

  if (useProxy) {
    const res = await fetch('devproxy.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, body, method, query, base_url: proxyOverride || undefined }),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok || data.error) {
      logUi('devApi proxy error', { path, status: res.status, data });
      throw new Error(data.error || text || `HTTP ${res.status}`);
    }
    return data;
  }

  let url = `${rawBase.replace(/\/$/, '')}${path}`;
  if (query) url += `?${new URLSearchParams(query).toString()}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok || data.error) {
    logUi('devApi direct error', { path, status: res.status, data });
    throw new Error(data.error || text || `HTTP ${res.status}`);
  }
  return data;
}

function defaultFlowPayload() {
  return {
    channel: 'openwebui',
    user_id: 'demo-user',
    conversation_id: `conv-${Date.now()}`,
    message_id: `msg-${Date.now()}`,
    text: 'liste les services npm',
    attachments: [],
    timestamp: new Date().toISOString(),
    reply_policy: 'same_channel',
    meta: {
      source: 'devlab-flow-test',
      toolbox_runner_url: 'http://localhost:8030',
    },
  };
}

function switchView(name) {
  els.navButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.view === name));
  els.views.forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
  window.location.hash = name;
}

function renderBuilder(tool) {
  const schema = tool?.input_schema;
  if (!schema || !schema.properties) {
    els.builderWrap.innerHTML = '<div class="muted">Aucun builder disponible.</div>';
    return;
  }
  const html = Object.entries(schema.properties).map(([key, meta]) => {
    const type = meta?.type === 'integer' ? 'number' : 'text';
    const label = `${key}${(tool.required_fields || []).includes(key) ? ' *' : ''}`;
    return `<div style="margin-bottom:.65rem;"><label>${label}</label><input data-builder-key="${key}" data-builder-type="${meta?.type || 'string'}" value="${(meta?.enum?.[0] ?? meta?.default ?? '')}" type="${type}" /></div>`;
  }).join('');
  els.builderWrap.innerHTML = `<div class="small muted" style="margin-bottom:.6rem;">Builder rapide basé sur le manifest.</div>${html}`;
  [...els.builderWrap.querySelectorAll('[data-builder-key]')].forEach(input => {
    input.addEventListener('input', builderToJson);
  });
}

function builderToJson() {
  const out = {};
  [...els.builderWrap.querySelectorAll('[data-builder-key]')].forEach(input => {
    const key = input.dataset.builderKey;
    const type = input.dataset.builderType;
    if (input.value === '') return;
    if (type === 'integer' || type === 'number') out[key] = Number(input.value);
    else if (type === 'boolean') out[key] = input.value === 'true';
    else out[key] = input.value;
  });
  els.toolInput.value = pretty(out);
}

function renderToolList() {
  const filter = els.toolSearch.value.trim().toLowerCase();
  const tools = state.tools.filter(t => !filter || t.name.toLowerCase().includes(filter) || (t.description || '').toLowerCase().includes(filter));
  els.toolList.innerHTML = tools.map(tool => `
    <button class="tool-item ${state.currentTool?.name === tool.name ? 'active' : ''}" data-tool-name="${tool.name}">
      <div><strong>${tool.name}</strong></div>
      <div class="small muted">${tool.description || 'sans description'}</div>
      <div class="small muted">${tool.entrypoint}</div>
    </button>
  `).join('') || '<div class="muted">Aucun outil.</div>';
  [...els.toolList.querySelectorAll('[data-tool-name]')].forEach(btn => btn.onclick = () => selectTool(btn.dataset.toolName));
}

function renderToolSelect() {
  els.toolSelect.innerHTML = state.tools.map(tool => `<option value="${tool.name}">${tool.name}</option>`).join('');
  if (state.currentTool) els.toolSelect.value = state.currentTool.name;
}

function loadToolSample(tool) {
  const sample = tool?.sample_input && Object.keys(tool.sample_input).length ? tool.sample_input : {};
  els.toolInput.value = pretty(sample);
}

function selectTool(toolName) {
  const tool = state.tools.find(t => t.name === toolName);
  if (!tool) return;
  state.currentTool = tool;
  renderToolList();
  renderToolSelect();
  renderBuilder(tool);
  loadToolSample(tool);
  els.toolOutput.textContent = pretty({ info: 'Tool sélectionné', tool: tool.name, required_fields: tool.required_fields });
  els.toolDiagnostics.textContent = pretty({
    aide: 'Séquence du Tool Lab',
    etapes: [
      '1. Le JSON de gauche = uniquement ton input manuel.',
      '2. Les secrets et paramètres DB ne sont pas copiés automatiquement dans ce JSON, sauf si le tool le prévoit.',
      '3. En mode direct/runner, le tool peut ensuite lire la DB lui-même.',
      '4. La sortie = résultat final du tool.',
      '5. La trace visuelle = étapes exécutées par le backend DevLab.'
    ],
    tool: tool.name,
    required_fields: tool.required_fields || [],
    conseil: 'Pour forcer un backend via proxy, mets par exemple proxy:http://192.168.11.206:8090 dans URL Dev backend.'
  });
  els.toolTrace.innerHTML = '';
}

function renderTrace(trace) {
  if (!trace?.spans?.length) {
    els.toolTrace.innerHTML = '<div class="muted">Pas de trace disponible.</div>';
    return;
  }
  els.toolTrace.innerHTML = trace.spans.map(span => `
    <div class="trace-step ${span.status}">
      <div class="status-line"><strong>${span.name}</strong><span class="badge ${span.status === 'ok' ? 'ok' : span.status === 'failed' ? 'err' : 'warn'}">${span.status}</span></div>
      <div class="small muted">${span.t0_ms ?? 0} ms → ${span.t1_ms ?? '?'} ms</div>
      <pre>${pretty(span.data || span.error || {})}</pre>
    </div>
  `).join('');
}

function renderDashboard() {
  els.kpiTools.textContent = state.tools.length;
  els.kpiPyFiles.textContent = state.pyFiles.length;
  els.kpiRuns.textContent = state.runs.length;
  els.dashboardRuns.innerHTML = state.runs.slice(0, 6).map(run => `
    <div class="trace-step ${run.status === 'ok' ? 'ok' : 'failed'}" style="margin-bottom:.5rem;">
      <div class="status-line"><strong>${run.tool_name}</strong><span class="badge">${run.mode}</span><span class="badge ${run.status === 'ok' ? 'ok' : 'err'}">${run.status}</span></div>
      <div class="small muted">${run.started_at} · ${run.duration_ms} ms</div>
    </div>`).join('') || '<div class="muted">Aucun run enregistré.</div>';
}

async function refreshHealth() {
  const health = await settled('healthcheck', () => api('healthcheck'));
  if (health.ok) {
    const data = health.value;
    setBadge(els.healthDb, data.tools_root_exists ? `DB ${data.tables.length} tables` : 'DB / repo ?', data.tools_root_exists ? 'ok' : 'warn');
    if (data.runner_health?.status === 'ok') setBadge(els.healthRunner, 'Runner OK', 'ok');
    else if (data.runner_error) setBadge(els.healthRunner, 'Runner KO', 'err');
    else setBadge(els.healthRunner, 'Runner ?', 'warn');
    logUi('healthcheck payload', data);
  } else {
    setBadge(els.healthDb, 'DB KO', 'err');
    setBadge(els.healthRunner, 'Runner KO', 'err');
  }

  const dev = await settled('dev health', () => devApi('/health', null, 'GET'));
  if (dev.ok) setBadge(els.healthDev, dev.value.status === 'ok' ? 'Dev OK' : 'Dev ?', dev.value.status === 'ok' ? 'ok' : 'warn');
  else setBadge(els.healthDev, 'Dev KO', 'err');

  const llm = await settled('llm health', async () => {
    const data = await devApi('/health', null, 'GET');
    return data.llm_adapter_url || null;
  });
  setBadge(els.healthLlm, llm.ok ? 'LLM via adapter' : 'LLM ?', llm.ok ? 'ok' : 'warn');
}

async function loadInventory() {
  const toolsResult = await settled('list_python_tools', () => api('list_python_tools'));
  const filesResult = await settled('list_python_files', () => api('list_python_files'));
  state.tools = toolsResult.ok ? (toolsResult.value.items || []) : [];
  state.pyFiles = filesResult.ok ? (filesResult.value.items || []) : [];
  renderToolSelect();
  renderToolList();
  if (!state.currentTool && state.tools.length) selectTool(state.tools[0].name);
  renderCodeFiles();
  renderDashboard();
}

function renderCodeFiles() {
  els.codeFileSelect.innerHTML = state.pyFiles.map(file => `<option value="${file.path}">${file.path}</option>`).join('');
  els.codeFileList.innerHTML = state.pyFiles.map(file => `
    <button class="tool-item" data-file-path="${file.path}">
      <div><strong>${file.filename}</strong></div>
      <div class="small muted">${file.path}</div>
      <div class="small muted">${file.manifest_exists ? 'manifest OK' : 'sans manifest'} · ${file.size} octets</div>
    </button>
  `).join('') || '<div class="muted">Aucun fichier Python.</div>';
  [...els.codeFileList.querySelectorAll('[data-file-path]')].forEach(btn => btn.onclick = () => {
    els.codeFileSelect.value = btn.dataset.filePath;
    loadCode();
  });
}

async function loadCode() {
  const path = els.codeFileSelect.value;
  if (!path) return;
  const data = await api('get_python_file', { path });
  els.codeEditor.value = data.code;
  els.codeMeta.textContent = pretty({ path: data.path, size: data.code.length, db_path: els.dbPath.value.trim() || '/tmp/jarvis_infra.db' });
}

async function saveCode() {
  const path = els.codeFileSelect.value;
  const data = await api('save_python_file', { path, code: els.codeEditor.value });
  els.codeMeta.textContent = pretty({ saved: true, path: data.path, length: els.codeEditor.value.length });
}

async function lintCode() {
  const language = els.codeLanguage.value;
  const filename = els.codeFileSelect.value ? els.codeFileSelect.value.split('/').pop() : `snippet.${language === 'python' ? 'py' : language === 'json' ? 'json' : 'js'}`;
  const data = await devApi('/lint', { code: els.codeEditor.value, language, filename });
  els.lintResult.textContent = pretty(data);
}

async function validateToolInput() {
  if (!state.currentTool) return;
  let input;
  try { input = JSON.parse(els.toolInput.value || '{}'); }
  catch (e) { els.toolDiagnostics.textContent = pretty({ valid: false, errors: [e.message] }); return; }
  const data = await devApi('/validate', { schema: state.currentTool.input_schema || {}, payload: input });
  els.toolDiagnostics.textContent = pretty(data);
}

async function executeTool(mode = null, quickPayload = null) {
  if (!state.currentTool) return;
  let input;
  if (quickPayload) input = quickPayload;
  else {
    try { input = JSON.parse(els.toolInput.value || '{}'); }
    catch (e) { els.toolDiagnostics.textContent = pretty({ error: e.message }); return; }
  }
  const data = await devApi('/run', {
    tool: state.currentTool.name,
    mode: mode || els.runMode.value,
    db_path: els.dbPath.value.trim(),
    input,
    options: { timeout_s: 30, store_run: true, redaction: true },
  });
  state.lastRun = data;
  els.toolOutput.textContent = pretty(data.output);
  els.toolDiagnostics.textContent = pretty(data.diagnostics);
  renderTrace(data.trace);
  await loadRuns();
  renderDashboard();
}

async function explainLastRun() {
  if (!state.lastRun) {
    els.llmOutput.textContent = 'Aucun run disponible.';
    return;
  }
  const data = await devApi('/llm/explain', { run: state.lastRun, trace: state.lastRun.trace, question: els.llmQuestion.value.trim() || undefined });
  els.llmOutput.textContent = pretty(data);
  els.toolDiagnostics.textContent = pretty(data);
  switchView('llm');
}

async function loadNamespace() {
  const ns = els.cfgNamespace.value;
  const data = await api('list_sensitive', { namespace: ns });
  const rows = data.items || [];
  if (rows.length === 0) {
    els.sensitiveTable.innerHTML = '<tr><td colspan="3" class="muted">Aucune valeur.</td></tr>';
    return;
  }
  els.sensitiveTable.innerHTML = rows.map(row => `
    <tr>
      <td><code>${row.key}</code></td>
      <td><input data-sensitive-key="${row.key}" value="${String(row.value).replace(/"/g, '&quot;')}" /></td>
      <td><button class="secondary" data-save-sensitive="${row.key}">Save</button></td>
    </tr>
  `).join('');
  [...els.sensitiveTable.querySelectorAll('[data-save-sensitive]')].forEach(btn => btn.onclick = async () => {
    const key = btn.dataset.saveSensitive;
    const input = els.sensitiveTable.querySelector(`[data-sensitive-key="${key}"]`);
    await api('upsert_sensitive', { namespace: ns, key, value: input.value });
    await loadNamespace();
  });
}

async function loadTables() {
  const data = await api('list_tables');
  els.dbTableSelect.innerHTML = (data.items || []).map(item => `<option value="${item.name}">${item.name}</option>`).join('');
}

async function loadSelectedTable() {
  const table = els.dbTableSelect.value;
  if (!table) return;
  const data = await api('get_table_rows', { table, limit: 100, offset: 0 });
  const head = `<tr>${data.columns.map(col => `<th>${col}</th>`).join('')}</tr>`;
  const body = data.rows.map(row => `<tr>${data.columns.map(col => `<td>${escapeHtml(String(row[col] ?? ''))}</td>`).join('')}</tr>`).join('');
  els.dbTableWrap.innerHTML = `<table><thead>${head}</thead><tbody>${body || `<tr><td colspan="${data.columns.length}">Aucune ligne.</td></tr>`}</tbody></table>`;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadRuns() {
  const data = await devApi('/runs/list', { db_path: els.dbPath.value.trim(), limit: 100, offset: 0 });
  state.runs = data.items || [];
  els.runsList.innerHTML = state.runs.map(run => `
    <button class="tool-item" data-run-id="${run.run_id}">
      <div class="status-line"><strong>${run.tool_name}</strong><span class="badge">${run.mode}</span><span class="badge ${run.status === 'ok' ? 'ok' : 'err'}">${run.status}</span></div>
      <div class="small muted">${run.started_at} · ${run.duration_ms} ms</div>
    </button>
  `).join('') || '<div class="muted">Aucun run.</div>';
  [...els.runsList.querySelectorAll('[data-run-id]')].forEach(btn => btn.onclick = async () => {
    const data = await devApi(`/runs/${btn.dataset.runId}`, null, 'GET', { db_path: els.dbPath.value.trim() });
    els.runDetail.textContent = pretty(data.item);
  });
}

async function sendFlow() {
  const endpoint = els.flowEndpoint.value.trim();
  if (!endpoint) throw new Error('Endpoint Node-RED requis');
  const payload = JSON.parse(els.flowPayload.value || '{}');
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const contentType = res.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await res.json() : await res.text();
  els.flowResponse.textContent = typeof body === 'string' ? body : pretty(body);
}

function initTabs() {
  const tabButtons = [...document.querySelectorAll('[data-editor-tab]')];
  tabButtons.forEach(btn => btn.onclick = () => {
    state.editorTab = btn.dataset.editorTab;
    tabButtons.forEach(b => b.classList.toggle('active', b === btn));
    els.builderWrap.style.display = state.editorTab === 'builder' ? 'block' : 'none';
    els.toolInput.style.display = state.editorTab === 'json' ? 'block' : 'none';
  });
  els.builderWrap.style.display = 'none';
}

function bindEvents() {
  els.navButtons.forEach(btn => btn.onclick = () => switchView(btn.dataset.view));
  els.dbPath.addEventListener('change', saveSettings);
  els.flowEndpoint.addEventListener('change', saveSettings);
  els.devBackendUrl.addEventListener('change', saveSettings);
  els.toolSearch.addEventListener('input', renderToolList);
  els.toolSelect.addEventListener('change', () => selectTool(els.toolSelect.value));
  els.btnLoadSample.onclick = () => { if (state.currentTool) loadToolSample(state.currentTool); };
  els.validateInput.onclick = async () => { try { await validateToolInput(); } catch (e) { els.toolDiagnostics.textContent = pretty({ error: e.message || String(e) }); logUi('validate input error', e.message || String(e)); } };
  els.runTool.onclick = async () => { try { await executeTool(); } catch (e) { els.toolDiagnostics.textContent = pretty({ error: e.message || String(e) }); logUi('runTool error', e.message || String(e)); } };
  els.explainRun.onclick = async () => { try { await explainLastRun(); } catch (e) { els.llmOutput.textContent = pretty({ error: e.message || String(e) }); logUi('explainRun error', e.message || String(e)); } };
  els.quickNpmDirect.onclick = async () => {
    try {
      if (state.tools.find(t => t.name === 'npm_service')) selectTool('npm_service');
      await executeTool('direct', { operation: 'list_services', instance_name: 'default' });
      switchView('tools');
    } catch (e) { els.toolDiagnostics.textContent = pretty({ error: e.message || String(e) }); logUi('quickNpmDirect error', e.message || String(e)); }
  };
  els.quickNpmRunner.onclick = async () => {
    try {
      if (state.tools.find(t => t.name === 'npm_service')) selectTool('npm_service');
      await executeTool('runner', { operation: 'list_services', instance_name: 'default' });
      switchView('tools');
    } catch (e) { els.toolDiagnostics.textContent = pretty({ error: e.message || String(e) }); logUi('quickNpmRunner error', e.message || String(e)); }
  };
  els.quickFlow.onclick = () => switchView('flow');
  els.flowReset.onclick = () => { els.flowPayload.value = pretty(defaultFlowPayload()); };
  els.flowSend.onclick = async () => {
    try { await sendFlow(); } catch (e) { els.flowResponse.textContent = pretty({ error: e.message }); }
  };
  els.loadCodeBtn.onclick = () => loadCode();
  els.lintCodeBtn.onclick = () => lintCode();
  els.saveCodeBtn.onclick = () => saveCode();
  els.loadNamespace.onclick = () => loadNamespace();
  els.loadTableBtn.onclick = () => loadSelectedTable();
  els.refreshRuns.onclick = () => loadRuns();
  els.llmExplain.onclick = explainLastRun;
}

async function bootstrap() {
  loadSettings();
  bindEvents();
  initTabs();
  els.flowPayload.value = pretty(defaultFlowPayload());
  await settled('refreshHealth', () => refreshHealth());
  await settled('loadInventory', () => loadInventory());
  await settled('loadTables', () => loadTables());
  await settled('loadNamespace', () => loadNamespace());
  await settled('loadRuns', () => loadRuns());
  renderDashboard();
  const hash = location.hash.replace('#', '');
  if (hash) switchView(hash);
  if (els.codeFileSelect.value) await settled('loadCode', () => loadCode());
}

bootstrap().catch(err => {
  console.error(err);
  logUi('bootstrap fatal', err.message || String(err));
  els.toolOutput.textContent = pretty({ error: err.message });
});
