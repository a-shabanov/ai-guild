import english from './i18n.en.js';

const supported = ['en', 'ru'];
const valid = (value) => supported.includes(value) ? value : null;
export function chooseLocale(query, saved, languages = []) {
  return valid(query) ?? valid(saved) ?? languages.map((s) => valid(s.toLowerCase().split('-')[0])).find(Boolean) ?? 'en';
}
let saved;
try { if (globalThis.document) saved = localStorage.getItem('ai-guild-locale'); } catch {}
export const locale = chooseLocale(new URLSearchParams(globalThis.location?.search ?? '').get('lang'), saved, globalThis.navigator?.languages ?? []);
export const dateLocale = locale === 'ru' ? 'ru-RU' : 'en-US';
if (globalThis.document) document.documentElement.lang = locale;

// Source phrases and indexed slots form the message key. Values are never translated,
// evaluated as markup, or processed for further placeholders.
export function translate(language, source, values = []) {
  const message = language === 'en' ? english[source] ?? source : source;
  return message.replace(/\{(\d+)\}/g, (slot, index) => index < values.length ? String(values[index]) : slot);
}
export function t(source, ...values) {
  const key = Array.isArray(source) ? source.map((part, i) => part + (i < source.length - 1 ? `{${i}}` : '')).join('') : source;
  return translate(locale, key, values);
}
export function languagePicker() {
  const picker = document.createElement('select');
  picker.className = 'language-picker';
  picker.setAttribute('aria-label', locale === 'ru' ? 'Язык интерфейса' : 'Interface language');
  picker.title = locale === 'ru' ? 'Язык интерфейса' : 'Interface language';
  for (const [value, label] of [['en', 'EN'], ['ru', 'RU']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    picker.append(option);
  }
  picker.value = locale;
  picker.addEventListener('change', () => {
    const url = new URL(location.href);
    url.searchParams.set('lang', picker.value);
    try { localStorage.setItem('ai-guild-locale', picker.value); } catch {}
    location.assign(url.href);
  });
  return picker;
}
