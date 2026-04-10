const globalStatus = document.getElementById('globalStatus');
const dbPathInput = document.getElementById('dbPath');

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
    table.innerHTML = '<tr><td class="muted">Aucune donnée</td></tr>';
    return;
  }
  const header = `<tr>${columns.map((c) => `<th>${c}</th>`).join('')}</tr>`;
  const body = rows
    .map((row) => `<tr>${columns.map((c) => `<td>${row[c] ?? ''}</td>`).join('')}</tr>`)
    .join('');
  table.innerHTML = header + body;
}

async function reloadAll() {
  try {
    const [s, t, c, ni] = await Promise.all([
      api('list_sensitive', { namespace: val('sNamespace') || 'proxmox' }),
      api('list_proxmox_targets'),
      api('list_ct_services'),
      api('list_npm_instances'),
    ]);

    renderTable('sensitiveTable', ['namespace', 'key', 'updated_at'], s.items);
    renderTable('targetsTable', ['name', 'ip', 'api_path', 'login', 'node', 'password_secret_key'], t.items);
    renderTable('ctServicesTable', ['name', 'target_name', 'ctid', 'path'], c.items);
    renderTable('npmInstancesTable', ['name', 'base_url', 'login', 'password_secret_key'], ni.items);

    if (val('nsInstance')) {
      const ns = await api('list_npm_services', { instance_name: val('nsInstance') });
      renderTable('npmServicesTable', ['domain', 'instance_name', 'forward_host', 'forward_port', 'scheme'], ns.items);
    }

    status('Chargement OK');
  } catch (e) {
    status(e.message, false);
  }
}

document.getElementById('reloadAll').onclick = reloadAll;

document.getElementById('saveSensitive').onclick = async () => {
  try {
    await api('upsert_sensitive', { namespace: val('sNamespace'), key: val('sKey'), value: val('sValue') });
    status('Secret enregistré');
    await reloadAll();
  } catch (e) { status(e.message, false); }
};

document.getElementById('listSensitive').onclick = async () => {
  try {
    const data = await api('list_sensitive', { namespace: val('sNamespace') });
    renderTable('sensitiveTable', ['namespace', 'key', 'updated_at'], data.items);
    status('Liste sensitive chargée');
  } catch (e) { status(e.message, false); }
};

document.getElementById('deleteSensitive').onclick = async () => {
  try {
    await api('delete_sensitive', { namespace: val('sNamespace'), key: val('sKey') });
    status('Secret supprimé (si existant)');
    await reloadAll();
  } catch (e) { status(e.message, false); }
};

document.getElementById('saveTarget').onclick = async () => {
  try {
    await api('upsert_proxmox_target', {
      row: {
        name: val('pName'), ip: val('pIp'), api_path: val('pApiPath') || '/api2/json', login: val('pLogin'),
        node: val('pNode'), password: val('pPassword') || null, password_secret_key: val('pPasswordKey') || null,
      },
    });
    status('Target proxmox enregistrée');
    await reloadAll();
  } catch (e) { status(e.message, false); }
};

document.getElementById('listTargets').onclick = async () => {
  try {
    const data = await api('list_proxmox_targets');
    renderTable('targetsTable', ['name', 'ip', 'api_path', 'login', 'node', 'password_secret_key'], data.items);
    status('Liste targets chargée');
  } catch (e) { status(e.message, false); }
};

document.getElementById('saveCtService').onclick = async () => {
  try {
    await api('upsert_ct_service', {
      row: { name: val('ctName'), target_name: val('ctTarget'), ctid: Number(val('ctId')), path: val('ctPath') || '/' },
    });
    status('Service CT enregistré');
    await reloadAll();
  } catch (e) { status(e.message, false); }
};

document.getElementById('listCtServices').onclick = async () => {
  try {
    const data = await api('list_ct_services');
    renderTable('ctServicesTable', ['name', 'target_name', 'ctid', 'path'], data.items);
    status('Liste CT services chargée');
  } catch (e) { status(e.message, false); }
};

document.getElementById('saveNpmInstance').onclick = async () => {
  try {
    await api('upsert_npm_instance', {
      row: {
        name: val('nName'), base_url: val('nBaseUrl'), login: val('nLogin'),
        password: val('nPassword') || null, password_secret_key: val('nPasswordKey') || null,
      },
    });
    status('Instance NPM enregistrée');
    await reloadAll();
  } catch (e) { status(e.message, false); }
};

document.getElementById('listNpmInstances').onclick = async () => {
  try {
    const data = await api('list_npm_instances');
    renderTable('npmInstancesTable', ['name', 'base_url', 'login', 'password_secret_key'], data.items);
    status('Liste NPM instances chargée');
  } catch (e) { status(e.message, false); }
};

document.getElementById('saveNpmService').onclick = async () => {
  try {
    await api('upsert_npm_service', {
      row: {
        domain: val('nsDomain'), instance_name: val('nsInstance'), forward_host: val('nsForwardHost'),
        forward_port: Number(val('nsForwardPort')), scheme: val('nsScheme') || 'http',
      },
    });
    status('Service NPM enregistré');
    await reloadAll();
  } catch (e) { status(e.message, false); }
};

document.getElementById('listNpmServices').onclick = async () => {
  try {
    const data = await api('list_npm_services', { instance_name: val('nsInstance') });
    renderTable('npmServicesTable', ['domain', 'instance_name', 'forward_host', 'forward_port', 'scheme'], data.items);
    status('Liste NPM services chargée');
  } catch (e) { status(e.message, false); }
};

reloadAll();
