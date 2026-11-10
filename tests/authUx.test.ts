import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'
import { installMockOAuthCredentials } from './helpers/mockOAuthCredentials'

test('mobile recovery keeps its title visible and confirms before account recreation', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto(baseUrl)
  await page.getByText('Having trouble with your passkey?', { exact: true }).click()
  await expect(page.getByText('Use a passkey saved on another device', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Set up again with the same Google account' }).click()
  const heading = page.getByRole('heading', { name: 'Set up Linger again' })
  await expect(heading).toBeFocused()
  await expect(page.getByRole('button', { name: 'Connect Google Drive', exact: true })).toBeDisabled()
  await page.getByRole('checkbox', { name: /I understand/ }).check()
  await expect(page.getByRole('button', { name: 'Connect Google Drive', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.locator('.landing').evaluate(element => element.scrollTo(0, 0))
  expect((await heading.boundingBox())!.y).toBeGreaterThanOrEqual(0)
  await page.locator('.passkey-gate-card').screenshot({ path: '/tmp/linger-auth-recovery-mobile.png' })
})

test('new setup explains each step and returning sign-in keeps persistence optional', async ({ page }) => {
  await page.goto(baseUrl)
  const checkbox = page.getByRole('checkbox', { name: 'Skip passkey on this browser' })
  await expect(checkbox).not.toBeChecked()
  await checkbox.check()
  const duration = page.getByRole('combobox', { name: 'How long to skip passkey' })
  await expect(duration).toHaveValue('1')
  await duration.selectOption('7')
  await expect(duration).toHaveValue('7')
  await page.getByRole('button', { name: 'First time using Linger? Get started' }).click()
  await expect(page.getByRole('list', { name: 'Start using Linger' })).toBeVisible()
  await expect(page.getByText(/confirm it once more/)).toBeVisible()
  await expect(page.getByRole('checkbox')).toHaveCount(0)
})

test('offers optional device persistence inside the editor after registration', async ({ page }) => {
  const userId = '624a7c5a-7c13-4c62-a14d-3f8c3bd516f8'
  await page.setViewportSize({ width: 390, height: 844 })
  await installMockOAuthCredentials(page, { seedOnModuleLoad: 0, seedVaultOnModuleLoad: 0 })
  await page.route('**/src/api/passkeys.ts*', route => route.fulfill({ contentType: 'application/javascript', body: `
    import { unlockVaultWithKey } from '/src/lib/passkeyVault.ts';
    export async function registerPasskey() { unlockVaultWithKey('${userId}', new Uint8Array(32).fill(7)); return { userId: '${userId}' }; }
    export const loginWithPasskey = registerPasskey;
    export async function addPasskey() {}
    export async function listPasskeys() { return { credentials: [], currentCredentialId: null }; }
    export async function renamePasskey() {}
    export async function deletePasskey() {}
  ` }))
  await page.context().route('**/auth/login?*', route => route.fulfill({ contentType: 'text/html', body: `<script>window.opener.postMessage({type:'linger-oauth-complete',credential:{accessToken:'initial',idToken:'initial-id',refreshToken:'refresh',expiresAt:Date.now()+3600000,email:'person@example.com'}},location.origin)</script>` }))
  await page.route('/auth/session', route => route.fulfill({ json: { signedIn: true, userId, email: 'person@example.com', googleSub: 'google-a', googleClientId: 'client' } }))
  await page.route('/auth/refresh', route => route.fulfill({ json: { accessToken: 'renewed', idToken: 'renewed-id', expiresAt: Date.now() + 3600000 } }))
  await page.route('/api/**', route => route.fulfill({ status: 404, body: '{}' }))
  await page.route('/api/drive/entries', route => route.fulfill({ json: { files: [] } }))
  await page.goto(baseUrl)
  await page.getByRole('button', { name: 'First time using Linger? Get started' }).click()
  await page.getByRole('button', { name: 'Connect Google Drive', exact: true }).click()
  await page.getByRole('button', { name: 'Create my first Linger passkey', exact: true }).click()
  const prompt = page.getByRole('complementary', { name: 'Choose how to sign in next time' })
  await expect(prompt).toBeVisible()
  await expect(prompt.getByRole('checkbox')).not.toBeChecked()
  await expect(page.locator('textarea.editor-textarea')).toBeVisible()
  const bounds = (await page.locator('#main-content').boundingBox())!
  expect(bounds.width).toBeGreaterThan(350)
  await page.screenshot({ path: '/tmp/linger-auth-remember-mobile.png' })
  await prompt.getByRole('checkbox').check()
  await prompt.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(prompt).toHaveCount(0)
  const remaining = await page.evaluate(() => JSON.parse(localStorage.getItem('linger_device_session_v1')!).expiresAt - Date.now())
  expect(remaining).toBeGreaterThan(23 * 3600000)
  expect(remaining).toBeLessThanOrEqual(24 * 3600000)
})
