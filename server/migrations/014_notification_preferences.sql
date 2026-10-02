create table notification_preferences (
  account_id bigint primary key references accounts(id) on delete cascade,
  preferences jsonb not null default '{}' check (jsonb_typeof(preferences) = 'object')
);
