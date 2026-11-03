import {modelFileProgress} from './model-progress.js?v=5'
// The worker permits only static model assets, with no request body, query or transcript in the URL.
const runtime = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/'
const model = 'Xenova/opus-mt-zh-en', revision = '39d480d52a9ea3065a1f117adfe4dbc55de10e6f'
const base = 'https://huggingface.co/' + model + '/resolve/' + revision + '/'
const sizes = { 'config.json':1389, 'tokenizer_config.json':282, 'generation_config.json':293,
  'tokenizer.json':6381339, 'onnx/encoder_model_quantized.onnx':52899742, 'onnx/decoder_model_merged_quantized.onnx':60212804 }
const files = new Set([...Object.keys(sizes).map(f=>base+f), runtime+'ort-wasm-simd.wasm',runtime+'ort-wasm.wasm',
  runtime+'ort-wasm-simd-threaded.wasm',runtime+'ort-wasm-threaded.wasm'])
const progress = modelFileProgress(sizes, '翻译', detail => self.postMessage({type:'progress', ...detail}))
let assetProblem = ''
function invalidAsset() {
  assetProblem = 'incomplete'
  return new Error('Incomplete pinned asset')
}

// A fetch response body is already decoded. v2.17.2 grows and copies its entire
// buffer on every chunk when the header is absent or still describes compressed data.
function sizedModelResponse(url, response, discardCached) {
  if (!url.startsWith(base) || !Object.hasOwn(sizes,url.slice(base.length)) ||
      !response || response.status !== 200 || !response.body || response.headers.has('content-range')) return response
  const expected = sizes[url.slice(base.length)]
  if (!discardCached && response.headers.get('content-length') === String(expected) && !response.headers.get('content-encoding')) return response
  if (/text\/html/i.test(response.headers.get('content-type') || '')) throw invalidAsset()
  const headers = new Headers(response.headers)
  headers.set('content-length',String(expected))
  headers.delete('content-encoding')
  headers.delete('transfer-encoding')
  async function incomplete() {
    const error = invalidAsset()
    if (discardCached) {
      try { await discardCached() } catch { /* Storage may have become unavailable. */ }
    }
    throw error
  }
  let received = 0
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength
      if (received > expected) return incomplete()
      controller.enqueue(chunk)
    },
    flush() { if (received !== expected) return incomplete() }
  }))
  const sized = new Response(body,{status:response.status,statusText:response.statusText,headers})
  // The loader reads the response once. Preserve the original HTTP provenance without
  // copying or teeing the body; downstream CacheStorage receives the corrected headers.
  Object.defineProperties(sized, {
    url:{value:response.url}, redirected:{value:response.redirected}, type:{value:response.type}
  })
  return sized
}

async function useModelCache(env) {
  if (!env.useBrowserCache) return
  // Older cached blobs may also lack a usable content-length. Keep the same cache
  // and keys as v2.17.2, but normalize known, immutable responses on a cache hit.
  env.useBrowserCache = false
  try {
    const cache = await caches.open('transformers-cache')
    env.customCache = {
      async match(key) {
        const hit = await cache.match(key)
        const discard = () => cache.delete(key)
        try { return sizedModelResponse(key,hit,discard) }
        catch { await discard(); return undefined }
      },
      put(key,value) { return cache.put(key,value) }
    }
    env.useCustomCache = true
  } catch { /* Private browsing can disable CacheStorage. Loading from the network still works. */ }
}
const realFetch = self.fetch.bind(self)
self.fetch = async (input, options = {}) => {
  const url = typeof input === 'string' ? input : input.url || String(input)
  const method = (options.method || input.method || 'GET').toUpperCase()
  if (!files.has(url) || !['GET','HEAD'].includes(method) || options.body || input.body) throw new Error('Unavailable static asset')
  if (method === 'GET') {
    if (url.startsWith(base)) progress.request(url.slice(base.length))
    else progress.prepare('正在载入本机翻译运行组件，浏览器未报告此步骤的进度…')
  }
  let response
  try { response = await realFetch(url,{method,credentials:'omit',referrerPolicy:'no-referrer',signal:options.signal || input.signal}) }
  catch (error) { assetProblem = 'network'; throw error }
  if (!response.ok) assetProblem = 'network'
  return method === 'GET' ? sizedModelResponse(url,response) : response
}
self.onmessage = async ({data}) => {
  let stage = 'library'
  try {
    if (!Array.isArray(data?.texts) || !data.texts.length || data.texts.length > 200 ||
        data.texts.some(text => typeof text !== 'string' || !text.trim() || Array.from(text.trim()).length > 160)) {
      throw new Error('Invalid input')
    }
    progress.prepare('翻译进程已启动，正在载入翻译程序…')
    const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js')
    stage = 'load'
    env.allowLocalModels = false
    // Pin both model/WASM assets; let newer Safari work without SharedArrayBuffer or COOP/COEP.
    env.backends.onnx.wasm.numThreads = 1
    env.backends.onnx.wasm.proxy = false
    env.backends.onnx.wasm.wasmPaths = runtime
    progress.prepare('正在检查本机缓存并准备翻译模型…')
    await useModelCache(env)
    const translate = await pipeline('translation',model,{revision,quantized:true,progress_callback:progress.observe})
    stage = 'translate'
    for (const [index,text] of data.texts.entries()) {
      const position = {type:'progress',stage,phase:'translate',unit:'lines',loaded:index,total:data.texts.length,percent:Math.floor(100*index/data.texts.length)}
      const label = '第 '+(index+1)+' / '+data.texts.length+' 句'
      self.postMessage({...position,message:'正在本机翻译'+label})
      let lastStep = performance.now()
      const [out] = await translate(text,{num_beams:2,do_sample:false,max_new_tokens:192,callback_function() {
        // Called by v2 after a real decoder step. Never emit tokens, beams or source text.
        const now = performance.now()
        if (now-lastStep < 1800) return
        lastStep = now
        self.postMessage({...position,message:label+'仍在本机翻译中…'})
      }})
      const en = out?.translation_text?.trim()
      if (!en || !/[\p{L}\p{N}]/u.test(en)) throw new Error('Empty translation')
      self.postMessage({type:'line',index,en})
    }
    self.postMessage({type:'done'})
  } catch (error) {
    let message
    if (stage === 'translate') message = '本机模型未能完成这句翻译。请缩短本次制作范围后重试。'
    else if (stage === 'library') message = '翻译程序未能载入。请检查网络能否访问 jsDelivr，并用新版 Safari 重试。'
    else if (assetProblem === 'incomplete') message = '翻译模型文件不完整。请检查网络后重试，损坏的缓存文件会单独重新下载。'
    else if (assetProblem === 'network' || /network|fetch|load failed|connection/i.test(error?.message || '')) message = '翻译文件下载未完成。请确认网络能访问 Hugging Face 和 jsDelivr 后重试。'
    else message = '本机翻译引擎未能启动。请关闭占用内存的其他页面，在新版 Safari 中重试。'
    self.postMessage({type:'error',message})
  }
}
