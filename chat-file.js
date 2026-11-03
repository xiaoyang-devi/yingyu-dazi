// Read the selected file on this device. Only the chosen chat TXT is decompressed.
const MiB = 1024 * 1024
const MAX_TEXT = 2 * MiB
const MAX_ARCHIVE = 256 * MiB
function fail(message) { throw new Error(message) }

function decoded(bytes, encoding) {
  try { return new TextDecoder(encoding, {fatal:true}).decode(bytes) } catch { return null }
}

function decodeText(bytes) {
  const [a, b] = bytes
  const bom = a === 0xff && b === 0xfe ? 'utf-16le' : a === 0xfe && b === 0xff ? 'utf-16be'
    : a === 0xef && b === 0xbb && bytes[2] === 0xbf ? 'utf-8' : null
  const error = '无法识别文件编码，请另存为 UTF-8 的 TXT。'
  if (bom) return decoded(bytes, bom) ?? fail(error)
  const utf8 = decoded(bytes, 'utf-8')
  if (utf8 !== null && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(utf8)) return utf8
  // Without a BOM, infer UTF-16 only from its encoded chat separators.
  if (!(bytes.length % 2)) {
    const scores = [0, 0]
    for (let i = 0; i < Math.min(bytes.length, 8192); i += 2) {
      const x = bytes[i], y = bytes[i+1]
      if ((y === 0 && [9,10,13,58].includes(x)) || (x === 0x1a && y === 0xff)) scores[0]++
      if ((x === 0 && [9,10,13,58].includes(y)) || (x === 0xff && y === 0x1a)) scores[1]++
    }
    if (scores[0] !== scores[1]) {
      const text = decoded(bytes, scores[0] > scores[1] ? 'utf-16le' : 'utf-16be')
      if (text !== null && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(text)) return text
    }
  }
  return decoded(bytes, 'gb18030') ?? fail(error)
}

function textName(bytes, flags) {
  const name = decoded(bytes, 'utf-8') ?? (!(flags & 0x800) ? decoded(bytes, 'gb18030') : null)
  if (!name || /^[a-z]:/iu.test(name) || /[\x00-\x1f]/u.test(name)) return null
  const parts = name.replace(/\\/g, '/').split('/')
  if (parts.some(p => !p || p.startsWith('.') || /^(?:__MACOSX|attachments?|media|聊天记录内的图片、视频和文件)$/iu.test(p))) return null
  return parts[parts.length-1]
}

function inflate(blob, entry) {
  if (typeof DecompressionStream === 'function') {
    try { return blob.stream().pipeThrough(new DecompressionStream('deflate-raw')) }
    catch {
      // RFC 1952 wraps the same raw DEFLATE data with a header and a CRC/length trailer.
      try {
        const trailer = new DataView(new ArrayBuffer(8))
        trailer.setUint32(0, entry.crc, true)
        trailer.setUint32(4, entry.length, true)
        const header = Uint8Array.of(31,139,8,0,0,0,0,0,0,255)
        return new Blob([header, blob, trailer]).stream().pipeThrough(new DecompressionStream('gzip'))
      } catch { /* Older browsers still accept an extracted TXT. */ }
    }
  }
  fail('当前浏览器缺少 ZIP 解压功能。请在「文件」中轻点 ZIP 解压，再导入聊天 TXT。')
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
      const flags=u16(d,j+8), base=textName(nameBytes,flags)
      const mode=u32(d,j+38) >>> 28, unix=dir[j+5] === 3
      if (base && (!unix || mode === 0 || mode === 8) && !(u32(d,j+38) & 16)) {
        choices.push({ base, nameBytes, flags, method:u16(d,j+10), crc:u32(d,j+16),
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
  if (c.flags & (1 | 64 | 8192) || ![0,8].includes(c.method)) fail('不支持加密 ZIP 或这种压缩方式，请解压后选择 TXT。')
  if (c.length > MAX_TEXT || c.compressed > MAX_TEXT + 65536) fail('聊天 TXT 超过导入限制，请分段导入。')
  if (!c.length) fail('ZIP 中的聊天 TXT 是空文件。')
  if (c.method === 0 && c.length !== c.compressed) badZip()
  const local = await bytesAt(file,c.position,30)
  if (local.length !== 30) badZip()
  const h = view(local), nameLen = u16(h,26), start = c.position + 30 + nameLen + u16(h,28)
  if (u32(h,0) !== 0x04034b50 || u16(h,6) !== c.flags || u16(h,8) !== c.method || start+c.compressed > offset || nameLen !== c.nameBytes.length) badZip()
  if (!(c.flags & 8) && (u32(h,14) !== c.crc || u32(h,18) !== c.compressed || u32(h,22) !== c.length)) badZip()
  const localName = await bytesAt(file,c.position+30,nameLen)
  if (!localName.every((b,k) => b === c.nameBytes[k])) badZip()
  const blob = file.slice(start,start+c.compressed)
  const stream = c.method === 8 ? inflate(blob,c) : blob.stream()
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

export async function readChatText(file) {
  if (!file?.size || typeof file.name !== 'string') fail('请选择非空的微信 ZIP 或聊天 TXT。')
  if (/\.zip$/iu.test(file.name)) return decodeText(await zipTranscript(file))
  if (!/\.txt$/iu.test(file.name)) fail('请选择微信导出的 ZIP 或聊天 TXT。')
  if (file.size > MAX_TEXT) fail('聊天 TXT 超过 2 MiB，请分段导入。')
  return decodeText(new Uint8Array(await file.arrayBuffer()))
}
