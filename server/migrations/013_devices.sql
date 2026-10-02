create table account_devices (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  installation_id uuid,
  name text not null,
  client_type text not null check (client_type in ('desktop_browser','mobile_browser','desktop_pwa','mobile_pwa','ios')),
  platform text not null check (platform in ('macos','windows','linux','ios','android','unknown')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  unique(account_id,installation_id)
);
alter table sessions add column device_id bigint references account_devices(id) on delete cascade;
create index sessions_device_idx on sessions(device_id);
alter table push_subscriptions add column device_id bigint references account_devices(id) on delete cascade;
alter table apns_devices add column device_id bigint references account_devices(id) on delete cascade;

-- Older sessions cannot safely be grouped into physical devices from a user agent.
-- Keep each as a separate legacy device until that client sends its installation id.
do $$
declare s record; d bigint;
begin
  for s in select existing.* from sessions existing join accounts a on a.id=existing.account_id
    where a.kind='human' and existing.expires_at>now()
  loop
    insert into account_devices(account_id,name,client_type,platform,created_at,last_used_at)
    values(s.account_id,'Ранее выполненный вход',
      case when s.user_agent ~* 'iPhone|iPad|Android|Mobile' then 'mobile_browser' else 'desktop_browser' end,
      case when s.user_agent ~* 'iPhone|iPad' then 'ios' when s.user_agent ~* 'Android' then 'android'
        when s.user_agent ~* 'Macintosh|Mac OS' then 'macos' when s.user_agent ~* 'Windows' then 'windows'
        when s.user_agent ~* 'Linux' then 'linux' else 'unknown' end,s.created_at,s.last_used_at) returning id into d;
    update sessions set device_id=d where id=s.id;
  end loop;
end $$;
