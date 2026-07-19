// Shared fetch-mocking helper for Playwright specs that exercise `src/api/*`
// client modules directly (no browser page) by stubbing `globalThis.fetch`.

export type FetchCall = { url: string; init?: RequestInit }

export type MockResponse = {
  status: number
  ok: boolean
  headers: Headers
  json: () => Promise<unknown>
  text: () => Promise<string>
}

export function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): MockResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(extraHeaders),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

export function textResponse(body: string, status: number, extraHeaders?: Record<string, string>): MockResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(extraHeaders),
    json: async () => JSON.parse(body),
    text: async () => body,
  }
}

export class FetchMock {
  calls: FetchCall[] = []
  private readonly originalFetch = globalThis.fetch
  private responses: MockResponse[] = []

  /** Queue responses (returned in order) and install the fetch stub. */
  mock(...nextResponses: MockResponse[]): void {
    this.responses = [...nextResponses]
    this.calls = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      this.calls.push({ url: String(input), init })
      const response = this.responses.shift()
      if (!response) throw new Error(`Unexpected fetch: ${String(input)}`)
      return response as unknown as Response
    }) as typeof fetch
  }

  /** Clear recorded calls/queued responses without touching the installed stub. */
  reset(): void {
    this.calls = []
    this.responses = []
  }

  /** Restore the real global fetch; call from `test.afterEach`. */
  restore(): void {
    globalThis.fetch = this.originalFetch
  }
}
