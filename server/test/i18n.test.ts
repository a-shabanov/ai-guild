import { test } from 'node:test';
import assert from 'node:assert/strict';
import english from '../public/i18n.en.js';
import { chooseLocale, translate } from '../public/i18n.js';

test('explicit and saved language choices take priority over browser languages', () => {
  assert.equal(chooseLocale('en', 'ru', ['ru-RU']), 'en');
  assert.equal(chooseLocale(null, 'ru', ['en-US']), 'ru');
  assert.equal(chooseLocale('unsupported', null, ['fr-FR', 'ru-RU']), 'ru');
  assert.equal(chooseLocale(null, null, ['fr']), 'en');
});

test('translated templates preserve user content and do not reinterpret its placeholders', () => {
  const name = '<script>{1}</script> Русский проект';
  assert.equal(translate('en', 'записал {0}', [name]), `recorded by ${name}`);
  assert.equal(translate('ru', 'записал {0}', [name]), `записал ${name}`);
  assert.equal(translate('en', 'No translation needed'), 'No translation needed');
});

test('English translations preserve interpolation slots and contain no Russian interface text', () => {
  for (const [key, value] of Object.entries(english)) {
    const slots = (s: string) => [...s.matchAll(/\{\d+\}/g)].map(m => m[0]).sort();
    assert.deepEqual(slots(value), slots(key), key);
    assert.doesNotMatch(value, /[А-Яа-яЁё]/, key);
  }
});
