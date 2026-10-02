import express, { type Request, type Response, type NextFunction, type Router } from 'express';
import busboy from 'busboy';
import { z } from 'zod';
import { authenticate, createSession, destroySession, type Actor, type SessionMethod } from './auth.ts';
import { config } from './config.ts';
import { HttpError } from './errors.ts';
import { apnsConfigured } from './apns.ts';
import { buildOpenApi } from './openapi.ts';
import * as passkeys from './passkeys.ts';
import * as push from './push.ts';
import * as notifications from './notification-preferences.ts';
import * as S from './schemas.ts';
import * as svc from './service.ts';
import * as social from './social-auth.ts';
import * as twoFactor from './two-factor.ts';
import * as devices from './devices.ts';

export const SESSION_COOKIE = 'ait_session';
const TWO_FACTOR_COOKIE = 'ait_two_factor';

declare module 'express-serve-static-core' {
  interface Request {
    actor: Actor;
    deviceId?: number;
  }
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      try { return decodeURIComponent(v.join('=')); } catch { return undefined; }
    }
  }
  return undefined;
}

function sameOrigin(req: Request): void {
  const origin = req.headers.origin;
  if ((origin && origin !== new URL(config.publicUrl).origin) || req.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, 'cross-origin request denied');
  }
}

function setSessionCookie(req: Request, res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'strict', secure: req.secure || config.publicUrl.startsWith('https:'),
    maxAge: config.sessionDays * 24 * 3600 * 1000, path: '/',
  });
}

const flowCookie = (provider: social.Provider) => `ait_oauth_${provider}`;
function bindBrowser(req: Request, res: Response, provider: social.Provider, browser: string) {
  res.cookie(flowCookie(provider), browser, { httpOnly: true, sameSite: 'lax',
    secure: req.secure || config.publicUrl.startsWith('https:'), path: '/api/auth', maxAge: 10 * 60_000 });
}

const authMessage = (error: unknown): string => {
  const message = error instanceof HttpError ? error.message : '';
  return ({
    'provider account is not linked': 'Этот аккаунт ещё не привязан. Откройте приглашение от администратора или добавьте способ входа в профиле.',
    'provider account is already linked': 'Этот аккаунт уже привязан к другому участнику.',
    'provider is already linked; unlink it first': 'Этот способ входа уже добавлен. Сначала отключите его в профиле.',
    'linking session expired': 'Сессия завершилась. Войдите снова и повторите привязку.',
    'invitation is invalid or expired': 'Приглашение уже использовано или истекло. Попросите администратора выдать новое.',
    'cancelled': 'Вход отменён. Можно попробовать ещё раз.',
    'invalid or expired sign-in': 'Вход устарел или открыт в другом браузере. Начните заново.',
  } as Record<string, string>)[message] ?? 'Не удалось подтвердить вход. Попробуйте ещё раз.';
};

export function keyFromRequest(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string') return apiKey.trim();
  return readCookie(req, SESSION_COOKIE);
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  req.actor = await authenticate(keyFromRequest(req));
  req.deviceId = await devices.associate(req.actor,keyFromRequest(req),devices.fromHeaders(req.headers),req.headers['user-agent']);
  // Set by the history importer, so hundreds of old events do not land in inboxes.
  if (req.headers['x-tracker-history'] === '1') req.actor.history = true;
  next();
}

function id(req: Request): number {
  const n = Number(req.params.id);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, 'invalid id');
  return n;
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const res = schema.safeParse(data ?? {});
  if (!res.success) throw new HttpError(400, z.prettifyError(res.error));
  return res.data;
}

function uploadFiles(req: Request, taskId: number): Promise<object[]> {
  const commentId = req.query.comment_id ? Number(req.query.comment_id) : undefined;
  if (commentId !== undefined && !Number.isSafeInteger(commentId)) {
    throw new HttpError(400, 'invalid comment_id');
  }

  if (!req.is('multipart/form-data')) {
    const filename = typeof req.query.filename === 'string' ? req.query.filename : '';
    if (!filename) {
      throw new HttpError(400, 'send multipart/form-data, or a raw body with ?filename=<name>');
    }
    return svc
      .addAttachment(req.actor, taskId, {
        filename,
        mime: req.headers['content-type'],
        stream: req,
        commentId,
      })
      .then((a) => [a]);
  }

  return new Promise((resolve, reject) => {
    const pending: Promise<object>[] = [];
    const bb = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 20 } });
    bb.on('file', (_field, stream, info) => {
      const p = svc.addAttachment(req.actor, taskId, {
        filename: info.filename ?? 'file',
        mime: info.mimeType,
        stream,
        commentId,
      });
      // Keep draining so busboy can reach the next part even when this one failed.
      p.catch(() => stream.resume());
      pending.push(p);
    });
    bb.on('error', reject);
    bb.on('close', () => {
      if (!pending.length) return reject(new HttpError(400, 'no file in the request'));
      Promise.all(pending).then(resolve, reject);
    });
    req.pipe(bb);
  });
}

export function restRouter(): Router {
  const r = express.Router();
  const jsonBody = express.json({ limit: '2mb' });

  // What the sign-in screen needs to know before anyone is signed in.
  r.get('/config', (_req, res) => {
    res.json({
      passkeys: { rp_id: config.webauthn.rpId, origins: config.webauthn.origins },
      providers: { google: social.configured('google'), telegram: social.configured('telegram') },
      two_factor: twoFactor.available(),
      apns: apnsConfigured(),
      version: config.version,
      build: config.build,
    });
  });

  r.get('/openapi.json', (_req, res) => {
    res.json(buildOpenApi());
  });

  // Browser session: an opaque token in an HttpOnly cookie, so <img>/<video> can load
  // attachments and the API key never stays in the browser.
  const gate = async (req: Request, res: Response, actor: Actor, method: SessionMethod, identityId?: number, key?: string) => {
    const challenge = await twoFactor.beginLogin(actor, method, identityId, key);
    if (challenge) {
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.cookie(TWO_FACTOR_COOKIE, challenge.challenge_token, { httpOnly: true, sameSite: 'strict',
        secure: req.secure || config.publicUrl.startsWith('https:'), path: '/api/auth/2fa', maxAge:10*60_000 });
    }
    return challenge;
  };
  const startSession = async (req: Request, res: Response, actor: Actor, method: SessionMethod, identityId?: number, key?: string) => {
    const native = !req.headers.origin && !req.headers['sec-fetch-site'];
    const challenge = await gate(req,res,actor,method,identityId,key);
    res.set('Cache-Control','no-store');
    if (challenge) {
      const {challenge_token,...details}=challenge;
      return void res.json(native ? challenge : details);
    }
    const token = await createSession(actor.id, method, req.headers['user-agent'],identityId);
    setSessionCookie(req, res, token);
    // Native apps cannot use the cookie jar reliably, so they get the token itself. Browsers
    // always send Origin on POST, which keeps the token away from page scripts.
    const {passkeyId,...account}=actor;
    res.json(native ? { ...account, session_token: token } : account);
  };

  r.post('/session', jsonBody, async (req, res) => {
    sameOrigin(req);
    const { key } = parse(z.object({ key: z.string() }), req.body);
    await startSession(req, res, await authenticate(key.trim(),true), 'key',undefined,key.trim());
  });
  r.delete('/session', async (req, res) => {
    sameOrigin(req);
    await destroySession(readCookie(req, SESSION_COOKIE));
    await destroySession(keyFromRequest(req));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    const pendingToken=readCookie(req,TWO_FACTOR_COOKIE);
    if(pendingToken) await twoFactor.cancel(pendingToken);
    res.clearCookie(TWO_FACTOR_COOKIE,{path:'/api/auth/2fa'});
    res.json({ ok: true });
  });

  r.post('/passkeys/login/options', async (_req, res) => {
    res.json(await passkeys.loginOptions());
  });
  r.post('/passkeys/login/verify', jsonBody, async (req, res) => {
    sameOrigin(req);
    const actor = await passkeys.verifyLogin(parse(S.PasskeyResponse, req.body));
    await startSession(req, res, actor, 'passkey');
  });

  // No OAuth response, invitation or linked identity is eligible for offline caching.
  r.use('/auth', (_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); next(); });

  const challengeToken = (req:Request) => parse(S.AuthToken,req.body?.challenge_token ?? req.headers['x-2fa-challenge'] ?? readCookie(req,TWO_FACTOR_COOKIE));
  r.get('/auth/2fa/pending', async(req,res)=>{res.json(await twoFactor.pending(challengeToken(req)));});
  r.post('/auth/2fa/send',jsonBody,async(req,res)=>{
    sameOrigin(req); const {channel}=parse(S.TwoFactorSend,req.body);
    res.json(await twoFactor.sendLogin(challengeToken(req),channel));
  });
  r.post('/auth/2fa/verify',jsonBody,async(req,res)=>{
    sameOrigin(req); const {code}=parse(S.TwoFactorVerify,req.body);
    const result=await twoFactor.verifyLogin(challengeToken(req),code,req.headers['user-agent']);
    res.clearCookie(TWO_FACTOR_COOKIE,{path:'/api/auth/2fa'});
    setSessionCookie(req,res,result.session);
    const native=!req.headers.origin&&!req.headers['sec-fetch-site'];
    res.json(native?{...result.actor,session_token:result.session}:result.actor);
  });
  r.delete('/auth/2fa/pending',jsonBody,async(req,res)=>{
    sameOrigin(req); await twoFactor.cancel(challengeToken(req));
    res.clearCookie(TWO_FACTOR_COOKIE,{path:'/api/auth/2fa'}); res.json({ok:true});
  });
  const opaque = S.AuthToken;
  r.post('/auth/invitations/inspect', jsonBody, async (req, res) => {
    const { token } = parse(S.InvitationToken, req.body);
    const invitation = await social.inspectInvitation(token);
    res.json({ name: invitation.name, expires_at: invitation.expires_at });
  });
  r.post('/auth/:provider/start', jsonBody, async (req, res) => {
    sameOrigin(req);
    const provider = social.providerName(req.params.provider);
    const input = parse(S.AuthStart, req.body);
    const credential = keyFromRequest(req);
    const link = input.intent === 'link' ? { actor: await authenticate(credential), credential: credential! } : undefined;
    const result = await social.begin(provider, link, input.code_challenge, input.invitation_token);
    if (result.browser) bindBrowser(req, res, provider, result.browser);
    if (input.invitation_token) res.cookie(`${flowCookie(provider)}_invite`, input.invitation_token,
      { httpOnly: true, sameSite: 'lax', secure: req.secure || config.publicUrl.startsWith('https:'), path: '/api/auth', maxAge: 10 * 60_000 });
    res.json({ authorization_url: result.authorization_url });
  });
  r.get('/auth/:provider/browser', async (req, res) => {
    const provider = social.providerName(req.params.provider);
    const { ticket, state } = parse(z.object({ ticket: opaque, state: opaque }), req.query);
    const result = await social.claimBrowser(provider, ticket, state);
    bindBrowser(req, res, provider, result.browser);
    res.redirect(303, result.authorization_url);
  });
  r.get('/auth/:provider/callback', async (req, res) => {
    const provider = social.providerName(req.params.provider);
    let flow: Awaited<ReturnType<typeof social.consumeFlow>> | undefined;
    try {
      const input = parse(z.object({ state: opaque, code: z.string().min(1).max(4096).optional(),
        error: z.string().max(255).optional() }), req.query);
      flow = await social.consumeFlow(provider, input.state, readCookie(req, flowCookie(provider)));
      res.clearCookie(flowCookie(provider), { path: '/api/auth' });
      if (input.error || !input.code) throw new HttpError(400, 'cancelled');
      const { actor, identityId } = await social.complete(provider, input.code, flow);
      if (flow.native_challenge) {
        const code = await social.nativeResult(actor, provider, flow, identityId);
        return void res.redirect(303, `aitracker://auth?code=${code}`);
      }
      if (!flow.account_id || flow.invitation_id) {
        if (await gate(req,res,actor,provider,identityId)) {
          res.clearCookie(`${flowCookie(provider)}_invite`, {path:'/api/auth'});
          return void res.redirect(303,'/#/two-factor');
        }
        setSessionCookie(req, res, await createSession(actor.id, provider, req.headers['user-agent'], identityId));
      }
      res.clearCookie(`${flowCookie(provider)}_invite`, { path: '/api/auth' });
      res.redirect(303, flow.account_id ? '/?auth=linked#/profile' : '/?auth=signed-in#/projects');
    } catch (error) {
      const message = encodeURIComponent(authMessage(error));
      let retry = '';
      if (flow?.invitation_id) {
        const token = readCookie(req, `${flowCookie(provider)}_invite`);
        if (token) {
          const invitation = await social.inspectInvitation(token).catch(() => null);
          if (invitation?.id === flow.invitation_id) retry = `#/invite/${token}`;
        }
        res.clearCookie(`${flowCookie(provider)}_invite`, { path: '/api/auth' });
      }
      // Only a consumed, browser-bound native flow can redirect into the app.
      res.redirect(303, flow?.native_challenge ? `aitracker://auth?error=${message}` : `/?auth_error=${message}${retry || (flow?.account_id && !flow.invitation_id ? '#/profile' : '')}`);
    }
  });
  r.post('/auth/exchange', jsonBody, async (req, res) => {
    sameOrigin(req);
    const { code, code_verifier } = parse(S.AuthExchange, req.body);
    const result = await social.exchange(code, code_verifier);
    if (result.linking) res.json({ ok: true });
    else {
      await startSession(req,res,result.actor,result.provider,result.identityId);
    }
  });

  r.use(requireAuth);

  r.use('/devices',(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  r.get('/devices',async(req,res)=>{res.json(await devices.list(req.actor,keyFromRequest(req)));});
  r.patch('/devices/:id',jsonBody,async(req,res)=>{
    sameOrigin(req);const {name}=parse(S.RenameDevice,req.body);
    res.json(await devices.rename(req.actor,keyFromRequest(req),id(req),name));
  });
  r.delete('/devices/:id',async(req,res)=>{
    sameOrigin(req);const deviceId=id(req);
    const result=await devices.revoke(req.actor,keyFromRequest(req),deviceId);
    if(req.deviceId===deviceId)res.clearCookie(SESSION_COOKIE,{path:'/'});
    res.json(result);
  });

  r.get('/auth/2fa/settings',async(req,res)=>{res.json(await twoFactor.settings(req.actor));});
  r.post('/auth/2fa/enroll',jsonBody,async(req,res)=>{
    sameOrigin(req);const input=parse(S.TwoFactorEnroll,req.body);
    res.json(await twoFactor.enroll(req.actor,keyFromRequest(req)!,input.channel,input.email,input.phone));
  });
  r.post('/auth/2fa/enroll/verify',jsonBody,async(req,res)=>{
    sameOrigin(req);const input=parse(S.TwoFactorEnrollmentVerify,req.body);
    res.json(await twoFactor.confirmEnrollment(req.actor,keyFromRequest(req)!,input.enrollment_token,input.code));
  });
  r.delete('/auth/2fa/settings/:channel',async(req,res)=>{
    sameOrigin(req);res.json(await twoFactor.remove(req.actor,keyFromRequest(req)!,parse(S.TwoFactorChannel,req.params.channel)));
  });
  r.post('/accounts/:id/reset-2fa',async(req,res)=>{
    sameOrigin(req);res.json(await twoFactor.reset(req.actor,keyFromRequest(req)!,id(req)));
  });

  r.get('/auth/identities', async (req, res) => { res.json(await social.listIdentities(req.actor)); });
  r.delete('/auth/identities/:provider', async (req, res) => {
    sameOrigin(req);
    await social.unlink(req.actor, social.providerName(req.params.provider));
    res.json({ ok: true });
  });
  r.post('/accounts/:id/invitation', jsonBody, async (req, res) => {
    sameOrigin(req);
    res.set('Cache-Control', 'no-store');
    res.status(201).json(await social.createInvitation(req.actor, id(req)));
  });

  r.get('/me', async (req, res) => {
    const all = await svc.listAccounts();
    res.json(all.find((a) => a.id === req.actor.id));
  });

  r.get('/accounts', async (_req, res) => {
    res.json(await svc.listAccounts());
  });
  r.post('/accounts', jsonBody, async (req, res) => {
    res.status(201).json(await svc.createAccount(parse(S.CreateAccount, req.body), req.actor));
  });
  r.patch('/accounts/:id', jsonBody, async (req, res) => {
    res.json(await svc.updateAccount(req.actor, id(req), parse(S.UpdateAccount, req.body)));
  });
  r.post('/accounts/:id/rotate-key', async (req, res) => {
    res.json(await svc.rotateKey(req.actor, id(req)));
  });

  r.get('/tasks', async (req, res) => {
    res.json(await svc.listTasks(req.actor, parse(S.ListTasks, req.query)));
  });
  r.post('/tasks', jsonBody, async (req, res) => {
    res.status(201).json(await svc.createTask(req.actor, parse(S.CreateTask, req.body)));
  });
  r.get('/tasks/:id', async (req, res) => {
    res.json(await svc.getTask(id(req)));
  });
  r.patch('/tasks/:id', jsonBody, async (req, res) => {
    res.json(await svc.updateTask(req.actor, id(req), parse(S.UpdateTask, req.body)));
  });
  r.post('/tasks/:id/links', jsonBody, async (req, res) => {
    res.status(201).json(await svc.linkTasks(req.actor, id(req), parse(S.LinkTasks, req.body)));
  });
  r.delete('/tasks/:id/links/:linkId', async (req, res) => {
    const linkId = Number(req.params.linkId);
    if (!Number.isSafeInteger(linkId)) throw new HttpError(400, 'invalid link id');
    res.json(await svc.unlinkTasks(req.actor, id(req), linkId));
  });
  r.post('/tasks/:id/result', jsonBody, async (req, res) => {
    res.json(await svc.submitResult(req.actor, id(req), parse(S.SubmitResult, req.body)));
  });
  r.post('/tasks/:id/comments', jsonBody, async (req, res) => {
    res.status(201).json(await svc.addComment(req.actor, id(req), parse(S.AddComment, req.body)));
  });
  r.post('/tasks/:id/runs', jsonBody, async (req, res) => {
    res.status(201).json(await svc.reportRun(req.actor, id(req), parse(S.ReportRun, req.body)));
  });
  r.post('/tasks/:id/time', jsonBody, async (req, res) => {
    res.status(201).json(await svc.logTime(req.actor, id(req), parse(S.LogTime, req.body)));
  });
  r.patch('/time-logs/:id', jsonBody, async (req, res) => {
    res.json(await svc.updateTimeLog(req.actor, id(req), parse(S.UpdateTimeLog, req.body)));
  });
  r.post('/tasks/:id/timer/start', jsonBody, async (req, res) => {
    res.status(201).json(await svc.startTimer(req.actor, id(req), parse(S.StartTimer, req.body)));
  });
  r.post('/tasks/:id/timer/stop', jsonBody, async (req, res) => {
    res.json(await svc.stopTimer(req.actor, id(req), parse(S.StopTimer, req.body)));
  });
  r.post('/tasks/:id/attachments', async (req, res) => {
    res.status(201).json(await uploadFiles(req, id(req)));
  });

  r.get('/attachments/:id/content', async (req, res) => {
    const { row, path } = await svc.getAttachment(id(req));
    // Uploaded HTML/SVG must never run in the tracker's origin.
    const inline = row.kind === 'image' && row.mime !== 'image/svg+xml' || row.kind === 'video';
    // The preview frame asks for the page itself. The sandbox gives it an origin of its own, so its
    // scripts see neither the session nor the API, and nothing is loaded from the network.
    const page = req.query.render === '1' && row.mime === 'text/html';
    const type = inline ? row.mime : page ? 'text/html; charset=utf-8' : svc.isTextMime(row.mime) ? 'text/plain; charset=utf-8' : row.mime;
    res.set({
      'Content-Type': type,
      'Content-Disposition': `${inline || svc.isTextMime(row.mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': page
        ? "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; sandbox allow-scripts"
        : "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    res.sendFile(path, { headers: { 'Content-Type': type }, dotfiles: 'allow' });
  });

  r.get('/passkeys', async (req, res) => {
    res.json(await passkeys.listPasskeys(req.actor));
  });
  r.post('/passkeys/register/options', async (req, res) => {
    res.json(await passkeys.registrationOptions(req.actor));
  });
  r.post('/passkeys/register/verify', jsonBody, async (req, res) => {
    const input = parse(S.PasskeyResponse.extend({ name: z.string().max(80).optional() }), req.body);
    res.status(201).json(await passkeys.verifyRegistration(req.actor, input));
  });
  r.delete('/passkeys/:id', async (req, res) => {
    await passkeys.deletePasskey(req.actor, id(req));
    res.json({ ok: true });
  });

  r.get('/push/key', async (_req, res) => {
    res.json({ key: await push.publicKey() });
  });
  r.get('/push/preferences', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await notifications.getPreferences(req.actor));
  });
  r.patch('/push/preferences', jsonBody, async (req, res) => {
    sameOrigin(req);
    res.set('Cache-Control', 'no-store');
    res.json(await notifications.updatePreferences(req.actor, parse(S.UpdateNotificationPreferences, req.body)));
  });
  r.post('/push/subscriptions', jsonBody, async (req, res) => {
    await push.subscribe(req.actor, parse(S.PushSubscription, req.body), req.headers['user-agent'],req.deviceId);
    res.status(201).json({ ok: true });
  });
  r.delete('/push/subscriptions', jsonBody, async (req, res) => {
    await push.unsubscribe(req.actor, parse(S.PushSubscription.pick({ endpoint: true }), req.body).endpoint);
    res.json({ ok: true });
  });
  r.post('/push/test', jsonBody, async (req, res) => {
    await push.testNotification(req.actor, parse(S.PushSubscription.pick({ endpoint: true }), req.body).endpoint);
    res.json({ ok: true });
  });

  r.post('/push/apns', jsonBody, async (req, res) => {
    const { token, environment } = parse(S.ApnsDevice, req.body);
    await push.registerApnsDevice(req.actor, token, environment,req.deviceId);
    res.status(201).json({ ok: true });
  });
  r.delete('/push/apns', jsonBody, async (req, res) => {
    await push.unregisterApnsDevice(req.actor, parse(S.ApnsDevice.pick({ token: true }), req.body).token);
    res.json({ ok: true });
  });

  // A signal that something has happened, the moment it does. It carries no content: whoever
  // listens reads the inbox as usual, so the stream needs no rules of its own about who sees what.
  r.get('/events/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write(': connected\n\n');
    const tell = (id: number) => res.write(`data: ${id}\n\n`);
    const beat = setInterval(() => res.write(': beat\n\n'), 25_000);
    svc.news.on('event', tell);
    req.on('close', () => {
      clearInterval(beat);
      svc.news.off('event', tell);
    });
  });
  r.get('/inbox', async (req, res) => {
    res.json(await svc.getInbox(req.actor, parse(S.ReadInbox, req.query)));
  });
  r.post('/inbox/read', jsonBody, async (req, res) => {
    res.json(await svc.readTask(req.actor, parse(S.ReadTask, req.body).task_id));
  });
  r.post('/inbox/ack', jsonBody, async (req, res) => {
    res.json(await svc.ackInbox(req.actor, parse(S.AckInbox, req.body).up_to));
  });
  r.get('/activity', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json(await svc.recentActivity(limit));
  });
  r.get('/timeline', async (req, res) => {
    res.json(await svc.timeline(parse(S.Timeline, req.query)));
  });
  r.get('/analytics', async (req, res) => {
    res.json(await svc.analytics(parse(S.Analytics, req.query)));
  });
  r.get('/projects', async (req, res) => {
    res.json(req.query.details ? await svc.listProjectDetails() : await svc.listProjects());
  });
  r.get('/projects/:id', async (req, res) => {
    res.json(await svc.getProject(id(req)));
  });
  r.patch('/projects/:id', jsonBody, async (req, res) => {
    res.json(await svc.updateProject(id(req), parse(S.UpdateProject, req.body)));
  });
  r.put('/projects/:id/logo', async (req, res) => {
    res.json(await svc.setProjectLogo(id(req), { mime: req.headers['content-type'], stream: req }));
  });
  r.get('/projects/:id/logo', async (req, res) => {
    const { path, mime } = await svc.getProjectLogo(id(req));
    res.set({
      'Content-Type': mime,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    res.sendFile(path, { headers: { 'Content-Type': mime }, dotfiles: 'allow' });
  });
  r.post('/projects', jsonBody, async (req, res) => {
    res.status(201).json(await svc.createProject(req.actor, parse(S.CreateProject, req.body)));
  });

  r.use((_req, _res, next) => next(new HttpError(404, 'no such endpoint')));
  return r;
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction): void {
  const status = err instanceof HttpError ? err.status : (err.status ?? err.statusCode ?? 500);
  if (status >= 500) console.error(err);
  if (res.headersSent) return void res.end();
  res.status(status).json({ error: status >= 500 ? 'internal error' : err.message });
}
