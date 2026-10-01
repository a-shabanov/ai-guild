-- Devices of the native iOS app that receive pushes through Apple's APNs.
create table apns_devices (
  id          bigserial primary key,
  account_id  bigint not null references accounts(id) on delete cascade,
  token       text not null unique,
  environment text not null check (environment in ('sandbox', 'production')),
  created_at  timestamptz not null default now()
);
create index apns_devices_account_idx on apns_devices(account_id);
