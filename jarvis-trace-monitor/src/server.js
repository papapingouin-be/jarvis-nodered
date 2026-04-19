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

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const sseClients = new Set();

function broadcast(event, payload) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    res.write(message);
  }
}

app.post('/api/events', (req, res) => {
  const validation = validateEvent(req.body);
  if (!validation.valid) {
    return res.status(400).json({ ok: false, errors: validation.errors });
  }

  ingestEvent(req.body);
  broadcast('event_ingested', req.body);

  return res.status(202).json({
    ok: true,
    warnings: validation.warnings,
    trace_id: req.body.trace_id
  });
});

app.get('/api/flows', (req, res) => {
  const { status, service, tool, q } = req.query;
  const flows = listFlows({ status, service, tool, q });
  res.json({ items: flows, total: flows.length });
});

app.get('/api/flows/:traceId', (req, res) => {
  const events = getTraceEvents(req.params.traceId);
  if (!events.length) {
    return res.status(404).json({ ok: false, error: 'Trace introuvable' });
  }

  res.json({ flow: summarizeFlow(events), events });
});

app.get('/api/flows/:traceId/timeline', (req, res) => {
  res.json({ items: getTimeline(req.params.traceId) });
});

app.get('/api/flows/:traceId/waterfall', (req, res) => {
  res.json({ items: getWaterfall(req.params.traceId) });
});

app.get('/api/services', (req, res) => {
  const services = getServices();
  res.json({ items: services, total: services.length });
});

app.get('/api/events/recent', (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  res.json({ items: recentEvents(limit), total: limit });
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write('event: ready\ndata: {"ok":true}\n\n');
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'jarvis-trace-monitor' });
});

app.listen(port, () => {
  console.log(`[jarvis-trace-monitor] listening on http://localhost:${port}`);
});
