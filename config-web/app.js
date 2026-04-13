
const $ = (id) => document.getElementById(id);

const els = {
  navButtons: [...document.querySelectorAll('.nav-btn')],
  views: [...document.querySelectorAll('.view')],
  flowEndpoint: $('flowEndpoint'),
  devBackendUrl: $('devBackendUrl'),
  healthDb: $('healthDb'),
  healthRunner: $('healthRunner'),
  healthDev: $('healthDev'),
  kpiTools: $('kpiTools'),
  kpiPyFiles: $('kpiPyFiles'),
  kpiTables: $('kpiTables'),
  dashboardSummary: $('dashboardSummary'),
  goDb: $('goDb'),
  dbActivePath: $('dbActivePath'),
  dbActiveName: $('dbActiveName'),
  dbDownloadLink: $('dbDownloadLink'),
  dbDownloadBtn: $('dbDownloadBtn'),
  dbContractWrap: $('dbContractWrap'),
  dbTableSelect: $('dbTableSelect'),
  loadTableBtn: $('loadTableBtn'),
  dbTableWrap: $('dbTableWrap'),
  cfgNamespace: $('cfgNamespace'),
  loadNamespace: $('loadNamespace'),
  sensitiveTable: $('sensitiveTable'),
  dbTransferOutput: $('dbTransferOutput'),
  dbSelectOpen: $('dbSelectOpen'),
  dbCreateOpen: $('dbCreateOpen'),
  dbUploadOpen: $('dbUploadOpen'),
  dbExportOpen: $('dbExportOpen'),
  dbDeleteBtn: $('dbDeleteBtn'),
  dbModal: $('dbModal'),
  dbModalClose: $('dbModalClose'),
  dbModalCancel: $('dbModalCancel'),
  dbBrowseRefresh: $('dbBrowseRefresh'),
  dbBrowseList: $('dbBrowseList'),
  dbActionTitle: $('dbActionTitle'),
  dbSelectedPath: $('dbSelectedPath'),
  dbActionBody: $('dbActionBody'),
  dbModalConfirm: $('dbModalConfirm'),
  dbActionOutput: $('dbActionOutput'),
  toolList: $('toolList'),
  toolSelect: $('toolSelect'),
  toolSearch: $('toolSearch'),
  toolInput: $('toolInput'),
  toolOutput: $('toolOutput'),
  toolDiagnostics: $('toolDiagnostics'),
  runTool: $('runTool'),
  validateInput: $('validateInput'),
  btnLoadSample: $('btnLoadSample'),
  codeFileList: $('codeFileList'),
  codeFileSelect: $('codeFileSelect'),
  codeEditor: $('codeEditor'),
  loadCodeBtn: $('loadCodeBtn'),
  saveCodeBtn: $('saveCodeBtn'),
  codeMeta: $('codeMeta'),
};

const storage = {
  dbPath: 'jarvis_db_path',
  flowEndpoint: 'jarvis_flow_endpoint',
  devBackendUrl: 'jarvis_dev_backend_url',
};

const state = {
  healthcheck: null,
  tools: [],
  pyFiles: [],
  currentTool: null,
  modalMode: null,
  modalSelectedPath: '',
  browserCurrentPath: '',
};

function activeDbPath() {
  return localStorage.getItem(storage.dbPath) || '';
}
function setActiveDbPath(path) {
  if (path) localStorage.setItem(storage.dbPath, path);
  else localStorage.removeItem(storage.dbPath);
  syncDbContext();
}
function fileName(path) {
  if (!path) return '';
  const normalized = path.replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}
function parentPath(path) {
  if (!path) return '/';
  const normalized = path.replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return '/';
  return normalized.slice(0, idx);
}
function pretty(v) { return JSON.stringify(v, null, 2); }
function logUi(...args) {
  console.log('[DevLab]', ...args);
  if (els.toolDiagnostics) {
    const current = els.toolDiagnostics.textContent || '';
    const line = `[${new Date().toISOString()}] ` + args.map(v => typeof v === 'string' ? v : pretty(v)).join(' ');
    if (current.length < 16000) els.toolDiagnostics.textContent = (current ? current + "\n\n" : '') + line;
  }
}
function setBadge(el, text, type='') {
  if (!el) return;
  el.textContent = text;
  el.className = `badge ${type}`.trim();
}
function loadSettings() {
  if (els.flowEndpoint) els.flowEndpoint.value = localStorage.getItem(storage.flowEndpoint) || 'http://localhost:1880/jarvis/inbound';
  if (els.devBackendUrl) els.devBackendUrl.value = localStorage.getItem(storage.devBackendUrl) || 'proxy';
  syncDbContext();
}
function saveSettings() {
  if (els.flowEndpoint) localStorage.setItem(storage.flowEndpoint, els.flowEndpoint.value.trim());
  if (els.devBackendUrl) localStorage.setItem(storage.devBackendUrl, els.devBackendUrl.value.trim());
}
function syncDbContext() {
  const path = activeDbPath();
  const label = path || 'non sélectionnée';
  if (els.dbActivePath) els.dbActivePath.textContent = label;
  if (els.dbActiveName) els.dbActiveName.textContent = label;
  const href = path ? `api.php?action=download_db&db_path=${encodeURIComponent(path)}` : '#';
  if (els.dbDownloadBtn) els.dbDownloadBtn.href = href;
  if (els.dbDownloadLink) els.dbDownloadLink.href = href;
}
async function api(action, payload = {}, multipart = false) {
  let options;
  if (multipart) {
    options = { method: 'POST', body: payload };
  } else {
    options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, db_path: activeDbPath(), ...payload }),
    };
  }
  const url = multipart ? 'api.php' : 'api.php';
  const res = await fetch(url, options);
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
async function devApi(path, body = null, method = 'POST', query = null) {
  const rawBase = (els.devBackendUrl?.value || 'proxy').trim();
  const proxyOverride = rawBase.startsWith('proxy:') ? rawBase.slice('proxy:'.length).trim() : null;
  const useProxy = rawBase === 'proxy' || rawBase === '' || rawBase.startsWith('proxy:');
  if (useProxy) {
    const res = await fetch('devproxy.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, body, method, query, base_url: proxyOverride || undefined }),
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok || data.error) throw new Error(data.error || text || `HTTP ${res.status}`);
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
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok || data.error) throw new Error(data.error || text || `HTTP ${res.status}`);
  return data;
}
function switchView(name) {
  els.navButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.view === name));
  els.views.forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
  window.location.hash = name;
}
function normalizeTool(tool) {
  return {
    ...tool,
    version: tool.version || tool.tool_version || tool.manifest_version || 'v0',
    description: tool.description || '',
    sample_input: tool.sample_input || {},
    required_fields: tool.required_fields || [],
    input_schema: tool.input_schema || {},
  };
}
function renderDashboard() {
  const hc = state.healthcheck || {};
  els.kpiTools.textContent = state.tools.length || hc.tools_count || 0;
  els.kpiPyFiles.textContent = state.pyFiles.length || hc.python_files_count || 0;
  els.kpiTables.textContent = (hc.tables || []).length || 0;
  els.dashboardSummary.textContent = pretty({
    active_db: activeDbPath() || null,
    tools_count: state.tools.length || hc.tools_count || 0,
    python_files_count: state.pyFiles.length || hc.python_files_count || 0,
    tables: hc.tables || [],
    namespaces: hc.namespaces || [],
    runner: hc.runner_health || hc.runner_error || null,
  });
}
async function refreshHealth() {
  const hc = await api('healthcheck');
  state.healthcheck = hc;
  setBadge(els.healthDb, activeDbPath() ? `DB ${fileName(activeDbPath()) || 'active'}` : 'DB non sélectionnée', activeDbPath() ? 'ok' : 'warn');
  if (hc.runner_health?.status === 'ok') setBadge(els.healthRunner, 'Runner OK', 'ok');
  else setBadge(els.healthRunner, 'Runner KO', 'err');
  try {
    const dev = await devApi('/health', null, 'GET');
    setBadge(els.healthDev, dev.status === 'ok' ? 'Dev OK' : 'Dev ?', dev.status === 'ok' ? 'ok' : 'warn');
  } catch {
    setBadge(els.healthDev, 'Dev KO', 'err');
  }
  renderDashboard();
  renderDbContract();
  renderNamespacesSelect(hc.namespaces || []);
}
function renderDbContract() {
  const contract = state.healthcheck?.db_contract?.tables || [];
  els.dbContractWrap.textContent = pretty({
    active_db: activeDbPath() || null,
    path_resolution: state.healthcheck?.db_contract?.db_path_resolution || [],
    tables: contract,
  });
}
function renderNamespacesSelect(namespaces) {
  const fixed = [...new Set(['runtime','npm_service','proxmox', ...namespaces])];
  els.cfgNamespace.innerHTML = fixed.map(ns => `<option value="${ns}">${ns}</option>`).join('');
}
async function loadInventory() {
  const [toolsData, filesData] = await Promise.all([
    api('list_python_tools').catch(() => ({ items: state.healthcheck?.tools_preview || [] })),
    api('list_python_files').catch(() => ({ items: state.healthcheck?.python_files_preview || [] })),
  ]);
  state.tools = (toolsData.items || []).map(normalizeTool);
  state.pyFiles = filesData.items || [];
  renderToolList();
  renderToolSelect();
  renderCodeFiles();
  if (!state.currentTool && state.tools.length) selectTool(state.tools[0].name);
  renderDashboard();
}
function renderToolList() {
  const filter = (els.toolSearch?.value || '').trim().toLowerCase();
  const tools = state.tools.filter(t => !filter || t.name.toLowerCase().includes(filter) || t.description.toLowerCase().includes(filter));
  els.toolList.innerHTML = tools.map(tool => `
    <button class="tool-item ${state.currentTool?.name === tool.name ? 'active' : ''}" data-tool-name="${tool.name}">
      <div class="status-line"><strong>${tool.name}</strong><span class="badge">${tool.version}</span></div>
      <div class="small muted">${tool.description || 'sans description'}</div>
    </button>`).join('') || '<div class="muted">Aucun outil.</div>';
  [...els.toolList.querySelectorAll('[data-tool-name]')].forEach(btn => btn.onclick = () => selectTool(btn.dataset.toolName));
}
function renderToolSelect() {
  els.toolSelect.innerHTML = state.tools.map(t => `<option value="${t.name}">${t.name} · ${t.version}</option>`).join('');
  if (state.currentTool) els.toolSelect.value = state.currentTool.name;
}
function selectTool(name) {
  const tool = state.tools.find(t => t.name === name);
  if (!tool) return;
  state.currentTool = tool;
  renderToolList();
  renderToolSelect();
  els.toolInput.value = pretty(tool.sample_input && Object.keys(tool.sample_input).length ? tool.sample_input : {});
  els.toolOutput.textContent = pretty({ tool: tool.name, version: tool.version });
  els.toolDiagnostics.textContent = pretty({
    aide: 'Le tool reçoit le JSON saisi + la DB active comme contexte.',
    active_db: activeDbPath() || null,
    required_fields: tool.required_fields || [],
  });
}
async function validateToolInput() {
  if (!state.currentTool) return;
  let payload;
  try { payload = JSON.parse(els.toolInput.value || '{}'); }
  catch (e) { els.toolDiagnostics.textContent = pretty({ valid: false, error: e.message }); return; }
  const data = await devApi('/validate', { schema: state.currentTool.input_schema || {}, payload });
  els.toolDiagnostics.textContent = pretty(data);
}
async function executeTool() {
  if (!state.currentTool) return;
  let payload;
  try { payload = JSON.parse(els.toolInput.value || '{}'); }
  catch (e) { els.toolDiagnostics.textContent = pretty({ error: e.message }); return; }
  const data = await api('run_python_tool', { tool: state.currentTool.name, input: payload });
  els.toolOutput.textContent = pretty(data);
}
function renderCodeFiles() {
  els.codeFileSelect.innerHTML = state.pyFiles.map(f => `<option value="${f.path}">${f.path}</option>`).join('');
  els.codeFileList.innerHTML = state.pyFiles.map(f => `<button class="tool-item" data-file-path="${f.path}"><div><strong>${f.filename}</strong></div><div class="small muted">${f.path}</div></button>`).join('') || '<div class="muted">Aucun fichier Python.</div>';
  [...els.codeFileList.querySelectorAll('[data-file-path]')].forEach(btn => btn.onclick = () => { els.codeFileSelect.value = btn.dataset.filePath; loadCode(); });
}
async function loadCode() {
  const path = els.codeFileSelect.value;
  if (!path) return;
  const data = await api('get_python_file', { path });
  els.codeEditor.value = data.code;
  els.codeMeta.textContent = pretty({ path: data.path, active_db: activeDbPath() || null });
}
async function saveCode() {
  const path = els.codeFileSelect.value;
  if (!path) return;
  const data = await api('save_python_file', { path, code: els.codeEditor.value });
  els.codeMeta.textContent = pretty(data);
}
async function loadSelectedTable() {
  const table = els.dbTableSelect.value;
  if (!table) return;
  const data = await api('get_table_rows', { table, limit: 100, offset: 0 });
  const head = `<tr>${data.columns.map(c => `<th>${c}</th>`).join('')}</tr>`;
  const body = data.rows.map(row => `<tr>${data.columns.map(c => `<td>${escapeHtml(String(row[c] ?? ''))}</td>`).join('')}</tr>`).join('');
  els.dbTableWrap.innerHTML = `<table><thead>${head}</thead><tbody>${body || `<tr><td colspan="${data.columns.length}">Aucune ligne.</td></tr>`}</tbody></table>`;
}
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
async function loadTables() {
  if (!activeDbPath()) {
    els.dbTableSelect.innerHTML = '';
    els.dbTableWrap.innerHTML = '<div class="muted">Aucune DB active.</div>';
    return;
  }
  const data = await api('list_tables');
  const items = data.items || [];
  els.dbTableSelect.innerHTML = items.map(i => `<option value="${i.name}">${i.name}</option>`).join('');
  if (items.length) await loadSelectedTable();
}
async function loadNamespace() {
  const ns = els.cfgNamespace.value;
  if (!activeDbPath()) {
    els.sensitiveTable.innerHTML = '<tr><td colspan="3" class="muted">Aucune DB active.</td></tr>';
    return;
  }
  const data = await api('list_sensitive', { namespace: ns });
  const rows = data.items || [];
  if (!rows.length) {
    els.sensitiveTable.innerHTML = '<tr><td colspan="3" class="muted">Aucune valeur.</td></tr>';
    return;
  }
  els.sensitiveTable.innerHTML = rows.map(row => `
    <tr>
      <td><code>${row.key}</code></td>
      <td><input data-sensitive-key="${row.key}" value="${String(row.value).replace(/"/g,'&quot;')}" /></td>
      <td><button class="secondary" data-save-sensitive="${row.key}">Save</button></td>
    </tr>`).join('');
  [...els.sensitiveTable.querySelectorAll('[data-save-sensitive]')].forEach(btn => btn.onclick = async () => {
    const key = btn.dataset.saveSensitive;
    const input = els.sensitiveTable.querySelector(`[data-sensitive-key="${key}"]`);
    await api('upsert_sensitive', { namespace: ns, key, value: input.value });
    await loadNamespace();
  });
}
async function browseDbPaths(targetPath = null) {
  const data = await api('browse_paths', targetPath ? { path: targetPath } : {});
  state.browserCurrentPath = data.current_path || '/';
  const parentBtn = data.parent_path ? `<button class="tool-item" data-db-nav="${data.parent_path}">⬆️ ..</button>` : '';
  const entries = (data.items || []).map(item => `
    <button class="tool-item" data-db-item="${item.path}" data-db-type="${item.type}">
      <div class="status-line"><strong>${item.type === 'dir' ? '📁' : '🗄️'} ${item.name}</strong><span class="badge">${item.type}</span></div>
      <div class="small muted">${item.path}${item.size !== null ? ` · ${item.size} octets` : ''}</div>
    </button>`).join('') || '<div class="muted">Aucun fichier DB.</div>';
  els.dbBrowseList.innerHTML = parentBtn + entries;
  [...els.dbBrowseList.querySelectorAll('[data-db-nav]')].forEach(btn => btn.onclick = () => browseDbPaths(btn.dataset.dbNav));
  [...els.dbBrowseList.querySelectorAll('[data-db-item]')].forEach(btn => btn.onclick = () => {
    const path = btn.dataset.dbItem;
    const type = btn.dataset.dbType;
    state.modalSelectedPath = path;
    els.dbSelectedPath.textContent = path;
    if (type === 'dir') browseDbPaths(path);
  });
}
function openDbModal(mode) {
  state.modalMode = mode;
  state.modalSelectedPath = activeDbPath() ? parentPath(activeDbPath()) : '';
  els.dbActionOutput.textContent = 'Aucune action.';
  const currentName = fileName(activeDbPath()) || 'nouvelle.db';
  let body = '';
  if (mode === 'select') {
    els.dbActionTitle.textContent = 'Sélectionner une DB';
    body = '<div class="small muted">Choisis un fichier .db dans l’arborescence à gauche puis confirme.</div>';
  } else if (mode === 'create') {
    els.dbActionTitle.textContent = 'Créer une nouvelle DB';
    body = `<label>Nom du nouveau fichier DB</label><input id="modalNewDbName" placeholder="nouvelle.db" value="${currentName || 'nouvelle.db'}">`;
  } else if (mode === 'upload') {
    els.dbActionTitle.textContent = 'Uploader une DB';
    body = `<label>Fichier local</label><input id="modalUploadFile" type="file" accept=".db,.sqlite,.sqlite3">`;
  } else if (mode === 'export') {
    els.dbActionTitle.textContent = 'Exporter la DB active';
    body = `<label>Nom du fichier cible</label><input id="modalExportDbName" placeholder="${currentName || 'copie.db'}" value="${currentName || 'copie.db'}">`;
  }
  els.dbActionBody.innerHTML = body;
  els.dbSelectedPath.textContent = state.modalSelectedPath || 'Aucun chemin sélectionné.';
  els.dbModal.classList.remove('hidden');
  els.dbModal.classList.add('open');
  browseDbPaths(state.modalSelectedPath || parentPath(activeDbPath() || '/'));
  const focusTarget = els.dbActionBody.querySelector('input,button');
  if (focusTarget) setTimeout(() => focusTarget.focus(), 10);
}
function closeDbModal() {
  els.dbModal.classList.add('hidden');
  els.dbModal.classList.remove('open');
}
async function confirmDbModal() {
  try {
    if (state.modalMode === 'select') {
      if (!state.modalSelectedPath || !/\.(db|sqlite|sqlite3)$/i.test(state.modalSelectedPath)) throw new Error('sélectionne un fichier DB');
      setActiveDbPath(state.modalSelectedPath);
    } else if (state.modalMode === 'create') {
      const name = (document.getElementById('modalNewDbName')?.value || '').trim();
      if (!name) throw new Error('nom de fichier requis');
      const baseDir = state.modalSelectedPath && !/\.(db|sqlite|sqlite3)$/i.test(state.modalSelectedPath) ? state.modalSelectedPath : parentPath(state.modalSelectedPath || activeDbPath() || '/');
      const data = await api('create_db', { target_dir: baseDir, filename: name });
      setActiveDbPath(data.target_path);
      els.dbActionOutput.textContent = pretty(data);
    } else if (state.modalMode === 'upload') {
      const file = document.getElementById('modalUploadFile')?.files?.[0];
      if (!file) throw new Error('sélectionne un fichier local');
      const baseDir = state.modalSelectedPath && !/\.(db|sqlite|sqlite3)$/i.test(state.modalSelectedPath) ? state.modalSelectedPath : parentPath(state.modalSelectedPath || activeDbPath() || '/');
      const form = new FormData();
      form.append('action', 'upload_db');
      form.append('db_path', `${baseDir}/${file.name}`);
      form.append('file', file, file.name);
      const data = await api('upload_db', form, true);
      setActiveDbPath(data.target_path);
      els.dbActionOutput.textContent = pretty(data);
    } else if (state.modalMode === 'export') {
      if (!activeDbPath()) throw new Error('aucune DB active');
      const name = (document.getElementById('modalExportDbName')?.value || '').trim();
      if (!name) throw new Error('nom de fichier requis');
      const baseDir = state.modalSelectedPath && !/\.(db|sqlite|sqlite3)$/i.test(state.modalSelectedPath) ? state.modalSelectedPath : parentPath(state.modalSelectedPath || activeDbPath() || '/');
      const data = await api('export_db', { target_path: `${baseDir}/${name}` });
      els.dbActionOutput.textContent = pretty(data);
    }
    await refreshHealth();
    await loadTables();
    await loadNamespace();
    closeDbModal();
  } catch (e) {
    els.dbActionOutput.textContent = pretty({ error: e.message || String(e) });
  }
}
async function deleteActiveDb() {
  const path = activeDbPath();
  if (!path) throw new Error('aucune DB active');
  if (!confirm(`Effacer ${path} ?`)) return;
  const data = await api('delete_db', { target_path: path });
  setActiveDbPath('');
  els.dbTransferOutput.textContent = pretty(data);
  await refreshHealth();
  await loadTables();
  await loadNamespace();
}
function bindEvents() {
  els.navButtons.forEach(btn => btn.onclick = () => switchView(btn.dataset.view));
  els.goDb.onclick = () => switchView('db');
  els.flowEndpoint.addEventListener('change', saveSettings);
  els.devBackendUrl.addEventListener('change', saveSettings);
  els.loadTableBtn.onclick = () => loadSelectedTable().catch(err => logUi(err.message || String(err)));
  els.loadNamespace.onclick = () => loadNamespace().catch(err => logUi(err.message || String(err)));
  els.dbSelectOpen.onclick = () => openDbModal('select');
  els.dbCreateOpen.onclick = () => openDbModal('create');
  els.dbUploadOpen.onclick = () => openDbModal('upload');
  els.dbExportOpen.onclick = () => openDbModal('export');
  els.dbDeleteBtn.onclick = () => deleteActiveDb().catch(err => { els.dbTransferOutput.textContent = pretty({ error: err.message || String(err) }); });
  els.dbModalClose.onclick = closeDbModal;
  els.dbModalCancel.onclick = closeDbModal;
  els.dbModalConfirm.onclick = () => confirmDbModal();
  els.dbBrowseRefresh.onclick = () => browseDbPaths(state.browserCurrentPath || parentPath(activeDbPath() || '/')).catch(err => { els.dbActionOutput.textContent = pretty({ error: err.message || String(err) }); });
  els.toolSearch.addEventListener('input', renderToolList);
  els.toolSelect.onchange = () => selectTool(els.toolSelect.value);
  els.btnLoadSample.onclick = () => { if (state.currentTool) els.toolInput.value = pretty(state.currentTool.sample_input || {}); };
  els.validateInput.onclick = () => validateToolInput().catch(err => { els.toolDiagnostics.textContent = pretty({ error: err.message || String(err) }); });
  els.runTool.onclick = () => executeTool().catch(err => { els.toolDiagnostics.textContent = pretty({ error: err.message || String(err) }); });
  els.loadCodeBtn.onclick = () => loadCode().catch(err => { els.codeMeta.textContent = pretty({ error: err.message || String(err) }); });
  els.saveCodeBtn.onclick = () => saveCode().catch(err => { els.codeMeta.textContent = pretty({ error: err.message || String(err) }); });
}
async function bootstrap() {
  loadSettings();
  bindEvents();
  await refreshHealth();
  await loadInventory();
  await loadTables();
  await loadNamespace();
}
bootstrap().catch(err => {
  console.error('[DevLab] bootstrap error', err);
  if (els.dashboardSummary) els.dashboardSummary.textContent = pretty({ error: err.message || String(err) });
});
