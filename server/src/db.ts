import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

// bigint and numeric come back as strings by default; ids and sums here fit in a double.
pg.types.setTypeParser(20, Number);
pg.types.setTypeParser(1700, Number);

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

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

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock(727001)');
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
      console.log(`migrated ${file}`);
    }
  } finally {
    await client.query('select pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}
