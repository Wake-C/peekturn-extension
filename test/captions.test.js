import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCues, mergeWindows, applyEndIds, cueAt, parseJson3, parseTranscriptResponse } from '../src/captions.js';

test('normalizes and sorts without changing source', () => {
  const source = [{ startMs: 1000, endMs: 2000, text: '  later\nline ' },
    { startMs: 0, endMs: 500, text: ' first ' }, { startMs: 1, endMs: 1, text: 'bad' }];
  const snapshot = structuredClone(source);
  assert.deepEqual(normalizeCues(source), [
    { id: 0, startMs: 0, endMs: 500, text: 'first' },
    { id: 1, startMs: 1000, endMs: 2000, text: 'later line' },
  ]);
  assert.deepEqual(source, snapshot);
});

test('windows partition long tracks with cue and character limits', () => {
  const cues = normalizeCues(Array.from({ length: 205 }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 500, text: 'a' })));
  const windows = mergeWindows(cues);
  assert.deepEqual(windows.map(w => w.length), [80, 80, 45]);
  assert.deepEqual(windows.flat(), cues);
  const large = normalizeCues([{ startMs: 0, endMs: 1, text: 'x'.repeat(8001) }, { startMs: 1, endMs: 2, text: 'y' }]);
  assert.deepEqual(mergeWindows(large).map(w => w.length), [1, 1]);
});

test('rejects malformed partitions and preserves original text', () => {
  const cues = normalizeCues([{ startMs: 0, endMs: 1000, text: 'one' },
    { startMs: 1000, endMs: 2000, text: 'two' }, { startMs: 2000, endMs: 3000, text: 'three' }]);
  for (const ends of [[], [0], [3], [2, 2], [1, 0, 2], ['2'], [1.5, 2], null]) assert.equal(applyEndIds(cues, ends), null);
  const before = structuredClone(cues);
  assert.deepEqual(applyEndIds(cues, [1, 2]), [
    { id: 0, startMs: 0, endMs: 2000, text: 'one two' },
    { id: 2, startMs: 2000, endMs: 3000, text: 'three' },
  ]);
  assert.deepEqual(cues, before);
});

test('splits at local duration, word and gap limits', () => {
  const cues = normalizeCues([
    { startMs: 0, endMs: 1000, text: Array(30).fill('word').join(' ') },
    { startMs: 1000, endMs: 2000, text: 'next' },
    { startMs: 3001, endMs: 4000, text: 'gap' },
    { startMs: 4000, endMs: 17000, text: 'long' },
  ]);
  assert.deepEqual(applyEndIds(cues, [3]).map(c => c.id), [0, 1, 2, 3]);
});

test('lookup respects gaps, exclusive ends, and overlapping cues', () => {
  const cues = normalizeCues([{ startMs: 0, endMs: 5000, text: 'long' },
    { startMs: 1000, endMs: 2000, text: 'short' }, { startMs: 6000, endMs: 7000, text: 'later' }]);
  assert.equal(cueAt(cues, 1500), 1);
  assert.equal(cueAt(cues, 2000), 0);
  assert.equal(cueAt(cues, 5000), -1);
  assert.equal(cueAt(cues, 7000), -1);
});

test('json3 honors segment offsets and removes only source-timed redraws', () => {
  const cues = parseJson3({ events: [
    { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'hello ', tOffsetMs: 200 }, { utf8: 'world', tOffsetMs: 500 }] },
    { tStartMs: 1500, dDurationMs: 2000, segs: [{ utf8: 'world', tOffsetMs: 0 }, { utf8: ' again', tOffsetMs: 600 }] },
    { tStartMs: 4000, dDurationMs: 1000, segs: [{ utf8: 'again again' }] },
    { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: 'again again' }] },
  ] });
  assert.deepEqual(cues.map(c => [c.startMs, c.endMs, c.text]), [[1200, 3000, 'hello world'], [2100, 3500, 'again'], [4000, 5000, 'again again'], [5000, 6000, 'again again']]);
  assert.deepEqual(parseJson3({ events: [{ tStartMs: 0, segs: [{ utf8: 'missing duration' }] }] }), []);
});

test('parses actual transcript segment renderers', () => {
  const json = { actions: [{ updateEngagementPanelAction: { content: { transcriptRenderer: { body: {
    transcriptBodyRenderer: { cueGroups: [
      { transcriptSegmentRenderer: { startMs: '1234', endMs: '2345', snippet: { runs: [{ text: 'hello ' }, { text: 'world' }] } } },
      { transcriptSegmentRenderer: { startMs: '3000', endMs: '4000', snippet: { simpleText: 'hello world' } } },
    ] },
  } } } } }] };
  assert.deepEqual(parseTranscriptResponse(json), [
    { id: 0, startMs: 1234, endMs: 2345, text: 'hello world' },
    { id: 1, startMs: 3000, endMs: 4000, text: 'hello world' },
  ]);
});
