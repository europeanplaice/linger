import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchBar } from '../../src/components/SearchBar'
import type { SearchResult } from '../../src/hooks/useDiary'
import { I18nProvider } from '../../src/i18n'
import type { ReactNode } from 'react'

// Exit animation timing needs a real browser. Keep these assertions focused on
// search state; let removed results leave the DOM synchronously in jsdom.
vi.mock('motion/react', async importOriginal => ({
  ...await importOriginal<typeof import('motion/react')>(),
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
}))

const empty: SearchResult = { results: [], unindexedCount: 0, totalCount: 0 }
const match: SearchResult = {
  results: [{ date: '2026-04-01', snippet: 'alpha match' }],
  unindexedCount: 0,
  totalCount: 1,
}

function setup(response = empty, entriesLoading = false) {
  const onSearch = vi.fn<(query: string) => Promise<SearchResult>>().mockResolvedValue(response)
  const onSelect = vi.fn()
  const view = (loading: boolean) => (
    <I18nProvider initialLanguage="en">
      <SearchBar entriesLoading={loading} onSearch={onSearch} onSelect={onSelect} />
    </I18nProvider>
  )
  const rendered = render(view(entriesLoading))
  return {
    ...rendered, onSearch, onSelect,
    input: screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search entries...' }),
    setLoading: (loading: boolean) => rendered.rerender(view(loading)),
  }
}

async function advance(ms = 250) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('SearchBar', () => {
  it('shows No results when search returns empty and indexing is complete', async () => {
    const { input } = setup()
    fireEvent.change(input, { target: { value: 'alpha' } })
    await advance()
    expect(screen.getByText('No results')).toBeTruthy()
  })

  it('shows the matching date and highlighted snippet', async () => {
    const { input } = setup(match)
    fireEvent.change(input, { target: { value: 'alpha' } })
    await advance()
    expect(screen.getByText('April 1, 2026')).toBeTruthy()
    expect(screen.getByRole('button').textContent).toContain('alpha match')
    expect(screen.getByText('alpha', { selector: 'mark' })).toBeTruthy()
  })

  it('selecting a result calls onSelect and clears the search UI', async () => {
    const { input, onSelect } = setup(match)
    fireEvent.change(input, { target: { value: 'alpha' } })
    await advance()
    fireEvent.click(screen.getByRole('button'))
    await advance()
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('2026-04-01')
    expect(input.value).toBe('')
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('does not search while entries are loading and resumes once loaded', async () => {
    const { input, onSearch, setLoading } = setup(empty, true)
    fireEvent.change(input, { target: { value: 'alpha' } })
    expect(screen.getByRole('status').textContent).toBe('Loading entries…')
    await advance(400)
    expect(onSearch).not.toHaveBeenCalled()
    setLoading(false)
    await advance()
    expect(onSearch).toHaveBeenCalledExactlyOnceWith('alpha')
  })

  it.each([0, 3])('reports partial results only when unindexedCount is positive (%i)', async unindexedCount => {
    const { input } = setup({ ...match, unindexedCount })
    fireEvent.change(input, { target: { value: 'alpha' } })
    await advance()
    expect(screen.queryByText('3 entries could not be searched.') !== null).toBe(unindexedCount > 0)
  })

  it('shows the total result count', async () => {
    const { input } = setup({
      ...match,
      results: [...match.results, { date: '2026-03-15', snippet: 'alpha two' }],
      totalCount: 2,
    })
    fireEvent.change(input, { target: { value: 'alpha' } })
    await advance()
    expect(screen.getByText('2 results')).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it.each([1, 50])('shows the capped hint only when some results are omitted (%i)', async totalCount => {
    const { input, container } = setup({ ...match, totalCount })
    fireEvent.change(input, { target: { value: 'alpha' } })
    await advance()
    const hint = container.querySelector('.search-result-capped')
    if (totalCount === 50) expect(hint?.textContent).toContain('50')
    else expect(hint).toBeNull()
  })

  it.each([401, 500])('describes the character count and limit state at %i characters', length => {
    const { input } = setup()
    fireEvent.change(input, { target: { value: 'a'.repeat(length) } })
    const description = document.getElementById(input.getAttribute('aria-describedby')!)!
    expect(description.textContent).toContain(`${length}/500`)
    expect(description.classList.contains('search-char-count--limit')).toBe(length === 500)
    expect(input.maxLength).toBe(500)
  })

  it('debounces rapid edits and searches only the final query', async () => {
    const { input, onSearch } = setup()
    fireEvent.change(input, { target: { value: 'a' } })
    await advance(200)
    fireEvent.change(input, { target: { value: 'alpha' } })
    await advance(249)
    expect(onSearch).not.toHaveBeenCalled()
    await advance(1)
    expect(onSearch).toHaveBeenCalledExactlyOnceWith('alpha')
  })

  it('ignores an older response that finishes after a newer search', async () => {
    const { input, onSearch } = setup(match)
    let resolveOld!: (value: SearchResult) => void
    onSearch.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    fireEvent.change(input, { target: { value: 'old' } })
    await advance()
    fireEvent.change(input, { target: { value: 'alpha' } })
    await advance()
    await act(async () => { resolveOld(empty) })
    expect(screen.getByRole('button').textContent).toContain('alpha match')
    expect(screen.queryByText('No results')).toBeNull()
  })
})
