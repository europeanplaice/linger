import type { Page } from '@playwright/test'

// Browser-only fixture: production code still performs server-side Siteverify.
export async function installMockTurnstile(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const callbacks = new Map<string, { callback: (token: string) => void; action: string }>()
    let nextId = 0
    const issue = (id: string) => setTimeout(() => {
      const entry = callbacks.get(id)
      if (entry) entry.callback(`test-${entry.action}-token`)
    }, 0)
    window.turnstile = {
      render: (_element, options) => {
        const id = String(++nextId)
        callbacks.set(id, { callback: options.callback as (token: string) => void, action: String(options.action) })
        issue(id)
        return id
      },
      reset: id => issue(id),
      remove: id => { callbacks.delete(id) },
    }
  })
}
