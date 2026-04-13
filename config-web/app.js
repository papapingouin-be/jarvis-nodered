const els = {
  dbStatus: document.getElementById('dbStatus'),
  dbDetails: document.getElementById('dbDetails'),
  createDb: document.getElementById('createDb'),
  selectDb: document.getElementById('selectDb'),
  uploadDb: document.getElementById('uploadDb'),
  exportDb: document.getElementById('exportDb'),
  deleteDb: document.getElementById('deleteDb'),
  dbModal: document.getElementById('dbModal'),
  dbModalTitle: document.getElementById('dbModalTitle'),
  dbBrowserPath: document.getElementById('dbBrowserPath'),
  dbBrowserList: document.getElementById('dbBrowserList'),
  dbActionBody: document.getElementById('dbActionBody'),
  dbActionOutput: document.getElementById('dbActionOutput'),
  dbActionConfirm: document.getElementById('dbActionConfirm'),
  dbActionCancel: document.getElementById('dbActionCancel'),
};

const DB_KEY = 'jarvis_active_db_path';
const DEFAULT_DB = '/var/www/jarvis/database/jarvis_infra.db';

const state = {
  activeDb: localStorage.getItem(DB_KEY) || DEFAULT_DB,
  modalAction: null,
  selectedPath: null,
  browserPath: '/var/www/jarvis/database',
  lastFocus: null,
};

function dblog(step, data = null) {
  console.log('[DB]', step, data ?? '');
}

function setActiveDb(path) {
  state.activeDb = path;
  localStorage.setItem(DB_KEY, path);
  dblog('active.path.saved', { path });
}

async function api(action, payload = {}, expectJson = true) {
  const body = { action, db_path: state.activeDb, ...payload };
  dblog('api.request', body);
  const res = await fetch('api.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!expectJson) return res;
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  dblog('api.response', { action, status: res.status, data });
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function renderHealth(data) {
  const db = data.db || {};
  const exists = !!db.exists;
  const openOk = !!db.sqlite_open_ok;
  const ok = exists && openOk;
  const color = ok ? '#10b981' : exists ? '#f59e0b' : '#ef4444';
  els.dbStatus.innerHTML = `
    <div><strong>DB active :</strong> <span style="color:${color}">${db.path || state.activeDb}</span></div>
    <div style="margin-top:.35rem;">
      ${exists ? `<a href="api.php?action=download_db&db_path=${encodeURIComponent(db.path)}">Télécharger la DB active</a>` : '<span style="color:#94a3b8">Aucune DB active valide.</span>'}
    </div>
  `;
  els.dbDetails.textContent = JSON.stringify({
    exists: db.exists,
    readable: db.readable,
    writable: db.writable,
    dir: db.dir,
    dir_exists: db.dir_exists,
    dir_writable: db.dir_writable,
    sqlite_open_ok: db.sqlite_open_ok,
    sqlite_error: db.sqlite_error,
    preferred_db_path: data.preferred_db_path,
  }, null, 2);
  dblog('health.render', { db });
}

async function refreshHealth() {
  dblog('health.request', { activeDb: state.activeDb });
  try {
    const data = await api('healthcheck');
    renderHealth(data);
  } catch (err) {
    els.dbStatus.textContent = 'Erreur healthcheck DB';
    els.dbDetails.textContent = String(err.message || err);
    dblog('health.error', { error: String(err.message || err) });
  }
}

function openModal(action, trigger = null) {
  state.lastFocus = trigger || document.activeElement;
  state.modalAction = action;
  state.selectedPath = null;
  els.dbActionOutput.textContent = 'Aucune action.';
  els.dbBrowserPath.textContent = state.browserPath;
  els.dbModal.hidden = false;
  const titles = {
    create: 'Créer une nouvelle DB',
    select: 'Sélectionner une DB existante',
    delete: 'Effacer une DB',
    upload: 'Uploader une DB locale',
    export: 'Exporter / télécharger la DB active',
  };
  els.dbModalTitle.textContent = titles[action] || 'Gestion DB';

  if (action === 'create') {
    els.dbActionBody.innerHTML = `
      <label>Nom du nouveau fichier DB</label>
      <input id="modalNewDbName" placeholder="jarvis_infra.db" value="jarvis_infra.db">
      <div class="small">Choisis d'abord un dossier dans l'arborescence, puis confirme.</div>
    `;
  } else if (action === 'upload') {
    els.dbActionBody.innerHTML = `
      <label>Fichier DB local</label>
      <input id="modalUploadFile" type="file" accept=".db,.sqlite,.sqlite3">
      <div class="small">Choisis d'abord un dossier distant. Cette version prépare le flux de choix.</div>
    `;
  } else if (action === 'export') {
    els.dbActionBody.innerHTML = `<div class="small">Le téléchargement utilise directement le lien de la DB active.</div>`;
  } else {
    els.dbActionBody.innerHTML = `<div class="small">Choisis un fichier .db dans l'arborescence distante, puis confirme.</div>`;
  }

  loadBrowser(state.browserPath);
  dblog('manager.open', { action });
  setTimeout(() => {
    const field = document.getElementById('modalNewDbName') || document.getElementById('modalUploadFile') || els.dbActionConfirm;
    field?.focus();
  }, 20);
}

function closeModal() {
  els.dbModal.hidden = true;
  state.modalAction = null;
  state.selectedPath = null;
  if (state.lastFocus && typeof state.lastFocus.focus === 'function') {
    setTimeout(() => state.lastFocus.focus(), 0);
  }
}

async function loadBrowser(path) {
  try {
    dblog('browse.start', { path });
    const data = await api('browse_paths', { path });
    state.browserPath = data.current_path;
    els.dbBrowserPath.textContent = data.current_path;
    els.dbBrowserList.innerHTML = (data.items || []).map(item => `
      <button type="button" class="browser-item" data-path="${item.path.replace(/"/g, '&quot;')}" data-type="${item.type}">
        <span>${item.type === 'dir' ? '📁' : '🗄️'} ${item.name}</span>
        <span class="small">${item.type}</span>
      </button>
    `).join('') || '<div class="small">Dossier vide.</div>';

    [...els.dbBrowserList.querySelectorAll('[data-path]')].forEach(btn => {
      btn.onclick = () => {
        const p = btn.dataset.path;
        const type = btn.dataset.type;
        if (type === 'dir') {
          state.selectedPath = p;
          loadBrowser(p);
          return;
        }
        state.selectedPath = p;
        [...els.dbBrowserList.querySelectorAll('.browser-item')].forEach(x => x.classList.remove('selected'));
        btn.classList.add('selected');
        dblog('browse.select.file', { path: p });
      };
    });

    dblog('browse.result', { current_path: data.current_path, count: (data.items || []).length });
  } catch (err) {
    els.dbBrowserList.innerHTML = `<div class="small">Erreur : ${String(err.message || err)}</div>`;
    dblog('browse.error', { error: String(err.message || err) });
  }
}

async function confirmModalAction() {
  try {
    if (state.modalAction === 'create') {
      const name = document.getElementById('modalNewDbName')?.value?.trim();
      if (!name) throw new Error('Nom de fichier requis');
      const dir = state.browserPath || '/var/www/jarvis/database';
      const path = `${dir.replace(/\/+$/, '')}/${name}`;
      dblog('create.request', { path });
      const data = await api('create_db', { path });
      setActiveDb(data.path);
      els.dbActionOutput.textContent = JSON.stringify(data, null, 2);
      await refreshHealth();
      return;
    }
    if (state.modalAction === 'select') {
      if (!state.selectedPath) throw new Error('Choisis un fichier .db');
      setActiveDb(state.selectedPath);
      els.dbActionOutput.textContent = JSON.stringify({ ok: true, selected: state.selectedPath }, null, 2);
      dblog('select.active.saved', { path: state.selectedPath });
      await refreshHealth();
      return;
    }
    if (state.modalAction === 'delete') {
      if (!state.selectedPath) throw new Error('Choisis un fichier .db');
      dblog('delete.request', { path: state.selectedPath });
      const data = await api('delete_db', { path: state.selectedPath });
      if (state.activeDb === state.selectedPath) setActiveDb(DEFAULT_DB);
      els.dbActionOutput.textContent = JSON.stringify(data, null, 2);
      await refreshHealth();
      loadBrowser(state.browserPath);
      return;
    }
    if (state.modalAction === 'export') {
      window.location = `api.php?action=download_db&db_path=${encodeURIComponent(state.activeDb)}`;
      return;
    }
    if (state.modalAction === 'upload') {
      const file = document.getElementById('modalUploadFile')?.files?.[0];
      if (!file) throw new Error('Choisis un fichier local');
      els.dbActionOutput.textContent = JSON.stringify({
        info: 'Flux upload préparé',
        selected_remote_dir: state.browserPath,
        local_file: file.name,
      }, null, 2);
      dblog('upload.request.prepared', { remote_dir: state.browserPath, local_file: file.name });
      return;
    }
  } catch (err) {
    els.dbActionOutput.textContent = JSON.stringify({ error: String(err.message || err) }, null, 2);
    dblog('action.error', { action: state.modalAction, error: String(err.message || err) });
  }
}

window.addEventListener('load', () => {
  dblog('settings.load', { activeDb: state.activeDb });
  refreshHealth();

  els.createDb.onclick = (e) => openModal('create', e.currentTarget);
  els.selectDb.onclick = (e) => openModal('select', e.currentTarget);
  els.uploadDb.onclick = (e) => openModal('upload', e.currentTarget);
  els.exportDb.onclick = (e) => openModal('export', e.currentTarget);
  els.deleteDb.onclick = (e) => openModal('delete', e.currentTarget);
  els.dbActionConfirm.onclick = confirmModalAction;
  els.dbActionCancel.onclick = closeModal;
  els.dbModal.addEventListener('click', (e) => {
    if (e.target === els.dbModal) closeModal();
  });
});
