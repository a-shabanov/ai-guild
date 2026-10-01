-- Browser sessions: the web UI no longer keeps the API key in its cookie.
create table sessions (
  id           bigserial primary key,
  token_hash   text not null unique,
  account_id   bigint not null references accounts(id) on delete cascade,
  method       text not null check (method in ('key', 'passkey')),
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index sessions_account_idx on sessions(account_id);

create table passkeys (
  id            bigserial primary key,
  account_id    bigint not null references accounts(id) on delete cascade,
  credential_id text not null unique,
  public_key    bytea not null,
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  device_type   text not null,
  backed_up     boolean not null default false,
  name          text not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index passkeys_account_idx on passkeys(account_id);

create table push_subscriptions (
  id         bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index push_subscriptions_account_idx on push_subscriptions(account_id);

create table settings (
  key   text primary key,
  value jsonb not null
);
