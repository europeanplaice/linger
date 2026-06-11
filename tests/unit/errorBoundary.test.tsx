import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ErrorBoundary } from '../../src/components/ErrorBoundary'

function ThrowingChild({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('boom')
  return <div>OK</div>
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ErrorBoundary', () => {
  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={false} />
      </ErrorBoundary>,
    )
    expect(screen.getByText('OK')).toBeTruthy()
  })

  it('renders the fallback UI when a child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow />
      </ErrorBoundary>,
    )
    expect(screen.getByText('Something went wrong.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  })

  it('calls console.error with the caught error in this render cycle (not a prior test)', () => {
    // Clear any calls made during beforeEach/other tests before checking
    vi.mocked(console.error).mockClear()

    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow />
      </ErrorBoundary>,
    )
    expect(vi.mocked(console.error)).toHaveBeenCalled()
    const allArgs = vi.mocked(console.error).mock.calls.flat()
    const thrownError = allArgs.find((a): a is Error => a instanceof Error && a.message === 'boom')
    expect(thrownError).toBeInstanceOf(Error)
  })

  it('Reload button calls window.location.reload', () => {
    const reloadMock = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload: reloadMock })

    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow />
      </ErrorBoundary>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reloadMock).toHaveBeenCalledOnce()
  })
})
