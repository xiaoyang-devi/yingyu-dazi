// The worker permits only static model assets, with no request body, query or transcript in the URL.
const runtime = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/'
const model = 'Xenova/opus-mt-zh-en', revision = '39d480d52a9ea3065a1f117adfe4dbc55de10e6f'
const base = 'https://huggingface.co/' + model + '/resolve/' + revision + '/'
const sizes = { 'config.json':1389, 'tokenizer_config.json':282, 'generation_config.json':293,
  'tokenizer.json':6381339, 'onnx/encoder_model_quantized.onnx':52899742, 'onnx/decoder_model_merged_quantized.onnx':60212804 }
const files = new Set([...Object.keys(sizes).map(f=>base+f), runtime+'ort-wasm-simd.wasm',runtime+'ort-wasm.wasm',
  runtime+'ort-wasm-simd-threaded.wasm',runtime+'ort-wasm-threaded.wasm'])
const realFetch = self.fetch.bind(self)
self.fetch = (input, options = {}) => {
  const url = typeof input === 'string' ? input : input.url || String(input)
  const method = (options.method || input.method || 'GET').toUpperCase()
  if (!files.has(url) || !['GET','HEAD'].includes(method) || options.body || input.body) throw new Error('Unavailable static asset')
  return realFetch(url,{method,credentials:'omit',referrerPolicy:'no-referrer',signal:options.signal || input.signal})
}
self.onmessage = async ({data}) => {
  let stage = 'load'
  try {
    if (!Array.isArray(data?.texts) || !data.texts.length || data.texts.length > 200 ||
        data.texts.some(text => typeof text !== 'string' || !text.trim() || Array.from(text.trim()).length > 160)) {
      throw new Error('Invalid input')
    }
    const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js')
    env.allowLocalModels = false
    // Pin both model/WASM assets; let newer Safari work without SharedArrayBuffer or COOP/COEP.
    env.backends.onnx.wasm.numThreads = 1
    env.backends.onnx.wasm.proxy = false
    env.backends.onnx.wasm.wasmPaths = runtime
    const total = Object.values(sizes).reduce((a,b)=>a+b,0), seen = new Map()
    let last = 0
    const translate = await pipeline('translation',model,{revision,quantized:true,progress_callback(info) {
      if (!(info.file in sizes) || !['progress','done'].includes(info.status)) return
      seen.set(info.file,info.status === 'done' ? sizes[info.file] : Math.min(info.loaded || 0,sizes[info.file]))
      const now = Date.now()
      if (now - last < 220 && info.status !== 'done') return
      last = now
      const loaded = Array.from(seen.values()).reduce((a,b)=>a+b,0), percent = Math.round(100*loaded/total)
      self.postMessage({type:'progress',stage,message:`正在准备本机翻译模型 · ${percent}%`,loaded,total,percent})
    }})
    stage = 'translate'
    for (const [index,text] of data.texts.entries()) {
      self.postMessage({type:'progress',stage,message:`正在本机翻译第 ${index+1} / ${data.texts.length} 句`,loaded:index,total:data.texts.length,percent:Math.round(100*index/data.texts.length)})
      const [out] = await translate(text,{num_beams:2,do_sample:false,max_new_tokens:192})
      const en = out?.translation_text?.trim()
      if (!en || !/[\p{L}\p{N}]/u.test(en)) throw new Error('Empty translation')
      self.postMessage({type:'line',index,en})
    }
    self.postMessage({type:'done'})
  } catch {
    self.postMessage({type:'error',message:stage === 'load'
      ? '无法载入本机翻译模型。请确认能访问 Hugging Face 和 jsDelivr，并检查浏览器可用内存。'
      : '本机模型未能译完本段，请分段重试或手动填写英文。'})
  }
}
