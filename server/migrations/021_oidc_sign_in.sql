-- A provider set by configuration: corporate SSO on a self-hosted install, or the sign-in of a service around it.
alter table sessions drop constraint sessions_method_check;
alter table sessions add constraint sessions_method_check
  check (method in ('key', 'passkey', 'google', 'telegram', 'oidc'));
alter table two_factor_logins drop constraint two_factor_logins_method_check;
alter table two_factor_logins add constraint two_factor_logins_method_check
  check (method in ('key', 'passkey', 'google', 'telegram', 'oidc'));
alter table account_identities drop constraint account_identities_provider_check;
alter table account_identities add constraint account_identities_provider_check
  check (provider in ('google', 'telegram', 'oidc'));
alter table auth_flows drop constraint auth_flows_provider_check;
alter table auth_flows add constraint auth_flows_provider_check
  check (provider in ('google', 'telegram', 'oidc'));
alter table auth_exchanges drop constraint auth_exchanges_provider_check;
alter table auth_exchanges add constraint auth_exchanges_provider_check
  check (provider in ('google', 'telegram', 'oidc'));
