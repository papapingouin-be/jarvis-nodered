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
const runNpmQuickBtn = document.getElementById('runNpmQuick');
const refreshLabBtn = document.getElementById('refreshLab');
const pythonToolList = document.getElementById('pythonToolList');
const codeEditorTool = document.getElementById('codeEditorTool');
const codeEditorPath = document.getElementById('codeEditorPath');
const codeEditor = document.getElementById('codeEditor');
const loadCodeBtn = document.getElementById('loadCode');
const saveCodeBtn = document.getElementById('saveCode');
const openNpmCodeBtn = document.getElementById('openNpmCode');

let availableTools = [];

dbPathInput.value = localStorage.getItem('jarvis_db_path') || '';

function status(msg, ok = true) {
  globalStatus.className = `status ${ok ? 'ok' : 'err'}`;
  globalStatus.textContent = msg;
}

function dbPath() {
  const path = dbPathInput.value.trim();
  localStorage.setItem('jarvis_db_path', path);
  return path;
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

async function loadToolList() {
  const data = await api('list_python_tools');
  availableTools = data.items || [];

  const options = availableTools
    .map((tool) => `<option value="${tool.name}">${tool.name}</option>`)
    .join('');

  labToolSelect.innerHTML = options;
  codeEditorTool.innerHTML = options;

  pythonToolList.innerHTML = availableTools
    .map((tool) => `<li><code>${tool.name}</code> · <span class="subtle">${tool.entrypoint}</span></li>`)
    .join('');

  if (availableTools.length === 0) {
    labInput.value = '{}';
    labResult.textContent = 'Aucun outil Python détecté.';
    codeEditorPath.textContent = 'Aucun fichier chargé';
    return;
  }

  await selectLabTool(labToolSelect.value || availableTools[0].name);
  await loadToolCode(codeEditorTool.value || availableTools[0].name);
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
  labInput.value = prettyJson(toolDefaultInput(toolName));
  setLabResult({
    info: 'Prêt à exécuter',
    tool: toolName,
  });
}

async function runLabTool() {
  const tool = labToolSelect.value;
  if (!tool) {
    throw new Error('Aucun outil sélectionné');
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

  const result = await api('run_python_tool', {
    tool,
    input,
  });

  setLabResult(result);
}

async function runQuickNpmTest() {
  const npmTool = availableTools.find((item) => item.name === 'npm_service');
  if (!npmTool) {
    throw new Error("L'outil npm_service n'est pas disponible");
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
  const data = await api('get_tool_code', { tool: toolName });
  codeEditor.value = data.code;
  codeEditorPath.textContent = data.path;
}

async function saveToolCode() {
  const tool = codeEditorTool.value;
  if (!tool) {
    throw new Error('Aucun outil sélectionné pour sauvegarde');
  }

  const data = await api('save_tool_code', {
    tool,
    code: codeEditor.value,
  });

  codeEditorPath.textContent = data.path;
  status(`Code Python sauvegardé pour ${tool}`);
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
runLabBtn.onclick = async () => {
  try {
    await runLabTool();
    status(`Exécution de ${labToolSelect.value} terminée`);
  } catch (e) {
    status(e.message, false);
    setLabResult({ error: e.message });
  }
};
runNpmQuickBtn.onclick = async () => {
  try {
    await runQuickNpmTest();
    status('Test rapide npm_service terminé');
  } catch (e) {
    status(e.message, false);
    setLabResult({ error: e.message });
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
    const npmTool = availableTools.find((item) => item.name === 'npm_service');
    if (!npmTool) {
      throw new Error("L'outil npm_service n'est pas disponible");
    }
    await loadToolCode('npm_service');
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
reloadAll();
