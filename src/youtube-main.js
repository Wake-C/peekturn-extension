(() => {
  'use strict';
  const currentId = () => location.pathname === '/watch' ? new URL(location.href).searchParams.get('v') : null;
  const validUrl = value => {
    try {
      const url = new URL(value, location.origin);
      return url.protocol === 'https:' && (url.hostname === 'www.youtube.com' || url.hostname === 'youtube.com') &&
        !url.username && !url.password && url.port === '' && url.pathname === '/api/timedtext' ? url : null;
    } catch { return null; }
  };
  const normalize = raw => raw.filter(c => typeof c.text === 'string' && c.text.trim() &&
    Number.isFinite(c.startMs) && Number.isFinite(c.endMs) && c.startMs >= 0 && c.endMs > c.startMs)
    .map((c, order) => ({ ...c, text: c.text.replace(/[\s\p{Z}\u0085]+/gu, ' ').trim(), order }))
    .sort((a, b) => a.startMs - b.startMs || a.order - b.order)
    .map(({ startMs, endMs, text }, id) => ({ id, startMs, endMs, text }));
  const jsonCues = json => {
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
        if (key && (seen.get(key) ?? -1) > start) continue;
        if (key) seen.set(key, start + duration);
        if (firstOffset === null && seg.utf8.trim()) firstOffset = timed ? offset : 0;
        text += seg.utf8;
      }
      const cueStart = start + (firstOffset ?? 0);
      if (text.trim() && cueStart < start + duration) raw.push({ startMs: cueStart, endMs: start + duration, text });
    }
    return normalize(raw);
  };
  const xmlCues = body => {
    const doc = new DOMParser().parseFromString(body, 'application/xml');
    if (doc.querySelector('parsererror')) return [];
    return normalize(Array.from(doc.querySelectorAll('transcript > text, timedtext body > p'), node => {
      const modern = node.hasAttribute('t');
      const startMs = Number(node.getAttribute(modern ? 't' : 'start')) * (modern ? 1 : 1000);
      const duration = Number(node.getAttribute(modern ? 'd' : 'dur')) * (modern ? 1 : 1000);
      return { startMs, endMs: startMs + duration, text: node.textContent };
    }));
  };
  // YouTube adds session verification parameters only when its player requests a track.
  // Keep those URLs inside the page world; never send them to extension storage or the model.
  const nativeRequests = new Map();
  const rememberRequest = entry => {
    const url = validUrl(entry.name);
    if (!url || entry.initiatorType !== 'xmlhttprequest' ||
        !/^en(?:-|$)/i.test(url.searchParams.get('lang') || '')) return;
    const videoId = url.searchParams.get('v');
    if (videoId !== currentId()) return;
    nativeRequests.set(videoId, url.href);
    for (const id of nativeRequests.keys()) if (id !== videoId) nativeRequests.delete(id);
  };
  new PerformanceObserver(list => list.getEntries().forEach(rememberRequest))
    .observe({ type: 'resource', buffered: true });
  async function nativeCaptions(videoId, track) {
    performance.getEntriesByType('resource').forEach(rememberRequest);
    if (!nativeRequests.has(videoId) && track) {
      const player = document.getElementById('movie_player');
      try {
        player?.loadModule?.('captions');
        // Player tracks carry internal IDs needed for verified requests; server captionTracks do not.
        let nativeTrack;
        for (let i = 0; i < 24 && !nativeTrack; i++) {
          if (currentId() !== videoId) return [];
          nativeTrack = player?.getOption?.('captions', 'tracklist')
            ?.find(item => /^en(?:-|$)/i.test(item.languageCode || ''));
          if (!nativeTrack) await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (nativeTrack) {
          player.setOption('captions', 'track', nativeTrack);
          player.setOption('captions', 'reload', true);
        }
      } catch { /* The player may still be initializing. */ }
    }
    const attempted = new Set();
    // A native request can finish empty before YouTube obtains verification. Wait for its
    // subsequent request, but never retry the same signed URL or retain it beyond this video.
    for (let i = 0; i < 32; i++) {
      if (currentId() !== videoId) return [];
      const url = nativeRequests.get(videoId);
      if (url && !attempted.has(url)) {
        attempted.add(url);
        try {
          const response = await fetch(url, {
            credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(8000)
          });
          if (response.ok && validUrl(response.url)) {
            const body = await response.text();
            if (body && body.length <= 20 * 1024 * 1024) {
              let cues;
              try { cues = jsonCues(JSON.parse(body)); } catch { cues = xmlCues(body); }
              if (cues.length) return cues;
            }
          }
        } catch { /* A newer native request can replace an expired or incomplete one. */ }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return [];
  }
  const playerResponse = videoId => {
    const player = document.getElementById('movie_player');
    let response;
    try { response = player?.getPlayerResponse?.(); } catch { /* Player is not ready yet. */ }
    if (response?.videoDetails?.videoId === videoId) return response;
    response = window.ytInitialPlayerResponse;
    return response?.videoDetails?.videoId === videoId ? response : null;
  };
  // Walk only YouTube's data objects, never the DOM or arbitrary page globals.
  const findObjects = (root, predicate) => {
    const found = [], stack = [root], seen = new WeakSet();
    let count = 0;
    while (stack.length && count < 100000) {
      const value = stack.pop();
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      count++;
      if (predicate(value)) found.push(value);
      for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(child);
    }
    return found;
  };
  const transcriptCues = json => {
    const segments = findObjects(json, value => value.transcriptSegmentRenderer);
    return normalize(segments.map(({ transcriptSegmentRenderer: segment }) => ({
      startMs: Number(segment.startMs), endMs: Number(segment.endMs),
      text: segment.snippet?.simpleText ?? segment.snippet?.runs?.map(run => run.text ?? '').join('')
    })));
  };
  async function transcriptFallback(videoId, tracks) {
    const flexy = document.querySelector('ytd-watch-flexy');
    const data = flexy?.data;
    const dataId = data?.currentVideoEndpoint?.watchEndpoint?.videoId ??
      data?.response?.currentVideoEndpoint?.watchEndpoint?.videoId ??
      data?.playerResponse?.videoDetails?.videoId;
    const roots = [];
    if (dataId === videoId) roots.push(data);
    if (window.ytInitialPlayerResponse?.videoDetails?.videoId === videoId) roots.push(window.ytInitialData);
    let params;
    for (const root of roots) {
      const endpoint = findObjects(root, value => typeof value.getTranscriptEndpoint?.params === 'string')[0];
      if (endpoint) { params = endpoint.getTranscriptEndpoint.params; break; }
    }
    const context = window.ytcfg?.get?.('INNERTUBE_CONTEXT');
    const key = window.ytcfg?.get?.('INNERTUBE_API_KEY');
    if (!params || !context || typeof context !== 'object') return [];
    const url = new URL('/youtubei/v1/get_transcript', location.origin);
    if (typeof key === 'string' && key) url.searchParams.set('key', key);
    const request = async requestParams => {
      if (currentId() !== videoId) return null;
      const result = await fetch(url.href, {
        method: 'POST', credentials: 'same-origin', redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context, params: requestParams })
      });
      if (!result.ok || result.url && new URL(result.url).origin !== location.origin) return null;
      const body = await result.text();
      if (!body || body.length > 20 * 1024 * 1024) return null;
      return JSON.parse(body);
    };
    try {
      let json = await request(params);
      if (!json) return [];
      const menus = findObjects(json, value => Array.isArray(value.sortFilterSubMenuRenderer?.subMenuItems));
      const items = menus.flatMap(value => value.sortFilterSubMenuRenderer.subMenuItems);
      const english = items.find(item => /^english(?:\b|$)/i.test(
        typeof item.title === 'string' ? item.title : item.title?.simpleText ?? ''));
      if (items.length) {
        if (!english) return [];
        if (!english.selected) {
          const endpoint = findObjects(english, value => typeof value.getTranscriptEndpoint?.params === 'string')[0];
          if (!endpoint) return [];
          json = await request(endpoint.getTranscriptEndpoint.params);
          if (!json) return [];
        }
      } else if (!tracks?.length || tracks.some(track => !/^en(?:-|$)/i.test(track.languageCode || ''))) {
        // A transcript without language metadata cannot safely be called English.
        return [];
      }
      return transcriptCues(json);
    } catch { return []; }
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function acquire(videoId) {
    let response;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (currentId() !== videoId) throw new Error('Video changed');
      response = playerResponse(videoId);
      if (response?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length) break;
      await sleep(250);
    }
    const trackList = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    const tracks = Array.isArray(trackList) ? trackList : [];
    const english = tracks.filter(track => typeof track.languageCode === 'string' && /^en(?:-|$)/i.test(track.languageCode));
    english.sort((a, b) => (a.kind === 'asr') - (b.kind === 'asr'));
    const native = await nativeCaptions(videoId, english[0]);
    if (native.length) return native;
    for (const track of english) {
      const url = validUrl(track.baseUrl);
      if (!url) continue;
      for (const format of ['json3', 'xml']) {
        url.searchParams.set('fmt', format);
        try {
          const result = await fetch(url.href, { credentials: 'same-origin', redirect: 'error' });
          if (!result.ok || !validUrl(result.url)) continue;
          const body = await result.text();
          if (!body || body.length > 20 * 1024 * 1024) continue;
          let cues;
          if (format === 'json3') { try { cues = jsonCues(JSON.parse(body)); } catch { continue; } }
          else cues = xmlCues(body);
          if (cues.length) return cues;
        } catch { /* Try the next available format or English track. */ }
      }
    }
    const transcript = await transcriptFallback(videoId, tracks);
    if (transcript.length) return transcript;
    throw new Error('Could not retrieve English captions');
  }
  document.addEventListener('peekturn:request', async event => {
    const { videoId, requestId } = event.detail || {};
    if (typeof videoId !== 'string' || !/^[\w-]{11}$/.test(videoId) ||
        !(typeof requestId === 'string' || Number.isSafeInteger(requestId)) || currentId() !== videoId) return;
    let cues = [], error;
    try { cues = await acquire(videoId); } catch (e) { error = e.message || 'Could not retrieve English captions'; }
    if (currentId() !== videoId) return;
    document.dispatchEvent(new CustomEvent('peekturn:captions', { detail: { videoId, requestId, cues, ...(error ? { error } : {}) } }));
  });
})();
