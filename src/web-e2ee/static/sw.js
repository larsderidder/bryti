// src/web-e2ee/static/sw.js
// Bump CACHE_NAME when the app shell changes in a way that should replace
// previously cached HTML, JS, CSS, manifest, or other static shell assets.
// Do not cache API responses or chat message content here.
const CACHE_NAME = "bryti-web-e2ee-shell-v6";
const SCOPE_URL = new URL("./", self.registration.scope);
const APP_SHELL_URL = new URL("./", self.registration.scope).toString();
const SHELL_ASSETS = ["./", "./index.html", "./app.js", "./idb.js", "./styles.css", "./manifest.json"]
  .map((asset) => new URL(asset, self.registration.scope).toString());
const SHELL_PATHS = new Set(SHELL_ASSETS.map((asset) => new URL(asset).pathname));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys
      .filter((key) => key !== CACHE_NAME)
      .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (!url.pathname.startsWith(SCOPE_URL.pathname)) {
    return;
  }

  if (url.pathname.startsWith(`${SCOPE_URL.pathname}api/`)) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(caches.match(APP_SHELL_URL).then((cached) => cached || fetch(request)));
    return;
  }

  if (!SHELL_PATHS.has(url.pathname)) {
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
