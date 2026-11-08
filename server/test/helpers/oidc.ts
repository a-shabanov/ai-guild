import express from 'express';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createHash, randomBytes } from 'node:crypto';

export async function fakeOidc() {
  const pair = await generateKeyPair('RS256');
  const wrong = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'test', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { auth: URL; claims: Record<string, any>; invalidSignature: boolean; sharedSecret?: string }>();
  const clients: Record<string, string> = { 'test-client': 'test-secret', 'client-b': 'secret-b' };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.get('/jwks', (_req, res) => { res.json({ keys: [jwk] }); });
  app.post('/:provider/token', async (req, res) => {
    const record = codes.get(req.body.code);
    codes.delete(req.body.code);
    if (!record || createHash('sha256').update(req.body.code_verifier ?? '').digest('base64url') !== record.auth.searchParams.get('code_challenge') ||
        req.body.redirect_uri !== record.auth.searchParams.get('redirect_uri') || req.body.client_id !== record.auth.searchParams.get('client_id') ||
        (req.params.provider === 'google' ? req.body.client_secret !== clients[req.body.client_id]
          : req.headers.authorization !== `Basic ${Buffer.from(`${req.body.client_id}:${clients[req.body.client_id]}`).toString('base64')}`)) {
      return void res.status(400).json({ error: 'invalid_grant' });
    }
    const token = record.sharedSecret
      ? await new SignJWT(record.claims).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(record.sharedSecret))
      : await new SignJWT(record.claims).setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .sign(record.invalidSignature ? wrong.privateKey : pair.privateKey);
    res.json({ id_token: token });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const issue = (provider: string, authUrl: string, overrides: Record<string, any> = {}, invalidSignature = false, sharedSecret?: string) => {
    const auth = new URL(authUrl);
    const code = randomBytes(32).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    codes.set(code, { auth, invalidSignature, sharedSecret, claims: { iss: provider === 'google' ? 'https://accounts.google.com' : 'https://oauth.telegram.org',
      aud: 'test-client', sub: `${provider}-person`, nonce: auth.searchParams.get('nonce'), iat: now, exp: now + 300,
      name: 'Test Person', email: 'person@example.test', email_verified: true, preferred_username: 'person', ...overrides } });
    return `${auth.searchParams.get('redirect_uri')}?${new URLSearchParams({ code, state: auth.searchParams.get('state')! })}`;
  };
  // Local browser QA can traverse the complete redirect flow with disposable accounts.
  app.get('/:provider/authorize', (req, res) => {
    const authUrl = `${url}${req.originalUrl}`;
    res.redirect(303, issue(req.params.provider, authUrl,
      { sub: req.params.provider === 'telegram' ? 'telegram-preview' : 'google-person' }));
  });
  return { url, issue, close: () => new Promise<void>((r) => server.close(() => r())) };
}
