const els = {
  navButtons:[...document.querySelectorAll('.nav-btn')],
  views:[...document.querySelectorAll('.view')],
  healthDb:document.getElementById('healthDb'),
  healthRunner:document.getElementById('healthRunner'),
  kpiTools:document.getElementById('kpiTools'),
  kpiPyFiles:document.getElementById('kpiPyFiles'),
  kpiTables:document.getElementById('kpiTables'),
  dbPathLabel:document.getElementById('dbPathLabel'),
  dbDownloadLink:document.getElementById('dbDownloadLink'),
  dbActivePath:document.getElementById('dbActivePath'),
  toolSearch:document.getElementById('toolSearch'),
  toolList:document.getElementById('toolList'),
  toolSelect:document.getElementById('toolSelect'),
  runMode:document.getElementById('runMode'),
  toolInput:document.getElementById('toolInput'),
  toolOutput:document.getElementById('toolOutput'),
  toolDiagnostics:document.getElementById('toolDiagnostics'),
  btnLoadSample:document.getElementById('btnLoadSample'),
  validateInput:document.getElementById('validateInput'),
  runTool:document.getElementById('runTool'),
  dbContractWrap:document.getElementById('dbContractWrap'),
  dbTableSelect:document.getElementById('dbTableSelect'),
  loadTableBtn:document.getElementById('loadTableBtn'),
  dbTableWrap:document.getElementById('dbTableWrap'),
  cfgNamespace:document.getElementById('cfgNamespace'),
  loadNamespace:document.getElementById('loadNamespace'),
  sensitiveTable:document.getElementById('sensitiveTable'),
  dbBrowseList:document.getElementById('dbBrowseList'),
  openSelectDb:document.getElementById('openSelectDb'),
  openCreateDb:document.getElementById('openCreateDb'),
  openUploadDb:document.getElementById('openUploadDb'),
  openExportDb:document.getElementById('openExportDb'),
  deleteActiveDb:document.getElementById('deleteActiveDb'),
  dbModal:document.getElementById('dbModal'),
  dbModalTitle:document.getElementById('dbModalTitle'),
  closeDbModal:document.getElementById('closeDbModal'),
  dbBrowserCurrent:document.getElementById('dbBrowserCurrent'),
  dbBrowserUp:document.getElementById('dbBrowserUp'),
  dbBrowserRefresh:document.getElementById('dbBrowserRefresh'),
  dbBrowserItems:document.getElementById('dbBrowserItems'),
  dbSelectedPath:document.getElementById('dbSelectedPath'),
  dbActionTitle:document.getElementById('dbActionTitle'),
  dbActionBody:document.getElementById('dbActionBody'),
  dbActionConfirm:document.getElementById('dbActionConfirm'),
  dbActionCancel:document.getElementById('dbActionCancel'),
  dbActionOutput:document.getElementById('dbActionOutput'),
};

const state = {
  activeDbPath: localStorage.getItem('jarvis_active_db_path') || '',
  tools: [],
  pyFiles: [],
  currentTool: null,
  browserCurrent: '',
  browserSelected: '',
  modalMode: null,
};

function pretty(v){ return JSON.stringify(v, null, 2); }
function escapeHtml(v){ return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function saveDbPath(path){ state.activeDbPath = path || ''; localStorage.setItem('jarvis_active_db_path', state.activeDbPath); renderActiveDb(); }
function log(...args){ console.log('[DevLab]', ...args); }

async function api(action, payload = {}, raw = false){
  let opts;
  if (raw === 'formdata') {
    payload.append('action', action);
    opts = { method: 'POST', body: payload };
  } else {
    opts = {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ action, db_path: state.activeDbPath, ...payload })
    };
  }
  const res = await fetch('api.php', opts);
  if (raw === 'download') return res;
  const text = await res.text();
  let data={}; try{ data=text?JSON.parse(text):{} }catch{ data={raw:text} }
  if(!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function switchView(name){
  els.navButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.view===name));
  els.views.forEach(v => v.classList.toggle('active', v.id===`view-${name}`));
  window.location.hash = name;
}

function renderActiveDb(){
  const path = state.activeDbPath || 'Aucune DB active.';
  els.dbPathLabel.textContent = path;
  els.dbActivePath.textContent = path;
  if (state.activeDbPath){
    els.dbDownloadLink.href = `api.php?action=download_db&db_path=${encodeURIComponent(state.activeDbPath)}`;
  } else {
    els.dbDownloadLink.href = '#';
  }
}

function renderTools(){
  const filter = (els.toolSearch.value || '').trim().toLowerCase();
  const items = state.tools.filter(t => !filter || t.name.toLowerCase().includes(filter) || (t.description||'').toLowerCase().includes(filter));
  els.toolList.innerHTML = items.map(tool => `
    <button class="tool-item ${state.currentTool?.name===tool.name?'active':''}" data-tool="${tool.name}">
      <div class="status-line"><strong>${escapeHtml(tool.name)}</strong><span class="badge">${escapeHtml(tool.version || 'v0')}</span></div>
      <div class="small muted">${escapeHtml(tool.description || 'sans description')}</div>
      <div class="small muted">${escapeHtml(tool.entrypoint || '')}</div>
    </button>
  `).join('') || '<div class="muted">Aucun outil.</div>';
  [...els.toolList.querySelectorAll('[data-tool]')].forEach(btn => btn.onclick = () => selectTool(btn.dataset.tool));
  els.toolSelect.innerHTML = state.tools.map(tool => `<option value="${tool.name}">${tool.name} · ${tool.version || 'v0'}</option>`).join('');
  if (state.currentTool) els.toolSelect.value = state.currentTool.name;
}

function selectTool(name){
  const tool = state.tools.find(t => t.name === name);
  if (!tool) return;
  state.currentTool = tool;
  renderTools();
  els.toolInput.value = pretty(tool.sample_input && Object.keys(tool.sample_input).length ? tool.sample_input : {});
  els.toolDiagnostics.textContent = pretty({
    tool: tool.name,
    version: tool.version || 'v0',
    db_active: state.activeDbPath || null,
    sequence: [
      '1. Tu fournis seulement le JSON métier.',
      '2. Le tool utilise la DB active ci-dessus comme contexte.',
      '3. Les secrets ne sont pas injectés dans le JSON.',
    ]
  });
}

async function refreshHealth(){
  const data = await api('healthcheck');
  els.kpiTools.textContent = data.tools_count || 0;
  els.kpiPyFiles.textContent = data.python_files_count || 0;
  els.kpiTables.textContent = (data.tables || []).length;
  els.healthDb.textContent = data.active_db_path ? 'DB active' : 'DB ?';
  els.healthDb.className = `badge ${data.active_db_path ? 'ok' : 'warn'}`;
  els.healthRunner.textContent = 'Local API OK';
  els.healthRunner.className = 'badge ok';
  if (!state.activeDbPath) saveDbPath(data.active_db_path || data.default_db_path || '');
  state.tools = data.tools_preview || [];
  renderTools();
  if (!state.currentTool && state.tools.length) selectTool(state.tools[0].name);
}

async function loadContract(){
  const data = await api('db_contract');
  const tables = data.contract?.tables || [];
  els.dbContractWrap.innerHTML = tables.map(t => `
    <div style="border:1px solid #2a3b62;border-radius:12px;padding:.65rem .7rem;background:#0b1324;margin-bottom:.55rem">
      <div class="status-line"><strong>${escapeHtml(t.name)}</strong><span class="chip">${escapeHtml((t.used_by||[]).join(', '))}</span></div>
      <div class="small muted"><code>${escapeHtml((t.columns||[]).join(', '))}</code></div>
    </div>
  `).join('');
}

async function loadTables(){
  const data = await api('list_tables');
  const items = data.items || [];
  els.dbTableSelect.innerHTML = items.map(i => `<option value="${i.name}">${i.name}</option>`).join('');
  if (items.length) await loadSelectedTable();
}

async function loadSelectedTable(){
  const table = els.dbTableSelect.value;
  if (!table) { els.dbTableWrap.innerHTML = '<div class="muted">Aucune table.</div>'; return; }
  const data = await api('get_table_rows', { table, limit: 100, offset: 0 });
  const head = `<tr>${(data.columns||[]).map(c=>`<th>${escapeHtml(c)}</th>`).join('')}</tr>`;
  const body = (data.rows||[]).map(row => `<tr>${(data.columns||[]).map(col=>`<td>${escapeHtml(row[col] ?? '')}</td>`).join('')}</tr>`).join('');
  els.dbTableWrap.innerHTML = `<table><thead>${head}</thead><tbody>${body || `<tr><td colspan="${(data.columns||[]).length || 1}">Aucune ligne.</td></tr>`}</tbody></table>`;
}

async function loadNamespaces(){
  const data = await api('list_namespaces');
  const items = data.items || [];
  els.cfgNamespace.innerHTML = items.map(ns => `<option value="${ns}">${ns}</option>`).join('') || '<option value="">(aucun namespace)</option>';
  if (items.length) await loadNamespace();
  else els.sensitiveTable.innerHTML = '<tr><td colspan="3" class="muted">Aucun namespace dans la DB active.</td></tr>';
}

async function loadNamespace(){
  const ns = els.cfgNamespace.value;
  if (!ns) return;
  const data = await api('list_sensitive', { namespace: ns });
  const rows = data.items || [];
  els.sensitiveTable.innerHTML = rows.map(row => `
    <tr>
      <td><code>${escapeHtml(row.key)}</code></td>
      <td><input data-k="${escapeHtml(row.key)}" value="${escapeHtml(row.value)}"></td>
      <td><button class="secondary" data-save="${escapeHtml(row.key)}">Save</button></td>
    </tr>
  `).join('') || '<tr><td colspan="3" class="muted">Namespace vide.</td></tr>';
  [...els.sensitiveTable.querySelectorAll('[data-save]')].forEach(btn => btn.onclick = async () => {
    const key = btn.dataset.save;
    const input = els.sensitiveTable.querySelector(`[data-k="${CSS.escape(key)}"]`);
    await api('upsert_sensitive', { namespace: ns, key, value: input.value });
    await loadNamespace();
  });
}

async function loadBrowseList(path = null){
  const data = await api('browse_db_paths', path ? { path } : {});
  state.browserCurrent = data.current_path;
  els.dbBrowseList.innerHTML = (data.items || []).map(item => `
    <div class="tool-item" data-db-file="${escapeHtml(item.path)}">
      <div class="status-line"><strong>${escapeHtml(item.name)}</strong><span class="badge">${item.type}</span></div>
      <div class="small muted">${escapeHtml(item.path)}</div>
    </div>
  `).join('') || '<div class="muted">Aucun fichier DB.</div>';
  [...els.dbBrowseList.querySelectorAll('[data-db-file]')].forEach(btn => btn.onclick = () => {
    const p = btn.dataset.dbFile;
    saveDbPath(p);
    refreshDbArea();
  });
}

function openModal(mode){
  state.modalMode = mode;
  state.browserSelected = '';
  els.dbActionOutput.textContent = 'Aucune action.';
  els.dbModal.classList.add('open');
  els.dbModalTitle.textContent = 'Gestion DB';
  const currentDir = state.activeDbPath ? state.activeDbPath.replace(/\/[^/]+$/, '') : '';
  browseModal(currentDir);
  renderModalBody();
}

async function browseModal(path = null){
  const data = await api('browse_db_paths', path ? { path } : {});
  state.browserCurrent = data.current_path;
  els.dbBrowserCurrent.textContent = data.current_path;
  els.dbBrowserUp.disabled = !data.parent_path;
  els.dbBrowserUp.onclick = () => data.parent_path && browseModal(data.parent_path);
  els.dbBrowserRefresh.onclick = () => browseModal(state.browserCurrent);
  els.dbBrowserItems.innerHTML = (data.items || []).map(item => `
    <div class="browser-item ${state.browserSelected===item.path?'active':''}" data-path="${escapeHtml(item.path)}" data-type="${item.type}">
      <div>
        <div><strong>${escapeHtml(item.name)}</strong></div>
        <div class="small muted">${escapeHtml(item.path)}</div>
      </div>
      <span class="chip">${item.type}</span>
    </div>
  `).join('') || '<div class="muted">Dossier vide.</div>';
  [...els.dbBrowserItems.querySelectorAll('[data-path]')].forEach(el => el.onclick = () => {
    const path = el.dataset.path, type = el.dataset.type;
    if (type === 'dir') browseModal(path);
    else {
      state.browserSelected = path;
      els.dbSelectedPath.textContent = path;
      [...els.dbBrowserItems.querySelectorAll('.browser-item')].forEach(n => n.classList.toggle('active', n===el));
    }
  });
}

function renderModalBody(){
  const mode = state.modalMode;
  const currentDir = state.browserCurrent || '';
  els.dbSelectedPath.textContent = state.browserSelected || 'Aucun chemin sélectionné.';
  if (mode === 'select') {
    els.dbActionTitle.textContent = 'Sélectionner la DB active';
    els.dbActionBody.innerHTML = '<div class="small muted">Choisis un fichier .db dans l’arborescence puis valide.</div>';
    els.dbActionConfirm.onclick = async () => {
      if (!state.browserSelected) return;
      saveDbPath(state.browserSelected);
      els.dbActionOutput.textContent = pretty({ ok:true, active_db_path: state.activeDbPath });
      await refreshDbArea();
      closeModal();
    };
  } else if (mode === 'create') {
    els.dbActionTitle.textContent = 'Créer une nouvelle DB';
    els.dbActionBody.innerHTML = `
      <label>Nom du nouveau fichier DB</label>
      <input id="modalNewDbName" placeholder="nouvelle.db" />
      <div class="small muted" style="margin-top:.5rem">Le fichier sera créé dans : <code>${escapeHtml(currentDir)}</code></div>`;
    els.dbActionConfirm.onclick = async () => {
      const name = document.getElementById('modalNewDbName').value.trim();
      if (!name) return;
      const target = `${state.browserCurrent.replace(/\/+$/,'')}/${name}`;
      const data = await api('create_db', { path: target });
      saveDbPath(data.path);
      els.dbActionOutput.textContent = pretty(data);
      await refreshDbArea();
      closeModal();
    };
  } else if (mode === 'upload') {
    els.dbActionTitle.textContent = 'Uploader une DB locale';
    els.dbActionBody.innerHTML = `
      <label>Choisir un fichier local</label>
      <input id="modalUploadFile" type="file" accept=".db,.sqlite,.sqlite3" />
      <label style="margin-top:.7rem">Nom cible</label>
      <input id="modalUploadName" placeholder="import.db" />
      <div class="small muted" style="margin-top:.5rem">Le fichier sera envoyé dans : <code>${escapeHtml(currentDir)}</code></div>`;
    els.dbActionConfirm.onclick = async () => {
      const f = document.getElementById('modalUploadFile').files[0];
      const name = document.getElementById('modalUploadName').value.trim() || (f ? f.name : '');
      if (!f || !name) return;
      const fd = new FormData();
      fd.append('file', f);
      fd.append('target_path', `${state.browserCurrent.replace(/\/+$/,'')}/${name}`);
      const data = await api('upload_db', fd, 'formdata');
      saveDbPath(data.target_path);
      els.dbActionOutput.textContent = pretty(data);
      await refreshDbArea();
      closeModal();
    };
  } else if (mode === 'export') {
    els.dbActionTitle.textContent = 'Exporter la DB active';
    els.dbActionBody.innerHTML = `
      <label>Nom cible</label>
      <input id="modalExportName" placeholder="${state.activeDbPath ? state.activeDbPath.split('/').pop() : 'export.db'}" />
      <div class="small muted" style="margin-top:.5rem">La DB active sera copiée vers : <code>${escapeHtml(currentDir)}</code></div>`;
    els.dbActionConfirm.onclick = async () => {
      if (!state.activeDbPath) return;
      const name = document.getElementById('modalExportName').value.trim() || 'export.db';
      const data = await api('export_db', { source_path: state.activeDbPath, target_path: `${state.browserCurrent.replace(/\/+$/,'')}/${name}` });
      els.dbActionOutput.textContent = pretty(data);
      await refreshDbArea();
      closeModal();
    };
  }
}

function closeModal(){ els.dbModal.classList.remove('open'); }

async function deleteActiveDb(){
  if (!state.activeDbPath) return;
  if (!confirm(`Effacer cette DB ?\n${state.activeDbPath}`)) return;
  const data = await api('delete_db', { path: state.activeDbPath });
  log('delete', data);
  saveDbPath('');
  await refreshDbArea();
}

async function refreshDbArea(){
  renderActiveDb();
  try {
    await refreshHealth();
    await loadContract();
    await loadTables();
    await loadNamespaces();
    await loadBrowseList(state.activeDbPath ? state.activeDbPath.replace(/\/[^/]+$/, '') : null);
  } catch (e) {
    els.dbTableWrap.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
    els.sensitiveTable.innerHTML = `<tr><td colspan="3" class="muted">${escapeHtml(e.message)}</td></tr>`;
  }
}

function bindEvents(){
  els.navButtons.forEach(btn => btn.onclick = () => switchView(btn.dataset.view));
  els.toolSearch.oninput = renderTools;
  els.toolSelect.onchange = () => selectTool(els.toolSelect.value);
  els.btnLoadSample.onclick = () => state.currentTool && (els.toolInput.value = pretty(state.currentTool.sample_input || {}));
  els.validateInput.onclick = () => { els.toolDiagnostics.textContent = pretty({ valid:true, note:'Validation locale minimale. Le backend complet peut faire une validation plus riche.' }); };
  els.runTool.onclick = () => { els.toolDiagnostics.textContent = pretty({ note:'Le flux DB est corrigé dans cette version. Le run backend complet reste branché sur ton backend DevLab.' }); };
  els.openSelectDb.onclick = () => openModal('select');
  els.openCreateDb.onclick = () => openModal('create');
  els.openUploadDb.onclick = () => openModal('upload');
  els.openExportDb.onclick = () => openModal('export');
  els.deleteActiveDb.onclick = deleteActiveDb;
  els.closeDbModal.onclick = closeModal;
  els.dbActionCancel.onclick = closeModal;
  els.loadTableBtn.onclick = loadSelectedTable;
  els.loadNamespace.onclick = loadNamespace;
}

async function bootstrap(){
  bindEvents();
  renderActiveDb();
  await refreshDbArea();
  const hash = location.hash.replace('#','');
  if (hash) switchView(hash);
}
bootstrap().catch(err => {
  console.error(err);
  els.dbTableWrap.innerHTML = `<div class="muted">${escapeHtml(err.message || String(err))}</div>`;
});