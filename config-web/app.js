const state = {
  services: [],
  current: null,
  editor: null,
  currentCodePath: null
};

function esc(v){
  return String(v ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function setGlobalStatus(message, ok=false){
  const el = document.getElementById('globalStatus');
  if (!message){
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `<div class="status ${ok ? 'ok' : 'err'}">${esc(message)}</div>`;
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
    throw new Error("api.php n'a pas renvoyé du JSON valide. Début de réponse: " + text.slice(0, 300));
  }

  if (!response.ok) {
    throw new Error(json.error || (`HTTP ${response.status}`));
  }

  if (json.error) {
    throw new Error(json.error + (json.message ? ` — ${json.message}` : ''));
  }

  return json;
}

async function bootstrap(){
  try {
    const health = await api('healthcheck');
    setApiStatus('API OK', true);
    if (health.php_version) {
      document.getElementById('serviceMeta').textContent = `PHP ${health.php_version} · DB ${health.db_path}`;
    }
    await loadServices();
    setGlobalStatus('Interface chargée.', true);
  } catch (e) {
    setApiStatus('API erreur', false);
    setGlobalStatus(e.message || String(e));
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

  selectService(state.services[0].name);
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
    setGlobalStatus('');
    showConfig();
  } catch (e) {
    setGlobalStatus(e.message || String(e));
  }
}

function ensureCurrent(){
  if (!state.current) {
    setGlobalStatus('Aucun service sélectionné.');
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
    <div class="small">Profil actif : <code>${esc(profile)}</code></div>
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

  html += `<div style="margin-top:14px"><button onclick="saveConfig()">Sauver la configuration</button></div>`;
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
    setGlobalStatus('Configuration sauvée.', true);
    showConfig();
  } catch (e) {
    setGlobalStatus(e.message || String(e));
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
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error('Le JSON de test est invalide.');
    }

    document.getElementById('testResult').textContent = 'Exécution en cours...';

    const result = await api('run_service_test', {
      service: state.current.name,
      engine,
      timeout,
      profile,
      payload
    });

    document.getElementById('testResult').textContent = JSON.stringify(result, null, 2);
    setGlobalStatus('Test terminé.', true);
  } catch (e) {
    document.getElementById('testResult').textContent = String(e.message || e);
    setGlobalStatus(e.message || String(e));
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
      document.getElementById("codeDiag").textContent = "Monaco n\'a pas pu être chargé.";
      return;
    }

    window.require.config({ paths: { 'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs' } });
    window.require(['vs/editor/editor.main'], async function () {
      if (state.editor) {
        state.editor.dispose();
      }
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
    setGlobalStatus(e.message || String(e));
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
    setGlobalStatus(e.message || String(e));
  }
}

async function saveCodeFile(){
  try {
    const path = document.getElementById('code_file').value;
    if (!path || !state.editor) return;
    const content = state.editor.getValue();
    const data = await api('save_code_file', { path, content });
    document.getElementById('codeDiag').textContent = JSON.stringify(data, null, 2);
    setGlobalStatus('Fichier sauvegardé.', true);
  } catch (e) {
    setGlobalStatus(e.message || String(e));
  }
}

async function validateCodeFile(){
  try {
    const path = document.getElementById('code_file').value;
    if (!path || !state.editor) return;
    const content = state.editor.getValue();
    const data = await api('validate_code_file', { path, content });
    document.getElementById('codeDiag').textContent = JSON.stringify(data, null, 2);
    setGlobalStatus(data.valid ? 'Validation OK.' : 'Validation en échec.', !!data.valid);
  } catch (e) {
    setGlobalStatus(e.message || String(e));
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
      html += `<table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Date</th>
            <th>Service</th>
            <th>Moteur</th>
            <th>Statut</th>
            <th>Résumé</th>
          </tr>
        </thead>
        <tbody>
      `;
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
    setGlobalStatus(e.message || String(e));
  }
}

bootstrap();
