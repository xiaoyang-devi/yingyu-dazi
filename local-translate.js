// Importing this module performs no requests. Start translateLocally only after the user opts in.
export const LOCAL_TRANSLATION_ESTIMATE_MB = 130
const MAX_UNITS = 200, MAX_UNIT_CHARS = 160
let cancelCurrent
export function cancelLocalTranslation() { cancelCurrent?.() }
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh', {granularity:'sentence'}) : null

function units(text) {
  const result = []
  let prefix = ''
  function keep(part) {
    if (!part.trim()) {
      if (result.length) result[result.length-1] += part
      else prefix += part
      return
    }
    result.push(prefix + part)
    prefix = ''
  }
  // Keep the exact source spans (including indentation and line breaks) in the
  // bilingual card. Only the text passed to the local tokenizer is trimmed.
  for (const para of text.match(/[^\n]*\n|[^\n]+$/gu) || []) {
    const sentences = segmenter ? Array.from(segmenter.segment(para), x => x.segment)
      : para.match(/[^。！？!?]+[。！？!?]*|[。！？!?]+/gu) || []
    for (const sentence of sentences) {
      const chars = Array.from(sentence)
      for (let start = 0; start < chars.length;) {
        let end = Math.min(start + MAX_UNIT_CHARS,chars.length)
        // Prefer a short grammatical boundary in long unpunctuated turns.
        if (end < chars.length) {
          for (let k=end-1; k>=start+Math.floor(MAX_UNIT_CHARS/2); k--) {
            if (/[，、；：,;:\s]/u.test(chars[k])) { end = k+1; break }
          }
        }
        keep(chars.slice(start,end).join(''))
        start = end
      }
    }
  }
  return result
}

export async function translateLocally(messages, onProgress = () => {}) {
  cancelLocalTranslation()
  if (!Array.isArray(messages) || !messages.length) throw new Error('请先导入聊天文字。')
  const cards = []
  for (const message of messages) {
    if (typeof message?.speaker !== 'string' || !message.speaker.trim() || typeof message.text !== 'string' || !message.text.trim()) throw new Error('消息需要有效的发言人和正文。')
    for (const zh of units(message.text)) {
      cards.push({speaker:message.speaker, zh, en:''})
      if (cards.length > MAX_UNITS) throw new Error('本机翻译单次最多 200 句，请分段导入。')
    }
  }
  // Retain numbers, emoji, and already-English messages without an unnecessary download.
  const pending = []
  cards.forEach((card, i) => { if (/\p{Script=Han}/u.test(card.zh)) pending.push(i); else card.en = card.zh.trim() })
  if (!pending.length) return cards
  if (globalThis.isSecureContext === false || typeof Worker !== 'function' || typeof WebAssembly !== 'object') throw new Error('当前浏览器不支持本机翻译。请使用较新版本的 Safari 或 Chrome。')
  onProgress({stage:'load', phase:'prepare', message:'正在打开本机翻译组件…'})
  // Dispose of the inference process at the end, before the voice model needs memory.
  const worker = new Worker(new URL('./mt-worker.js?v=4', import.meta.url), {type:'module',name:'local-translation'})
  let timer, cancel
  try {
    await new Promise((resolve,reject) => {
      cancel = () => reject(new DOMException('已取消本机翻译。','AbortError'))
      cancelCurrent = cancel
      function arm(ms) {
        clearTimeout(timer)
        timer = setTimeout(() => reject(new Error('本机翻译长时间没有响应。请检查模型下载、保持页面打开，或分段重试。')), ms)
      }
      arm(180000)
      worker.onerror = e => { e.preventDefault(); reject(new Error('翻译进程未能运行。请检查网络、浏览器和可用内存。')) }
      worker.onmessageerror = () => reject(new Error('浏览器未能读取本机翻译结果。'))
      let finished = 0
      worker.onmessage = ({data}) => {
        arm(data.type === 'progress' && data.stage === 'load' ? 180000 : 120000)
        if (data.type === 'progress') { try { onProgress(data) } catch (e) { reject(e) } }
        else if (data.type === 'line') {
          if (finished >= pending.length || data.index !== finished || typeof data.en !== 'string' || !data.en.trim()) { reject(new Error('本机翻译返回了不完整的句子。')); return }
          cards[pending[finished++]].en = data.en
        } else if (data.type === 'done') {
          if (finished === pending.length) resolve(); else reject(new Error('本机翻译尚未完成全部句子。'))
        } else if (data.type === 'error') reject(new Error(data.message))
      }
      worker.postMessage({texts:pending.map(i=>cards[i].zh.trim())})
    })
    return cards
  } finally {
    if (cancelCurrent === cancel) cancelCurrent = undefined
    clearTimeout(timer); worker.terminate()
  }
}
