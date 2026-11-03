// Load immutable same-site files. The deadline covers only an outstanding network
// read, never time spent compiling WASM or using the model.
export async function fetchSiteAsset(url, {fetcher, bytes, signal, onRetry, idleMs = 25000, method = 'GET', fresh = false}) {
  const maxRetries = 2;
  let received = 0, skip = 0, retries = 0, connection, reader;
  const abort = () => connection?.abort();
  signal?.throwIfAborted?.();
  signal?.addEventListener('abort',abort,{once:true});
  const cleanup = () => signal?.removeEventListener('abort',abort);

  async function timed(operation) {
    let timer;
    try {
      return await Promise.race([operation(),new Promise((_,reject) => {
        timer = setTimeout(() => { abort(); reject(Error('Site download stalled')); },idleMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function open() {
    if (signal?.aborted) throw new DOMException('Aborted','AbortError');
    connection = new AbortController();
    const range = received && bytes ? {Range:'bytes=' + received + '-'} : {};
    const response = await timed(() => fetcher(url,{
      method, headers:range, credentials:'omit', referrerPolicy:'no-referrer',
      cache:fresh || retries ? 'reload' : 'default', signal:connection.signal
    }));
    if (response.status === 429 || response.status >= 500) throw Error('Model server HTTP ' + response.status);
    if (!response.ok) return response;
    skip = received; // When the server ignores Range, discard only the prefix already delivered.
    if (response.status === 206) {
      const expected = 'bytes ' + received + '-' + (bytes-1) + '/' + bytes;
      if (!bytes || response.headers.get('content-range') !== expected) throw Error('Unexpected model byte range');
      skip = 0;
    }
    reader = response.body?.getReader();
    return response;
  }
  function retry(error) {
    abort();
    if (signal?.aborted || retries >= maxRetries) { cleanup(); throw error; }
    retries++;
    onRetry?.(retries,received);
  }
  async function connect() {
    for (;;) {
      try { return await open(); }
      catch (error) { retry(error); }
    }
  }
  const first = await connect();
  if (!first.ok || method === 'HEAD' || !reader) { cleanup(); return first; }
  const headers = new Headers(first.headers);
  headers.delete('content-encoding');
  headers.delete('transfer-encoding');
  headers.delete('content-range');
  if (bytes) headers.set('content-length',String(bytes)); else headers.delete('content-length');
  let closed = false;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        while (!closed) {
          let part;
          try {
            part = await timed(() => reader.read());
            if (part.done && (skip || (bytes && received !== bytes))) throw Error('Incomplete site download');
            if (!part.done && bytes && received + Math.max(0,part.value.byteLength-skip) > bytes) throw Error('Oversized site download');
          } catch (error) {
            if (closed) return;
            retry(error);
            const response = await connect();
            if (!response.ok || !reader) throw Error('Model server HTTP ' + response.status);
            continue;
          }
          if (part.done) { closed = true; cleanup(); controller.close(); return; }
          const discard = Math.min(skip,part.value.byteLength);
          skip -= discard;
          const chunk = part.value.subarray(discard);
          if (!chunk.byteLength) continue;
          received += chunk.byteLength;
          controller.enqueue(chunk);
          return;
        }
      } catch (error) { if (!closed) { closed = true; abort(); cleanup(); controller.error(error); } }
    },
    cancel() { closed = true; abort(); cleanup(); }
  });
  return new Response(body,{status:200,headers});
}
