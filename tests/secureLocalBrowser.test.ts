import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'
import { installMockOAuthCredentials } from './helpers/mockOAuthCredentials'

test('imports unattributed milestones only after a user decision and stores them encrypted', async ({ page }) => {
  await installMockOAuthCredentials(page)
  await page.addInitScript(() => {
    localStorage.setItem('linger_language', 'en')
    localStorage.setItem('linger_milestones', JSON.stringify([{ id: 'old', label: 'Private family birthday', date: '2001-05-10' }]))
    localStorage.setItem('linger_milestones_pending', 'true')
  })
  let saves = 0
  await page.route('/auth/session', route => route.fulfill({ json: { signedIn: true, email: 'person@example.com', googleSub: 'person' } }))
  await page.route('/api/drive/entries', route => route.fulfill({ json: { files: [] } }))
  await page.route('/api/drive/entry/**', route => route.fulfill({ status: 404 }))
  await page.route('/api/drive/milestones', route => {
    if (route.request().method() === 'PUT') { saves++; return route.fulfill({ json: {} }) }
    return route.fulfill({ json: [] })
  })
  await page.goto(baseUrl)
  const button = page.getByRole('button', { name: 'Import older milestones' })
  await expect(button).toBeEnabled()
  expect(saves).toBe(0)
  expect(await page.evaluate(() => localStorage.getItem('linger_milestones'))).toContain('Private family birthday')
  await button.click()
  await expect.poll(() => saves).toBe(1)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('linger_milestones'))).toBeNull()
  const persisted = await page.evaluate(async () => {
    const request = indexedDB.open('linger_diary_cache')
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const data = await new Promise<unknown[]>((resolve, reject) => {
      const read = db.transaction('secureRecords').objectStore('secureRecords').getAll()
      read.onsuccess = () => resolve(read.result)
      read.onerror = () => reject(read.error)
    })
    db.close()
    return JSON.stringify(data)
  })
  expect(persisted).not.toContain('Private family birthday')
  expect(persisted).not.toContain('2001-05-10')
})

test('requires a user decision before importing older cache, diary copies, and queued edits', async ({ page }) => {
  await installMockOAuthCredentials(page)
  await page.addInitScript(() => localStorage.setItem('linger_language', 'en'))
  await page.goto(`${baseUrl}/tests/useDiaryHarness.html`)
  await page.evaluate(async () => {
    localStorage.setItem('linger_session_user', 'person@example.com')
    localStorage.setItem('linger_local_entry_2020-02-03', 'Private old mirror')
    localStorage.setItem('linger_pending_sync_queue', JSON.stringify([{ id: 'old-save', type: 'SAVE', date: '2020-03-04', content: 'Private old queued edit', timestamp: 123 }]))
    await window.diaryHarness.seedIdb([{ date: '2020-01-02', meta: { id: 'old-file', name: 'old-name', version: '1' }, content: { date: '2020-01-02', content: 'Private old cache' } }])
  })
  await page.route('/auth/session', route => route.fulfill({ json: { signedIn: true, email: 'person@example.com', googleSub: 'person' } }))
  await page.route('/api/drive/entries', route => route.fulfill({ json: { files: [] } }))
  await page.route('/api/drive/entry/**', route => route.fulfill({ status: 404 }))
  await page.route('/api/drive/milestones', route => route.fulfill({ json: [] }))
  await page.goto(baseUrl)
  await expect(page.locator('textarea.editor-textarea')).toBeVisible()
  const cacheNotice = page.locator('.sidebar-status').filter({ hasText: 'Older cached diary data' })
  const mirrorNotice = page.locator('.sidebar-status').filter({ hasText: 'Older diary copies' })
  const queueNotice = page.locator('.sidebar-status').filter({ hasText: 'Older unsynced changes' })
  await expect(cacheNotice).toBeVisible()
  await expect(mirrorNotice).toBeVisible()
  await expect(queueNotice).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('linger_local_entry_2020-02-03'))).toBe('Private old mirror')
  await cacheNotice.getByRole('button').click()
  await mirrorNotice.getByRole('button').click()
  await queueNotice.getByRole('button').click()
  await expect(cacheNotice).toHaveCount(0)
  await expect(mirrorNotice).toHaveCount(0)
  await expect(queueNotice).toHaveCount(0)
  await expect.poll(() => page.evaluate(async () => {
    const path = '/src/lib/draftStorage.ts'
    const drafts = await import(/* @vite-ignore */ path)
    return (await drafts.getDraft('2020-03-04', 'person@example.com'))?.content
  })).toBe('Private old queued edit')
  expect(await page.evaluate(() => localStorage.getItem('linger_local_entry_2020-02-03'))).toBeNull()
  expect(await page.evaluate(() => localStorage.getItem('linger_pending_sync_queue'))).toBeNull()
  const stored = await page.evaluate(async () => {
    const request = indexedDB.open('linger_diary_cache')
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const data = await Promise.all(['entries', 'secureRecords'].map(name => new Promise<unknown[]>((resolve, reject) => {
      const read = db.transaction(name).objectStore(name).getAll()
      read.onsuccess = () => resolve(read.result)
      read.onerror = () => reject(read.error)
    })))
    db.close()
    return JSON.stringify(data)
  })
  for (const value of ['Private old cache', 'Private old mirror', 'Private old queued edit']) expect(stored).not.toContain(value)
})
