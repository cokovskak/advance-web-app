// Pentest Pipeline Dashboard — service worker
// Strategy:
//   - Precache app shell on install
//   - Cache-first for shell, network-first for /data/*.json with cache fallback
//   - Handle push events and a "simulate-push" postMessage so dev/testing works without a server

const VERSION = "v1.1.0";
const SHELL_CACHE = `shell-${VERSION}`;
const DATA_CACHE  = `data-${VERSION}`;

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-maskable.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, DATA_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter(n => !keep.has(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

function isDataRequest(url) {
  return url.pathname.startsWith("/api/") ||
         url.pathname.endsWith(".json") ||
         url.pathname.includes("/data/");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (isDataRequest(url)) {
    event.respondWith(networkFirst(req));
  } else {
    event.respondWith(cacheFirst(req));
  }
});

async function cacheFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok && res.type === "basic") cache.put(req, res.clone());
    return res;
  } catch (_) {
    // Last-resort navigation fallback
    if (req.mode === "navigate") {
      const shell = await cache.match("./index.html");
      if (shell) return shell;
    }
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

async function networkFirst(req) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(req, { cache: "no-store" });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (_) {
    const hit = await cache.match(req);
    if (hit) return hit;
    return new Response(JSON.stringify({ error: "offline" }), {
      status: 503, headers: { "Content-Type": "application/json" }
    });
  }
}

// -------- Push notifications --------

self.addEventListener("push", (event) => {
  let payload = { title: "Pentest update", body: "New event from pipeline" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch (_) {
    if (event.data) payload.body = event.data.text();
  }
  event.waitUntil(showAndNotify(payload));
});

async function showAndNotify(payload) {
  const title = payload.title || "Pentest update";
  const opts = {
    body: payload.body || "",
    icon: "icons/icon.svg",
    badge: "icons/icon.svg",
    tag: payload.tag || "pentest",
    data: { url: payload.url || "./index.html", ...payload },
    requireInteraction: (payload.tag === "critical")
  };
  await self.registration.showNotification(title, opts);
  // Tell any open clients so they can refresh
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const c of clients) c.postMessage({ type: "push-received", payload });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const payload = event.notification.data || {};
  const targetUrl = payload.url || "./index.html";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if ("focus" in c) {
        await c.focus();
        // Tell the page to reload its data now that it's visible.
        c.postMessage({ type: "push-received", payload });
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});

// -------- Page → SW messages (e.g. "simulate-push") --------

self.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "simulate-push") {
    event.waitUntil(showAndNotify(msg.payload || {}));
  }
});
