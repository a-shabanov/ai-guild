// A team's whole tracker in one file, from the shell. Usage:
//   npm run data -- export tracker.tar.gz
//   npm run data -- import tracker.tar.gz      into an empty install of the same version
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { migrate, pool } from './db.ts';
import { readExport, writeExport } from './portable.ts';

const [command, file] = process.argv.slice(2);
if (!file || !['export', 'import'].includes(command ?? '')) {
  console.error('usage: npm run data -- export|import <file>');
  process.exit(2);
}
try {
  await migrate({ quiet: true });
  const summary = command === 'export'
    ? await writeExport(createWriteStream(file, { flags: 'wx', mode: 0o600 })).catch(async (err) => {
      if (err.code !== 'EEXIST') await rm(file, { force: true });
      throw err;
    })
    : await readExport(createReadStream(file));
  console.log(`${command === 'export' ? 'Exported' : 'Imported'}: ${Object.entries(summary.tables).map(([table, count]) => `${table} ${count}`).join(', ')}; files ${summary.files}`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
