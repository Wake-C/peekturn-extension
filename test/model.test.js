import test from 'node:test';
import assert from 'node:assert/strict';
import { chat, explain, merge, endpointUrl } from '../src/model.js';
import { PROMPT_EN, PROMPT_ZH, MERGE_PROMPT } from '../src/prompts.js';

const config = { endpoint: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'secret' };
const answer = { term: 'hello', partOfSpeech: 'interjection', ukIpa: '', usIpa: '', meaning: 'A greeting.', context: 'It greets someone.', examples: [{ text: 'Hello, Sam.', translation: '' }], synonyms: 'hi', antonyms: '' };
function provider(value, inspect = () => {}) {
  return async (url, init) => { inspect(url, JSON.parse(init.body), init.headers); return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }) }; };
}
test('explains with exact prompt, context clipping, schema and authentication', async () => {
  const result = await explain(config, { selection: 'hello', before: Array.from({ length: 35 }, (_, i) => i).join(' '), after: 'next', sourceTitle: 'Title' }, provider(answer, (url, body, headers) => {
    assert.equal(url, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(headers.Authorization, 'Bearer secret');
    assert.ok(body.messages[0].content.startsWith(PROMPT_EN));
    assert.equal(JSON.parse(body.messages[1].content).before.split(' ').length, 30);
    assert.equal(body.response_format.type, 'json_object');
  }));
  assert.deepEqual(result, answer);
});
test('honors language-specific override and translation policy', async () => {
  const chinese = { ...answer, examples: [{ text: 'Hello, Sam.', translation: '你好，山姆。' }] };
  await explain({ ...config, language: 'zh' }, { selection: 'hello' }, provider(chinese, (_, body) => assert.ok(body.messages[0].content.startsWith(PROMPT_ZH))));
  await explain({ ...config, promptEn: 'custom' }, { selection: 'hello' }, provider(answer, (_, body) => assert.ok(body.messages[0].content.startsWith('custom Required JSON schema:'))));
  await assert.rejects(explain({ ...config, language: 'zh' }, { selection: 'hello' }, provider(answer)), /invalid explanation/);
  await assert.rejects(explain(config, { selection: 'hello' }, provider({ ...answer, extra: true })), /invalid explanation/);
});
test('rejects malformed provider responses and unsafe endpoints', async () => {
  assert.throws(() => endpointUrl('http://example.com'), /HTTPS/);
  assert.throws(() => endpointUrl('https://user:pass@example.com'), /credentials/);
  assert.equal(endpointUrl('https://example.com/v1').pathname, '/v1/chat/completions');
  await assert.rejects(chat(config, [], { name: 'x', schema: {} }, async () => ({ ok: false, status: 401 })), /HTTP 401/);
  await assert.rejects(chat(config, [], { name: 'x', schema: {} }, async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }) })), /incomplete/);
});
test('computes ceilings and splits model boundaries at local limits', async () => {
  const cues = [{ id: 1, startMs: 0, endMs: 1000, text: 'one' }, { id: 2, startMs: 1500, endMs: 2000, text: 'two' }, { id: 3, startMs: 4000, endMs: 5000, text: 'three' }];
  const ids = await merge(config, cues, provider({ endCueIds: [3] }, (_, body) => {
    assert.ok(body.messages[0].content.startsWith(MERGE_PROMPT));
    assert.deepEqual(JSON.parse(body.messages[1].content).cues.map(c => c.maxEndCueId), [2, 2, 3]);
  }));
  assert.deepEqual(ids, [2, 3]);
  await assert.rejects(merge(config, cues, provider({ endCueIds: [1, 1, 3] })), /invalid caption/);
  await assert.rejects(merge(config, cues, provider({ endCueIds: [2] })), /incomplete caption/);
});
test('enforces word and duration limits and preserves oversized cues', async () => {
  const cues = [{ id: 1, startMs: 0, endMs: 100, text: 'word '.repeat(31) }, { id: 2, startMs: 100, endMs: 12000, text: 'a' }, { id: 3, startMs: 12000, endMs: 12101, text: 'b' }];
  assert.deepEqual(await merge(config, cues, provider({ endCueIds: [3] })), [1, 2, 3]);
});
