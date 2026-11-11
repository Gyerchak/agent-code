// Keeps the app shell available offline (the chat itself always comes live from Agent Code).
const SHELL = ["./", "index.html", "app.js", "style.css", "icon.svg", "manifest.webmanifest"]
self.addEventListener("install", (event) => event.waitUntil(caches.open("occ-shell-v1").then((cache) => cache.addAll(SHELL))))
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url)
  if (url.pathname.includes("/api/")) return
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)))
})
