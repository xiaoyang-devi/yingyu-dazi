// In both pinned Transformers.js bundles, cached responses also fire "download", and
// a missing Content-Length can make their reported "total" grow one chunk at a time.
// Count actual bytes read per model file; use sizes from the immutable model revision.
export function modelFileProgress(sizes, label, emit) {
  const fetched = new Set(), loaded = new Map(), done = new Set()
  const expected = Object.entries(sizes)
  const allBytes = expected.reduce((sum, [, size]) => sum + size, 0)
  let knownTotal = expected.every(([, size]) => Number.isSafeInteger(size) && size >= 0)
  let last = -Infinity, reportedReady = false
  const owns = file => Object.hasOwn(sizes, file)
  function prepare(message) { emit({stage:'load', phase:'prepare', message}) }
  return {
    request(file) { if (owns(file)) fetched.add(file) },
    prepare,
    observe({status, file, loaded: bytes}) {
      if (reportedReady || !owns(file) || (status !== 'progress' && status !== 'done')) return
      if (status === 'progress' && Number.isSafeInteger(bytes) && bytes >= 0) {
        loaded.set(file, Math.max(bytes, loaded.get(file) || 0))
        if (bytes > sizes[file]) knownTotal = false
      }
      if (status === 'done') {
        done.add(file)
        // A completed file of a pinned, known size can be served without chunk events.
        if (!loaded.has(file) && Number.isSafeInteger(sizes[file])) loaded.set(file, sizes[file])
      }
      const now = Date.now()
      if (status !== 'done' && now - last < 170) return
      last = now
      let read = 0, cachedBytes = 0
      for (const [name, amount] of loaded) {
        read += amount
        if (!fetched.has(name)) cachedBytes += amount
      }
      if (read > 0) {
        const cached = fetched.size === 0
        const detail = {stage:'load', phase:cached?'cache':'download', unit:'bytes', loaded:read, cachedBytes, cached,
          message:cached ? '正在从本机缓存读取'+label+'模型文件' : '正在读取'+label+'模型文件'}
        if (knownTotal && Number.isSafeInteger(allBytes) && allBytes > 0) {
          detail.total = allBytes
          detail.percent = Math.floor(100 * read / allBytes)
        }
        emit(detail)
      }
      if (!reportedReady && done.size === expected.length) {
        reportedReady = true
        prepare(label+'模型文件已就绪，正在初始化本机引擎…')
      }
    }
  }
}
