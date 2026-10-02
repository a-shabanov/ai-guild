import * as i18n from './i18n.js';
import { classifyClient } from './client-device.js';
// Platform features of the installed app: passkeys, service worker, push, install, offline outbox.

// ---------- passkeys (WebAuthn) ----------

const toBuffer = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer;

function toBase64url(buffer) {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const withIds = (list) => list?.map((c) => ({ ...c, id: toBuffer(c.id) }));

function creationOptions(json) {
  if (PublicKeyCredential.parseCreationOptionsFromJSON) {
    return PublicKeyCredential.parseCreationOptionsFromJSON(json);
  }
  return {
    ...json,
    challenge: toBuffer(json.challenge),
    user: { ...json.user, id: toBuffer(json.user.id) },
    excludeCredentials: withIds(json.excludeCredentials),
  };
}

function requestOptions(json) {
  if (PublicKeyCredential.parseRequestOptionsFromJSON) {
    return PublicKeyCredential.parseRequestOptionsFromJSON(json);
  }
  return {
    ...json,
    challenge: toBuffer(json.challenge),
    allowCredentials: withIds(json.allowCredentials),
  };
}

function credentialJSON(credential) {
  if (credential.toJSON) return credential.toJSON();
  const r = credential.response;
  const response = { clientDataJSON: toBase64url(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = toBase64url(r.attestationObject);
    response.transports = r.getTransports?.() ?? [];
  } else {
    response.authenticatorData = toBase64url(r.authenticatorData);
    response.signature = toBase64url(r.signature);
    if (r.userHandle) response.userHandle = toBase64url(r.userHandle);
  }
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response,
  };
}

/** Why passkeys cannot be used here, or null when they can. */
export function passkeyBlocker(config) {
  if (!window.PublicKeyCredential || !navigator.credentials) return i18n.t('Браузер не поддерживает passkeys');
  if (!isSecureContext) return i18n.t('Passkeys работают только по HTTPS или на localhost');
  const origins = config?.passkeys?.origins ?? [];
  if (!origins.includes(location.origin)) {
    return i18n.t`Passkeys настроены для ${origins.join(', ') || i18n.t('другого адреса')}, а вы открыли ${location.origin}`;
  }
  return null;
}

function friendly(err) {
  if (err?.name === 'NotAllowedError') return new Error(i18n.t('Проверка отменена'));
  if (err?.name === 'InvalidStateError') return new Error(i18n.t('Этот passkey уже добавлен'));
  if (err?.name === 'SecurityError') return new Error(i18n.t('Passkeys недоступны на этом адресе'));
  return err;
}

export async function passkeySignIn(api) {
  const { challenge_id, options } = await api('POST', '/passkeys/login/options');
  let credential;
  try {
    credential = await navigator.credentials.get({ publicKey: requestOptions(options) });
  } catch (err) {
    throw friendly(err);
  }
  return api('POST', '/passkeys/login/verify', { challenge_id, response: credentialJSON(credential) });
}

export async function passkeyRegister(api, name) {
  const { challenge_id, options } = await api('POST', '/passkeys/register/options');
  let credential;
  try {
    credential = await navigator.credentials.create({ publicKey: creationOptions(options) });
  } catch (err) {
    throw friendly(err);
  }
  return api('POST', '/passkeys/register/verify', {
    challenge_id,
    name,
    response: credentialJSON(credential),
  });
}

export function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  return i18n.t('Это устройство');
}

// Random installation id, scoped to this site's storage; never a hardware fingerprint.
let installationId;
export function clientDescriptor({userAgent=navigator.userAgent,touchPoints=navigator.maxTouchPoints,
  standalone=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true}={}) {
  return classifyClient({userAgent,touchPoints,standalone});
}
export function clientHeaders() {
  if(!installationId){
    try{installationId=localStorage.getItem('ai-guild-device-id');}catch{}
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(installationId??'')){
      const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
      const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
      installationId=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
      try{localStorage.setItem('ai-guild-device-id',installationId);}catch{}
    }
  }
  const client=clientDescriptor();
  return {'X-Device-Id':installationId,'X-Client-Type':client.client_type,'X-Client-Platform':client.platform};
}

/** What the device calls its biometric check, for button labels. */
export function biometryName() {
  const device = deviceName();
  if (device === 'iPhone' || device === 'iPad') return 'Face ID';
  if (device === 'Mac') return 'Touch ID';
  return 'passkey';
}

// ---------- service worker ----------

export async function registerServiceWorker(onNavigate) {
  if (!('serviceWorker' in navigator)) return;
  let worker;
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type !== 'navigate') return;
    let url;
    try { url = new URL(event.data.url, location.origin); } catch { return; }
    if (url.origin !== location.origin || !url.hash.startsWith('#/')) return;
    onNavigate(url.href);
    (event.source ?? worker)?.postMessage({ type: 'navigation-ack', url: url.href });
  });
  const ready = () => (navigator.serviceWorker.controller ?? worker)?.postMessage({ type: 'navigation-ready' });
  navigator.serviceWorker.addEventListener('controllerchange', ready);
  addEventListener('pageshow', ready);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ready(); });
  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    worker = registration.active ?? (await navigator.serviceWorker.ready).active;
    ready();
  } catch (err) {
    console.warn('service worker registration failed', err);
  }
}

export async function updateApp() {
  if (!navigator.onLine) throw new Error(i18n.t('Для обновления приложения нужна сеть'));
  const registration = await navigator.serviceWorker?.getRegistration();
  if (registration) {
    await registration.update();
    const worker = registration.installing || registration.waiting;
    if (worker && worker.state !== 'activated') {
      await new Promise((resolve, reject) => {
        const finish = () => {
          if (!['activated', 'redundant'].includes(worker.state)) return;
          clearTimeout(timeout);
          worker.removeEventListener('statechange', finish);
          worker.state === 'activated' ? resolve() : reject(new Error(i18n.t('Не удалось обновить приложение. Попробуйте ещё раз.')));
        };
        const timeout = setTimeout(() => {
          worker.removeEventListener('statechange', finish);
          reject(new Error(i18n.t('Не удалось обновить приложение. Попробуйте ещё раз.')));
        }, 15000);
        worker.addEventListener('statechange', finish);
        finish();
      });
    }
  }
  location.reload();
}

export function forgetPrivateData() {
  navigator.serviceWorker?.controller?.postMessage({ type: 'logout' });
  try {
    localStorage.removeItem(OUTBOX);
  } catch {}
  setBadge(0);
}

export function setBadge(count) {
  if (!('setAppBadge' in navigator)) return;
  (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
}

// ---------- push ----------

export const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export const isIOS = () => ['iPhone', 'iPad'].includes(deviceName());

/** Why push cannot be turned on here, or null when it can. */
export function pushBlocker() {
  if (isIOS() && !isStandalone()) {
    return i18n.t('На iPhone добавьте приложение на экран «Домой» через меню «Поделиться» в Safari, затем откройте его с иконки. Требуется iOS 16.4 или новее.');
  }
  if (!isSecureContext) return i18n.t('Уведомления работают только по HTTPS или на localhost');
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return i18n.t('Браузер не поддерживает push-уведомления');
  }
  if (Notification.permission === 'denied') return isIOS()
    ? i18n.t('Разрешите уведомления для AI Guild в настройках iPhone → Уведомления, затем вернитесь в приложение.')
    : i18n.t('Уведомления запрещены в настройках браузера');
  return null;
}

async function currentSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

export async function pushEnabled(api) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  const subscription = await currentSubscription();
  if (!subscription) return false;
  // Restore the association after a server restore or signing into another account.
  if (api) await api('POST', '/push/subscriptions', subscription.toJSON());
  return true;
}

export async function enablePush(api) {
  const blocker = pushBlocker();
  if (blocker) throw new Error(blocker);
  // Keep this call directly in the tap handler: iOS requires user activation.
  if ((await Notification.requestPermission()) !== 'granted') {
    throw new Error(i18n.t('Вы не разрешили уведомления'));
  }
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration?.active) throw new Error(i18n.t('Приложение ещё готовится. Попробуйте включить уведомления через несколько секунд.'));
  const { key } = await api('GET', '/push/key');
  let subscription = await registration.pushManager.getSubscription();
  const expectedKey = new Uint8Array(toBuffer(key));
  const existingKey = subscription?.options?.applicationServerKey;
  if (existingKey && toBase64url(existingKey) !== toBase64url(expectedKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  const created = !subscription;
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: toBuffer(key),
  });
  try {
    await api('POST', '/push/subscriptions', subscription.toJSON());
  } catch (err) {
    if (created) await subscription.unsubscribe();
    throw err;
  }
}

export async function disablePush(api) {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await api('DELETE', '/push/subscriptions', { endpoint: subscription.endpoint });
  if (!(await subscription.unsubscribe())) throw new Error(i18n.t('Не удалось отключить уведомления на устройстве. Попробуйте ещё раз.'));
}

export async function testPush(api) {
  const subscription = await currentSubscription();
  if (!subscription) throw new Error(i18n.t('Сначала включите уведомления'));
  await api('POST', '/push/subscriptions', subscription.toJSON());
  await api('POST', '/push/test', { endpoint: subscription.endpoint });
}

// ---------- install ----------

let installPrompt = null;
const installListeners = new Set();

addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  installListeners.forEach((fn) => fn());
});
addEventListener('appinstalled', () => {
  installPrompt = null;
  installListeners.forEach((fn) => fn());
});

export const onInstallChange = (fn) => installListeners.add(fn);
export const canPromptInstall = () => installPrompt !== null;

export async function promptInstall() {
  if (!installPrompt) return false;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  return outcome === 'accepted';
}

// ---------- offline outbox (comments written without a connection) ----------

const OUTBOX = 'ait-outbox';

function readOutbox() {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX) ?? '[]');
  } catch {
    return [];
  }
}

function writeOutbox(items) {
  try {
    localStorage.setItem(OUTBOX, JSON.stringify(items));
  } catch {}
}

export const isNetworkError = (err) => err instanceof TypeError || err?.offline === true;

export const pendingComments = (taskId) => readOutbox().filter((c) => c.taskId === taskId);

export function queueComment(taskId, body, reopen) {
  writeOutbox([...readOutbox(), { id: crypto.randomUUID(), taskId, body, reopen, at: new Date().toISOString() }]);
}

let flushing = false;

/** Sends queued comments in order; returns how many went through. */
export async function flushOutbox(api) {
  if (flushing) return 0;
  flushing = true;
  let sent = 0;
  try {
    for (const item of readOutbox()) {
      try {
        await api('POST', `/tasks/${item.taskId}/comments`, { body: item.body });
        if (item.reopen) await api('PATCH', `/tasks/${item.taskId}`, { status: 'in_progress' });
        sent++;
      } catch (err) {
        if (isNetworkError(err)) break;
        // The server refused it (task deleted, signed out): retrying would never succeed.
      }
      writeOutbox(readOutbox().filter((c) => c.id !== item.id));
    }
  } finally {
    flushing = false;
  }
  return sent;
}

// ---------- share target ----------

/** Content handed over by the OS share sheet, or null. Reading it consumes it. */
export async function takeShare() {
  if (!('caches' in window)) return null;
  const cache = await caches.open('share');
  const meta = await cache.match('/__share/meta');
  if (!meta) return null;
  const { title, text, files } = await meta.json();
  const loaded = [];
  for (let i = 0; i < files.length; i++) {
    const res = await cache.match(`/__share/file/${i}`);
    if (res) loaded.push(new File([await res.blob()], files[i], { type: res.headers.get('content-type') }));
  }
  for (const key of await cache.keys()) await cache.delete(key);
  return { title, text, files: loaded };
}
