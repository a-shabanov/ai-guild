import * as i18n from './i18n.js';
// AI Guild web UI. No build step, no dependencies. All DOM is built with h(), never innerHTML,
// so text coming from agents cannot inject markup.

import * as pwa from './pwa.js';
import { createNavigation } from './navigation.js';

const STATUS = {
  todo: i18n.t('К выполнению'),
  in_progress: i18n.t('В работе'),
  review: i18n.t('На проверке'),
  blocked: i18n.t('Заблокирована'),
  done: i18n.t('Готово'),
  cancelled: i18n.t('Отменена'),
};
const PRIORITY = { low: i18n.t('Низкий'), normal: i18n.t('Обычный'), high: i18n.t('Высокий'), urgent: i18n.t('Срочный') };
const LEVEL = { epic: i18n.t('Эпик'), story: i18n.t('Стори'), task: i18n.t('Таск'), subtask: i18n.t('Подтаск') };
const LEVELS = Object.keys(LEVEL);
const KIND = { visual: i18n.t('Визуал'), technical: i18n.t('Техническая') };
const LINK = {
  blocks: i18n.t('Блокирует'),
  blocked_by: i18n.t('Заблокирована задачей'),
  relates: i18n.t('Связана с'),
  duplicates: i18n.t('Дублирует'),
  duplicated_by: i18n.t('Дублируется задачей'),
};
const GROUPS = {
  worker: i18n.t('Исполнитель записи'),
  model: i18n.t('Модель'),
  effort: 'Effort',
  account: i18n.t('Аккаунт'),
  system: i18n.t('Система'),
  project: i18n.t('Проект'),
  task: i18n.t('Задача'),
};

const state = { me: null, accounts: [], inboxCount: 0, poll: null, config: null };
const app = document.getElementById('app');

// ---------- helpers ----------

function appendChildren(el, ...children) {
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

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
  appendChildren(el, ...children);
  return el;
}

async function api(method, path, body) {
  const isForm = body instanceof FormData;
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: {...pwa.clientHeaders(),...(body && !isForm ? { 'Content-Type': 'application/json' } : {})},
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
  } catch {
    setOffline(true);
    throw Object.assign(new Error(i18n.t('Нет соединения с сервером')), { offline: true });
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
  if (s < 60) return i18n.t`${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return i18n.t`${m} мин`;
  const hrs = Math.floor(m / 60);
  return m % 60 ? i18n.t`${hrs} ч ${m % 60} мин` : i18n.t`${hrs} ч`;
}

function fmtCompact(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return Math.round(n).toLocaleString(i18n.dateLocale);
}

const fmtMoney = (n) =>
  '$' + Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtSize(bytes) {
  if (bytes < 1024) return i18n.t`${bytes} Б`;
  if (bytes < 1024 ** 2) return i18n.t`${(bytes / 1024).toFixed(0)} КБ`;
  if (bytes < 1024 ** 3) return i18n.t`${(bytes / 1024 ** 2).toFixed(1)} МБ`;
  return i18n.t`${(bytes / 1024 ** 3).toFixed(2)} ГБ`;
}

const rtf = new Intl.RelativeTimeFormat(i18n.locale, { numeric: 'auto' });
function fmtAgo(iso) {
  const diff = (new Date(iso) - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return i18n.t('только что');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return new Date(iso).toLocaleDateString(i18n.dateLocale);
}
const fmtDate = (iso) => new Date(iso).toLocaleString(i18n.dateLocale, { dateStyle: 'medium', timeStyle: 'short' });
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
const recordedChip = (name) => name && h('span', { class: 'chip', title: i18n.t('Записано агентом со слов автора') }, i18n.t`записал ${name}`);
const originalWords = (text) =>
  text && h('details', { class: 'original' }, h('summary', null, i18n.t('Исходное сообщение')), h('blockquote', null, text));

function runChips(model, effort) {
  return [
    model && h('span', { class: 'chip mono', title: i18n.t('Модель') }, model),
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
          : h('span', { class: 'muted', title: i18n.t('Приложите файл к задаче, чтобы картинка появилась') }, i18n.t`[изображение: ${g.alt || g.src}]`),
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
  const menu = h('ul', { class: 'mention-menu', role: 'listbox', id, hidden: true, 'aria-label': i18n.t('Кого упомянуть') });
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
          h('span', { class: 'muted small' }, a.kind === 'human' ? i18n.t('человек') : a.system ?? i18n.t('агент')),
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
    toast(sent === 1 ? i18n.t('Отложенный комментарий отправлен') : i18n.t`Отправлено отложенных комментариев: ${sent}`);
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
      h('a', { class: 'brand', href: '#/projects', title: release() && i18n.t`Версия ${release()}` }, h('img', { class: 'brand-icon', src: '/icons/favicon-32.png?v=c76fb7f1fa02', alt: '' }), 'AI Guild', h('span', { class: 'version desktop-only' }, state.config?.version ? `${state.config.version} · ${state.config.build}` : '')),
      h(
        'nav',
        { class: 'nav row', style: 'flex-wrap:nowrap;gap:2px' },
        link('#/projects', i18n.t('Проекты'), 'projects'),
        link('#/board', i18n.t('Доска'), 'board'),
        link('#/timeline', i18n.t('График'), 'timeline', null, 'desktop-only'),
        link('#/tasks', i18n.t('Задачи'), 'tasks', null, 'desktop-only'),
        link('#/inbox', i18n.t('Входящие'), 'inbox', state.inboxCount ? h('span', { class: 'badge' }, String(state.inboxCount)) : null),
        link('#/analytics', i18n.t('Аналитика'), 'analytics', null, 'desktop-only'),
        link('#/accounts', i18n.t('Аккаунты'), 'accounts', null, 'desktop-only'),
        link('#/connect', i18n.t('Подключение'), 'connect', null, 'desktop-only'),
      ),
      h('span', { class: 'spacer' }),
      i18n.languagePicker(),
      h(
        'a',
        { href: '#/profile', class: `row profile-link ${active === 'profile' ? 'active' : ''}`, style: 'flex-wrap:nowrap', title: i18n.t('Профиль и устройство') },
        avatar(state.me.name, state.me.kind),
        h('span', { class: 'small' }, state.me.name),
      ),
    ),
    h('div', { class: 'offline-bar', role: 'status' }, i18n.t('Нет сети — показаны сохранённые данные')),
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
      await acceptSignIn(await pwa.passkeySignIn(api));
    } catch (ex) {
      err.textContent = ex.message === 'passkey sign-in failed' ? i18n.t('Этот passkey не подходит') : ex.message;
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
            const result = await api('POST', '/session', { key: input.value });
            state.signedInWithKey = true;
            await acceptSignIn(result);
          } catch (ex) {
            err.textContent =
              ex.message === 'invalid API key'
                ? i18n.t('Такого ключа нет. Возможно, его перевыпустили.')
                : ex.message === 'missing or malformed API key'
                  ? i18n.t('Это не ключ. Ключ — длинная строка, которая начинается с ait_; имя аккаунта не подходит.')
                  : ex.message;
          }
        },
      },
      h('div', { class: 'row' }, h('h1', { style: 'margin:0' }, 'AI Guild'), h('span', { class: 'spacer' }), i18n.languagePicker()),
      h('p', { class: 'muted', style: 'margin:0' }, i18n.t('Войдите способом, который привязан к вашему аккаунту.')),
      providerButtons(err),
      !Object.values(state.config?.providers ?? {}).some(Boolean) && h('p', { class: 'muted small', style: 'margin:0' }, i18n.t('Вход через Google и Telegram пока не настроен администратором.')),
      passkeys && h('button', { type: 'button', class: 'primary big', onclick: withPasskey }, i18n.t`Войти с ${pwa.biometryName()}`),
      passkeys && h('div', { class: 'divider' }, i18n.t('или')),
      h('p', { class: 'muted small', style: 'margin:0' }, i18n.t('Первый вход — по приглашению администратора. Если у вас уже есть API-ключ, можно войти с ним.')),
      h('label', { class: 'field' }, i18n.t('API-ключ'), input),
      h('p', { class: 'muted small', style: 'margin:0' }, i18n.t('Ключ выдаётся при создании аккаунта. На компьютере, где работает трекер, ключи лежат в папке ~/.config/ai-tracker.')),
      err,
      h('button', { class: passkeys ? '' : 'primary' }, i18n.t('Войти по ключу')),
      release() && h('p', { class: 'muted small', style: 'margin:0;text-align:center' }, i18n.t`Версия ${release()}`),
    ),
  );
}

const providerLabels = { google: 'Google', telegram: 'Telegram' };
const factorLabels = { email: 'Email', telegram: 'Telegram' };
async function acceptSignIn(result) {
  if (result.two_factor_required) {
    state.me = null;
    location.hash = '#/two-factor';
    await render();
  } else await boot();
}

async function twoFactorView() {
  const err = h('div', { class: 'error small', role: 'alert' });
  const back = async () => {
    await api('DELETE', '/auth/2fa/pending').catch(() => {});
    location.hash = '#/';
    await boot();
  };
  let pending;
  try { pending = await api('GET', '/auth/2fa/pending'); }
  catch (error) { return h('main', null, h('section', {class:'card pad stack login'},
    h('h1', null, i18n.t('Войдите снова')), h('p', null, error.message), h('button', {onclick:back}, i18n.t('Вернуться ко входу')))); }
  const code = h('input', { type:'text', inputmode:'numeric', autocomplete:'one-time-code', pattern:'[0-9]{6}', maxlength:6, required:true, placeholder:'000000', 'aria-label':i18n.t('Код подтверждения') });
  const hint = h('p', {class:'muted small',role:'status'}, i18n.t('Выберите, куда отправить код.'));
  const submit = h('button', {class:'primary big',disabled:true}, i18n.t('Подтвердить вход'));
  const buttons = pending.methods.map(method => h('button', {type:'button',disabled:!method.available,
    onclick: async e => {
      const button=e.currentTarget; err.textContent=''; button.disabled=true;
      try {
        const result=await api('POST','/auth/2fa/send',{channel:method.channel});
        hint.textContent=i18n.t`Код отправлен: ${result.masked}. Действует 5 минут.`;
        submit.disabled=false; code.focus();
        for(const b of buttons)b.disabled=true;
        let remaining=60;
        state.twoFactorTicker=setInterval(()=>{
          hint.textContent=i18n.t`Код отправлен: ${result.masked}. Повторная отправка через ${--remaining} с.`;
          if(remaining<=0){clearInterval(state.twoFactorTicker); for(let i=0;i<buttons.length;i++)buttons[i].disabled=!pending.methods[i].available; hint.textContent=i18n.t('Код действует 5 минут. Можно отправить новый.');}
        },1000);
      } catch(error){err.textContent=error.message;button.disabled=false;}
    },
  }, method.channel === 'telegram' ? method.masked : `${factorLabels[method.channel]} · ${method.masked}`));
  return h('main', null, h('form', {class:'card pad stack login',onsubmit:async e=>{
    e.preventDefault();err.textContent='';submit.disabled=true;
    try {await api('POST','/auth/2fa/verify',{code:code.value});location.hash='#/projects';await boot();}
    catch(error){err.textContent=error.message;submit.disabled=false;}
  }}, h('h1',null,i18n.t('Подтвердите вход')), h('p',{class:'muted',style:'margin:0'},i18n.t('Первый шаг пройден. Теперь введите одноразовый код.')),
    ...buttons, pending.methods.every(m=>!m.available)&&h('p',{class:'error small'},i18n.t('Отправка кодов недоступна. Обратитесь к администратору для восстановления доступа.')),
    hint,h('label',{class:'field'},i18n.t('Код из шести цифр'),code),err,submit,
    h('button',{type:'button',class:'ghost',onclick:back},i18n.t('Другой аккаунт'))));
}

function enrollTwoFactor(channel) {
  dialog(i18n.t`Подключить ${factorLabels[channel]} для 2FA`, (form, {close,err})=>{
    const email=h('input',{type:'email',autocomplete:'email',required:channel==='email',placeholder:'you@example.com'});
    const phone=h('input',{type:'tel',autocomplete:'tel',required:channel==='telegram',placeholder:'+79991234567',pattern:'\\+[1-9][0-9]{7,14}'});
    const code=h('input',{inputmode:'numeric',autocomplete:'one-time-code',pattern:'[0-9]{6}',maxlength:6,placeholder:'000000','aria-label':i18n.t('Код подтверждения канала')});
    const codeLabel=h('label',{class:'field',hidden:true},i18n.t('Код подтверждения'),code);
    const status=h('p',{class:'muted small',role:'status'});
    const send=h('button',{type:'button',onclick:async e=>{
      err.textContent='';e.currentTarget.disabled=true;
      try{
        const field=channel==='email'?email:phone;if(!field.reportValidity()){send.disabled=false;return;}
        const result=await api('POST','/auth/2fa/enroll',{channel,...(channel==='email'?{email:email.value}:{phone:phone.value})});
        enrollmentToken=result.enrollment_token;status.textContent=i18n.t`Код отправлен: ${result.masked}. Действует 5 минут.`;
        codeLabel.hidden=false;code.required=true;confirm.hidden=false;code.focus();
        let seconds=60;const ticker=setInterval(()=>{send.textContent=i18n.t`Отправить снова (${--seconds} с)`;
          if(seconds<=0||!send.isConnected){clearInterval(ticker);send.textContent=i18n.t('Отправить снова');send.disabled=false;}},1000);
      }catch(error){err.textContent=error.message;send.disabled=false;}
    }},i18n.t('Получить код'));
    const confirm=h('button',{class:'primary',hidden:true},i18n.t('Включить 2FA'));
    let enrollmentToken;
    appendChildren(form, h('p',{class:'muted'},i18n.t('Второй шаг будет включён только после подтверждения кода. Другие устройства потребуется авторизовать заново.')),
      channel==='email'?h('label',{class:'field'},i18n.t('Почта для кодов'),email)
        :h('div',{class:'stack'},h('label',{class:'field'},i18n.t('Номер телефона в Telegram'),phone),
          h('p',{class:'muted small'},i18n.t('Укажите номер с кодом страны. Нажимая «Получить код», вы соглашаетесь получать коды входа в официальном чате Telegram Verification Codes.'))),
      status,codeLabel,h('div',{class:'row'},send,confirm,h('button',{type:'button',class:'ghost',onclick:close},i18n.t('Отмена'))));
    form.addEventListener('submit',async e=>{
      e.preventDefault();err.textContent='';confirm.disabled=true;
      try{await api('POST','/auth/2fa/enroll/verify',{enrollment_token:enrollmentToken,code:code.value});close();toast(i18n.t('2FA включена'));await render();}
      catch(error){err.textContent=error.message;confirm.disabled=false;}
    });
  });
}
function providerButtons(err, intent = 'login', invitationToken) {
  return h('div', { class: 'stack' }, Object.entries(providerLabels).map(([provider, label]) =>
    h('button', { type: 'button', class: 'big', disabled: !state.config?.providers?.[provider],
      title: state.config?.providers?.[provider] ? '' : i18n.t`${label} пока не настроен администратором`,
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
    }, `${intent === 'link' || invitationToken ? i18n.t('Привязать') : i18n.t('Войти через')} ${label}`),
  ));
}

async function invitationView(token) {
  const err = h('div', { class: 'error small', role: 'alert' });
  let invite;
  try { invite = await api('POST', '/auth/invitations/inspect', { token }); }
  catch { return h('main', null, h('section', { class: 'card pad stack login' },
    h('h1', null, i18n.t('Приглашение недоступно')),
    h('p', null, i18n.t('Ссылка уже использована, истекла или была заменена. Попросите администратора выдать новую.')),
    h('a', { href: '#/' }, i18n.t('Перейти ко входу')))); }
  return h('main', null, h('section', { class: 'card pad stack login' },
    h('h1', null, i18n.t('Добро пожаловать')), h('p', { style: 'margin:0' }, i18n.t('Администратор пригласил вас в AI Guild.')),
    h('div', { class: 'row' }, avatar(invite.name, 'human'), h('strong', null, invite.name)),
    h('p', { class: 'muted', style: 'margin:0' }, i18n.t('Выберите аккаунт для входа. Он будет привязан к вашему профилю.')),
    providerButtons(err, 'login', token), err,
    !Object.values(state.config?.providers ?? {}).some(Boolean) && h('p', { class: 'muted small' }, i18n.t('Администратору нужно настроить Google или Telegram. Ссылка останется доступной до указанного срока.')),
    h('p', { class: 'muted small', style: 'margin:0' }, i18n.t`Ссылка действует до ${fmtDate(invite.expires_at)}. Второй способ входа можно добавить в профиле.`),
    state.me && h('p', { class: 'muted small' }, i18n.t`Сейчас вы вошли как ${state.me.name}. По приглашению будет открыт аккаунт ${invite.name}.`),
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
  appendChildren(form, err);
  dlg.append(form);
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

// ---------- tasks list ----------

const filters = { status: 'open', assignee: '', project: '', level: '', kind: '', q: '' };

async function tasksView(context) {
  const list = h('div', { class: 'card task-list' }, h('div', { class: 'empty' }, i18n.t('Загрузка…')));
  const projectsPromise = api('GET', '/projects').catch(() => []);
  let request = 0;
  let snapshot;

  const load = async () => {
    const seq = ++request;
    const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
    try {
      const tasks = await api('GET', `/tasks?${qs}`);
      if (seq !== request) return;
      const next = JSON.stringify(tasks);
      if (snapshot === next) return;
      snapshot = next;
      list.replaceChildren(
        ...(tasks.length ? treeRows(tasks) : [h('div', { class: 'empty' }, i18n.t('Задач по этим фильтрам нет'))]),
      );
    } catch (ex) {
      if (seq !== request) return;
      if (ex.offline && snapshot !== undefined) return;
      snapshot = undefined;
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
  context.setPoll(load);
  const projects = await projectsPromise;

  return shell(
    'tasks',
    h(
      'div',
      { class: 'page-head' },
      h('h1', null, i18n.t('Задачи')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'primary', onclick: () => newTaskDialog(projects) }, i18n.t('Новая задача')),
    ),
    h(
      'div',
      { class: 'filters' },
      h(
        'select',
        { 'aria-label': i18n.t('Статус'), ...bind('status') },
        h('option', { value: 'open' }, i18n.t('Открытые')),
        h('option', { value: '' }, i18n.t('Все')),
        Object.entries(STATUS).map(([v, l]) => h('option', { value: v }, l)),
      ),
      h(
        'select',
        { 'aria-label': i18n.t('Исполнитель'), ...bind('assignee') },
        h('option', { value: '' }, i18n.t('Любой исполнитель')),
        h('option', { value: 'me' }, i18n.t('Я')),
        h('option', { value: 'none' }, i18n.t('Не назначен')),
        state.accounts.filter((a) => !a.disabled).map((a) => h('option', { value: a.name }, a.name)),
      ),
      h(
        'select',
        { 'aria-label': i18n.t('Проект'), ...bind('project') },
        h('option', { value: '' }, i18n.t('Все проекты')),
        projects.map((p) => h('option', { value: p }, p)),
      ),
      h(
        'select',
        { 'aria-label': i18n.t('Уровень'), ...bind('level') },
        h('option', { value: '' }, i18n.t('Все уровни')),
        Object.entries(LEVEL).map(([v, l]) => h('option', { value: v }, l)),
      ),
      h(
        'select',
        { 'aria-label': i18n.t('Тип'), ...bind('kind') },
        h('option', { value: '' }, i18n.t('Все типы')),
        Object.entries(KIND).map(([v, l]) => h('option', { value: v }, l)),
        h('option', { value: 'none' }, i18n.t('Без типа')),
      ),
      h('input', {
        type: 'search',
        placeholder: i18n.t('Поиск…'),
        'aria-label': i18n.t('Поиск'),
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
        t.child_count > 0 && h('span', { title: i18n.t('Готово из вложенных') }, `${t.child_done}/${t.child_count}`),
        t.project && h('span', null, t.project),
        ['high', 'urgent'].includes(t.priority) && h('span', { class: `prio-${t.priority}` }, PRIORITY[t.priority]),
        t.labels.map((l) => h('span', { class: 'chip' }, l)),
      ),
    ),
    h(
      'div',
      { class: 'task-meta' },
      t.total_seconds > 0 && h('span', { title: i18n.t('Затрачено времени') }, '⏱ ' + fmtDuration(t.total_seconds)),
      t.comment_count > 0 && h('span', { title: i18n.t('Комментарии') }, '💬 ' + t.comment_count),
      t.attachment_count > 0 && h('span', { title: i18n.t('Вложения') }, '📎 ' + t.attachment_count),
      t.assignee_name
        ? h('span', { class: 'row', style: 'gap:4px;flex-wrap:nowrap' }, avatar(t.assignee_name, kindOf(t.assignee_name)), t.assignee_name)
        : h('span', null, i18n.t('не назначен')),
      time(t.updated_at),
    ),
  );
}

const treeRows = (tasks) => asTree(tasks).map(([t, depth]) => taskRow(t, depth));

function newTaskDialog(projects, preset = {}) {
  dialog(i18n.t('Новая задача'), (form, { close, err }) => {
    const title = h('input', { required: true, maxlength: 300, autofocus: true, value: preset.title ?? '' });
    const description = h('textarea', { placeholder: i18n.t('Что нужно сделать. Markdown; картинку можно вставить из буфера или перетащить.') });
    description.value = preset.text ?? '';
    const shared = [...(preset.files ?? [])];
    acceptImages(description, (file) => shared.push(file));
    offerMentions(description);
    const assignee = h(
      'select',
      null,
      h('option', { value: '' }, i18n.t('Не назначен')),
      state.accounts.filter((a) => !a.disabled).map((a) => h('option', { value: a.name }, `${a.name} (${a.kind === 'agent' ? i18n.t('агент') : i18n.t('человек')})`)),
    );
    const priority = h('select', null, Object.entries(PRIORITY).map(([v, l]) => h('option', { value: v, selected: v === 'normal' }, l)));
    const project = h('input', { list: 'projects', maxlength: 100, value: preset.project ?? '' });
    const parent = preset.parent;
    // Under a parent only the levels below it make sense.
    const allowed = parent ? LEVELS.slice(LEVELS.indexOf(parent.level) + 1) : LEVELS;
    const wanted = preset.level ?? (parent ? allowed[0] : 'task');
    const level = h('select', null, allowed.map((v) => h('option', { value: v, selected: v === wanted }, LEVEL[v])));
    const kind = h('select', null, h('option', { value: '' }, i18n.t('Не указан')), Object.entries(KIND).map(([v, l]) => h('option', { value: v, selected: v === preset.kind }, l)));
    appendChildren(form,
      parent && h('div', { class: 'muted small' }, i18n.t('Входит в: '), levelChip(parent.level), ` #${parent.id} ${parent.title}`),
      h('label', { class: 'field' }, i18n.t('Название'), title),
      h('label', { class: 'field' }, i18n.t('Описание'), description),
      h('div', { class: 'grid-2' }, h('label', { class: 'field' }, i18n.t('Уровень'), level), h('label', { class: 'field' }, i18n.t('Тип'), kind)),
      h('div', { class: 'grid-2' }, h('label', { class: 'field' }, i18n.t('Исполнитель'), assignee), h('label', { class: 'field' }, i18n.t('Приоритет'), priority)),
      !parent && h('label', { class: 'field' }, i18n.t('Проект'), project, h('datalist', { id: 'projects' }, projects.map((p) => h('option', { value: p })))),
      preset.files?.length > 0 && h('div', { class: 'muted small' }, i18n.t`Будут приложены: ${preset.files.map((f) => f.name).join(', ')}`),
      h(
        'div',
        { class: 'row', style: 'justify-content:flex-end' },
        h('button', { type: 'button', class: 'ghost', onclick: close }, i18n.t('Отмена')),
        h('button', { class: 'primary' }, i18n.t('Создать')),
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
  task_created: () => i18n.t('создал(а) задачу'),
  task_assigned: (d) => (d.assignee ? i18n.t`назначил(а) исполнителем ${d.assignee}` : i18n.t('снял(а) исполнителя')),
  status_changed: (d) => i18n.t`сменил(а) статус: ${STATUS[d.from] ?? d.from} → ${STATUS[d.to] ?? d.to}`,
  task_edited: (d) => i18n.t`изменил(а): ${(d.fields ?? []).join(', ')}`,
  result_submitted: (d) => i18n.t`отправил(а) результат → ${STATUS[d.to] ?? d.to}`,
  attachment_added: (d) => i18n.t`приложил(а) файл ${d.filename}`,
  link_added: (d) => i18n.t`добавил(а) связь: ${(LINK[d.type] ?? d.type).toLowerCase()} #${d.task_id}`,
  agent_run: (d) =>
    ({ started: i18n.t('запущен по сообщению человека'), finished: i18n.t('закончил запуск'), failed: i18n.t`запуск не удался${d.detail ? `: ${d.detail.slice(-300)}` : ''}` })[d.state] ?? d.state,
  link_removed: (d) => i18n.t`убрал(а) связь: ${(LINK[d.type] ?? d.type).toLowerCase()} #${d.task_id}`,
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
  const strip = h('div', { class: 'viewer-strip', role: 'tablist', 'aria-label': i18n.t('Вложения') });
  const step = (by) => show((at + by + items.length) % items.length);
  const prev = h('button', { class: 'viewer-nav prev', 'aria-label': i18n.t('Предыдущее'), onclick: () => step(-1) }, '‹');
  const next = h('button', { class: 'viewer-nav next', 'aria-label': i18n.t('Следующее'), onclick: () => step(1) }, '›');

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
      h('span', { class: 'muted small' }, `${fmtSize(a.size)} · ${a.account_name}${items.length > 1 ? i18n.t` · ${at + 1} из ${items.length}` : ''}`),
    );
    actions.replaceChildren(
      ...[
        isPage(a) &&
          h('button', { class: 'small', 'aria-pressed': String(asSource), onclick: () => ((asSource = !asSource), show(at)) }, asSource ? i18n.t('Страница') : i18n.t('Исходный код')),
        h('a', { class: 'button small', href: a.url, download: a.filename }, i18n.t('Скачать')),
        h('button', { class: 'small', 'aria-label': i18n.t('Закрыть'), onclick: () => dlg.close() }, '✕'),
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
      'aria-label': i18n.t('Просмотр вложения'),
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

async function taskView(id, context) {
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
    context.setTitle(`#${t.id} ${t.title} · AI Guild`);
    head.replaceChildren(...[
      h(
        'nav',
        { class: 'small crumbs', 'aria-label': i18n.t('Путь') },
        t.project ? h('a', { href: `#/projects/${encodeURIComponent(t.project)}` }, t.project) : h('a', { href: '#/tasks' }, i18n.t('Все задачи')),
        t.ancestors.map((p) => [h('span', { class: 'muted', 'aria-hidden': 'true' }, ' › '), h('a', { href: `#/tasks/${p.id}` }, `${LEVEL[p.level]} #${p.id} ${p.title}`)]),
      ),
      h('div', { class: 'page-head' }, h('h1', null, h('span', { class: 'muted' }, `#${t.id} `), t.title), statusChip(t.status), levelChip(t.level), kindChip(t.kind)),
      t.status === 'review' &&
        h(
          'div',
          { class: 'card review-bar' },
          h('div', null, h('strong', null, i18n.t('Ждёт вашего решения. ')), i18n.t`${t.result_by_name ?? t.assignee_name ?? i18n.t('Агент')} сдал работу — посмотрите результат ниже.`),
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'primary', onclick: () => patch({ status: 'done' }) }, i18n.t('Принять')),
            h(
              'button',
              {
                onclick: async () => {
                  await patch({ status: 'in_progress' });
                  text.placeholder = i18n.t('Что доделать? Агент увидит это в своих входящих.');
                  text.focus();
                },
              },
              i18n.t('Вернуть в работу'),
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
          h('button', { class: 'ghost small', onclick: () => editTaskDialog(t, load) }, i18n.t('Изменить')),
        ),
        h('div', { class: 'comment-body' }, t.description ? markdown(t.description, t.attachments) : h('span', { class: 'muted' }, i18n.t('Без описания')), originalWords(t.original_text)),
      ),
      t.result &&
        h(
          'section',
          { class: 'card result', style: 'margin-top:12px' },
          h(
            'div',
            { class: 'comment-head' },
            h('strong', null, i18n.t('Результат')),
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
            h('strong', null, i18n.t('Состоит из')),
            t.children.length > 0 && h('span', { class: 'muted' }, i18n.t`готово ${t.child_done} из ${t.child_count}`),
            h('span', { class: 'spacer' }),
            h('button', { class: 'ghost small', onclick: async () => newTaskDialog(await api('GET', '/projects').catch(() => []), { parent: t, kind: t.kind }) }, i18n.t('Добавить')),
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
            : h('div', { class: 'comment-body muted small' }, i18n.t('Пока не разбита на части')),
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
        h('div', { class: 'comment-head' }, avatar(state.me.name, state.me.kind), h('strong', null, state.me.name), h('span', { class: 'chip' }, i18n.t('ждёт сети')), h('span', { class: 'spacer' }), time(c.at)),
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
          h('span', null, i18n.t('Статус')),
          select(t.status, Object.entries(STATUS), (v) => patch({ status: v })),
          h('span', null, i18n.t('Исполнитель')),
          select(
            t.assignee_name ?? '',
            [['', i18n.t('Не назначен')], ...state.accounts.filter((a) => !a.disabled || a.name === t.assignee_name).map((a) => [a.name, a.name])],
            (v) => patch({ assignee: v || null }),
          ),
          h('span', null, i18n.t('Уровень')),
          select(t.level, Object.entries(LEVEL), (v) => patch({ level: v })),
          h('span', null, i18n.t('Тип')),
          select(t.kind ?? '', [['', i18n.t('Не указан')], ...Object.entries(KIND)], (v) => patch({ kind: v || null })),
          h('span', null, i18n.t('Приоритет')),
          select(t.priority, Object.entries(PRIORITY), (v) => patch({ priority: v })),
          h('span', null, i18n.t('Проект')),
          h('input', { value: t.project ?? '', placeholder: '—', onchange: (e) => patch({ project: e.target.value.trim() || null }) }),
          h('span', null, i18n.t('Создана')),
          h('span', { class: 'small' }, fmtDate(t.created_at)),
          t.completed_at && [h('span', null, i18n.t('Завершена')), h('span', { class: 'small' }, fmtDate(t.completed_at))],
        ),
        err,
      ),
      linksCard(t, load, err),
      h(
        'div',
        { class: 'card pad' },
        h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' }, h('h3', { style: 'margin:0' }, i18n.t('Время')), h('strong', null, fmtDuration(t.total_seconds))),
        t.tree_seconds > t.total_seconds && h('div', { class: 'muted small', style: 'margin-bottom:8px' }, i18n.t`С вложенными задачами: ${fmtDuration(t.tree_seconds)}`),
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
                        l.cache_read_tokens != null && i18n.t`кэш ${fmtCompact(l.cache_read_tokens)}`,
                        l.cost_usd != null && fmtMoney(l.cost_usd),
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    ),
                  l.note && h('div', { class: 'muted small' }, l.note),
                ),
                l.seconds == null ? h('span', { class: 'running' }, i18n.t('● идёт')) : h('span', null, fmtDuration(l.seconds)),
              ),
            )
          : h('div', { class: 'muted small' }, i18n.t('Время ещё не списывали')),
      ),
      h(
        'div',
        { class: 'card pad' },
        h('h3', null, i18n.t`Вложения${loose.length ? ` · ${loose.length}` : ''}`),
        loose.length ? h('div', { class: 'files', style: 'grid-template-columns:1fr 1fr' }, loose.map((a) => fileCard(a, t.attachments))) : h('div', { class: 'muted small' }, i18n.t('Нет файлов')),
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
      if (state.me?.kind === 'human' && !document.hidden && context.isActive()) {
        api('POST', '/inbox/read', { task_id: id }).then(refreshInboxCount).catch(() => {});
      }
    }
  };

  try {
    await load();
  } catch (ex) {
    return shell('tasks', h('div', { class: 'empty error' }, ex.message), h('p', { style: 'text-align:center' }, h('a', { href: '#/tasks' }, i18n.t('← Все задачи'))));
  }
  context.setPoll(load);

  const text = h('textarea', { placeholder: i18n.t('Комментарий для агентов. Упомяните через @имя; картинку можно вставить из буфера.'), required: true });
  const pasted = [];
  acceptImages(text, (file) => pasted.push(file));
  offerMentions(text);
  const files = h('input', { type: 'file', multiple: true, 'aria-label': i18n.t('Файлы') });
  const reopen = h('input', { type: 'checkbox' });
  const formErr = h('div', { class: 'error small', role: 'alert' });
  const send = h('button', { class: 'primary', title: i18n.t`Отправить (${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'}+Enter)` }, i18n.t('Отправить'));
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
            toast(i18n.t('Нет сети. Комментарий отправится, когда связь вернётся'));
            await load().catch(() => {});
          } else {
            formErr.textContent = pwa.isNetworkError(ex) ? i18n.t('Нет сети. Файлы можно отправить только со связью.') : ex.message;
          }
        } finally {
          send.disabled = false;
        }
      },
    },
    h('h2', null, i18n.t('Комментарий')),
    text,
    h(
      'div',
      { class: 'row' },
      files,
      h('span', { class: 'spacer' }),
      h('label', { class: 'row small', style: 'gap:4px' }, reopen, i18n.t('Вернуть в работу')),
      send,
    ),
    formErr,
  );

  return shell('tasks', head, h('div', { class: 'detail' }, h('div', null, body, timeline, composer), side));
}

function linksCard(t, reload, err) {
  const type = h('select', { 'aria-label': i18n.t('Вид связи') }, Object.entries(LINK).map(([v, l]) => h('option', { value: v }, l)));
  const other = h('input', { type: 'number', min: 1, placeholder: '№', 'aria-label': i18n.t('Номер задачи'), style: 'width:72px', required: true });
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
    h('h3', null, i18n.t`Связи${t.links.length ? ` · ${t.links.length}` : ''}`),
    waiting.length > 0 && !['done', 'cancelled'].includes(t.status) && h('div', { class: 'blocked-note' }, i18n.t`⚠ Ждёт ${waiting.length === 1 ? i18n.t('задачу') : i18n.t('задачи')} ${waiting.map((l) => '#' + l.task.id).join(', ')}`),
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
        h('button', { class: 'ghost small', title: i18n.t('Убрать связь'), 'aria-label': i18n.t`Убрать связь с задачей ${l.task.id}`, onclick: () => run(() => api('DELETE', `/tasks/${t.id}/links/${l.id}`)) }, '×'),
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
      h('button', { class: 'small' }, i18n.t('Связать')),
    ),
  );
}

function editTaskDialog(t, reload) {
  dialog(i18n.t`Задача #${t.id}`, (form, { close, err }) => {
    const title = h('input', { required: true, maxlength: 300, value: t.title });
    const description = h('textarea', { style: 'min-height:220px', placeholder: i18n.t('Markdown; картинку можно вставить из буфера или перетащить.') });
    description.value = t.description;
    const added = [];
    acceptImages(description, (file) => added.push(file));
    offerMentions(description);
    appendChildren(form,
      h('label', { class: 'field' }, i18n.t('Название'), title),
      h('label', { class: 'field' }, i18n.t('Описание'), description),
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { type: 'button', class: 'ghost', onclick: close }, i18n.t('Отмена')), h('button', { class: 'primary' }, i18n.t('Сохранить'))),
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
  if (!parts.length) return h('div', { class: 'muted small' }, i18n.t('Задач пока нет'));
  return h(
    'div',
    null,
    h(
      'div',
      { class: 'status-bar', role: 'img', 'aria-label': parts.map(([s, n]) => `${STATUS[s]}: ${n}`).join(', ') },
      parts.map(([s, n]) => withTip(h('span', { class: `seg-${s}`, style: `flex-grow:${n}` }), STATUS[s], i18n.t`${n} из ${p.tasks}`)),
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
      h('div', { style: 'min-width:0' }, h('h2', null, p.name), h('div', { class: 'muted small' }, p.last_activity_at ? i18n.t`Активность ${fmtAgo(p.last_activity_at)}` : i18n.t('Ещё не начат'))),
    ),
    h('p', { class: 'project-teaser' }, teaser(p.description) || h('span', { class: 'muted' }, i18n.t('Без описания'))),
    statusBar(p),
    h(
      'div',
      { class: 'project-foot' },
      h('span', { class: 'row', style: 'gap:2px;flex-wrap:nowrap' }, p.members.map((m) => h('span', { title: m.name }, avatar(m.name, m.kind)))),
      h('span', { class: 'spacer' }),
      p.total_seconds > 0 && h('span', { title: i18n.t('Затрачено времени') }, '⏱ ' + fmtDuration(p.total_seconds)),
      p.cost_usd > 0 && h('span', { title: i18n.t('Стоимость по прайсу API') }, fmtMoney(p.cost_usd)),
    ),
  );
}

function projectDialog(p, done) {
  dialog(p ? i18n.t('Проект') : i18n.t('Новый проект'), (form, { close, err }) => {
    const name = h('input', { required: true, maxlength: 100, value: p?.name ?? '', autofocus: !p });
    const description = h('textarea', { placeholder: i18n.t('О чём проект. Markdown.') });
    description.value = p?.description ?? '';
    const color = h('input', { type: 'color', value: p?.color ?? '#2a78d6', style: 'padding:2px;height:36px;width:64px' });
    const logo = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    appendChildren(form,
      h('label', { class: 'field' }, i18n.t('Название'), name),
      h('label', { class: 'field' }, i18n.t('Описание'), description),
      h('div', { class: 'grid-2' }, h('label', { class: 'field' }, i18n.t('Логотип (PNG, JPEG, WebP до 5 МБ)'), logo), h('label', { class: 'field' }, i18n.t('Цвет'), color)),
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { type: 'button', class: 'ghost', onclick: close }, i18n.t('Отмена')), h('button', { class: 'primary' }, p ? i18n.t('Сохранить') : i18n.t('Создать'))),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const body = { name: name.value, description: description.value, color: color.value };
        const saved = p ? await api('PATCH', `/projects/${p.id}`, body) : await api('POST', '/projects', body);
        if (logo.files[0]) {
          const res = await fetch(`/api/projects/${saved.id}/logo`, { method: 'PUT', headers: { 'Content-Type': logo.files[0].type }, body: logo.files[0] });
          if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? i18n.t('Не удалось загрузить логотип'));
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
  const [projects, loose] = await Promise.all([
    api('GET', '/projects?details=1'),
    api('GET', '/tasks?limit=500&status=').then((all) => all.filter((t) => !t.project).length, () => 0),
  ]);
  return shell(
    'projects',
    h('div', { class: 'page-head' }, h('h1', null, i18n.t('Проекты')), h('span', { class: 'spacer' }), h('button', { class: 'primary', onclick: () => projectDialog(null, (p) => (location.hash = `#/projects/${encodeURIComponent(p.name)}`)) }, i18n.t('Новый проект'))),
    projects.length
      ? h('div', { class: 'project-grid' }, projects.map(projectCard))
      : h('div', { class: 'card empty' }, i18n.t('Проектов пока нет')),
    loose > 0 && h('p', { class: 'muted small' }, h('a', { href: '#/tasks' }, i18n.t`Задач без проекта: ${loose}`)),
  );
}

async function projectView(name, context) {
  const projects = await api('GET', '/projects?details=1');
  const p = projects.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!p) return shell('projects', h('div', { class: 'empty' }, i18n.t`Проекта «${name}» нет`), h('p', { style: 'text-align:center' }, h('a', { href: '#/projects' }, i18n.t('← Все проекты'))));
  context.setTitle(`${p.name} · AI Guild`);

  const list = h('div', { class: 'card task-list' });
  let only = 'open';
  const load = async () => {
    const qs = new URLSearchParams({ project: p.name, limit: '500', ...(only && { status: only }) });
    const tasks = await api('GET', `/tasks?${qs}`);
    list.replaceChildren(...(tasks.length ? treeRows(tasks) : [h('div', { class: 'empty' }, only === 'open' ? i18n.t('Открытых задач нет') : i18n.t('Задач нет'))]));
  };
  await load();
  context.setPoll(load);

  const tile = (label, value, hint) => h('div', { class: 'card pad' }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value), hint && h('div', { class: 'muted small' }, hint));
  const st = p.tasks_by_status;
  const filter = h(
    'select',
    { 'aria-label': i18n.t('Статус'), onchange: (e) => { only = e.target.value; load(); } },
    h('option', { value: 'open' }, i18n.t('Открытые')),
    h('option', { value: '' }, i18n.t('Все')),
    Object.entries(STATUS).map(([v, l]) => h('option', { value: v }, l)),
  );

  return shell(
    'projects',
    h('div', { class: 'small', style: 'margin-bottom:10px' }, h('a', { href: '#/projects' }, i18n.t('← Все проекты'))),
    h(
      'section',
      { class: 'card project-hero', style: p.color ? `--project:${p.color}` : '' },
      projectLogo(p, 88),
      h(
        'div',
        { style: 'min-width:0;flex:1' },
        h('div', { class: 'row' }, h('h1', null, p.name), h('span', { class: 'spacer' }), h('a', { class: 'button', href: `#/board/${encodeURIComponent(p.name)}` }, i18n.t('Доска')), h('a', { class: 'button', href: `#/timeline/${encodeURIComponent(p.name)}` }, i18n.t('График')), h('button', { onclick: () => projectDialog(p, (saved) => (saved.name === p.name ? render() : (location.hash = `#/projects/${encodeURIComponent(saved.name)}`))) }, i18n.t('Изменить'))),
        p.description ? markdown(p.description) : h('p', { class: 'muted' }, i18n.t('Без описания')),
        h('div', { class: 'row', style: 'margin-top:10px' }, p.members.map((m) => h('span', { class: 'chip' }, avatar(m.name, m.kind), m.name)), p.models.map((m) => h('span', { class: 'chip mono', title: i18n.t('Модель') }, m))),
      ),
    ),
    h(
      'div',
      { class: 'tiles', style: 'margin-top:16px' },
      tile(i18n.t('Задачи'), String(p.tasks), i18n.t`${p.open_tasks} открыто · ${st.done ?? 0} готово`),
      tile(i18n.t('На проверке'), String(st.review ?? 0), (st.blocked ?? 0) > 0 ? i18n.t`${st.blocked} заблокировано` : i18n.t('ждут вашего решения')),
      tile(i18n.t('Время'), fmtDuration(p.total_seconds)),
      tile(i18n.t('Стоимость'), fmtMoney(p.cost_usd), i18n.t('по прайсу API')),
    ),
    h('div', { class: 'card pad', style: 'margin-bottom:16px' }, statusBar(p)),
    h('div', { class: 'page-head' }, h('h2', null, i18n.t('Задачи')), filter, h('span', { class: 'spacer' }), h('button', { class: 'primary', onclick: async () => newTaskDialog(await api('GET', '/projects').catch(() => []), { project: p.name }) }, i18n.t('Новая задача'))),
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
      h('h1', null, i18n.t('Входящие')),
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
          i18n.t('Отметить всё прочитанным'),
        ),
    ),
    h('p', { class: 'muted', style: 'margin-top:-8px' }, i18n.t('Что агенты сделали по вашим задачам. Событие уходит отсюда, когда вы открываете задачу или нажимаете «Прочитано». У каждого агента такой же ящик — в него попадают ваши комментарии.')),
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
                    e.type === 'comment_added' ? i18n.t('прокомментировал(а)') : (EVENT_TEXT[e.type] ?? (() => e.type))(e.data),
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
                      title: i18n.t('Убрать из входящих всё по этой задаче'),
                      'aria-label': i18n.t`Отметить прочитанным: задача ${e.task_id}`,
                      onclick: async (click) => {
                        click.preventDefault();
                        await api('POST', '/inbox/read', { task_id: e.task_id });
                        render();
                      },
                    },
                    i18n.t('Прочитано'),
                  ),
                ),
              ),
            )
        : h('div', { class: 'empty' }, i18n.t('Новых событий нет')),
    ),
  );
}

// ---------- analytics ----------

const an = { range: '30', group: 'model', measure: 'seconds', project: '' };
const MEASURES = {
  seconds: { label: i18n.t('Время'), fmt: fmtDuration },
  cost_usd: { label: i18n.t('Стоимость'), fmt: fmtMoney },
  tokens: { label: i18n.t('Токены'), fmt: fmtCompact },
  tasks: { label: i18n.t('Задачи'), fmt: (n) => String(n) },
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
      i18n.t`Время: ${fmtDuration(r.seconds)}`,
      i18n.t`Задач: ${r.tasks} · записей: ${r.entries}`,
      i18n.t`Токены: ${fmtCompact(r.input_tokens)} in / ${fmtCompact(r.output_tokens)} out`,
      i18n.t`Кэш: ${fmtCompact(r.cache_read_tokens)} чтение / ${fmtCompact(r.cache_write_tokens)} запись`,
      i18n.t`Стоимость: ${analyticsCost(r)}`,
    ].join('\n'),
  ];
}

function barChart(rows) {
  const top = rows.slice().sort((a, b) => measureOf(b) - measureOf(a)).slice(0, 12);
  const max = Math.max(...top.map(measureOf), 0);
  if (!max) return h('div', { class: 'empty' }, i18n.t('Нет данных за период'));
  return h(
    'div',
    { class: 'bars' },
    top.map((r) => {
      const name = r.keys[0] ?? i18n.t('— не указано');
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
  if (!max) return h('div', { class: 'empty' }, i18n.t('Нет данных за период'));
  const label = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString(i18n.dateLocale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return h(
    'div',
    null,
    h('div', { class: 'muted small', style: 'margin-bottom:4px' }, i18n.t`макс. ${MEASURES[an.measure].fmt(max)}`),
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
        h('tr', null, h('th', null, groupLabel), [i18n.t('Время'), i18n.t('Задач'), i18n.t('Записей'), i18n.t('Токены in'), i18n.t('Токены out'), i18n.t('Кэш: чтение'), i18n.t('Кэш: запись'), i18n.t('Стоимость'), i18n.t('$/час')].map((c) => h('th', { class: 'num' }, c))),
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
        h('p', { class: 'muted small', style: 'padding:0 16px 12px' }, i18n.t('* Оценка по тарифу GPT-5.6 Luna. Фактическая модель и тариф codex-auto-review не опубликованы; оценка не включена в итоговую стоимость.')),
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
    h('div', { class: 'page-head' }, h('h1', null, i18n.t('Аналитика'))),
    h(
      'div',
      { class: 'filters' },
      seg('range', [['7', i18n.t('7 дней')], ['30', i18n.t('30 дней')], ['90', i18n.t('90 дней')], ['all', i18n.t('Всё время')]]),
      h('select', { 'aria-label': i18n.t('Проект'), onchange: set('project') }, h('option', { value: '' }, i18n.t('Все проекты')), projects.map((p) => h('option', { value: p, selected: p === an.project }, p))),
      h('span', { class: 'spacer' }),
      seg('measure', Object.entries(MEASURES).map(([v, m]) => [v, m.label])),
    ),
    h(
      'div',
      { class: 'tiles' },
      tile(i18n.t('Время работы'), fmtDuration(t.seconds), i18n.t`${t.entries} записей по ${t.tasks} задачам`),
      tile(i18n.t('Стоимость'), fmtMoney(t.cost_usd), t.unpriced_entries ? i18n.t`${t.unpriced_entries} записей без подтверждённой цены` : t.seconds ? i18n.t`${fmtMoney(t.cost_usd / (t.seconds / 3600))} за час` : null),
      tile(i18n.t('Токены'), fmtCompact(t.input_tokens + t.output_tokens), i18n.t`${fmtCompact(t.input_tokens)} in · ${fmtCompact(t.output_tokens)} out · кэш ${fmtCompact(t.cache_read_tokens)}`),
      tile(i18n.t('Задачи'), i18n.t`${st.done ?? 0} готово`, i18n.t`${open} открыто · ${st.review ?? 0} на проверке`),
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
          h('select', { 'aria-label': i18n.t('Группировка'), onchange: set('group') }, Object.entries(GROUPS).map(([v, l]) => h('option', { value: v, selected: v === an.group }, l))),
        ),
        barChart(grouped.rows),
      ),
      h('section', { class: 'card pad' }, h('div', { class: 'chart-head' }, h('h2', null, i18n.t`${MEASURES[an.measure].label} по дням`), h('span', { class: 'muted small' }, 'UTC')), dayChart(daily.rows, from, to)),
    ),
    h('section', { class: 'card', style: 'margin-top:16px' }, h('div', { class: 'pad', style: 'padding-bottom:4px' }, h('h2', null, i18n.t('Модель × effort'))), matrix.rows.length ? statsTable(matrix.rows, i18n.t('Модель · effort')) : h('div', { class: 'empty' }, i18n.t('Нет данных за период'))),
  );
}

// ---------- accounts ----------

function showKey(name, key) {
  dialog(i18n.t`Ключ для ${name}`, (form, { close }) => {
    appendChildren(form,
      h('p', { style: 'margin:0' }, i18n.t('Ключ показывается один раз. Сохраните его сейчас — восстановить нельзя, только выпустить новый.')),
      h('div', { class: 'keybox' }, key),
      h(
        'div',
        { class: 'row', style: 'justify-content:flex-end' },
        h('button', { type: 'button', onclick: (e) => navigator.clipboard.writeText(key).then(() => (e.target.textContent = i18n.t('Скопировано'))) }, i18n.t('Скопировать')),
        h('button', { type: 'button', class: 'primary', onclick: close }, i18n.t('Готово')),
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
    dialog(i18n.t('Новый аккаунт'), (form, { close, err }) => {
      const name = h('input', { required: true, pattern: '[a-zA-Z0-9][a-zA-Z0-9_.\\-]{0,39}', placeholder: 'claude-backend', autofocus: true });
      const kind = h('select', null, h('option', { value: 'agent' }, i18n.t('Агент')), h('option', { value: 'human' }, i18n.t('Человек')));
      const system = h('input', { placeholder: 'claude, codex…', list: 'systems' });
      const role = h('select', null, h('option', { value: 'member' }, i18n.t('Участник')), h('option', { value: 'admin' }, i18n.t('Администратор')));
      appendChildren(form,
        h('label', { class: 'field' }, i18n.t('Имя (латиница, для @упоминаний)'), name),
        h('div', { class: 'grid-2' }, h('label', { class: 'field' }, i18n.t('Тип'), kind), h('label', { class: 'field' }, i18n.t('Роль'), role)),
        h('label', { class: 'field' }, i18n.t('Система'), system, h('datalist', { id: 'systems' }, ['claude', 'codex'].map((s) => h('option', { value: s })))),
        h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { type: 'button', class: 'ghost', onclick: close }, i18n.t('Отмена')), h('button', { class: 'primary' }, i18n.t('Создать'))),
      );
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const res = await api('POST', '/accounts', { name: name.value, kind: kind.value, role: role.value, ...(system.value.trim() && { system: system.value.trim() }) });
          close();
          await render();
          if (res.account.kind === 'human') {
            try { showInvitation(res.account.name, await api('POST', `/accounts/${res.account.id}/invitation`)); }
            catch (error) { alert(i18n.t`Аккаунт создан. Приглашение можно выдать в списке аккаунтов. ${error.message}`); }
          } else showKey(res.account.name, res.key);
        } catch (ex) {
          err.textContent = ex.message;
        }
      });
    });

  return shell(
    'accounts',
    h('div', { class: 'page-head' }, h('h1', null, i18n.t('Аккаунты')), h('span', { class: 'spacer' }), admin && h('button', { class: 'primary', onclick: create }, i18n.t('Новый аккаунт'))),
    h(
      'div',
      { class: 'card table-wrap' },
      h(
        'table',
        null,
        h('thead', null, h('tr', null, [i18n.t('Имя'), i18n.t('Тип'), i18n.t('Система'), i18n.t('Роль'), i18n.t('Ключ'), i18n.t('Активность'), ''].map((c) => h('th', null, c)))),
        h(
          'tbody',
          null,
          state.accounts.map((a) =>
            h(
              'tr',
              { style: a.disabled ? 'opacity:.5' : '' },
              h('td', null, h('span', { class: 'row', style: 'flex-wrap:nowrap' }, avatar(a.name, a.kind), a.name)),
              h('td', null, a.kind === 'agent' ? i18n.t('Агент') : i18n.t('Человек')),
              h('td', null, a.system ?? '—'),
              h('td', null, a.role === 'admin' ? i18n.t('Администратор') : i18n.t('Участник')),
              h('td', null, h('code', null, a.key_prefix + '…')),
              h('td', null, a.disabled ? i18n.t('отключён') : a.last_seen_at ? time(a.last_seen_at) : h('span', { class: 'muted small' }, i18n.t('не заходил'))),
              h(
                'td',
                null,
                admin && a.kind === 'human' && !a.disabled && h('button', { class: 'ghost',
                  onclick: () => act(async () => showInvitation(a.name, await api('POST', `/accounts/${a.id}/invitation`))) }, i18n.t('Пригласить')),
                admin && a.kind === 'human' && h('button',{class:'ghost',onclick:()=>{
                  if(confirm(i18n.t`Сбросить 2FA для ${a.name}? Все его сессии завершатся. Убедитесь, что запрос поступил от владельца аккаунта.`))
                    act(async()=>{await api('POST',`/accounts/${a.id}/reset-2fa`);toast(i18n.t('2FA сброшена'));if(a.id===state.me.id)await boot();});
                }},i18n.t('Сбросить 2FA')),
                (admin || a.id === state.me.id) &&
                  h(
                    'button',
                    {
                      class: 'ghost',
                      onclick: () =>
                        confirm(i18n.t`Выпустить новый ключ для ${a.name}? Старый перестанет работать.`) &&
                        act(async () => {
                          const res = await api('POST', `/accounts/${a.id}/rotate-key`);
                          if (a.id === state.me.id) await api('POST', '/session', { key: res.key });
                          showKey(a.name, res.key);
                        }),
                    },
                    i18n.t('Новый ключ'),
                  ),
                admin &&
                  a.id !== state.me.id &&
                  h('button', { class: 'ghost', onclick: () => act(() => api('PATCH', `/accounts/${a.id}`, { disabled: !a.disabled })) }, a.disabled ? i18n.t('Включить') : i18n.t('Отключить')),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function showInvitation(name, invitation) {
  dialog(i18n.t`Приглашение для ${name}`, (form, { close }) => {
    const input = h('input', { value: invitation.url, readonly: true, 'aria-label': i18n.t('Ссылка-приглашение') });
    appendChildren(form, h('p', { class: 'muted', style: 'margin:0' }, i18n.t('Передайте эту ссылку человеку: он привяжет Google или Telegram и войдёт в выданный аккаунт.')),
      input, h('p', { class: 'muted small' }, i18n.t`Одноразовая ссылка действует до ${fmtDate(invitation.expires_at)}. Новая ссылка заменяет предыдущую.`),
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { type: 'button', onclick: async (e) => {
          try { await navigator.clipboard.writeText(invitation.url); e.target.textContent = i18n.t('Скопировано'); }
          catch { input.select(); }
        } }, i18n.t('Скопировать ссылку')), h('button', { type: 'button', class: 'primary', onclick: close }, i18n.t('Готово'))));
  });
}

// ---------- connect ----------

function connectView() {
  const origin = location.origin;
  const block = (title, text, note) =>
    h('section', { class: 'card pad stack' }, h('h2', null, title), note && h('p', { class: 'muted', style: 'margin:0' }, note), h('div', { class: 'md' }, h('pre', null, h('code', null, text))));
  return shell(
    'connect',
    h('div', { class: 'page-head' }, h('h1', null, i18n.t('Подключение агентов'))),
    h(
      'div',
      { class: 'stack' },
      h('p', { class: 'muted', style: 'margin:0' }, i18n.t('Заведите каждому агенту свой аккаунт на странице «Аккаунты» и подставьте его ключ вместо <KEY>.')),
      block('Claude Code', `claude mcp add --transport http ai-tracker ${origin}/mcp \\\n  --header "Authorization: Bearer <KEY>"`),
      block(
        'Codex',
        `# ~/.codex/config.toml\n[mcp_servers.ai-tracker]\nurl = "${origin}/mcp"\ndefault_tools_approval_mode = "approve"\nhttp_headers = { Authorization = "Bearer <KEY>" }`,
      ),
      block(
        i18n.t('Инструкция агенту (CLAUDE.md / AGENTS.md)'),
        i18n.t(`## AI Guild\n- В начале сессии вызови get_inbox: там комментарии человека и других агентов. Выполни то, что просят, затем ack_inbox.\n- Перед работой найди или создай задачу и вызови start_timer.\n- Ход работы, вопросы и обсуждение — через add_comment; логи — attach_text; скриншоты и видео — через get_upload_command.\n- По завершении: stop_timer (с токенами и стоимостью), затем submit_result.\n- Всегда указывай свои настоящие model и effort.`),
        i18n.t('Чтобы агент сам читал ваши комментарии и доделывал задачи.'),
      ),
      block('REST', i18n.t`curl -H "Authorization: Bearer <KEY>" ${origin}/api/tasks\n\n# загрузка файла\ncurl -H "Authorization: Bearer <KEY>" -F "file=@screen.png" ${origin}/api/tasks/1/attachments\n\n# контракт\n${origin}/api/openapi.json`),
    ),
  );
}

// ---------- profile: passkeys, notifications, install ----------

async function profileView() {
  const blocker = pwa.passkeyBlocker(state.config);
  const [passkeys, pushOn, identities, secondFactor, devices] = await Promise.all([api('GET', '/passkeys'), pwa.pushEnabled().catch(() => false), api('GET', '/auth/identities'),api('GET','/auth/2fa/settings'),state.me.kind==='human'?api('GET','/devices'):[]]);
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
    h('div', { class: 'page-head' }, h('h1', null, i18n.t('Профиль')), h('span', { class: 'spacer' }), h('button', { onclick: logout }, i18n.t('Выйти'))),
    h(
      'div',
      { class: 'stack' },
      err,
      h(
        'section',
        { class: 'card pad stack' },
        h('div', { class: 'row' }, avatar(state.me.name, state.me.kind), h('strong', null, state.me.name), h('span', { class: 'chip' }, state.me.role === 'admin' ? i18n.t('Администратор') : i18n.t('Участник')), h('span', { class: 'chip mono' }, state.me.key_prefix + '…')),
      ),
      h(
        'nav',
        { class: 'card task-list mobile-only' },
        h('a', { class: 'task-row', href: '#/tasks', style: 'grid-template-columns:1fr' }, i18n.t('Все задачи списком')),
        h('a', { class: 'task-row', href: '#/timeline', style: 'grid-template-columns:1fr' }, i18n.t('График работ')),
        h('a', { class: 'task-row', href: '#/analytics', style: 'grid-template-columns:1fr' }, i18n.t('Аналитика')),
        h('a', { class: 'task-row', href: '#/accounts', style: 'grid-template-columns:1fr' }, i18n.t('Аккаунты и ключи')),
        h('a', { class: 'task-row', href: '#/connect', style: 'grid-template-columns:1fr' }, i18n.t('Подключение агентов')),
      ),
      state.me.kind === 'human' && h('section', { class: 'card pad stack' },
        h('h2',null,i18n.t('Устройства')),
        h('p',{class:'muted small',style:'margin:0'},i18n.t('Один браузер или установка приложения — одно устройство. Повторные входы объединяются.')),
        devices.map(device=>h('div',{class:'device-row'},
          h('div',{class:'stack',style:'gap:4px'},
            h('div',{class:'row'},h('strong',null,device.name),device.current&&h('span',{class:'chip'},i18n.t('Это устройство'))),
            h('span',{class:'muted small'},({desktop_browser:i18n.t('Браузер на компьютере'),mobile_browser:i18n.t('Мобильный браузер'),desktop_pwa:i18n.t('PWA на компьютере'),mobile_pwa:i18n.t('Мобильная PWA'),ios:i18n.t('Приложение iOS')})[device.client_type]),
            h('span',{class:'muted small'},i18n.t`Активность: ${fmtAgo(device.last_used_at)} · Сессий: ${device.sessions}`)),
          h('div',{class:'row'},
            h('button',{class:'ghost',onclick:()=>dialog(i18n.t('Имя устройства'),(form,{close,err})=>{
              const name=h('input',{value:device.name,maxlength:80,required:true,'aria-label':i18n.t('Имя устройства')});
              form.append(h('label',{class:'field'},i18n.t('Имя устройства'),name),h('button',{class:'primary'},i18n.t('Сохранить')));
              form.addEventListener('submit',async e=>{e.preventDefault();try{await api('PATCH',`/devices/${device.id}`,{name:name.value});close();await render();}catch(error){err.textContent=error.message;}});
            })},i18n.t('Переименовать')),
            h('button',{class:'ghost',onclick:run(async()=>{
              if(!confirm(device.current?i18n.t('Завершить все входы с этого устройства? Потребуется войти снова.'):i18n.t`Завершить все входы на устройстве «${device.name}»? Уведомления на нём будут отключены.`))return;
              await api('DELETE',`/devices/${device.id}`);
              if(device.current){pwa.forgetPrivateData();state.me=null;}
            })},i18n.t('Завершить входы'))))),
        !devices.length&&h('p',{class:'muted small'},i18n.t('Активных устройств нет')),
      ),
      state.me.kind === 'human' && h('section', { class: 'card pad stack' },
        h('h2',null,i18n.t('Двухэтапный вход')),
        h('p',{class:'muted',style:'margin:0'},secondFactor.enabled?i18n.t('После входа требуется код по одному из подключённых каналов.'):i18n.t('Включите дополнительное подтверждение входа кодом. Это необязательно.')),
        Object.entries(factorLabels).map(([channel,label])=>{
          const method=secondFactor.methods.find(m=>m.channel===channel);
          return h('div',{class:'row'},h('strong',null,label),h('span',{class:'muted small'},method?.masked??i18n.t('Не подключён')),h('span',{class:'spacer'}),
            h('button',{disabled:!secondFactor.available[channel],onclick:()=>enrollTwoFactor(channel)},method?i18n.t('Сменить'):i18n.t('Подключить')),
            method&&h('button',{class:'ghost',onclick:run(async()=>{if(confirm(i18n.t`Отключить коды ${label}?`))await api('DELETE',`/auth/2fa/settings/${channel}`);})},i18n.t('Отключить')));
        }),
        !Object.values(secondFactor.available).some(Boolean)&&h('p',{class:'muted small'},i18n.t('Отправка кодов пока не настроена администратором.')),
        h('p',{class:'muted small',style:'margin:0'},i18n.t('Добавьте оба канала, чтобы иметь запасной способ подтверждения. Для изменения 2FA может потребоваться войти заново.')),
      ),
      state.me.kind === 'human' && h('section', { class: 'card pad stack' },
        h('h2', null, i18n.t('Способы входа')),
        h('p', { class: 'muted', style: 'margin:0' }, i18n.t('Привяжите Google и Telegram, чтобы входить без API-ключа.')),
        Object.entries(providerLabels).map(([provider, label]) => {
          const identity = identities.find((i) => i.provider === provider);
          return h('div', { class: 'row' }, h('strong', null, label),
            h('span', { class: 'muted small' }, identity?.label ?? (state.config?.providers?.[provider] ? i18n.t('Не привязан') : i18n.t('Не настроен администратором'))),
            h('span', { class: 'spacer' }), identity
              ? h('button', { class: 'ghost', onclick: (e) => {
                if (confirm(i18n.t`Отключить ${label}? Сессии через него завершатся. Для входа останется другой привязанный способ, passkey или API-ключ.`)) {
                  run(async () => { await api('DELETE', `/auth/identities/${provider}`); await boot(); })(e);
                }
              } }, i18n.t('Отключить'))
              : h('button', { disabled: !state.config?.providers?.[provider], onclick: run(async () => {
                const result = await api('POST', `/auth/${provider}/start`, { intent: 'link' });
                location.assign(result.authorization_url);
              }) }, i18n.t('Привязать')));
        })),
      h(
        'section',
        { class: 'card pad stack' },
        h('h2', null, i18n.t`Вход по ${bio}`),
        h('p', { class: 'muted', style: 'margin:0' }, i18n.t('Passkey хранится на устройстве и синхронизируется через связку ключей. Сервер получает только открытый ключ — украсть с него нечего, а фишинговый сайт passkey не примет.')),
        passkeys.length
          ? h(
              'div',
              null,
              passkeys.map((p) =>
                h(
                  'div',
                  { class: 'timelog', style: 'align-items:center' },
                  h('div', null, h('div', null, p.name, ' ', p.backed_up && h('span', { class: 'chip' }, i18n.t('синхронизируется'))), h('div', { class: 'muted small' }, i18n.t`Добавлен ${fmtDate(p.created_at)}`, p.last_used_at ? i18n.t` · вход ${fmtAgo(p.last_used_at)}` : i18n.t(' · ещё не использовался'))),
                  h('button', { class: 'ghost', onclick: (e) => confirm(i18n.t`Удалить passkey «${p.name}»? Войти с ним больше не получится.`) && run(() => api('DELETE', `/passkeys/${p.id}`))(e) }, i18n.t('Удалить')),
                ),
              ),
            )
          : h('div', { class: 'muted small' }, i18n.t('Пока ни одного passkey')),
        blocker
          ? h('div', { class: 'muted small' }, blocker)
          : h('div', null, h('button', { class: 'primary', onclick: run(() => pwa.passkeyRegister(api, pwa.deviceName())) }, passkeys.length ? i18n.t('Добавить ещё один') : i18n.t`Включить ${bio}`)),
      ),
      h(
        'section',
        { class: 'card pad stack' },
        h('h2', null, i18n.t('Уведомления')),
        h('p', { class: 'muted', style: 'margin:0' }, i18n.t('Push, когда агент сдал результат, ответил в вашей задаче или упомянул вас.')),
        pushOn
          ? h('div', { class: 'row' }, h('span', { class: 'chip st-done' }, h('span', { class: 'dot' }), i18n.t('Включены на этом устройстве')), h('button', { onclick: run(() => pwa.disablePush(api)) }, i18n.t('Выключить')))
          : pushBlock
            ? h('div', { class: 'muted small' }, pushBlock)
            : h('div', null, h('button', { class: 'primary', onclick: run(() => pwa.enablePush(api)) }, i18n.t('Включить уведомления'))),
      ),
      h(
        'section',
        { class: 'card pad stack' },
        h('h2', null, i18n.t('Приложение')),
        installed
          ? h('div', { class: 'row' }, h('span', { class: 'chip st-done' }, h('span', { class: 'dot' }), i18n.t('Установлено')))
          : pwa.canPromptInstall()
            ? h('div', null, h('button', { class: 'primary', onclick: run(() => pwa.promptInstall()) }, i18n.t('Установить приложение')))
            : h('p', { class: 'muted', style: 'margin:0' }, pwa.isIOS() ? i18n.t('В Safari нажмите «Поделиться» → «На экран „Домой“».') : i18n.t('В меню браузера выберите «Установить приложение» или «Добавить в Dock».')),
        h('p', { class: 'muted small', style: 'margin:0' }, i18n.t('Работает без сети: последние открытые задачи доступны для чтения, комментарии отправятся при появлении связи.')),
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
    dialog(i18n.t`Включить вход по ${pwa.biometryName()}?`, (form, { close, err }) => {
      appendChildren(form,
        h('p', { style: 'margin:0' }, i18n.t('В следующий раз не придётся вводить API-ключ — достаточно взгляда или отпечатка.')),
        h(
          'div',
          { class: 'row', style: 'justify-content:flex-end' },
          h('button', { type: 'button', class: 'ghost', onclick: close }, i18n.t('Не сейчас')),
          h('button', { class: 'primary' }, i18n.t('Включить')),
        ),
      );
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await pwa.passkeyRegister(api, pwa.deviceName());
          close();
          toast(i18n.t('Готово. Теперь можно входить по биометрии'));
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
  todo: i18n.t('ещё никто не взял'),
  in_progress: i18n.t('агент работает'),
  review: i18n.t('ждут вашего решения'),
  blocked: i18n.t('нужна помощь'),
  done: i18n.t('принято'),
};
const DONE_SHOWN = 20;
const board = { project: '', work: 'work', kind: '', assignee: '', allDone: false };

async function boardView(project, context) {
  if (project !== undefined) board.project = project;
  const selection = { ...board };
  const columns = h('div', { class: 'board' });
  const err = h('div', { class: 'error small', role: 'alert' });
  const projectsPromise = api('GET', '/projects').catch(() => []);
  let request = 0;
  let snapshot;

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
        !selection.project && t.project && h('span', null, t.project),
        t.child_count > 0 && h('span', { title: i18n.t('Готово из вложенных') }, `${t.child_done}/${t.child_count}`),
        ['high', 'urgent'].includes(t.priority) && h('span', { class: `prio-${t.priority}` }, PRIORITY[t.priority]),
      ),
      h(
        'div',
        { class: 'board-foot' },
        t.assignee_name ? h('span', { class: 'row', style: 'gap:4px;flex-wrap:nowrap' }, avatar(t.assignee_name), t.assignee_name) : h('span', { class: 'muted' }, i18n.t('не назначен')),
        h('span', { class: 'spacer' }),
        t.total_seconds > 0 && h('span', { title: i18n.t('Затрачено времени') }, '⏱ ' + fmtDuration(t.total_seconds)),
        t.attachment_count > 0 && h('span', { title: i18n.t('Вложения') }, '📎 ' + t.attachment_count),
      ),
      // Moving without a mouse or on a phone, where dragging is awkward.
      h(
        'div',
        { class: 'board-actions' },
        t.status === 'review' && h('button', { class: 'primary small', onclick: () => move(t.id, 'done') }, i18n.t('Принять')),
        t.status === 'review' && h('button', { class: 'small', onclick: () => (location.hash = `#/tasks/${t.id}`) }, i18n.t('Открыть')),
        h(
          'select',
          { class: 'small', 'aria-label': i18n.t`Статус задачи ${t.id}`, onchange: (e) => move(t.id, e.target.value) },
          Object.entries(STATUS).map(([v, l]) => h('option', { value: v, selected: v === t.status }, l)),
        ),
      ),
    );

  const load = async () => {
    const seq = ++request;
    const qs = new URLSearchParams({ limit: '500', status: BOARD_COLUMNS.join(',') });
    if (selection.project) qs.set('project', selection.project);
    if (selection.kind) qs.set('kind', selection.kind);
    if (selection.assignee) qs.set('assignee', selection.assignee);
    if (selection.work === 'work') qs.set('level', 'task,subtask');
    else if (selection.work === 'plan') qs.set('level', 'epic,story');
    let tasks;
    try {
      tasks = await api('GET', `/tasks?${qs}`);
    } catch (ex) {
      if (seq !== request) return;
      if (ex.offline && snapshot !== undefined) return;
      snapshot = undefined;
      columns.replaceChildren(h('div', { class: 'empty error' }, ex.message));
      return;
    }
    if (seq !== request) return;
    const next = JSON.stringify([tasks, selection.allDone]);
    if (snapshot === next) return;
    snapshot = next;
    const recent = (a, b) => b.updated_at.localeCompare(a.updated_at);
    columns.replaceChildren(
      ...BOARD_COLUMNS.map((status) => {
        const all = tasks.filter((t) => t.status === status).sort(recent);
        const shown = status === 'done' && !selection.allDone ? all.slice(0, DONE_SHOWN) : all;
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
          shown.length ? shown.map(card) : h('div', { class: 'muted small board-empty' }, i18n.t('Пусто')),
          all.length > shown.length &&
            h('button', { class: 'ghost small', onclick: () => ((selection.allDone = true), load()) }, i18n.t`Показать все ${all.length}`),
        );
      }),
    );
  };
  const bind = (key) => ({
    onchange: (e) => {
      selection[key] = e.target.value;
      board[key] = selection[key];
      if (key === 'project') history.replaceState(null, '', selection.project ? `#/board/${encodeURIComponent(selection.project)}` : '#/board');
      load();
    },
  });
  const option = (value, label, current) => h('option', { value, selected: value === current }, label);

  const [projects] = await Promise.all([projectsPromise, load()]);
  context.setPoll(load);

  return shell(
    'board',
    h('div', { class: 'page-head' }, h('h1', null, i18n.t('Доска')), h('span', { class: 'spacer' }), h('button', { class: 'primary', onclick: () => newTaskDialog(projects, { project: selection.project }) }, i18n.t('Новая задача'))),
    h(
      'div',
      { class: 'filters' },
      h('select', { 'aria-label': i18n.t('Проект'), ...bind('project') }, option('', i18n.t('Все проекты'), selection.project), projects.map((p) => option(p, p, selection.project))),
      h('select', { 'aria-label': i18n.t('Уровень'), ...bind('work') }, option('work', i18n.t('Таски и подтаски'), selection.work), option('plan', i18n.t('Эпики и стори'), selection.work), option('all', i18n.t('Все уровни'), selection.work)),
      h('select', { 'aria-label': i18n.t('Тип'), ...bind('kind') }, option('', i18n.t('Все типы'), selection.kind), Object.entries(KIND).map(([v, l]) => option(v, l, selection.kind))),
      h('select', { 'aria-label': i18n.t('Исполнитель'), ...bind('assignee') }, option('', i18n.t('Любой исполнитель'), selection.assignee), state.accounts.filter((a) => !a.disabled).map((a) => option(a.name, a.name, selection.assignee))),
    ),
    h(
      'p',
      { class: 'muted small', style: 'margin:-4px 0 12px' },
      i18n.t('Агент берёт задачу в работу и сдаёт её на проверку. Принять её или вернуть в работу — решаете вы. Карточки можно перетаскивать между колонками.'),
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
  [15 * 60, i18n.t('до 15 мин')],
  [3600, i18n.t('до 1 ч')],
  [3 * 3600, i18n.t('до 3 ч')],
  [Infinity, i18n.t('больше 3 ч')],
];
const loadStep = (seconds) => LOAD_STEPS.findIndex(([limit]) => seconds <= limit) + 1;
const tl = { project: '', closed: null };

const dayOf = (iso, tz) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });
const dayNumber = (day) => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / DAY_MS;
const dayLabel = (day, options) => new Date(day + 'T00:00:00Z').toLocaleDateString(i18n.dateLocale, { timeZone: 'UTC', ...options });

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
    return shell('timeline', h('div', { class: 'page-head' }, h('h1', null, i18n.t('График'))), timelineFilters(projects), h('div', { class: 'card empty' }, i18n.t('В проекте пока нет задач')));
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
    else months.push({ key, span: 1, label: dayLabel(day, { month: 'long', year: 'numeric' }).replace(i18n.t(' г.'), ''), at: i });
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
                      'aria-label': `${tl.closed.has(t.id) ? i18n.t('Развернуть') : i18n.t('Свернуть')}: ${t.title}`,
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
                  i18n.t`Время не записано\n${t.title}`,
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
        h('div', { class: 'tl-name tl-corner' }, `${rows.length} ${rows.length === 1 ? i18n.t('задача') : i18n.t('задач')}`),
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
        h('span', { class: 'tl-today', title: i18n.t('Сегодня') }),
        body,
      ),
    ),
  );
  const totalSeconds = tasks.reduce((n, t) => n + t.seconds, 0);
  const workedDays = new Set(tasks.flatMap((t) => Object.keys(t.days))).size;

  return shell(
    'timeline',
    h('div', { class: 'page-head' }, h('h1', null, i18n.t('График')), h('span', { class: 'muted' }, i18n.t`${fmtDuration(totalSeconds)} за ${workedDays} ${workedDays === 1 ? i18n.t('день') : i18n.t('дн.')} работы`)),
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
      h('span', { class: 'muted' }, i18n.t('Работа за день:')),
      LOAD_STEPS.map(([, label], i) => h('span', null, h('i', { class: `tl-day load-${i + 1}` }), label)),
      h('span', null, h('i', { class: 'tl-day tl-untimed' }), i18n.t('время не записано')),
      h('span', { class: 'muted' }, i18n.t`Дни — по часовому поясу ${tz}`),
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
        'aria-label': i18n.t('Проект'),
        onchange: (e) => (location.hash = `#/timeline/${encodeURIComponent(e.target.value)}`),
      },
      projects.map((p) => h('option', { value: p, selected: p === tl.project }, p)),
    ),
    collapse && h('button', { onclick: collapse }, i18n.t('Свернуть всё')),
    expand && h('button', { onclick: expand }, i18n.t('Развернуть всё')),
  );
}

// ---------- router ----------

const navigation = createNavigation({
  load: routeView,
  show: (view) => {
    app.replaceChildren(...[view].flat());
    paintInboxCount();
  },
  loading: (key) => {
    const [, route] = key.split('/');
    const labels = { tasks: i18n.t('Задачи'), projects: i18n.t('Проекты'), board: i18n.t('Доска'),
      timeline: i18n.t('График'), inbox: i18n.t('Входящие'), analytics: i18n.t('Аналитика'),
      accounts: i18n.t('Аккаунты'), connect: i18n.t('Подключение'), profile: i18n.t('Профиль') };
    app.replaceChildren(...shell(route || 'projects',
      h('div', { class: 'page-head' }, h('h1', null, labels[route] || i18n.t('Проекты'))),
      h('div', { class: 'card empty', role: 'status', 'aria-busy': 'true' }, i18n.t('Загрузка…'))));
  },
  error: (key, ex) => state.me ? shell(key.split('/')[1], h('div', { class: 'empty error' }, ex.message)) : loginView(),
  changed: (entry) => {
    state.poll = entry ? () => Promise.resolve(navigation.refresh()) : null;
    document.title = entry?.title || 'AI Guild';
  },
  getScroll: () => window.scrollY,
  setScroll: (top) => window.scrollTo({ top, behavior: 'instant' }),
  cacheable: (key) => /^#\/(projects|tasks|board|inbox|analytics|connect)\/?$/.test(key),
});

async function routeView(key, context) {
  const [, route, arg] = key.split('/');
  if (route === 'tasks' && arg) return taskView(Number(arg), context);
  if (route === 'projects' && arg) return projectView(decodeURIComponent(arg), context);
  if (route === 'tasks') return tasksView(context);
  if (route === 'board') return boardView(arg ? decodeURIComponent(arg) : undefined, context);
  if (route === 'timeline') return timelineView(arg ? decodeURIComponent(arg) : undefined);
  if (route === 'inbox') return inboxView();
  if (route === 'analytics') return analyticsView();
  if (route === 'accounts') return accountsView();
  if (route === 'connect') return connectView();
  if (route === 'profile') return profileView();
  return projectsView();
}

let renderSeq = 0;
async function render({ reload = true } = {}) {
  const seq = ++renderSeq;
  clearInterval(state.twoFactorTicker);
  tip.hidden = true;
  if(location.hash==='#/two-factor') {
    navigation.clear();
    const view=await twoFactorView();if(seq===renderSeq)app.replaceChildren(view);return;
  }
  if (location.hash.startsWith('#/invite/')) {
    navigation.clear();
    const view = await invitationView(location.hash.slice('#/invite/'.length));
    if (seq === renderSeq) app.replaceChildren(view);
    return;
  }
  if (!state.me) {
    navigation.clear();
    return app.replaceChildren(loginView());
  }
  const [, route] = location.hash.split('/');
  await navigation.navigate(location.hash || '#/projects', { reload }).catch(() => {});
  if (seq !== renderSeq || !state.me) return;

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
  state.inboxCount = events.length;
  paintInboxCount();
}

function paintInboxCount() {
  const link = document.querySelector('.nav a[href="#/inbox"]');
  const badge = link?.querySelector('.badge');
  if (!state.inboxCount) badge?.remove();
  else if (badge) badge.textContent = String(state.inboxCount);
  else link?.append(h('span', { class: 'badge' }, String(state.inboxCount)));
}

async function boot() {
  navigation.clear();
  const configPromise = state.config ? Promise.resolve(state.config) : fetch('/api/config').then((r) => r.json()).catch(() => null);
  try {
    const [config, res] = await Promise.all([configPromise, fetch('/api/me',{headers:pwa.clientHeaders()})]);
    state.config = config;
    state.me = res.ok ? await res.json() : null;
    if (state.me) {
      const [accounts] = await Promise.all([api('GET', '/accounts'), refreshInboxCount().catch(() => {})]);
      state.accounts = accounts;
    }
  } catch {
    state.me = null;
  }
  await render();
  const feedback = new URLSearchParams(location.search);
  if (feedback.has('auth_error') || feedback.has('auth')) {
    toast(feedback.get('auth_error') || (feedback.get('auth') === 'linked' ? i18n.t('Способ входа привязан') : i18n.t('Вы вошли в аккаунт')));
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

addEventListener('hashchange', () => render({ reload: false }));
// Browser Back/Forward must not fight the saved scroll position of each tab.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
setInterval(() => {
  if (!state.me || document.hidden || document.querySelector('dialog[open]')) return;
  state.poll?.().catch(() => {});
  refreshInboxCount().catch(() => {});
}, 8000);

boot();
