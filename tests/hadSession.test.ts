import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'

// Default storageState (storageState.en.json) does NOT include linger_had_session,
// so each test starts without a prior-session hint unless explicitly set.

test('no app shell shown during auth check when no prior session', async ({ page }) => {
  let releaseSession!: () => void
  const sessionGate = new Promise<void>(resolve => { releaseSession = resolve })

  await page.route('/auth/session', async route => {
    await sessionGate
    await route.fulfill({ json: { signedIn: false } })
  })

  await page.goto(baseUrl)

  // While checkSession() is pending and hadSession=false, render returns null — no app shell
  await expect(page.locator('.restoring-app')).toHaveCount(0)
  await expect(page.locator('.login-screen')).toHaveCount(0)

  releaseSession()
  await expect(page.locator('.login-screen')).toBeVisible()
})

test('app shell shown during auth check when prior session hint is set', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('linger_had_session', 'true')
  })

  let releaseSession!: () => void
  const sessionGate = new Promise<void>(resolve => { releaseSession = resolve })

  await page.route('/auth/session', async route => {
    await sessionGate
    await route.fulfill({ json: { signedIn: true } })
  })
  await page.route('/api/drive/entries', async route => {
    await route.fulfill({ json: { files: [] } })
  })
  await page.route('/api/drive/entry/**', async route => {
    await route.fulfill({ status: 404, body: '' })
  })

  await page.goto(baseUrl)

  // While checkSession() is pending and hadSession=true, show the restoring skeleton
  await expect(page.locator('.restoring-app')).toBeVisible()

  releaseSession()
  await expect(page.locator('.editor-textarea')).toBeVisible()
})

test('sets linger_had_session to true after successful session check', async ({ page }) => {
  await page.route('/auth/session', async route => {
    await route.fulfill({ json: { signedIn: true } })
  })
  await page.route('/api/drive/entries', async route => {
    await route.fulfill({ json: { files: [] } })
  })
  await page.route('/api/drive/entry/**', async route => {
    await route.fulfill({ status: 404, body: '' })
  })

  await page.goto(baseUrl)
  await expect(page.locator('.editor-textarea')).toBeVisible()

  const value = await page.evaluate(() => localStorage.getItem('linger_had_session'))
  expect(value).toBe('true')
})

test('sets linger_had_session to false after failed session check', async ({ page }) => {
  await page.route('/auth/session', async route => {
    await route.fulfill({ json: { signedIn: false } })
  })

  await page.goto(baseUrl)
  await expect(page.locator('.login-screen')).toBeVisible()

  const value = await page.evaluate(() => localStorage.getItem('linger_had_session'))
  expect(value).toBe('false')
})

test('clears linger_had_session on sign-out', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('linger_had_session', 'true')
  })

  await page.route('/auth/session', async route => {
    await route.fulfill({ json: { signedIn: true } })
  })
  await page.route('/api/drive/entries', async route => {
    await route.fulfill({ json: { files: [] } })
  })
  await page.route('/api/drive/entry/**', async route => {
    await route.fulfill({ status: 404, body: '' })
  })
  await page.route('/auth/logout', async route => {
    await route.fulfill({ status: 200, body: '' })
  })

  await page.goto(baseUrl)
  await expect(page.locator('.editor-textarea')).toBeVisible()

  await page.locator('.btn-settings').click()
  await page.locator('.settings-signout-btn').click()
  // Sign-out is now confirmed through a dialog before it takes effect.
  await page.locator('.signout-confirm-start').click()
  await expect(page.locator('.login-screen')).toBeVisible()

  const value = await page.evaluate(() => localStorage.getItem('linger_had_session'))
  expect(value).toBe('false')
})
