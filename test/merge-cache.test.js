import test from 'node:test';
import assert from 'node:assert/strict';
import { createMergeCache } from '../src/merge-cache.js';

const config = { endpoint: 'https://api.example.com', model: 'model', apiKey: 'secret', language: 'en' };
const video = 'abcdefghijk';
const cues = [{ id: 1, startMs: 0, endMs: 500, text: 'private caption' }, { id: 2, startMs: 500, endMs: 1000, text: 'next' }];
const forbidden = async () => { throw new Error('unexpected model request'); };
const result = async (_config, input) => [input.at(-1).id];
function memory() {
  let data = {};
  return {
    async get(key) { return structuredClone({ [key]: data[key] }); },
    async set(value) { Object.assign(data, structuredClone(value)); },
    snapshot() { return structuredClone(data); },
    replace(value) { data = structuredClone(value); }
  };
}

test('persists partitions across instances without storing private input', async () => {
  const storage = memory();
  const first = createMergeCache({ storage, loader: result });
  assert.deepEqual(await first.merge(config, video, cues), { endCueIds: [2], cache: 'stored' });
  const saved = JSON.stringify(storage.snapshot());
  for (const value of ['private caption', video, config.endpoint, config.apiKey]) assert.ok(!saved.includes(value));
  const second = createMergeCache({ storage, loader: forbidden });
  assert.deepEqual(await second.merge({ ...config, apiKey: 'other', language: 'zh', promptZh: 'different', merge: false, autoPronounce: false }, video, cues), { endCueIds: [2], cache: 'hit' });
  assert.equal((await second.merge({ ...config, endpoint: 'https://api.example.com/v1/chat/completions' }, video, cues)).cache, 'hit');
});

test('video, content, timing, cue id, model and endpoint invalidate the key', async () => {
  const storage = memory();
  let calls = 0;
  const cache = createMergeCache({ storage, loader: async (...args) => { calls++; return result(...args); } });
  await cache.merge(config, video, cues);
  for (const [settings, id, input] of [
    [config, 'abcdefghij_', cues],
    [config, video, [{ ...cues[0], text: 'changed' }, cues[1]]],
    [config, video, [{ ...cues[0], startMs: 1 }, cues[1]]],
    [config, video, [{ ...cues[0], endMs: 501 }, cues[1]]],
    [config, video, [{ ...cues[0], id: 0 }, cues[1]]],
    [{ ...config, model: 'another' }, video, cues],
    [{ ...config, endpoint: 'https://other.example.com' }, video, cues]
  ]) assert.equal((await cache.merge(settings, id, input)).cache, 'stored');
  assert.equal(calls, 8);
});

test('TTL is fixed from creation and LRU evicts the least recently used entry', async () => {
  const storage = memory();
  let time = 1000, calls = 0;
  const cache = createMergeCache({ storage, now: () => time, ttl: 100, maxEntries: 2, loader: async (...args) => { calls++; return result(...args); } });
  const a = 'aaaaaaaaaaa', b = 'bbbbbbbbbbb', c = 'ccccccccccc';
  await cache.merge(config, a, cues);
  time += 1; await cache.merge(config, b, cues);
  time += 1; assert.equal((await cache.merge(config, a, cues)).cache, 'hit');
  time += 1; await cache.merge(config, c, cues);
  time += 1; assert.equal((await cache.merge(config, b, cues)).cache, 'stored');
  assert.equal(calls, 4);
  const ttlStorage = memory();
  time = 1000;
  const ttlCache = createMergeCache({ storage: ttlStorage, now: () => time, ttl: 100, loader: result });
  await ttlCache.merge(config, a, cues);
  time = 1099; assert.equal((await ttlCache.merge(config, a, cues)).cache, 'hit');
  time = 1100; assert.equal((await ttlCache.merge(config, a, cues)).cache, 'stored');
});

test('enforces the UTF-8 serialized byte limit and reports an oversized entry', async () => {
  const storage = memory();
  let time = 1000;
  const cache = createMergeCache({ storage, now: () => time, maxBytes: 200, loader: result });
  await cache.merge(config, 'aaaaaaaaaaa', cues);
  time++; await cache.merge(config, 'bbbbbbbbbbb', cues);
  assert.ok(new TextEncoder().encode(JSON.stringify(storage.snapshot())).length <= 200);
  const hitOnly = createMergeCache({ storage, now: () => time, maxBytes: 200, loader: forbidden });
  assert.equal((await hitOnly.merge(config, 'bbbbbbbbbbb', cues)).cache, 'hit');
  assert.equal((await cache.merge(config, 'aaaaaaaaaaa', cues)).cache, 'stored');
  const tiny = createMergeCache({ storage: memory(), maxBytes: 1, loader: result });
  assert.equal((await tiny.merge(config, video, cues)).cache, 'unavailable');
});

test('rejects malformed partitions and expired or future records', async () => {
  for (const mutate of [
    entry => { entry.endCueIds = [1]; },
    entry => { entry.endCueIds = [2, 2]; },
    entry => { entry.createdAt = 1001; },
    entry => { entry.lastUsed = 1001; },
    entry => { entry.createdAt = -1; },
    entry => { entry.extra = 'unexpected'; }
  ]) {
    const storage = memory();
    const cache = createMergeCache({ storage, now: () => 1000, loader: result });
    await cache.merge(config, video, cues);
    const data = storage.snapshot(); mutate(data.mergeCache[0]); storage.replace(data);
    assert.equal((await cache.merge(config, video, cues)).cache, 'stored');
  }
});

test('failed loaders do not cache and pending requests are cleared', async () => {
  const storage = memory();
  let calls = 0;
  const cache = createMergeCache({ storage, loader: async (...args) => { if (++calls === 1) throw new Error('failed'); return result(...args); } });
  await assert.rejects(cache.merge(config, video, cues), /failed/);
  assert.equal((await cache.merge(config, video, cues)).cache, 'stored');
  assert.equal(calls, 2);
  const invalid = createMergeCache({ storage: memory(), loader: async () => [1] });
  assert.equal((await invalid.merge(config, video, cues)).cache, 'unavailable');
});

test('coalesces same-key requests and serializes writes for different keys', async () => {
  const storage = memory();
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const cache = createMergeCache({ storage, loader: async (...args) => { calls++; await gate; return result(...args); } });
  const requests = [cache.merge(config, video, cues), cache.merge(config, video, cues), cache.merge(config, 'aaaaaaaaaaa', cues)];
  release();
  const values = await Promise.all(requests);
  assert.deepEqual(values.map(value => value.endCueIds), [[2], [2], [2]]);
  assert.equal(calls, 2);
  const fresh = createMergeCache({ storage, loader: forbidden });
  assert.equal((await fresh.merge(config, video, cues)).cache, 'hit');
  assert.equal((await fresh.merge(config, 'aaaaaaaaaaa', cues)).cache, 'hit');
});

test('storage errors do not discard valid model results', async () => {
  for (const storage of [
    { get: async () => { throw new Error('read'); }, set: async () => {} },
    { get: async () => ({}), set: async () => { throw new Error('write'); } }
  ]) {
    const cache = createMergeCache({ storage, loader: result });
    assert.deepEqual(await cache.merge(config, video, cues), { endCueIds: [2], cache: 'unavailable' });
  }
});
