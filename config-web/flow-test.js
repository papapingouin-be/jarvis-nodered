const endpointInput = document.getElementById('endpoint');
const dbPathInput = document.getElementById('dbPath');
const useDbRunnerInput = document.getElementById('useDbRunnerUrl');
const payloadInput = document.getElementById('payload');
const statusEl = document.getElementById('status');
const responseEl = document.getElementById('response');
const sendBtn = document.getElementById('sendBtn');
const resetBtn = document.getElementById('resetBtn');

const STORAGE_ENDPOINT = 'jarvis_flow_test_endpoint';
const STORAGE_DB_PATH = 'jarvis_db_path';
const STORAGE_USE_DB_RUNNER = 'jarvis_flow_test_use_db_runner_url';
const DEFAULT_TOOLBOX_RUNNER_PORT = '8030';

function defaultPayload() {
  return {
    channel: 'openwebui',
    user_id: 'demo-user',
    conversation_id: `conv-${Date.now()}`,
    message_id: `msg-${Date.now()}`,
    text: 'Fais un test du flux de base',
    attachments: [],
    timestamp: new Date().toISOString(),
    reply_policy: 'same_channel',
    meta: {
      source: 'config-web-flow-test',
      toolbox_runner_url: `http://localhost:${DEFAULT_TOOLBOX_RUNNER_PORT}`,
    },
  };
}

function inferToolboxRunnerUrl(endpoint) {
  try {
    const endpointUrl = new URL(endpoint);
    return `${endpointUrl.protocol}//${endpointUrl.hostname}:${DEFAULT_TOOLBOX_RUNNER_PORT}`;
  } catch {
    return `http://localhost:${DEFAULT_TOOLBOX_RUNNER_PORT}`;
  }
}

function setStatus(message, ok = true) {
  statusEl.className = `status ${ok ? 'ok' : 'err'}`;
  statusEl.textContent = message;
}

function formatJson(data) {
  return JSON.stringify(data, null, 2);
}

function resetPayload() {
  payloadInput.value = formatJson(defaultPayload());
  responseEl.textContent = 'Aucune requête envoyée.';
  setStatus('Payload réinitialisé.');
}

async function api(action, payload = {}) {
  const res = await fetch('api.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, db_path: dbPathInput.value.trim(), ...payload }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

async function loadRunnerUrlFromDb() {
  const data = await api('get_sensitive', {
    namespace: 'runtime',
    key: 'TOOLBOX_RUNNER_URL',
  });
  return data.item?.value?.trim() || '';
}

endpointInput.value = localStorage.getItem(STORAGE_ENDPOINT) || 'http://localhost:1880/jarvis/inbound';
dbPathInput.value = localStorage.getItem(STORAGE_DB_PATH) || '';
useDbRunnerInput.checked = localStorage.getItem(STORAGE_USE_DB_RUNNER) !== '0';
resetPayload();

sendBtn.onclick = async () => {
  try {
    const endpoint = endpointInput.value.trim();
    if (!endpoint) {
      throw new Error("L'endpoint Node-RED est requis.");
    }

    let payload;
    try {
      payload = JSON.parse(payloadInput.value);
    } catch {
      throw new Error('Le JSON du message est invalide.');
    }

    if (!payload.meta || typeof payload.meta !== 'object') {
      payload.meta = {};
    }

    if (!payload.meta.toolbox_runner_url) {
      payload.meta.toolbox_runner_url = inferToolboxRunnerUrl(endpoint);
    }

    localStorage.setItem(STORAGE_DB_PATH, dbPathInput.value.trim());
    localStorage.setItem(STORAGE_USE_DB_RUNNER, useDbRunnerInput.checked ? '1' : '0');

    if (useDbRunnerInput.checked) {
      const dbRunnerUrl = await loadRunnerUrlFromDb();
      if (dbRunnerUrl) {
        payload.meta.toolbox_runner_url = dbRunnerUrl;
      } else {
        setStatus("Aucune URL trouvée en DB (runtime/TOOLBOX_RUNNER_URL), fallback sur meta.toolbox_runner_url.", false);
      }
    }

    localStorage.setItem(STORAGE_ENDPOINT, endpoint);
    setStatus('Envoi en cours...');

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const contentType = res.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await res.json() : await res.text();

    responseEl.textContent = typeof body === 'string' ? body : formatJson(body);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    setStatus(`Test réussi (HTTP ${res.status}).`);
  } catch (error) {
    setStatus(error.message || 'Erreur inconnue', false);
  }
};

resetBtn.onclick = resetPayload;
