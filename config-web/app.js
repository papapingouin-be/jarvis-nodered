const state = {
  services: [],
  current: null,
  editor: null,
  currentCodePath: null,
  dbTable: 'service_config_values'
};

function esc(v){
  return String(v ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function setGlobalStatus(message, level='err'){
  const el = document.getElementById('globalStatus');
  if (!message){ el.innerHTML = ''; return; }
  el.innerHTML = `<div class="status ${level}">${esc(message)}</div>`;
}

function setApiStatus(text, ok=false){
  const el = document.getElementById('apiStatus');
  el.textContent = text;
  el.style.borderColor = ok ? 'rgba(16,185,129,.35)' : 'rgba(239,68,68,.35)';
  el.style.background = ok ? 'rgba(16,185,129,.12)' : 'rgba(239,68,68,.12)';
}

async function api(action, data = {}) {
  const response = await fetch('api.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...data })
  });

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (e) {
    console.error('Réponse non JSON:', text);
    throw new Error("api.php n'a pas renvoyé du JSON valide. Début de réponse: " + text.slice(0, 800));
  }

  if (!response.ok || json.error) {
    const detail = json.message ? ` — ${json.message}` : '';
    const file = json.file ? ` @ ${json.file}` : '';
    const line = json.line ? `:${json.line}` : '';
    throw new Error((json.error || (`HTTP ${response.status}`)) + detail + file + line);
  }
  return json;
}

async function bootstrap(){
  try {
    const health = await api('healthcheck');
    setApiStatus('API OK', true);
    const probe = health.db_probe || {};
    document.getElementById('apiMeta').textContent =
      `PHP ${health.php_version} · DB ${probe.db_path || 'n/a'} · services ${health.service_count}`;
    await loadServices();
    setGlobalStatus('Interface V6 chargée.', 'ok');
  } catch (e) {
    setApiStatus('API erreur', false);
    setGlobalStatus(e.message || String(e), 'err');
    console.error(e);
  }
}

async function loadServices(){
  const data = await api('list_services');
  state.services = data.services || [];

  const list = document.getElementById('serviceList');
  list.innerHTML = '';

  if (!state.services.length) {
    list.innerHTML = '<div class="small">Aucun service détecté.</div>';
    document.getElementById('serviceTitle').textContent = 'Aucun service';
    document.getElementById('serviceMeta').textContent = 'Ajoute des manifests ou garde le service démo.';
    document.getElementById('view').innerHTML = '<div class="small">Aucun service disponible.</div>';
    return;
  }

  state.services.forEach(service => {
    const btn = document.createElement('button');
    btn.textContent = service.name;
    btn.onclick = () => selectService(service.name);
    btn.dataset.service = service.name;
    list.appendChild(btn);
  });

  await selectService(state.services[0].name);
}

async function selectService(name){
  try {
    const data = await api('get_service', { service: name });
    state.current = data.service;
    [...document.querySelectorAll('#serviceList button')].forEach(btn => {
      btn.classList.toggle('active', btn.dataset.service === name);
    });
    document.getElementById('serviceTitle').textContent = state.current.name;
    document.getElementById('serviceMeta').textContent =
      `${state.current.description || 'Sans description'} · moteur ${state.current.engine_default || 'plan_only'}`;
    showConfig();
  } catch (e) {
    setGlobalStatus(e.message || String(e), 'err');
  }
}

function ensureCurrent(){
  if (!state.current) {
    setGlobalStatus('Aucun service sélectionné.', 'warn');
    return false;
  }
  return true;
}

function showConfig(){
  if (!ensureCurrent()) return;

  const req = state.current.config_requirements || [];
  const values = state.current.config_values || {};
  const profile = state.current.profile || 'default';

  let html = `
    <h3 style="margin-top:0">Configuration du service</h3>
    <div class="small">Point d'entrée simple : ce que le service a besoin pour fonctionner.</div>
    <label>Profil</label>
    <input id="cfg_profile" value="${esc(profile)}" placeholder="default">
  `;

  if (!req.length) {
    html += `<div class="status ok">Ce service n'a pas déclaré de besoins de configuration.</div>`;
  } else {
    req.forEach(r => {
      const value = values[r.key] ?? '';
      html += `
        <label>${esc(r.label || r.key)} ${r.required ? ' *' : ''}</label>
        <input id="cfg_${esc(r.key)}" value="${esc(value)}" placeholder="${esc(r.key)}">
        <div class="small">${esc(r.namespace || state.current.name)} / ${esc(r.key)}</div>
      `;
    });
  }

  html += `
    <div class="toolbar" style="margin-top:14px">
      <button onclick="saveConfig()">Sauver la configuration</button>
      <button class="secondary" onclick="showDbLab()">Ouvrir DB Lab</button>
    </div>
  `;
  document.getElementById('view').innerHTML = html;
}

async function saveConfig(){
  if (!ensureCurrent()) return;
  try {
    const req = state.current.config_requirements || [];
    const profile = document.getElementById('cfg_profile')?.value?.trim() || 'default';
    const config = {};
    req.forEach(r => {
      const el = document.getElementById('cfg_' + r.key);
      config[r.key] = el ? el.value : '';
    });

    await api('save_service_config', {
      service: state.current.name,
      profile,
      config
    });

    const refreshed = await api('get_service', { service: state.current.name, profile });
    state.current = refreshed.service;
    setGlobalStatus('Configuration sauvée.', 'ok');
    showConfig();
  } catch (e) {
    setGlobalStatus(e.message || String(e), 'err');
  }
}

function buildSamplePayload(kind){
  const sample = state.current?.sample_input || {};
  if (kind === 'empty') return {};
  if (kind === 'sample') return sample;
  if (kind === 'required') {
    const out = {};
    const required = state.current?.required_fields || [];
    required.forEach(k => { out[k] = sample[k] ?? ""; });
    return out;
  }
  if (kind === 'trace') {
    return {
      ...sample,
      _meta: {
        trace: true,
        capture_logs: true,
        timeout: 30
      }
    };
  }
  return {};
}

function showTest(){
  if (!ensureCurrent()) return;

  const engine = state.current.engine_default || 'plan_only';
  document.getElementById('view').innerHTML = `
    <h3 style="margin-top:0">Test du service</h3>
    <div class="small">Choix moteur + JSON vide/exemple + sortie et logs.</div>
    <div class="row">
      <div>
        <label>Moteur</label>
        <select id="test_engine">
          <option value="plan_only"${engine === 'plan_only' ? ' selected' : ''}>plan_only</option>
          <option value="python_direct"${engine === 'python_direct' ? ' selected' : ''}>python_direct</option>
        </select>
      </div>
      <div>
        <label>Timeout (s)</label>
        <input id="test_timeout" type="number" value="30" min="1" max="300">
      </div>
      <div>
        <label>Profil de config</label>
        <input id="test_profile" value="${esc(state.current.profile || 'default')}">
      </div>
    </div>

    <label>Payload JSON</label>
    <textarea id="jsonInput">{}</textarea>

    <div class="toolbar" style="margin-top:12px">
      <button onclick="fillPayload('empty')">JSON vide</button>
      <button class="secondary" onclick="fillPayload('sample')">Exemple</button>
      <button class="secondary" onclick="fillPayload('required')">Requis mini</button>
      <button class="secondary" onclick="fillPayload('trace')">Mode trace</button>
      <button onclick="runTest()">Exécuter</button>
    </div>

    <h4>Résultat</h4>
    <pre id="testResult">Aucune exécution.</pre>
  `;

  fillPayload('sample');
}

function fillPayload(kind){
  const payload = buildSamplePayload(kind);
  const el = document.getElementById('jsonInput');
  if (el) el.value = JSON.stringify(payload, null, 2);
}

async function runTest(){
  if (!ensureCurrent()) return;

  try {
    const engine = document.getElementById('test_engine').value;
    const timeout = parseInt(document.getElementById('test_timeout').value || '30', 10);
    const profile = document.getElementById('test_profile').value || 'default';
    const raw = document.getElementById('jsonInput').value || '{}';

    let payload;
    try { payload = JSON.parse(raw); }
    catch { throw new Error('Le JSON de test est invalide.'); }

    document.getElementById('testResult').textContent = 'Exécution en cours...';

    const result = await api('run_service_test', {
      service: state.current.name,
      engine,
      timeout,
      profile,
      payload
    });

    document.getElementById('testResult').textContent = JSON.stringify(result, null, 2);
    setGlobalStatus('Test terminé.', 'ok');
  } catch (e) {
    document.getElementById('testResult').textContent = String(e.message || e);
    setGlobalStatus(e.message || String(e), 'err');
  }
}

async function showCode(){
  if (!ensureCurrent()) return;

  try {
    const data = await api('list_service_code_files', { service: state.current.name });
    const files = data.files || [];
    const first = files[0]?.path || null;

    let fileOptions = files.map(f => `<option value="${esc(f.path)}">${esc(f.path)}</option>`).join('');
    if (!fileOptions) fileOptions = '<option value="">Aucun fichier</option>';

    document.getElementById('view').innerHTML = `
      <h3 style="margin-top:0">Code Studio</h3>
      <div class="small">Monaco + chargement, sauvegarde et validation.</div>
      <div class="row">
        <div>
          <label>Fichier</label>
          <select id="code_file">${fileOptions}</select>
        </div>
      </div>
      <div class="toolbar" style="margin-top:12px">
        <button onclick="loadCodeFile()">Charger</button>
        <button class="secondary" onclick="saveCodeFile()">Sauver</button>
        <button class="secondary" onclick="validateCodeFile()">Valider</button>
      </div>
      <div id="editor"></div>
      <h4>Diagnostic</h4>
      <pre id="codeDiag">Aucun diagnostic.</pre>
    `;

    if (!window.require) {
      document.getElementById("codeDiag").textContent = "Monaco n'a pas pu être chargé.";
      return;
    }

    window.require.config({ paths: { 'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs' } });
    window.require(['vs/editor/editor.main'], async function () {
      if (state.editor) state.editor.dispose();
      state.editor = monaco.editor.create(document.getElementById('editor'), {
        value: '# Chargement...',
        language: 'python',
        theme: 'vs-dark',
        automaticLayout: true,
        minimap: { enabled: false }
      });

      if (first) {
        document.getElementById('code_file').value = first;
        await loadCodeFile();
      } else {
        state.editor.setValue('# Aucun fichier disponible pour ce service.');
      }
    });
  } catch (e) {
    setGlobalStatus(e.message || String(e), 'err');
  }
}

async function loadCodeFile(){
  try {
    const path = document.getElementById('code_file').value;
    if (!path) return;
    const data = await api('read_code_file', { path });
    state.currentCodePath = path;
    if (state.editor) state.editor.setValue(data.content || '');
    document.getElementById('codeDiag').textContent = `Fichier chargé : ${path}`;
  } catch (e) {
    setGlobalStatus(e.message || String(e), 'err');
  }
}

async function saveCodeFile(){
  try {
    const path = document.getElementById('code_file').value;
    if (!path || !state.editor) return;
    const content = state.editor.getValue();
    const data = await api('save_code_file', { path, content });
    document.getElementById('codeDiag').textContent = JSON.stringify(data, null, 2);
    setGlobalStatus('Fichier sauvegardé.', 'ok');
  } catch (e) {
    setGlobalStatus(e.message || String(e), 'err');
  }
}

async function validateCodeFile(){
  try {
    const path = document.getElementById('code_file').value;
    if (!path || !state.editor) return;
    const content = state.editor.getValue();
    const data = await api('validate_code_file', { path, content });
    document.getElementById('codeDiag').textContent = JSON.stringify(data, null, 2);
    setGlobalStatus(data.valid ? 'Validation OK.' : 'Validation en échec.', data.valid ? 'ok' : 'err');
  } catch (e) {
    setGlobalStatus(e.message || String(e), 'err');
  }
}

async function showRuns(){
  if (!ensureCurrent()) return;
  try {
    const data = await api('list_runs', { service: state.current.name });
    const runs = data.runs || [];
    let html = `<h3 style="margin-top:0">Historique</h3>`;
    if (!runs.length) {
      html += `<div class="small">Aucune exécution.</div>`;
    } else {
      html += `<table><thead><tr>
        <th>ID</th><th>Date</th><th>Service</th><th>Moteur</th><th>Statut</th><th>Résumé</th>
      </tr></thead><tbody>`;
      runs.forEach(run => {
        html += `<tr>
          <td>${esc(run.run_id)}</td>
          <td>${esc(run.started_at)}</td>
          <td>${esc(run.service_name)}</td>
          <td>${esc(run.engine)}</td>
          <td>${esc(run.status)}</td>
          <td>${esc(run.summary || '')}</td>
        </tr>`;
      });
      html += `</tbody></table>`;
    }
    document.getElementById('view').innerHTML = html;
  } catch (e) {
    setGlobalStatus(e.message || String(e), 'err');
  }
}

async function showDbLab(){
  try {
    const tablesData = await api('db_list_tables');
    const rowsData = await api('db_list_config');
    const tables = tablesData.tables || [];
    const rows = rowsData.rows || [];

    let html = `
      <h3 style="margin-top:0">DB Lab</h3>
      <div class="small">Édition directe de la configuration DB. Là, on parle au moteur, pas au décor.</div>

      <div class="row">
        <div>
          <label>Tables disponibles</label>
          <select id="db_table_select" onchange="loadDbTablePreview()">
            ${tables.map(t => `<option value="${esc(t)}"${t===state.dbTable?' selected':''}>${esc(t)}</option>`).join('')}
          </select>
        </div>
        <div style="display:flex;align-items:end">
          <button class="mini-btn" onclick="loadDbTablePreview()">Prévisualiser la table</button>
        </div>
      </div>

      <h4>Ajouter / modifier une config</h4>
      <div class="row">
        <div><label>Profil</label><input id="db_profile" value="default"></div>
        <div><label>Service</label><input id="db_service" value="${esc(state.current?.name || '')}"></div>
      </div>
      <div class="row">
        <div><label>Clé</label><input id="db_key" placeholder="API_URL"></div>
        <div><label>Valeur</label><input id="db_value" placeholder="http://..."></div>
      </div>
      <div class="toolbar">
        <button onclick="dbSetConfig()">Sauver en DB</button>
        <button class="secondary" onclick="reloadCurrentServiceFromDb()">Recharger le service</button>
      </div>

      <h4>Config actuelle</h4>
      <table><thead><tr>
        <th>Profil</th><th>Service</th><th>Clé</th><th>Valeur</th><th></th>
      </tr></thead><tbody id="db_config_rows"></tbody></table>

      <h4>Prévisualisation de table</h4>
      <pre id="db_table_preview">Chargement...</pre>
    `;

    document.getElementById('view').innerHTML = html;
    renderDbConfigRows(rows);
    await loadDbTablePreview();
  } catch (e) {
    setGlobalStatus(e.message || String(e), 'err');
  }
}

function renderDbConfigRows(rows){
  const tbody = document.getElementById('db_config_rows');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="small">Aucune ligne.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${esc(r.profile)}</td>
      <td>${esc(r.service_name)}</td>
      <td><code>${esc(r.config_key)}</code></td>
      <td>${esc(r.config_value)}</td>
      <td>
        <button class="mini-btn" onclick="dbFillForm(${JSON.stringify(String(r.profile))}, ${JSON.stringify(String(r.service_name))}, ${JSON.stringify(String(r.config_key))}, ${JSON.stringify(String(r.config_value ?? ''))})">Charger</button>
        <button class="mini-btn" onclick="dbDeleteConfig(${JSON.stringify(String(r.profile))}, ${JSON.stringify(String(r.service_name))}, ${JSON.stringify(String(r.config_key))})">Suppr.</button>
      </td>
    </tr>
  `).join('');
}

function dbFillForm(profile, service, key, value){
  document.getElementById('db_profile').value = profile;
  document.getElementById('db_service').value = service;
  document.getElementById('db_key').value = key;
  document.getElementById('db_value').value = value;
}

async function dbSetConfig(){
  try {
    const profile = document.getElementById('db_profile').value.trim() || 'default';
    const service = document.getElementById('db_service').value.trim();
    const key = document.getElementById('db_key').value.trim();
    const value = document.getElementById('db_value').value;

    if (!service || !key) throw new Error('Service et clé obligatoires.');
    await api('db_set_config', { profile, service, key, value });
    setGlobalStatus('Config DB sauvée.', 'ok');
    await showDbLab();
  } catch (e) {
    setGlobalStatus(e.message || String(e), 'err');
  }
}

async function dbDeleteConfig(profile, service, key){
  try {
    if (!confirm(`Supprimer ${profile} / ${service} / ${key} ?`)) return;
    await api('db_delete_config', { profile, service, key });
    setGlobalStatus('Ligne supprimée.', 'ok');
    await showDbLab();
  } catch (e) {
    setGlobalStatus(e.message || String(e), 'err');
  }
}

async function loadDbTablePreview(){
  try {
    const sel = document.getElementById('db_table_select');
    if (sel) state.dbTable = sel.value;
    const data = await api('db_get_table', { table: state.dbTable, limit: 100 });
    document.getElementById('db_table_preview').textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    setGlobalStatus(e.message || String(e), 'err');
  }
}

async function reloadCurrentServiceFromDb(){
  if (!state.current) return;
  try {
    const data = await api('get_service', { service: state.current.name });
    state.current = data.service;
    setGlobalStatus('Service rechargé depuis la DB.', 'ok');
  } catch (e) {
    setGlobalStatus(e.message || String(e), 'err');
  }
}

bootstrap();
