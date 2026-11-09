// A team's whole tracker as one file, to move it or keep it: `npm run data -- export` and `import`.
// A gzipped tar: manifest.json first, then table rows as JSON lines, then the files, then end.json with the counts,
// so a file that was cut short is told apart from a small team. Only an install of the same schema can read it.
//
// What only ever meant something on the old server stays behind: sessions, passkeys, second factors, devices, sign-in
// links to other services, open invitations and this server's own keys. API keys are stored as hashes and do travel,
// so agents keep working once they point to the new address. People get in with a key from the account CLI.
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import pg from 'pg';
import { config } from './config.ts';
import { pool } from './db.ts';

// In loading order: parents before children, so that every foreign key is satisfied. A test checks this against the database.
export const dataTables = ['accounts', 'projects', 'tasks', 'comments', 'time_logs', 'attachments', 'events', 'task_links', 'inbox_reads', 'notification_preferences', 'wiki_pages'];
// The ones with an id from a sequence, which has to continue after the highest id that arrived.
export const tablesWithId = ['accounts', 'projects', 'tasks', 'comments', 'time_logs', 'attachments', 'events', 'task_links', 'wiki_pages'];
export const leftBehind = ['schema_migrations', 'sessions', 'passkeys', 'push_subscriptions', 'apns_devices', 'settings', 'account_identities', 'account_invitations',
  'auth_flows', 'auth_exchanges', 'account_second_factors', 'two_factor_logins', 'two_factor_codes', 'account_devices'];
const fileFolders = ['attachments', 'logos', 'avatars'];
const FORMAT = 1;
const BLOCK = 512;
const ROWS_PER_ENTRY = 200;

type Client = pg.PoolClient;
const quote = pg.escapeIdentifier;

// ---- tar, as much of it as this file needs: regular files with short names.

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(BLOCK);
  if (Buffer.byteLength(name) > 100) throw new Error(`name too long for the archive: ${name}`);
  header.write(name, 0);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0' + '00', 257);
  header.write(`${checksum(header).toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}
const checksum = (header: Buffer) => header.reduce((sum, byte) => sum + byte, 0);
const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

class TarWriter {
  private out: Writable;
  constructor(out: Writable) { this.out = out; }
  async write(chunk: Buffer) {
    if (this.out.destroyed) throw new Error('the export was interrupted');
    if (!this.out.write(chunk)) await once(this.out, 'drain');
  }
  async add(name: string, content: Buffer) {
    await this.write(tarHeader(name, content.length));
    await this.write(content);
    await this.write(padding(content.length));
  }
  /** Opened before anything is written, so a file removed meanwhile is either here whole or not at all. */
  async addFile(name: string, path: string) {
    let file;
    try {
      file = await open(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
    try {
      const { size } = await file.stat();
      await this.write(tarHeader(name, size));
      let left = size;
      if (size) {
        for await (const chunk of file.createReadStream({ autoClose: false, start: 0, end: size - 1 })) {
          await this.write(chunk as Buffer);
          left -= (chunk as Buffer).length;
        }
      }
      if (left) throw new Error('a file got shorter while it was being read');
      await this.write(padding(size));
      return true;
    } finally {
      await file.close();
    }
  }
}

class TarReader {
  private source: AsyncIterator<Buffer>;
  private held: Buffer = Buffer.alloc(0);
  constructor(source: AsyncIterable<Buffer>) { this.source = source[Symbol.asyncIterator](); }
  private async fill() {
    const { value, done } = await this.source.next();
    if (done) throw new Error('the file ends too early');
    this.held = this.held.length ? Buffer.concat([this.held, value]) : value;
  }
  private async take(size: number) {
    while (this.held.length < size) await this.fill();
    const taken = this.held.subarray(0, size);
    this.held = this.held.subarray(size);
    return taken;
  }
  /** The next entry, or null at the end marker. */
  async next() {
    const header = await this.take(BLOCK);
    if (header.every((byte) => byte === 0)) return null;
    const field = (at: number, length: number) => header.subarray(at, at + length).toString().split('\0')[0]!;
    const stored = parseInt(field(148, 8).trim(), 8);
    const blank = Buffer.from(header);
    blank.write('        ', 148);
    if (stored !== checksum(blank)) throw new Error('the file is damaged');
    return { name: field(0, 100), type: field(156, 1), size: parseInt(field(124, 12).trim(), 8) };
  }
  /** Reads to the very end, where gzip keeps its checksum: a file cut after the last entry is still a damaged file. */
  async finish() {
    for (;;) {
      const { done } = await this.source.next();
      if (done) return;
    }
  }
  async content(size: number) {
    const content = Buffer.from(await this.take(size));
    await this.take(padding(size).length);
    return content;
  }
  async *chunks(size: number) {
    let left = size;
    while (left > 0) {
      if (!this.held.length) await this.fill();
      const chunk = this.held.subarray(0, Math.min(left, this.held.length));
      this.held = this.held.subarray(chunk.length);
      left -= chunk.length;
      yield chunk;
    }
    await this.take(padding(size).length);
  }
}

// ---- Export

async function filesOfFolder(folder: string): Promise<string[]> {
  try {
    const entries = await readdir(join(config.dataDir, folder), { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(config.dataDir.length + 1));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Writes the archive of the current install or scope. Rows are from one moment; files are read after the connection is free. */
export async function writeExport(out: Writable) {
  const gzip = createGzip();
  const finished = pipeline(gzip, out);
  const tar = new TarWriter(gzip);
  const tables: Record<string, number> = {};
  let files = 0;
  try {
    const client = await pool.connect();
    try {
      await client.query('begin isolation level repeatable read read only');
      const { rows: migrations } = await client.query('select name from schema_migrations order by name');
      await tar.add('manifest.json', Buffer.from(JSON.stringify({ format: FORMAT, version: config.version, migrations: migrations.map((m) => m.name), exported_at: new Date().toISOString() }, null, 2)));
      for (const table of dataTables) {
        tables[table] = 0;
        await client.query(`declare portable_rows cursor for select row_to_json(t)::text as line from ${quote(table)} t`);
        for (let part = 1; ; part += 1) {
          const { rows } = await client.query(`fetch ${ROWS_PER_ENTRY} from portable_rows`);
          if (!rows.length) break;
          tables[table] += rows.length;
          await tar.add(`tables/${table}/${String(part).padStart(6, '0')}.jsonl`, Buffer.from(`${rows.map((row) => row.line).join('\n')}\n`));
        }
        await client.query('close portable_rows');
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    for (const folder of fileFolders) {
      for (const file of await filesOfFolder(folder)) {
        if (await tar.addFile(`files/${file}`, join(config.dataDir, file))) files += 1;
      }
    }
    await tar.add('end.json', Buffer.from(JSON.stringify({ tables, files })));
    await tar.write(Buffer.alloc(BLOCK * 2));
    gzip.end();
    await finished;
    return { tables, files };
  } catch (err) {
    gzip.destroy(err as Error);
    await finished.catch(() => {});
    throw err;
  }
}

// ---- Import

// Names come from the file: nothing may land outside the folders the tracker keeps files in.
const isSafeFile = (name: string) => {
  const [root, folder, ...rest] = name.split('/');
  return root === 'files' && fileFolders.includes(folder ?? '') && rest.length > 0 && rest.every((part) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part));
};

// Only ever called with a name from dataTables.
async function loadStaged(client: Client, table: string) {
  // One statement for the whole table: a row may point to a later row of the same table.
  await client.query(`insert into ${quote(table)} select (jsonb_populate_record(null::${quote(table)}, line::jsonb)).* from portable_staging`);
  await client.query('truncate portable_staging');
  if (tablesWithId.includes(table)) {
    await client.query(`select setval(pg_get_serial_sequence($1, 'id'), coalesce(max(id), 1), max(id) is not null) from ${quote(table)}`, [quote(table)]);
  }
}

/** Into an empty install of the same schema, or not at all: a failure leaves no rows and no files behind. */
export async function readExport(input: Readable) {
  const gunzip = createGunzip();
  const stream = input.pipe(gunzip);
  input.once('error', (err) => gunzip.destroy(err));
  // Told through the reader while it reads. After it stops, an error here must not take the process down.
  gunzip.on('error', () => {});
  const tar = new TarReader(stream as AsyncIterable<Buffer>);
  const written: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('begin');
    const first = await tar.next();
    if (first?.name !== 'manifest.json') throw new Error('this is not a tracker export');
    const manifest = JSON.parse((await tar.content(first.size)).toString());
    if (manifest.format !== FORMAT) throw new Error(`this export has format ${manifest.format}, this version reads format ${FORMAT}`);
    const { rows: applied } = await client.query('select name from schema_migrations order by name');
    if (JSON.stringify(applied.map((m) => m.name)) !== JSON.stringify(manifest.migrations)) {
      throw new Error(`this export is from version ${manifest.version} with a different database schema; install that version (this is ${config.version}), import, then upgrade`);
    }
    const { rows: [{ taken }] } = await client.query('select exists(select 1 from accounts) or exists(select 1 from tasks) or exists(select 1 from projects) as taken');
    if (taken) throw new Error('this install already has data; import needs an empty one');

    await client.query('create temp table portable_staging (line text not null) on commit drop');
    const tables: Record<string, number> = {};
    let files = 0;
    let openTable: string | null = null;
    let end: { tables: Record<string, number>; files: number } | null = null;
    for (let entry = await tar.next(); entry; entry = await tar.next()) {
      if (end) throw new Error('the file is damaged');
      if (entry.type !== '0' && entry.type !== '') throw new Error(`unexpected entry in the export: ${entry.name}`);
      const match = /^tables\/([a-z_]+)\/\d+\.jsonl$/.exec(entry.name);
      if (match) {
        const table = match[1]!;
        if (!dataTables.includes(table)) throw new Error(`unexpected table in the export: ${table}`);
        if (openTable !== table) {
          if (openTable) await loadStaged(client, openTable);
          if (table in tables) throw new Error('the file is damaged');
          openTable = table;
          tables[table] = 0;
        }
        const lines = (await tar.content(entry.size)).toString().split('\n').filter(Boolean);
        await client.query('insert into portable_staging(line) select unnest($1::text[])', [lines]);
        tables[table] += lines.length;
      } else if (entry.name === 'end.json') {
        end = JSON.parse((await tar.content(entry.size)).toString());
      } else if (isSafeFile(entry.name)) {
        if (openTable) { await loadStaged(client, openTable); openTable = null; }
        const path = join(config.dataDir, entry.name.slice('files/'.length));
        await mkdir(dirname(path), { recursive: true });
        // Never over a file that is already there.
        const target = createWriteStream(path, { flags: 'wx' });
        written.push(path);
        await pipeline(Readable.from(tar.chunks(entry.size)), target);
        files += 1;
      } else {
        throw new Error(`unexpected entry in the export: ${entry.name}`);
      }
    }
    if (openTable) await loadStaged(client, openTable);
    if (!end) throw new Error('the file ends too early');
    await tar.finish();
    const counted = Object.entries(end.tables).filter(([, count]) => count > 0).sort();
    if (JSON.stringify(counted) !== JSON.stringify(Object.entries(tables).sort()) || end.files !== files) throw new Error('the file is damaged: its contents do not match its counts');
    await client.query('commit');
    return { tables, files };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    await Promise.all(written.map((path) => rm(path, { force: true })));
    throw err;
  } finally {
    client.release();
    gunzip.destroy();
    input.destroy();
  }
}
