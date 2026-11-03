// Pinned browser bundle from the Kokoro authors. The phonemizer and tokenizer run here.
const PACKAGE = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";
const WASM = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/";
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

// The published v1.2.1 bundle constructs HF /main/ URLs internally. Bind its fetch
// and cache namespace to the immutable revision without modifying other app workers.
const modelFiles = new Set([
  "config.json","tokenizer.json","tokenizer_config.json","special_tokens_map.json","onnx/model_quantized.onnx",
  ...Array.from(voiceFiles,voice => "voices/"+voice+".bin")
]);
const runtimeFiles = new Set(["ort-wasm-simd-threaded.jsep", "ort-wasm-simd-threaded", "ort-wasm-simd", "ort-wasm"]
  .flatMap(stem => [WASM+stem+".wasm", WASM+stem+".mjs"]));
const http = self.fetch.bind(self);
self.fetch = (input, options = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, self.location.href);
  const method = (options.method || input.method || "GET").toUpperCase();
  if (!["GET","HEAD"].includes(method) || options.body || input.body || url.search || url.hash) {
    throw new Error("配音组件只允许下载静态模型文件。");
  }
  let target;
  for (const alias of ["main", REV]) {
    const prefix = base + alias + "/";
    if (url.href.startsWith(prefix) && modelFiles.has(url.href.slice(prefix.length))) {
      target = base + REV + "/" + url.href.slice(prefix.length);
      break;
    }
  }
  if (!target && runtimeFiles.has(url.href)) target = url.href;
  if (!target) throw new Error("本机语音组件阻止了非模型请求。");
  // Send no request bodies, caller headers or cookies, including when input is a Request.
  return http(target, {method,credentials:"omit",referrerPolicy:"no-referrer",signal:options.signal || input.signal});
};
try {
  const open = self.caches.open.bind(self.caches);
  self.caches.open = name => open("yingyudazi-voice-"+REV+"-"+name);
} catch { /* Private browsing may disable the Cache API. */ }

let engine;
let queue=Promise.resolve();
let notify=()=>{};
let lastPct=-1;
function load() {
  if (!engine) {
    engine=(async()=>{
      notify("正在加载本机语音组件…");
      const {KokoroTTS,env}=await import(PACKAGE);
      // This published Kokoro bundle exposes only wasmPaths. Its bundled ORT
      // selects one thread in a non-cross-origin-isolated worker (including standalone iOS).
      env.wasmPaths = WASM;
      notify("正在准备英语语音模型，首次使用需要下载…");
      return KokoroTTS.from_pretrained(MODEL,{device:"wasm",dtype:"q8",progress_callback(e){
        if(e.status==="progress" && e.file?.endsWith(".onnx") && e.total>0){
          const pct=Math.min(100,Math.floor(100*e.loaded/e.total));
          if(pct!==lastPct){lastPct=pct;notify("正在加载语音模型 "+pct+"%");}
        }
      }});
    })().catch(error=>{engine=undefined;lastPct=-1;throw error;});
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

async function render({id,text,voice}) {
  notify=status=>self.postMessage({id,status});
  try{
    if(!voiceFiles.has(voice) || typeof text!=="string" || !text.trim() || text.length>12000)throw new Error("无效的语音或台词。");
    const tts=await load();
    const chunks=segments(text),parts=[];
    for(let i=0;i<chunks.length;i++){
      notify(chunks.length>1?"正在本机配音 "+(i+1)+" / "+chunks.length:"正在本机配音…");
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
    self.postMessage({id,error:"本机配音未完成。请确认浏览器支持 WebAssembly SIMD，可访问 Hugging Face 和 jsDelivr，并有足够可用内存。"});
  }finally{notify=()=>{};}
}
self.onmessage=event=>{queue=queue.then(()=>render(event.data));};
