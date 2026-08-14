import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const SW_SOURCE = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf-8');

type RequestLike = {
  url: string;
  method?: string;
  mode?: string;
  destination?: string;
  cache?: string;
};

function createHarness() {
  const listeners = new Map<string, Array<(event: any) => void>>();
  const cachesByKey = new Map<string, Map<string, Response>>();
  let fetchImpl: (input: string) => Promise<Response> = async () => {
    throw new Error('fetch not stubbed for this test');
  };

  const urlOf = (input: string | RequestLike) => (typeof input === 'string' ? input : input.url);

  const storage: any = {
    async open(name: string) {
      let entries = cachesByKey.get(name);
      if (!entries) {
        entries = new Map();
        cachesByKey.set(name, entries);
      }
      return {
        match: async (req: string | RequestLike) => entries?.get(urlOf(req)) ?? undefined,
        put: async (req: string | RequestLike, res: Response) => {
          entries?.set(urlOf(req), res);
        },
        delete: async (req: string | RequestLike) => entries?.delete(urlOf(req)) ?? false,
        addAll: async (urls: string[]) => {
          for (const url of urls) {
            const res = await fetchImpl(url);
            if (!res.ok) throw new Error(`addAll failed for ${url}`);
            entries?.set(url, res);
          }
        },
        keys: async () => [...(entries?.keys() ?? [])].map((url) => ({ url })),
      };
    },
    async keys() {
      return [...cachesByKey.keys()];
    },
    async delete(name: string) {
      return cachesByKey.delete(name);
    },
    async match(req: string | RequestLike) {
      for (const entries of cachesByKey.values()) {
        const hit = entries.get(urlOf(req));
        if (hit) return hit;
      }
      return undefined;
    },
  };

  const sandbox: any = {
    self: {
      location: { origin: 'https://app.example.com' },
      registration: { scope: 'https://app.example.com/' },
      addEventListener(type: string, fn: (event: any) => void) {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
      skipWaiting() {},
    },
    caches: storage,
    fetch: (input: string | RequestLike) => fetchImpl(urlOf(input)),
    Response,
    URL,
    console,
  };

  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox, { filename: 'public/sw.js' });

  function dispatchFetch(request: RequestLike) {
    let respondWith: Promise<Response | undefined> | undefined;
    const event = {
      request,
      respondWith(p: Promise<Response | undefined>) {
        respondWith = p;
      },
    };
    for (const fn of listeners.get('fetch') ?? []) fn(event);
    return respondWith;
  }

  async function flush() {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return {
    setFetch(impl: (input: string) => Promise<Response>) {
      fetchImpl = impl;
    },
    seedEntry(cacheName: string, url: string, response: Response) {
      if (!cachesByKey.has(cacheName)) cachesByKey.set(cacheName, new Map());
      cachesByKey.get(cacheName)!.set(url, response);
    },
    entriesFor(cacheName: string, url: string) {
      return cachesByKey.get(cacheName)?.get(url);
    },
    dispatchFetch,
    flush,
    CACHE_NAME: '__CACHE_VERSION__',
  };
}

type Harness = ReturnType<typeof createHarness>;

function jsResponse(body: string) {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/javascript' } });
}

function htmlResponse(body = '<!doctype html><html></html>') {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });
}

describe('service worker (public/sw.js) fetch handling', () => {
  let h: Harness;
  const ASSET_URL = 'https://app.example.com/assets/index-abc123.js';
  const APP_URL = 'https://app.example.com/';

  beforeEach(() => {
    h = createHarness();
  });

  it('caches a JavaScript asset response and serves it from cache later', async () => {
    h.setFetch(async (url) => jsResponse(`/* ${url} */`));

    const first = await h.dispatchFetch({ url: ASSET_URL, method: 'GET', destination: 'script' });
    await h.flush();

    expect(await first?.text()).toContain('assets/index-abc123.js');
    const cached = h.entriesFor(h.CACHE_NAME, ASSET_URL);
    expect(cached).toBeDefined();
    expect(cached?.headers.get('Content-Type')).toContain('javascript');

    const spy = vi.fn(async () => {
      throw new Error('network should not be hit');
    });
    h.setFetch(spy);
    const second = await h.dispatchFetch({ url: ASSET_URL, method: 'GET', destination: 'script' });
    expect(await second?.text()).toContain('assets/index-abc123.js');
    expect(spy).not.toHaveBeenCalled();
  });

  it('never caches an HTML fallback response under an asset URL', async () => {
    h.setFetch(async () => htmlResponse('<!doctype html><title>fallback</title>'));

    const result = await h.dispatchFetch({ url: ASSET_URL, method: 'GET', destination: 'script' });
    await h.flush();

    expect(await result?.text()).toContain('fallback');
    expect(h.entriesFor(h.CACHE_NAME, ASSET_URL)).toBeUndefined();
  });

  it('ignores a poisoned HTML cache entry and refetches from the network, healing the entry', async () => {
    h.seedEntry(h.CACHE_NAME, ASSET_URL, htmlResponse('<!doctype html><title>poison</title>'));
    h.setFetch(async () => jsResponse('/* fresh */'));

    const result = await h.dispatchFetch({ url: ASSET_URL, method: 'GET', destination: 'script' });
    await h.flush();

    expect(await result?.text()).toContain('fresh');
    expect(h.entriesFor(h.CACHE_NAME, ASSET_URL)?.headers.get('Content-Type')).toContain('javascript');
  });

  it('does not serve a poisoned HTML cache entry when the network is down', async () => {
    h.seedEntry(h.CACHE_NAME, ASSET_URL, htmlResponse('<!doctype html><title>poison</title>'));
    h.setFetch(async () => {
      throw new TypeError('network down');
    });

    const result = await h.dispatchFetch({ url: ASSET_URL, method: 'GET', destination: 'script' });
    const res = await result;
    expect(res?.type).toBe('error');
    expect(res?.ok).toBe(false);
  });

  it('settles with an error response instead of rejecting when the network fails for an asset', async () => {
    h.setFetch(async () => {
      throw new TypeError('network down');
    });

    const result = await h.dispatchFetch({ url: ASSET_URL, method: 'GET', destination: 'script' });
    const res = await result;
    expect(res?.type).toBe('error');
    expect(h.entriesFor(h.CACHE_NAME, ASSET_URL)).toBeUndefined();
  });

  it.each([
    ['style', 'app.css', 'text/css'],
    ['image', 'icon.png', 'image/png'],
    ['font', 'font.woff2', 'font/woff2'],
    ['manifest', 'manifest.webmanifest', 'application/manifest+json'],
  ])('caches a %s response whose MIME matches', async (destination, file, contentType) => {
    const url = `https://app.example.com/assets/${file}`;
    h.setFetch(async () => new Response('data', { status: 200, headers: { 'Content-Type': contentType } }));

    await h.dispatchFetch({ url, method: 'GET', destination: destination as string });
    await h.flush();

    expect(h.entriesFor(h.CACHE_NAME, url)).toBeDefined();
  });

  it.each([
    ['style', 'app.css'],
    ['image', 'icon.png'],
    ['font', 'font.woff2'],
    ['manifest', 'manifest.webmanifest'],
  ])('does not cache an HTML fallback under a %s URL', async (destination, file) => {
    const url = `https://app.example.com/assets/${file}`;
    h.setFetch(async () => htmlResponse('<!doctype html>'));

    await h.dispatchFetch({ url, method: 'GET', destination: destination as string });
    await h.flush();

    expect(h.entriesFor(h.CACHE_NAME, url)).toBeUndefined();
  });

  it('caches the app shell on navigation and falls back to it when the network fails', async () => {
    h.setFetch(async () => htmlResponse('<!doctype html><title>shell v1</title>'));

    const first = await h.dispatchFetch({ url: APP_URL, method: 'GET', mode: 'navigate', destination: 'document' });
    await h.flush();
    expect(await first?.text()).toContain('shell v1');
    expect(h.entriesFor(h.CACHE_NAME, APP_URL)).toBeDefined();

    h.setFetch(async () => {
      throw new TypeError('offline');
    });
    const second = await h.dispatchFetch({ url: APP_URL, method: 'GET', mode: 'navigate', destination: 'document' });
    expect(await second?.text()).toContain('shell v1');
  });

  it('bypasses the SW cache for reload/no-store/no-cache requests', async () => {
    h.seedEntry(h.CACHE_NAME, ASSET_URL, jsResponse('/* stale */'));
    h.setFetch(async () => jsResponse('/* fresh */'));

    for (const cacheMode of ['no-store', 'reload', 'no-cache']) {
      const result = await h.dispatchFetch({ url: ASSET_URL, method: 'GET', destination: 'script', cache: cacheMode });
      expect(await result?.text()).toContain('fresh');
    }
  });

  it('does not intercept /api/ requests', async () => {
    const result = h.dispatchFetch({ url: 'https://app.example.com/api/drive/list', method: 'GET' });
    expect(result).toBeUndefined();
  });

  it('does not intercept /auth/ navigations (must hit the network directly for the OAuth redirect chain)', async () => {
    const result = h.dispatchFetch({ url: 'https://app.example.com/auth/login?redirect=%2F', method: 'GET', mode: 'navigate', destination: 'document' });
    expect(result).toBeUndefined();
  });

  it('does not intercept non-GET requests', async () => {
    const result = h.dispatchFetch({ url: ASSET_URL, method: 'POST' });
    expect(result).toBeUndefined();
  });

  it('does not intercept cross-origin requests', async () => {
    const result = h.dispatchFetch({ url: 'https://fonts.example.com/x.js', method: 'GET' });
    expect(result).toBeUndefined();
  });
});
