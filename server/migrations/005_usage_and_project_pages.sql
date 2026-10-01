-- Prompt caching makes "input tokens" misleading on its own: most of what an agent
-- reads comes from the cache and is billed at a different rate.
alter table time_logs
  add column cache_read_tokens  bigint,
  add column cache_write_tokens bigint;

-- Project pages.
alter table projects
  add column color      text,
  add column logo_key   text,
  add column logo_mime  text,
  add column updated_at timestamptz not null default now();
