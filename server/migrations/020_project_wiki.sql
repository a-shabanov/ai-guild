create table wiki_pages (
  id bigserial primary key,
  project_id bigint not null references projects(id) on delete cascade,
  parent_id bigint,
  title text not null check (length(trim(title)) between 1 and 200),
  content text not null default '',
  revision integer not null default 1,
  created_by bigint references accounts(id) on delete set null,
  updated_by bigint references accounts(id) on delete set null,
  model text,
  effort text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, id),
  foreign key (project_id, parent_id) references wiki_pages(project_id, id),
  check (parent_id is distinct from id)
);
create index wiki_pages_tree on wiki_pages(project_id, parent_id);
