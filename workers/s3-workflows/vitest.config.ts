import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'

import { PRIVACY_WORKER_TEST_FILES } from './vitest.privacy.config'

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
    exclude: process.env.SKIP_PRIVACY_TESTS === '1' ? PRIVACY_WORKER_TEST_FILES : [],
    setupFiles: ['test/setup.ts'],
  },
})
