import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'

const root = fileURLToPath(new URL('.', import.meta.url))

const poolOptions = {
  wrangler: { configPath: `${root}wrangler.jsonc` },
  miniflare: { bindings: { TEST_AUTH_MIGRATIONS: await readD1Migrations(`${root}../../migrations/auth`) } },
}

export default defineConfig({
  root,
  plugins: [cloudflareTest(poolOptions)],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
  },
})
