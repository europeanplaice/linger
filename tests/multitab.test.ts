import { expect, test, type BrowserContext } from '@playwright/test'
import { baseUrl } from './baseUrl'

const date = '2026-05-01'

async function setup(context: BrowserContext, options: { blockFirstNotifications?: boolean; withoutBroadcastChannel?: boolean } = {}) {
  const writes: { account: string; content: string }[] = []
  const rejected: { cookie: string; expected: string | undefined }[] = []
  const deletions: string[] = []
  await context.addCookies([{ name: 'linger_session', value: 'A', url: baseUrl }])
  // WebKit can omit Cookie from intercepted headers, so the mock server reads the
  // browser's URL-scoped cookie jar instead of the intercepted headers.
  const requestAccount = async (url: string) => (await context.cookies(url)).find(cookie => cookie.name === 'linger_session')?.value
  await context.route('**/auth/**', async route => {
    const headers = await route.request().allHeaders()
    const account = await requestAccount(route.request().url())
    if (route.request().url().endsWith('/logout')) {
      if (account && headers['x-linger-account'] !== `sub:account-${account}`) {
        await route.fulfill({ status: 401, json: { code: 'account_changed' } }); return
      }
      await route.fulfill({ json: { ok: true }, headers: { 'Set-Cookie': 'linger_session=; Path=/; Max-Age=0' } }); return
    }
    await route.fulfill({ json: { signedIn: Boolean(account), email: account ? `${account}@example.com` : null, googleSub: account ? `account-${account}` : null } })
  })
  await context.route('**/api/drive/**', async route => {
    const headers = await route.request().allHeaders()
    const account = await requestAccount(route.request().url())
    if (!account) { await route.fulfill({ status: 401, json: { error: 'Unauthorized' } }); return }
    const expected = headers['x-linger-account']
    if (expected !== `sub:account-${account}`) {
      rejected.push({ cookie: account, expected })
      await route.fulfill({ status: 401, json: { code: 'account_changed' }, headers: { 'X-Linger-Account-Changed': '1' } }); return
    }
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/entries')) { await route.fulfill({ json: { files: [] } }); return }
    if (url.pathname.endsWith('/changes')) { await route.fulfill({ json: { changes: [], newStartPageToken: 'x' } }); return }
    const requestDate = url.pathname.split('/').pop()!
    const meta = { id: `file-account-${account}-${requestDate}`, name: `diary-${requestDate}.txt`, version: '1' }
    if (route.request().method() === 'POST') {
      writes.push({ account, content: route.request().postDataJSON().content })
      await route.fulfill({ json: meta }); return
    }
    if (route.request().method() === 'DELETE') { deletions.push(requestDate); await route.fulfill({ status: 204 }); return }
    if (requestDate !== date) { await route.fulfill({ status: 404, json: {} }); return }
    await route.fulfill({ json: { entry: { date, content: `Account ${account} private diary` }, meta } })
  })
  const first = await context.newPage()
  const second = await context.newPage()
  if (options.withoutBroadcastChannel) {
    await context.addInitScript(() => { Object.defineProperty(window, 'BroadcastChannel', { value: undefined }) })
  }
  if (options.blockFirstNotifications) {
    await first.addInitScript(() => {
      Object.defineProperty(window, 'BroadcastChannel', { value: undefined })
      const add = window.addEventListener.bind(window)
      window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        if (type !== 'storage' && type !== 'focus') add(type, listener, options)
      }) as typeof window.addEventListener
      const addDocument = document.addEventListener.bind(document)
      document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        if (type !== 'visibilitychange') addDocument(type, listener, options)
      }) as typeof document.addEventListener
    })
  }
  for (const page of [first, second]) {
    await page.goto(`${baseUrl}/tests/multitabHarness.html`)
    await expect(page.locator('#ready')).toHaveAttribute('data-loaded', 'true')
  }
  return { first, second, writes, rejected, deletions }
}

for (const withoutBroadcastChannel of [false, true]) {
  test(`logout clears the other tab's authentication and cached content (storage fallback: ${withoutBroadcastChannel})`, async ({ context }) => {
    const { first, second } = await setup(context, { withoutBroadcastChannel })
    await first.evaluate(date => window.multitabHarness.diary.getContent(date), date)
    await second.evaluate(() => window.multitabHarness.auth.signOut())
    await expect(first.locator('#ready')).toHaveAttribute('data-status', 'signedOut')
    expect(await first.evaluate(date => window.multitabHarness.diary.getContent(date), date)).toBeNull()
  })
}

test('switching accounts stops the old tab without clearing the new account cache', async ({ context }) => {
  const { first, second, writes } = await setup(context)
  await first.evaluate(date => window.multitabHarness.diary.getContent(date), date)
  await context.addCookies([{ name: 'linger_session', value: 'B', url: baseUrl }])
  await second.reload()
  await expect(second.locator('#ready')).toHaveAttribute('data-email', 'B@example.com')
  await expect(second.locator('#ready')).toHaveAttribute('data-loaded', 'true')
  await expect(first.locator('#ready')).toHaveAttribute('data-status', 'signedOut')
  await second.evaluate(date => window.multitabHarness.diary.getContent(date), date)
  await first.evaluate(() => window.multitabHarness.diary.save('2026-05-02', 'Account A private text', null).catch(() => null))
  expect(writes).toEqual([])
  await expect.poll(() => second.evaluate(() => window.multitabHarness.getAllCached())).toContainEqual(expect.objectContaining({ owner: 'B@example.com', content: { date, content: 'Account B private diary' } }))
})

test('server account binding rejects an old tab even when all notifications are missed', async ({ context }) => {
  const { first, second, writes, rejected } = await setup(context, { blockFirstNotifications: true })
  await context.addCookies([{ name: 'linger_session', value: 'B', url: baseUrl }])
  await second.reload()
  await expect(second.locator('#ready')).toHaveAttribute('data-loaded', 'true')
  await first.evaluate(() => window.multitabHarness.diary.save('2026-05-02', 'Account A private text', null).catch(() => null))
  expect(rejected).toContainEqual({ cookie: 'B', expected: 'sub:account-A' })
  expect(writes).toEqual([])
  await expect(first.locator('#ready')).toHaveAttribute('data-status', 'signedOut')
  expect(await first.evaluate(() => window.multitabHarness.auth.tokenExpired)).toBe(false)
  expect(await first.evaluate(() => window.multitabHarness.diary.retryPendingSave())).toBeNull()
})

test('independent offline deletes survive and replay once across two tabs', async ({ context }) => {
  const { first, second, deletions } = await setup(context)
  await Promise.all([
    first.evaluate(() => window.multitabHarness.queue.enqueue({ id: 'a', type: 'REMOVE', date: '2026-05-01', timestamp: 1 })),
    second.evaluate(() => window.multitabHarness.queue.enqueue({ id: 'b', type: 'REMOVE', date: '2026-05-02', timestamp: 2 })),
  ])
  expect((await first.evaluate(() => window.multitabHarness.queue.getPending())).map(item => item.id)).toEqual(['a', 'b'])
  await Promise.all([first.evaluate(() => window.multitabHarness.processQueue()), second.evaluate(() => window.multitabHarness.processQueue())])
  expect(deletions.sort()).toEqual(['2026-05-01', '2026-05-02'])
  expect(await second.evaluate(() => window.multitabHarness.queue.getPending())).toEqual([])
})

test('sign-out from an unaware old tab preserves the new account session and cache', async ({ context }) => {
  const { first, second } = await setup(context, { blockFirstNotifications: true })
  await context.addCookies([{ name: 'linger_session', value: 'B', url: baseUrl }])
  await second.reload()
  await expect(second.locator('#ready')).toHaveAttribute('data-loaded', 'true')
  await second.evaluate(date => window.multitabHarness.diary.getContent(date), date)
  await first.evaluate(() => window.multitabHarness.auth.signOut())
  await expect(first.locator('#ready')).toHaveAttribute('data-status', 'signedOut')
  expect((await context.cookies()).find(cookie => cookie.name === 'linger_session')?.value).toBe('B')
  await expect(second.locator('#ready')).toHaveAttribute('data-status', 'signedIn')
  expect(await second.evaluate(() => window.multitabHarness.getAllCached())).toContainEqual(expect.objectContaining({ owner: 'B@example.com' }))
})

test('BroadcastChannel still propagates logout when the auth event cannot be persisted', async ({ context }) => {
  const { first, second } = await setup(context)
  await second.evaluate(() => {
    const set = Storage.prototype.setItem
    Storage.prototype.setItem = function(key, value) {
      if (key === 'linger_auth_event' || key === 'linger_had_session') throw new DOMException('Full', 'QuotaExceededError')
      set.call(this, key, value)
    }
  })
  await second.evaluate(() => window.multitabHarness.auth.signOut())
  await expect(first.locator('#ready')).toHaveAttribute('data-status', 'signedOut')
  await expect(second.locator('#ready')).toHaveAttribute('data-status', 'signedOut')
})
