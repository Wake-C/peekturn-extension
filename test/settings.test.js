import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeSettings, publicSettings } from '../src/settings.js';

test('defaults and normalizes known settings without leaking unexpected fields', () => {
  assert.deepEqual(normalizeSettings(), DEFAULTS);
  const settings = normalizeSettings({ endpoint: ' https://example.com ', apiKey: ' key ', language: 'fr', accent: 'xx', merge: false, autoPronounce: false, promptEn: ' custom ', extra: 'ignored' });
  assert.equal(settings.endpoint, 'https://example.com');
  assert.equal(settings.apiKey, 'key');
  assert.equal(settings.language, 'en');
  assert.equal(settings.accent, 'US');
  assert.equal(settings.promptEn, ' custom ');
  assert.equal(settings.merge, false);
  assert.equal(settings.autoPronounce, false);
  assert.equal('extra' in settings, false);
});
test('public settings never include an API key', () => {
  const settings = publicSettings({ apiKey: 'secret', language: 'zh' });
  assert.equal('apiKey' in settings, false);
  assert.equal(settings.language, 'zh');
});
