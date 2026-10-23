const C="cutjoin-v4";
const FILES=["./","index.html","manifest.json","icon-192.png","icon-512.png","mp4cut.js"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(FILES)));self.skipWaiting();});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim();});
// HTMLは最新優先（オフライン時はキャッシュ）、それ以外はキャッシュ優先
self.addEventListener("fetch",e=>{
  const r=e.request; if(r.method!=="GET"||!r.url.startsWith(self.location.origin)) return;
  if(r.mode==="navigate"){e.respondWith(fetch(r).then(res=>{caches.open(C).then(c=>c.put("index.html",res.clone()));return res;}).catch(()=>caches.match("index.html")));return;}
  e.respondWith(caches.match(r).then(m=>m||fetch(r)));
});
