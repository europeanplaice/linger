import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-plugin'

const root = fileURLToPath(new URL('.', import.meta.url))

const poolOptions = {
  wrangler: { configPath: `${root}wrangler.jsonc` },
}

export default defineConfig({
  root,
  plugins: [cloudflareTest(poolOptions)],
  test: {
    include: ['test/**/*.test.ts'],
  },
})
