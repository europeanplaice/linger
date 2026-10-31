import type { D1Migration } from 'cloudflare:test'
import { beforeAll } from 'vitest'

// Load bindings after the test module has installed its Drive/S3 mocks. Loading
// the Worker entrypoint in setupFiles would cache the real external clients.
beforeAll(async () => {
  const { applyD1Migrations, env } = await import('cloudflare:test')
  await applyD1Migrations(env.AUTH_DB, (env as unknown as { TEST_AUTH_MIGRATIONS: D1Migration[] }).TEST_AUTH_MIGRATIONS)
})
