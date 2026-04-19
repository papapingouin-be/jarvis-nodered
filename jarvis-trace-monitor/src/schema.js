const REQUIRED_FIELDS = ['ts', 'service', 'trace_id', 'event', 'summary'];

const KNOWN_EVENTS = new Set([
  'flow_received',
  'routing_started',
  'routing_finished',
  'tool_lookup_started',
  'tool_lookup_failed',
  'tool_invocation_started',
  'tool_invocation_finished',
  'script_started',
  'script_stdout',
  'script_stderr',
  'db_query_started',
  'db_query_finished',
  'api_call_started',
  'api_call_finished',
  'validation_error',
  'timeout',
  'flow_completed',
  'heartbeat'
]);

function isIsoDate(value) {
  return !Number.isNaN(Date.parse(value));
}

function validateEvent(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['Payload JSON invalide'] };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!payload[field]) {
      errors.push(`Champ obligatoire manquant: ${field}`);
    }
  }

  if (payload.ts && !isIsoDate(payload.ts)) {
    errors.push('ts doit être une date ISO valide');
  }

  const stringFields = ['service', 'trace_id', 'event', 'summary', 'level', 'span_id', 'parent_span_id', 'stage', 'tool', 'intent', 'status'];
  for (const field of stringFields) {
    if (payload[field] !== undefined && payload[field] !== null && typeof payload[field] !== 'string') {
      errors.push(`Champ ${field} doit être une chaîne`);
    }
  }

  if (payload.details !== undefined && (payload.details === null || typeof payload.details !== 'object' || Array.isArray(payload.details))) {
    errors.push('details doit être un objet JSON');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: payload.event && !KNOWN_EVENTS.has(payload.event) ? [`Type d'événement non répertorié: ${payload.event}`] : []
  };
}

module.exports = {
  KNOWN_EVENTS,
  REQUIRED_FIELDS,
  validateEvent
};
