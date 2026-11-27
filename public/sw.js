const CACHE_NAME = '__CACHE_VERSION__'
const PRECACHE_ASSETS = [] // __PRECACHE_ASSETS__

function scopedUrl(path) {
  return new URL(path, self.registration.scope).toString()
}

const APP_SHELL_URL = scopedUrl('./')
const PRIVACY_PAGE_URL = scopedUrl('./privacy.html')
const SHARE_TARGET_URL = scopedUrl('./share-target')
const SHARE_FIELDS = ['title', 'text', 'url']
const MAX_SHARE_BYTES = 64 * 1024
const pendingShares = new Map()
const NAVIGATION_CACHE_KEYS = new Map([
  [APP_SHELL_URL, APP_SHELL_URL],
  [scopedUrl('./index.html'), APP_SHELL_URL],
  [scopedUrl('./privacy'), PRIVACY_PAGE_URL],
  [PRIVACY_PAGE_URL, PRIVACY_PAGE_URL],
])

const APP_SHELL = [
  APP_SHELL_URL,
  scopedUrl('./index.html'),
  scopedUrl('./manifest.webmanifest'),
  scopedUrl('./favicon.svg'),
  scopedUrl('./icon.svg'),
  scopedUrl('./apple-touch-icon.png'),
  scopedUrl('./icon-192.png'),
  PRIVACY_PAGE_URL,
  ...PRECACHE_ASSETS.map(scopedUrl),
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
  if (event.data?.type !== 'linger-take-share' || !event.ports[0]) return
  const share = pendingShares.get(event.data.id)
  share?.finish()
  event.ports[0].postMessage(share?.text ?? null)
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

function shareError(message, status) {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
}

async function readShareForm(request) {
  const origin = request.headers.get('Origin')
  const site = request.headers.get('Sec-Fetch-Site')
  // A browser-created share can have an opaque or missing Origin.
  if ((origin && origin !== 'null' && origin !== self.location.origin) || site === 'cross-site' || site === 'same-site') {
    return shareError('This share request was blocked.', 403)
  }
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/x-www-form-urlencoded' || !request.body) {
    return shareError('The shared content could not be read.', 415)
  }
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let body = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_SHARE_BYTES) {
        await reader.cancel()
        return shareError('The shared content is too large.', 413)
      }
      body += decoder.decode(value, { stream: true })
    }
    return new URLSearchParams(body + decoder.decode())
  } catch {
    return shareError('The shared content could not be read.', 400)
  }
}

async function stageShare(fields) {
  const values = await fields
  if (values instanceof Response) return { response: values }
  const text = SHARE_FIELDS.map(name => values.get(name)?.trim()).filter(Boolean).join('\n')
  if (!text) return { response: Response.redirect(APP_SHELL_URL, 303) }
  if (text.length > MAX_SHARE_BYTES || pendingShares.size >= 8) return { response: shareError('Open Linger and try sharing again.', 503) }

  const id = crypto.randomUUID()
  const consumed = new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer)
      pendingShares.delete(id)
      resolve()
    }
    const timer = setTimeout(finish, 60_000)
    pendingShares.set(id, { text, finish })
  })
  // Switch the navigation to GET. The receipt is single-use and stays in the
  // fragment, so neither it nor the text is sent on the redirected request.
  return { response: Response.redirect(APP_SHELL_URL + '#linger-share=' + id, 303), consumed }
}

self.addEventListener('fetch', event => {
  const { request } = event
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    const shareReceipt = url.hash.startsWith('#linger-share=') && url.hash.slice('#linger-share='.length)
    if (request.method === 'GET' && url.origin + url.pathname === APP_SHELL_URL
        && shareReceipt && pendingShares.has(shareReceipt)) {
      // Form navigations can keep a no-cache request mode after the 303.
      // Use the precached app so a local share also works while offline.
      event.respondWith(caches.open(CACHE_NAME)
        .then(async cache => (await cache.match(APP_SHELL_URL)) ?? fetch(APP_SHELL_URL))
        .catch(() => Response.error()))
      return
    }
    const sharePost = request.method === 'POST' && url.origin + url.pathname === SHARE_TARGET_URL
    const legacyShare = request.method === 'GET' && NAVIGATION_CACHE_KEYS.get(url.origin + url.pathname) === APP_SHELL_URL
      && SHARE_FIELDS.some(name => url.searchParams.has(name))
    if (sharePost || legacyShare) {
      const share = stageShare(sharePost ? readShareForm(request) : url.searchParams)
      event.respondWith(share.then(result => result.response))
      event.waitUntil(share.then(result => result.consumed))
      return
    }
  }
  if (request.method !== 'GET') return

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
    // Shortcuts add query parameters to the same app shell.
    const cacheKey = NAVIGATION_CACHE_KEYS.get(url.origin + url.pathname)
    if (!cacheKey) return

    event.respondWith(
      fetch(request)
        .then(response => {
          const contentType = response.headers.get('Content-Type')?.toLowerCase()
          if (response.ok && !response.redirected && contentType?.startsWith('text/html')) {
            const copy = response.clone()
            event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, copy)).catch(() => {}))
          }
          return response
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME)
          return (await cache.match(cacheKey)) ?? Response.error()
        }),
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
