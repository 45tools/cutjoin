const C="cutjoin-v15";
const FILES=["./","index.html","manifest.json","icon-192.png","icon-512.png","mp4cut.js"];
// 入れるときは必ずサーバーから取り直す（端末に残った古い版を使わない）
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(FILES.map(u=>new Request(u,{cache:"reload"})))));self.skipWaiting();});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()));});
// いつもネット上の最新を確認し、つながらないときだけ保存版を使う
self.addEventListener("fetch",e=>{
  const r=e.request; if(r.method!=="GET"||!r.url.startsWith(self.location.origin)) return;
  e.respondWith(fetch(r,{cache:"no-cache"}).then(res=>{ if(res.ok){ const cp=res.clone(); caches.open(C).then(c=>c.put(r.mode==="navigate"?"index.html":r,cp)); } return res; })
    .catch(()=>caches.match(r).then(m=>m||(r.mode==="navigate"?caches.match("index.html"):undefined))));
});
