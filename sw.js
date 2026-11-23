// Caches the game's files so later visits don't re-download ~366 MB.
// The files come from raw.githubusercontent.com pinned to one commit, so they never change;
// GitHub only lets browsers keep them for 5 minutes, which is why they re-downloaded each visit.
// Everything else (index.html, the mod menu, online requests) always goes to the network.
const CACHE = "gd-files-v1";
const GAME_FILES = /^https:\/\/raw\.githubusercontent\.com\/web-ports\/geometry-dash\/[0-9a-f]{40}\//;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("gd-files-") && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || !GAME_FILES.test(req.url) || req.headers.has("range")) return;
  event.respondWith((async () => {
    try {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req.url);
      if (hit) return hit;
      const res = await fetch(req.url, { mode: "cors", credentials: "omit" });
      if (res.ok && res.status === 200) event.waitUntil(cache.put(req.url, res.clone()).catch(() => {}));
      return res;
    } catch (e) {
      return fetch(req);   // never let caching problems stop the game from loading
    }
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "clear") event.waitUntil(caches.delete(CACHE));
});
