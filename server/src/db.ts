import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { currentScope } from './scope.ts';

// bigint and numeric come back as strings by default; ids and sums here fit in a double.
pg.types.setTypeParser(20, Number);
pg.types.setTypeParser(1700, Number);

const connections = new pg.Pool({
  connectionString: config.databaseUrl,
  ...(config.db.poolMax && { max: config.db.poolMax }),
  ...(config.db.maxLifetimeSeconds && { maxLifetimeSeconds: config.db.maxLifetimeSeconds }),
  // No schema to fall back on: SQL that reaches the database without one fails.
  ...(config.db.scoped && { options: '-c search_path=' }),
});

// Postgres going away must fail the requests in flight, not the whole process. An error event
// with no listener is fatal in Node: idle connections report to the pool, and connections
// checked out with pool.connect() report only to themselves. The pool drops dead ones on release.
connections.on('error', () => {});
connections.on('connect', (client) => {
  client.on('error', (err) => console.error('postgres connection lost:', err.message));
});

const SCHEMA_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const schemaInUse = (): string => currentScope()?.dbSchema ?? config.db.schema;

/** Keeps one schema from taking every connection of the shared pool. Waiters queue in memory. */
const schemaSlots = new Map<string, { busy: number; waiting: (() => void)[] }>();
async function takeSlot(schema: string, limit: number): Promise<() => void> {
  let slot = schemaSlots.get(schema);
  if (!slot) schemaSlots.set(schema, (slot = { busy: 0, waiting: [] }));
  const own = slot;
  if (own.busy >= limit) await new Promise<void>((resolve) => own.waiting.push(resolve));
  else own.busy++;
  return () => {
    const next = own.waiting.shift();
    if (next) next(); // the slot passes straight on
    else own.busy--;
  };
}

type ScopedClient = pg.PoolClient & { schema?: string };

async function checkout(): Promise<pg.PoolClient> {
  const schema = schemaInUse();
  if (schema && !SCHEMA_NAME.test(schema)) throw new Error(`bad schema name: ${schema}`);
  const limit = config.db.maxPerSchema;
  const freeSlot = schema && limit ? await takeSlot(schema, limit) : undefined;
  let client: ScopedClient;
  try {
    client = await connections.connect();
  } catch (err) {
    freeSlot?.();
    throw err;
  }
  if (freeSlot) {
    const release = client.release.bind(client);
    client.release = ((err?: Error | boolean) => {
      release(err);
      freeSlot();
    }) as typeof client.release;
  }
  // A connection keeps its schema between checkouts, which every checkout corrects if needed.
  if ((client.schema ?? '') !== schema) {
    try {
      await client.query(`set search_path to ${schema ? pg.escapeIdentifier(schema) : "''"}`);
    } catch (err) {
      client.release(true);
      throw err;
    }
    client.schema = schema;
  }
  return client;
}

const scopedPool = {
  connect: checkout,
  query: async (text: any, params?: any) => {
    const client = await checkout();
    try {
      return await client.query(text, params);
    } finally {
      client.release();
    }
  },
  end: () => connections.end(),
} as unknown as pg.Pool;

export const pool: pg.Pool = config.db.scoped ? scopedPool : connections;

export type Row = Record<string, any>;

export async function q<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params as any[]);
  return res.rows as T[];
}

export async function q1<T extends Row = Row>(
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  return (await q<T>(text, params))[0];
}

/** Brings the current schema up to date: `public` by default, or the one the scope names. */
export async function migrate({ quiet = false } = {}): Promise<void> {
  const schema = config.db.scoped ? schemaInUse() : '';
  // On a connection of its own: nothing can enter the schema before it exists.
  if (schema) await connections.query(`create schema if not exists ${pg.escapeIdentifier(schema)}`);
  const client = await pool.connect();
  // Per schema, so that several can migrate at the same time.
  const lock = schema ? `727001, hashtext(${pg.escapeLiteral(schema)})` : '727001';
  try {
    await client.query(`select pg_advisory_lock(${lock})`);
    await client.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    const applied = new Set(
      (await client.query('select name from schema_migrations')).rows.map((r) => r.name),
    );
    const files = readdirSync(config.migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(config.migrationsDir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations(name) values ($1)', [file]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
      if (!quiet) console.log(`migrated ${file}`);
    }
  } finally {
    await client.query(`select pg_advisory_unlock(${lock})`).catch(() => {});
    client.release();
  }
}
