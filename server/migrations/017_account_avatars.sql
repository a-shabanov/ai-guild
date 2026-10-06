-- Custom avatars per account (bundled system presets stay in public/avatars/).
alter table accounts
  add column avatar_key  text,
  add column avatar_mime text;
