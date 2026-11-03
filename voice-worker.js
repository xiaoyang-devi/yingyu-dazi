import {modelFileProgress} from './model-progress.js?v=7';
import {createBestEffortCache} from './best-effort-cache.js?v=7';
import {fetchSiteAsset} from './site-asset.js?v=7';
// Pinned browser bundle from the Kokoro authors. The phonemizer and tokenizer run here.
const PACKAGE = new URL("./assets/voice-runtime/kokoro.web.js",import.meta.url).href;
const WASM = new URL("./assets/voice-runtime/",import.meta.url).href;
const modelRoot = new URL("./assets/voice-model/",import.meta.url).href;
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const REV = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
const base = "https://huggingface.co/" + MODEL + "/resolve/";
const voiceFiles = new Set(["af_heart","am_michael","bf_emma","af_bella","am_fenrir","bm_george","bf_isabella"]);

// Kokoro's bundled eSpeak dictionary iterates a gzip stream during module startup.
// Some WebKit workers support DecompressionStream but lack the stream iterator.
if (typeof ReadableStream !== "undefined" && !ReadableStream.prototype[Symbol.asyncIterator]) {
  Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, {
    configurable: true, writable: true,
    async *value(options = {}) {
      const reader = this.getReader();
      let done = false;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) { done = true; return; }
          yield chunk.value;
        }
      } finally {
        try {
          if (!done && !options.preventCancel) await reader.cancel();
        } finally { reader.releaseLock(); }
      }
    }
  });
}

// Keep the library's existing cache keys, but fetch its pinned bytes from this site.
const modelFiles = new Set([
  "config.json","tokenizer.json","tokenizer_config.json","special_tokens_map.json","onnx/model_quantized.onnx",
  ...Array.from(voiceFiles,voice => "voices/"+voice+".bin")
]);
const runtimeSizes = {"ort-wasm-simd-threaded.jsep.mjs":44484,"ort-wasm-simd-threaded.jsep.wasm":21596019};
const storedInBlocks = new Set()
const skipWrite = key => {
  const url = typeof key === 'string' ? key : key.url || String(key)
  return [...storedInBlocks].some(file => url.endsWith('/' + file))
}
let bypassCache = false;
const coreSizes = {"config.json":44, "tokenizer_config.json":113, "tokenizer.json":3497, "onnx/model_quantized.onnx":92361116};
let progress;
const http = self.fetch.bind(self);
self.fetch = (input, options = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, self.location.href);
  const method = (options.method || input.method || "GET").toUpperCase();
  if (!["GET","HEAD"].includes(method) || options.body || input.body || url.search || url.hash) {
    throw new Error("配音组件只允许下载静态模型文件。");
  }
  let modelFile;
  for (const alias of ["main", REV]) {
    const prefix = base + alias + "/";
    if (url.href.startsWith(prefix) && modelFiles.has(url.href.slice(prefix.length))) {
      modelFile = url.href.slice(prefix.length);
      break;
    }
  }
  const runtimeFile = url.href.startsWith(WASM) ? url.href.slice(WASM.length) : "";
  if (!modelFile && !Object.hasOwn(runtimeSizes,runtimeFile)) throw Error("无效的语音组件文件。");
  if (method === "GET") {
    if (runtimeFile) progress.prepare("正在载入本站的语音运行组件…");
    else progress.request(modelFile);
  }
  const bytes = modelFile?.startsWith('voices/') ? 522240 : coreSizes[modelFile] || runtimeSizes[runtimeFile];
  return fetchSiteAsset(modelFile ? modelRoot + modelFile : url.href, {
    fetcher:http, bytes, method,
    fresh:bypassCache, signal:options.signal || input.signal,
    onCheckpoint:event => {
      const name = modelFile || runtimeFile
      if (event.kind === 'complete') storedInBlocks.add(name)
      progress.checkpoint(name,event)
    },
    onRetry:attempt => progress.networkRetry(attempt)
  });
};
try {
  const open = self.caches.open.bind(self.caches);
  const adapters = new Map();
  self.caches.open = async name => {
    if (!adapters.has(name)) adapters.set(name,createBestEffortCache({
      name:"yingyudazi-voice-"+REV+"-"+name, open, bypassReads:bypassCache, skipWrite,
      onBypass:() => progress?.prepare("已跳过暂不可用的设备缓存，正在从本站读取配音文件…")
    }));
    return adapters.get(name);
  };
} catch { /* CacheStorage is optional. */ }

let engine;
let queue=Promise.resolve();
let notify=()=>{};

function load() {
  if (!engine) {
    engine=(async()=>{
      progress = modelFileProgress(coreSizes, "语音", detail => notify(detail.message,detail));
      progress.prepare("正在打开本机语音组件…");
      const {KokoroTTS,env}=await import(PACKAGE);
      // This published Kokoro bundle exposes only wasmPaths. Its bundled ORT
      // selects one thread in a non-cross-origin-isolated worker (including standalone iOS).
      env.wasmPaths = WASM;
      progress.prepare("正在准备本站的配音模型…");
      return KokoroTTS.from_pretrained(MODEL,{device:"wasm",dtype:"q8",progress_callback:progress.observe});
    })().catch(error=>{engine=undefined;throw error;});
  }
  return engine;
}

function segments(line) {
  // Stay well below Kokoro's phoneme window, even for long supplied messages.
  const result=[];
  let current="";
  for(const word of line.trim().split(/\s+/u)){
    if(word.length>100)throw new Error("有一段英文过长且没有空格，请分段后重试。");
    if(current.length+word.length+1>145){
      // Prefer a nearby natural boundary; keep decimals and initials within a word.
      const boundary=[...current.matchAll(/[.!?;,:][”’"']? +/g)].pop();
      const cut=boundary && boundary.index>60 ? boundary.index+boundary[0].length : current.length;
      result.push(current.slice(0,cut).trim());
      current=current.slice(cut).trim();
      if(current && current.length+word.length+1>145){result.push(current);current="";}
    }
    current+=(current?" ":"")+word;
  }
  if(current)result.push(current);
  return result;
}

function wav(parts, rate) {
  const gap=Math.floor(rate*.11);
  const frames=parts.reduce((a,x)=>a+x.length,0)+gap*(parts.length-1);
  const buf=new ArrayBuffer(44+2*frames), view=new DataView(buf);
  const write=(pos,s)=>{for(let i=0;i<s.length;i++)view.setUint8(pos+i,s.charCodeAt(i));};
  write(0,"RIFF");view.setUint32(4,buf.byteLength-8,true);write(8,"WAVE");write(12,"fmt ");
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);
  view.setUint32(28,2*rate,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
  write(36,"data");view.setUint32(40,2*frames,true);
  let idx=44;
  for(let n=0;n<parts.length;n++){
    if(n)idx+=gap*2;
    for(const v of parts[n]){view.setInt16(idx,Math.round(Math.min(1,Math.max(-1,v))*32767),true);idx+=2;}
  }
  return buf;
}

async function render({id,text,voice,bypassCache:skipCache}) {
  bypassCache = skipCache === true;
  notify=(status,detail)=>self.postMessage({id,status,detail});
  try{
    if(!voiceFiles.has(voice) || typeof text!=="string" || !text.trim() || text.length>12000)throw new Error("无效的语音或台词。");
    const tts=await load();
    const chunks=segments(text),parts=[];
    for(let i=0;i<chunks.length;i++){
      const status=chunks.length>1?"正在本机配音 "+(i+1)+" / "+chunks.length:"正在本机配音…";
      notify(status,{stage:"synthesize",phase:"synthesize",unit:"segments",loaded:i,total:chunks.length,message:status});
      const audio=await tts.generate(chunks[i],{voice,speed:.92});
      if(audio.sampling_rate!==24000 || !audio.audio?.length)throw new Error("语音输出为空，请重试。");
      parts.push(audio.audio);
    }
    if(!parts.length)throw new Error("没有可朗读的英文。");
    const output=wav(parts,24000);
    self.postMessage({id,wav:output},[output]);
  }catch(error){
    // Keep locally processed transcript content out of telemetry/errors.
    console.warn("本机配音失败",String(error?.name || "Error"));
    self.postMessage({id,error:"本机配音未完成。请确认网络可以下载本站文件，然后重试。"});
  }finally{notify=()=>{};}
}
self.onmessage=event=>{queue=queue.then(()=>render(event.data));};
