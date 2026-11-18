import { applyEndIds } from './captions.js';
import { endpointUrl, merge as modelMerge } from './model.js';
import { MERGE_PROMPT } from './prompts.js';
import { normalizeSettings } from './settings.js';

const STORAGE_KEY = 'mergeCache';
const TTL = 30 * 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();

// Bump this when the merge request or local partition policy changes.
const POLICY = 'merge-v1;thinking=disabled;window=80,8000;gap=1000;duration=12000;words=30';

export function createMergeCache({ storage, loader = modelMerge, now = Date.now, maxEntries = 256, maxBytes = 1024 * 1024, ttl = TTL } = {}) {
  const pending = new Map();
  let queue = Promise.resolve();
  const exclusive = fn => {
    const operation = queue.then(fn);
    queue = operation.catch(() => {});
    return operation;
  };
  const validRecord = (record, time) => record && typeof record === 'object' && !Array.isArray(record) &&
    Object.keys(record).length === 4 && /^[a-f0-9]{64}$/.test(record.hash) &&
    Array.isArray(record.endCueIds) && record.endCueIds.length > 0 && record.endCueIds.every(Number.isSafeInteger) &&
    Number.isSafeInteger(record.createdAt) && Number.isSafeInteger(record.lastUsed) &&
    record.createdAt >= 0 && record.createdAt <= record.lastUsed && record.lastUsed <= time && time - record.createdAt < ttl;
  const readEntries = async time => {
    const value = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
    return Array.isArray(value) ? value.filter(record => validRecord(record, time)).map(({ hash, endCueIds, createdAt, lastUsed }) => ({ hash, endCueIds, createdAt, lastUsed })) : [];
  };
  const save = async entries => {
    entries.sort((a, b) => b.lastUsed - a.lastUsed || b.createdAt - a.createdAt);
    entries.length = Math.min(entries.length, Math.max(0, maxEntries));
    while (entries.length && encoder.encode(JSON.stringify({ [STORAGE_KEY]: entries })).length > maxBytes) entries.pop();
    await storage.set({ [STORAGE_KEY]: entries });
    return entries;
  };
  const keyFor = async (videoId, config, cues) => {
    if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId) || !Array.isArray(cues) || !cues.length) return null;
    if (cues.some((cue, i) => !cue || !Number.isSafeInteger(cue.id) || (i && cue.id <= cues[i - 1].id) ||
      !Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs) || cue.endMs < cue.startMs || typeof cue.text !== 'string')) return null;
    const settings = normalizeSettings(config);
    const input = JSON.stringify([videoId, endpointUrl(settings.endpoint).href, settings.model, MERGE_PROMPT, POLICY,
      cues.map(cue => [cue.id, cue.startMs, cue.endMs, cue.text])]);
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  };
  return {
    async merge(config, videoId, cues) {
      let hash;
      try { hash = await keyFor(videoId, config, cues); } catch { /* Cache is optional. */ }
      if (!hash) return { endCueIds: await loader(config, cues), cache: 'unavailable' };
      if (pending.has(hash)) return pending.get(hash);
      const operation = (async () => {
        let unavailable = false;
        try {
          const hit = await exclusive(async () => {
            const time = now();
            const entries = await readEntries(time);
            const entry = entries.find(item => item.hash === hash);
            if (!entry || !applyEndIds(cues, entry.endCueIds)) return null;
            entry.lastUsed = time;
            try { await save(entries); return { endCueIds: entry.endCueIds, cache: 'hit' }; }
            catch { return { endCueIds: entry.endCueIds, cache: 'unavailable' }; }
          });
          if (hit) return hit;
        } catch { unavailable = true; }
        const endCueIds = await loader(config, cues);
        if (!applyEndIds(cues, endCueIds)) return { endCueIds, cache: 'unavailable' };
        if (!unavailable) {
          try {
            const stored = await exclusive(async () => {
              const time = now();
              const entries = (await readEntries(time)).filter(entry => entry.hash !== hash);
              entries.unshift({ hash, endCueIds: [...endCueIds], createdAt: time, lastUsed: time });
              return (await save(entries)).some(entry => entry.hash === hash);
            });
            if (!stored) unavailable = true;
          } catch { unavailable = true; }
        }
        return { endCueIds, cache: unavailable ? 'unavailable' : 'stored' };
      })();
      pending.set(hash, operation);
      try { return await operation; } finally { pending.delete(hash); }
    }
  };
}
