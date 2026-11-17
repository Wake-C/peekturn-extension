const clean = text => text.replace(/[\s\p{Z}\u0085]+/gu, ' ').trim();

// Input remains untouched; IDs describe the stable chronological source order.
export function normalizeCues(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(c => c && typeof c.text === 'string' && clean(c.text) &&
    Number.isFinite(c.startMs) && Number.isFinite(c.endMs) && c.startMs >= 0 && c.endMs > c.startMs)
    .map((c, order) => ({ startMs: c.startMs, endMs: c.endMs, text: clean(c.text), order }))
    .sort((a, b) => a.startMs - b.startMs || a.order - b.order)
    .map(({ startMs, endMs, text }, id) => ({ id, startMs, endMs, text }));
}

export function mergeWindows(cues) {
  const windows = [];
  let window = [], chars = 0;
  for (const cue of cues) {
    const length = clean(cue.text).length;
    if (window.length && (window.length >= 80 || chars + 1 + length > 8000)) {
      windows.push(window); window = []; chars = 0;
    }
    chars += (window.length ? 1 : 0) + length;
    window.push(cue);
  }
  if (window.length) windows.push(window);
  return windows;
}

export function applyEndIds(cues, endCueIds) {
  if (!Array.isArray(cues) || !Array.isArray(endCueIds) || !cues.length || !endCueIds.length) return null;
  const positions = new Map();
  for (let i = 0; i < cues.length; i++) {
    if (!Number.isSafeInteger(cues[i].id) || positions.has(cues[i].id)) return null;
    positions.set(cues[i].id, i);
  }
  const ends = [];
  let previous = -1;
  for (const id of endCueIds) {
    const index = positions.get(id);
    if (!Number.isSafeInteger(id) || index === undefined || index <= previous) return null;
    ends.push(index); previous = index;
  }
  if (previous !== cues.length - 1) return null;
  const result = [];
  let start = 0;
  for (const end of ends) {
    while (start <= end) {
      let last = start, latestEnd = cues[start].endMs;
      let words = (cues[start].text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || []).length;
      while (last < end) {
        const next = cues[last + 1];
        const nextEnd = Math.max(latestEnd, next.endMs);
        const nextWords = words + (next.text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || []).length;
        if (next.startMs - latestEnd > 1000 || nextEnd - cues[start].startMs > 12000 || nextWords > 30) break;
        last++; latestEnd = nextEnd; words = nextWords;
      }
      result.push({ id: cues[start].id, startMs: cues[start].startMs, endMs: latestEnd,
        text: clean(cues.slice(start, last + 1).map(c => c.text).join(' ')) });
      start = last + 1;
    }
  }
  return result;
}

export function cueAt(cues, timeMs) {
  if (!Number.isFinite(timeMs)) return -1;
  let lo = 0, hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cues[mid].startMs <= timeMs) lo = mid + 1; else hi = mid;
  }
  // Earlier cues may overlap a later, already-ended cue.
  for (let i = lo - 1; i >= 0; i--) if (timeMs < cues[i].endMs) return i;
  return -1;
}

export function parseJson3(json) {
  if (!Array.isArray(json?.events)) return [];
  const raw = [], seen = new Map();
  for (const event of json.events) {
    const start = Number(event.tStartMs), duration = Number(event.dDurationMs);
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0 || !Array.isArray(event.segs)) continue;
    let text = '', firstOffset = null;
    for (const seg of event.segs) {
      if (typeof seg.utf8 !== 'string') continue;
      const offset = Number(seg.tOffsetMs);
      const timed = seg.tOffsetMs != null && Number.isFinite(offset) && offset >= 0;
      const key = timed ? `${start + offset}\u0000${seg.utf8}` : null;
      // Only identical source-timed segments in overlapping display events are redraws.
      if (key && (seen.get(key) ?? -1) > start) continue;
      if (key) seen.set(key, start + duration);
      if (firstOffset === null && seg.utf8.trim()) firstOffset = timed ? offset : 0;
      text += seg.utf8;
    }
    const cueStart = start + (firstOffset ?? 0);
    if (text.trim() && cueStart < start + duration) raw.push({ startMs: cueStart, endMs: start + duration, text });
  }
  return normalizeCues(raw);
}

export function parseTranscriptResponse(json) {
  const raw = [];
  const stack = [json];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) { for (let i = value.length - 1; i >= 0; i--) stack.push(value[i]); continue; }
    const segment = value.transcriptSegmentRenderer;
    if (segment) {
      const startMs = Number(segment.startMs), endMs = Number(segment.endMs);
      const text = segment.snippet?.simpleText ?? segment.snippet?.runs?.map(r => r.text ?? '').join('');
      raw.push({ startMs, endMs, text });
    } else for (const child of Object.values(value)) stack.push(child);
  }
  return normalizeCues(raw);
}
