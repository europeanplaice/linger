import { describe, it, expect } from 'vitest'
import { excerpt } from '../../src/utils/text'

describe('excerpt', () => {
  it('returns short content unchanged', () => {
    expect(excerpt('Hello world')).toBe('Hello world')
  })

  it('joins multiple lines with double-space, dropping blank lines', () => {
    const content = 'First line\n\n  Second line  \n\nThird line'
    expect(excerpt(content)).toBe('First line  Second line  Third line')
  })

  it('truncates content over max chars and appends an ellipsis', () => {
    const content = 'a'.repeat(150)
    const result = excerpt(content)
    expect(result.length).toBe(140)
    expect(result.endsWith('…')).toBe(true)
    expect(result.slice(0, -1)).toBe('a'.repeat(139))
  })

  it('respects a custom max argument', () => {
    const content = 'abcdefghij'
    expect(excerpt(content, 5)).toBe('abcd…')
  })

  it('does not truncate content exactly at max length', () => {
    const content = 'a'.repeat(140)
    expect(excerpt(content)).toBe(content)
  })
})
