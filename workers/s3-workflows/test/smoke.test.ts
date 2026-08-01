import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('smoke', () => {
  it('boots the workers runtime with expected bindings', () => {
    expect(env.S3_SYNC_INDEX).toBeDefined()
    expect(env.SESSIONS).toBeDefined()
  })
})
