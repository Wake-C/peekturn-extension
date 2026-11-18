import { normalizeSettings } from './settings.js';
import { PROMPT_EN, PROMPT_ZH, MERGE_PROMPT } from './prompts.js';

const string = { type: 'string' };
const answerProperties = Object.fromEntries(['term', 'partOfSpeech', 'ukIpa', 'usIpa', 'meaning', 'context'].map(key => [key, string]));
answerProperties.examples = { type: 'array', minItems: 1, maxItems: 2, items: { type: 'object', additionalProperties: false, properties: { text: string, translation: string }, required: ['text', 'translation'] } };
for (const key of ['synonyms', 'antonyms']) answerProperties[key] = { type: 'string', maxLength: 160 };
const answerSchema = { type: 'object', additionalProperties: false, properties: answerProperties, required: Object.keys(answerProperties) };
const mergeSchema = { type: 'object', additionalProperties: false, properties: { endCueIds: { type: 'array', items: { type: 'integer' } } }, required: ['endCueIds'] };

export function endpointUrl(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('Enter a valid HTTPS provider URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Provider URL must use HTTPS and contain no credentials, query or fragment.');
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/chat/completions') ? path : path.endsWith('/v1') ? `${path}/chat/completions` : path ? `${path}/chat/completions` : '/v1/chat/completions';
  return url;
}

export async function chat(config, messages, schema, fetchImpl = globalThis.fetch) {
  const settings = normalizeSettings(config);
  const url = endpointUrl(settings.endpoint);
  if (!settings.model || !settings.apiKey || !/^[\x21-\x7e]+$/.test(settings.apiKey)) throw new Error('Enter a model and valid API key in Settings.');
  const strict = url.hostname === 'api.openai.com';
  const requestMessages = messages.map((message, index) => index === 0 && !strict ? { ...message, content: `${message.content} Required JSON schema: ${JSON.stringify(schema.schema)}` } : message);
  const signal = AbortSignal.timeout(45000);
  let response;
  try {
    response = await fetchImpl(url.toString(), { method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` }, body: JSON.stringify({ model: settings.model, messages: requestMessages, thinking: { type: 'disabled' }, response_format: strict ? { type: 'json_schema', json_schema: { name: schema.name, strict: true, schema: schema.schema } } : { type: 'json_object' } }) });
  } catch { throw new Error(signal.aborted ? 'Model request timed out. Please try again.' : 'Could not connect to the model provider.'); }
  if (!response.ok) throw new Error(`Model provider returned HTTP ${response.status}.`);
  let envelope;
  try { envelope = await response.json(); } catch { throw new Error(signal.aborted ? 'Model request timed out. Please try again.' : 'Model provider returned invalid JSON.'); }
  const choice = envelope?.choices?.[0];
  if (choice?.finish_reason !== 'stop' || typeof choice?.message?.content !== 'string' || choice.message.content.length > 128000) throw new Error('Model provider returned an incomplete response.');
  try { return JSON.parse(choice.message.content); } catch { throw new Error('Model provider returned invalid structured output.'); }
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validAnswer(answer, language) {
  const keys = Object.keys(answerProperties);
  if (!exactKeys(answer, keys) || keys.filter(k => k !== 'examples').some(k => typeof answer[k] !== 'string')) return false;
  if (['term', 'partOfSpeech', 'meaning', 'context'].some(k => !answer[k].trim())) return false;
  if (['synonyms', 'antonyms'].some(k => answer[k].length > 160 || /[\n\r\u0085\u2028\u2029]/u.test(answer[k]))) return false;
  if (!Array.isArray(answer.examples) || answer.examples.length < 1 || answer.examples.length > 2) return false;
  return answer.examples.every(example => exactKeys(example, ['text', 'translation']) && typeof example.text === 'string' && !!example.text.trim() && typeof example.translation === 'string' && (language === 'zh' ? !!example.translation.trim() : example.translation === ''));
}

export async function explain(config, context, fetchImpl) {
  const settings = normalizeSettings(config);
  if (!context || typeof context.selection !== 'string' || !context.selection.trim()) throw new Error('Select text to explain.');
  const get = key => typeof context[key] === 'string' ? context[key] : '';
  const words = text => text.trim().split(/[\s\p{Z}\u0085]+/u).filter(Boolean);
  const passage = { selection: context.selection, before: words(get('before')).slice(-30).join(' '), after: words(get('after')).slice(0, 30).join(' '), sourceTitle: get('sourceTitle'), sectionTitle: get('sectionTitle') };
  const prompt = settings.language === 'zh' ? settings.promptZh || PROMPT_ZH : settings.promptEn || PROMPT_EN;
  const result = await chat(settings, [{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify(passage) }], { name: 'explanation', schema: answerSchema }, fetchImpl);
  if (!validAnswer(result, settings.language)) throw new Error('Model provider returned an invalid explanation.');
  return result;
}

function endLimit(cues, start, through = cues.length - 1) {
  let words = 0, latest = -Infinity;
  for (let i = start; i <= through; i++) {
    const cue = cues[i];
    if (i > start && cue.startMs - latest > 1000) return i - 1;
    latest = Math.max(latest, cue.endMs);
    words += [...cue.text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)].length;
    if (latest - cues[start].startMs > 12000 || words > 30) return Math.max(start, i - 1);
  }
  return through;
}

export async function merge(config, cues, fetchImpl) {
  if (!Array.isArray(cues)) throw new Error('Invalid captions.');
  if (!cues.length) return [];
  if (cues.some((c, i) => !c || !Number.isSafeInteger(c.id) || (i && c.id <= cues[i - 1].id) || !Number.isFinite(c.startMs) || !Number.isFinite(c.endMs) || c.endMs < c.startMs || typeof c.text !== 'string')) throw new Error('Invalid captions.');
  const ends = [];
  for (let start = 0; start < cues.length;) {
    let end = start, chars = 0;
    while (end < cues.length && end - start < 80) {
      const added = cues[end].text.trim().replace(/[\s\p{Z}\u0085]+/gu, ' ').length + (end > start ? 1 : 0);
      if (end > start && chars + added > 8000) break;
      chars += added; end++;
    }
    const window = cues.slice(start, end);
    const payload = { cues: window.map((cue, i) => ({ id: cue.id, startMs: cue.startMs, endMs: cue.endMs, text: cue.text, maxEndCueId: window[endLimit(window, i)].id })), lastCueId: window.at(-1).id };
    const result = await chat(config, [{ role: 'system', content: MERGE_PROMPT }, { role: 'user', content: JSON.stringify(payload) }], { name: 'caption_groups', schema: mergeSchema }, fetchImpl);
    if (!exactKeys(result, ['endCueIds']) || !Array.isArray(result.endCueIds) || !result.endCueIds.length) throw new Error('Model provider returned invalid caption boundaries.');
    let groupStart = 0;
    for (const id of result.endCueIds) {
      const index = window.findIndex(cue => cue.id === id);
      if (!Number.isSafeInteger(id) || index < groupStart) throw new Error('Model provider returned invalid caption boundaries.');
      while (groupStart <= index) { const last = endLimit(window, groupStart, index); ends.push(window[last].id); groupStart = last + 1; }
    }
    if (groupStart !== window.length) throw new Error('Model provider returned incomplete caption boundaries.');
    start = end;
  }
  return ends;
}
