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
  npm_service: [
    'NPM_URL',
    'NPM_IDENTITY',
    'NPM_SECRET',
  ],
};

const TOOL_LABELS = {
  proxmox: 'proxmox',
  npm_service: 'npm_service',
};

const FIELD_HINTS = {
  NPM_URL: 'Format attendu: http://192.168.12.250:81/api',
};

const globalStatus = document.getElementById('globalStatus');
const dbPathInput = document.getElementById('dbPath');
const toolSelect = document.getElementById('cfgTool');
const configEditor = document.getElementById('configEditor');

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
          <input data-key="${key}" type="password" value="${existing?.value ?? ''}" placeholder="Saisir une valeur" />
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

async function reloadAll() {
  try {
    await renderEditor();
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
    await reloadAll();
  } catch (e) {
    status(e.message, false);
  }
};

function initToolSelect() {
  toolSelect.innerHTML = Object.keys(TOOL_PARAMS)
    .map((tool) => `<option value="${tool}">${TOOL_LABELS[tool] || tool}</option>`)
    .join('');
}

initToolSelect();
reloadAll();
