const endpointInput = document.getElementById('endpoint');
const payloadInput = document.getElementById('payload');
const statusEl = document.getElementById('status');
const responseEl = document.getElementById('response');
const sendBtn = document.getElementById('sendBtn');
const resetBtn = document.getElementById('resetBtn');

const STORAGE_ENDPOINT = 'jarvis_flow_test_endpoint';

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
    meta: { source: 'config-web-flow-test' },
  };
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

endpointInput.value = localStorage.getItem(STORAGE_ENDPOINT) || 'http://localhost:1880/jarvis/inbound';
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
