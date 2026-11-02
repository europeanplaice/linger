import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    __DEPLOY_VERSION__: JSON.stringify('test-version'),
    __DEPLOY_BRANCH__: JSON.stringify('test'),
    __DEPLOY_COMMIT_URL__: JSON.stringify(''),
    __DEPLOY_AUDIT_HISTORY_URL__: JSON.stringify(''),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/unit/**/*.test.{ts,tsx}'],
  },
})
