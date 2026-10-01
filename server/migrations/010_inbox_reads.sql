-- What an account has read task by task, next to the cursor that acknowledges everything.
create table inbox_reads (
  account_id integer not null references accounts(id) on delete cascade,
  task_id    integer not null references tasks(id) on delete cascade,
  up_to      bigint  not null,
  primary key (account_id, task_id)
);
