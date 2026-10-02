// Push: tells a person's devices when someone acts on a task they are involved in.
// Browsers and the installed PWA get Web Push; the native iOS app gets APNs.
// Must not import service.ts (service.ts calls notifyEvent).
import webpush from 'web-push';
import { sendApns } from './apns.ts';
import type { Actor } from './auth.ts';
import { config } from './config.ts';
import { q, q1, type Row } from './db.ts';
import { HttpError } from './errors.ts';

type Vapid = { publicKey: string; privateKey: string };
let vapid: Promise<Vapid> | undefined;

// Keys come from the environment, or are generated once and kept in the database:
// changing them invalidates every existing subscription.
function vapidKeys(): Promise<Vapid> {
  return (vapid ??= (async () => {
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
    if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
      return { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY };
    }
    await q(
      `insert into settings(key, value) values ('vapid', $1) on conflict (key) do nothing`,
      [JSON.stringify(webpush.generateVAPIDKeys())],
    );
    return (await q1(`select value from settings where key = 'vapid'`))!.value as Vapid;
  })());
}

const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

export async function publicKey(): Promise<string> {
  return (await vapidKeys()).publicKey;
}

export async function subscribe(
  actor: Actor,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  userAgent?: string,
  deviceId?: number,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(sub.endpoint);
  } catch {
    throw new HttpError(400, 'invalid push endpoint');
  }
  // The server will POST to this URL, so only real push services are accepted.
  if (url.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(url.hostname))) {
    throw new HttpError(400, 'unsupported push service');
  }
  await q(
    `insert into push_subscriptions(account_id, endpoint, p256dh, auth, user_agent, device_id)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (endpoint) do update
       set account_id = excluded.account_id, p256dh = excluded.p256dh, auth = excluded.auth,device_id=excluded.device_id`,
    [actor.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent?.slice(0, 300) ?? null,deviceId??null],
  );
}

export async function unsubscribe(actor: Actor, endpoint: string): Promise<void> {
  await q('delete from push_subscriptions where account_id = $1 and endpoint = $2', [
    actor.id,
    endpoint,
  ]);
}

const STATUS: Record<string, string> = {
  todo: 'К выполнению',
  in_progress: 'В работе',
  review: 'На проверке',
  blocked: 'Заблокирована',
  done: 'Готово',
  cancelled: 'Отменена',
};

function describe(e: Row): string {
  const d = e.data;
  switch (e.type) {
    case 'comment_added':
      return String(d.body ?? '').slice(0, 180);
    case 'result_submitted':
      return `Результат → ${STATUS[d.to] ?? d.to}`;
    case 'status_changed':
      return `Статус: ${STATUS[d.from] ?? d.from} → ${STATUS[d.to] ?? d.to}`;
    case 'task_assigned':
      return d.assignee ? `Исполнитель: ${d.assignee}` : 'Исполнитель снят';
    case 'task_created':
      return d.assignee ? `Новая задача для ${d.assignee}` : 'Новая задача';
    case 'attachment_added':
      return `Файл: ${d.filename}`;
    default:
      return 'Задача изменена';
  }
}

export async function registerApnsDevice(
  actor: Actor,
  token: string,
  environment: 'sandbox' | 'production',
  deviceId?: number,
): Promise<void> {
  await q(
    `insert into apns_devices(account_id, token, environment, device_id) values ($1, $2, $3, $4)
     on conflict (token) do update
       set account_id = excluded.account_id, environment = excluded.environment,device_id=excluded.device_id`,
    [actor.id, token.toLowerCase(), environment,deviceId??null],
  );
}

export async function unregisterApnsDevice(actor: Actor, token: string): Promise<void> {
  await q('delete from apns_devices where account_id = $1 and token = $2', [
    actor.id,
    token.toLowerCase(),
  ]);
}

// Same audience as the inbox: everyone involved in the task or @mentioned, plus people
// overseeing the agents' new tasks, results and blockers; never the actor.
export async function notifyEvent(eventId: number): Promise<void> {
  const recipients = await q(
    `select r.id as account_id, e.type, e.data, e.task_id, t.title, ac.name as actor_name
       from events e
       join tasks t on t.id = e.task_id
       join accounts ac on ac.id = e.actor_id
       join accounts r on r.id <> e.actor_id and not r.disabled
      where e.id = $1 and e.type <> 'task_edited'
        and (exists (select 1 from push_subscriptions s where s.account_id = r.id)
             or exists (select 1 from apns_devices d where d.account_id = r.id))
        and (t.assignee_id = r.id or t.created_by = r.id
             or exists (select 1 from comments c where c.task_id = t.id and c.author_id = r.id)
             or position(lower('@' || r.name) in lower(coalesce(e.data->>'body', ''))) > 0
             or (r.kind = 'human' and (e.type in ('task_created', 'result_submitted')
                 or (e.type = 'status_changed' and e.data->>'to' in ('review', 'blocked')))))`,
    [eventId],
  );
  if (!recipients.length) return;

  const event = recipients[0]!;
  const ids = recipients.map((r) => r.account_id);
  const message = {
    title: `${event.actor_name} · #${event.task_id} ${event.title}`.slice(0, 120),
    body: describe(event),
    url: `/#/tasks/${event.task_id}`,
    tag: `task-${event.task_id}`,
    task_id: event.task_id as number,
  };
  const [subs, devices] = await Promise.all([
    q('select id, endpoint, p256dh, auth from push_subscriptions where account_id = any($1)', [ids]),
    q('select id, token, environment from apns_devices where account_id = any($1)', [ids]),
  ]);

  const keys = subs.length ? await vapidKeys() : undefined;
  await Promise.all([
    ...subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(message),
          {
            vapidDetails: { subject: config.vapidSubject, ...keys! },
            TTL: 24 * 3600,
            timeout: 10_000,
          },
        );
      } catch (err: any) {
        // The browser dropped this subscription; stop sending to it.
        if (err.statusCode === 404 || err.statusCode === 410) {
          await q('delete from push_subscriptions where id = $1', [s.id]);
        } else {
          console.error(`push to ${new URL(s.endpoint).host} failed: ${err.statusCode ?? err.message}`);
        }
      }
    }),
    ...devices.map(async (d) => {
      const result = await sendApns(d.token, d.environment, message).catch((err) => ({
        status: 0,
        reason: String(err.message ?? err),
      }));
      if (!result) return;
      // Apple says the app was removed or the token is no longer valid.
      if (result.status === 410 || ['BadDeviceToken', 'Unregistered'].includes(result.reason)) {
        await q('delete from apns_devices where id = $1', [d.id]);
      } else if (result.status !== 200) {
        console.error(`APNs push failed: ${result.status} ${result.reason}`);
      }
    }),
  ]);
}
