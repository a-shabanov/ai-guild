-- Projects used to exist only as a label on tasks; this lets one exist before its first task.
create table projects (
  id          bigserial primary key,
  name        text not null,
  description text not null default '',
  created_by  bigint references accounts(id),
  created_at  timestamptz not null default now()
);
create unique index projects_name_idx on projects(lower(name));

insert into projects(name)
select distinct on (lower(project)) project from tasks where project is not null
on conflict do nothing;
