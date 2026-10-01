alter table sessions drop constraint sessions_method_check;
alter table sessions add constraint sessions_method_check
  check (method in ('key', 'passkey', 'google', 'telegram'));

create table account_identities (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  provider text not null check (provider in ('google', 'telegram')),
  subject text not null,
  label text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (provider, subject),
  unique (account_id, provider)
);
alter table sessions add column identity_id bigint references account_identities(id) on delete cascade;

-- Flows survive restarts and can be consumed only once, across server processes.
create table account_invitations (
  id bigserial primary key,
  account_id bigint not null unique references accounts(id) on delete cascade,
  token_hash text not null unique,
  created_by bigint not null references accounts(id),
  expires_at timestamptz not null default now() + interval '24 hours',
  used_at timestamptz
);

create table auth_flows (
  state_hash text primary key,
  provider text not null check (provider in ('google', 'telegram')),
  browser_hash text,
  ticket_hash text unique,
  verifier text not null,
  nonce text not null,
  account_id bigint references accounts(id) on delete cascade,
  invitation_id bigint references account_invitations(id) on delete cascade,
  link_credential_hash text,
  native_challenge text,
  expires_at timestamptz not null default now() + interval '10 minutes'
);

create table auth_exchanges (
  code_hash text primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  provider text not null check (provider in ('google', 'telegram')),
  identity_id bigint not null references account_identities(id) on delete cascade,
  challenge text not null,
  linking boolean not null,
  expires_at timestamptz not null default now() + interval '1 minute'
);
