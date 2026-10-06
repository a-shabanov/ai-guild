// Local read-only product tour. Requires an explicitly named demo database.
import { resolve } from 'node:path';

const database = process.env.DEMO_DATABASE_URL;
if (!database) throw new Error('Set DEMO_DATABASE_URL to a dedicated database whose name ends in _demo');
const parsed = new URL(database);
if (!parsed.pathname.endsWith('_demo')) throw new Error('The demo database name must end in _demo');
process.env.DATABASE_URL = database;
process.env.HOST = '127.0.0.1';
process.env.PORT ??= '4602';
process.env.PUBLIC_URL = `http://127.0.0.1:${process.env.PORT}`;
process.env.DATA_DIR = resolve(process.env.DEMO_DATA_DIR ?? 'data/showcase');

const [{ default: express }, { buildApp }, { q1, pool }, { createSession, destroySession, authenticate }, { skipSetup, lock }] = await Promise.all([
  import('express'), import('../src/server.ts'), import('../src/db.ts'), import('../src/auth.ts'),
  import('../src/app-lock.ts'),
]);
const account = await q1("select id from accounts where name = 'demo' and kind = 'human' and not disabled");
if (!account) {
  await pool.end();
  throw new Error('Seed the dedicated demo database with scripts/seed-demo.ts first');
}
const token = await createSession(account.id, 'key', 'local read-only demo');
// The tour has no write access, so dismiss the optional PIN setup before serving it.
const actor = await authenticate(token);
await skipSetup(actor, token);
const app = express();
app.use(async (req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  // Boot relocks its saved session even without a PIN. This disposable session
  // action is allowed; all project, task and account writes remain denied.
  if (req.method === 'POST' && req.path === '/api/app-lock/lock') {
    res.json(await lock(actor, token));
    return;
  }
  if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path.startsWith('/api/auth/') || req.path === '/mcp') {
    res.status(403).json({ error: 'This tour is read-only. Run your own instance to create or change tasks.' });
    return;
  }
  req.headers.authorization = `Bearer ${token}`;
  next();
});
app.use(buildApp());
const server = app.listen(Number(process.env.PORT), '127.0.0.1', () => {
  console.log(`Read-only demo: http://127.0.0.1:${process.env.PORT}`);
});
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  server.close();
  await destroySession(token);
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
