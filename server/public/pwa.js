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
  if (!window.PublicKeyCredential || !navigator.credentials) return 'Браузер не поддерживает passkeys';
  if (!isSecureContext) return 'Passkeys работают только по HTTPS или на localhost';
  const origins = config?.passkeys?.origins ?? [];
  if (!origins.includes(location.origin)) {
    return `Passkeys настроены для ${origins.join(', ') || 'другого адреса'}, а вы открыли ${location.origin}`;
  }
  return null;
}

function friendly(err) {
  if (err?.name === 'NotAllowedError') return new Error('Проверка отменена');
  if (err?.name === 'InvalidStateError') return new Error('Этот passkey уже добавлен');
  if (err?.name === 'SecurityError') return new Error('Passkeys недоступны на этом адресе');
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
  return 'Это устройство';
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
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'navigate') onNavigate(event.data.url);
  });
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.warn('service worker registration failed', err);
  }
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
    return 'На iPhone уведомления работают только в установленном приложении';
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'Браузер не поддерживает push-уведомления';
  }
  if (Notification.permission === 'denied') return 'Уведомления запрещены в настройках браузера';
  return null;
}

async function currentSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

export async function pushEnabled() {
  return Notification.permission === 'granted' && (await currentSubscription()) !== null;
}

export async function enablePush(api) {
  if ((await Notification.requestPermission()) !== 'granted') {
    throw new Error('Вы не разрешили уведомления');
  }
  const registration = await navigator.serviceWorker.ready;
  const { key } = await api('GET', '/push/key');
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: toBuffer(key),
  });
  try {
    await api('POST', '/push/subscriptions', subscription.toJSON());
  } catch (err) {
    await subscription.unsubscribe();
    throw err;
  }
}

export async function disablePush(api) {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await api('DELETE', '/push/subscriptions', { endpoint: subscription.endpoint }).catch(() => {});
  await subscription.unsubscribe();
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
