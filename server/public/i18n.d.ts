export function chooseLocale(query: string | null, saved: string | null | undefined, languages?: string[]): 'en' | 'es' | 'ru';
export const locale: 'en' | 'es' | 'ru';
export const dateLocale: string;
export function translate(language: string, source: string, values?: unknown[]): string;
export function t(source: string | TemplateStringsArray, ...values: unknown[]): string;
export function languagePicker(): HTMLSelectElement;
