// Apple Push Notification service client (HTTP/2, token-based auth).
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import http2 from 'node:http2';
import { config } from './config.ts';

export type ApnsMessage = { title: string; body: string; tag: string; task_id: number };
export type ApnsResult = { status: number; reason: string };

export function apnsConfigured(): boolean {
  const { key, keyId, teamId } = config.apns;
  return Boolean(key && keyId && teamId);
}

const b64u = (data: string | Buffer) => Buffer.from(data).toString('base64url');

let privateKey: KeyObject | undefined;
let jwt: { value: string; issuedAt: number } | undefined;

// Apple rejects tokens older than an hour and throttles ones refreshed more often than every 20 min.
function providerToken(): string {
  const now = Math.floor(Date.now() / 1000);
  if (jwt && now - jwt.issuedAt < 40 * 60) return jwt.value;
  privateKey ??= createPrivateKey(config.apns.key);
  const head = b64u(JSON.stringify({ alg: 'ES256', kid: config.apns.keyId }));
  const claims = b64u(JSON.stringify({ iss: config.apns.teamId, iat: now }));
  const signature = sign('sha256', Buffer.from(`${head}.${claims}`), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  jwt = { value: `${head}.${claims}.${b64u(signature)}`, issuedAt: now };
  return jwt.value;
}

const sessions = new Map<string, http2.ClientHttp2Session>();

function session(url: string): http2.ClientHttp2Session {
  const existing = sessions.get(url);
  if (existing && !existing.closed && !existing.destroyed) return existing;
  const created = http2.connect(url);
  const drop = () => sessions.get(url) === created && sessions.delete(url);
  created.on('error', drop);
  created.on('close', drop);
  created.on('goaway', drop);
  // An idle connection must not keep the process alive.
  created.unref();
  sessions.set(url, created);
  return created;
}

/** Sends one notification. Resolves to undefined when APNs is not configured. */
export function sendApns(
  deviceToken: string,
  environment: 'sandbox' | 'production',
  message: ApnsMessage,
): Promise<ApnsResult | undefined> {
  if (!apnsConfigured()) return Promise.resolve(undefined);
  const payload = JSON.stringify({
    aps: {
      alert: { title: message.title, body: message.body },
      sound: 'default',
      'thread-id': message.tag,
    },
    task_id: message.task_id,
  });
  return new Promise((resolve, reject) => {
    const req = session(config.apns.urls[environment]).request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${providerToken()}`,
      'apns-topic': config.apns.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-collapse-id': message.tag,
      'content-type': 'application/json',
    });
    let status = 0;
    let body = '';
    req.setTimeout(10_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
    req.on('response', (headers) => (status = Number(headers[':status'])));
    req.on('data', (chunk) => (body += chunk));
    req.on('error', reject);
    req.on('close', () => {
      if (!status) return reject(new Error('APNs request timed out'));
      let reason = '';
      try {
        reason = JSON.parse(body).reason ?? '';
      } catch {}
      resolve({ status, reason });
    });
    req.end(payload);
  });
}
