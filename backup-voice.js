// Hugging Face Space's public Gradio API. Importing this module sends nothing.
import {readWave,splitLine,waveFromParts} from './cloud-voice.js?v=12';

const origin = 'https://kinabraytan-kokoro-tts-server.hf.space';
const endpoint = origin + '/gradio_api/call/generate_speech';
const fallbackVoices = new Map([['af_heart','af_bella'],['am_michael','am_michael']]);
const invalidResult = () => Error('备用配音服务返回了无效的结果。');

async function request(url,signal,options) {
  const response = await fetch(url,{
    ...options,signal,credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',cache:'no-store'
  });
  if (response.status === 429) throw Error('备用配音服务也已限流，请稍后重试。');
  if (!response.ok) throw Error('备用配音服务暂时不可用，请稍后重试。');
  return response;
}

// Also enforce the cap if a streaming response omits Content-Length.
async function boundedBody(response,maxBytes) {
  if (!response.body || Number(response.headers.get('Content-Length')) > maxBytes) throw invalidResult();
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      const {value,done} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw invalidResult();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks);
}

function resultFile(events) {
  for (const block of events.replace(/\r\n?/g,'\n').split('\n\n')) {
    const fields = block.split('\n');
    if (fields.includes('event: error')) throw Error('备用配音未能合成这句英文。');
    if (!fields.includes('event: complete')) continue;
    const data = fields.filter(field => field.startsWith('data:')).map(field => field.slice(5).trimStart()).join('\n');
    const file = JSON.parse(data)?.[0]?.url;
    if (typeof file !== 'string') throw invalidResult();
    const url = new URL(file);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash ||
        !url.pathname.startsWith('/gradio_api/file=') || !url.pathname.endsWith('.wav')) throw invalidResult();
    return url.href;
  }
  throw invalidResult();
}

async function generatePart(text,voice,signal) {
  const response = await request(endpoint,signal,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({data:[text,voice,1]})});
  const {event_id} = JSON.parse(await (await boundedBody(response,4096)).text());
  if (typeof event_id !== 'string' || !/^[a-f0-9]{32}$/i.test(event_id)) throw invalidResult();
  const events = await request(endpoint + '/' + event_id,signal);
  const url = resultFile(await (await boundedBody(events,65536)).text());
  const audio = await boundedBody(await request(url,signal),12 * 1024 * 1024);
  return readWave(new Response(audio));
}

export async function synthesizeBackupLine(text,primaryVoice,signal) {
  const voice = fallbackVoices.get(primaryVoice);
  if (!voice || typeof text !== 'string') throw invalidResult();
  const job = new AbortController(), clips = [];
  const abort = () => job.abort(signal.reason || new DOMException('已停止备用配音。','AbortError'));
  if (signal?.aborted) { abort(); throw job.signal.reason; }
  signal?.addEventListener('abort',abort,{once:true});
  try {
    for (const part of splitLine(text)) {
      const timer = setTimeout(() => job.abort(Error('备用配音等待超时，请稍后重试。')),90000);
      try { clips.push(await generatePart(part,voice,job.signal)); }
      finally { clearTimeout(timer); }
    }
    if (job.signal.aborted) throw job.signal.reason;
    if (clips.length === 1) return clips[0];
    return waveFromParts(await clips[0].slice(0,44).arrayBuffer(),clips.map(clip => clip.slice(44)));
  } catch (error) {
    if (job.signal.aborted) throw job.signal.reason;
    if (error instanceof SyntaxError) throw invalidResult();
    if (error instanceof TypeError) throw Error('无法连接备用配音服务，请检查网络后重试。');
    throw error;
  } finally {
    job.abort(); // Release any oversized or incomplete response.
    signal?.removeEventListener('abort',abort);
  }
}
