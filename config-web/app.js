const TOOL_PARAMS = {
  runtime: [
    'TOOLBOX_RUNNER_URL',
  ],
  proxmox: [
    'PROXMOX_API_TOKEN_ID',
    'PROXMOX_API_TOKEN_SECRET',
    'PROXMOX_HOST',
    'PROXMOX_PASSWORD',
    'PROXMOX_SSH_PORT',
    'PROXMOX_USER',
    'PROXMOX_WEB',
  ],
  npm_service: [
    'NPM_URL',
    'NPM_IDENTITY',
    'NPM_SECRET',
  ],
};

const TOOL_LABELS = {
  runtime: 'runtime',
  proxmox: 'proxmox',
  npm_service: 'npm_service',
};

const FIELD_HINTS = {
  NPM_URL: 'Format attendu: http://192.168.12.250:81/api',
  TOOLBOX_RUNNER_URL: 'Format attendu: http://localhost:8030',
};

const globalStatus = document.getElementById('globalStatus');
const dbPathInput = document.getElementById('dbPath');
const toolSelect = document.getElementById('cfgTool');
const configEditor = document.getElementById('configEditor');
const labToolSelect = document.getElementById('labTool');
const labInput = document.getElementById('labInput');
const labResult = document.getElementById('labResult');
const runLabBtn = document.getElementById('runLab');
const runAllLabBtn = document.getElementById('runAllLab');
const runNpmQuickBtn = document.getElementById('runNpmQuick');
const refreshLabBtn = document.getElementById('refreshLab');
const pythonToolList = document.getElementById('pythonToolList');
const labDiagnostics = document.getElementById('labDiagnostics');
const flowSelectedTool = document.getElementById('flowSelectedTool');
const flowDbPath = document.getElementById('flowDbPath');
const flowRunStatus = document.getElementById('flowRunStatus');
const codeEditorTool = document.getElementById('codeEditorTool');
const codeEditorPath = document.getElementById('codeEditorPath');
const codeEditor = document.getElementById('codeEditor');
const loadCodeBtn = document.getElementById('loadCode');
const saveCodeBtn = document.getElementById('saveCode');
const openNpmCodeBtn = document.getElementById('openNpmCode');

let availableTools = [];
let availablePythonFiles = [];

dbPathInput.value = localStorage.getItem('jarvis_db_path') || '';

function status(msg, ok = true) {
  globalStatus.className = `status ${ok ? 'ok' : 'err'}`;
  globalStatus.textContent = msg;
}

function dbPath() {
  const path = dbPathInput.value.trim();
  localStorage.setItem('jarvis_db_path', path);
  updateFlowContext();
  return path;
}

function updateFlowContext(statusValue) {
  const db = dbPathInput.value.trim();
  flowDbPath.textContent = db || 'non défini';
  flowSelectedTool.textContent = labToolSelect.value || '-';
  if (statusValue) {
    flowRunStatus.textContent = statusValue;
  }
}

async function api(action, payload = {}) {
  const res = await fetch('api.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, db_path: dbPath(), ...payload }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

async function renderEditor() {
  const tool = toolSelect.value;
  const keys = TOOL_PARAMS[tool] || [];
  const data = await api('list_sensitive', { namespace: tool });
  const valuesByKey = Object.fromEntries(data.items.map((item) => [item.key, item]));

  if (keys.length === 0) {
    configEditor.innerHTML = '<tr><td class="subtle">Aucun paramètre configuré pour cet outil.</td></tr>';
    return;
  }

  const header = `
    <tr>
      <th>Clé</th>
      <th>Valeur</th>
      <th>Info</th>
      <th>Action</th>
    </tr>
  `;

  const body = keys.map((key) => {
    const existing = valuesByKey[key];
    const updated = existing?.updated_at ? `Sauvegardé: ${existing.updated_at}` : 'Pas encore sauvegardé';
    const hint = FIELD_HINTS[key] ? ` · ${FIELD_HINTS[key]}` : '';

    return `
      <tr>
        <td><code>${key}</code></td>
        <td>
          <input data-key="${key}" type="text" value="${existing?.value ?? ''}" placeholder="Saisir une valeur" />
        </td>
        <td class="subtle">${updated}${hint}</td>
        <td>
          <div class="row">
            <button data-action="save" data-key="${key}">Enregistrer</button>
            <button class="danger" data-action="delete" data-key="${key}">Supprimer</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  configEditor.innerHTML = header + body;
}

function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function setLabResult(payload) {
  labResult.textContent = prettyJson(payload);
}

function setLabDiagnostics(payload) {
  labDiagnostics.textContent = prettyJson(payload);
}

function readLabDiagnostics() {
  try {
    return JSON.parse(labDiagnostics.textContent || '{}');
  } catch {
    return {};
  }
}

async function loadToolList() {
  const [toolsData, filesData] = await Promise.all([
    api('list_python_tools'),
    api('list_python_files'),
  ]);
  availableTools = toolsData.items || [];
  availablePythonFiles = filesData.items || [];

  const toolOptions = availableTools
    .map((tool) => `<option value="${tool.name}">${tool.name}</option>`)
    .join('');
  const fileOptions = availablePythonFiles
    .map((file) => `<option value="${file.path}">${file.path}</option>`)
    .join('');

  labToolSelect.innerHTML = toolOptions;
  codeEditorTool.innerHTML = fileOptions;

  pythonToolList.innerHTML = availablePythonFiles
    .map((file) => `<li><code>${file.path}</code> · <span class="subtle">${file.manifest_exists ? 'manifest OK' : 'sans manifest'} · ${file.size} octets</span></li>`)
    .join('');

  setLabDiagnostics({
    scanned_root: filesData.search_root || 'jarvis/toolbox/tools',
    scanned_python_pattern: filesData.search_python_pattern || '**/*.py',
    scanned_manifest_pattern: toolsData.search_manifest_pattern || '**/manifest.json',
    scanned_entrypoint_extension: toolsData.search_entrypoint_extension || '.py',
    scanned_python_files_count: availablePythonFiles.length,
    scanned_tool_runnables_count: availableTools.length,
    scanned_python_files: availablePythonFiles,
    scanned_tools: availableTools.map((tool) => ({
      name: tool.name,
      entrypoint: tool.entrypoint,
      manifest_path: tool.manifest_path,
      code_path: tool.code_path,
    })),
    note: 'Les fichiers .py sont listés même sans manifest. Seuls les outils avec manifest+entrypoint sont exécutables.',
  });

  if (availablePythonFiles.length === 0) {
    labInput.value = '{}';
    labResult.textContent = 'Aucun fichier Python détecté.';
    codeEditorPath.textContent = 'Aucun fichier chargé';
    updateFlowContext('aucun outil détecté');
    return;
  }

  if (availableTools.length > 0) {
    await selectLabTool(labToolSelect.value || availableTools[0].name);
  } else {
    labInput.value = '{}';
    setLabResult({ warning: 'Aucun outil exécutable détecté via manifest.json' });
    updateFlowContext('manifest manquant');
  }
  await loadToolCode(codeEditorTool.value || availablePythonFiles[0].path);
  updateFlowContext('prêt');
}

function toolDefaultInput(toolName) {
  const tool = availableTools.find((item) => item.name === toolName);
  if (!tool) {
    return {};
  }
  return tool.sample_input || {};
}

async function selectLabTool(toolName) {
  labToolSelect.value = toolName;
  const defaultInput = toolDefaultInput(toolName);
  labInput.value = prettyJson(Object.keys(defaultInput).length ? defaultInput : {
    note: 'Aucun sample_input défini pour cet outil',
  });
  setLabResult({
    info: 'Prêt à exécuter',
    tool: toolName,
  });
  updateFlowContext('outil sélectionné');
}

async function runLabTool() {
  const tool = labToolSelect.value;
  if (!tool) {
    throw new Error('Aucun outil exécutable sélectionné. Vérifiez les manifest.json.');
  }

  let input;
  try {
    input = JSON.parse(labInput.value || '{}');
  } catch (e) {
    throw new Error(`JSON input invalide: ${e.message}`);
  }

  setLabResult({
    status: 'running',
    tool,
  });
  updateFlowContext('en cours');

  const result = await api('run_python_tool', {
    tool,
    input,
  });

  setLabResult(result);
  updateFlowContext(result?.response?.status || 'terminé');
}

async function runAllLabTools() {
  if (availableTools.length === 0) {
    throw new Error("Aucun outil Python détecté dans jarvis/toolbox/tools.");
  }

  const startedAt = new Date().toISOString();
  const results = [];
  setLabResult({
    status: 'running_all',
    total_tools: availableTools.length,
    started_at: startedAt,
  });
  updateFlowContext('batch en cours');

  for (const tool of availableTools) {
    const input = toolDefaultInput(tool.name);
    try {
      const result = await api('run_python_tool', {
        tool: tool.name,
        input,
      });
      results.push({
        tool: tool.name,
        ok: true,
        http_code: result.http_code,
        response_status: result.response?.status || null,
      });
    } catch (e) {
      results.push({
        tool: tool.name,
        ok: false,
        error: e.message,
      });
    }
  }

  const summary = {
    status: 'completed_all',
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    total_tools: availableTools.length,
    ok_count: results.filter((item) => item.ok).length,
    fail_count: results.filter((item) => !item.ok).length,
    results,
  };

  setLabResult(summary);
  updateFlowContext('batch terminé');
  setLabDiagnostics({
    ...readLabDiagnostics(),
    last_batch_run: summary,
  });
}

async function runQuickNpmTest() {
  const npmTool = availableTools.find((item) => item.name === 'npm_service');
  if (!npmTool) {
    throw new Error(`L'outil npm_service n'est pas disponible. Outils détectés: ${availableTools.map((tool) => tool.name).join(', ') || 'aucun'}. Cliquez d'abord sur "Rafraîchir la liste".`);
  }

  labToolSelect.value = 'npm_service';
  const quickInput = {
    operation: 'list_services',
  };
  labInput.value = prettyJson(quickInput);
  await runLabTool();
}

async function loadToolCode(toolName) {
  if (!toolName) {
    return;
  }
  codeEditorTool.value = toolName;
  const data = await api('get_python_file', { path: toolName });
  codeEditor.value = data.code;
  codeEditorPath.textContent = data.path;
}

async function saveToolCode() {
  const path = codeEditorTool.value;
  if (!path) {
    throw new Error('Aucun outil sélectionné pour sauvegarde');
  }

  const data = await api('save_python_file', {
    path,
    code: codeEditor.value,
  });

  codeEditorPath.textContent = data.path;
  status(`Code Python sauvegardé: ${data.path}`);
  await loadToolList();
}

async function reloadAll() {
  try {
    await renderEditor();
    await loadToolList();
    status('Chargement OK');
  } catch (e) {
    status(e.message, false);
  }
}

async function saveKey(key) {
  const input = configEditor.querySelector(`input[data-key="${key}"]`);
  if (!input || input.value.trim() === '') {
    throw new Error(`Valeur vide pour ${key}`);
  }
  await api('upsert_sensitive', {
    namespace: toolSelect.value,
    key,
    value: input.value.trim(),
  });
}

async function deleteKey(key) {
  await api('delete_sensitive', {
    namespace: toolSelect.value,
    key,
  });
}

document.getElementById('reloadAll').onclick = reloadAll;
toolSelect.onchange = reloadAll;
labToolSelect.onchange = () => selectLabTool(labToolSelect.value);
dbPathInput.onchange = () => updateFlowContext();
runLabBtn.onclick = async () => {
  try {
    await runLabTool();
    status(`Exécution de ${labToolSelect.value} terminée`);
  } catch (e) {
    status(e.message, false);
    setLabResult({ error: e.message });
    updateFlowContext('erreur');
  }
};
runAllLabBtn.onclick = async () => {
  try {
    await runAllLabTools();
    status('Test global des outils terminé');
  } catch (e) {
    status(e.message, false);
    setLabResult({ error: e.message });
    updateFlowContext('erreur');
  }
};
runNpmQuickBtn.onclick = async () => {
  try {
    await runQuickNpmTest();
    status('Test rapide npm_service terminé');
  } catch (e) {
    status(e.message, false);
    setLabResult({ error: e.message });
    updateFlowContext('erreur');
  }
};
refreshLabBtn.onclick = reloadAll;
loadCodeBtn.onclick = async () => {
  try {
    await loadToolCode(codeEditorTool.value);
    status(`Code chargé pour ${codeEditorTool.value}`);
  } catch (e) {
    status(e.message, false);
  }
};
saveCodeBtn.onclick = async () => {
  try {
    await saveToolCode();
  } catch (e) {
    status(e.message, false);
  }
};
openNpmCodeBtn.onclick = async () => {
  try {
    const npmFile = availablePythonFiles.find((item) => item.path.endsWith('npm_service/tool.py'));
    if (!npmFile) {
      throw new Error('Fichier npm_service/tool.py introuvable');
    }
    await loadToolCode(npmFile.path);
    status('Code chargé pour npm_service');
  } catch (e) {
    status(e.message, false);
  }
};

configEditor.onclick = async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const action = target.dataset.action;
  const key = target.dataset.key;
  if (!action || !key) {
    return;
  }

  try {
    if (action === 'save') {
      await saveKey(key);
      status(`${key} enregistré`);
    }
    if (action === 'delete') {
      await deleteKey(key);
      status(`${key} supprimé (si existant)`);
    }
    await renderEditor();
  } catch (e) {
    status(e.message, false);
  }
};


function initTabs() {
  const buttons = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel');

  buttons.forEach((btn) => {
    btn.onclick = () => {
      const target = btn.dataset.tab;
      buttons.forEach((b) => b.classList.toggle('active', b === btn));
      panels.forEach((panel) => panel.classList.toggle('active', panel.id === target));
    };
  });
}

function initToolSelect() {
  toolSelect.innerHTML = Object.keys(TOOL_PARAMS)
    .map((tool) => `<option value="${tool}">${TOOL_LABELS[tool] || tool}</option>`)
    .join('');
}

initTabs();
initToolSelect();
updateFlowContext('initialisation');
reloadAll();
