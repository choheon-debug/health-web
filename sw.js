// 앱 파일을 휴대폰에 저장해 두어 인터넷이 잠깐 끊겨도 열리게 한다.
// 앱을 고칠 때마다 VERSION을 올려야 새 버전이 퍼진다.
const VERSION = "health-web-8";
const ASSETS = ["./", "./index.html", "./manifest.webmanifest", 
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// 화면(HTML)은 인터넷에서 새로 받아 오고(고친 내용이 바로 보이게), 안 되면 저장해 둔 것을 쓴다.
// 아이콘 같은 나머지 파일은 저장해 둔 것으로 바로 열고, 뒤에서 새 파일을 받아 둔다.
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  if (req.mode === "navigate") {
    e.respondWith(caches.open(VERSION).then(cache =>
      fetch(req, { cache: "no-store" }).then(res => {
        if (res.ok) cache.put("./index.html", res.clone());
        return res;
      }).catch(() => cache.match("./index.html"))));
    return;
  }
  e.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req).then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
