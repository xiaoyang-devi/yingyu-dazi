// No storage is opened on import. Only savePracticeCard writes a reviewed listening card.
const DATABASE = 'yingyu-dazi-practice:' + new URL('.', import.meta.url).pathname
const RECORDS = 'cards', HEADERS = 'summaries'
const ids = new WeakMap(), saving = new WeakMap()
const maxBytes = 128 * 1024 * 1024
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)
const validText = (text,max) => typeof text === 'string' && text.trim().length > 0 && text.length <= max
const unavailable = () => Error('这张练习卡的数据不完整或版本不兼容。可以从库中删除它。')
const missing = () => Error('这张练习卡已删除，或浏览器已清理本机数据。请刷新练习库。')

class LibraryStorageError extends Error {}
function storageError(error) {
  if (error instanceof LibraryStorageError) return error
  if (error?.name === 'QuotaExceededError') return new LibraryStorageError('本机存储空间不足。请删除不再需要的练习卡或释放设备空间后重试。')
  if (error?.name === 'VersionError') return new LibraryStorageError('练习库由更新版本的网页创建。请刷新网页后再打开。')
  if (error?.name === 'SecurityError' || error?.name === 'InvalidStateError') return new LibraryStorageError('此浏览环境未开放本机练习库。请在普通 Safari 或 Chrome 页面中重试。')
  return new LibraryStorageError('本机练习库暂时不可用。请刷新后重试，并检查浏览器是否允许存储及设备可用空间。')
}

let connection
function openDatabase() {
  return new Promise((resolve,reject) => {
    let request
    try {
      if (!globalThis.indexedDB) throw new DOMException('Storage unavailable','SecurityError')
      request = indexedDB.open(DATABASE,1)
    } catch (e) { reject(storageError(e)); return }
    let stopped = false
    const stop = error => { stopped = true; clearTimeout(timer); reject(error) }
    const timer = setTimeout(() => stop(new LibraryStorageError('打开本机练习库超时。请关闭其他同站页面后重试。')),10000)
    request.onblocked = () => stop(new LibraryStorageError('其他同站页面正在使用旧版练习库。请关闭它们后重试。'))
    request.onerror = () => stop(storageError(request.error))
    request.onupgradeneeded = () => {
      if (stopped) { request.transaction.abort(); return }
      const db=request.result
      db.createObjectStore(HEADERS,{keyPath:'id'})
      db.createObjectStore(RECORDS,{keyPath:'id'})
    }
    request.onsuccess = () => {
      clearTimeout(timer)
      const db = request.result
      if (stopped) { db.close(); return }
      db.onversionchange = () => { connection = undefined; db.close() }
      db.onclose = () => { connection = undefined }
      resolve(db)
    }
  })
}

function connect() {
  if (!connection) connection = openDatabase().catch(error => { connection=undefined; throw error })
  return connection
}

// The queue function issues requests synchronously in the active transaction.
// Resolve only on commit, so quota errors and interrupted writes cannot leave half a card.
async function transaction(stores,mode,queue) {
  const db = await connect()
  return new Promise((resolve,reject) => {
    const tx = db.transaction(stores,mode)
    let result, cause
    const abort = error => { cause=error; tx.abort() }
    tx.onerror = event => { cause ||= event.target?.error }
    tx.onabort = () => reject(cause || tx.error || Error('Transaction aborted'))
    tx.oncomplete = () => {
      try { resolve(result?.()) } catch (e) { reject(e) }
    }
    try { result = queue(tx,abort) } catch (e) { abort(e) }
  })
}

function summary(row) {
  if (!validId(row?.id)) return null
  if (row.version !== 1 || !validText(row.title,512) || typeof row.native !== 'boolean' ||
      !Number.isSafeInteger(row.lineCount) || row.lineCount < 1 || row.lineCount > 200 ||
      !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 ||
      !Number.isSafeInteger(row.bytes) || row.bytes < 0) {
    return {id:row.id,title:'无法读取的练习卡',native:false,lineCount:0,createdAt:0,bytes:0,position:0,unavailable:true}
  }
  const {id,title,native,lineCount,createdAt,bytes} = row
  const position=Number.isInteger(row.position) && row.position>=0 && row.position<lineCount ? row.position : 0
  return {id,title,native,lineCount,createdAt,bytes,position}
}

async function validWave(blob) {
  if (!(blob instanceof Blob) || blob.size <= 44 || blob.size > maxBytes || (blob.size-44)%2) throw unavailable()
  const head = await blob.slice(0,44).arrayBuffer()
  if (head.byteLength !== 44) throw unavailable()
  const v=new DataView(head)
  if (v.getUint32(0)!==0x52494646 || v.getUint32(8)!==0x57415645 || v.getUint32(12)!==0x666d7420 ||
      v.getUint32(36)!==0x64617461 || v.getUint32(4,true)!==blob.size-8 || v.getUint32(16,true)!==16 ||
      v.getUint16(20,true)!==1 || v.getUint16(22,true)!==1 || v.getUint32(24,true)!==24000 ||
      v.getUint32(28,true)!==48000 || v.getUint16(32,true)!==2 || v.getUint16(34,true)!==16 ||
      v.getUint32(40,true)!==blob.size-44) throw unavailable()
  return blob
}

async function packed(card) {
  if (!card || card.demo || !validText(card.title,512) || !Array.isArray(card.lines) ||
      !card.lines.length || card.lines.length > 200) throw unavailable()
  const native = card.native === true, lines = [], names = new Set()
  let bytes = 0
  for (const line of card.lines) {
    if (!validText(line?.speaker,128) || !validText(line.zh,12000) || !validText(line.en,12000)) throw unavailable()
    const item={speaker:line.speaker,zh:line.zh,en:line.en}
    if (card.cloud && line.voiceProvider === 'huggingface') item.voiceProvider='huggingface'
    if (!native) {
      item.blob = await validWave(line.blob)
      bytes += item.blob.size
      if (bytes > maxBytes) throw Error('这张卡的录音超过 128 MiB，请缩短制作范围后分开保存。')
    }
    names.add(line.speaker)
    lines.push(item)
  }
  const voices=[]
  // Earlier cloud recordings have no saved voice identities. They remain playable.
  if (native || card.cloud && card.voices?.size) {
    if (!(card.voices instanceof Map)) throw unavailable()
    for (const name of names) {
      const key=card.voices.get(name)
      if (!validText(key,4096)) throw unavailable()
      voices.push([name,key])
    }
  }
  return {version:1,title:card.title,native,online:native && card.online === true,cloud:!native && card.cloud === true,lines,voices,bytes}
}

async function writeRecord(record,header) {
  return transaction([HEADERS,RECORDS],'readwrite',(tx,abort) => {
    const store=tx.objectStore(HEADERS), lookup=store.get(record.id)
    lookup.onsuccess=() => {
      if (lookup.result !== undefined) return // Repeated taps or a concurrent save of this card.
      try {
        store.add(header)
        tx.objectStore(RECORDS).add(record)
      } catch (e) { abort(e) }
    }
    return () => summary(lookup.result ?? header)
  })
}

export function savePracticeCard(card) {
  if (!card || typeof card!=='object') return Promise.reject(unavailable())
  if (saving.has(card)) return saving.get(card)
  const writing=saveOnce(card).finally(() => saving.delete(card))
  saving.set(card,writing)
  return writing
}

async function saveOnce(card) {
  const record=await packed(card)
  let id=validId(card.libraryId) ? card.libraryId : ids.get(card)
  if (!id) {
    const random=crypto.getRandomValues(new Uint8Array(16))
    id=Array.from(random,x=>x.toString(16).padStart(2,'0')).join('')
    ids.set(card,id)
  }
  record.id=id
  const header={id,version:1,title:record.title,native:record.native,lineCount:record.lines.length,createdAt:Date.now(),bytes:record.bytes,position:0}
  let saved
  try {
    // WebKit can stall on a Blob write while another transaction is pending.
    // Store each clip as bytes and reconstruct the lossless WAV Blob only on review.
    if (!record.native) {
      for (const line of record.lines) line.blob=await line.blob.arrayBuffer()
    }
    saved=await writeRecord(record,header)
  } catch (e) { throw storageError(e) }
  if (!saved || saved.unavailable) throw unavailable()
  return saved
}

export async function listPracticeCards() {
  let rows
  try { rows=await transaction([HEADERS],'readonly',tx => {
    const req=tx.objectStore(HEADERS).getAll()
    return () => req.result
  }) } catch (e) { throw storageError(e) }
  return rows.map(summary).filter(Boolean).sort((a,b)=>b.createdAt-a.createdAt || a.id.localeCompare(b.id))
}

export async function loadPracticeCard(id) {
  if (!validId(id)) throw missing()
  let record, header
  try { [record,header]=await transaction([HEADERS,RECORDS],'readonly',tx => {
    const body=tx.objectStore(RECORDS).get(id), meta=tx.objectStore(HEADERS).get(id)
    return () => [body.result,summary(meta.result)]
  }) } catch (e) { throw storageError(e) }
  if (!record && !header) throw missing()
  if (!record || !header || header.unavailable || header.lineCount!==record.lines?.length || header.native!==record.native || header.title!==record.title) throw unavailable()
  if (record.version!==1 || record.id!==id || typeof record.native!=='boolean' ||
      !Array.isArray(record.voices) || record.voices.length>200 || !Array.isArray(record.lines) ||
      !record.lines.length || record.lines.length>200) throw unavailable()
  try {
    const voices=new Map(record.voices)
    let bytes=0
    const lines=record.lines.map(line => {
      if (record.native || !(line?.blob instanceof ArrayBuffer)) return line
      bytes+=line.blob.byteLength
      if (bytes>maxBytes) throw unavailable()
      return {...line,blob:new Blob([line.blob],{type:'audio/wav'})}
    })
    const valid=await packed({...record,lines,voices})
    if (valid.bytes!==header.bytes) throw unavailable()
    return {title:valid.title,native:valid.native,online:valid.online,cloud:valid.cloud,lines:valid.lines,voices:new Map(valid.voices),demo:false,libraryId:id,resumeIndex:header.position}
  } catch { throw unavailable() }
}

// Zero-based line position on an already-saved card. No audio is read or rewritten.
export async function updatePracticePosition(id,index) {
  if (!validId(id)) throw missing()
  if (!Number.isInteger(index) || index < 0) throw Error('跟读位置无效。')
  let saved
  try { saved=await transaction([HEADERS],'readwrite',(tx,abort) => {
    const store=tx.objectStore(HEADERS), request=store.get(id)
    let head
    request.onsuccess=() => {
      head=summary(request.result)
      if (!head || head.unavailable || index>=head.lineCount || index===head.position) return
      try { store.put({...request.result,position:index}); head.position=index }
      catch (e) { abort(e) }
    }
    return () => head
  }) } catch (e) { throw storageError(e) }
  if (!saved) throw missing()
  if (saved.unavailable) throw unavailable()
  if (index>=saved.lineCount) throw Error('跟读位置超出这张卡的范围。')
  return saved
}

export async function deletePracticeCard(id) {
  if (!validId(id)) throw missing()
  try { await transaction([HEADERS,RECORDS],'readwrite',tx => {
    tx.objectStore(HEADERS).delete(id)
    tx.objectStore(RECORDS).delete(id)
  }) } catch (e) { throw storageError(e) }
}
