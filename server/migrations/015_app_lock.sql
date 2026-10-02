-- App passcodes protect a saved browser session, independently of its sign-in method.
alter table sessions add column app_passcode_hash text;
alter table sessions add column app_locked_at timestamptz;
alter table sessions add column app_biometric_unlock boolean not null default false;
alter table sessions add column app_passcode_attempts integer not null default 0;
alter table sessions add column app_passcode_retry_at timestamptz;
