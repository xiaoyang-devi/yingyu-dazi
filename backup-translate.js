// Public Gradio translation endpoint. The caller decides whether the user has opted in.
const endpoint = 'https://helsinki-nlp-opus-translate.hf.space/call/translate';
const invalid = () => Error('备用翻译返回了无法读取的结果。');
const quota = () => Error('备用翻译服务也已达到用量或请求频率限制，请稍后再试。');

async function request(url,signal,options) {
  const response = await fetch(url,{
    ...options,signal,credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',cache:'no-store'
  });
  if (response.status === 429) throw quota();
  if (!response.ok) throw Error('备用翻译服务暂时不可用，请稍后再试。');
  return response;
}

// Bound the streamed response, including when the server omits Content-Length. For SSE,
// return as soon as a terminal event arrives instead of waiting for the connection to close.
async function readResponse(response,maxBytes,extract) {
  if (!response.body || Number(response.headers.get('Content-Length')) > maxBytes) throw invalid();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) {
        text += decoder.decode();
        if (!extract) return text;
        const result = extract(text);
        if (result !== null) return result;
        throw invalid();
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) throw invalid();
      text += decoder.decode(value,{stream:true});
      if (!extract) continue;
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(text))) {
        const result = extract(text.slice(0,boundary.index));
        if (result !== null) return result;
        text = text.slice(boundary.index + boundary[0].length);
      }
    }
  } finally { reader.releaseLock(); }
}

function extractResult(block) {
  const fields = block.split(/\r?\n/);
  const event = fields.find(line => line.startsWith('event:'))?.slice(6).trim();
  if (event !== 'complete' && event !== 'error') return null;
  const data = fields.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  if (event === 'error') {
    if (/quota|rate.?limit|too many requests/i.test(data)) throw quota();
    throw Error('备用翻译未能完成这句，服务可能正在排队或已限流。');
  }
  const result = JSON.parse(data);
  // OPUS returns [translation, error]. A nonempty error field is never a translation.
  if (!Array.isArray(result) || result.length !== 2 || result[1] !== '' ||
      typeof result[0] !== 'string' || result[0].length > 8000) throw invalid();
  return result[0].trim();
}

export async function translateBackupSegment(text,signal) {
  const job = new AbortController();
  const abort = () => job.abort(signal.reason || new DOMException('已取消备用翻译。','AbortError'));
  if (signal?.aborted) { abort(); throw job.signal.reason; }
  if (typeof text !== 'string' || !text.trim() || new TextEncoder().encode(text).length > 500) {
    throw Error('备用翻译只接受所选聊天中的单个文字片段。');
  }
  signal?.addEventListener('abort',abort,{once:true});
  const timer = setTimeout(() => job.abort(Error('备用翻译等待超时，请稍后再试。')),90000);
  try {
    const submission = await request(endpoint,job.signal,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({data:[text,'Chinese','English']})});
    const id = JSON.parse(await readResponse(submission,4096))?.event_id;
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/i.test(id)) throw invalid();
    const events = await request(endpoint + '/' + id,job.signal,{headers:{Accept:'text/event-stream'}});
    if (!/^text\/event-stream\b/i.test(events.headers.get('Content-Type') || '')) throw invalid();
    return await readResponse(events,65536,extractResult);
  } catch (error) {
    if (job.signal.aborted) throw job.signal.reason;
    if (error instanceof SyntaxError) throw invalid();
    if (error instanceof TypeError) throw Error('未能连接备用翻译服务，请检查网络后重试。');
    throw error;
  } finally {
    clearTimeout(timer);
    job.abort();
    signal?.removeEventListener('abort',abort);
  }
}
