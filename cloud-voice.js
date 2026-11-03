// The caller obtains consent before calling this module. Importing it performs no network requests.
export const CLOUD_VOICES = Object.freeze(['af_heart', 'am_michael']);

const api = 'https://api.tts.ai';
const audioOrigins = new Set([api, 'https://cdn.tts.ai']);
const maxPart = 500;
const recentSubmissions = [];
const maxAudioBytes = 12 * 1024 * 1024;
const cancelled = () => new DOMException('已取消在线配音。', 'AbortError');
const invalidAudio = () => Error('在线配音返回的录音不完整，请重试。');

function splitLine(text) {
  const chars = Array.from(text.trim());
  if (!chars.length) throw Error('这句缺少英文台词。');
  if (chars.length > 5000) throw Error('这句英文超过在线配音每日 5,000 字符额度，请缩短选区。');
  const parts = [];
  for (let start = 0; start < chars.length;) {
    let end = Math.min(start + maxPart, chars.length);
    if (end < chars.length) {
      for (let k = end - 1; k >= start + maxPart / 2; k--) {
        if (/\s/u.test(chars[k])) { end = k + 1; break; }
      }
    }
    const part = chars.slice(start, end).join('').trim();
    if (part) parts.push(part);
    start = end;
  }
  return parts;
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason || cancelled()); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason || cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, {once:true});
  });
}

// The free endpoint allows ten submissions per minute. Count submitted attempts even if cancelled.
async function waitForSubmission(signal) {
  for (;;) {
    if (signal.aborted) throw signal.reason || cancelled();
    const now = performance.now();
    while (recentSubmissions.length && now - recentSubmissions[0] >= 60000) recentSubmissions.shift();
    if (recentSubmissions.length < 10) {
      recentSubmissions.push(now);
      return;
    }
    await pause(Math.ceil(60000 - (now - recentSubmissions[0])), signal);
  }
}

async function request(url, options, signal) {
  const res = await fetch(url, {...options, signal, credentials:'omit', referrerPolicy:'no-referrer', cache:'no-store', redirect:'error'});
  if (res.status === 429 || res.status === 402) throw Error('在线配音达到免费用量或请求频率上限。可稍后重试，或在制作台选择纯本机配音。');
  if (!res.ok) throw Error('在线配音服务暂时不可用。可稍后重试，或在制作台选择纯本机配音。');
  return res;
}

async function json(res) {
  try { return await res.json(); }
  catch { throw Error('在线配音服务未返回有效的任务信息。'); }
}

function waveFromParts(header, pcm) {
  const bytes = pcm.reduce((sum, chunk) => sum + chunk.size, 0);
  const v = new DataView(header);
  v.setUint32(4, bytes + 36, true);
  v.setUint32(40, bytes, true);
  return new Blob([header, ...pcm], {type:'audio/wav'});
}

// Keep quiet consonants and breaths. In 5-ms windows, disregard DC offset and the
// near-zero dither that Kokoro leaves in its long pauses. Never trim an interior pause.
function trimQuietEdges(view, blob) {
  const frames = (blob.size - 44) / 2, windowFrames = 120;
  let first = frames, last = 0, audible = false;
  for (let start = 0; start < frames; start += windowFrames) {
    const end = Math.min(frames, start + windowFrames);
    let sum = 0, energy = 0;
    for (let i = start; i < end; i++) {
      const sample = view.getInt16(44 + 2 * i, true);
      sum += sample;
      energy += sample * sample;
    }
    const count = end - start;
    const variance = energy / count - (sum / count) ** 2;
    if (variance > 8 ** 2) {
      first = Math.min(first, start);
      last = end;
      if (variance > 24 ** 2) audible = true;
    }
  }
  if (!audible) throw Error('在线配音返回了一段静音，请重试。');
  const from = Math.max(0, first - 1680), to = Math.min(frames, last + 3120); // 70 / 130 ms at 24 kHz
  if (from === 0 && to === frames) return blob.slice(0, blob.size, 'audio/wav');
  return waveFromParts(view.buffer.slice(0,44), [blob.slice(44 + from * 2, 44 + to * 2)]);
}

// Only accept the canonical PCM format used by the library and downloadable listening cards.
async function readWave(res) {
  if (Number(res.headers.get('Content-Length')) > maxAudioBytes) throw invalidAudio();
  const blob = await res.blob();
  if (blob.size <= 44 || blob.size > maxAudioBytes || blob.size % 2) throw invalidAudio();
  const v = new DataView(await blob.arrayBuffer());
  if (v.getUint32(0) !== 0x52494646 || v.getUint32(4,true) !== blob.size - 8 ||
      v.getUint32(8) !== 0x57415645 || v.getUint32(12) !== 0x666d7420 ||
      v.getUint32(16,true) !== 16 || v.getUint16(20,true) !== 1 || v.getUint16(22,true) !== 1 ||
      v.getUint32(24,true) !== 24000 || v.getUint32(28,true) !== 48000 ||
      v.getUint16(32,true) !== 2 || v.getUint16(34,true) !== 16 ||
      v.getUint32(36) !== 0x64617461 || v.getUint32(40,true) !== blob.size - 44) throw invalidAudio();
  return trimQuietEdges(v, blob);
}

async function generatePart(text, voice, signal) {
  const created = await json(await request(api + '/v1/tts/', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:'kokoro', text, voice, language:'en', format:'wav', speed:1})
  }, signal));
  if (typeof created?.uuid !== 'string' || !/^[a-z\d-]{1,80}$/i.test(created.uuid)) {
    throw Error('在线配音未返回任务编号。');
  }
  const poll = api + '/v1/speech/results/?uuid=' + encodeURIComponent(created.uuid);
  for (;;) {
    await pause(1300, signal);
    const result = await json(await request(poll, {}, signal));
    if (result?.status === 'completed') {
      if (typeof result.result_url !== 'string') throw invalidAudio();
      let source;
      try { source = new URL(result.result_url, api); } catch { throw invalidAudio(); }
      if (!audioOrigins.has(source.origin) || source.username || source.password) throw invalidAudio();
      return readWave(await request(source.href, {}, signal));
    }
    if (!['queued','pending','processing','running','started','in_progress'].includes(result?.status)) {
      throw Error('在线配音未能完成这句英文。可稍后重试，或在制作台选择纯本机配音。');
    }
  }
}

export async function synthesizeCloudLine(text, voice, signal) {
  if (signal?.aborted) throw cancelled();
  if (!CLOUD_VOICES.includes(voice)) throw Error('请选择在线配音提供的音色。');
  if (typeof text !== 'string') throw Error('这句缺少英文台词。');
  const parts = splitLine(text);
  const controller = new AbortController();
  const abort = () => controller.abort(cancelled());
  signal?.addEventListener('abort', abort, {once:true});
  const clips = [];
  try {
    for (const part of parts) {
      await waitForSubmission(controller.signal);
      const timer = setTimeout(() => controller.abort(Error('在线配音响应超时。请检查网络后重试，或在制作台选择纯本机配音。')), 60000);
      try { clips.push(await generatePart(part, voice, controller.signal)); }
      finally { clearTimeout(timer); }
    }
    if (controller.signal.aborted) throw controller.signal.reason || cancelled();
    if (clips.length === 1) return clips[0];
    const pcm = clips.map(clip => clip.slice(44));
    const header = await clips[0].slice(0,44).arrayBuffer();
    if (controller.signal.aborted) throw controller.signal.reason || cancelled();
    return waveFromParts(header, pcm);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason || cancelled();
    if (error instanceof TypeError) throw Error('未能连接在线配音服务，请检查网络或选择纯本机配音。');
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

export const cloudClipKey = (voice,text) => JSON.stringify([voice,text]);

// Only call after the user approves this selection. Cache by exact text AND voice
// so retries, repeated sentences and edits reuse matching audio.
export async function renderCloudDialogue(lines,voices,clips,signal,onLine) {
  const pending = new Set();
  let characters = 0;
  for (const line of lines) {
    const voice = voices.get(line.speaker);
    if (!CLOUD_VOICES.includes(voice)) throw Error('请选择有效的自然配音音色。');
    const key = cloudClipKey(voice,line.en);
    if (clips.has(key) || pending.has(key)) continue;
    pending.add(key);
    characters += Array.from(line.en).length;
  }
  if (characters > 5000) throw Error('本次待配音的英文超过 5,000 字符，请缩短选区。');
  const ready = [];
  for (const [i,line] of lines.entries()) {
    if (signal.aborted) throw signal.reason || cancelled();
    const voice = voices.get(line.speaker), key = cloudClipKey(voice,line.en);
    onLine(i,line,voice);
    if (!clips.has(key)) {
      const blob = await synthesizeCloudLine(line.en,voice,signal);
      if (signal.aborted) throw signal.reason || cancelled();
      clips.set(key,blob);
    }
    ready.push({...line,blob:clips.get(key)});
  }
  return ready;
}
