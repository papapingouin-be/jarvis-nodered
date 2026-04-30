CREATE TABLE IF NOT EXISTS http_requests (
  id bigserial primary key,
  request_id text not null,
  trace_id text,
  ts timestamptz default now(),
  service text not null default 'jarvis-engine',
  source_ip text,
  method text,
  path text,
  query_string text,
  status_code int,
  duration_ms numeric,
  user_agent text,
  request_headers_json jsonb,
  request_body_json jsonb,
  response_body_json jsonb,
  error_text text
);

CREATE TABLE IF NOT EXISTS traces (
  trace_id text primary key,
  request_id text,
  source text,
  tool_name text,
  intent text,
  status text,
  input_json jsonb,
  output_json jsonb,
  error_text text,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms numeric
);

CREATE TABLE IF NOT EXISTS trace_events (
  id bigserial primary key,
  trace_id text,
  request_id text,
  ts timestamptz default now(),
  service text,
  step text,
  event_type text,
  status text,
  input_json jsonb,
  output_json jsonb,
  error_text text,
  duration_ms numeric
);

CREATE TABLE IF NOT EXISTS service_logs (
  id bigserial primary key,
  ts timestamptz default now(),
  service text,
  level text,
  message text,
  trace_id text,
  request_id text,
  data_json jsonb
);
