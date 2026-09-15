/**
 * Service worker — deliberately does almost nothing.
 *
 * Its only job is to make the archive installable, so that "Add to Home
 * Screen" works and the share sheet can post straight into it (see the
 * share_target in /manifest.webmanifest).
 *
 * It intercepts no fetches and caches nothing: an archive backed by a live
 * Postgres should never serve a stale wall, and a caching layer here would be
 * a source of bugs for no benefit.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Chrome only offers installation to apps whose worker handles `fetch`. This
// listener satisfies that check and hands every request to the network.
self.addEventListener("fetch", () => {});
