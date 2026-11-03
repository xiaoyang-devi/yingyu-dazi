import {assets, blockSize} from './checkpoint-assets.js?v=1';
import {createBestEffortCache} from './best-effort-cache.js?v=7';

const root = new URL('./assets/',import.meta.url).href;
// Voice workers later wrap CacheStorage.open for their third-party libraries.
let openStorage;
try { openStorage = globalThis.caches?.open.bind(globalThis.caches); } catch { /* Private storage is optional. */ }
let unavailable = !openStorage;
const storage = createBestEffortCache({
  name:'dialogue-immutable-blocks-v1',open:openStorage,
  openTimeoutMs:1500,readTimeoutMs:1200,writeTimeoutMs:2200,
  onBypass:() => { unavailable = true; }
});

export function checkpointAsset(url,bytes) {
  const href = String(url);
  if (!href.startsWith(root) || !globalThis.crypto?.subtle) return null;
  const metadata = assets[href.slice(root.length)];
  return metadata?.bytes === bytes ? metadata : null;
}
function key(url,plan,index) {
  const part = new URL(url);
  part.searchParams.set('dialogue-block',plan.revision + '.' + blockSize + '.' + index);
  return part.href;
}
async function digest(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  return btoa(String.fromCharCode(...hash));
}
async function cachedBlock(id,length,hash) {
  if (unavailable) return null;
  const hit = await storage.match(id);
  if (!hit || hit.headers.get('content-length') !== String(length)) return null;
  // A Cache.match can resolve while its body hangs. Bound the actual read as
  // well, and cap memory even if an invalid entry lies about its size.
  if (!hit.body) return null;
  const reader = hit.body.getReader();
  let timer, stopped = false;
  const data = new Uint8Array(length);
  async function read() {
    let offset = 0;
    while (!stopped) {
      const part = await reader.read();
      if (part.done) return offset === length;
      if (offset + part.value.length > length) return false;
      data.set(part.value,offset);
      offset += part.value.length;
    }
    return false;
  }
  try {
    const valid = await Promise.race([read(),new Promise((_,reject) => {
      timer = setTimeout(() => reject(Error('Cache body stalled')),1500);
    })]);
    return valid && await digest(data) === hash ? data : null;
  } catch {
    unavailable = true;
    return null;
  } finally {
    stopped = true;
    clearTimeout(timer);
    reader.cancel().catch(()=>{});
  }
}
async function saveBlock(id,block) {
  if (unavailable) return false;
  await storage.put(id,new Response(block,{headers:{'content-type':'application/octet-stream','content-length':String(block.length)}}));
  return !unavailable;
}

// Replay verified contiguous checkpoints first, then stream the remainder directly
// to the loader. Only one extra incomplete block is kept in memory per active file.
export function checkpointResponse(url,options,plan,networkAt) {
  const {signal,onCheckpoint} = options;
  const connection = new AbortController();
  let stopped = false, source, remote, index = 0, reused = 0, saved = 0;
  let buffer, fill = 0, warned = false;
  const notify = (kind,bytes) => { try { onCheckpoint?.({kind,bytes,total:plan.bytes}); } catch {} };
  function warnIfUnavailable() {
    if (unavailable && !warned) { warned = true; notify('unavailable',0); }
  }
  function stop() {
    if (stopped) return;
    stopped = true; connection.abort();
    signal?.removeEventListener('abort',abort);
    remote?.cancel().catch(()=>{});
  }
  function abort() {
    if (stopped) return;
    stop(); source.error(new DOMException('Aborted','AbortError'));
  }
  const lengthAt = i => Math.min(blockSize,plan.bytes-i*blockSize);
  async function capture(data) {
    for (let offset=0; offset<data.length && !stopped;) {
      if (!buffer) buffer = new Uint8Array(lengthAt(index));
      const length = Math.min(buffer.length-fill,data.length-offset);
      if (!length) throw Error('Model block exceeds the pinned size');
      buffer.set(data.subarray(offset,offset+length),fill);
      fill += length; offset += length;
      if (fill !== buffer.length) continue;
      if (await digest(buffer) !== plan.hashes[index]) throw Error('本站模型分块校验失败，请刷新后重试。');
      if (stopped) return;
      if (await saveBlock(key(url,plan,index),buffer)) { saved += buffer.length; if (!stopped) notify('saved',saved); }
      warnIfUnavailable(); index++; fill = 0; buffer = null;
    }
  }
  function done(controller) {
    if (stopped) return;
    if (index !== plan.hashes.length || fill) throw Error('Model ended before all pinned blocks arrived');
    if (reused+saved === plan.bytes) notify('complete',plan.bytes);
    stopped = true;signal?.removeEventListener('abort',abort);controller.close();
  }
  const body = new ReadableStream({
    start(controller) {
      source=controller;
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort',abort,{once:true});
    },
    async pull(controller) {
      try {
        if (!remote && index < plan.hashes.length) {
          const bytes = await cachedBlock(key(url,plan,index),lengthAt(index),plan.hashes[index]);
          if (stopped) return;
          warnIfUnavailable();
          if (bytes) {
            index++; reused += bytes.length;notify('reused',reused);controller.enqueue(bytes);return;
          }
          const response = await networkAt(reused,connection.signal);
          if (stopped) { response.body?.cancel().catch(()=>{});return; }
          if (!response.ok || !response.body) throw Error('模型下载未完成（HTTP ' + response.status + '）。');
          remote = response.body.getReader();
        }
        if (!remote) { done(controller);return; }
        const part = await remote.read();
        if (stopped) return;
        if (part.done) { done(controller);return; }
        await capture(part.value);
        if (!stopped) controller.enqueue(part.value);
      } catch (error) {
        if (!stopped) { stop();controller.error(error); }
      }
    },
    cancel:stop
  },{highWaterMark:0});
  const type = String(url).endsWith('.wasm') ? 'application/wasm' : String(url).endsWith('.json') ? 'application/json' : 'application/octet-stream';
  return new Response(body,{headers:{'content-length':String(plan.bytes),'content-type':type}});
}
