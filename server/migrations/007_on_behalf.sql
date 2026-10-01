-- What a person asked for in a chat with an agent, written down by that agent under the
-- person's name. The author stays the person; recorded_by keeps who wrote it down, and
-- original_text keeps the person's own words next to the agent's cleaned-up wording.
alter table tasks
  add column recorded_by   bigint references accounts(id),
  add column original_text text;
alter table comments
  add column recorded_by   bigint references accounts(id),
  add column original_text text;
