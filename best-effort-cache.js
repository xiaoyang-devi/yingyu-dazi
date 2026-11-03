// A stalled CacheStorage operation must not block model loading. The circuit is
// local to one adapter/worker; the next job can use the original cache again.
export function createBestEffortCache({
  name = 'transformers-cache',
  open = cacheName => globalThis.caches.open(cacheName),
  bypassReads = false,
  normalizeHit,
  onBypass,
  openTimeoutMs = 3500,
  readTimeoutMs = 2500,
  writeTimeoutMs = 12000
} = {}) {
  let opening, unavailable = false;
  const waiting = new Set();

  function bypass(reason) {
    if (unavailable) return;
    unavailable = true;
    for (const release of waiting) release();
    try { onBypass?.(reason); } catch { /* A progress callback cannot block the model. */ }
  }
  function bounded(operation, timeout, run, fallback) {
    if (unavailable) return Promise.resolve(fallback);
    return new Promise(resolve => {
      function finish(value) {
        if (!waiting.delete(release)) return;
        clearTimeout(timer);
        resolve(value);
      }
      const release = () => finish(fallback);
      const timer = setTimeout(() => bypass(operation + '-timeout'),timeout);
      waiting.add(release);
      // Native cache operations cannot be aborted. Observe late rejection and
      // leave an in-flight write alone; never delete stored data on timeout.
      Promise.resolve().then(() => unavailable ? fallback : run()).then(finish,() => bypass(operation + '-error'));
    });
  }
  function getCache() {
    if (!opening) opening = bounded('open',openTimeoutMs,() => open(name),undefined);
    return opening;
  }
  async function remove(key, options) {
    if (unavailable) return false;
    const cache = await getCache();
    return cache ? bounded('delete',readTimeoutMs,() => cache.delete(key,options),false) : false;
  }
  return {
    async match(key, options) {
      if (bypassReads || unavailable) return undefined;
      const cache = await getCache();
      if (!cache) return undefined;
      const hit = await bounded('match',readTimeoutMs,() => cache.match(key,options),undefined);
      if (!hit || !normalizeHit) return hit;
      const url = typeof key === 'string' ? key : key.url || String(key);
      try {
        // Only the validator can explicitly evict a proven corrupt entry.
        return normalizeHit(url,hit,() => remove(key,options));
      } catch {
        return undefined;
      }
    },
    async put(key, response) {
      if (unavailable) return;
      const cache = await getCache();
      if (cache) await bounded('put',writeTimeoutMs,() => cache.put(key,response),undefined);
    },
    delete: remove
  };
}
