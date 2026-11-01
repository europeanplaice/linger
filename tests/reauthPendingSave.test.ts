import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'
import { installMockOAuthCredentials } from './helpers/mockOAuthCredentials'

async function setUpExpiredSave(
  page: import('@playwright/test').Page,
  reauthSub: 'google-a' | 'google-b',
) {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('linger_language', 'en')
  })
  await installMockOAuthCredentials(page, { seedOnModuleLoad: 0 })

  let popupCount = 0
  await page.context().route('**/auth/login', async route => {
    popupCount++
    const isReauth = popupCount > 1
    const sub = isReauth ? reauthSub : 'google-a'
    const html = isReauth
      ? `<script>window.opener.postMessage({type:'reauth-popup-ready'},location.origin)</script>`
      : `<script>window.opener.postMessage({type:'linger-oauth-complete',credential:{accessToken:'token-a',idToken:'${sub}',expiresAt:Date.now()+3600000}},location.origin)</script>`
    await route.fulfill({ contentType: 'text/html', body: html })
  })
  await page.route('/auth/session', async route => {
    const idToken = route.request().headers()['x-linger-google-id-token']
    const googleSub = idToken === 'google-b' ? 'google-b' : 'google-a'
    await route.fulfill({ json: { signedIn: true, email: `${googleSub}@example.com`, googleSub } })
  })
  await page.route('/api/**', route => route.fulfill({ status: 404, body: '{}' }))
  await page.route('/api/s3/entry-status/**', route => route.fulfill({ json: { status: 'disabled' } }))
  await page.route('/api/drive/entries', route => route.fulfill({ json: { files: [] } }))
  await page.route('/api/drive/entry/**', async route => {
    if (route.request().method() === 'POST') {
      const count = Number(await page.evaluate(() => Number(sessionStorage.getItem('pendingSaveCount') ?? 0))) + 1
      await page.evaluate(value => sessionStorage.setItem('pendingSaveCount', String(value)), count)
      if (count === 1) return route.fulfill({ status: 401, body: '{}' })
      return route.fulfill({ json: { id: 'saved-entry', name: 'diary-entry.txt', version: String(count) } })
    }
    return route.fulfill({ status: 404, body: '' })
  })

  await page.goto(baseUrl)
  await page.getByRole('button', { name: 'Sign in with Google' }).click()
  await expect(page.locator('textarea.editor-textarea')).toBeVisible()
  await page.locator('textarea.editor-textarea').fill('Unsaved draft that must stay with Google A')
  await page.locator('button.btn-save').click()
  await expect(page.locator('.session-expired-dialog')).toBeVisible()
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('pendingSaveCount'))).toBe('1')
}

test('pending save waits for popup completion, then retries for the same Google sub', async ({ page }) => {
  await setUpExpiredSave(page, 'google-a')

  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Log in again' }).click()
  const popup = await popupPromise
  await popup.waitForLoadState()
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('pendingSaveCount'))).toBe('1')

  await popup.evaluate(() => window.opener?.postMessage({
    type: 'linger-oauth-complete',
    credential: { accessToken: 'token-a-reauth', idToken: 'google-a', expiresAt: Date.now() + 3600000 },
  }, location.origin))
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('pendingSaveCount'))).toBe('2')
  await expect(page.locator('textarea.editor-textarea')).toHaveValue('Unsaved draft that must stay with Google A')
})

test('pending save is not retried when reauth returns a different Google sub', async ({ page }) => {
  await setUpExpiredSave(page, 'google-b')

  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Log in again' }).click()
  const popup = await popupPromise
  await popup.waitForLoadState()
  await popup.evaluate(() => window.opener?.postMessage({
    type: 'linger-oauth-complete',
    credential: { accessToken: 'token-b', idToken: 'google-b', expiresAt: Date.now() + 3600000 },
  }, location.origin))

  await expect(page.getByRole('alert')).toContainText('Google returned a different account')
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('pendingSaveCount'))).toBe('1')
  await expect(page.locator('textarea.editor-textarea')).toHaveValue('Unsaved draft that must stay with Google A')
})
