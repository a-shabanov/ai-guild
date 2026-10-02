alter table sessions add column two_factor_at timestamptz;
alter table accounts add column two_factor_failures integer not null default 0;
alter table accounts add column two_factor_locked_until timestamptz;
alter table accounts add column two_factor_sent_at timestamptz;
alter table accounts add column two_factor_send_window timestamptz;
alter table accounts add column two_factor_send_count integer not null default 0;

create table account_second_factors (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  channel text not null check (channel in ('email','telegram')),
  destination text not null,
  created_at timestamptz not null default now(),
  unique(account_id, channel)
);
create table two_factor_logins (
  token_hash text primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  method text not null check (method in ('key','passkey','google','telegram')),
  identity_id bigint references account_identities(id) on delete cascade,
  passkey_id bigint references passkeys(id) on delete cascade,
  key_hash text,
  expires_at timestamptz not null default now() + interval '10 minutes'
);
create table two_factor_codes (
  token_hash text primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  purpose text not null check (purpose in ('login','enroll')),
  login_hash text references two_factor_logins(token_hash) on delete cascade,
  session_hash text,
  factor_id bigint references account_second_factors(id) on delete cascade,
  channel text not null check (channel in ('email','telegram')),
  destination text not null,
  code_hash text not null,
  expires_at timestamptz not null default now() + interval '5 minutes'
);
create index two_factor_codes_account_idx on two_factor_codes(account_id);
