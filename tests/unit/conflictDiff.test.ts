import { describe, it, expect } from 'vitest'
import { diffConflictLines, mergeConflictTexts } from '../../src/utils/conflictDiff'

describe('diffConflictLines', () => {
  it('marks identical lines as unchanged and differing lines as changed', () => {
    const diff = diffConflictLines('line 1\nlocal 2\nline 3', 'line 1\nremote 2\nline 3')
    expect(diff.localLines).toEqual([
      { text: 'line 1', changed: false },
      { text: 'local 2', changed: true },
      { text: 'line 3', changed: false },
    ])
    expect(diff.remoteLines).toEqual([
      { text: 'line 1', changed: false },
      { text: 'remote 2', changed: true },
      { text: 'line 3', changed: false },
    ])
  })

  it('handles insertions and deletions across different line counts', () => {
    const diff = diffConflictLines('a\nb\nc', 'a\nx\nb\ny\nc')
    expect(diff.localLines).toEqual([
      { text: 'a', changed: false },
      { text: 'b', changed: false },
      { text: 'c', changed: false },
    ])
    expect(diff.remoteLines).toEqual([
      { text: 'a', changed: false },
      { text: 'x', changed: true },
      { text: 'b', changed: false },
      { text: 'y', changed: true },
      { text: 'c', changed: false },
    ])
  })

  it('handles empty strings gracefully', () => {
    expect(diffConflictLines('', 'only remote')).toEqual({
      localLines: [],
      remoteLines: [{ text: 'only remote', changed: true }],
    })
  })
})

describe('mergeConflictTexts', () => {
  it('auto-merges when both devices only appended after the same base', () => {
    const res = mergeConflictTexts(
      'Morning walk.\nEvening coffee.',
      'Morning walk.\nAfternoon rain.',
      'Morning walk.',
    )
    expect(res.kind).toBe('auto-append')
    expect(res.text).toBe('Morning walk.\nAfternoon rain.\nEvening coffee.')
  })

  it('combines both versions with a separator when edits diverge from base', () => {
    const res = mergeConflictTexts(
      'Edited local paragraph',
      'Edited remote paragraph',
      'Original paragraph',
    )
    expect(res.kind).toBe('combined')
    expect(res.text).toBe('Edited remote paragraph\n\n---\n\nEdited local paragraph')
  })

  it('returns the non-empty version when one side is blank', () => {
    expect(mergeConflictTexts('   ', 'remote text', '')).toEqual({
      text: 'remote text',
      kind: 'auto-append',
    })
    expect(mergeConflictTexts('local text', '', '')).toEqual({
      text: 'local text',
      kind: 'auto-append',
    })
  })
})
