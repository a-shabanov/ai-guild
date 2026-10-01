create table accounts (
  id          bigserial primary key,
  name        text not null,
  kind        text not null check (kind in ('human', 'agent')),
  system      text,
  role        text not null default 'member' check (role in ('admin', 'member')),
  key_hash    text not null unique,
  key_prefix  text not null,
  disabled    boolean not null default false,
  inbox_cursor bigint not null default 0,
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz
);
-- Names are looked up case-insensitively (@mentions, assignee), so they must be unique that way too.
create unique index accounts_name_idx on accounts(lower(name));

create table tasks (
  id           bigserial primary key,
  title        text not null,
  description  text not null default '',
  status       text not null default 'todo'
               check (status in ('todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled')),
  priority     text not null default 'normal'
               check (priority in ('low', 'normal', 'high', 'urgent')),
  project      text,
  labels       text[] not null default '{}',
  parent_id    bigint references tasks(id) on delete set null,
  created_by   bigint not null references accounts(id),
  assignee_id  bigint references accounts(id),
  model        text,
  effort       text,
  result       text,
  result_by    bigint references accounts(id),
  result_model text,
  result_effort text,
  result_at    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  started_at   timestamptz,
  completed_at timestamptz
);
create index tasks_status_idx on tasks(status);
create index tasks_assignee_idx on tasks(assignee_id);
create index tasks_project_idx on tasks(project);

create table comments (
  id         bigserial primary key,
  task_id    bigint not null references tasks(id) on delete cascade,
  author_id  bigint not null references accounts(id),
  body       text not null,
  model      text,
  effort     text,
  created_at timestamptz not null default now()
);
create index comments_task_idx on comments(task_id);

-- A row with ended_at/seconds null is a running timer.
create table time_logs (
  id            bigserial primary key,
  task_id       bigint not null references tasks(id) on delete cascade,
  account_id    bigint not null references accounts(id),
  model         text,
  effort        text,
  seconds       integer check (seconds is null or seconds >= 0),
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  note          text,
  input_tokens  bigint,
  output_tokens bigint,
  cost_usd      numeric(12, 4),
  created_at    timestamptz not null default now()
);
create index time_logs_task_idx on time_logs(task_id);
create index time_logs_started_idx on time_logs(started_at);
create unique index time_logs_running_idx on time_logs(task_id, account_id) where ended_at is null;

create table attachments (
  id           bigserial primary key,
  task_id      bigint not null references tasks(id) on delete cascade,
  comment_id   bigint references comments(id) on delete set null,
  account_id   bigint not null references accounts(id),
  filename     text not null,
  mime         text not null,
  size         bigint not null,
  kind         text not null check (kind in ('image', 'video', 'log', 'file')),
  storage_key  text not null unique,
  created_at   timestamptz not null default now()
);
create index attachments_task_idx on attachments(task_id);

create table events (
  id         bigserial primary key,
  task_id    bigint not null references tasks(id) on delete cascade,
  actor_id   bigint not null references accounts(id),
  type       text not null,
  data       jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index events_task_idx on events(task_id);
