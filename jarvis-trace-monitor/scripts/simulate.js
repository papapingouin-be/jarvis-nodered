const baseUrl = process.env.MONITOR_URL || 'http://localhost:4318';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postEvent(event) {
  const res = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event)
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Event rejected (${res.status}): ${body}`);
  }
}

async function run() {
  const trace = `demo-live-${Date.now()}`;
  const now = Date.now();
  const steps = [
    { event: 'flow_received', service: 'openwebui', summary: 'Requête utilisateur reçue', stage: 'ingress' },
    { event: 'routing_started', service: 'mcpo', summary: 'Routage MCP en cours', stage: 'routing' },
    { event: 'routing_finished', service: 'mcpo', summary: 'Routage terminé', stage: 'routing' },
    { event: 'tool_invocation_started', service: 'mcp_server', summary: 'Invocation du tool npm_service', stage: 'tool_execution', tool: 'npm_service' },
    { event: 'api_call_started', service: 'npm_service', summary: 'Appel API npm', stage: 'external_call', tool: 'npm_service' },
    { event: 'api_call_finished', service: 'npm_service', summary: 'Réponse npm reçue', stage: 'external_call', tool: 'npm_service', status: 'running' },
    { event: 'tool_invocation_finished', service: 'mcp_server', summary: 'Tool npm_service terminé', stage: 'tool_execution', tool: 'npm_service' },
    { event: 'flow_completed', service: 'mcpo', summary: 'Réponse envoyée à OpenWebUI', stage: 'response', status: 'completed' }
  ];

  for (let i = 0; i < steps.length; i += 1) {
    const item = steps[i];
    await postEvent({
      ts: new Date(now + i * 700).toISOString(),
      trace_id: trace,
      span_id: `step-${String(i + 1).padStart(2, '0')}`,
      parent_span_id: i > 0 ? `step-${String(i).padStart(2, '0')}` : null,
      level: 'info',
      intent: 'demo',
      status: item.status || 'running',
      details: { demo: true, index: i, duration_ms: 200 + i * 50 },
      ...item
    });
    console.log(`[simulate] ${item.event}`);
    await sleep(450);
  }

  console.log(`[simulate] trace envoyée: ${trace}`);
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
