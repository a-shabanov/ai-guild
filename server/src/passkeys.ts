// Passkeys (WebAuthn). On Apple devices the platform authenticator is Face ID / Touch ID.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { randomUUID } from 'node:crypto';
import type { Actor } from './auth.ts';
import { config } from './config.ts';
import { q, q1, type Row } from './db.ts';
import { HttpError } from './errors.ts';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// Challenges are single-use and short-lived, so process memory is enough for a single server.
const challenges = new Map<string, { challenge: string; accountId?: number; purpose: string; expires: number }>();

function putChallenge(challenge: string, accountId?: number, purpose = 'register'): string {
  const now = Date.now();
  for (const [id, c] of challenges) if (c.expires < now) challenges.delete(id);
  const id = randomUUID();
  challenges.set(id, { challenge, accountId, purpose, expires: now + CHALLENGE_TTL_MS });
  return id;
}

function takeChallenge(id: unknown, accountId?: number, purpose = 'register'): string {
  const entry = typeof id === 'string' ? challenges.get(id) : undefined;
  if (typeof id === 'string') challenges.delete(id);
  if (!entry || entry.expires < Date.now() || entry.accountId !== accountId || entry.purpose !== purpose) {
    throw new HttpError(400, 'passkey challenge expired, try again');
  }
  return entry.challenge;
}

const PUBLIC_COLS = 'id, name, device_type, backed_up, created_at, last_used_at';

export async function listPasskeys(actor: Actor): Promise<Row[]> {
  return q(`select ${PUBLIC_COLS} from passkeys where account_id = $1 order by id`, [actor.id]);
}

export async function registrationOptions(actor: Actor): Promise<Row> {
  const existing = await q('select credential_id, transports from passkeys where account_id = $1', [
    actor.id,
  ]);
  const options = await generateRegistrationOptions({
    rpName: config.webauthn.rpName,
    rpID: config.webauthn.rpId,
    userID: new TextEncoder().encode(`account:${actor.id}`),
    userName: actor.name,
    userDisplayName: actor.name,
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.credential_id, transports: p.transports })),
    // Discoverable + verified: sign-in needs no username, and always asks for biometrics or PIN.
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  return { challenge_id: putChallenge(options.challenge, actor.id), options };
}

export async function verifyRegistration(
  actor: Actor,
  input: { challenge_id: string; response: any; name?: string },
): Promise<Row> {
  const expectedChallenge = takeChallenge(input.challenge_id, actor.id);
  let result;
  try {
    result = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge,
      expectedOrigin: config.webauthn.origins,
      expectedRPID: config.webauthn.rpId,
      requireUserVerification: true,
    });
  } catch (err: any) {
    throw new HttpError(400, `passkey registration failed: ${err.message}`);
  }
  if (!result.verified || !result.registrationInfo) {
    throw new HttpError(400, 'passkey registration failed');
  }
  const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
  try {
    const row = await q1(
      `insert into passkeys(account_id, credential_id, public_key, counter, transports,
                            device_type, backed_up, name)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${PUBLIC_COLS}`,
      [
        actor.id,
        credential.id,
        Buffer.from(credential.publicKey),
        credential.counter,
        credential.transports ?? [],
        credentialDeviceType,
        credentialBackedUp,
        input.name?.trim().slice(0, 80) || 'Passkey',
      ],
    );
    return row!;
  } catch (err: any) {
    if (err.code === '23505') throw new HttpError(409, 'this passkey is already registered');
    throw err;
  }
}

export async function deletePasskey(actor: Actor, id: number): Promise<void> {
  const row = await q1('delete from passkeys where id = $1 and account_id = $2 returning id', [
    id,
    actor.id,
  ]);
  if (!row) throw new HttpError(404, `passkey ${id} not found`);
  await q(`delete from sessions where account_id = $1 and method = 'passkey'`, [actor.id]);
}

export async function loginOptions(): Promise<Row> {
  const options = await generateAuthenticationOptions({
    rpID: config.webauthn.rpId,
    userVerification: 'required',
  });
  return { challenge_id: putChallenge(options.challenge, undefined, 'login'), options };
}

export async function verifyLogin(input: { challenge_id: string; response: any }, unlock?: { actor: Actor; sessionHash: string; purpose?: 'unlock' | 'enable-biometric' }): Promise<Actor> {
  const expectedChallenge = takeChallenge(input.challenge_id, unlock?.actor.id, unlock ? `${unlock.purpose ?? 'unlock'}:${unlock.sessionHash}` : 'login');
  const failed = new HttpError(401, 'passkey sign-in failed');
  const row = await q1(
    `select p.*, a.name as account_name, a.kind, a.system, a.role, a.disabled
       from passkeys p join accounts a on a.id = p.account_id
      where p.credential_id = $1`,
    [String(input.response?.id ?? '')],
  );
  if (!row || row.disabled || (unlock && row.account_id !== unlock.actor.id)) throw failed;
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge,
      expectedOrigin: config.webauthn.origins,
      expectedRPID: config.webauthn.rpId,
      requireUserVerification: true,
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(row.public_key),
        counter: row.counter,
        transports: row.transports,
      },
    });
  } catch {
    throw failed;
  }
  if (!result.verified) throw failed;
  await q('update passkeys set counter = $2, backed_up = $3, last_used_at = now() where id = $1', [
    row.id,
    result.authenticationInfo.newCounter,
    result.authenticationInfo.credentialBackedUp,
  ]);
  return {
    id: row.account_id,
    name: row.account_name,
    kind: row.kind,
    system: row.system,
    role: row.role,
    passkeyId: row.id,
  };
}

export async function unlockOptions(actor: Actor, sessionHash: string, purpose: 'unlock' | 'enable-biometric' = 'unlock'): Promise<Row> {
  const credentials = await q('select credential_id,transports from passkeys where account_id=$1', [actor.id]);
  if (!credentials.length) throw new HttpError(400, 'add a passkey first');
  const options = await generateAuthenticationOptions({ rpID: config.webauthn.rpId, userVerification: 'required',
    allowCredentials: credentials.map(p => ({id:p.credential_id,transports:p.transports})) });
  return {challenge_id:putChallenge(options.challenge,actor.id,`${purpose}:${sessionHash}`),options};
}
