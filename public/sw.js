const CACHE_NAME = '__CACHE_VERSION__'

function scopedUrl(path) {
  return new URL(path, self.registration.scope).toString()
}

const APP_SHELL = [
  scopedUrl('./'),
  scopedUrl('./index.html'),
  scopedUrl('./manifest.webmanifest'),
  scopedUrl('./favicon.svg'),
  scopedUrl('./icon.svg'),
  scopedUrl('./privacy.html'),
]

// Only runtime-cache responses whose MIME type matches what the request is for.
// Cloudflare Pages serves index.html (200, text/html) for any missing path, so
// a stale hashed-asset URL can otherwise come back as HTML — caching or serving
// that under an asset key makes the browser fail with a module-script MIME error.
function contentTypeMatches(request, response) {
  const contentType = (response.headers.get('Content-Type') ?? '').toLowerCase()
  switch (request.destination) {
    case 'script':
      return contentType.includes('javascript') || contentType.includes('wasm')
    case 'style':
      return contentType.includes('css')
    case 'image':
      return contentType.startsWith('image/')
    case 'font':
      return contentType.includes('font')
    case 'manifest':
      return contentType.includes('json')
    default:
      return false
  }
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)),
  )
  // Do NOT call skipWaiting() here — the page controls when to activate via postMessage.
})

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all([
        ...keys.map(key => (key === CACHE_NAME ? undefined : caches.delete(key))),
        caches.open(CACHE_NAME).then(cache =>
          cache.keys().then(requests =>
            Promise.all(
              requests
                .filter(req => new URL(req.url).pathname.startsWith('/api/'))
                .map(req => cache.delete(req)),
            ),
          ),
        ),
      ]),
    ),
  )
  // clients.claim() intentionally omitted — the page reloads itself after SKIP_WAITING,
  // so claiming existing clients is unnecessary and risks serving new assets to old JS.
})

self.addEventListener('fetch', event => {
  const { request } = event

  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  const scopePath = new URL(self.registration.scope).pathname
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith(`${scopePath}api/`)) return
  // OAuth navigations (/auth/login → accounts.google.com → /auth/callback) must hit
  // the network directly. Intercepting them here would make the SW's own fetch()
  // silently follow the whole cross-origin redirect chain (including Google's
  // consent/account screen) and hand back only the final response — the user never
  // sees Google's UI, the address bar never visibly moves, and a real interactive
  // step (e.g. account chooser, re-consent) has no page to render on.
  if (url.pathname.startsWith('/auth/') || url.pathname.startsWith(`${scopePath}auth/`)) return

  if (request.cache === 'no-store' || request.cache === 'reload' || request.cache === 'no-cache') {
    event.respondWith(fetch(request).catch(() => Response.error()))
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone()
          caches.open(CACHE_NAME).then(cache => cache.put(scopedUrl('./'), copy))
          return response
        })
        .catch(() => caches.match(scopedUrl('./'))),
    )
    return
  }

  event.respondWith(
    caches.match(request).then(cached => {
      // Never serve a cache entry whose MIME doesn't match the request
      // destination — a stale entry can be HTML for an asset URL. Skipping it
      // lets the network refetch the real file, which then overwrites the entry.
      if (cached && contentTypeMatches(request, cached)) return cached

      return fetch(request)
        .then(response => {
          if (response.ok && contentTypeMatches(request, response)) {
            const copy = response.clone()
            caches.open(CACHE_NAME).then(cache => cache.put(request, copy))
          }
          return response
        })
        .catch(() => Response.error())
    }),
  )
})
