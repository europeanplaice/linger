import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const sharedDefine = {
  __DEPLOY_VERSION__: JSON.stringify('test-version'),
  __DEPLOY_BRANCH__: JSON.stringify('test'),
  __DEPLOY_COMMIT_URL__: JSON.stringify(''),
  __DEPLOY_AUDIT_HISTORY_URL__: JSON.stringify(''),
}

const JSDOM_UNIT_TESTS = [
  'tests/unit/**/*.test.tsx',
  'tests/unit/use*.test.ts',
  'tests/unit/accountSession.test.ts',
  'tests/unit/dataProtection.test.ts',
  'tests/unit/deletionSafety.test.ts',
  'tests/unit/driveEntries-cancellation.test.ts',
  'tests/unit/driveEntries.test.ts',
  'tests/unit/passkeyAccountName.test.ts',
  'tests/unit/passkeys.test.ts',
  'tests/unit/secureLocalData.test.ts',
  'tests/unit/serendipitySeen.test.ts',
  'tests/unit/share.test.ts',
  'tests/unit/storageAdapter.test.ts',
  'tests/unit/syncQueue.test.ts',
  'tests/unit/tabSession.test.ts',
  'tests/unit/tabSync.test.ts',
]

export default defineConfig({
  plugins: [react()],
  define: sharedDefine,
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit-node',
          environment: 'node',
          globals: true,
          include: ['tests/unit/**/*.test.ts'],
          exclude: ['tests/unit/codeSplitting.test.ts', ...JSDOM_UNIT_TESTS],
        },
      },
      {
        extends: true,
        test: {
          name: 'unit-jsdom',
          environment: 'jsdom',
          globals: true,
          include: JSDOM_UNIT_TESTS,
        },
      },
    ],
  },
})
