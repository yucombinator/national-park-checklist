// Offline app shell. The checklist works with no signal;
// map tiles are cached opportunistically after they have been viewed.

const VERSION = "v4";
const CACHE = `park-checklist-${VERSION}`;
const DATA_CACHE = `park-checklist-data-${VERSION}`;

const SHELL = [
  "./",
  "index.html",
  "css/park.css",
  "js/main.js",
  "js/map.js",
  "js/park-data.js",
  "js/store.js",
  "js/filter.js",
  "manifest.webmanifest",
  "icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(
        SHELL.map((url) => cache.add(url).catch(() => null)),
      ),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE && k !== DATA_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

const isTile = (url) =>
  /tile\.opentopomap\.org|arcgisonline\.com|tile\.openstreetmap\.org/.test(url);

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    // revalidate: GitHub Pages serves assets with a 10-minute cache
    const res = await fetch(request, { cache: "no-cache" });
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    const hit = await cache.match(request, { ignoreSearch: false });
    if (hit) return hit;
    throw new Error("offline");
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request, { cache: "no-cache" });
  if (res && res.ok) cache.put(request, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // map tiles: cache what the user has already looked at
  if (isTile(request.url)) {
    event.respondWith(cacheFirst(request, DATA_CACHE).catch(() => Response.error()));
    return;
  }

  // app data is small: prefer fresh, keep the last copy for offline use
  if (url.origin === self.location.origin && url.pathname.includes("/data/")) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  // everything same-origin plus the Leaflet CDN: prefer fresh, fall back to cache
  event.respondWith(networkFirst(request, CACHE).catch(() => caches.match(request)));
});
