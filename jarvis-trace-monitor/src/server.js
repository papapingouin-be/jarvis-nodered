const path = require('path');
const express = require('express');
const cors = require('cors');
const { validateEvent } = require('./schema');
const {
  ingestEvent,
  listFlows,
  getTraceEvents,
  getTimeline,
  getWaterfall,
  getServices,
  recentEvents,
  summarizeFlow
} = require('./traceService');

const app = express();
const port = Number(process.env.PORT || 4318);

function logStep(step, details) {
  const ts = new Date().toISOString();
  if (details === undefined) {
    console.log(`[jarvis-trace-monitor][${ts}] ${step}`);
    return;
  }
  console.log(`[jarvis-trace-monitor][${ts}] ${step}`, details);
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const sseClients = new Set();

function broadcast(event, payload) {
  logStep('Broadcast start', { event, clients: sseClients.size });
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    res.write(message);
  }
  logStep('Broadcast done', { event, clients: sseClients.size });
}

app.post('/api/events', (req, res) => {
  logStep('POST /api/events received', {
    trace_id: req.body?.trace_id,
    service: req.body?.service,
    event: req.body?.event
  });
  const validation = validateEvent(req.body);
  if (!validation.valid) {
    logStep('POST /api/events validation failed', { errors: validation.errors });
    return res.status(400).json({ ok: false, errors: validation.errors });
  }

  ingestEvent(req.body);
  logStep('POST /api/events ingested', {
    trace_id: req.body.trace_id,
    warnings: validation.warnings?.length || 0
  });
  broadcast('event_ingested', req.body);

  return res.status(202).json({
    ok: true,
    warnings: validation.warnings,
    trace_id: req.body.trace_id
  });
});

app.get('/api/flows', (req, res) => {
  logStep('GET /api/flows query', req.query);
  const { status, service, tool, q } = req.query;
  const flows = listFlows({ status, service, tool, q });
  logStep('GET /api/flows response', { total: flows.length });
  res.json({ items: flows, total: flows.length });
});

app.get('/api/flows/:traceId', (req, res) => {
  logStep('GET /api/flows/:traceId', { traceId: req.params.traceId });
  const events = getTraceEvents(req.params.traceId);
  if (!events.length) {
    logStep('GET /api/flows/:traceId not found', { traceId: req.params.traceId });
    return res.status(404).json({ ok: false, error: 'Trace introuvable' });
  }

  logStep('GET /api/flows/:traceId response', {
    traceId: req.params.traceId,
    events: events.length
  });
  res.json({ flow: summarizeFlow(events), events });
});

app.get('/api/flows/:traceId/timeline', (req, res) => {
  const items = getTimeline(req.params.traceId);
  logStep('GET /api/flows/:traceId/timeline response', {
    traceId: req.params.traceId,
    total: items.length
  });
  res.json({ items });
});

app.get('/api/flows/:traceId/waterfall', (req, res) => {
  const items = getWaterfall(req.params.traceId);
  logStep('GET /api/flows/:traceId/waterfall response', {
    traceId: req.params.traceId,
    total: items.length
  });
  res.json({ items });
});

app.get('/api/services', (req, res) => {
  const services = getServices();
  logStep('GET /api/services response', { total: services.length });
  res.json({ items: services, total: services.length });
});

app.get('/api/events/recent', (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  logStep('GET /api/events/recent response', { limit });
  res.json({ items: recentEvents(limit), total: limit });
});

app.get('/api/stream', (req, res) => {
  logStep('SSE client opening', {
    ip: req.ip,
    userAgent: req.headers['user-agent']
  });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write('event: ready\ndata: {"ok":true}\n\n');
  sseClients.add(res);
  logStep('SSE client connected', { clients: sseClients.size });

  req.on('close', () => {
    sseClients.delete(res);
    logStep('SSE client disconnected', { clients: sseClients.size });
  });
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'jarvis-trace-monitor' });
});

const server = app.listen(port, () => {
  logStep(`listening on http://localhost:${port}`);
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[jarvis-trace-monitor] received ${signal}, shutting down gracefully`);

  for (const res of sseClients) {
    res.end();
  }
  sseClients.clear();

  server.close((err) => {
    if (err) {
      console.error('[jarvis-trace-monitor] shutdown error:', err);
      process.exit(1);
      return;
    }
    process.exit(0);
  });

  setTimeout(() => {
    console.error('[jarvis-trace-monitor] force exit after shutdown timeout');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
