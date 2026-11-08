import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import english from '../public/i18n.en.js';
import spanish from '../public/i18n.es.js';
import { chooseLocale, translate } from '../public/i18n.js';

const catalogues = { English: english, Spanish: spanish };

test('explicit and saved language choices take priority over browser languages', () => {
  assert.equal(chooseLocale('en', 'ru', ['ru-RU']), 'en');
  assert.equal(chooseLocale(null, 'ru', ['en-US']), 'ru');
  assert.equal(chooseLocale('unsupported', null, ['fr-FR', 'ru-RU']), 'ru');
  assert.equal(chooseLocale(null, null, ['fr']), 'en');
  assert.equal(chooseLocale('es', 'en', ['ru-RU']), 'es');
  assert.equal(chooseLocale(null, 'es', ['en-US']), 'es');
  assert.equal(chooseLocale(null, null, ['es-MX', 'en-US']), 'es');
});

test('translated templates preserve user content and do not reinterpret its placeholders', () => {
  const name = '<script>{1}</script> Русский проект';
  assert.equal(translate('en', 'записал {0}', [name]), `recorded by ${name}`);
  assert.equal(translate('es', 'записал {0}', [name]), `registrado por ${name}`);
  assert.equal(translate('ru', 'записал {0}', [name]), `записал ${name}`);
  assert.equal(translate('en', 'No translation needed'), 'No translation needed');
  assert.equal(translate('es', 'No translation needed'), 'No translation needed');
});

for (const [language, catalogue] of Object.entries(catalogues)) {
  test(`${language} translations preserve interpolation slots and contain no Russian interface text`, () => {
    for (const [key, value] of Object.entries(catalogue)) {
      const slots = (s: string) => [...s.matchAll(/\{\d+\}/g)].map(m => m[0]).sort();
      assert.deepEqual(slots(value), slots(key), key);
      assert.doesNotMatch(value, /[А-Яа-яЁё]/, key);
    }
  });
}

test('every Russian literal passed to i18n.t has a translation in each catalogue', () => {
  const dir = new URL('../public/', import.meta.url);
  const missing: string[] = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith('.js') && !f.startsWith('i18n'))) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    for (const [, single, double] of source.matchAll(/\bi18n\.t\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*\)/g)) {
      const key = (single ?? double).replace(/\\(['"])/g, '$1');
      if (!/[А-Яа-яЁё]/.test(key)) continue;
      for (const [language, catalogue] of Object.entries(catalogues)) {
        if (!(key in catalogue)) missing.push(`${language}, ${file}: ${key}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('the Spanish catalogue covers exactly the English message keys', () => {
  assert.deepEqual(Object.keys(spanish).sort(), Object.keys(english).sort());
});

test('the offline shell includes every locale module', () => {
  const worker = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  for (const file of readdirSync(new URL('../public/', import.meta.url)).filter(f => /^i18n.*\.js$/.test(f))) {
    assert.ok(worker.includes(`'/${file}'`), file);
  }
});
