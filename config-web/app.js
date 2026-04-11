const TOOL_PARAMS = {
  proxmox: [
    'PROXMOX_API_TOKEN_ID',
    'PROXMOX_API_TOKEN_SECRET',
    'PROXMOX_HOST',
    'PROXMOX_PASSWORD',
    'PROXMOX_SSH_PORT',
    'PROXMOX_USER',
    'PROXMOX_WEB',
  ],
  npm_service: [],
};

const TOOL_LABELS = {
  proxmox: 'proxmox',
  npm_service: 'npm_service',
};

const globalStatus = document.getElementById('globalStatus');
const dbPathInput = document.getElementById('dbPath');
const toolSelect = document.getElementById('cfgTool');
const keySelect = document.getElementById('cfgKey');

dbPathInput.value = localStorage.getItem('jarvis_db_path') || '';

function status(msg, ok = true) {
  globalStatus.className = `status ${ok ? 'ok' : 'err'}`;
  globalStatus.textContent = msg;
}

function val(id) {
  return document.getElementById(id).value.trim();
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

function renderTable(id, columns, rows) {
  const table = document.getElementById(id);
  if (!rows || rows.length === 0) {
    table.innerHTML = '<tr><td class="subtle">Liste vide</td></tr>';
    return;
  }
  const header = `<tr>${columns.map((c) => `<th>${c}</th>`).join('')}</tr>`;
  const body = rows
    .map((row) => `<tr>${columns.map((c) => `<td>${row[c] ?? ''}</td>`).join('')}</tr>`)
    .join('');
  table.innerHTML = header + body;
}

function buildCatalog() {
  const rows = Object.entries(TOOL_PARAMS).flatMap(([tool, params]) => {
    if (params.length === 0) {
      return [{ tool: TOOL_LABELS[tool] || tool, parameter: '', note: 'Liste vide' }];
    }
    return params.map((parameter) => ({ tool: TOOL_LABELS[tool] || tool, parameter, note: 'À stocker' }));
  });
  renderTable('catalogTable', ['tool', 'parameter', 'note'], rows);
}

function refreshKeyOptions() {
  const tool = toolSelect.value;
  const keys = TOOL_PARAMS[tool] || [];
  keySelect.innerHTML = keys.map((k) => `<option value="${k}">${k}</option>`).join('');
  keySelect.disabled = keys.length === 0;
}

async function reloadAll() {
  try {
    const tool = toolSelect.value;
    const data = await api('list_sensitive', { namespace: tool });
    renderTable('configTable', ['namespace', 'key', 'updated_at'], data.items);
    status('Chargement OK');
  } catch (e) {
    status(e.message, false);
  }
}

document.getElementById('reloadAll').onclick = reloadAll;

document.getElementById('saveConfig').onclick = async () => {
  try {
    if (keySelect.disabled) {
      throw new Error('Aucun paramètre à stocker pour cet outil');
    }
    await api('upsert_sensitive', {
      namespace: toolSelect.value,
      key: keySelect.value,
      value: val('cfgValue'),
    });
    status('Valeur enregistrée');
    await reloadAll();
  } catch (e) {
    status(e.message, false);
  }
};

document.getElementById('listConfig').onclick = reloadAll;

document.getElementById('deleteConfig').onclick = async () => {
  try {
    if (keySelect.disabled) {
      throw new Error('Aucun paramètre à supprimer pour cet outil');
    }
    await api('delete_sensitive', {
      namespace: toolSelect.value,
      key: keySelect.value,
    });
    status('Valeur supprimée (si existante)');
    await reloadAll();
  } catch (e) {
    status(e.message, false);
  }
};

toolSelect.onchange = async () => {
  refreshKeyOptions();
  await reloadAll();
};

function initToolSelect() {
  toolSelect.innerHTML = Object.keys(TOOL_PARAMS)
    .map((tool) => `<option value="${tool}">${TOOL_LABELS[tool] || tool}</option>`)
    .join('');
  refreshKeyOptions();
}

buildCatalog();
initToolSelect();
reloadAll();
