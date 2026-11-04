// Pasted text stays in the page; this module does no I/O.
const MAX_TEXT = 2*1024*1024, MAX_ITEMS = 5000
const LABEL = /^[·•](.+)$/u
const DAY = /\d{4}(?:年\d{1,2}月\d{1,2}日|[-/]\d{1,2}[-/]\d{1,2})/u.source
const TIME = /(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?/u.source
const DATE = new RegExp('^'+DAY+'\\s+'+TIME+'$','u')
const BARE_TIME = new RegExp('^(?:'+DAY+'\\s+)?'+TIME+'$','u')
const STAMPED = new RegExp('^(.{1,128}?)\\s+(?:'+DAY+'\\s+)?'+TIME+'$','u')
const URL_OR_CLOCK = /^(?:[a-z][\w+.-]*:\/\/|(?:mailto|tel|file|data|blob|sms|urn|about):|\/\/|www\.|(?:[\w-]+\.)+[a-z]{2,}(?:[:/]|$)|\d{1,2}:\d{2}(?:\D|$))/iu
const MEDIA = /^\[(?:图片|视频|文件|动画表情|表情包|语音|语音通话|视频通话|位置|名片|小程序|链接)\](?:[ \t][^\n]*)?$/u
const MEDIA_TYPES = new Set(['image', 'voice', 'video', 'file', 'location', 'link', 'business_card', 'miniprogram', 'emoji', 'channels_shop_product', 'channels_shop_order', 'finder'])
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
function fail(message) { throw new Error(message) }

function parseJSON(raw, error) {
  try { return JSON.parse(raw) } catch { fail(error) }
}

function parseMerged(value, add, skip, depth = 0) {
  if (depth > 5) fail('合并聊天记录嵌套层数过多。')
  if (!object(value) || (value.msgtype != null && value.msgtype !== 'merged_msg')) fail('JSON 不是可导入的微信合并聊天记录。')
  const record = value.merged_msg ?? value
  if (!Array.isArray(record?.item) || !record.item.length) fail('合并记录缺少消息列表 item。')
  for (const item of record.item) {
    if (!object(item)) fail('合并记录含有无效消息，请改为粘贴带昵称的文字。')
    if (MEDIA_TYPES.has(item.msgtype)) { skip(); continue }
    if (item.msgtype !== 'text' && item.msgtype !== 'merged_msg') fail('有无法识别的消息类型，请粘贴需要的文字并保留昵称。')
    const payload = typeof item.msg_content === 'string'
      ? parseJSON(item.msg_content, '合并消息内容不完整，请粘贴带昵称的文字。') : item.msg_content
    if (!object(payload) || (payload.msgtype != null && payload.msgtype !== item.msgtype)) fail('合并消息正文与标注的类型不一致。')
    if (item.msgtype === 'merged_msg') parseMerged(payload, add, skip, depth + 1)
    else add(item.sender_name, payload.text?.content, false)
  }
}

// Choose a source format from the first named record. In timestamped mode, only
// that format starts a new turn, so URLs and colons in the body stay ordinary text.
function readNamedLines(raw, add) {
  const lines = raw.split('\n')
  const missing = () => fail('有消息缺少可确认的昵称。请把每条整理为「昵称：内容」后再粘贴。')
  function field(line) {
    const trimmed = line.trim()
    if (URL_OR_CLOCK.test(trimmed) || BARE_TIME.test(trimmed)) return null
    const match = /^\s*([^：:\n]{1,128})[：:](?!\/\/)(.*)$/u.exec(line)
    // A clock embedded in a sentence is body text, even when it starts with words.
    if (match && /\d{1,2}$/u.test(match[1]) && /^[0-5]\d(?:\D|$)/u.test(match[2])) return null
    return match
  }
  function header(i) {
    const line = lines[i].trim()
    if (!line || BARE_TIME.test(line) || URL_OR_CLOCK.test(line)) return null
    const marked = LABEL.exec(line)
    const stamped = STAMPED.exec(line)
    if (!marked && stamped && !/[：:]/u.test(stamped[1])) {
      return {mode:'inline',name:stamped[1].trim(),until:i}
    }
    if (!marked && /[：:]/u.test(line)) return null
    let j = i+1
    while (j<lines.length && !lines[j].trim()) j++
    if (!DATE.test(lines[j]?.trim() || '')) return null
    return {mode:marked?'marked':'stacked',name:marked?marked[1].trim():line,until:j}
  }
  const firstHeader = header(0)
  if (lines.length === 1 && firstHeader?.mode === 'inline') return false
  if (!firstHeader && !field(lines[0])) {
    // Recognizable export headers still report incomplete or misplaced records.
    if ((DATE.test(lines[0]) && lines.length > 1) || lines.some((_,i) => header(i))) missing()
    return false
  }
  const mode = firstHeader?.mode || 'colon'
  let speaker = null, body = []
  function finish() { if (speaker !== null) add(speaker,body.join('\n')) }
  for (let i=0;i<lines.length;i++) {
    const line=lines[i], trimmed=line.trim()
    const indented = speaker !== null && /^(?:\t| {4})/u.test(line)
    const native=mode==='colon' && indented ? null : header(i)
    if (native) {
      if (mode !== native.mode) fail('聊天混用了几种排版，请按「昵称：内容」分别整理后粘贴。')
      if (!native.name || URL_OR_CLOCK.test(native.name) || BARE_TIME.test(native.name)) missing()
      finish(); speaker=native.name; body=[]; i=native.until; continue
    }
    if (mode==='marked' && LABEL.test(trimmed)) fail('昵称下面缺少完整日期和时间，请核对原文。')
    const named = mode==='colon' && !indented ? field(line) : null
    if (named) { finish(); speaker=named[1].trim(); body=[named[2]]; continue }
    if (speaker===null || (mode!=='colon' && BARE_TIME.test(trimmed))) missing()
    body.push(line)
  }
  finish()
  return true
}

export function parseText(input,{singleMessage = false} = {}) {
  if (typeof input !== 'string') fail('请提供聊天文字。')
  if (input.length > MAX_TEXT || new TextEncoder().encode(input).length > MAX_TEXT) fail('聊天文字超过 2 MiB，请分段导入。')
  const raw = input.replace(/^\uFEFF/u, '').replace(/\r\n?/g, '\n').trim()
  if (!raw || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(raw)) fail('没有可识别的聊天文字，请检查文本编码。')
  const messages = []
  let skipped = 0
  const count = () => { if (messages.length + skipped >= MAX_ITEMS) fail('单次最多导入 5000 条消息，请分段导入。') }
  const skip = () => { count(); skipped++ }
  function add(who, body, detectMedia = true) {
    if (typeof who !== 'string' || !who.trim() || who.trim().length > 128 || /[\r\n\u0000-\u001F]/u.test(who)) fail('有消息缺少有效的发言人姓名，请核对原文。')
    if (typeof body !== 'string' || !body.trim() || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(body)) fail('有消息缺少正文，请核对原文。')
    const text = body.trim()
    if (detectMedia && MEDIA.test(text)) { skip(); return }
    count()
    messages.push({ speaker: who.trim(), text })
  }
  let plain = singleMessage
  if (singleMessage) {
    add('朗读',raw)
  } else if (raw[0] === '{' || raw[0] === '[' && /^\[\s*[\[{"\]]/.test(raw)) {
    parseMerged(parseJSON(raw, '无法解析 JSON，请检查文件是否完整。'), add, skip)
  } else if (!readNamedLines(raw,add)) {
    add('朗读',raw)
    plain = true
  }
  if (!messages.length) fail('记录中没有可朗读的文字消息。')
  return plain ? {messages,skipped,singleMessage:true} : {messages,skipped}
}
