import { normalizeSettings } from './settings.js';
import { PROMPT_EN, PROMPT_ZH } from './prompts.js';
import { endpointUrl } from './model.js';

const form = document.querySelector('#settings');
const status = document.querySelector('#status');
const test = document.querySelector('#test');
const field = name => form.elements.namedItem(name);
field('promptEn').placeholder = PROMPT_EN;
field('promptZh').placeholder = PROMPT_ZH;

function show(message, error = false) { status.textContent = message; status.classList.toggle('error', error); }
function values() {
  const raw = {};
  for (const name of ['endpoint', 'model', 'apiKey', 'language', 'accent', 'promptEn', 'promptZh']) raw[name] = field(name).value;
  for (const name of ['autoPronounce', 'merge']) raw[name] = field(name).checked;
  return normalizeSettings(raw);
}
function validate(settings) {
  const url = endpointUrl(settings.endpoint);
  if (!settings.model) throw new Error('Enter a model.');
  if (settings.apiKey && !/^[\x21-\x7e]+$/.test(settings.apiKey)) throw new Error('Enter a valid API key.');
  return `${url.origin}/*`;
}
async function requestPermission(origin) {
  if (!await chrome.permissions.request({ origins: [origin] })) throw new Error('Provider access was not granted.');
}

for (const button of document.querySelectorAll('[data-reset]')) button.addEventListener('click', () => { field(button.dataset.reset).value = ''; show('Default prompt restored. Save to apply.'); });
form.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const settings = values();
    const origin = validate(settings);
    await requestPermission(origin);
    await chrome.storage.local.set(settings);
    show('Settings saved.');
  } catch (error) { show(error.message || 'Could not save settings.', true); }
});
test.addEventListener('click', async () => {
  try {
    const settings = values();
    const origin = validate(settings);
    if (!settings.apiKey) throw new Error('Enter an API key to test the connection.');
    await requestPermission(origin);
    test.disabled = true; show('Testing connection…');
    const result = await chrome.runtime.sendMessage({ type: 'connection:test', settings });
    if (!result?.ok) throw new Error(result?.error || 'Connection test failed.');
    show('Connected. The model returned a valid structured answer.');
  } catch (error) { show(error.message || 'Connection test failed.', true); }
  finally { test.disabled = false; }
});
document.querySelector('#preview').addEventListener('click', async () => {
  try {
    show('Playing voice preview…');
    const result = await chrome.runtime.sendMessage({ type: 'speak', text: 'Hello, welcome to Peekturn.', accent: field('accent').value });
    if (!result?.ok) throw new Error(result?.error || 'Voice preview failed.');
    show('Voice preview finished.');
  } catch (error) { show(error.message || 'Voice preview failed.', true); }
});
try {
  const settings = normalizeSettings(await chrome.storage.local.get(null));
  for (const [name, value] of Object.entries(settings)) {
    if (typeof value === 'boolean') field(name).checked = value;
    else field(name).value = value;
  }
} catch { show('Could not load settings.', true); }
