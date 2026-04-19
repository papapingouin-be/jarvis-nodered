function nanosToIso(value) {
  if (value === undefined || value === null) {
    return new Date().toISOString();
  }
  const asString = String(value);
  const nanos = Number(asString);
  if (Number.isNaN(nanos)) {
    return new Date().toISOString();
  }
  return new Date(Math.floor(nanos / 1e6)).toISOString();
}

function readAnyValue(anyValue) {
  if (!anyValue || typeof anyValue !== 'object') return null;
  if (anyValue.stringValue !== undefined) return anyValue.stringValue;
  if (anyValue.boolValue !== undefined) return anyValue.boolValue;
  if (anyValue.intValue !== undefined) return String(anyValue.intValue);
  if (anyValue.doubleValue !== undefined) return anyValue.doubleValue;
  if (Array.isArray(anyValue.arrayValue?.values)) {
    return anyValue.arrayValue.values.map(readAnyValue);
  }
  if (Array.isArray(anyValue.kvlistValue?.values)) {
    return Object.fromEntries(
      anyValue.kvlistValue.values.map((kv) => [kv.key, readAnyValue(kv.value)])
    );
  }
  return null;
}

function attrsToObject(attributes = []) {
  if (!Array.isArray(attributes)) return {};
  return Object.fromEntries(attributes.map((attr) => [attr.key, readAnyValue(attr.value)]));
}

function mapServiceName(resource) {
  const attrs = attrsToObject(resource?.attributes);
  return attrs['service.name'] || 'unknown-service';
}

function otlpJsonToEvents(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const resourceSpans = Array.isArray(payload.resourceSpans) ? payload.resourceSpans : [];
  const normalized = [];

  for (const resourceSpan of resourceSpans) {
    const service = mapServiceName(resourceSpan.resource);
    const scopeSpans = Array.isArray(resourceSpan.scopeSpans)
      ? resourceSpan.scopeSpans
      : Array.isArray(resourceSpan.instrumentationLibrarySpans)
        ? resourceSpan.instrumentationLibrarySpans
        : [];

    for (const scopeSpan of scopeSpans) {
      const spans = Array.isArray(scopeSpan.spans) ? scopeSpan.spans : [];
      for (const span of spans) {
        const details = attrsToObject(span.attributes);
        const traceId = span.traceId || span.trace_id;
        if (!traceId) continue;

        normalized.push({
          ts: nanosToIso(span.startTimeUnixNano),
          service,
          trace_id: traceId,
          span_id: span.spanId || null,
          parent_span_id: span.parentSpanId || null,
          event: 'otlp_span_started',
          stage: 'otlp',
          status: 'running',
          summary: span.name || 'Span OTLP démarré',
          details
        });

        normalized.push({
          ts: nanosToIso(span.endTimeUnixNano || span.startTimeUnixNano),
          service,
          trace_id: traceId,
          span_id: span.spanId || null,
          parent_span_id: span.parentSpanId || null,
          event: 'otlp_span_finished',
          stage: 'otlp',
          status: span.status?.code === 2 ? 'error' : 'completed',
          summary: span.name ? `Span OTLP terminé: ${span.name}` : 'Span OTLP terminé',
          details: {
            ...details,
            status_code: span.status?.code,
            status_message: span.status?.message
          }
        });

        const events = Array.isArray(span.events) ? span.events : [];
        for (const event of events) {
          normalized.push({
            ts: nanosToIso(event.timeUnixNano || span.startTimeUnixNano),
            service,
            trace_id: traceId,
            span_id: span.spanId || null,
            parent_span_id: span.parentSpanId || null,
            event: `otlp_event_${event.name || 'event'}`,
            stage: 'otlp',
            status: 'running',
            summary: event.name || 'Événement OTLP',
            details: attrsToObject(event.attributes)
          });
        }
      }
    }
  }

  return normalized;
}

module.exports = {
  otlpJsonToEvents
};
