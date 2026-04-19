const db = require('./db');

const terminalEvents = new Set(['flow_completed', 'timeout', 'validation_error', 'tool_lookup_failed']);
const slowThresholdMs = Number(process.env.SLOW_THRESHOLD_MS || 4000);
const serviceSilentThresholdMs = Number(process.env.SERVICE_SILENT_THRESHOLD_MS || 30000);

const insertStmt = db.prepare(`
INSERT INTO events (
  ts, service, level, trace_id, span_id, parent_span_id, event, stage, tool, intent, status, summary, details_json
)
VALUES (
  @ts, @service, @level, @trace_id, @span_id, @parent_span_id, @event, @stage, @tool, @intent, @status, @summary, @details_json
)
`);

function normalizeRow(row) {
  return {
    id: row.id,
    ts: row.ts,
    service: row.service,
    level: row.level,
    trace_id: row.trace_id,
    span_id: row.span_id,
    parent_span_id: row.parent_span_id,
    event: row.event,
    stage: row.stage,
    tool: row.tool,
    intent: row.intent,
    status: row.status,
    summary: row.summary,
    details: row.details_json ? JSON.parse(row.details_json) : {}
  };
}

function ingestEvent(event) {
  insertStmt.run({
    ts: event.ts,
    service: event.service,
    level: event.level || 'info',
    trace_id: event.trace_id,
    span_id: event.span_id || null,
    parent_span_id: event.parent_span_id || null,
    event: event.event,
    stage: event.stage || null,
    tool: event.tool || null,
    intent: event.intent || null,
    status: event.status || null,
    summary: event.summary,
    details_json: JSON.stringify(event.details || {})
  });
}

function getTraceEvents(traceId) {
  return db.prepare('SELECT * FROM events WHERE trace_id = ? ORDER BY ts ASC, id ASC').all(traceId).map(normalizeRow);
}

function computeFlowStatus(events) {
  if (events.length === 0) return 'unknown';

  const last = events[events.length - 1];

  if (events.some((evt) => evt.event === 'timeout')) return 'timeout';
  if (events.some((evt) => ['validation_error', 'tool_lookup_failed'].includes(evt.event))) return 'error';
  if (last.event === 'flow_completed' || last.status === 'completed') return 'completed';
  if (last.status) return last.status;
  if (['routing_started', 'tool_lookup_started', 'tool_invocation_started', 'script_started', 'db_query_started', 'api_call_started'].includes(last.event)) {
    return 'running';
  }

  return 'received';
}

function synthesizeInsights(events) {
  if (!events.length) return ['Aucun événement reçu pour cette trace'];

  const insights = [];
  const services = [...new Set(events.map((evt) => evt.service))];

  if (services.includes('mcpo') && services.some((svc) => svc.includes('mcp'))) {
    insights.push('Le flux a bien atteint MCPO puis le MCP Server.');
  }

  const runningTool = events.findLast((evt) => evt.event === 'tool_invocation_started');
  const finishedTool = events.findLast((evt) => evt.event === 'tool_invocation_finished');
  if (runningTool && !finishedTool) {
    insights.push('Le tool a démarré mais aucune fin n’a été reçue.');
  }

  if (events.some((evt) => evt.event === 'validation_error')) {
    insights.push('Une erreur de validation est survenue avant exécution.');
  }

  const lookupStart = events.find((evt) => evt.event === 'tool_lookup_started');
  if (lookupStart && runningTool) {
    const gap = new Date(runningTool.ts).getTime() - new Date(lookupStart.ts).getTime();
    if (gap > slowThresholdMs) {
      insights.push('Le flux semble bloqué entre la sélection du tool et son exécution.');
    }
  }

  const last = events[events.length - 1];
  const sinceLast = Date.now() - new Date(last.ts).getTime();
  if (!terminalEvents.has(last.event) && sinceLast > serviceSilentThresholdMs) {
    insights.push(`Le flux est silencieux depuis ${Math.round(sinceLast / 1000)} secondes.`);
  }

  if (!insights.length) {
    insights.push('Flux cohérent: la séquence événementielle est exploitable et corrélée.');
  }

  return insights;
}

function summarizeFlow(events) {
  if (!events.length) return null;

  const first = events[0];
  const last = events[events.length - 1];
  const durationMs = new Date(last.ts).getTime() - new Date(first.ts).getTime();
  const status = computeFlowStatus(events);

  return {
    trace_id: first.trace_id,
    status,
    start_ts: first.ts,
    last_ts: last.ts,
    duration_ms: Math.max(durationMs, 0),
    entry_service: first.service,
    current_service: last.service,
    tool: events.findLast((evt) => evt.tool)?.tool || null,
    last_summary: last.summary,
    has_error: status === 'error' || status === 'timeout',
    events_count: events.length,
    insights: synthesizeInsights(events)
  };
}

function listFlows(filters = {}) {
  const rows = db.prepare('SELECT DISTINCT trace_id FROM events ORDER BY trace_id DESC').all();

  const flows = rows
    .map(({ trace_id }) => summarizeFlow(getTraceEvents(trace_id)))
    .filter(Boolean)
    .filter((flow) => {
      if (filters.status && flow.status !== filters.status) return false;
      if (filters.service && flow.current_service !== filters.service && flow.entry_service !== filters.service) return false;
      if (filters.tool && flow.tool !== filters.tool) return false;
      if (filters.q) {
        const haystack = `${flow.trace_id} ${flow.last_summary} ${flow.entry_service} ${flow.current_service} ${flow.tool || ''}`.toLowerCase();
        if (!haystack.includes(filters.q.toLowerCase())) return false;
      }
      return true;
    })
    .sort((a, b) => new Date(b.last_ts).getTime() - new Date(a.last_ts).getTime());

  return flows;
}

function getTimeline(traceId) {
  const events = getTraceEvents(traceId);
  return events.map((event, idx) => {
    const prev = idx > 0 ? events[idx - 1] : null;
    const gapMs = prev ? Math.max(0, new Date(event.ts).getTime() - new Date(prev.ts).getTime()) : 0;

    return {
      ...event,
      index: idx,
      gap_from_prev_ms: gapMs
    };
  });
}

function getWaterfall(traceId) {
  const events = getTraceEvents(traceId);
  if (!events.length) return [];

  const spans = new Map();
  for (const event of events) {
    const key = event.span_id || `${event.service}:${event.event}:${event.ts}`;
    if (!spans.has(key)) {
      spans.set(key, {
        key,
        span_id: event.span_id,
        parent_span_id: event.parent_span_id,
        service: event.service,
        stage: event.stage,
        tool: event.tool,
        label: `${event.service}${event.stage ? ` → ${event.stage}` : ''}`,
        start_ts: event.ts,
        end_ts: event.ts,
        start_event: event.event,
        end_event: event.event,
        status: event.status || 'running',
        summaries: [event.summary]
      });
    } else {
      const span = spans.get(key);
      if (new Date(event.ts).getTime() < new Date(span.start_ts).getTime()) {
        span.start_ts = event.ts;
        span.start_event = event.event;
      }
      if (new Date(event.ts).getTime() >= new Date(span.end_ts).getTime()) {
        span.end_ts = event.ts;
        span.end_event = event.event;
        span.status = event.status || span.status;
      }
      span.summaries.push(event.summary);
    }
  }

  return [...spans.values()]
    .map((span) => ({
      ...span,
      duration_ms: Math.max(0, new Date(span.end_ts).getTime() - new Date(span.start_ts).getTime())
    }))
    .sort((a, b) => new Date(a.start_ts).getTime() - new Date(b.start_ts).getTime());
}

function getServices() {
  const services = db.prepare('SELECT DISTINCT service FROM events').all().map((r) => r.service);
  const now = Date.now();

  return services.map((service) => {
    const recentEvents = db
      .prepare(`SELECT * FROM events WHERE service = ? AND ts >= datetime('now', '-10 minutes') ORDER BY ts DESC`)
      .all(service)
      .map(normalizeRow);

    const last = db.prepare('SELECT * FROM events WHERE service = ? ORDER BY ts DESC LIMIT 1').get(service);
    const normalizedLast = last ? normalizeRow(last) : null;

    const errorsRecent = recentEvents.filter((evt) => evt.event.includes('error') || evt.level === 'error' || evt.status === 'error').length;
    const durations = recentEvents
      .filter((evt) => typeof evt.details?.duration_ms === 'number')
      .map((evt) => evt.details.duration_ms);

    const avgLatency = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
    const silentFor = normalizedLast ? now - new Date(normalizedLast.ts).getTime() : null;

    let health = 'healthy';
    if (errorsRecent > 0) health = 'error';
    else if (silentFor && silentFor > serviceSilentThresholdMs) health = 'silent';
    else if (avgLatency && avgLatency > slowThresholdMs) health = 'warning';

    return {
      service,
      last_event: normalizedLast,
      last_activity_ts: normalizedLast?.ts || null,
      recent_event_count: recentEvents.length,
      recent_error_count: errorsRecent,
      avg_latency_ms: avgLatency,
      health
    };
  });
}

function recentEvents(limit = 100) {
  return db.prepare('SELECT * FROM events ORDER BY ts DESC, id DESC LIMIT ?').all(limit).map(normalizeRow);
}

function getMonitorStatus(meta = {}) {
  const startedAt = meta.startedAt || Date.now();
  const now = Date.now();
  const totalEvents = db.prepare('SELECT COUNT(*) AS total FROM events').get().total;
  const totalTraces = db.prepare('SELECT COUNT(DISTINCT trace_id) AS total FROM events').get().total;
  const runningFlows = listFlows({ status: 'running' }).length;
  const lastRow = db.prepare('SELECT * FROM events ORDER BY ts DESC, id DESC LIMIT 1').get();
  const lastEvent = lastRow ? normalizeRow(lastRow) : null;
  const sinceLastMs = lastEvent ? Math.max(0, now - new Date(lastEvent.ts).getTime()) : null;

  return {
    engine: {
      running: true,
      started_at: new Date(startedAt).toISOString(),
      uptime_ms: Math.max(0, now - startedAt)
    },
    stream: {
      sse_clients: Number(meta.sseClients || 0)
    },
    events: {
      total: totalEvents,
      traces_total: totalTraces,
      running_flows: runningFlows,
      last_event_ts: lastEvent?.ts || null,
      since_last_event_ms: sinceLastMs
    }
  };
}

module.exports = {
  ingestEvent,
  listFlows,
  getTraceEvents,
  getTimeline,
  getWaterfall,
  getServices,
  recentEvents,
  summarizeFlow,
  getMonitorStatus
};
