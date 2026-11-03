// Read only the conversation text. All parsing and ZIP decompression stay in the browser.
const MiB = 1024 * 1024
const MAX_TEXT = 2 * MiB, MAX_ARCHIVE = 256 * MiB, MAX_ITEMS = 5000
const LABEL = /^[·•](.+)$/u
const DATE = /^\d{4}(?:年\d{1,2}月\d{1,2}日|[-/]\d{1,2}[-/]\d{1,2})\s+\d{1,2}:\d{2}(?::\d{2})?$/u
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
    if (!object(item)) fail('合并记录含有无效消息。')
    if (MEDIA_TYPES.has(item.msgtype)) { skip(); continue }
    if (item.msgtype !== 'text' && item.msgtype !== 'merged_msg') fail('记录中含有无法识别的消息类型，请使用文字导出。')
    const payload = typeof item.msg_content === 'string'
      ? parseJSON(item.msg_content, '合并消息内容损坏，请重新导出。') : item.msg_content
    if (!object(payload) || (payload.msgtype != null && payload.msgtype !== item.msgtype)) fail('合并消息正文与标注的类型不一致。')
    if (item.msgtype === 'merged_msg') parseMerged(payload, add, skip, depth + 1)
    else add(item.sender_name, payload.text?.content, false)
  }
}

export function parseText(input) {
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
  if (raw[0] === '{' || raw[0] === '[' && /^\[\s*[\[{"\]]/.test(raw)) {
    parseMerged(parseJSON(raw, '无法解析 JSON，请检查文件是否完整。'), add, skip)
  } else {
    const lines = raw.split('\n')
    const dated = LABEL.test(lines[0].trim())
    let speaker = null, body = []
    function finish() { if (speaker !== null) add(speaker, body.join('\n')) }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i], label = LABEL.exec(line.trim())
      if (dated && label) {
        if (!DATE.test((lines[i + 1] ?? '').trim())) fail('微信导出的发言人后缺少日期时间，请检查原记录。')
        finish(); speaker = label[1].trim(); body = []; i++; continue
      }
      if (!dated && label && DATE.test((lines[i + 1] ?? '').trim())) fail('聊天文字混用了不同格式，请分别导入。')
      const indented = speaker !== null && /^(?:\t| {4})/u.test(line)
      const field = !dated && !indented && !/^\s*(?:[a-z][\w+.-]*:\/\/|\d{1,2}:\d{2}(?:\D|$))/iu.test(line)
        ? /^\s*([^：:\n]{1,128})[：:](.*)$/u.exec(line) : null
      if (field) { finish(); speaker = field[1].trim(); body = [field[2]]; continue }
      if (speaker === null) fail('未找到发言人。请按每行「名字：内容」粘贴，或选择微信导出的聊天记录。')
      body.push(line)
    }
    finish()
  }
  if (!messages.length) fail('记录中没有可朗读的文字消息。')
  return { messages, skipped }
}

function decode(bytes) {
  const [a, b] = bytes
  const encodings = a === 0xff && b === 0xfe ? ['utf-16le'] : a === 0xfe && b === 0xff ? ['utf-16be'] : ['utf-8', 'gb18030']
  for (const encoding of encodings) {
    try { return new TextDecoder(encoding, { fatal: true }).decode(bytes) } catch { /* try next encoding */ }
  }
  fail('无法识别文件编码，请另存为 UTF-8 的 TXT。')
}

const u16 = (v, i) => v.getUint16(i, true)
const u32 = (v, i) => v.getUint32(i, true)
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
const bytesAt = async (file, start, length) => new Uint8Array(await file.slice(start, start + length).arrayBuffer())
const badZip = () => fail('ZIP 结构损坏或不受支持，请解压后选择聊天 TXT。')

async function zipTranscript(file) {
  if (file.size > MAX_ARCHIVE) fail('ZIP 超过 256 MiB，请解压后导入聊天 TXT。')
  const tail = await bytesAt(file, Math.max(0, file.size - 65557), 65557)
  const end = view(tail)
  let i = tail.length - 22
  while (i >= 0 && !(u32(end, i) === 0x06054b50 && i + 22 + u16(end, i + 20) === tail.length)) i--
  if (i < 0 || u16(end,i+4) || u16(end,i+6)) badZip()
  const count = u16(end,i+10), size = u32(end,i+12), offset = u32(end,i+16)
  if (!count || count !== u16(end,i+8) || count > 12000 || size > 8 * MiB || offset + size !== file.size - tail.length + i) badZip()
  const dir = await bytesAt(file, offset, size), d = view(dir), choices = []
  let j = 0
  for (let k = 0; k < count; k++) {
    if (j + 46 > size || u32(d,j) !== 0x02014b50) badZip()
    const chars = u16(d,j+28), next = j + 46 + chars + u16(d,j+30) + u16(d,j+32)
    if (next > size) badZip()
    const nameBytes = dir.subarray(j+46,j+46+chars)
    // ZIPs may contain unrelated legacy-encoded media names. Only inspect TXT entries.
    if (chars >= 4 && String.fromCharCode(...nameBytes.subarray(-4)).toLowerCase() === '.txt') {
      const name = decode(nameBytes).replace(/\\/g,'/'), path = name.split('/'), base = path.at(-1)
      if (!path.some(s => /^(?:__MACOSX|\.\.?|attachments?|media|聊天记录内的图片、视频和文件)$/iu.test(s)) && !base.startsWith('._')) {
        choices.push({ base, nameBytes, flags:u16(d,j+8), method:u16(d,j+10), crc:u32(d,j+16),
          compressed:u32(d,j+20), length:u32(d,j+24), position:u32(d,j+42) })
      }
    }
    j = next
  }
  if (j !== size) badZip()
  const preferred = choices.filter(c => c.base === '聊天记录.txt')
  const selected = preferred.length ? preferred : choices
  if (selected.length !== 1) fail('ZIP 内没有唯一可识别的聊天 TXT，请解压后选择目标文件。')
  const c = selected[0]
  if (c.flags & 1 || ![0,8].includes(c.method)) fail('不支持加密 ZIP 或这种压缩方式，请解压后选择 TXT。')
  if (c.length > MAX_TEXT || c.compressed > MAX_TEXT + 65536) fail('聊天 TXT 超过导入限制，请分段导入。')
  const local = await bytesAt(file,c.position,30)
  if (local.length !== 30) badZip()
  const h = view(local), nameLen = u16(h,26), start = c.position + 30 + nameLen + u16(h,28)
  if (u32(h,0) !== 0x04034b50 || u16(h,6) !== c.flags || u16(h,8) !== c.method || start+c.compressed > offset || nameLen !== c.nameBytes.length) badZip()
  const localName = await bytesAt(file,c.position+30,nameLen)
  if (!localName.every((b,k) => b === c.nameBytes[k])) badZip()
  let stream = file.slice(start,start+c.compressed).stream()
  if (c.method === 8) {
    try { stream = stream.pipeThrough(new DecompressionStream('deflate-raw')) }
    catch { fail('当前浏览器无法解压，请解压后导入聊天 TXT。') }
  }
  const out = new Uint8Array(c.length), reader = stream.getReader()
  let used = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (used+value.length > out.length) { await reader.cancel(); badZip() }
      out.set(value,used); used += value.length
    }
  } catch { badZip() } finally { reader.releaseLock() }
  if (used !== out.length) badZip()
  let crc = -1
  for (const byte of out) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  if ((~crc >>> 0) !== c.crc) badZip()
  return out
}

export async function readChatFile(file) {
  if (!file?.size || typeof file.name !== 'string') fail('请选择非空的 TXT、ZIP 或 JSON 文件。')
  if (/\.zip$/iu.test(file.name)) return parseText(decode(await zipTranscript(file)))
  if (!/\.(?:txt|json)$/iu.test(file.name)) fail('请选择 TXT、ZIP 或微信合并记录 JSON。')
  if (file.size > MAX_TEXT) fail('聊天文件超过 2 MiB，请分段导入。')
  const text = decode(new Uint8Array(await file.arrayBuffer()))
  if (/\.json$/iu.test(file.name) && !text.trimStart().startsWith('{')) fail('JSON 不是可导入的微信合并聊天记录。')
  return parseText(text)
}
