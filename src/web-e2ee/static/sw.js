// src/web-e2ee/static/sw.js         
// Bump CACHE_NAME when shell assets or transport protocol expectations change.
const CACHE_NAME = "bryti-web-e2ee-shell-v5a";
const ASSETS = ["./", "./app.js", "./idb.js", "./styles.css", "./manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys
      .filter((key) => key !== CACHE_NAME)
      .map((key) => caches.delete(key)))),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
