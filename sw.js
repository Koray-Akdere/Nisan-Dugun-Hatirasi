// Service Worker: Arka plan isteklerini canlı tutar
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Arka planda fetch isteklerinin kesintiye uğramasını önler
self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request).catch((err) => {
      return err;
    }),
  );
});
