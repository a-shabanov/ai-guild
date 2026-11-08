import english from './i18n.en.js';
import spanish from './i18n.es.js';

const supported = ['en', 'es', 'ru'];
const catalogues = { en: english, es: spanish };
const dateLocales = { en: 'en-US', es: 'es-ES', ru: 'ru-RU' };
const valid = (value) => supported.includes(value) ? value : null;
export function chooseLocale(query, saved, languages = []) {
  return valid(query) ?? valid(saved) ?? languages.map((s) => valid(s.toLowerCase().split('-')[0])).find(Boolean) ?? 'en';
}
let saved;
try { if (globalThis.document) saved = localStorage.getItem('ai-guild-locale'); } catch {}
export const locale = chooseLocale(new URLSearchParams(globalThis.location?.search ?? '').get('lang'), saved, globalThis.navigator?.languages ?? []);
export const dateLocale = dateLocales[locale];
if (globalThis.document) document.documentElement.lang = locale;

// Source phrases and indexed slots form the message key. Values are never translated,
// evaluated as markup, or processed for further placeholders.
export function translate(language, source, values = []) {
  const message = language === 'ru' ? source : catalogues[language]?.[source] ?? english[source] ?? source;
  return message.replace(/\{(\d+)\}/g, (slot, index) => index < values.length ? String(values[index]) : slot);
}
export function t(source, ...values) {
  const key = Array.isArray(source) ? source.map((part, i) => part + (i < source.length - 1 ? `{${i}}` : '')).join('') : source;
  return translate(locale, key, values);
}
export function languagePicker() {
  const picker = document.createElement('select');
  picker.className = 'language-picker';
  picker.setAttribute('aria-label', t('Язык интерфейса'));
  picker.title = t('Язык интерфейса');
  for (const [value, label] of [['en', 'EN'], ['es', 'ES'], ['ru', 'RU']]) {
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
