import express from 'express';
import { config } from './config.ts';
import { migrate, pool } from './db.ts';
import { handleMcp } from './mcp.ts';
import { errorHandler, restRouter } from './rest.ts';
import { accountsExist } from './service.ts';

export function buildApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.get('/healthz', async (_req, res) => {
    await pool.query('select 1');
    res.json({ ok: true });
  });
  // Lets the native iOS app use this site's passkeys (Associated Domains).
  app.get('/.well-known/apple-app-site-association', (_req, res) => {
    if (!config.appleAppIds.length) return void res.status(404).end();
    res.json({ webcredentials: { apps: config.appleAppIds } });
  });
  app.all('/mcp', express.json({ limit: '8mb' }), handleMcp);
  app.use('/api', restRouter());
  app.use(
    express.static(config.publicDir, {
      setHeaders: (res, path) => {
        res.set('Cache-Control', 'no-cache');
        if (path.endsWith('.webmanifest')) res.type('application/manifest+json');
        res.set(
          'Content-Security-Policy',
          "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'",
        );
      },
    }),
  );
  app.use(errorHandler);
  return app;
}

if (import.meta.main) {
  await migrate();
  if (!(await accountsExist())) {
    console.log(
      'No accounts yet. Create your admin account:\n' +
        '  npm run account -- create --name <you> --kind human --role admin',
    );
  }
  const server = buildApp().listen(config.port, config.host, () => {
    console.log(`AI Tracker  http://${config.host}:${config.port}`);
    console.log(`MCP         http://${config.host}:${config.port}/mcp`);
    console.log(`OpenAPI     http://${config.host}:${config.port}/api/openapi.json`);
  });
  const stop = () => {
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
