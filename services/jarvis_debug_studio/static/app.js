async function loadTraces() {
  const response = await fetch('/api/traces');
  const data = await response.json();
  const list = document.getElementById('trace-list');
  list.innerHTML = '';
  for (const item of data.items) {
    const li = document.createElement('li');
    li.textContent = `${item.trace_id} · ${item.tool} · ${item.events} events`;
    li.onclick = () => loadTrace(item.trace_id);
    list.appendChild(li);
  }
}

function toCell(value) {
  const pre = document.createElement('pre');
  pre.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return pre;
}

async function loadTrace(traceId) {
  const response = await fetch(`/api/traces/${encodeURIComponent(traceId)}`);
  const data = await response.json();
  document.getElementById('trace-title').textContent = `Trace ${data.trace_id}`;
  document.getElementById('trace-meta').textContent = `tool: ${data.tool}`;

  const tbody = document.getElementById('trace-events');
  tbody.innerHTML = '';

  for (const event of data.events) {
    const payload = event.payload || {};
    const row = document.createElement('tr');
    const values = [
      event.stage,
      payload.handler || '',
      payload.code_preview || '',
      payload.stdout || '',
      payload.stderr || '',
      payload.raw_output || '',
      event.duration_ms ?? '',
      event.has_error ? 'yes' : '',
    ];

    for (const value of values) {
      const td = document.createElement('td');
      td.appendChild(toCell(value));
      row.appendChild(td);
    }
    tbody.appendChild(row);
  }
}

document.getElementById('refresh-btn').onclick = loadTraces;
loadTraces();
