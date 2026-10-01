// AI Guild web UI. No build step, no dependencies. All DOM is built with h(), never innerHTML,
// so text coming from agents cannot inject markup.

import * as pwa from './pwa.js';

const STATUS = {
  todo: 'К выполнению',
  in_progress: 'В работе',
  review: 'На проверке',
  blocked: 'Заблокирована',
  done: 'Готово',
  cancelled: 'Отменена',
};
const PRIORITY = { low: 'Низкий', normal: 'Обычный', high: 'Высокий', urgent: 'Срочный' };
const LEVEL = { epic: 'Эпик', story: 'Стори', task: 'Таск', subtask: 'Подтаск' };
const LEVELS = Object.keys(LEVEL);
const KIND = { visual: 'Визуал', technical: 'Техническая' };
const LINK = {
  blocks: 'Блокирует',
  blocked_by: 'Заблокирована задачей',
  relates: 'Связана с',
  duplicates: 'Дублирует',
  duplicated_by: 'Дублируется задачей',
};
const GROUPS = {
  worker: 'Исполнитель записи',
  model: 'Модель',
  effort: 'Effort',
  account: 'Аккаунт',
  system: 'Система',
  project: 'Проект',
  task: 'Задача',
};

const state = { me: null, accounts: [], inboxCount: 0, poll: null, config: null };
const app = document.getElementById('app');

// ---------- helpers ----------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

async function api(method, path, body) {
  const isForm = body instanceof FormData;
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: body && !isForm ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
  } catch {
    setOffline(true);
    throw Object.assign(new Error('Нет соединения с сервером'), { offline: true });
  }
  // The service worker marks answers it served from its cache while the network was down.
  setOffline(res.headers.has('X-From-Cache'));
  const data = await res.json().catch(() => null);
  if (res.status === 401 && state.me) {
    state.me = null;
    render();
  }
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

function fmtDuration(seconds) {
  const s = Math.round(seconds ?? 0);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин`;
  const hrs = Math.floor(m / 60);
  return m % 60 ? `${hrs} ч ${m % 60} мин` : `${hrs} ч`;
}

function fmtCompact(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return Math.round(n).toLocaleString('ru-RU');
}

const fmtMoney = (n) =>
  '$' + Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} КБ`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
  return `${(bytes / 1024 ** 3).toFixed(2)} ГБ`;
}

const rtf = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });
function fmtAgo(iso) {
  const diff = (new Date(iso) - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return 'только что';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return new Date(iso).toLocaleDateString('ru-RU');
}
const fmtDate = (iso) => new Date(iso).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
const time = (iso) => h('time', { datetime: iso, title: fmtDate(iso), class: 'muted small' }, fmtAgo(iso));

const statusChip = (s) => h('span', { class: `chip st-${s}` }, h('span', { class: 'dot' }), STATUS[s] ?? s);
const levelChip = (level) => h('span', { class: `chip level level-${level}` }, LEVEL[level] ?? level);
const kindChip = (kind) => kind && h('span', { class: `chip kind-${kind}` }, KIND[kind] ?? kind);

// Parents first, each followed by its children; tasks whose parent is not in the list
// (filtered out, or in another project) start their own branch.
function asTree(tasks) {
  const ids = new Set(tasks.map((t) => t.id));
  const children = new Map();
  for (const t of tasks) {
    const key = ids.has(t.parent_id) ? t.parent_id : null;
    children.set(key, [...(children.get(key) ?? []), t]);
  }
  const out = [];
  const walk = (key, depth) => {
    for (const t of children.get(key) ?? []) {
      out.push([t, depth]);
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

// People are circles, agents are rounded squares; every agent system has its own colour,
// and two letters tell apart names that start the same (claude, codex).
const AGENT_COLORS = { claude: '#c2603f', codex: '#0f8a6c' };
const SPARE_COLORS = ['#4a3aa7', '#a3358f', '#2a78d6', '#8a6d00', '#b03a3a', '#3d7a1f'];

function avatarColor(account, name) {
  const known = AGENT_COLORS[(account?.system ?? name ?? '').toLowerCase()];
  if (known) return known;
  let hash = 0;
  for (const ch of name ?? '') hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return SPARE_COLORS[hash % SPARE_COLORS.length];
}

function avatar(name, kind) {
  const account = state.accounts.find((a) => a.name === name);
  const who = kind ?? account?.kind ?? 'agent';
  const system = (account?.system ?? name ?? '').toLowerCase();
  const image = who === 'agent' && ['claude', 'codex'].includes(system) ? `/avatars/${system}.png` : null;
  return h(
    'span',
    { class: `avatar ${who}`, 'aria-hidden': 'true', style: image ? 'background:transparent' : who === 'human' ? '' : `background:${avatarColor(account, name)}` },
    image ? h('img', { src: image, alt: '' }) : (name ?? '?').slice(0, 1).toUpperCase() + (name ?? '').slice(1, 2).toLowerCase(),
  );
}
const kindOf = (name) => state.accounts.find((a) => a.name === name)?.kind;

// An entry that an agent wrote down for a person: who did it, and the person's own words.
const recordedChip = (name) => name && h('span', { class: 'chip', title: 'Записано агентом со слов автора' }, `записал ${name}`);
const originalWords = (text) =>
  text && h('details', { class: 'original' }, h('summary', null, 'Исходное сообщение'), h('blockquote', null, text));

function runChips(model, effort) {
  return [
    model && h('span', { class: 'chip mono', title: 'Модель' }, model),
    effort && h('span', { class: 'chip mono', title: 'Effort' }, effort),
  ];
}

// Minimal markdown: fenced code, headings, lists, inline code, bold, links, @mentions.
// Images are only ever loaded from this tracker: an attachment of the task, by file name,
// by "attachment:12" or by its URL. Anything else stays text, so a description cannot make
// the reader's browser call a third-party server.
function resolveImage(ref, files) {
  const byId = /^(?:attachment:|\/api\/attachments\/)(\d+)(?:\/content)?$/.exec(ref);
  const name = decodeURIComponent(ref).split('/').pop();
  const file = byId
    ? files.find((f) => f.id === Number(byId[1]))
    : files.findLast((f) => f.filename === name);
  if (file) return file.kind === 'image' && file.mime !== 'image/svg+xml' ? file : null;
  return byId ? { id: Number(byId[1]), url: `/api/attachments/${byId[1]}/content`, filename: ref } : null;
}

const IMAGE = /!\[([^\]\n]*)\]\(([^)\s]+)\)/g;

/** Ids of the attachments that the text shows inline. */
function inlineImageIds(text, files) {
  return [...(text ?? '').matchAll(IMAGE)].map((m) => resolveImage(m[2], files)?.id).filter(Boolean);
}

function inline(text, files = []) {
  const out = [];
  const re = /!\[(?<alt>[^\]\n]*)\]\((?<src>[^)\s]+)\)|`(?<code>[^`\n]+)`|\*\*(?<bold>[^*\n]+)\*\*|\[(?<label>[^\]\n]+)\]\((?<href>https?:\/\/[^\s)]+)\)|(?<url>https?:\/\/[^\s<>)]+)|(?<pre>^|\s)@(?<mention>[\w.-]+)/g;
  let last = 0;
  for (let m; (m = re.exec(text)); ) {
    out.push(text.slice(last, m.index));
    const g = m.groups;
    if (g.src != null) {
      const image = resolveImage(g.src, files);
      out.push(
        image
          ? h('a', { class: 'md-img', href: image.url, target: '_blank', onclick: image.id && ((e) => (e.preventDefault(), openViewer(files.some((f) => f.id === image.id) ? files : [image], image))) }, h('img', { src: image.url, alt: g.alt || image.filename, loading: 'lazy' }))
          : h('span', { class: 'muted', title: 'Приложите файл к задаче, чтобы картинка появилась' }, `[изображение: ${g.alt || g.src}]`),
      );
    } else if (g.code != null) out.push(h('code', null, g.code));
    else if (g.bold != null) out.push(h('strong', null, g.bold));
    else if (g.label != null) out.push(h('a', { href: g.href, target: '_blank', rel: 'noopener noreferrer' }, g.label));
    else if (g.url != null) out.push(h('a', { href: g.url, target: '_blank', rel: 'noopener noreferrer' }, g.url));
    else out.push(g.pre, h('span', { class: 'mention' }, '@' + g.mention));
    last = re.lastIndex;
  }
  out.push(text.slice(last));
  return out;
}

// Pasting or dropping a picture into a text field attaches it and writes its markdown.
// Typing "@" offers the accounts; the list narrows with every letter.
let mentionMenus = 0;
function offerMentions(textarea) {
  const id = `mentions-${++mentionMenus}`;
  const menu = h('ul', { class: 'mention-menu', role: 'listbox', id, hidden: true, 'aria-label': 'Кого упомянуть' });
  let found = [];
  let at = 0;
  let from = -1;

  const close = () => {
    menu.hidden = true;
    from = -1;
    textarea.setAttribute('aria-expanded', 'false');
    textarea.removeAttribute('aria-activedescendant');
  };
  const paint = () => {
    menu.replaceChildren(
      ...found.map((a, i) =>
        h(
          'li',
          {
            role: 'option',
            id: `${id}-${i}`,
            'aria-selected': String(i === at),
            // Keeps the focus in the text while the mouse picks.
            onmousedown: (e) => (e.preventDefault(), pick(i)),
            onmousemove: () => i !== at && ((at = i), paint()),
          },
          avatar(a.name, a.kind),
          h('span', null, a.name),
          h('span', { class: 'muted small' }, a.kind === 'human' ? 'человек' : a.system ?? 'агент'),
        ),
      ),
    );
    textarea.setAttribute('aria-activedescendant', `${id}-${at}`);
    menu.children[at]?.scrollIntoView({ block: 'nearest' });
  };
  const pick = (i) => {
    const name = found[i].name;
    const caret = textarea.selectionStart;
    const after = textarea.value.slice(caret);
    textarea.value = `${textarea.value.slice(0, from)}@${name}${after.startsWith(' ') ? '' : ' '}${after}`;
    const to = from + name.length + 2;
    textarea.setSelectionRange(to, to);
    close();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const look = () => {
    const before = textarea.value.slice(0, textarea.selectionStart);
    const m = /(^|\s)@([\w.-]*)$/.exec(before);
    if (!m) return close();
    const typed = m[2].toLowerCase();
    found = state.accounts
      .filter((a) => !a.disabled && a.name !== state.me.name && a.name.toLowerCase().includes(typed))
      .sort((a, b) => a.name.toLowerCase().indexOf(typed) - b.name.toLowerCase().indexOf(typed) || a.name.localeCompare(b.name))
      .slice(0, 8);
    // Nothing to offer once the name is complete.
    if (!found.length || (found.length === 1 && found[0].name.toLowerCase() === typed)) return close();
    from = before.length - m[2].length - 1;
    at = Math.min(at, found.length - 1);
    if (!menu.isConnected) textarea.after(menu);
    menu.style.top = `${textarea.offsetTop + textarea.offsetHeight + 4}px`;
    menu.style.left = `${textarea.offsetLeft}px`;
    menu.hidden = false;
    textarea.setAttribute('aria-expanded', 'true');
    paint();
  };

  Object.entries({ role: 'combobox', 'aria-autocomplete': 'list', 'aria-controls': id, 'aria-expanded': 'false' }).forEach(([k, v]) =>
    textarea.setAttribute(k, v),
  );
  textarea.addEventListener('input', look);
  textarea.addEventListener('click', look);
  textarea.addEventListener('blur', close);
  textarea.addEventListener('keydown', (e) => {
    if (menu.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      at = (at + (e.key === 'ArrowDown' ? 1 : found.length - 1)) % found.length;
      paint();
    } else if (e.key === 'Enter' || e.key === 'Tab') pick(at);
    else if (e.key === 'Escape') {
      close();
      // The dialog around the field must not take this press as "close me".
      e.stopPropagation();
    } else return;
    e.preventDefault();
  });
  return textarea;
}

function acceptImages(textarea, attach) {
  const take = (list) => {
    const images = [...(list ?? [])].filter((f) => f.type.startsWith('image/'));
    for (const file of images) {
      const ext = (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
      const generic = !file.name || /^image\.\w+$/i.test(file.name);
      const name = generic ? `image-${Date.now().toString(36)}.${ext}` : file.name.replace(/[\s()\[\]]+/g, '-');
      attach(new File([file], name, { type: file.type }));
      const at = textarea.selectionStart ?? textarea.value.length;
      const before = textarea.value.slice(0, at);
      const snippet = `${before && !before.endsWith('\n') ? '\n' : ''}![](${name})\n`;
      textarea.setRangeText(snippet, at, textarea.selectionEnd ?? at, 'end');
    }
    return images.length > 0;
  };
  textarea.addEventListener('paste', (e) => take(e.clipboardData?.files) && e.preventDefault());
  textarea.addEventListener('dragover', (e) => e.preventDefault());
  textarea.addEventListener('drop', (e) => take(e.dataTransfer?.files) && e.preventDefault());
}

async function uploadFiles(taskId, files, commentId) {
  if (!files.length) return;
  const fd = new FormData();
  for (const f of files) fd.append('file', f);
  await api('POST', `/tasks/${taskId}/attachments${commentId ? `?comment_id=${commentId}` : ''}`, fd);
}

function markdown(src, files = []) {
  const root = h('div', { class: 'md' });
  const lines = (src ?? '').replace(/\r\n/g, '\n').split('\n');
  let para = [];
  let list = null;
  const flush = () => {
    if (para.length) root.append(h('p', null, para.flatMap((l, i) => [i ? h('br') : null, inline(l, files)])));
    para = [];
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flush();
      const code = [];
      while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i]);
      root.append(h('pre', null, h('code', null, code.join('\n'))));
      continue;
    }
    const heading = /^#{1,6}\s+(.*)/.exec(line);
    const item = /^\s*(?:[-*]|(\d+)[.)])\s+(.*)/.exec(line);
    if (heading) {
      flush();
      root.append(h('h4', null, inline(heading[1], files)));
    } else if (item) {
      if (!list) {
        flush();
        list = h(item[1] ? 'ol' : 'ul');
        root.append(list);
      }
      list.append(h('li', null, inline(item[2], files)));
    } else if (!line.trim()) {
      flush();
    } else {
      if (list) flush();
      para.push(line);
    }
  }
  flush();
  return root;
}

function setOffline(offline) {
  if (document.body.classList.contains('offline') === offline) return;
  document.body.classList.toggle('offline', offline);
  if (!offline) flushOutbox();
}

let toastTimer;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

async function flushOutbox() {
  const sent = await pwa.flushOutbox(api).catch(() => 0);
  if (sent) {
    toast(sent === 1 ? 'Отложенный комментарий отправлен' : `Отправлено отложенных комментариев: ${sent}`);
    state.poll?.().catch(() => {});
  }
}

// ---------- tooltip (chart hover layer) ----------

const tip = document.getElementById('tooltip');
function withTip(el, title, body) {
  const show = (e) => {
    tip.replaceChildren(h('b', null, title), body);
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    const x = e.clientX ?? el.getBoundingClientRect().left;
    const y = e.clientY ?? el.getBoundingClientRect().top;
    tip.style.left = Math.max(8, Math.min(x + 12, innerWidth - r.width - 8)) + 'px';
    tip.style.top = Math.max(8, y - r.height - 12) + 'px';
  };
  el.addEventListener('pointermove', show);
  el.addEventListener('focus', show);
  el.addEventListener('pointerleave', () => (tip.hidden = true));
  el.addEventListener('blur', () => (tip.hidden = true));
  el.tabIndex = 0;
  return el;
}

// ---------- shell ----------

// "0.2.0 (7)": the version and the build number of the server that answers.
const release = () => (state.config?.version ? `${state.config.version} (${state.config.build})` : '');

function shell(active, ...content) {
  const link = (href, label, key, extra, cls = '') =>
    h('a', { href, class: `${cls} ${active === key ? 'active' : ''}` }, label, extra);
  return [
    h(
      'header',
      { class: 'topbar' },
      h('a', { class: 'brand', href: '#/projects', title: release() && `Версия ${release()}` }, h('img', { class: 'brand-icon', src: '/icons/favicon-32.png', alt: '' }), 'AI Guild', h('span', { class: 'version desktop-only' }, state.config?.version ? `${state.config.version} · ${state.config.build}` : '')),
      h(
        'nav',
        { class: 'nav row', style: 'flex-wrap:nowrap;gap:2px' },
        link('#/projects', 'Проекты', 'projects'),
        link('#/board', 'Доска', 'board'),
        link('#/timeline', 'График', 'timeline', null, 'desktop-only'),
        link('#/tasks', 'Задачи', 'tasks', null, 'desktop-only'),
        link('#/inbox', 'Входящие', 'inbox', state.inboxCount ? h('span', { class: 'badge' }, String(state.inboxCount)) : null),
        link('#/analytics', 'Аналитика', 'analytics', null, 'desktop-only'),
        link('#/accounts', 'Аккаунты', 'accounts', null, 'desktop-only'),
        link('#/connect', 'Подключение', 'connect', null, 'desktop-only'),
      ),
      h('span', { class: 'spacer' }),
      h(
        'a',
        { href: '#/profile', class: `row profile-link ${active === 'profile' ? 'active' : ''}`, style: 'flex-wrap:nowrap', title: 'Профиль и устройство' },
        avatar(state.me.name, state.me.kind),
        h('span', { class: 'small' }, state.me.name),
      ),
    ),
    h('div', { class: 'offline-bar', role: 'status' }, 'Нет сети — показаны сохранённые данные'),
    h('main', null, content),
  ];
}

async function logout() {
  await pwa.disablePush(api).catch(() => {});
  await fetch('/api/session', { method: 'DELETE' }).catch(() => {});
  pwa.forgetPrivateData();
  state.me = null;
  render();
}

function loginView() {
  const err = h('div', { class: 'error small', role: 'alert' });
  const input = h('input', { type: 'password', name: 'key', placeholder: 'ait_…', required: true, autocomplete: 'off' });
  const passkeys = pwa.passkeyBlocker(state.config) === null;
  const withPasskey = async (e) => {
    err.textContent = '';
    e.currentTarget.disabled = true;
    try {
      await pwa.passkeySignIn(api);
      await boot();
    } catch (ex) {
      err.textContent = ex.message === 'passkey sign-in failed' ? 'Этот passkey не подходит' : ex.message;
      e.target.disabled = false;
    }
  };
  return h(
    'main',
    null,
    h(
      'form',
      {
        class: 'card pad stack login',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          try {
            await api('POST', '/session', { key: input.value });
            state.signedInWithKey = true;
            await boot();
          } catch (ex) {
            err.textContent =
              ex.message === 'invalid API key'
                ? 'Такого ключа нет. Возможно, его перевыпустили.'
                : ex.message === 'missing or malformed API key'
                  ? 'Это не ключ. Ключ — длинная строка, которая начинается с ait_; имя аккаунта не подходит.'
                  : ex.message;
          }
        },
      },
      h('h1', null, 'AI Guild'),
      h('p', { class: 'muted', style: 'margin:0' }, 'Войдите способом, который привязан к вашему аккаунту.'),
      providerButtons(err),
      !Object.values(state.config?.providers ?? {}).some(Boolean) && h('p', { class: 'muted small', style: 'margin:0' }, 'Вход через Google и Telegram пока не настроен администратором.'),
      passkeys && h('button', { type: 'button', class: 'primary big', onclick: withPasskey }, `Войти с ${pwa.biometryName()}`),
      passkeys && h('div', { class: 'divider' }, 'или'),
      h('p', { class: 'muted small', style: 'margin:0' }, 'Первый вход — по приглашению администратора. Если у вас уже есть API-ключ, можно войти с ним.'),
      h('label', { class: 'field' }, 'API-ключ', input),
      h('p', { class: 'muted small', style: 'margin:0' }, 'Ключ выдаётся при создании аккаунта. На компьютере, где работает трекер, ключи лежат в папке ~/.config/ai-tracker.'),
      err,
      h('button', { class: passkeys ? '' : 'primary' }, 'Войти по ключу'),
      release() && h('p', { class: 'muted small', style: 'margin:0;text-align:center' }, `Версия ${release()}`),
    ),
  );
}

const providerLabels = { google: 'Google', telegram: 'Telegram' };
function providerButtons(err, intent = 'login', invitationToken) {
  return h('div', { class: 'stack' }, Object.entries(providerLabels).map(([provider, label]) =>
    h('button', { type: 'button', class: 'big', disabled: !state.config?.providers?.[provider],
      title: state.config?.providers?.[provider] ? '' : `${label} пока не настроен администратором`,
      onclick: async (e) => {
        const button = e.currentTarget;
        button.disabled = true;
        err.textContent = '';
        try {
          const result = await api('POST', `/auth/${provider}/start`, { intent,
            ...(invitationToken && { invitation_token: invitationToken }) });
          location.assign(result.authorization_url);
        } catch (error) { err.textContent = error.message; button.disabled = false; }
      },
    }, `${intent === 'link' || invitationToken ? 'Привязать' : 'Войти через'} ${label}`),
  ));
}

async function invitationView(token) {
  const err = h('div', { class: 'error small', role: 'alert' });
  let invite;
  try { invite = await api('POST', '/auth/invitations/inspect', { token }); }
  catch { return h('main', null, h('section', { class: 'card pad stack login' },
    h('h1', null, 'Приглашение недоступно'),
    h('p', null, 'Ссылка уже использована, истекла или была заменена. Попросите администратора выдать новую.'),
    h('a', { href: '#/' }, 'Перейти ко входу'))); }
  return h('main', null, h('section', { class: 'card pad stack login' },
    h('h1', null, 'Добро пожаловать'), h('p', { style: 'margin:0' }, 'Администратор пригласил вас в AI Guild.'),
    h('div', { class: 'row' }, avatar(invite.name, 'human'), h('strong', null, invite.name)),
    h('p', { class: 'muted', style: 'margin:0' }, 'Выберите аккаунт для входа. Он будет привязан к вашему профилю.'),
    providerButtons(err, 'login', token), err,
    !Object.values(state.config?.providers ?? {}).some(Boolean) && h('p', { class: 'muted small' }, 'Администратору нужно настроить Google или Telegram. Ссылка останется доступной до указанного срока.'),
    h('p', { class: 'muted small', style: 'margin:0' }, `Ссылка действует до ${fmtDate(invite.expires_at)}. Второй способ входа можно добавить в профиле.`),
    state.me && h('p', { class: 'muted small' }, `Сейчас вы вошли как ${state.me.name}. По приглашению будет открыт аккаунт ${invite.name}.`),
  ));
}

// Cmd+Enter (Ctrl+Enter) in a text field sends the form it belongs to.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.defaultPrevented || e.isComposing) return;
  const form = e.target.closest?.('textarea, input')?.form;
  if (!form) return;
  e.preventDefault();
  // Goes through validation and the form's own handler, like a click on its button.
  form.requestSubmit();
});

function dialog(title, build) {
  const dlg = h('dialog', { onclose: () => dlg.remove() });
  const err = h('div', { class: 'error small', role: 'alert' });
  const close = () => dlg.close();
  const form = h('form', { method: 'dialog' }, h('h2', null, title));
  build(form, { close, err });
  form.append(err);
  dlg.append(form);
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

// ---------- tasks list ----------

const filters = { status: 'open', assignee: '', project: '', level: '', kind: '', q: '' };

async function tasksView() {
  const list = h('div', { class: 'card task-list' }, h('div', { class: 'empty' }, 'Загрузка…'));
  const projects = await api('GET', '/projects').catch(() => []);

  const load = async () => {
    const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
    try {
      const tasks = await api('GET', `/tasks?${qs}`);
      list.replaceChildren(
        ...(tasks.length ? treeRows(tasks) : [h('div', { class: 'empty' }, 'Задач по этим фильтрам нет')]),
      );
    } catch (ex) {
      list.replaceChildren(h('div', { class: 'empty error' }, ex.message));
    }
  };
  const bind = (key) => ({
    value: filters[key],
    onchange: (e) => {
      filters[key] = e.target.value;
      load();
    },
  });
  let debounce;

  load();
  state.poll = load;

  return shell(
    'tasks',
    h(
      'div',
      { class: 'page-head' },
      h('h1', null, 'Задачи'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'primary', onclick: () => newTaskDialog(projects) }, 'Новая задача'),
    ),
    h(
      'div',
      { class: 'filters' },
      h(
        'select',
        { 'aria-label': 'Статус', ...bind('status') },
        h('option', { value: 'open' }, 'Открытые'),
        h('option', { value: '' }, 'Все'),
        Object.entries(STATUS).map(([v, l]) => h('option', { value: v }, l)),
      ),
      h(
        'select',
        { 'aria-label': 'Исполнитель', ...bind('assignee') },
        h('option', { value: '' }, 'Любой исполнитель'),
        h('option', { value: 'me' }, 'Я'),
        h('option', { value: 'none' }, 'Не назначен'),
        state.accounts.filter((a) => !a.disabled).map((a) => h('option', { value: a.name }, a.name)),
      ),
      h(
        'select',
        { 'aria-label': 'Проект', ...bind('project') },
        h('option', { value: '' }, 'Все проекты'),
        projects.map((p) => h('option', { value: p }, p)),
      ),
      h(
        'select',
        { 'aria-label': 'Уровень', ...bind('level') },
        h('option', { value: '' }, 'Все уровни'),
        Object.entries(LEVEL).map(([v, l]) => h('option', { value: v }, l)),
      ),
      h(
        'select',
        { 'aria-label': 'Тип', ...bind('kind') },
        h('option', { value: '' }, 'Все типы'),
        Object.entries(KIND).map(([v, l]) => h('option', { value: v }, l)),
        h('option', { value: 'none' }, 'Без типа'),
      ),
      h('input', {
        type: 'search',
        placeholder: 'Поиск…',
        'aria-label': 'Поиск',
        value: filters.q,
        oninput: (e) => {
          filters.q = e.target.value;
          clearTimeout(debounce);
          debounce = setTimeout(load, 250);
        },
      }),
    ),
    list,
  );
}

function taskRow(t, depth = 0) {
  return h(
    'a',
    { class: 'task-row', href: `#/tasks/${t.id}`, style: depth ? `padding-left:${16 + depth * 26}px` : '' },
    statusChip(t.status),
    h(
      'div',
      { style: 'min-width:0' },
      h('div', { class: 'task-title' }, depth > 0 && h('span', { class: 'branch', 'aria-hidden': 'true' }, '└ '), h('span', { class: 'muted' }, `#${t.id} `), t.title),
      h(
        'div',
        { class: 'task-meta' },
        levelChip(t.level),
        kindChip(t.kind),
        t.child_count > 0 && h('span', { title: 'Готово из вложенных' }, `${t.child_done}/${t.child_count}`),
        t.project && h('span', null, t.project),
        ['high', 'urgent'].includes(t.priority) && h('span', { class: `prio-${t.priority}` }, PRIORITY[t.priority]),
        t.labels.map((l) => h('span', { class: 'chip' }, l)),
      ),
    ),
    h(
      'div',
      { class: 'task-meta' },
      t.total_seconds > 0 && h('span', { title: 'Затрачено времени' }, '⏱ ' + fmtDuration(t.total_seconds)),
      t.comment_count > 0 && h('span', { title: 'Комментарии' }, '💬 ' + t.comment_count),
      t.attachment_count > 0 && h('span', { title: 'Вложения' }, '📎 ' + t.attachment_count),
      t.assignee_name
        ? h('span', { class: 'row', style: 'gap:4px;flex-wrap:nowrap' }, avatar(t.assignee_name, kindOf(t.assignee_name)), t.assignee_name)
        : h('span', null, 'не назначен'),
      time(t.updated_at),
    ),
  );
}

const treeRows = (tasks) => asTree(tasks).map(([t, depth]) => taskRow(t, depth));

function newTaskDialog(projects, preset = {}) {
  dialog('Новая задача', (form, { close, err }) => {
    const title = h('input', { required: true, maxlength: 300, autofocus: true, value: preset.title ?? '' });
    const description = h('textarea', { placeholder: 'Что нужно сделать. Markdown; картинку можно вставить из буфера или перетащить.' });
    description.value = preset.text ?? '';
    const shared = [...(preset.files ?? [])];
    acceptImages(description, (file) => shared.push(file));
    offerMentions(description);
    const assignee = h(
      'select',
      null,
      h('option', { value: '' }, 'Не назначен'),
      state.accounts.filter((a) => !a.disabled).map((a) => h('option', { value: a.name }, `${a.name} (${a.kind === 'agent' ? 'агент' : 'человек'})`)),
    );
    const priority = h('select', null, Object.entries(PRIORITY).map(([v, l]) => h('option', { value: v, selected: v === 'normal' }, l)));
    const project = h('input', { list: 'projects', maxlength: 100, value: preset.project ?? '' });
    const parent = preset.parent;
    // Under a parent only the levels below it make sense.
    const allowed = parent ? LEVELS.slice(LEVELS.indexOf(parent.level) + 1) : LEVELS;
    const wanted = preset.level ?? (parent ? allowed[0] : 'task');
    const level = h('select', null, allowed.map((v) => h('option', { value: v, selected: v === wanted }, LEVEL[v])));
    const kind = h('select', null, h('option', { value: '' }, 'Не указан'), Object.entries(KIND).map(([v, l]) => h('option', { value: v, selected: v === preset.kind }, l)));
    form.append(
      parent && h('div', { class: 'muted small' }, 'Входит в: ', levelChip(parent.level), ` #${parent.id} ${parent.title}`),
      h('label', { class: 'field' }, 'Название', title),
      h('label', { class: 'field' }, 'Описание', description),
      h('div', { class: 'grid-2' }, h('label', { class: 'field' }, 'Уровень', level), h('label', { class: 'field' }, 'Тип', kind)),
      h('div', { class: 'grid-2' }, h('label', { class: 'field' }, 'Исполнитель', assignee), h('label', { class: 'field' }, 'Приоритет', priority)),
      !parent && h('label', { class: 'field' }, 'Проект', project, h('datalist', { id: 'projects' }, projects.map((p) => h('option', { value: p })))),
      preset.files?.length > 0 && h('div', { class: 'muted small' }, `Будут приложены: ${preset.files.map((f) => f.name).join(', ')}`),
      h(
        'div',
        { class: 'row', style: 'justify-content:flex-end' },
        h('button', { type: 'button', class: 'ghost', onclick: close }, 'Отмена'),
        h('button', { class: 'primary' }, 'Создать'),
      ),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const task = await api('POST', '/tasks', {
          title: title.value,
          description: description.value,
          priority: priority.value,
          level: level.value,
          ...(kind.value && { kind: kind.value }),
          ...(parent && { parent_id: parent.id }),
          ...(assignee.value && { assignee: assignee.value }),
          ...(!parent && project.value.trim() && { project: project.value.trim() }),
        });
        await uploadFiles(task.id, shared);
        close();
        location.hash = `#/tasks/${task.id}`;
      } catch (ex) {
        err.textContent = ex.message;
      }
    });
  });
}

// ---------- task detail ----------

const EVENT_TEXT = {
  task_created: () => 'создал(а) задачу',
  task_assigned: (d) => (d.assignee ? `назначил(а) исполнителем ${d.assignee}` : 'снял(а) исполнителя'),
  status_changed: (d) => `сменил(а) статус: ${STATUS[d.from] ?? d.from} → ${STATUS[d.to] ?? d.to}`,
  task_edited: (d) => `изменил(а): ${(d.fields ?? []).join(', ')}`,
  result_submitted: (d) => `отправил(а) результат → ${STATUS[d.to] ?? d.to}`,
  attachment_added: (d) => `приложил(а) файл ${d.filename}`,
  link_added: (d) => `добавил(а) связь: ${(LINK[d.type] ?? d.type).toLowerCase()} #${d.task_id}`,
  agent_run: (d) =>
    ({ started: 'запущен по сообщению человека', finished: 'закончил запуск', failed: `запуск не удался${d.detail ? `: ${d.detail.slice(-300)}` : ''}` })[d.state] ?? d.state,
  link_removed: (d) => `убрал(а) связь: ${(LINK[d.type] ?? d.type).toLowerCase()} #${d.task_id}`,
};

// ---------- attachment viewer ----------

const isPicture = (a) => a.kind === 'image' && a.mime !== 'image/svg+xml';
const isPage = (a) => a.mime === 'text/html';
const isText = (a) => a.kind === 'log' || a.mime === 'image/svg+xml';
const canPreview = (a) => isPicture(a) || a.kind === 'video' || isText(a);
const extension = (a) => (a.filename.includes('.') ? a.filename.split('.').pop() : 'file').slice(0, 5).toUpperCase();

// Opens one attachment large, with the rest of the task's previewable files a key press away.
function openViewer(files, current) {
  const items = files.filter(canPreview);
  let at = Math.max(0, items.findIndex((a) => a.id === current.id));
  let asSource = false;

  const stage = h('div', { class: 'viewer-stage' });
  const title = h('div', { class: 'viewer-title' });
  const actions = h('div', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' });
  const strip = h('div', { class: 'viewer-strip', role: 'tablist', 'aria-label': 'Вложения' });
  const step = (by) => show((at + by + items.length) % items.length);
  const prev = h('button', { class: 'viewer-nav prev', 'aria-label': 'Предыдущее', onclick: () => step(-1) }, '‹');
  const next = h('button', { class: 'viewer-nav next', 'aria-label': 'Следующее', onclick: () => step(1) }, '›');

  const content = (a) => {
    if (isPicture(a)) return h('img', { src: a.url, alt: a.filename });
    if (a.kind === 'video') return h('video', { src: a.url, controls: true, autoplay: true });
    // The frame has no rights in the tracker: see the headers of /attachments/:id/content.
    return h('iframe', {
      src: isPage(a) && !asSource ? `${a.url}?render=1` : a.url,
      title: a.filename,
      sandbox: isPage(a) && !asSource ? 'allow-scripts' : '',
      referrerpolicy: 'no-referrer',
    });
  };

  function show(index) {
    at = index;
    const a = items[at];
    stage.replaceChildren(content(a));
    title.replaceChildren(
      h('strong', { title: a.filename }, a.filename),
      h('span', { class: 'muted small' }, `${fmtSize(a.size)} · ${a.account_name}${items.length > 1 ? ` · ${at + 1} из ${items.length}` : ''}`),
    );
    actions.replaceChildren(
      ...[
        isPage(a) &&
          h('button', { class: 'small', 'aria-pressed': String(asSource), onclick: () => ((asSource = !asSource), show(at)) }, asSource ? 'Страница' : 'Исходный код'),
        h('a', { class: 'button small', href: a.url, download: a.filename }, 'Скачать'),
        h('button', { class: 'small', 'aria-label': 'Закрыть', onclick: () => dlg.close() }, '✕'),
      ].filter(Boolean),
    );
    for (const [i, tab] of [...strip.children].entries()) {
      tab.setAttribute('aria-selected', String(i === at));
      if (i === at) tab.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }

  strip.append(
    ...items.map((a, i) =>
      h(
        'button',
        { class: 'viewer-thumb', role: 'tab', title: a.filename, 'aria-label': a.filename, onclick: () => ((asSource = false), show(i)) },
        isPicture(a) ? h('img', { src: a.url, alt: '', loading: 'lazy' }) : h('span', null, a.kind === 'video' ? '▶' : extension(a)),
      ),
    ),
  );

  const dlg = h(
    'dialog',
    {
      class: 'viewer',
      'aria-label': 'Просмотр вложения',
      onclose: () => dlg.remove(),
      // A click outside the content lands on the dialog or the stage themselves.
      onclick: (e) => (e.target === dlg || e.target === stage) && dlg.close(),
      onkeydown: (e) => {
        if (items.length < 2 || e.target.closest?.('video')) return;
        if (e.key === 'ArrowLeft') step(-1);
        else if (e.key === 'ArrowRight') step(1);
      },
    },
    h('header', { class: 'viewer-head' }, title, h('span', { class: 'spacer' }), actions),
    h('div', { class: 'viewer-body' }, items.length > 1 && prev, stage, items.length > 1 && next),
    items.length > 1 && strip,
  );
  document.body.append(dlg);
  dlg.showModal();
  show(at);
}

// `all` is what the viewer pages through: every attachment of the task.
function fileCard(a, all = [a]) {
  let preview;
  if (isPicture(a)) preview = h('img', { src: a.url, alt: a.filename, loading: 'lazy' });
  else if (a.kind === 'video') preview = h('video', { src: a.url, controls: true, preload: 'metadata' });
  else preview = h('div', { class: 'file-icon' }, extension(a));
  const name = h('div', { class: 'file-name', title: a.filename }, a.filename, h('div', { class: 'muted' }, `${fmtSize(a.size)} · ${a.account_name}`));
  const open = (e) => {
    // Modified clicks keep their meaning: a new tab, a download.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openViewer(all, a);
  };
  // The video element needs its own clicks for the controls, so only the caption opens the viewer.
  if (a.kind === 'video') return h('div', { class: 'file' }, preview, h('a', { href: a.url, target: '_blank', style: 'color:inherit', onclick: open }, name));
  return h('a', { class: 'file', href: a.url, target: '_blank', onclick: canPreview(a) ? open : null }, preview, name);
}

async function taskView(id) {
  const head = h('div');
  const body = h('div');
  const timeline = h('div', { class: 'timeline' });
  const side = h('aside', { class: 'side' });
  const err = h('div', { class: 'error small', role: 'alert' });

  const patch = async (change) => {
    try {
      await api('PATCH', `/tasks/${id}`, change);
      await load();
    } catch (ex) {
      err.textContent = ex.message;
    }
  };

  const paint = (t) => {
    document.title = `#${t.id} ${t.title} · AI Guild`;
    head.replaceChildren(...[
      h(
        'nav',
        { class: 'small crumbs', 'aria-label': 'Путь' },
        t.project ? h('a', { href: `#/projects/${encodeURIComponent(t.project)}` }, t.project) : h('a', { href: '#/tasks' }, 'Все задачи'),
        t.ancestors.map((p) => [h('span', { class: 'muted', 'aria-hidden': 'true' }, ' › '), h('a', { href: `#/tasks/${p.id}` }, `${LEVEL[p.level]} #${p.id} ${p.title}`)]),
      ),
      h('div', { class: 'page-head' }, h('h1', null, h('span', { class: 'muted' }, `#${t.id} `), t.title), statusChip(t.status), levelChip(t.level), kindChip(t.kind)),
      t.status === 'review' &&
        h(
          'div',
          { class: 'card review-bar' },
          h('div', null, h('strong', null, 'Ждёт вашего решения. '), `${t.result_by_name ?? t.assignee_name ?? 'Агент'} сдал работу — посмотрите результат ниже.`),
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'primary', onclick: () => patch({ status: 'done' }) }, 'Принять'),
            h(
              'button',
              {
                onclick: async () => {
                  await patch({ status: 'in_progress' });
                  text.placeholder = 'Что доделать? Агент увидит это в своих входящих.';
                  text.focus();
                },
              },
              'Вернуть в работу',
            ),
          ),
        ),
    ].filter(Boolean));

    // A picture shown inside the text is not repeated in the file grids.
    const shownInline = new Set(
      [t.description, t.result, ...t.comments.map((c) => c.body)].flatMap((text) => inlineImageIds(text, t.attachments)),
    );
    const files = t.attachments.filter((a) => !shownInline.has(a.id));
    const commentFiles = new Map();
    for (const a of files) {
      if (a.comment_id) commentFiles.set(a.comment_id, [...(commentFiles.get(a.comment_id) ?? []), a]);
    }

    // replaceChildren would print a skipped section as the word "null".
    const sections = [
      h(
        'section',
        { class: 'card' },
        h(
          'div',
          { class: 'comment-head' },
          avatar(t.created_by_name, kindOf(t.created_by_name)),
          h('strong', null, t.created_by_name),
          recordedChip(t.recorded_by_name),
          runChips(t.model, t.effort),
          h('span', { class: 'spacer' }),
          time(t.created_at),
          h('button', { class: 'ghost small', onclick: () => editTaskDialog(t, load) }, 'Изменить'),
        ),
        h('div', { class: 'comment-body' }, t.description ? markdown(t.description, t.attachments) : h('span', { class: 'muted' }, 'Без описания'), originalWords(t.original_text)),
      ),
      t.result &&
        h(
          'section',
          { class: 'card result', style: 'margin-top:12px' },
          h(
            'div',
            { class: 'comment-head' },
            h('strong', null, 'Результат'),
            t.result_by_name && h('span', null, '· ' + t.result_by_name),
            runChips(t.result_model, t.result_effort),
            h('span', { class: 'spacer' }),
            t.result_at && time(t.result_at),
          ),
          h('div', { class: 'comment-body' }, markdown(t.result, t.attachments)),
        ),
      (t.children.length > 0 || t.level !== 'subtask') &&
        h(
          'section',
          { class: 'card', style: 'margin-top:12px' },
          h(
            'div',
            { class: 'comment-head' },
            h('strong', null, 'Состоит из'),
            t.children.length > 0 && h('span', { class: 'muted' }, `готово ${t.child_done} из ${t.child_count}`),
            h('span', { class: 'spacer' }),
            h('button', { class: 'ghost small', onclick: async () => newTaskDialog(await api('GET', '/projects').catch(() => []), { parent: t, kind: t.kind }) }, 'Добавить'),
          ),
          t.children.length
            ? t.children.map((c) =>
                h(
                  'a',
                  { class: 'task-row', href: `#/tasks/${c.id}`, style: 'grid-template-columns:110px minmax(0,1fr) auto' },
                  statusChip(c.status),
                  h('div', { class: 'task-title' }, h('span', { class: 'muted' }, `#${c.id} `), c.title),
                  h('div', { class: 'task-meta' }, levelChip(c.level), kindChip(c.kind), c.assignee_name),
                ),
              )
            : h('div', { class: 'comment-body muted small' }, 'Пока не разбита на части'),
        ),
    ];
    body.replaceChildren(...sections.filter(Boolean));

    const items = [
      ...t.comments.map((c) => ({ at: c.created_at, id: c.id, comment: c })),
      ...t.events
        .filter((e) => e.type !== 'comment_added' && e.type !== 'task_created')
        .map((e) => ({ at: e.created_at, id: e.id, event: e })),
    ].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);

    const pending = pwa.pendingComments(id).map((c) =>
      h(
        'article',
        { class: 'card comment human pending' },
        h('div', { class: 'comment-head' }, avatar(state.me.name, state.me.kind), h('strong', null, state.me.name), h('span', { class: 'chip' }, 'ждёт сети'), h('span', { class: 'spacer' }), time(c.at)),
        h('div', { class: 'comment-body' }, markdown(c.body)),
      ),
    );

    timeline.replaceChildren(
      ...items.map(({ comment: c, event: e }) =>
        c
          ? h(
              'article',
              { class: `card comment ${c.author_kind}` },
              h(
                'div',
                { class: 'comment-head' },
                avatar(c.author_name, c.author_kind),
                h('strong', null, c.author_name),
                recordedChip(c.recorded_by_name),
                runChips(c.model, c.effort),
                h('span', { class: 'spacer' }),
                time(c.created_at),
              ),
              h(
                'div',
                { class: 'comment-body' },
                markdown(c.body, t.attachments),
                originalWords(c.original_text),
                commentFiles.has(c.id) && h('div', { class: 'files', style: 'margin-top:10px' }, commentFiles.get(c.id).map((a) => fileCard(a, t.attachments))),
              ),
            )
          : h(
              'div',
              { class: 'event' },
              avatar(e.actor_name, e.actor_kind),
              h('strong', null, e.actor_name),
              (EVENT_TEXT[e.type] ?? (() => e.type))(e.data),
              runChips(e.data.model, e.data.effort),
              time(e.created_at),
            ),
      ),
      ...pending,
    );

    const loose = files.filter((a) => !a.comment_id);
    const select = (value, options, onchange) =>
      h('select', { onchange: (e) => onchange(e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));

    side.replaceChildren(
      h(
        'div',
        { class: 'card pad' },
        h(
          'div',
          { class: 'kv' },
          h('span', null, 'Статус'),
          select(t.status, Object.entries(STATUS), (v) => patch({ status: v })),
          h('span', null, 'Исполнитель'),
          select(
            t.assignee_name ?? '',
            [['', 'Не назначен'], ...state.accounts.filter((a) => !a.disabled || a.name === t.assignee_name).map((a) => [a.name, a.name])],
            (v) => patch({ assignee: v || null }),
          ),
          h('span', null, 'Уровень'),
          select(t.level, Object.entries(LEVEL), (v) => patch({ level: v })),
          h('span', null, 'Тип'),
          select(t.kind ?? '', [['', 'Не указан'], ...Object.entries(KIND)], (v) => patch({ kind: v || null })),
          h('span', null, 'Приоритет'),
          select(t.priority, Object.entries(PRIORITY), (v) => patch({ priority: v })),
          h('span', null, 'Проект'),
          h('input', { value: t.project ?? '', placeholder: '—', onchange: (e) => patch({ project: e.target.value.trim() || null }) }),
          h('span', null, 'Создана'),
          h('span', { class: 'small' }, fmtDate(t.created_at)),
          t.completed_at && [h('span', null, 'Завершена'), h('span', { class: 'small' }, fmtDate(t.completed_at))],
        ),
        err,
      ),
      linksCard(t, load, err),
      h(
        'div',
        { class: 'card pad' },
        h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' }, h('h3', { style: 'margin:0' }, 'Время'), h('strong', null, fmtDuration(t.total_seconds))),
        t.tree_seconds > t.total_seconds && h('div', { class: 'muted small', style: 'margin-bottom:8px' }, `С вложенными задачами: ${fmtDuration(t.tree_seconds)}`),
        t.time_logs.length
          ? t.time_logs.map((l) =>
              h(
                'div',
                { class: 'timelog' },
                h(
                  'div',
                  { style: 'min-width:0' },
                  h('div', null, l.account_name, l.worker && h('span', { class: 'muted' }, ` · ${l.worker}`), ' ', h('span', { class: 'muted' }, fmtAgo(l.started_at))),
                  h('div', { class: 'row', style: 'gap:4px;margin-top:2px' }, runChips(l.model, l.effort)),
                  (l.input_tokens != null || l.cost_usd != null) &&
                    h(
                      'div',
                      { class: 'muted small' },
                      [
                        l.input_tokens != null && `${fmtCompact(l.input_tokens)} in`,
                        l.output_tokens != null && `${fmtCompact(l.output_tokens)} out`,
                        l.cache_read_tokens != null && `кэш ${fmtCompact(l.cache_read_tokens)}`,
                        l.cost_usd != null && fmtMoney(l.cost_usd),
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    ),
                  l.note && h('div', { class: 'muted small' }, l.note),
                ),
                l.seconds == null ? h('span', { class: 'running' }, '● идёт') : h('span', null, fmtDuration(l.seconds)),
              ),
            )
          : h('div', { class: 'muted small' }, 'Время ещё не списывали'),
      ),
      h(
        'div',
        { class: 'card pad' },
        h('h3', null, `Вложения${loose.length ? ` · ${loose.length}` : ''}`),
        loose.length ? h('div', { class: 'files', style: 'grid-template-columns:1fr 1fr' }, loose.map((a) => fileCard(a, t.attachments))) : h('div', { class: 'muted small' }, 'Нет файлов'),
      ),
    );
  };

  // A snapshot guard keeps polling from re-rendering (and resetting video playback) when nothing changed.
  let snapshot = '';
  const load = async () => {
    const t = await api('GET', `/tasks/${id}`);
    const next = JSON.stringify([t, pwa.pendingComments(id)]);
    if (next !== snapshot) {
      snapshot = next;
      paint(t);
      // The person is looking at the task: what happened in it is no longer news.
      if (state.me.kind === 'human' && !document.hidden) {
        api('POST', '/inbox/read', { task_id: id }).then(refreshInboxCount).catch(() => {});
      }
    }
  };

  try {
    await load();
  } catch (ex) {
    return shell('tasks', h('div', { class: 'empty error' }, ex.message), h('p', { style: 'text-align:center' }, h('a', { href: '#/tasks' }, '← Все задачи')));
  }
  state.poll = load;

  const text = h('textarea', { placeholder: 'Комментарий для агентов. Упомяните через @имя; картинку можно вставить из буфера.', required: true });
  const pasted = [];
  acceptImages(text, (file) => pasted.push(file));
  offerMentions(text);
  const files = h('input', { type: 'file', multiple: true, 'aria-label': 'Файлы' });
  const reopen = h('input', { type: 'checkbox' });
  const formErr = h('div', { class: 'error small', role: 'alert' });
  const send = h('button', { class: 'primary', title: `Отправить (${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'}+Enter)` }, 'Отправить');
  const composer = h(
    'form',
    {
      class: 'card pad stack',
      onsubmit: async (e) => {
        e.preventDefault();
        formErr.textContent = '';
        send.disabled = true;
        try {
          const comment = await api('POST', `/tasks/${id}/comments`, { body: text.value });
          await uploadFiles(id, [...pasted, ...files.files], comment.id);
          pasted.length = 0;
          if (reopen.checked) await api('PATCH', `/tasks/${id}`, { status: 'in_progress' });
          composer.reset();
          await load();
        } catch (ex) {
          if (pwa.isNetworkError(ex) && !files.files.length && !pasted.length) {
            // Keep the words: they go out by themselves once the connection is back.
            pwa.queueComment(id, text.value, reopen.checked);
            composer.reset();
            toast('Нет сети. Комментарий отправится, когда связь вернётся');
            await load().catch(() => {});
          } else {
            formErr.textContent = pwa.isNetworkError(ex) ? 'Нет сети. Файлы можно отправить только со связью.' : ex.message;
          }
        } finally {
          send.disabled = false;
        }
      },
    },
    h('h2', null, 'Комментарий'),
    text,
    h(
      'div',
      { class: 'row' },
      files,
      h('span', { class: 'spacer' }),
      h('label', { class: 'row small', style: 'gap:4px' }, reopen, 'Вернуть в работу'),
      send,
    ),
    formErr,
  );

  return shell('tasks', head, h('div', { class: 'detail' }, h('div', null, body, timeline, composer), side));
}

function linksCard(t, reload, err) {
  const type = h('select', { 'aria-label': 'Вид связи' }, Object.entries(LINK).map(([v, l]) => h('option', { value: v }, l)));
  const other = h('input', { type: 'number', min: 1, placeholder: '№', 'aria-label': 'Номер задачи', style: 'width:72px', required: true });
  const run = async (fn) => {
    err.textContent = '';
    try {
      await fn();
      await reload();
    } catch (ex) {
      err.textContent = ex.message;
    }
  };
  // Open work that waits for something unfinished is what needs attention.
  const waiting = t.links.filter((l) => l.type === 'blocked_by' && !['done', 'cancelled'].includes(l.task.status));
  return h(
    'div',
    { class: 'card pad' },
    h('h3', null, `Связи${t.links.length ? ` · ${t.links.length}` : ''}`),
    waiting.length > 0 && !['done', 'cancelled'].includes(t.status) && h('div', { class: 'blocked-note' }, `⚠ Ждёт ${waiting.length === 1 ? 'задачу' : 'задачи'} ${waiting.map((l) => '#' + l.task.id).join(', ')}`),
    t.links.map((l) =>
      h(
        'div',
        { class: 'link-row' },
        h(
          'div',
          { style: 'min-width:0' },
          h('div', { class: 'muted small' }, LINK[l.type] ?? l.type),
          h('a', { href: `#/tasks/${l.task.id}`, class: l.task.status === 'done' ? 'done' : '' }, `#${l.task.id} ${l.task.title}`),
          h('div', null, statusChip(l.task.status)),
        ),
        h('button', { class: 'ghost small', title: 'Убрать связь', 'aria-label': `Убрать связь с задачей ${l.task.id}`, onclick: () => run(() => api('DELETE', `/tasks/${t.id}/links/${l.id}`)) }, '×'),
      ),
    ),
    h(
      'form',
      {
        class: 'row',
        style: 'margin-top:10px;flex-wrap:nowrap',
        onsubmit: (e) => {
          e.preventDefault();
          run(() => api('POST', `/tasks/${t.id}/links`, { type: type.value, to: Number(other.value) }));
        },
      },
      type,
      other,
      h('button', { class: 'small' }, 'Связать'),
    ),
  );
}

function editTaskDialog(t, reload) {
  dialog(`Задача #${t.id}`, (form, { close, err }) => {
    const title = h('input', { required: true, maxlength: 300, value: t.title });
    const description = h('textarea', { style: 'min-height:220px', placeholder: 'Markdown; картинку можно вставить из буфера или перетащить.' });
    description.value = t.description;
    const added = [];
    acceptImages(description, (file) => added.push(file));
    offerMentions(description);
    form.append(
      h('label', { class: 'field' }, 'Название', title),
      h('label', { class: 'field' }, 'Описание', description),
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { type: 'button', class: 'ghost', onclick: close }, 'Отмена'), h('button', { class: 'primary' }, 'Сохранить')),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        // Files first: the saved text must never point at a picture that is not there.
        await uploadFiles(t.id, added);
        await api('PATCH', `/tasks/${t.id}`, { title: title.value, description: description.value });
        close();
        await reload();
      } catch (ex) {
        err.textContent = ex.message;
      }
    });
  });
}

// ---------- projects ----------

const STATUS_ORDER = ['done', 'review', 'in_progress', 'blocked', 'todo', 'cancelled'];

function projectLogo(p, size) {
  const style = `width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.24)}px;`;
  return p.logo_url
    ? h('img', { class: 'logo', src: p.logo_url, alt: '', style })
    : h('span', { class: 'logo logo-letter', 'aria-hidden': 'true', style: `${style}font-size:${Math.round(size * 0.44)}px;background:${p.color ?? 'var(--muted)'}` }, p.name[0]);
}

// Parts of a whole: one bar, split by status, with the legend carrying the names.
function statusBar(p) {
  const parts = STATUS_ORDER.map((s) => [s, p.tasks_by_status[s] ?? 0]).filter(([, n]) => n > 0);
  if (!parts.length) return h('div', { class: 'muted small' }, 'Задач пока нет');
  return h(
    'div',
    null,
    h(
      'div',
      { class: 'status-bar', role: 'img', 'aria-label': parts.map(([s, n]) => `${STATUS[s]}: ${n}`).join(', ') },
      parts.map(([s, n]) => withTip(h('span', { class: `seg-${s}`, style: `flex-grow:${n}` }), STATUS[s], `${n} из ${p.tasks}`)),
    ),
    h('div', { class: 'status-legend' }, parts.map(([s, n]) => h('span', { class: `st-${s}` }, h('span', { class: 'dot' }), `${STATUS[s]} ${n}`))),
  );
}

// First paragraph of the description, without markdown marks.
const teaser = (text) => (text ?? '').split(/\n\s*\n/)[0].replace(/[*`#]|!?\[([^\]]*)\]\([^)]*\)/g, '$1').trim();

function projectCard(p) {
  return h(
    'a',
    { class: 'card project-card', href: `#/projects/${encodeURIComponent(p.name)}`, style: p.color ? `--project:${p.color}` : '' },
    h(
      'div',
      { class: 'project-head' },
      projectLogo(p, 56),
      h('div', { style: 'min-width:0' }, h('h2', null, p.name), h('div', { class: 'muted small' }, p.last_activity_at ? `Активность ${fmtAgo(p.last_activity_at)}` : 'Ещё не начат')),
    ),
    h('p', { class: 'project-teaser' }, teaser(p.description) || h('span', { class: 'muted' }, 'Без описания')),
    statusBar(p),
    h(
      'div',
      { class: 'project-foot' },
      h('span', { class: 'row', style: 'gap:2px;flex-wrap:nowrap' }, p.members.map((m) => h('span', { title: m.name }, avatar(m.name, m.kind)))),
      h('span', { class: 'spacer' }),
      p.total_seconds > 0 && h('span', { title: 'Затрачено времени' }, '⏱ ' + fmtDuration(p.total_seconds)),
      p.cost_usd > 0 && h('span', { title: 'Стоимость по прайсу API' }, fmtMoney(p.cost_usd)),
    ),
  );
}

function projectDialog(p, done) {
  dialog(p ? 'Проект' : 'Новый проект', (form, { close, err }) => {
    const name = h('input', { required: true, maxlength: 100, value: p?.name ?? '', autofocus: !p });
    const description = h('textarea', { placeholder: 'О чём проект. Markdown.' });
    description.value = p?.description ?? '';
    const color = h('input', { type: 'color', value: p?.color ?? '#2a78d6', style: 'padding:2px;height:36px;width:64px' });
    const logo = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    form.append(
      h('label', { class: 'field' }, 'Название', name),
      h('label', { class: 'field' }, 'Описание', description),
      h('div', { class: 'grid-2' }, h('label', { class: 'field' }, 'Логотип (PNG, JPEG, WebP до 5 МБ)', logo), h('label', { class: 'field' }, 'Цвет', color)),
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { type: 'button', class: 'ghost', onclick: close }, 'Отмена'), h('button', { class: 'primary' }, p ? 'Сохранить' : 'Создать')),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const body = { name: name.value, description: description.value, color: color.value };
        const saved = p ? await api('PATCH', `/projects/${p.id}`, body) : await api('POST', '/projects', body);
        if (logo.files[0]) {
          const res = await fetch(`/api/projects/${saved.id}/logo`, { method: 'PUT', headers: { 'Content-Type': logo.files[0].type }, body: logo.files[0] });
          if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Не удалось загрузить логотип');
        }
        close();
        done(saved);
      } catch (ex) {
        err.textContent = ex.message;
      }
    });
  });
}

async function projectsView() {
  const projects = await api('GET', '/projects?details=1');
  const loose = await api('GET', '/tasks?limit=500&status=').then((all) => all.filter((t) => !t.project).length, () => 0);
  return shell(
    'projects',
    h('div', { class: 'page-head' }, h('h1', null, 'Проекты'), h('span', { class: 'spacer' }), h('button', { class: 'primary', onclick: () => projectDialog(null, (p) => (location.hash = `#/projects/${encodeURIComponent(p.name)}`)) }, 'Новый проект')),
    projects.length
      ? h('div', { class: 'project-grid' }, projects.map(projectCard))
      : h('div', { class: 'card empty' }, 'Проектов пока нет'),
    loose > 0 && h('p', { class: 'muted small' }, h('a', { href: '#/tasks' }, `Задач без проекта: ${loose}`)),
  );
}

async function projectView(name) {
  const projects = await api('GET', '/projects?details=1');
  const p = projects.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!p) return shell('projects', h('div', { class: 'empty' }, `Проекта «${name}» нет`), h('p', { style: 'text-align:center' }, h('a', { href: '#/projects' }, '← Все проекты')));
  document.title = `${p.name} · AI Guild`;

  const list = h('div', { class: 'card task-list' });
  let only = 'open';
  const load = async () => {
    const qs = new URLSearchParams({ project: p.name, limit: '500', ...(only && { status: only }) });
    const tasks = await api('GET', `/tasks?${qs}`);
    list.replaceChildren(...(tasks.length ? treeRows(tasks) : [h('div', { class: 'empty' }, only === 'open' ? 'Открытых задач нет' : 'Задач нет')]));
  };
  await load();
  state.poll = load;

  const tile = (label, value, hint) => h('div', { class: 'card pad' }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value), hint && h('div', { class: 'muted small' }, hint));
  const st = p.tasks_by_status;
  const filter = h(
    'select',
    { 'aria-label': 'Статус', onchange: (e) => { only = e.target.value; load(); } },
    h('option', { value: 'open' }, 'Открытые'),
    h('option', { value: '' }, 'Все'),
    Object.entries(STATUS).map(([v, l]) => h('option', { value: v }, l)),
  );

  return shell(
    'projects',
    h('div', { class: 'small', style: 'margin-bottom:10px' }, h('a', { href: '#/projects' }, '← Все проекты')),
    h(
      'section',
      { class: 'card project-hero', style: p.color ? `--project:${p.color}` : '' },
      projectLogo(p, 88),
      h(
        'div',
        { style: 'min-width:0;flex:1' },
        h('div', { class: 'row' }, h('h1', null, p.name), h('span', { class: 'spacer' }), h('a', { class: 'button', href: `#/board/${encodeURIComponent(p.name)}` }, 'Доска'), h('a', { class: 'button', href: `#/timeline/${encodeURIComponent(p.name)}` }, 'График'), h('button', { onclick: () => projectDialog(p, (saved) => (saved.name === p.name ? render() : (location.hash = `#/projects/${encodeURIComponent(saved.name)}`))) }, 'Изменить')),
        p.description ? markdown(p.description) : h('p', { class: 'muted' }, 'Без описания'),
        h('div', { class: 'row', style: 'margin-top:10px' }, p.members.map((m) => h('span', { class: 'chip' }, avatar(m.name, m.kind), m.name)), p.models.map((m) => h('span', { class: 'chip mono', title: 'Модель' }, m))),
      ),
    ),
    h(
      'div',
      { class: 'tiles', style: 'margin-top:16px' },
      tile('Задачи', String(p.tasks), `${p.open_tasks} открыто · ${st.done ?? 0} готово`),
      tile('На проверке', String(st.review ?? 0), (st.blocked ?? 0) > 0 ? `${st.blocked} заблокировано` : 'ждут вашего решения'),
      tile('Время', fmtDuration(p.total_seconds)),
      tile('Стоимость', fmtMoney(p.cost_usd), 'по прайсу API'),
    ),
    h('div', { class: 'card pad', style: 'margin-bottom:16px' }, statusBar(p)),
    h('div', { class: 'page-head' }, h('h2', null, 'Задачи'), filter, h('span', { class: 'spacer' }), h('button', { class: 'primary', onclick: async () => newTaskDialog(await api('GET', '/projects').catch(() => []), { project: p.name }) }, 'Новая задача')),
    list,
  );
}

// ---------- inbox ----------

async function inboxView() {
  const { events } = await api('GET', '/inbox');
  state.inboxCount = events.length;
  pwa.setBadge(events.length);
  return shell(
    'inbox',
    h(
      'div',
      { class: 'page-head' },
      h('h1', null, 'Входящие'),
      h('span', { class: 'spacer' }),
      events.length > 0 &&
        h(
          'button',
          {
            onclick: async () => {
              await api('POST', '/inbox/ack', { up_to: events.at(-1).id });
              state.inboxCount = 0;
              render();
            },
          },
          'Отметить всё прочитанным',
        ),
    ),
    h('p', { class: 'muted', style: 'margin-top:-8px' }, 'Что агенты сделали по вашим задачам. Событие уходит отсюда, когда вы открываете задачу или нажимаете «Прочитано». У каждого агента такой же ящик — в него попадают ваши комментарии.'),
    h(
      'div',
      { class: 'card task-list' },
      events.length
        ? events
            .slice()
            .reverse()
            .map((e) =>
              h(
                'a',
                { class: 'task-row', href: `#/tasks/${e.task_id}`, style: 'grid-template-columns:minmax(0,1fr) auto' },
                h(
                  'div',
                  { style: 'min-width:0' },
                  h(
                    'div',
                    { class: 'row', style: 'gap:6px' },
                    avatar(e.actor_name, e.actor_kind),
                    h('strong', null, e.actor_name),
                    e.type === 'comment_added' ? 'прокомментировал(а)' : (EVENT_TEXT[e.type] ?? (() => e.type))(e.data),
                    runChips(e.data.model, e.data.effort),
                  ),
                  h('div', { class: 'task-title muted' }, `#${e.task_id} ${e.task_title}`),
                  e.data.body && h('div', { class: 'task-title' }, e.data.body.slice(0, 200)),
                ),
                h(
                  'div',
                  { class: 'row', style: 'gap:10px;flex-wrap:nowrap' },
                  time(e.created_at),
                  h(
                    'button',
                    {
                      class: 'small',
                      title: 'Убрать из входящих всё по этой задаче',
                      'aria-label': `Отметить прочитанным: задача ${e.task_id}`,
                      onclick: async (click) => {
                        click.preventDefault();
                        await api('POST', '/inbox/read', { task_id: e.task_id });
                        render();
                      },
                    },
                    'Прочитано',
                  ),
                ),
              ),
            )
        : h('div', { class: 'empty' }, 'Новых событий нет'),
    ),
  );
}

// ---------- analytics ----------

const an = { range: '30', group: 'model', measure: 'seconds', project: '' };
const MEASURES = {
  seconds: { label: 'Время', fmt: fmtDuration },
  cost_usd: { label: 'Стоимость', fmt: fmtMoney },
  tokens: { label: 'Токены', fmt: fmtCompact },
  tasks: { label: 'Задачи', fmt: (n) => String(n) },
};
const measureOf = (row) => (an.measure === 'tokens' ? row.input_tokens + row.output_tokens : row[an.measure]);
const autoReviewEstimate = (row) =>
  row.keys?.[0] === 'codex-auto-review'
    ? (row.input_tokens * 0.2 + row.cache_read_tokens * 0.02 + row.cache_write_tokens * 0.25 + row.output_tokens * 1.2) / 1e6
    : null;
function analyticsCost(row) {
  const estimate = autoReviewEstimate(row);
  if (estimate > 0 && (row.unpriced_entries || row.cost_usd === 0)) return `≈${fmtMoney(estimate)}*`;
  if (row.unpriced_entries === row.entries) return '—';
  return `${fmtMoney(row.cost_usd)}${row.unpriced_entries ? ' + ?' : ''}`;
}

function rowTip(title, r) {
  return [
    title,
    [
      `Время: ${fmtDuration(r.seconds)}`,
      `Задач: ${r.tasks} · записей: ${r.entries}`,
      `Токены: ${fmtCompact(r.input_tokens)} in / ${fmtCompact(r.output_tokens)} out`,
      `Кэш: ${fmtCompact(r.cache_read_tokens)} чтение / ${fmtCompact(r.cache_write_tokens)} запись`,
      `Стоимость: ${analyticsCost(r)}`,
    ].join('\n'),
  ];
}

function barChart(rows) {
  const top = rows.slice().sort((a, b) => measureOf(b) - measureOf(a)).slice(0, 12);
  const max = Math.max(...top.map(measureOf), 0);
  if (!max) return h('div', { class: 'empty' }, 'Нет данных за период');
  return h(
    'div',
    { class: 'bars' },
    top.map((r) => {
      const name = r.keys[0] ?? '— не указано';
      return [
        h('div', { class: 'bar-label', title: name }, name),
        withTip(
          h(
            'div',
            { class: 'bar-track' },
            h('div', { class: 'bar', style: `width:calc(${(measureOf(r) / max) * 100}% - ${(measureOf(r) / max) * 84}px)` }),
            h('span', { class: 'bar-value' }, MEASURES[an.measure].fmt(measureOf(r))),
          ),
          ...rowTip(name, r),
        ),
      ];
    }),
  );
}

function dayChart(rows, from, to) {
  const byDay = new Map(rows.map((r) => [r.keys[0], r]));
  const days = [];
  const start = from ? new Date(from) : new Date(rows[0]?.keys[0] ?? to);
  for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())); d <= to && days.length < 370; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  const empty = { seconds: 0, tasks: 0, entries: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  const max = Math.max(...days.map((d) => measureOf(byDay.get(d) ?? empty)), 0);
  if (!max) return h('div', { class: 'empty' }, 'Нет данных за период');
  const label = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return h(
    'div',
    null,
    h('div', { class: 'muted small', style: 'margin-bottom:4px' }, `макс. ${MEASURES[an.measure].fmt(max)}`),
    h(
      'div',
      { class: 'cols' },
      days.map((d) => {
        const r = byDay.get(d) ?? empty;
        return withTip(
          h('div', { class: 'col' }, measureOf(r) > 0 && h('div', { class: 'col-bar', style: `height:${(measureOf(r) / max) * 100}%` })),
          ...rowTip(label(d), r),
        );
      }),
    ),
    h('div', { class: 'col-axis' }, h('span', null, label(days[0])), h('span', null, label(days.at(-1)))),
  );
}

function statsTable(rows, groupLabel) {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      null,
      h(
        'thead',
        null,
        h('tr', null, h('th', null, groupLabel), ['Время', 'Задач', 'Записей', 'Токены in', 'Токены out', 'Кэш: чтение', 'Кэш: запись', 'Стоимость', '$/час'].map((c) => h('th', { class: 'num' }, c))),
      ),
      h(
        'tbody',
        null,
        rows.map((r) =>
          h(
            'tr',
            null,
            h('td', null, r.keys.map((k) => k ?? '—').join(' · ')),
            h('td', { class: 'num' }, fmtDuration(r.seconds)),
            h('td', { class: 'num' }, String(r.tasks)),
            h('td', { class: 'num' }, String(r.entries)),
            h('td', { class: 'num' }, fmtCompact(r.input_tokens)),
            h('td', { class: 'num' }, fmtCompact(r.output_tokens)),
            h('td', { class: 'num' }, fmtCompact(r.cache_read_tokens)),
            h('td', { class: 'num' }, fmtCompact(r.cache_write_tokens)),
            h('td', { class: 'num' }, analyticsCost(r)),
            h('td', { class: 'num' }, r.seconds && !r.unpriced_entries && !(autoReviewEstimate(r) > 0 && r.cost_usd === 0) ? fmtMoney(r.cost_usd / (r.seconds / 3600)) : '—'),
          ),
        ),
      ),
    ),
      rows.some((r) => autoReviewEstimate(r) > 0 && (r.unpriced_entries || r.cost_usd === 0)) &&
        h('p', { class: 'muted small', style: 'padding:0 16px 12px' }, '* Оценка по тарифу GPT-5.6 Luna. Фактическая модель и тариф codex-auto-review не опубликованы; оценка не включена в итоговую стоимость.'),
  );
}

async function analyticsView() {
  const to = new Date();
  const from = an.range === 'all' ? null : new Date(Date.now() - Number(an.range) * 86400e3);
  const qs = (group) => {
    const p = new URLSearchParams({ group_by: group });
    if (from) p.set('from', from.toISOString());
    if (an.project) p.set('project', an.project);
    return p;
  };
  const [grouped, daily, matrix, projects] = await Promise.all([
    api('GET', `/analytics?${qs(an.group)}`),
    api('GET', `/analytics?${qs('day')}`),
    api('GET', `/analytics?${qs('model,effort')}`),
    api('GET', '/projects'),
  ]);
  const t = grouped.totals;
  const set = (key) => (e) => {
    an[key] = e.target.value ?? e.currentTarget.value;
    render();
  };
  const seg = (key, options) =>
    h(
      'div',
      { class: 'seg', role: 'group' },
      options.map(([v, l]) => h('button', { value: v, 'aria-pressed': String(an[key] === v), onclick: set(key) }, l)),
    );
  const tile = (label, value, hint) =>
    h('div', { class: 'card pad' }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value), hint && h('div', { class: 'muted small' }, hint));
  const st = grouped.tasks_by_status;
  const open = Object.entries(st).filter(([s]) => !['done', 'cancelled'].includes(s)).reduce((n, [, v]) => n + v, 0);

  return shell(
    'analytics',
    h('div', { class: 'page-head' }, h('h1', null, 'Аналитика')),
    h(
      'div',
      { class: 'filters' },
      seg('range', [['7', '7 дней'], ['30', '30 дней'], ['90', '90 дней'], ['all', 'Всё время']]),
      h('select', { 'aria-label': 'Проект', onchange: set('project') }, h('option', { value: '' }, 'Все проекты'), projects.map((p) => h('option', { value: p, selected: p === an.project }, p))),
      h('span', { class: 'spacer' }),
      seg('measure', Object.entries(MEASURES).map(([v, m]) => [v, m.label])),
    ),
    h(
      'div',
      { class: 'tiles' },
      tile('Время работы', fmtDuration(t.seconds), `${t.entries} записей по ${t.tasks} задачам`),
      tile('Стоимость', fmtMoney(t.cost_usd), t.unpriced_entries ? `${t.unpriced_entries} записей без подтверждённой цены` : t.seconds ? `${fmtMoney(t.cost_usd / (t.seconds / 3600))} за час` : null),
      tile('Токены', fmtCompact(t.input_tokens + t.output_tokens), `${fmtCompact(t.input_tokens)} in · ${fmtCompact(t.output_tokens)} out · кэш ${fmtCompact(t.cache_read_tokens)}`),
      tile('Задачи', `${st.done ?? 0} готово`, `${open} открыто · ${st.review ?? 0} на проверке`),
    ),
    h(
      'div',
      { class: 'charts' },
      h(
        'section',
        { class: 'card pad' },
        h(
          'div',
          { class: 'chart-head' },
          h('h2', null, `${MEASURES[an.measure].label}: ${GROUPS[an.group].toLowerCase()}`),
          h('select', { 'aria-label': 'Группировка', onchange: set('group') }, Object.entries(GROUPS).map(([v, l]) => h('option', { value: v, selected: v === an.group }, l))),
        ),
        barChart(grouped.rows),
      ),
      h('section', { class: 'card pad' }, h('div', { class: 'chart-head' }, h('h2', null, `${MEASURES[an.measure].label} по дням`), h('span', { class: 'muted small' }, 'UTC')), dayChart(daily.rows, from, to)),
    ),
    h('section', { class: 'card', style: 'margin-top:16px' }, h('div', { class: 'pad', style: 'padding-bottom:4px' }, h('h2', null, 'Модель × effort')), matrix.rows.length ? statsTable(matrix.rows, 'Модель · effort') : h('div', { class: 'empty' }, 'Нет данных за период')),
  );
}

// ---------- accounts ----------

function showKey(name, key) {
  dialog(`Ключ для ${name}`, (form, { close }) => {
    form.append(
      h('p', { style: 'margin:0' }, 'Ключ показывается один раз. Сохраните его сейчас — восстановить нельзя, только выпустить новый.'),
      h('div', { class: 'keybox' }, key),
      h(
        'div',
        { class: 'row', style: 'justify-content:flex-end' },
        h('button', { type: 'button', onclick: (e) => navigator.clipboard.writeText(key).then(() => (e.target.textContent = 'Скопировано')) }, 'Скопировать'),
        h('button', { type: 'button', class: 'primary', onclick: close }, 'Готово'),
      ),
    );
  });
}

async function accountsView() {
  state.accounts = await api('GET', '/accounts');
  const admin = state.me.role === 'admin';
  const act = async (fn) => {
    try {
      await fn();
      render();
    } catch (ex) {
      alert(ex.message);
    }
  };
  const create = () =>
    dialog('Новый аккаунт', (form, { close, err }) => {
      const name = h('input', { required: true, pattern: '[a-zA-Z0-9][a-zA-Z0-9_.\\-]{0,39}', placeholder: 'claude-backend', autofocus: true });
      const kind = h('select', null, h('option', { value: 'agent' }, 'Агент'), h('option', { value: 'human' }, 'Человек'));
      const system = h('input', { placeholder: 'claude, codex…', list: 'systems' });
      const role = h('select', null, h('option', { value: 'member' }, 'Участник'), h('option', { value: 'admin' }, 'Администратор'));
      form.append(
        h('label', { class: 'field' }, 'Имя (латиница, для @упоминаний)', name),
        h('div', { class: 'grid-2' }, h('label', { class: 'field' }, 'Тип', kind), h('label', { class: 'field' }, 'Роль', role)),
        h('label', { class: 'field' }, 'Система', system, h('datalist', { id: 'systems' }, ['claude', 'codex'].map((s) => h('option', { value: s })))),
        h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { type: 'button', class: 'ghost', onclick: close }, 'Отмена'), h('button', { class: 'primary' }, 'Создать')),
      );
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const res = await api('POST', '/accounts', { name: name.value, kind: kind.value, role: role.value, ...(system.value.trim() && { system: system.value.trim() }) });
          close();
          await render();
          if (res.account.kind === 'human') {
            try { showInvitation(res.account.name, await api('POST', `/accounts/${res.account.id}/invitation`)); }
            catch (error) { alert(`Аккаунт создан. Приглашение можно выдать в списке аккаунтов. ${error.message}`); }
          } else showKey(res.account.name, res.key);
        } catch (ex) {
          err.textContent = ex.message;
        }
      });
    });

  return shell(
    'accounts',
    h('div', { class: 'page-head' }, h('h1', null, 'Аккаунты'), h('span', { class: 'spacer' }), admin && h('button', { class: 'primary', onclick: create }, 'Новый аккаунт')),
    h(
      'div',
      { class: 'card table-wrap' },
      h(
        'table',
        null,
        h('thead', null, h('tr', null, ['Имя', 'Тип', 'Система', 'Роль', 'Ключ', 'Активность', ''].map((c) => h('th', null, c)))),
        h(
          'tbody',
          null,
          state.accounts.map((a) =>
            h(
              'tr',
              { style: a.disabled ? 'opacity:.5' : '' },
              h('td', null, h('span', { class: 'row', style: 'flex-wrap:nowrap' }, avatar(a.name, a.kind), a.name)),
              h('td', null, a.kind === 'agent' ? 'Агент' : 'Человек'),
              h('td', null, a.system ?? '—'),
              h('td', null, a.role === 'admin' ? 'Администратор' : 'Участник'),
              h('td', null, h('code', null, a.key_prefix + '…')),
              h('td', null, a.disabled ? 'отключён' : a.last_seen_at ? time(a.last_seen_at) : h('span', { class: 'muted small' }, 'не заходил')),
              h(
                'td',
                null,
                admin && a.kind === 'human' && !a.disabled && h('button', { class: 'ghost',
                  onclick: () => act(async () => showInvitation(a.name, await api('POST', `/accounts/${a.id}/invitation`))) }, 'Пригласить'),
                (admin || a.id === state.me.id) &&
                  h(
                    'button',
                    {
                      class: 'ghost',
                      onclick: () =>
                        confirm(`Выпустить новый ключ для ${a.name}? Старый перестанет работать.`) &&
                        act(async () => {
                          const res = await api('POST', `/accounts/${a.id}/rotate-key`);
                          if (a.id === state.me.id) await api('POST', '/session', { key: res.key });
                          showKey(a.name, res.key);
                        }),
                    },
                    'Новый ключ',
                  ),
                admin &&
                  a.id !== state.me.id &&
                  h('button', { class: 'ghost', onclick: () => act(() => api('PATCH', `/accounts/${a.id}`, { disabled: !a.disabled })) }, a.disabled ? 'Включить' : 'Отключить'),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function showInvitation(name, invitation) {
  dialog(`Приглашение для ${name}`, (form, { close }) => {
    const input = h('input', { value: invitation.url, readonly: true, 'aria-label': 'Ссылка-приглашение' });
    form.append(h('p', { class: 'muted', style: 'margin:0' }, 'Передайте эту ссылку человеку: он привяжет Google или Telegram и войдёт в выданный аккаунт.'),
      input, h('p', { class: 'muted small' }, `Одноразовая ссылка действует до ${fmtDate(invitation.expires_at)}. Новая ссылка заменяет предыдущую.`),
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { type: 'button', onclick: async (e) => {
          try { await navigator.clipboard.writeText(invitation.url); e.target.textContent = 'Скопировано'; }
          catch { input.select(); }
        } }, 'Скопировать ссылку'), h('button', { type: 'button', class: 'primary', onclick: close }, 'Готово')));
  });
}

// ---------- connect ----------

function connectView() {
  const origin = location.origin;
  const block = (title, text, note) =>
    h('section', { class: 'card pad stack' }, h('h2', null, title), note && h('p', { class: 'muted', style: 'margin:0' }, note), h('div', { class: 'md' }, h('pre', null, h('code', null, text))));
  return shell(
    'connect',
    h('div', { class: 'page-head' }, h('h1', null, 'Подключение агентов')),
    h(
      'div',
      { class: 'stack' },
      h('p', { class: 'muted', style: 'margin:0' }, 'Заведите каждому агенту свой аккаунт на странице «Аккаунты» и подставьте его ключ вместо <KEY>.'),
      block('Claude Code', `claude mcp add --transport http ai-tracker ${origin}/mcp \\\n  --header "Authorization: Bearer <KEY>"`),
      block(
        'Codex',
        `# ~/.codex/config.toml\n[mcp_servers.ai-tracker]\nurl = "${origin}/mcp"\ndefault_tools_approval_mode = "approve"\nhttp_headers = { Authorization = "Bearer <KEY>" }`,
      ),
      block(
        'Инструкция агенту (CLAUDE.md / AGENTS.md)',
        `## AI Guild\n- В начале сессии вызови get_inbox: там комментарии человека и других агентов. Выполни то, что просят, затем ack_inbox.\n- Перед работой найди или создай задачу и вызови start_timer.\n- Ход работы, вопросы и обсуждение — через add_comment; логи — attach_text; скриншоты и видео — через get_upload_command.\n- По завершении: stop_timer (с токенами и стоимостью), затем submit_result.\n- Всегда указывай свои настоящие model и effort.`,
        'Чтобы агент сам читал ваши комментарии и доделывал задачи.',
      ),
      block('REST', `curl -H "Authorization: Bearer <KEY>" ${origin}/api/tasks\n\n# загрузка файла\ncurl -H "Authorization: Bearer <KEY>" -F "file=@screen.png" ${origin}/api/tasks/1/attachments\n\n# контракт\n${origin}/api/openapi.json`),
    ),
  );
}

// ---------- profile: passkeys, notifications, install ----------

async function profileView() {
  const blocker = pwa.passkeyBlocker(state.config);
  const [passkeys, pushOn, identities] = await Promise.all([api('GET', '/passkeys'), pwa.pushEnabled().catch(() => false), api('GET', '/auth/identities')]);
  const err = h('div', { class: 'error small', role: 'alert' });
  const run = (fn) => async (e) => {
    err.textContent = '';
    const button = e.currentTarget;
    button.disabled = true;
    try {
      await fn();
      await render();
    } catch (ex) {
      err.textContent = ex.message;
      button.disabled = false;
    }
  };
  const bio = pwa.biometryName();
  const pushBlock = pwa.pushBlocker();
  const installed = pwa.isStandalone();

  return shell(
    'profile',
    h('div', { class: 'page-head' }, h('h1', null, 'Профиль'), h('span', { class: 'spacer' }), h('button', { onclick: logout }, 'Выйти')),
    h(
      'div',
      { class: 'stack' },
      err,
      h(
        'section',
        { class: 'card pad stack' },
        h('div', { class: 'row' }, avatar(state.me.name, state.me.kind), h('strong', null, state.me.name), h('span', { class: 'chip' }, state.me.role === 'admin' ? 'Администратор' : 'Участник'), h('span', { class: 'chip mono' }, state.me.key_prefix + '…')),
      ),
      h(
        'nav',
        { class: 'card task-list mobile-only' },
        h('a', { class: 'task-row', href: '#/tasks', style: 'grid-template-columns:1fr' }, 'Все задачи списком'),
        h('a', { class: 'task-row', href: '#/timeline', style: 'grid-template-columns:1fr' }, 'График работ'),
        h('a', { class: 'task-row', href: '#/analytics', style: 'grid-template-columns:1fr' }, 'Аналитика'),
        h('a', { class: 'task-row', href: '#/accounts', style: 'grid-template-columns:1fr' }, 'Аккаунты и ключи'),
        h('a', { class: 'task-row', href: '#/connect', style: 'grid-template-columns:1fr' }, 'Подключение агентов'),
      ),
      state.me.kind === 'human' && h('section', { class: 'card pad stack' },
        h('h2', null, 'Способы входа'),
        h('p', { class: 'muted', style: 'margin:0' }, 'Привяжите Google и Telegram, чтобы входить без API-ключа.'),
        Object.entries(providerLabels).map(([provider, label]) => {
          const identity = identities.find((i) => i.provider === provider);
          return h('div', { class: 'row' }, h('strong', null, label),
            h('span', { class: 'muted small' }, identity?.label ?? (state.config?.providers?.[provider] ? 'Не привязан' : 'Не настроен администратором')),
            h('span', { class: 'spacer' }), identity
              ? h('button', { class: 'ghost', onclick: (e) => {
                if (confirm(`Отключить ${label}? Сессии через него завершатся. Для входа останется другой привязанный способ, passkey или API-ключ.`)) {
                  run(async () => { await api('DELETE', `/auth/identities/${provider}`); await boot(); })(e);
                }
              } }, 'Отключить')
              : h('button', { disabled: !state.config?.providers?.[provider], onclick: run(async () => {
                const result = await api('POST', `/auth/${provider}/start`, { intent: 'link' });
                location.assign(result.authorization_url);
              }) }, 'Привязать'));
        })),
      h(
        'section',
        { class: 'card pad stack' },
        h('h2', null, `Вход по ${bio}`),
        h('p', { class: 'muted', style: 'margin:0' }, 'Passkey хранится на устройстве и синхронизируется через связку ключей. Сервер получает только открытый ключ — украсть с него нечего, а фишинговый сайт passkey не примет.'),
        passkeys.length
          ? h(
              'div',
              null,
              passkeys.map((p) =>
                h(
                  'div',
                  { class: 'timelog', style: 'align-items:center' },
                  h('div', null, h('div', null, p.name, ' ', p.backed_up && h('span', { class: 'chip' }, 'синхронизируется')), h('div', { class: 'muted small' }, `Добавлен ${fmtDate(p.created_at)}`, p.last_used_at ? ` · вход ${fmtAgo(p.last_used_at)}` : ' · ещё не использовался')),
                  h('button', { class: 'ghost', onclick: (e) => confirm(`Удалить passkey «${p.name}»? Войти с ним больше не получится.`) && run(() => api('DELETE', `/passkeys/${p.id}`))(e) }, 'Удалить'),
                ),
              ),
            )
          : h('div', { class: 'muted small' }, 'Пока ни одного passkey'),
        blocker
          ? h('div', { class: 'muted small' }, blocker)
          : h('div', null, h('button', { class: 'primary', onclick: run(() => pwa.passkeyRegister(api, pwa.deviceName())) }, passkeys.length ? 'Добавить ещё один' : `Включить ${bio}`)),
      ),
      h(
        'section',
        { class: 'card pad stack' },
        h('h2', null, 'Уведомления'),
        h('p', { class: 'muted', style: 'margin:0' }, 'Push, когда агент сдал результат, ответил в вашей задаче или упомянул вас.'),
        pushOn
          ? h('div', { class: 'row' }, h('span', { class: 'chip st-done' }, h('span', { class: 'dot' }), 'Включены на этом устройстве'), h('button', { onclick: run(() => pwa.disablePush(api)) }, 'Выключить'))
          : pushBlock
            ? h('div', { class: 'muted small' }, pushBlock)
            : h('div', null, h('button', { class: 'primary', onclick: run(() => pwa.enablePush(api)) }, 'Включить уведомления')),
      ),
      h(
        'section',
        { class: 'card pad stack' },
        h('h2', null, 'Приложение'),
        installed
          ? h('div', { class: 'row' }, h('span', { class: 'chip st-done' }, h('span', { class: 'dot' }), 'Установлено'))
          : pwa.canPromptInstall()
            ? h('div', null, h('button', { class: 'primary', onclick: run(() => pwa.promptInstall()) }, 'Установить приложение'))
            : h('p', { class: 'muted', style: 'margin:0' }, pwa.isIOS() ? 'В Safari нажмите «Поделиться» → «На экран „Домой“».' : 'В меню браузера выберите «Установить приложение» или «Добавить в Dock».'),
        h('p', { class: 'muted small', style: 'margin:0' }, 'Работает без сети: последние открытые задачи доступны для чтения, комментарии отправятся при появлении связи.'),
      ),
    ),
  );
}

// Offer biometrics once, right after the first sign-in with a key.
function offerPasskey() {
  if (!state.signedInWithKey) return;
  state.signedInWithKey = false;
  if (pwa.passkeyBlocker(state.config) || localStorage.getItem('ait-passkey-offered')) return;
  localStorage.setItem('ait-passkey-offered', '1');
  api('GET', '/passkeys').then((list) => {
    if (list.length) return;
    dialog(`Включить вход по ${pwa.biometryName()}?`, (form, { close, err }) => {
      form.append(
        h('p', { style: 'margin:0' }, 'В следующий раз не придётся вводить API-ключ — достаточно взгляда или отпечатка.'),
        h(
          'div',
          { class: 'row', style: 'justify-content:flex-end' },
          h('button', { type: 'button', class: 'ghost', onclick: close }, 'Не сейчас'),
          h('button', { class: 'primary' }, 'Включить'),
        ),
      );
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await pwa.passkeyRegister(api, pwa.deviceName());
          close();
          toast('Готово. Теперь можно входить по биометрии');
        } catch (ex) {
          err.textContent = ex.message;
        }
      });
    });
  }, () => {});
}

// ---------- board ----------

const BOARD_COLUMNS = ['todo', 'in_progress', 'review', 'blocked', 'done'];
// Who moves a task out of each status; shown under the column name.
const COLUMN_HINT = {
  todo: 'ещё никто не взял',
  in_progress: 'агент работает',
  review: 'ждут вашего решения',
  blocked: 'нужна помощь',
  done: 'принято',
};
const DONE_SHOWN = 20;
const board = { project: '', work: 'work', kind: '', assignee: '', allDone: false };

async function boardView(project) {
  if (project !== undefined) board.project = project;
  const columns = h('div', { class: 'board' });
  const err = h('div', { class: 'error small', role: 'alert' });
  const projects = await api('GET', '/projects').catch(() => []);

  const move = async (id, status) => {
    err.textContent = '';
    try {
      await api('PATCH', `/tasks/${id}`, { status });
    } catch (ex) {
      err.textContent = ex.message;
    }
    await load();
  };

  const card = (t) =>
    h(
      'article',
      {
        class: 'board-card',
        draggable: 'true',
        ondragstart: (e) => {
          e.dataTransfer.setData('text/plain', String(t.id));
          e.dataTransfer.effectAllowed = 'move';
          e.currentTarget.classList.add('dragging');
        },
        ondragend: (e) => e.currentTarget.classList.remove('dragging'),
      },
      h('a', { href: `#/tasks/${t.id}`, class: 'board-title', draggable: 'false' }, h('span', { class: 'muted' }, `#${t.id} `), t.title),
      h(
        'div',
        { class: 'task-meta', style: 'flex-wrap:wrap' },
        levelChip(t.level),
        kindChip(t.kind),
        !board.project && t.project && h('span', null, t.project),
        t.child_count > 0 && h('span', { title: 'Готово из вложенных' }, `${t.child_done}/${t.child_count}`),
        ['high', 'urgent'].includes(t.priority) && h('span', { class: `prio-${t.priority}` }, PRIORITY[t.priority]),
      ),
      h(
        'div',
        { class: 'board-foot' },
        t.assignee_name ? h('span', { class: 'row', style: 'gap:4px;flex-wrap:nowrap' }, avatar(t.assignee_name), t.assignee_name) : h('span', { class: 'muted' }, 'не назначен'),
        h('span', { class: 'spacer' }),
        t.total_seconds > 0 && h('span', { title: 'Затрачено времени' }, '⏱ ' + fmtDuration(t.total_seconds)),
        t.attachment_count > 0 && h('span', { title: 'Вложения' }, '📎 ' + t.attachment_count),
      ),
      // Moving without a mouse or on a phone, where dragging is awkward.
      h(
        'div',
        { class: 'board-actions' },
        t.status === 'review' && h('button', { class: 'primary small', onclick: () => move(t.id, 'done') }, 'Принять'),
        t.status === 'review' && h('button', { class: 'small', onclick: () => (location.hash = `#/tasks/${t.id}`) }, 'Открыть'),
        h(
          'select',
          { class: 'small', 'aria-label': `Статус задачи ${t.id}`, onchange: (e) => move(t.id, e.target.value) },
          Object.entries(STATUS).map(([v, l]) => h('option', { value: v, selected: v === t.status }, l)),
        ),
      ),
    );

  const load = async () => {
    const qs = new URLSearchParams({ limit: '500', status: BOARD_COLUMNS.join(',') });
    if (board.project) qs.set('project', board.project);
    if (board.kind) qs.set('kind', board.kind);
    if (board.assignee) qs.set('assignee', board.assignee);
    if (board.work === 'work') qs.set('level', 'task,subtask');
    else if (board.work === 'plan') qs.set('level', 'epic,story');
    let tasks;
    try {
      tasks = await api('GET', `/tasks?${qs}`);
    } catch (ex) {
      columns.replaceChildren(h('div', { class: 'empty error' }, ex.message));
      return;
    }
    const recent = (a, b) => b.updated_at.localeCompare(a.updated_at);
    columns.replaceChildren(
      ...BOARD_COLUMNS.map((status) => {
        const all = tasks.filter((t) => t.status === status).sort(recent);
        const shown = status === 'done' && !board.allDone ? all.slice(0, DONE_SHOWN) : all;
        return h(
          'section',
          {
            class: `board-column col-${status}`,
            'aria-label': STATUS[status],
            ondragover: (e) => {
              e.preventDefault();
              e.currentTarget.classList.add('over');
            },
            ondragleave: (e) => e.currentTarget.classList.remove('over'),
            ondrop: (e) => {
              e.preventDefault();
              e.currentTarget.classList.remove('over');
              const id = Number(e.dataTransfer.getData('text/plain'));
              if (id && tasks.find((t) => t.id === id)?.status !== status) move(id, status);
            },
          },
          h(
            'header',
            { class: 'board-head' },
            h('div', { class: `st-${status} row`, style: 'gap:6px' }, h('span', { class: 'dot' }), h('strong', null, STATUS[status]), h('span', { class: 'muted' }, String(all.length))),
            h('div', { class: 'muted small' }, COLUMN_HINT[status]),
          ),
          shown.length ? shown.map(card) : h('div', { class: 'muted small board-empty' }, 'Пусто'),
          all.length > shown.length &&
            h('button', { class: 'ghost small', onclick: () => ((board.allDone = true), load()) }, `Показать все ${all.length}`),
        );
      }),
    );
  };
  const bind = (key) => ({
    onchange: (e) => {
      board[key] = e.target.value;
      if (key === 'project') history.replaceState(null, '', board.project ? `#/board/${encodeURIComponent(board.project)}` : '#/board');
      load();
    },
  });
  const option = (value, label, current) => h('option', { value, selected: value === current }, label);

  await load();
  state.poll = load;

  return shell(
    'board',
    h('div', { class: 'page-head' }, h('h1', null, 'Доска'), h('span', { class: 'spacer' }), h('button', { class: 'primary', onclick: () => newTaskDialog(projects, { project: board.project }) }, 'Новая задача')),
    h(
      'div',
      { class: 'filters' },
      h('select', { 'aria-label': 'Проект', ...bind('project') }, option('', 'Все проекты', board.project), projects.map((p) => option(p, p, board.project))),
      h('select', { 'aria-label': 'Уровень', ...bind('work') }, option('work', 'Таски и подтаски', board.work), option('plan', 'Эпики и стори', board.work), option('all', 'Все уровни', board.work)),
      h('select', { 'aria-label': 'Тип', ...bind('kind') }, option('', 'Все типы', board.kind), Object.entries(KIND).map(([v, l]) => option(v, l, board.kind))),
      h('select', { 'aria-label': 'Исполнитель', ...bind('assignee') }, option('', 'Любой исполнитель', board.assignee), state.accounts.filter((a) => !a.disabled).map((a) => option(a.name, a.name, board.assignee))),
    ),
    h(
      'p',
      { class: 'muted small', style: 'margin:-4px 0 12px' },
      'Агент берёт задачу в работу и сдаёт её на проверку. Принять её или вернуть в работу — решаете вы. Карточки можно перетаскивать между колонками.',
    ),
    err,
    columns,
  );
}

// ---------- timeline ----------

const DAY_MS = 86400e3;
const DAY_PX = 20;
// How much was worked in a day, as steps of one hue.
const LOAD_STEPS = [
  [15 * 60, 'до 15 мин'],
  [3600, 'до 1 ч'],
  [3 * 3600, 'до 3 ч'],
  [Infinity, 'больше 3 ч'],
];
const loadStep = (seconds) => LOAD_STEPS.findIndex(([limit]) => seconds <= limit) + 1;
const tl = { project: '', closed: null };

const dayOf = (iso, tz) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });
const dayNumber = (day) => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / DAY_MS;
const dayLabel = (day, options) => new Date(day + 'T00:00:00Z').toLocaleDateString('ru-RU', { timeZone: 'UTC', ...options });

async function timelineView(project) {
  if (project !== undefined && project !== tl.project) {
    tl.project = project;
    tl.closed = null;
  }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const projects = await api('GET', '/projects').catch(() => []);
  if (!tl.project && projects.length) tl.project = projects[0];
  const qs = new URLSearchParams({ tz });
  if (tl.project) qs.set('project', tl.project);
  const { tasks } = await api('GET', `/timeline?${qs}`);

  // A parent's days are its own work plus everything under it.
  const byId = new Map(tasks.map((t) => [t.id, { ...t, own: t.days, days: { ...t.days }, kids: 0 }]));
  for (const t of byId.values()) {
    for (let up = byId.get(t.parent_id); up; up = byId.get(up.parent_id)) {
      for (const [day, seconds] of Object.entries(t.own)) up.days[day] = (up.days[day] ?? 0) + seconds;
    }
    if (byId.has(t.parent_id)) byId.get(t.parent_id).kids++;
  }
  // Nothing was logged on the task or under it: show at least when it appeared.
  for (const t of byId.values()) if (!Object.keys(t.days).length) t.marker = dayOf(t.started_at, tz);
  const rows = asTree([...byId.values()]);
  // Large projects open as a list of their top-level items.
  tl.closed ??= new Set(rows.length > 40 ? rows.filter(([t]) => t.kids > 0).map(([t]) => t.id) : []);

  const allDays = rows.flatMap(([t]) => [...Object.keys(t.days), ...(t.marker ? [t.marker] : [])]);
  if (!allDays.length) {
    return shell('timeline', h('div', { class: 'page-head' }, h('h1', null, 'График')), timelineFilters(projects), h('div', { class: 'card empty' }, 'В проекте пока нет задач'));
  }
  const first = Math.min(...allDays.map(dayNumber)) - 1;
  const last = Math.max(Math.max(...allDays.map(dayNumber)), dayNumber(dayOf(new Date().toISOString(), tz))) + 1;
  const count = last - first + 1;
  const days = Array.from({ length: count }, (_, i) => new Date((first + i) * DAY_MS).toISOString().slice(0, 10));
  const today = dayNumber(dayOf(new Date().toISOString(), tz)) - first;
  const width = count * DAY_PX;

  const months = [];
  for (const [i, day] of days.entries()) {
    const key = day.slice(0, 7);
    if (months.at(-1)?.key === key) months.at(-1).span++;
    else months.push({ key, span: 1, label: dayLabel(day, { month: 'long', year: 'numeric' }).replace(' г.', ''), at: i });
  }
  const weekend = (day) => [0, 6].includes(new Date(day + 'T00:00:00Z').getUTCDay());

  const hidden = (t) => {
    for (let up = byId.get(t.parent_id); up; up = byId.get(up.parent_id)) if (tl.closed.has(up.id)) return true;
    return false;
  };
  const body = h('div', { class: 'tl-body' });
  const paint = () => {
    body.replaceChildren(
      ...rows
        .filter(([t]) => !hidden(t))
        .map(([t, depth]) => {
          const worked = Object.entries(t.days).sort();
          const span = worked.length ? [dayNumber(worked[0][0]) - first, dayNumber(worked.at(-1)[0]) - first] : null;
          const total = worked.reduce((n, [, s]) => n + s, 0);
          return h(
            'div',
            { class: `tl-row level-row-${t.level}` },
            h(
              'div',
              { class: 'tl-name', style: `padding-left:${8 + depth * 16}px` },
              t.kids > 0
                ? h(
                    'button',
                    {
                      class: 'ghost tl-toggle',
                      'aria-expanded': String(!tl.closed.has(t.id)),
                      'aria-label': `${tl.closed.has(t.id) ? 'Развернуть' : 'Свернуть'}: ${t.title}`,
                      onclick: () => {
                        tl.closed.has(t.id) ? tl.closed.delete(t.id) : tl.closed.add(t.id);
                        paint();
                      },
                    },
                    tl.closed.has(t.id) ? '▸' : '▾',
                  )
                : h('span', { class: 'tl-toggle' }),
              h('span', { class: `st-${t.status}`, title: STATUS[t.status] }, h('span', { class: 'dot' })),
              h('a', { href: `#/tasks/${t.id}`, title: `${LEVEL[t.level]} #${t.id} · ${STATUS[t.status]}` }, t.title),
              h('span', { class: 'tl-total' }, total ? fmtDuration(total) : ''),
            ),
            h(
              'div',
              { class: 'tl-track', style: `width:${width}px` },
              span && h('span', { class: 'tl-span', style: `left:${span[0] * DAY_PX + DAY_PX / 2}px;width:${Math.max(0, (span[1] - span[0]) * DAY_PX)}px` }),
              worked.map(([day, seconds]) =>
                withTip(
                  h('span', { class: `tl-day load-${loadStep(seconds)}`, style: `left:${(dayNumber(day) - first) * DAY_PX + 2}px` }),
                  dayLabel(day, { day: 'numeric', month: 'long', weekday: 'short' }),
                  `${fmtDuration(seconds)}\n${t.title}`,
                ),
              ),
              (t.marker ? [t.marker] : []).map((day) =>
                withTip(
                  h('span', { class: 'tl-day tl-untimed', style: `left:${(dayNumber(day) - first) * DAY_PX + 2}px` }),
                  dayLabel(day, { day: 'numeric', month: 'long', weekday: 'short' }),
                  `Время не записано\n${t.title}`,
                ),
              ),
            ),
          );
        }),
    );
  };
  paint();

  const grid = h(
    'div',
    { class: 'card tl', style: `--day:${DAY_PX}px;--today:${today * DAY_PX}px` },
    h(
      'div',
      { class: 'tl-scroll' },
      h(
        'div',
        { class: 'tl-head' },
        h('div', { class: 'tl-name tl-corner' }, `${rows.length} ${rows.length === 1 ? 'задача' : 'задач'}`),
        h(
          'div',
          { class: 'tl-track', style: `width:${width}px` },
          months.map((m) => h('span', { class: 'tl-month', style: `left:${m.at * DAY_PX}px;width:${m.span * DAY_PX}px` }, m.span > 3 || months.length === 1 ? m.label : '')),
          days.map((day, i) => h('span', { class: `tl-date ${weekend(day) ? 'weekend' : ''}`, style: `left:${i * DAY_PX}px` }, String(+day.slice(8)))),
        ),
      ),
      h(
        'div',
        { class: 'tl-grid', style: `--width:${width}px` },
        days.map((day, i) => weekend(day) && h('span', { class: 'tl-weekend', style: `left:${i * DAY_PX}px` })),
        h('span', { class: 'tl-today', title: 'Сегодня' }),
        body,
      ),
    ),
  );
  const totalSeconds = tasks.reduce((n, t) => n + t.seconds, 0);
  const workedDays = new Set(tasks.flatMap((t) => Object.keys(t.days))).size;

  return shell(
    'timeline',
    h('div', { class: 'page-head' }, h('h1', null, 'График'), h('span', { class: 'muted' }, `${fmtDuration(totalSeconds)} за ${workedDays} ${workedDays === 1 ? 'день' : 'дн.'} работы`)),
    timelineFilters(projects, () => {
      tl.closed = new Set(rows.filter(([t]) => t.kids > 0).map(([t]) => t.id));
      paint();
    }, () => {
      tl.closed = new Set();
      paint();
    }),
    h(
      'div',
      { class: 'tl-legend' },
      h('span', { class: 'muted' }, 'Работа за день:'),
      LOAD_STEPS.map(([, label], i) => h('span', null, h('i', { class: `tl-day load-${i + 1}` }), label)),
      h('span', null, h('i', { class: 'tl-day tl-untimed' }), 'время не записано'),
      h('span', { class: 'muted' }, `Дни — по часовому поясу ${tz}`),
    ),
    grid,
  );
}

function timelineFilters(projects, collapse, expand) {
  return h(
    'div',
    { class: 'filters' },
    h(
      'select',
      {
        'aria-label': 'Проект',
        onchange: (e) => (location.hash = `#/timeline/${encodeURIComponent(e.target.value)}`),
      },
      projects.map((p) => h('option', { value: p, selected: p === tl.project }, p)),
    ),
    collapse && h('button', { onclick: collapse }, 'Свернуть всё'),
    expand && h('button', { onclick: expand }, 'Развернуть всё'),
  );
}

// ---------- router ----------

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  state.poll = null;
  tip.hidden = true;
  document.title = 'AI Guild';
  if (location.hash.startsWith('#/invite/')) {
    const view = await invitationView(location.hash.slice('#/invite/'.length));
    if (seq === renderSeq) app.replaceChildren(view);
    return;
  }
  if (!state.me) return app.replaceChildren(loginView());

  const [, route, arg] = location.hash.split('/');
  let view;
  try {
    if (route === 'tasks' && arg) view = await taskView(Number(arg));
    else if (route === 'projects' && arg) view = await projectView(decodeURIComponent(arg));
    else if (route === 'tasks') view = await tasksView();
    else if (route === 'board') view = await boardView(arg ? decodeURIComponent(arg) : undefined);
    else if (route === 'timeline') view = await timelineView(arg ? decodeURIComponent(arg) : undefined);
    else if (route === 'inbox') view = await inboxView();
    else if (route === 'analytics') view = await analyticsView();
    else if (route === 'accounts') view = await accountsView();
    else if (route === 'connect') view = connectView();
    else if (route === 'profile') view = await profileView();
    else view = await projectsView();
  } catch (ex) {
    view = state.me ? shell('', h('div', { class: 'empty error' }, ex.message)) : loginView();
  }
  // A slower earlier navigation must not overwrite a newer one.
  if (seq !== renderSeq) return;
  app.replaceChildren(...[view].flat());

  // Entry points from the app icon's shortcuts and the OS share sheet.
  if (route === 'new' || route === 'share') {
    const preset = route === 'share' ? ((await pwa.takeShare().catch(() => null)) ?? {}) : {};
    history.replaceState(null, '', '#/projects');
    newTaskDialog(await api('GET', '/projects').catch(() => []), preset);
  }
}

async function refreshInboxCount() {
  const { events } = await api('GET', '/inbox');
  pwa.setBadge(events.length);
  if (events.length !== state.inboxCount) {
    state.inboxCount = events.length;
    const link = document.querySelector('.nav a[href="#/inbox"]');
    link?.querySelector('.badge')?.remove();
    if (events.length) link?.append(h('span', { class: 'badge' }, String(events.length)));
  }
}

async function boot() {
  state.config ??= await fetch('/api/config').then((r) => r.json()).catch(() => null);
  try {
    const res = await fetch('/api/me');
    state.me = res.ok ? await res.json() : null;
    if (state.me) {
      state.accounts = await api('GET', '/accounts');
      await refreshInboxCount().catch(() => {});
    }
  } catch {
    state.me = null;
  }
  await render();
  const feedback = new URLSearchParams(location.search);
  if (feedback.has('auth_error') || feedback.has('auth')) {
    toast(feedback.get('auth_error') || (feedback.get('auth') === 'linked' ? 'Способ входа привязан' : 'Вы вошли в аккаунт'));
    history.replaceState(null, '', location.pathname + location.hash);
  }
  if (state.me) {
    offerPasskey();
    flushOutbox();
  }
}

pwa.registerServiceWorker((url) => {
  location.hash = new URL(url).hash || '#/inbox';
});
pwa.onInstallChange(() => location.hash.startsWith('#/profile') && render());
addEventListener('online', () => {
  flushOutbox();
  state.poll?.().catch(() => {});
});

addEventListener('hashchange', render);
setInterval(() => {
  if (!state.me || document.hidden || document.querySelector('dialog[open]')) return;
  state.poll?.().catch(() => {});
  refreshInboxCount().catch(() => {});
}, 8000);

boot();
