// Public Gradio APIs. Importing this module sends nothing; the caller obtains
// separate consent for each Space before selecting it.
import {readWave,splitLine,waveFromParts} from './cloud-voice.js?v=16';

const providers = {
  huggingface: {
    origin:'https://kinabraytan-kokoro-tts-server.hf.space',
    apiName:'generate_speech',
    voices:new Map([['af_heart','af_bella'],['am_michael','am_michael']]),
    data:(text,voice) => [text,voice,1]
  }
};
const invalidResult = () => Error('备用配音服务返回了无效的结果。');
const cancelled = () => new DOMException('已停止备用配音。','AbortError');
const check = signal => { if (signal.aborted) throw signal.reason || cancelled(); };

// A rejected submission, a busy result stream, or a bounded wait for a result
// can route elsewhere. A failed audio download instead retains its known URL.
export class BackupVoiceBusyError extends Error {
  constructor(reason,retryMs = 60000) {
    super(reason === 'backup-timeout' ? '备用配音等待超时，尚未取得录音。' : '备用配音服务繁忙，已完成的录音会保留。');
    this.name = 'BackupVoiceBusyError';
    this.reason = reason;
    this.retryAt = Date.now() + Math.max(1000,retryMs);
  }
}

function retryDelay(response) {
  const value = response.headers.get('Retry-After');
  const ms = /^\d+(?:\.\d+)?$/.test(value || '') ? Number(value)*1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? ms : 60000;
}

async function request(url,signal,options,stage) {
  check(signal);
  const response = await fetch(url,{
    ...options,signal,credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',cache:'no-store'
  });
  check(signal);
  if (stage !== 'audio' && [429,503].includes(response.status)) {
    throw new BackupVoiceBusyError(response.status === 429 ? 'backup-rate-limit' : 'backup-unavailable',retryDelay(response));
  }
  if (!response.ok) {
    const error = Error(stage === 'audio' ? '录音已生成，但下载暂时未完成。重试会继续下载这份录音。' : '备用配音服务暂时不可用，请稍后重试。');
    error.status = response.status;
    error.stage = stage;
    throw error;
  }
  return response;
}

// Enforce caps even without Content-Length; release a blocked reader on abort.
async function consume(response,maxBytes,signal,onChunk) {
  if (!response.body || Number(response.headers.get('Content-Length')) > maxBytes) throw invalidResult();
  const reader = response.body.getReader();
  const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
  let length = 0;
  signal.addEventListener('abort',abort,{once:true});
  try {
    for (;;) {
      check(signal);
      const {value,done} = await reader.read();
      check(signal);
      if (done) return onChunk(null);
      length += value.byteLength;
      if (length > maxBytes) throw invalidResult();
      const result = onChunk(value);
      if (result !== undefined) return result;
    }
  } finally {
    signal.removeEventListener('abort',abort);
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function boundedBody(response,maxBytes,signal) {
  const chunks = [];
  return consume(response,maxBytes,signal,value => {
    if (value === null) return new Blob(chunks);
    chunks.push(value);
  });
}

function safeFile(file,origin) {
  if (typeof file !== 'string') throw invalidResult();
  const url = new URL(file);
  if (url.origin !== origin || url.username || url.password || url.search || url.hash ||
      !url.pathname.startsWith('/gradio_api/file=') || !url.pathname.endsWith('.wav')) throw invalidResult();
  return url.href;
}

async function resultFile(response,origin,signal) {
  const decoder = new TextDecoder();
  let buffer = '';
  return consume(response,65536,signal,value => {
    buffer += value === null ? decoder.decode() : decoder.decode(value,{stream:true});
    buffer = buffer.replace(/\r\n/g,'\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const fields = buffer.slice(0,boundary).split('\n');
      buffer = buffer.slice(boundary+2);
      const kind = fields.find(field => field.startsWith('event:'))?.slice(6).trim();
      if (!['error','complete'].includes(kind)) continue;
      const data = JSON.parse(fields.filter(field => field.startsWith('data:')).map(field => field.slice(5).trimStart()).join('\n'));
      if (kind === 'error') {
        if (typeof data === 'string' && /queue (?:is )?full|too many (?:concurrent )?requests|rate.limit|server (?:is )?busy/i.test(data)) {
          throw new BackupVoiceBusyError('backup-unavailable');
        }
        const error = Error('备用配音未能合成这句英文。重试时会重新提交这一段。');
        error.remoteFailed = true;
        throw error;
      }
      return safeFile(data?.[0]?.url,origin);
    }
    // Process the terminal event immediately, without waiting for SSE EOF.
    if (value === null) throw invalidResult();
  });
}

async function generatePart(text,voice,signal,job,config,onDownload) {
  const endpoint = config.origin + '/gradio_api/call/' + config.apiName;
  if (!job.eventId && !job.resultURL) {
    const response = await request(endpoint,signal,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({data:config.data(text,voice)})},'submit');
    const {event_id} = JSON.parse(await (await boundedBody(response,4096,signal)).text());
    if (typeof event_id !== 'string' || !/^[a-f0-9]{32}$/i.test(event_id)) throw invalidResult();
    job.eventId = event_id;
    job.acceptedAt = Date.now();
  }
  if (!job.resultURL) {
    const events = await request(endpoint + '/' + job.eventId,signal,{},'result');
    job.resultURL = await resultFile(events,config.origin,signal);
  }
  check(signal);
  const url = safeFile(job.resultURL,config.origin);
  onDownload();
  const audio = await boundedBody(await request(url,signal,{},'audio'),12 * 1024 * 1024,signal);
  const blob = await readWave(new Response(audio));
  check(signal);
  job.blob = blob;
  return blob;
}

export async function synthesizeBackupLine(text,primaryVoice,signal,{job = {},maxWaitMs = 90000,provider = 'huggingface'} = {}) {
  const config = providers[provider], voice = config?.voices.get(primaryVoice);
  if (!voice || typeof text !== 'string') throw invalidResult();
  if (job.text !== undefined && (job.text !== text || job.voice !== voice || job.provider !== provider)) throw invalidResult();
  job.text = text; job.voice = voice; job.provider = provider;
  const controller = new AbortController(), clips = [], parts = splitLine(text);
  const abort = () => controller.abort(signal.reason || cancelled());
  if (signal?.aborted) { abort(); throw controller.signal.reason; }
  signal?.addEventListener('abort',abort,{once:true});
  job.parts ||= [];
  try {
    for (const [index,part] of parts.entries()) {
      const piece = job.parts[index] || (job.parts[index] = {});
      check(controller.signal);
      if (piece.blob) { clips.push(piece.blob); continue; }
      // Waiting for synthesis and downloading completed audio have separate
      // budgets. A URL received at the end of the wait still gets a full download
      // window; retrying a known URL never starts the short synthesis timer.
      let timer = piece.resultURL ? null : setTimeout(() => controller.abort(new BackupVoiceBusyError('backup-timeout')),maxWaitMs);
      const onDownload = () => {
        check(controller.signal);
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(Error('录音已生成，但下载等待超时。重试会继续下载这份录音。')),90000);
      };
      try { clips.push(await generatePart(part,voice,controller.signal,piece,config,onDownload)); }
      catch (error) {
        // Confirmed terminal failure/expiry allows a fresh submission on the
        // next user retry. An interrupted accepted job keeps its ID instead.
        if (error.remoteFailed || error.stage === 'result' && [404,410].includes(error.status)) {
          delete piece.eventId; delete piece.resultURL;
        }
        throw error;
      } finally { clearTimeout(timer); }
    }
    check(controller.signal);
    if (clips.length === 1) return clips[0];
    return waveFromParts(await clips[0].slice(0,44).arrayBuffer(),clips.map(clip => clip.slice(44)));
  } catch (error) {
    if (signal?.aborted) throw signal.reason || cancelled();
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof SyntaxError) throw invalidResult();
    if (error instanceof TypeError) throw Error('无法连接备用配音服务，请检查网络后重试。');
    throw error;
  } finally {
    controller.abort();
    signal?.removeEventListener('abort',abort);
  }
}
