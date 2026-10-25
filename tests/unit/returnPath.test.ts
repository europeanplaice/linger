import { describe, expect, it } from 'vitest'
import { sanitizeReturnPath } from '../../functions/_shared/returnPath'

const DOMAIN = 'https://example.com'

describe('sanitizeReturnPath', () => {
  it.each([
    undefined,
    null,
    123,
    {},
    '',
    'notes',
    'https://evil.com/',
    '//evil.com/',
    '/\\evil.com/',
    '/\t/evil.com/',
    '/\n/evil.com/',
    '/notes/..//evil.com/',
    '/notes/%2e%2e//evil.com/',
    '/notes/..\\/evil.com/',
  ])('rejects unsafe or invalid return path %j', (value) => {
    expect(sanitizeReturnPath(value, DOMAIN)).toBe('/')
  })

  it.each([
    ['/', '/'],
    ['/notes?date=2026-10-25#entry', '/notes?date=2026-10-25#entry'],
    ['/notes/../today?next=//evil.com#entry', '/today?next=//evil.com#entry'],
    ['/日本語', '/%E6%97%A5%E6%9C%AC%E8%AA%9E'],
    ['/%2f%2fevil.com', '/%2f%2fevil.com'],
  ])('preserves a local destination %s as %s', (value, expected) => {
    const result = sanitizeReturnPath(value, DOMAIN)
    expect(result).toBe(expected)
    expect(new URL(result, DOMAIN).origin).toBe(DOMAIN)
  })
})
