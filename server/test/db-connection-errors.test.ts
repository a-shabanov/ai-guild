// Postgres restarting or dropping a connection must not take the application down with it.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const database = new URL('postgres://aitracker:aitracker@127.0.0.1:5433/aitracker_db_errors_test');
process.env.DATABASE_URL = database.href;
const db = await import('../src/db.ts');

const maintenance = new URL(database);
maintenance.pathname = '/postgres';
let admin: pg.Client;

const terminate = (pid: number) => admin.query('select pg_terminate_backend($1)', [pid]);
/** The error reaches the client as a socket event, a moment after the backend is gone. */
const settled = () => new Promise((r) => setTimeout(r, 200));

before(async () => {
  admin = new pg.Client({ connectionString: maintenance.href });
  await admin.connect();
  await admin.query('drop database if exists aitracker_db_errors_test with (force)');
  await admin.query('create database aitracker_db_errors_test');
});

after(async () => {
  await db.pool.end();
  await admin.end();
});

test('losing an idle connection does not crash the process', async () => {
  const { pid } = (await db.q1<{ pid: number }>('select pg_backend_pid() as pid'))!;
  await terminate(pid);
  await settled();
  const after = await db.q1<{ pid: number }>('select pg_backend_pid() as pid');
  assert.notEqual(after!.pid, pid, 'the pool opened a new connection');
});

test('losing a connection between two queries of a transaction does not crash the process', async () => {
  const client = await db.pool.connect();
  const { pid } = (await client.query('select pg_backend_pid() as pid')).rows[0];
  await client.query('begin');
  await terminate(pid);
  await settled();
  await assert.rejects(client.query('select 1'));
  await assert.rejects(client.query('rollback'));
  client.release();
  const after = await db.q1<{ pid: number }>('select pg_backend_pid() as pid');
  assert.notEqual(after!.pid, pid, 'the dead connection did not go back into the pool');
});

test('losing a connection in the middle of a query fails only that query', async () => {
  const client = await db.pool.connect();
  const { pid } = (await client.query('select pg_backend_pid() as pid')).rows[0];
  const failure = assert.rejects(client.query('select pg_sleep(10)'));
  await settled();
  await terminate(pid);
  await failure;
  await settled();
  client.release();
  assert.equal((await db.q1('select 1 as ok'))!.ok, 1);
});

test('losing a connection under pool.query fails only that query', async () => {
  const failure = assert.rejects(db.q('select pg_sleep(10)'));
  let busy: pg.QueryResult;
  do {
    await settled(); // the query needs a moment to appear, more so when other test files are running
    busy = await admin.query(
      `select pid from pg_stat_activity where datname = 'aitracker_db_errors_test' and query = 'select pg_sleep(10)' and state = 'active'`,
    );
  } while (!busy.rows.length);
  await terminate(busy.rows[0].pid);
  await failure;
  await settled();
  assert.equal((await db.q1('select 1 as ok'))!.ok, 1);
});
