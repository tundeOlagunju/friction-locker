/* Friction Vault offline shell. User vault data remains in IndexedDB. */
const CACHE_VERSION = "friction-vault-shell-v1";
const APP_ROOT = new URL("./", self.registration.scope).href;
const CORE_ASSETS = [
  APP_ROOT,
  new URL("manifest.webmanifest", APP_ROOT).href,
  new URL("icon-192.png", APP_ROOT).href,
  new URL("icon-512.png", APP_ROOT).href,
  new URL("icon-512-maskable.png", APP_ROOT).href,
  new URL("apple-touch-icon.png", APP_ROOT).href,
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      Promise.all(
        CORE_ASSETS.map((asset) =>
          cache
            .add(new Request(asset, { cache: "reload" }))
            .catch(() => undefined),
        ),
      ),
    ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith("friction-vault-shell-") && key !== CACHE_VERSION,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "CACHE_SHELL" || !Array.isArray(event.data.urls)) {
    return;
  }

  const urls = [...new Set(event.data.urls)]
    .slice(0, 100)
    .filter((value) => {
      if (typeof value !== "string") return false;
      const url = new URL(value, APP_ROOT);
      return (
        url.origin === self.location.origin &&
        url.pathname.startsWith(new URL(APP_ROOT).pathname)
      );
    });

  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      Promise.all(
        urls.map((url) =>
          cache
            .add(new Request(url, { cache: "reload" }))
            .catch(() => undefined),
        ),
      ),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(CACHE_VERSION);
            await cache.put(request, response.clone());
          }
          return response;
        })
        .catch(async () => {
          const exact = await caches.match(request);
          return exact ?? (await caches.match(APP_ROOT)) ?? Response.error();
        }),
    );
    return;
  }

  const network = fetch(request).then(async (response) => {
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      await cache.put(request, response.clone());
    }
    return response;
  });
  event.waitUntil(network.then(() => undefined).catch(() => undefined));
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }

      return network;
    }),
  );
});
