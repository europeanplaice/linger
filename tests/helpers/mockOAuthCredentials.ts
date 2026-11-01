import type { Page, BrowserContext } from '@playwright/test'

/**
 * Replace the app's OAuth credential module inside a browser test with a
 * request-scoped in-memory credential fixture. This is a module interception,
 * not a production global hook; no tokens are written to browser storage.
 */
export async function installMockOAuthCredentials(
  target: Page | BrowserContext,
  options: { seedOnModuleLoad?: number | 'all' } = {},
): Promise<void> {
  let moduleLoads = 0
  await target.route('**/src/lib/oauthCredentials.ts*', route => {
    moduleLoads++
    const seedThisLoad = options.seedOnModuleLoad === undefined || options.seedOnModuleLoad === 'all' || moduleLoads === options.seedOnModuleLoad
    const body = !seedThisLoad
      ? `
          let current = null;
          export function setOAuthCredentials(value) { current = { ...value }; }
          export function getAccessToken() { return current && current.expiresAt > Date.now() + 5000 ? current.accessToken : null; }
          export function getIdToken() { return getAccessToken() ? current.idToken : null; }
          export function clearOAuthCredentials() { current = null; }
        `
      : `
          let current = { accessToken: 'e2e-access-token', idToken: 'e2e-id-token', expiresAt: Date.now() + 3600000 };
          export function setOAuthCredentials(value) { current = { ...value }; }
          export function getAccessToken() { return current && current.expiresAt > Date.now() + 5000 ? current.accessToken : null; }
          export function getIdToken() { return getAccessToken() ? current.idToken : null; }
          export function clearOAuthCredentials() { current = null; }
        `
    return route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body,
    })
  })
}
