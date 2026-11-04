// Only these published resources are needed to reopen the studio, a local card or the example.
const scope = new URL(self.registration.scope);
const prefix = 'yingyu-dazi-app-shell:' + scope.pathname + ':';
const cacheName = prefix + '16';
const files = [
  'index.html', 'app.js?v=16', 'style.css?v=14', 'cloud-panel.js?v=16', 'cloud-voice.js?v=16', 'backup-voice.js?v=16', 'secondary-voice.js?v=16', 'online-translate.js?v=13', 'backup-translate.js?v=13', 'library-view.js?v=16', 'library.js?v=16',
  'intake.js?v=14', 'local-translate.js?v=8', 'local-voice.js?v=7', 'native-speech.js',
  'chat-file.js', 'export-card.js', 'offline-player.txt', 'app.webmanifest',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'demo/manifest.json', 'demo/CREDITS.txt', 'assets/NOTICE.html',
  ...Array.from({length:6}, (_, i) => 'demo/0' + (i+1) + '.mp3')
];
const urls = new Set(files.map(file => new URL(file,scope).href));
const indexURL = new URL('index.html',scope).href;

function bounded(promise,ms) {
  let timer;
  const timeout = new Promise((_,reject) => {
    timer = setTimeout(() => reject(Error('Offline storage timed out')),ms);
  });
  return Promise.race([promise,timeout]).finally(() => clearTimeout(timer));
}
self.addEventListener('install',event => {
  event.waitUntil((async () => {
    const cache = await bounded(caches.open(cacheName),4000);
    await bounded(cache.addAll([...urls].map(url => new Request(url,{cache:'reload'}))),60000);
  })());
});
self.addEventListener('activate',event => {
  event.waitUntil((async () => {
    await self.clients.claim();
    try {
      const names = await bounded(caches.keys(),1500);
      await bounded(Promise.all(names.filter(n => n.startsWith(prefix) && n !== cacheName).map(n => caches.delete(n))),3000);
    } catch { /* Unavailable storage must not prevent online navigation. */ }
  })());
});

async function stored(url) {
  try { return await bounded(caches.match(url,{cacheName}),1000); }
  catch { return undefined; }
}
async function documentResponse(request) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(),7000);
  try {
    const response = await fetch(request,{signal:abort.signal});
    if (response.ok) return response;
    return await stored(indexURL) || response;
  } catch (error) {
    const fallback = await stored(indexURL);
    if (fallback) return fallback;
    throw error;
  } finally { clearTimeout(timer); }
}
async function assetResponse(request) {
  const response = await stored(request.url);
  if (!response) return fetch(request);
  const range = request.headers.get('range');
  if (!range) return response;
  // Safari commonly reads the first two bytes of an MP3 before requesting the rest.
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
  if (!match || (!match[1] && !match[2])) return fetch(request);
  const blob = await response.blob();
  const length = blob.size;
  const start = match[1] ? Number(match[1]) : Math.max(0,length-Number(match[2]));
  const end = match[1] && match[2] ? Math.min(length-1,Number(match[2])) : length-1;
  if (start > end || start >= length) {
    return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+length}});
  }
  return new Response(blob.slice(start,end+1),{status:206,headers:{
    'Content-Type':response.headers.get('Content-Type') || 'audio/mpeg',
    'Content-Length':String(end-start+1),'Content-Range':'bytes '+start+'-'+end+'/'+length,'Accept-Ranges':'bytes'
  }});
}
self.addEventListener('fetch',event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin) return;
  if (request.mode === 'navigate' && (url.pathname === scope.pathname || url.pathname === new URL(indexURL).pathname)) {
    event.respondWith(documentResponse(request));
  } else if (urls.has(url.href)) {
    event.respondWith(assetResponse(request));
  }
});
