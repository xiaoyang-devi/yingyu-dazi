// Importing this module never downloads a model or starts a worker.
export const LOCAL_VOICES = Object.freeze([
  "af_heart", "am_michael", "bf_emma", "af_bella", "am_fenrir", "bm_george", "bf_isabella"
]);

let worker;
let nextId = 0, timer;
const pending = new Map();

function stop(error) {
  clearTimeout(timer);
  worker?.terminate();
  worker = undefined;
  for (const job of pending.values()) job.reject(error);
  pending.clear();
}

export function releaseLocalVoice() {
  stop(new DOMException("本机配音已取消","AbortError"));
}

function watch() {
  clearTimeout(timer);
  if (pending.size) {
    timer = setTimeout(() => stop(new Error("本机配音长时间没有响应。请保持页面打开，检查网络或分段重试。")), 180000);
  }
}

function getWorker() {
  if (worker) return worker;
  if (!globalThis.isSecureContext || !globalThis.Worker || !globalThis.WebAssembly) {
    throw new Error("本机配音需要支持 WebAssembly 的新版浏览器，并通过 HTTPS 或本机地址打开。");
  }
  const active = new Worker(new URL("./voice-worker.js",import.meta.url),{type:"module",name:"local-english-voice"});
  worker = active;
  active.addEventListener("message",({data})=>{
    if (worker !== active) return;
    const request = pending.get(data?.id);
    if (!request) return;
    if (typeof data.status === "string") {
      watch();
      try { request.onProgress?.(data.status); } catch { /* Optional UI callback. */ }
      return;
    }
    pending.delete(data.id);
    watch();
    if (data.error || !(data.wav instanceof ArrayBuffer) || data.wav.byteLength <= 44) {
      request.reject(new Error(data.error || "收到的本机录音不完整。"));
    } else {
      request.resolve(new Blob([data.wav],{type:"audio/wav"}));
    }
  });
  active.addEventListener("messageerror",()=>{
    if (worker === active) stop(new Error("浏览器未能接收配音，请重新生成。"));
  });
  active.addEventListener("error",()=>{
    if (worker === active) stop(new Error("本机配音未能启动。请在新版 Safari 或 Chrome 中打开，并检查下载网络。"));
  });
  return active;
}

export async function renderLocalVoice(text,voice,onProgress) {
  if (typeof text !== "string" || !text.trim()) throw new Error("这句缺少英文台词。");
  if (text.length > 12000) throw new Error("这句过长，请先拆成较短的台词。");
  if (!LOCAL_VOICES.includes(voice)) throw new Error("未识别的本机音色。");
  const engine = getWorker(), id = ++nextId;
  return new Promise((resolve,reject)=>{
    pending.set(id,{resolve,reject,onProgress});
    watch();
    try { engine.postMessage({id,text:text.trim(),voice}); }
    catch (error) { pending.delete(id); watch(); reject(error); }
  });
}
