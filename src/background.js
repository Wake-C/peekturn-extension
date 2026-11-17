import { normalizeSettings, publicSettings } from './settings.js';
import { explain, merge } from './model.js';

// The API key must never be readable through chrome.storage from a content script.
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

function senderKind(sender) {
  if (sender.id !== chrome.runtime.id || !sender.url) return null;
  let url;
  try { url = new URL(sender.url); } catch { return null; }
  if (url.protocol === 'chrome-extension:' && url.host === chrome.runtime.id && url.pathname === '/options.html') return 'options';
  if (url.protocol === 'https:' && (url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com')) && sender.tab) return 'youtube';
  return null;
}

function speak(text, accent) {
  if (typeof text !== 'string' || !text.trim() || text.length > 10000 || !['US', 'UK'].includes(accent)) throw new Error('Invalid speech request.');
  return new Promise((resolve, reject) => {
    chrome.tts.speak(text, { lang: accent === 'UK' ? 'en-GB' : 'en-US', onEvent(event) {
      if (event.type === 'end') resolve();
      else if (event.type === 'interrupted' || event.type === 'cancelled') resolve();
      else if (event.type === 'error') reject(new Error('Speech could not be played.'));
    } }, () => { if (chrome.runtime.lastError) reject(new Error('Speech could not be played.')); });
  });
}

async function handle(message, sender) {
  const kind = senderKind(sender);
  if (!kind || !message || typeof message.type !== 'string') throw new Error('Unauthorized request.');
  await storageReady;
  if (message.type === 'options:open') { await chrome.runtime.openOptionsPage(); return { ok: true }; }
  if (message.type === 'settings:get') return { ok: true, settings: publicSettings(await chrome.storage.local.get(null)) };
  if (message.type === 'settings:merge') {
    if (typeof message.enabled !== 'boolean') throw new Error('Invalid merge setting.');
    await chrome.storage.local.set({ merge: message.enabled }); return { ok: true };
  }
  if (message.type === 'speech:stop') { chrome.tts.stop(); return { ok: true }; }
  if (message.type === 'speak') { await speak(message.text, message.accent); return { ok: true }; }
  if (message.type === 'connection:test' && kind === 'options') {
    await explain(normalizeSettings(message.settings), { selection: 'hello' });
    return { ok: true };
  }
  if (message.type === 'explain' || message.type === 'merge') {
    const config = normalizeSettings(await chrome.storage.local.get(null));
    if (message.type === 'explain') return { ok: true, answer: await explain(config, message.context) };
    return { ok: true, endCueIds: await merge(config, message.cues) };
  }
  throw new Error('Unknown request.');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender).then(sendResponse, error => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Request failed.' }));
  return true;
});

chrome.action.onClicked.addListener(() => { chrome.runtime.openOptionsPage().catch(() => {}); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  chrome.storage.local.get(null).then(async stored => {
    const settings = publicSettings(stored);
    const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
    await Promise.all(tabs.filter(tab => tab.id != null).map(tab =>
      chrome.tabs.sendMessage(tab.id, { type: 'settings:changed', settings }).catch(() => {})
    ));
  }).catch(() => {});
});
