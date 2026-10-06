-- Keep account IDs for task authorship, comments and analytics after removal.
alter table accounts add column deleted_at timestamptz;
alter table accounts add constraint deleted_accounts_disabled
  check (deleted_at is null or disabled);
