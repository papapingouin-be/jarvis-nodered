const DB_KEY = 'jarvis_active_db_path';
const DEFAULT_DB = '/var/www/jarvis/database/jarvis.db';

const state = {
  services: [],
  current: null,
  editor: null,
  currentCodePath: null,
  dbTable: 'service_config_values',
  activeDbPath: localStorage.getItem(DB_KEY) || DEFAULT_DB,
  dbBrowserPath: '/var/www/jarvis/database',
  dbSelectedPath: null,
  dbAction: null,
  configMode: 'text',
  dbConfigMode: 'text'
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

function setActiveDbPath(path){
  state.activeDbPath = path || DEFAULT_DB;
  localStorage.setItem(DB_KEY, state.activeDbPath);
}

function dbLink(path){
  return `api.php?action=download_db&db_path=${encodeURIComponent(path || state.activeDbPath)}`;
}

async function api(action, data = {}) {
  const payload = { action, ...data };
  if (state.activeDbPath) payload.db_path = state.activeDbPath;
  const response = await fetch('api.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
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
  const savedDbPath = state.activeDbPath;
  try {
    state.activeDbPath = '';
    const health = await api('healthcheck');
    if (health.preferred_db_path) setActiveDbPath(health.preferred_db_path);
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
  } finally {
    if (!state.activeDbPath) state.activeDbPath = savedDbPath;
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

  const rawReq = state.current.config_requirements || [];
  const values = state.current.config_values || {};
  const entries = Array.isArray(state.current.config_entries) ? state.current.config_entries : [];
  const profile = state.current.profile || 'default';
  const runtimeEnv = Array.isArray(state.current.runtime_env_keys) ? state.current.runtime_env_keys : [];
  const missingRuntime = Array.isArray(state.current.missing_runtime_env_keys) ? state.current.missing_runtime_env_keys : [];
  const req = rawReq.filter(r => {
    const key = String(r?.key || '');
    if (!key.endsWith('_DIR')) return true;
    const sibling = rawReq.find(x => String(x?.key || '') === key.replace(/_DIR$/, ''));
    return !sibling;
  });

  const entryMap = {};
  entries.forEach(e => {
    if (!e || !e.namespace || !e.key) return;
    entryMap[`${e.namespace}|${e.key}`] = e.value ?? '';
  });

  const reqRows = req.map(r => {
    const ns = r.namespace || state.current.name;
    const value = entryMap[`${ns}|${r.key}`] ?? values[r.key] ?? '';
    return `
      <div class="cfg-row">
        <div class="cfg-label">${esc(r.label || r.key)}${r.required ? ' *' : ''}<div class="small">${esc(ns)} / ${esc(r.key)}</div></div>
        <input data-cfg-namespace="${esc(ns)}" data-cfg-key="${esc(r.key)}" value="${esc(value)}" placeholder="${esc(r.key)}">
      </div>
    `;
  }).join('');

  const baseEntries = entries.length ? entries : req.map(r => ({ namespace: r.namespace || state.current.name, key: r.key, value: values[r.key] ?? '' }));
  const runtimeEntries = runtimeEnv
    .filter(key => !baseEntries.some(e => e.namespace === state.current.name && e.key === key))
    .map(key => ({ namespace: state.current.name, key, value: values[key] ?? '' }));
  const entriesText = [...baseEntries, ...runtimeEntries]
    .map(e => `${e.namespace}.${e.key}=${e.value ?? ''}`)
    .join('\n');

  let html = `
    <h3 style="margin-top:0">Configuration du service</h3>
    <div class="small">Interface compacte avec 2 modes: liste 2 colonnes ou texte <code>namespace.key=valeur</code>.</div>
    <label>Profil</label>
    <input id="cfg_profile" value="${esc(profile)}" placeholder="default">
    <div class="toolbar" style="margin-top:10px">
      <button class="${state.configMode === 'grid' ? '' : 'secondary'}" onclick="setConfigMode('grid')">Mode liste</button>
      <button class="${state.configMode === 'text' ? '' : 'secondary'}" onclick="setConfigMode('text')">Mode texte</button>
    </div>
  `;

  if (!req.length) {
    html += `<div class="status ok">Ce service n'a pas déclaré de besoins de configuration.</div>`;
  }

  html += `
    <div id="cfg_mode_grid" style="${state.configMode === 'grid' ? '' : 'display:none'}">
      <div class="cfg-grid">${reqRows || '<div class="small">Aucun champ déclaré.</div>'}</div>
    </div>
    <div id="cfg_mode_text" style="${state.configMode === 'text' ? '' : 'display:none'}">
      <label>Entrées (namespace.key=valeur)</label>
      <textarea id="cfg_entries_text" style="min-height:180px">${esc(entriesText)}</textarea>
    </div>
  `;

  if (runtimeEnv.length) {
    html += `<div class="small" style="margin-top:10px">Clés d'environnement détectées dans le code: <code>${esc(runtimeEnv.join(', '))}</code></div>`;
    if (missingRuntime.length) {
      html += `<div class="status warn">Clés détectées mais non renseignées: ${esc(missingRuntime.join(', '))}</div>`;
    }
  }

  html += `
    <div class="toolbar" style="margin-top:14px">
      <button onclick="saveConfig()">Sauver la configuration</button>
      <button class="secondary" onclick="showDbLab()">Ouvrir DB Lab</button>
    </div>
  `;
  document.getElementById('view').innerHTML = html;
}

function setConfigMode(mode){
  state.configMode = mode === 'text' ? 'text' : 'grid';
  showConfig();
}

function parseConfigEntriesText(raw, defaultNamespace){
  const entries = [];
  const lines = String(raw || '').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) throw new Error(`Ligne invalide: ${t}`);
    const left = t.slice(0, eq).trim();
    const value = t.slice(eq + 1);
    const dot = left.indexOf('.');
    const namespace = dot > 0 ? left.slice(0, dot).trim() : defaultNamespace;
    const key = dot > 0 ? left.slice(dot + 1).trim() : left;
    if (!namespace || !key) throw new Error(`Namespace/clé invalide: ${t}`);
    entries.push({ namespace, key, value });
  }
  return entries;
}

async function saveConfig(){
  if (!ensureCurrent()) return;
  try {
    const req = state.current.config_requirements || [];
    const profile = document.getElementById('cfg_profile')?.value?.trim() || 'default';
    let entries = [];
    if (state.configMode === 'text') {
      entries = parseConfigEntriesText(document.getElementById('cfg_entries_text')?.value || '', state.current.name);
    } else {
      entries = [...document.querySelectorAll('[data-cfg-key]')].map(el => ({
        namespace: el.dataset.cfgNamespace || state.current.name,
        key: el.dataset.cfgKey || '',
        value: el.value
      })).filter(e => e.key);
    }
    const config = {};
    req.forEach(r => {
      const ns = r.namespace || state.current.name;
      const found = entries.find(e => e.namespace === ns && e.key === r.key);
      config[r.key] = found ? found.value : '';
    });

    await api('save_service_config', {
      service: state.current.name,
      profile,
      config,
      config_entries: entries
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
  const operations = Array.isArray(state.current?.operations) ? state.current.operations : [];
  const defaultOperation = operations.includes('describe') ? 'describe' : operations[0];
  if (kind === 'empty') return {};
  if (kind === 'sample') return defaultOperation && !sample.operation ? { operation: defaultOperation, ...sample } : sample;
  if (kind === 'required') {
    const out = {};
    const required = state.current?.required_fields || [];
    required.forEach(k => { out[k] = sample[k] ?? (k === 'operation' ? (defaultOperation || '') : ''); });
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
  const ops = Array.isArray(state.current.operations) ? state.current.operations : [];
  const allTools = (state.services || []).map(s => s.name).join(', ');
  const opsBadges = ops.length ? ops.map(op => `<span class="badge" style="margin-right:6px">${esc(op)}</span>`).join('') : '<span class="small">Aucune opération détectée.</span>';
  document.getElementById('view').innerHTML = `
    <h3 style="margin-top:0">Test du service</h3>
    <div class="small">Choix moteur + JSON vide/exemple + sortie et logs.</div>
    <div class="small" style="margin-top:8px"><strong>Outils disponibles:</strong> ${esc(allTools || 'n/a')}</div>
    <div class="small" style="margin-top:6px"><strong>Opérations du service:</strong> ${opsBadges}</div>
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
      <button class="warn" onclick="runDbDebug()">Diagnostic DB</button>
    </div>

    <h4>Résultat</h4>
    <pre id="testResult">Aucune exécution.</pre>
    <h4>Diagnostic guidé</h4>
    <pre id="testHints">Lance un test pour obtenir des pistes automatiques.</pre>
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
    renderTestHints(result);
    setGlobalStatus('Test terminé.', 'ok');
  } catch (e) {
    document.getElementById('testResult').textContent = String(e.message || e);
    const hints = document.getElementById('testHints');
    if (hints) hints.textContent = 'Le test a échoué avant le retour JSON. Vérifie api.php et le JSON payload.';
    setGlobalStatus(e.message || String(e), 'err');
  }
}

function renderTestHints(result){
  const hints = [];
  const errorText = String(result?.output?.error || '');
  const cfg = result?.config_values || {};
  const configuredDb = cfg.JARVIS_INFRA_DB || '';
  if (errorText.toLowerCase().includes('unable to open database file')) {
    hints.push("Erreur SQLite détectée: le process Python n'arrive pas à ouvrir la base.");
    if (configuredDb) hints.push(`JARVIS_INFRA_DB configuré: ${configuredDb}`);
    if (configuredDb && configuredDb !== state.activeDbPath) {
      hints.push(`La DB DevLab active est différente: ${state.activeDbPath}`);
    }
    hints.push('Action rapide: clique sur "Diagnostic DB" pour vérifier existence + permissions + test Python.');
  } else if (errorText.includes('provide exactly one of instance.password or instance.password_secret_key')) {
    hints.push("Erreur de payload npm_service/register_instance: renseigne exactement un seul mode d'authentification.");
    hints.push('- Mode 1 (inline): `instance.password`');
    hints.push('- Mode 2 (secret): `instance.password_secret_key` (clé existante dans `sensitive_values`).');
    hints.push("Ne fournis pas les deux en même temps, et n'envoie pas une chaîne vide.");
    if (cfg.NPM_URL || cfg.NPM_IDENTITY || cfg.NPM_SECRET) {
      hints.push("Note: les clés runtime `NPM_URL` / `NPM_IDENTITY` / `NPM_SECRET` ne servent qu'au fallback de `list_services`, pas à `register_instance`.");
    }
  } else if (result?.status === 'ok') {
    hints.push('Pas d’erreur bloquante détectée côté moteur.');
  } else {
    hints.push('Aucune règle de diagnostic automatique pour cette erreur.');
  }

  const el = document.getElementById('testHints');
  if (el) el.textContent = hints.join('\n');
}

async function runDbDebug(){
  if (!ensureCurrent()) return;
  try {
    const profile = document.getElementById('test_profile')?.value || state.current.profile || 'default';
    const refreshed = await api('get_service', { service: state.current.name, profile });
    const cfg = refreshed?.service?.config_values || {};
    const candidates = [
      cfg.JARVIS_INFRA_DB,
      state.activeDbPath
    ].filter(Boolean);
    const report = await api('debug_db_access', { paths: candidates });
    const lines = [];
    lines.push('Diagnostic DB terminé.');
    (report.inspections || []).forEach((item, idx) => {
      lines.push(`\n[${idx + 1}] ${item.path || 'path inconnu'}`);
      if (item.error) {
        lines.push(`- erreur: ${item.error}`);
        return;
      }
      lines.push(`- exists=${item.exists} is_file=${item.is_file} readable=${item.readable} writable=${item.writable}`);
      lines.push(`- dir_exists=${item.dir_exists} dir_writable=${item.dir_writable} allowed_root=${item.allowed_root}`);
      lines.push(`- pdo_open_ok=${item.pdo_open_ok} python_sqlite_ok=${item.python_sqlite_ok}`);
      if (item.pdo_error) lines.push(`- pdo_error=${item.pdo_error}`);
      if (item.python_sqlite_output) lines.push(`- python_output=${item.python_sqlite_output}`);
    });
    const hints = document.getElementById('testHints');
    if (hints) hints.textContent = lines.join('\n');
    setGlobalStatus('Diagnostic DB terminé.', 'ok');
  } catch (e) {
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
    const health = await api('healthcheck');
    const tablesData = await api('db_list_tables');
    const rowsData = await api('db_list_config');
    const probe = health.db_probe || {};
    const tables = tablesData.tables || [];
    const rows = rowsData.rows || [];

    const currentService = state.current?.name || '';
    const currentProfile = 'default';
    const currentRows = rows.filter(r => (r.profile || '') === currentProfile && (r.service_name || '') === currentService);
    const entriesText = currentRows.map(r => `${r.service_name}.${r.config_key}=${r.config_value ?? ''}`).join('\n');
    const fullConfigText = rows
      .map(r => `${r.profile}.${r.service_name}.${r.config_key}=${r.config_value ?? ''}`)
      .join('\n');

    let html = `
      <h3 style="margin-top:0">DB Lab</h3>
      <div class="small">Gestion du fichier DB + édition directe de la configuration.</div>

      <h4>Fichier DB actif</h4>
      <div class="small">Chemin courant: <code>${esc(state.activeDbPath)}</code></div>
      <div class="toolbar" style="margin-top:10px">
        <button class="secondary" onclick="dbPickPath()">Sélectionner</button>
        <button onclick="dbCreateFromPrompt()">Créer</button>
        <button class="danger" onclick="dbDeleteSelected()">Effacer</button>
        <button class="secondary" onclick="dbDownloadActive()">Télécharger</button>
      </div>
      <pre>${esc(JSON.stringify(probe, null, 2))}</pre>

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
        <div><label>Profil</label><input id="db_profile" value="${esc(currentProfile)}"></div>
        <div><label>Service</label><input id="db_service" value="${esc(currentService)}"></div>
      </div>
      <div class="toolbar" style="margin-top:10px">
        <button class="${state.dbConfigMode === 'grid' ? '' : 'secondary'}" onclick="setDbConfigMode('grid')">Mode liste</button>
        <button class="${state.dbConfigMode === 'text' ? '' : 'secondary'}" onclick="setDbConfigMode('text')">Mode texte</button>
      </div>

      <div id="db_cfg_mode_grid" style="${state.dbConfigMode === 'grid' ? '' : 'display:none'}">
        <div class="row">
          <div><label>Clé</label><input id="db_key" placeholder="API_URL"></div>
          <div><label>Valeur</label><input id="db_value" placeholder="http://..."></div>
        </div>
        <div class="toolbar">
          <button onclick="dbSetConfig()">Sauver en DB</button>
          <button class="secondary" onclick="reloadCurrentServiceFromDb()">Recharger le service</button>
        </div>
      </div>

      <div id="db_cfg_mode_text" style="${state.dbConfigMode === 'text' ? '' : 'display:none'}">
        <label>Entrées (namespace.key=valeur)</label>
        <textarea id="db_entries_text" style="min-height:180px">${esc(entriesText)}</textarea>
        <div class="toolbar">
          <button onclick="dbSaveTextEntries()">Sauver tout en DB</button>
          <button class="secondary" onclick="reloadCurrentServiceFromDb()">Recharger le service</button>
        </div>
      </div>

      <h4>Config actuelle (texte)</h4>
      <label>Vue globale (profil.service.clé=valeur)</label>
      <textarea id="db_current_config_text" style="min-height:220px" readonly>${esc(fullConfigText || '# Aucune entrée en base')}</textarea>
      <div class="small">Vue en lecture seule de toutes les entrées DB (pas seulement le service sélectionné).</div>

      <h4>Prévisualisation de table</h4>
      <pre id="db_table_preview">Chargement...</pre>
    `;

    document.getElementById('view').innerHTML = html;
    await loadDbTablePreview();
  } catch (e) {
    setGlobalStatus(e.message || String(e), 'err');
  }
}

function setDbConfigMode(mode){
  state.dbConfigMode = mode === 'text' ? 'text' : 'grid';
  showDbLab();
}

async function dbPickPath(){
  try {
    const data = await api('browse_paths', { path: state.dbBrowserPath });
    const items = (data.items || []).filter(i => i.type === 'file');
    state.dbBrowserPath = data.current_path || state.dbBrowserPath;
    const choices = items.map(i => i.path).join('\n');
    const next = prompt(`Fichiers DB détectés sous ${state.dbBrowserPath}\n\n${choices || 'Aucun fichier DB'}\n\nColle le chemin complet à activer:`, state.activeDbPath);
    if (!next) return;
    setActiveDbPath(next.trim());
    await showDbLab();
    setGlobalStatus('DB active mise à jour.', 'ok');
  } catch (e) {
    setGlobalStatus(e.message || String(e), 'err');
  }
}

async function dbCreateFromPrompt(){
  try {
    const path = prompt('Chemin complet du nouveau fichier DB (.db, format path+nomfichier)', `${state.dbBrowserPath.replace(/\/+$/, '')}/jarvis.db`);
    if (!path) return;
    const data = await api('create_db', { path: path.trim() });
    setActiveDbPath(data.path);
    await showDbLab();
    setGlobalStatus('DB créée et activée.', 'ok');
  } catch (e) {
    setGlobalStatus(e.message || String(e), 'err');
  }
}

async function dbDeleteSelected(){
  try {
    const path = prompt('Chemin complet du fichier DB à supprimer', state.activeDbPath);
    if (!path) return;
    if (!confirm(`Supprimer ${path} ?`)) return;
    await api('delete_db', { path: path.trim() });
    if (state.activeDbPath === path.trim()) setActiveDbPath(DEFAULT_DB);
    await showDbLab();
    setGlobalStatus('DB supprimée.', 'ok');
  } catch (e) {
    setGlobalStatus(e.message || String(e), 'err');
  }
}

function dbDownloadActive(){
  window.location.href = dbLink(state.activeDbPath);
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

async function dbSaveTextEntries(){
  try {
    const profile = document.getElementById('db_profile').value.trim() || 'default';
    const defaultService = document.getElementById('db_service').value.trim();
    const raw = document.getElementById('db_entries_text')?.value || '';
    const entries = parseConfigEntriesText(raw, defaultService);
    if (!entries.length) throw new Error('Aucune entrée à sauvegarder.');
    for (const entry of entries) {
      await api('db_set_config', {
        profile,
        service: entry.namespace,
        key: entry.key,
        value: entry.value
      });
    }
    setGlobalStatus(`Config DB sauvée (${entries.length} entrées).`, 'ok');
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
