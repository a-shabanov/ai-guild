-- Several models can work on one task at the same time, also under one account
-- (an agent and its sub-agents), so each stretch of work is its own entry and any
-- number of them may be running.
drop index time_logs_running_idx;
create index time_logs_running_idx on time_logs(task_id, account_id) where ended_at is null;

-- Tells parallel entries apart: "main session", "sub-agent: tests", a session id.
alter table time_logs add column worker text;
