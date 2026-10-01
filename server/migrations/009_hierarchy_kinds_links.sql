-- Hierarchy: epic > story > task > subtask. A parent is always of a higher level than its
-- children, which also rules out cycles. parent_id has existed since 001.
alter table tasks
  add column level text not null default 'task'
    check (level in ('epic', 'story', 'task', 'subtask')),
  add column kind text
    check (kind in ('visual', 'technical'));
create index tasks_parent_idx on tasks(parent_id);

-- Links between tasks other than parent/child. Stored once, in the direction it was stated:
-- "from blocks to", "from duplicates to"; "relates" has no direction.
create table task_links (
  id         bigserial primary key,
  from_task  bigint not null references tasks(id) on delete cascade,
  to_task    bigint not null references tasks(id) on delete cascade,
  type       text not null check (type in ('blocks', 'relates', 'duplicates')),
  created_by bigint not null references accounts(id),
  created_at timestamptz not null default now(),
  check (from_task <> to_task),
  unique (from_task, to_task, type)
);
create index task_links_to_idx on task_links(to_task);
