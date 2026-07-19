// Minimal in-memory stand-in for a Cloudflare KVNamespace, backed by a real Map
// rather than per-call vi.fn() stubs. Used by integration-style tests that chain
// multiple functions/ modules together and need get/put/delete to actually behave
// like a store (a put must be visible to a later get) instead of each call being
// independently scripted.

interface StoredValue {
  value: string
  expirationTtl?: number
}

export interface FakeKV {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
  // Test-only inspection, not part of the real KVNamespace interface.
  has(key: string): boolean
  size(): number
}

export function createFakeKV(seed?: Record<string, string>): FakeKV {
  const store = new Map<string, StoredValue>(
    Object.entries(seed ?? {}).map(([key, value]) => [key, { value }]),
  )

  return {
    async get(key) {
      return store.get(key)?.value ?? null
    },
    async put(key, value, opts) {
      store.set(key, { value, expirationTtl: opts?.expirationTtl })
    },
    async delete(key) {
      store.delete(key)
    },
    has: key => store.has(key),
    size: () => store.size,
  }
}
