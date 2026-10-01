# Interface languages

The web/PWA supports English and Russian. Use the EN/RU selector in the header or on the sign-in page. The choice is saved on the device. `?lang=en` or `?lang=ru` overrides it for a shared tour link; otherwise the saved choice or a supported browser language is used, with English as the fallback.

Dates, relative time, durations and number separators use the selected language. Task titles, comments, project names and attachments remain as written. Native iOS localisation is a separate mobile-release item.

## Adding interface text

`server/public/i18n.js` provides a small dependency-free message API. Russian source phrases serve as stable keys; `server/public/i18n.en.js` contains the English catalogue.

```js
import * as i18n from './i18n.js';
i18n.t('Новая задача');
i18n.t`записал ${account.name}`;
```

Templates use indexed slots in the catalogue (`recorded by {0}`). Values pass through unchanged and are rendered as text. Never translate a task title or comment by passing it to `i18n.t`; only interface literals belong in the catalogue. Translate accessible labels, placeholders and confirmation dialogs as well as visible headings.

When changing the catalogue, run `node --test test/i18n.test.ts` from `server/`, check both language choices in the browser, and include the locale modules in the service-worker shell. The tests check language selection, placeholder preservation and the absence of Russian text in English translations.
