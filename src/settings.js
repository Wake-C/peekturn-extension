export const DEFAULTS = Object.freeze({ endpoint: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: '', language: 'en', promptEn: '', promptZh: '', autoPronounce: true, accent: 'US', merge: true });

export function normalizeSettings(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  const result = { ...DEFAULTS };
  for (const key of ['endpoint', 'model', 'apiKey', 'promptEn', 'promptZh']) {
    if (typeof value[key] === 'string') result[key] = key.startsWith('prompt') ? value[key] : value[key].trim();
  }
  if (value.language === 'en' || value.language === 'zh') result.language = value.language;
  if (value.accent === 'US' || value.accent === 'UK') result.accent = value.accent;
  for (const key of ['autoPronounce', 'merge']) if (typeof value[key] === 'boolean') result[key] = value[key];
  return result;
}

export function publicSettings(value) {
  const { apiKey, ...settings } = normalizeSettings(value);
  return settings;
}
