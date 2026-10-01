-- 007 was edited after some databases had already applied its first version, which had
-- recorded_by only. This brings every database to the same shape.
alter table tasks
  add column if not exists recorded_by   bigint references accounts(id),
  add column if not exists original_text text;
alter table comments
  add column if not exists recorded_by   bigint references accounts(id),
  add column if not exists original_text text;
