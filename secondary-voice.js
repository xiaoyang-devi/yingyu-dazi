// Pendrokar's explicitly exposed CPU API. Importing sends nothing. The caller
// obtains separate consent before invoking this provider. generate_all is used
// because predict/generate_first silently return only the first pipeline chunk.
import {readWave, waveFromParts} from './cloud-voice.js?v=16';

const origin = 'https://pendrokar-kokoro-tts.hf.space';
const endpoint = origin + '/gradio_api/call/generate_all';
const maxBytes = 12 * 1024 * 1024;
const invalid = () => Error('第二备用配音返回的录音不完整，已保留生成任务，请稍后重试。');
const cancelled = () => new DOMException('已停止第二备用配音。', 'AbortError');
const check = signal => { if (signal.aborted) throw signal.reason || cancelled(); };

async function request(url, signal, options = {}) {
  check(signal);
  const response = await fetch(url, {...options, signal, credentials:'omit', referrerPolicy:'no-referrer', redirect:'error', cache:'no-store'});
  check(signal);
  if (!response.ok) {
    const error = Error([429,503].includes(response.status)
      ? '第二备用配音服务也暂时繁忙。已完成的录音会保留，请稍后重试。'
      : '第二备用配音暂时未完成。已保留生成任务，请稍后重试。');
    error.status = response.status;
    throw error;
  }
  return response;
}

async function consume(response, limit, signal, onChunk) {
  if (!response.body || Number(response.headers.get('Content-Length')) > limit) throw invalid();
  const reader = response.body.getReader();
  const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
  let size = 0;
  signal.addEventListener('abort', abort, {once:true});
  try {
    for (;;) {
      check(signal);
      const {value, done} = await reader.read();
      check(signal);
      if (done) return onChunk(null);
      size += value.byteLength;
      if (size > limit) throw invalid();
      const result = onChunk(value);
      if (result !== undefined) return result;
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function body(response, limit, signal) {
  const chunks = [];
  return consume(response, limit, signal, value => {
    if (value === null) return new Blob(chunks);
    chunks.push(value);
  });
}

function safePlaylist(value) {
  if (typeof value !== 'string') throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.origin !== origin || url.username || url.password || url.search || url.hash ||
      !/^\/gradio_api\/stream\/[a-f\d]{32}\/\d+\/\d+\/playlist\.m3u8$/i.test(url.pathname)) throw invalid();
  return url.href;
}

async function resultPlaylist(response, signal) {
  const decoder = new TextDecoder();
  let buffer = '';
  return consume(response, 65536, signal, value => {
    buffer += value === null ? decoder.decode() : decoder.decode(value, {stream:true});
    buffer = buffer.replace(/\r\n/g, '\n');
    // A terminal frame is enough; an SSE connection need not close afterwards.
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const fields = buffer.slice(0,boundary).split('\n');
      buffer = buffer.slice(boundary+2);
      const type = fields.find(line => line.startsWith('event:'))?.slice(6).trim();
      if (!['complete','error'].includes(type)) continue;
      if (type === 'error') {
        const error = Error('第二备用配音未能完成这句英文。再次重试时会重新提交这一句。');
        error.terminalFailed = true;
        throw error;
      }
      const data = JSON.parse(fields.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'));
      if (data?.[0]?.is_stream !== true) throw invalid();
      return safePlaylist(data[0].url);
    }
    if (value === null) throw invalid();
  });
}

// This service exposes a finite HLS playlist of raw AAC chunks, including a
// zero-duration placeholder. Only that narrow, unencrypted format is accepted.
function parsePlaylist(text, playlistURL) {
  const lines = text.trim().split(/\r?\n/).map(line => line.trim());
  if (lines[0] !== '#EXTM3U' || lines.at(-1) !== '#EXT-X-ENDLIST') throw invalid();
  const directory = new URL('.', safePlaylist(playlistURL)).href;
  const segments = [];
  let duration = null, total = 0, count = 0;
  for (const line of lines.slice(1,-1)) {
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      if (duration !== null || !/^#EXTINF:(?:\d+(?:\.\d+)?),[^\r\n]*$/.test(line)) throw invalid();
      duration = Number(line.slice(8).split(',')[0]);
      if (!Number.isFinite(duration) || duration > 250) throw invalid();
      continue;
    }
    if (line.startsWith('#')) {
      if (duration !== null || !/^(?:#EXT-X-PLAYLIST-TYPE:(?:EVENT|VOD)|#EXT-X-TARGETDURATION:\d+|#EXT-X-VERSION:[1-9]\d*|#EXT-X-MEDIA-SEQUENCE:0)$/.test(line)) throw invalid();
      continue;
    }
    // No absolute URLs, parent traversal, query parameters, key, map, ranges,
    // variant playlist, or external origin can enter the decoder.
    if (duration === null || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\.aac$/i.test(line) || ++count > 64) throw invalid();
    total += duration;
    if (total > 250) throw invalid();
    if (duration > 0) segments.push({url:directory + line, duration});
    duration = null;
  }
  if (duration !== null || !segments.length) throw invalid();
  return segments;
}

function abortable(promise, signal) {
  return new Promise((resolve,reject) => {
    const abort = () => reject(signal.reason || cancelled());
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort',abort,{once:true});
    promise.then(value => { signal.removeEventListener('abort',abort); resolve(value); },
      error => { signal.removeEventListener('abort',abort); reject(error); });
  });
}

async function decode(segment, signal) {
  const Context = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Context) throw Error('此浏览器暂不支持第二备用录音解码，请用最新版 Safari 重试。');
  const context = new Context(1,1,24000);
  const audio = await abortable(context.decodeAudioData(await segment.aac.arrayBuffer()), signal);
  check(signal);
  if (audio.numberOfChannels !== 1 || audio.sampleRate !== 24000 || !audio.length ||
      audio.length * 2 > maxBytes || audio.duration > segment.duration + 2 ||
      audio.duration < Math.max(0.001,segment.duration - 0.25)) throw invalid();
  const samples = audio.getChannelData(0), pcm = new ArrayBuffer(samples.length * 2), view = new DataView(pcm);
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) throw invalid();
    const sample = Math.max(-1,Math.min(1,samples[i]));
    view.setInt16(i*2,Math.round(sample * (sample < 0 ? 32768 : 32767)),true);
  }
  return new Blob([pcm]);
}

function header() {
  const result = new ArrayBuffer(44), v = new DataView(result);
  v.setUint32(0,0x52494646); v.setUint32(8,0x57415645); v.setUint32(12,0x666d7420);
  v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
  v.setUint32(24,24000,true); v.setUint32(28,48000,true); v.setUint16(32,2,true);
  v.setUint16(34,16,true); v.setUint32(36,0x64617461);
  return result;
}

export async function synthesizeSecondaryLine(text, voice, signal, {job = {}, maxWaitMs = 30000} = {}) {
  if (typeof text !== 'string' || !text.trim() || Array.from(text).length > 6000 || !['af_heart','am_michael'].includes(voice)) throw invalid();
  if (job.text !== undefined && (job.text !== text || job.voice !== voice)) throw invalid();
  if (signal?.aborted) throw signal.reason || cancelled();
  job.text = text; job.voice = voice;
  if (job.blob) return job.blob;
  // Only a confirmed terminal SSE error allows a new POST, and only when the
  // caller explicitly retries. Timeouts/cancellation/download errors retain IDs.
  if (job.terminalFailed && !job.segments) {
    delete job.eventId; delete job.resultURL; delete job.terminalFailed;
  }
  const controller = new AbortController(), active = controller.signal;
  const abort = () => controller.abort(signal.reason || cancelled());
  signal?.addEventListener('abort',abort,{once:true});
  const timer = setTimeout(() => controller.abort(Error('第二备用配音等待超时。已完成的录音和任务会保留，请稍后重试。')),
    Number.isFinite(maxWaitMs) ? Math.max(1,Math.min(120000,maxWaitMs)) : 30000);
  try {
    if (!job.eventId && !job.resultURL) {
      const submitted = await request(endpoint,active,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:[text,voice,1,false,'en-us']})});
      const data = JSON.parse(await (await body(submitted,4096,active)).text());
      if (typeof data.event_id !== 'string' || !/^[a-f\d]{32}$/i.test(data.event_id)) throw invalid();
      job.eventId = data.event_id;
    }
    if (!job.resultURL) job.resultURL = await resultPlaylist(await request(endpoint + '/' + job.eventId,active),active);
    const playlistURL = safePlaylist(job.resultURL);
    if (!job.segments) job.segments = parsePlaylist(await (await body(await request(playlistURL,active),65536,active)).text(),playlistURL);
    let pcmBytes = 0, compressedBytes = 0;
    for (const segment of job.segments) {
      check(active);
      if (!segment.aac) segment.aac = await body(await request(segment.url,active),maxBytes,active);
      compressedBytes += segment.aac.size;
      if (!segment.aac.size || compressedBytes > maxBytes) throw invalid();
      if (!segment.pcm) segment.pcm = await decode(segment,active);
      pcmBytes += segment.pcm.size;
      if (pcmBytes + 44 > maxBytes) throw invalid();
    }
    const audio = waveFromParts(header(),job.segments.map(segment => segment.pcm));
    const blob = await readWave(new Response(audio));
    check(active);
    job.blob = blob;
    return blob;
  } catch (error) {
    if (active.aborted) throw active.reason;
    if (error.terminalFailed) job.terminalFailed = true;
    if (error instanceof SyntaxError) throw invalid();
    if (error instanceof TypeError) throw Error('无法连接第二备用配音服务。已保留生成任务，请检查网络后重试。');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort',abort);
    controller.abort();
  }
}
