const CACHE = "bemagic-public-v1";
const STATIC = ["/offline.html", "/icon.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(STATIC)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith("bemagic-public-") && key !== CACHE)
        .map((key) => caches.delete(key)),
    )).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/"))
    return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () =>
      (await caches.match("/offline.html")) ||
      new Response("Sem conexão. Reconecte para cuidar do seu pet.", {
        status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    ));
  } else if (!url.search && STATIC.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
  }
});

self.addEventListener("push", (event) => {
  // Content and destination are deliberately fixed, never trusted from a push payload.
  event.waitUntil(self.registration.showNotification("Seu pet está com saudade!", {
    body: "Visite seu bichinho para cuidar dele.",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: "bemagic-pet-care",
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = new URL("/", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.navigate(destination);
        return client.focus();
      }
    }
    return self.clients.openWindow(destination);
  }));
});
