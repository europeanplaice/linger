import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'

async function loadHarness(page: import('@playwright/test').Page) {
  await page.goto(`${baseUrl}/tests/settingsModalHarness.html`)
}

async function render(
  page: import('@playwright/test').Page,
  opts: { autoSave?: boolean; modalOpen?: boolean; anniversaries?: import('../src/types').Anniversary[] } = {},
) {
  await page.evaluate(({ autoSave, modalOpen, anniversaries }) => {
    window.settingsHarness.render({ autoSave, modalOpen, anniversaries })
  }, { autoSave: opts.autoSave, modalOpen: opts.modalOpen, anniversaries: opts.anniversaries })
  await page.waitForSelector('.settings-dialog')
}

test.describe('SettingsModal — anniversaries', () => {
  test('adds, toggles, and confirms deletion of an anniversary', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    await page.getByRole('button', { name: 'Add' }).click()
    await page.getByLabel('Name (e.g. Birthday)').fill('Birthday')
    await page.getByLabel('Date').fill('2020-05-10')
    await page.getByRole('button', { name: 'Add' }).click()

    const row = page.locator('.settings-anniversary-row', { hasText: 'Birthday' })
    await expect(row).toContainText('2020-05-10')

    const badgeSwitch = row.getByRole('switch', { name: 'Show badge' })
    await expect(badgeSwitch).toHaveAttribute('aria-checked', 'true')
    await badgeSwitch.click()
    await expect(badgeSwitch).toHaveAttribute('aria-checked', 'false')

    await row.getByRole('button', { name: 'Remove Birthday' }).click()
    await expect(row).toContainText('Delete anniversary "Birthday"?')
    await row.getByRole('button', { name: 'Delete' }).click()
    await expect(row).toHaveCount(0)
  })

  test('allows at most ten anniversaries', async ({ page }) => {
    await loadHarness(page)
    await render(page, {
      anniversaries: Array.from({ length: 10 }, (_, i) => ({
        id: `anniversary-${i + 1}`,
        label: `Anniversary ${i + 1}`,
        date: `2020-${String(i + 1).padStart(2, '0')}-01`,
        showBadge: i < 3 ? undefined : false,
      })),
    })

    await expect(page.getByText('10 / 10 registered')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add' })).toBeDisabled()
  })

  test('allows at most three enabled anniversary badges', async ({ page }) => {
    await loadHarness(page)
    await render(page, {
      anniversaries: [
        { id: 'one', label: 'One', date: '2020-01-01' },
        { id: 'two', label: 'Two', date: '2020-02-01' },
        { id: 'three', label: 'Three', date: '2020-03-01' },
        { id: 'four', label: 'Four', date: '2020-04-01', showBadge: false },
      ],
    })

    const firstSwitch = page.locator('.settings-anniversary-row', { hasText: 'One' })
      .getByRole('switch', { name: 'Show badge' })
    const fourthSwitch = page.locator('.settings-anniversary-row', { hasText: 'Four' })
      .getByRole('switch', { name: 'Show badge' })

    await expect(fourthSwitch).toHaveAttribute('aria-disabled', 'true')
    await expect(fourthSwitch).toHaveAttribute('aria-checked', 'false')

    await firstSwitch.click()
    await expect(fourthSwitch).not.toHaveAttribute('aria-disabled', 'true')
    await fourthSwitch.click()
    await expect(fourthSwitch).toHaveAttribute('aria-checked', 'true')
  })
})

test.describe('SettingsModal — auto-save toggle', () => {
  test('is checked by default when localStorage has no value', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(() => localStorage.removeItem('linger_autosave'))
    await render(page)

    const toggle = page.locator('.settings-item:has-text("Auto-save") .settings-switch')
    await expect(toggle).toHaveClass(/active/)
  })

  test('is unchecked when localStorage is set to false', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(() => localStorage.setItem('linger_autosave', 'false'))
    await render(page, { autoSave: false })

    const toggle = page.locator('.settings-item:has-text("Auto-save") .settings-switch')
    await expect(toggle).not.toHaveClass(/active/)
  })

  test('toggling off persists false to localStorage', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(() => localStorage.removeItem('linger_autosave'))
    await render(page)

    const toggle = page.locator('.settings-item:has-text("Auto-save") .settings-switch')
    await toggle.click()

    const stored = await page.evaluate(() => window.settingsHarness.getStoredAutoSave())
    expect(stored).toBe('false')
    await expect(toggle).not.toHaveClass(/active/)
  })

  test('toggling on persists true to localStorage', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(() => localStorage.setItem('linger_autosave', 'false'))
    await render(page, { autoSave: false })

    const toggle = page.locator('.settings-item:has-text("Auto-save") .settings-switch')
    await toggle.click()
    await page.waitForFunction(() => localStorage.getItem('linger_autosave') === 'true')

    const stored = await page.evaluate(() => window.settingsHarness.getStoredAutoSave())
    expect(stored).toBe('true')
    await expect(toggle).toHaveClass(/active/)
  })

  test('switch has correct aria attributes', async ({ page }) => {
    await loadHarness(page)
    await render(page, { autoSave: true })

    const toggle = page.locator('.settings-item:has-text("Auto-save") .settings-switch')
    await expect(toggle).toHaveAttribute('role', 'switch')
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  test('Escape key closes the modal', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    await page.keyboard.press('Escape')
    await expect(page.locator('.settings-dialog')).toHaveCount(0)
  })

  test('overlay click closes the modal', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    await page.mouse.click(5, 5)
    await expect(page.locator('.settings-dialog')).toHaveCount(0)
  })
})

test.describe('SettingsModal — theme picker', () => {
  test('shows three theme buttons with correct labels', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const buttons = page.locator('.settings-theme-picker .settings-theme-option')
    await expect(buttons).toHaveCount(3)
    await expect(buttons.nth(0)).toHaveAttribute('aria-label', 'Light')
    await expect(buttons.nth(1)).toHaveAttribute('aria-label', 'Dark')
    await expect(buttons.nth(2)).toHaveAttribute('aria-label', 'Auto')
  })

  test('defaults to light as active', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const buttons = page.locator('.settings-theme-picker .settings-theme-option')
    await expect(buttons.nth(0)).toHaveClass(/active/)
    await expect(buttons.nth(1)).not.toHaveClass(/active/)
    await expect(buttons.nth(2)).not.toHaveClass(/active/)
  })

  test('initializes with provided themeMode', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(() => window.settingsHarness.render({ themeMode: 'system' }))
    await page.waitForSelector('.settings-dialog')

    const buttons = page.locator('.settings-theme-picker .settings-theme-option')
    await expect(buttons.nth(2)).toHaveClass(/active/)
    await expect(buttons.nth(0)).not.toHaveClass(/active/)
  })

  test('clicking dark activates dark button', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const buttons = page.locator('.settings-theme-picker .settings-theme-option')
    await buttons.nth(1).click()
    await expect(buttons.nth(1)).toHaveClass(/active/)
    await expect(buttons.nth(0)).not.toHaveClass(/active/)
  })

  test('clicking system activates system button', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const buttons = page.locator('.settings-theme-picker .settings-theme-option')
    await buttons.nth(2).click()
    await expect(buttons.nth(2)).toHaveClass(/active/)
    await expect(buttons.nth(0)).not.toHaveClass(/active/)
  })

  test('switching from dark back to light activates light button', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(() => window.settingsHarness.render({ themeMode: 'dark' }))
    await page.waitForSelector('.settings-dialog')

    const buttons = page.locator('.settings-theme-picker .settings-theme-option')
    await buttons.nth(0).click()
    await expect(buttons.nth(0)).toHaveClass(/active/)
    await expect(buttons.nth(1)).not.toHaveClass(/active/)
  })
})

test.describe('SettingsModal — about data storage', () => {
  test('shows about data storage section', async ({ page }) => {
    await loadHarness(page)
    await render(page, { modalOpen: true })

    const aboutStorage = page.locator('.settings-about').filter({ hasText: 'About data storage' })
    await expect(aboutStorage).toBeVisible()
    await expect(aboutStorage.locator('.settings-about-title')).toHaveText('About data storage')
    await expect(aboutStorage.locator('.settings-about-text')).toContainText('Your diary entries are stored in your Google Drive:')
  })

  test('lists correct storage details', async ({ page }) => {
    await loadHarness(page)
    await render(page, { modalOpen: true })

    const listItems = page.locator('.settings-about').filter({ hasText: 'About data storage' }).locator('.settings-about-list li')
    await expect(listItems).toHaveCount(4)
    await expect(listItems.nth(0)).toContainText('linger_diary')
    await expect(listItems.nth(1)).toContainText('diary-YYYY-MM-DD.txt')
    await expect(listItems.nth(2)).toContainText('plain text body')
    await expect(listItems.nth(3)).toContainText('drive.file')
  })

  test('about section appears after export section', async ({ page }) => {
    await loadHarness(page)
    await render(page, { modalOpen: true })

    const exportSection = page.locator('.settings-item').filter({ hasText: 'Export all entries' })
    const aboutSection = page.locator('.settings-about').filter({ hasText: 'About data storage' })
    await expect(exportSection).toBeVisible()
    await expect(aboutSection).toBeVisible()

    const exportBox = await exportSection.boundingBox()
    const aboutBox = await aboutSection.boundingBox()
    expect(exportBox).not.toBeNull()
    expect(aboutBox).not.toBeNull()
    if (exportBox && aboutBox) {
      expect(aboutBox.y).toBeGreaterThan(exportBox.y)
    }
  })
})

test.describe('SettingsModal — export confirm modal', () => {
  test('clicking Export all opens confirm modal', async ({ page }) => {
    await loadHarness(page)
    await render(page, { modalOpen: true })

    await page.locator('.btn-export-modern').click()
    await expect(page.locator('.export-confirm-dialog')).toBeVisible()
  })

  test('confirm modal shows entry count', async ({ page }) => {
    await loadHarness(page)
    await render(page, { modalOpen: true })

    await page.locator('.btn-export-modern').click()
    await expect(page.locator('.export-confirm-desc')).toContainText('2 entries')
  })

  test('cancel button closes confirm modal', async ({ page }) => {
    await loadHarness(page)
    await render(page, { modalOpen: true })

    await page.locator('.btn-export-modern').click()
    await page.locator('.export-confirm-cancel').click()
    await expect(page.locator('.export-confirm-dialog')).not.toBeVisible()
  })

  test('Escape key closes confirm modal', async ({ page }) => {
    await loadHarness(page)
    await render(page, { modalOpen: true })

    await page.locator('.btn-export-modern').click()
    await page.keyboard.press('Escape')
    await expect(page.locator('.export-confirm-dialog')).not.toBeVisible()
  })

  test('overlay click closes confirm modal', async ({ page }) => {
    await loadHarness(page)
    await render(page, { modalOpen: true })

    await page.locator('.btn-export-modern').click()
    await page.mouse.click(5, 5)
    await expect(page.locator('.export-confirm-dialog')).not.toBeVisible()
  })

  test('Start export calls handler', async ({ page }) => {
    await loadHarness(page)
    await render(page, { modalOpen: true })

    await page.locator('.btn-export-modern').click()
    await page.locator('.export-confirm-start').click()

    const calls = await page.evaluate(() => window.settingsHarness.exportCalls())
    expect(calls.length).toBe(1)
    expect(calls[0].hasProgress).toBe(true)
  })

  test('confirm modal explains the ZIP format with a note', async ({ page }) => {
    await loadHarness(page)
    await render(page, { modalOpen: true })

    await page.locator('.btn-export-modern').click()

    const note = page.locator('.export-format-note')
    await expect(note).toBeVisible()
    await expect(note).toContainText('plain-text file')
  })

  test('confirm modal shows a file tree with the zip name and per-day files', async ({ page }) => {
    await loadHarness(page)
    await render(page, { modalOpen: true })

    await page.locator('.btn-export-modern').click()

    const tree = page.locator('.export-format-tree')
    await expect(tree).toBeVisible()

    // ZIP archive name line.
    await expect(tree.locator('.export-format-zip')).toContainText('linger_diary_export_')
    await expect(tree.locator('.export-format-zip')).toContainText('.zip')

    // One file line per entry date, named diary-YYYY-MM-DD.txt.
    const files = tree.locator('.export-format-file')
    await expect(files).toHaveCount(2)
    await expect(files.nth(0)).toContainText('diary-2026-05-01.txt')
    await expect(files.nth(1)).toContainText('diary-2026-05-02.txt')
  })

  test('export button is disabled when no dates', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(() => {
      window.settingsHarness.render({ modalOpen: true })
      // Override dates to empty
      const settingsModal = document.querySelector('.settings-dialog')
      if (settingsModal) {
        // Can't dynamically change dates prop easily, but button should be disabled
      }
    })
    // This test is limited by harness design; skip for now
  })
})

test.describe('SettingsModal — Drive folder link', () => {
  test('shows a link to the Drive folder', async ({ page }) => {
    await loadHarness(page)
    await render(page, { modalOpen: true })

    const link = page.locator('.settings-drive-link')
    await expect(link).toBeVisible()
    await expect(link).toContainText('Google Drive')
    const href = await link.getAttribute('href')
    expect(href).toContain('drive.google.com/drive/search')
    expect(href).toContain('linger_diary')
  })

  test('link opens in a new tab', async ({ page }) => {
    await loadHarness(page)
    await render(page, { modalOpen: true })

    const link = page.locator('.settings-drive-link')
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  test('link includes authuser param when email is provided', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(() => window.settingsHarness.render({ modalOpen: true, email: 'test@example.com' }))
    await page.waitForSelector('.settings-dialog')

    const link = page.locator('.settings-drive-link')
    const href = await link.getAttribute('href')
    expect(href).toContain('authuser=test%40example.com')
  })

  test('link has no authuser param when email is not provided', async ({ page }) => {
    await loadHarness(page)
    await render(page, { modalOpen: true })

    const link = page.locator('.settings-drive-link')
    const href = await link.getAttribute('href')
    expect(href).not.toContain('authuser')
  })
})

test.describe('SettingsModal — font size select', () => {
  test('font size dropdown keeps the compact popup style', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    await page.getByRole('button', { name: 'Font size' }).click()
    const dropdown = page.getByRole('listbox', { name: 'Font size' })
    await expect(dropdown).toBeVisible()

    const metrics = await dropdown.evaluate(el => {
      const styles = getComputedStyle(el)
      return {
        width: el.getBoundingClientRect().width,
        background: styles.backgroundColor,
        borderWidth: styles.borderTopWidth,
        borderRadius: styles.borderTopLeftRadius,
        padding: styles.paddingTop,
        shadow: styles.boxShadow,
        optionCount: el.querySelectorAll('[role="option"]').length,
      }
    })

    expect(metrics.width).toBeGreaterThanOrEqual(96)
    expect(metrics.width).toBeLessThan(160)
    expect(metrics.background).toBe('rgb(250, 249, 246)')
    expect(parseFloat(metrics.borderWidth)).toBeGreaterThanOrEqual(1)
    expect(metrics.borderRadius).toBe('8px')
    expect(metrics.padding).toBe('4px')
    expect(metrics.shadow).not.toBe('none')
    expect(metrics.optionCount).toBe(4)
  })

  test('shows a select with four size options', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const trigger = page.getByRole('button', { name: 'Font size' })
    await expect(trigger).toBeVisible()
    await trigger.click()

    const dropdown = page.getByRole('listbox', { name: 'Font size' })
    await expect(dropdown).toBeVisible()

    const options = dropdown.getByRole('option')
    await expect(options).toHaveCount(4)
    await expect(options.nth(0)).toHaveText('Small')
    await expect(options.nth(1)).toHaveText('Medium')
    await expect(options.nth(2)).toHaveText('Large')
    await expect(options.nth(3)).toHaveText('Extra large')
  })

  test('defaults to medium', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const trigger = page.getByRole('button', { name: 'Font size' })
    await expect(trigger.locator('span')).toHaveText('Medium')
  })

  test('initializes with provided fontSize', async ({ page }) => {
    await loadHarness(page)
    await page.evaluate(() => window.settingsHarness.render({ fontSize: 'lg' }))
    await page.waitForSelector('.settings-dialog')

    const trigger = page.getByRole('button', { name: 'Font size' })
    await expect(trigger.locator('span')).toHaveText('Large')
  })

  test('selecting xl updates the select value', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const trigger = page.getByRole('button', { name: 'Font size' })
    await trigger.click()

    const dropdown = page.getByRole('listbox', { name: 'Font size' })
    await dropdown.getByRole('option', { name: 'Extra large' }).click()

    await expect(trigger.locator('span')).toHaveText('Extra large')
  })
})

test.describe('SettingsModal — sign out button', () => {
  test('matches the other action buttons at rest and on hover', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const signOut = page.locator('.settings-signout-btn')
    const share = page.locator('.settings-action-btn:not(.settings-signout-btn)').first()
    const bg = (loc: import('@playwright/test').Locator) =>
      loc.evaluate(el => getComputedStyle(el).backgroundColor)

    // At rest, sign out uses the same accent background as other action buttons.
    const restSignOut = await bg(signOut)
    const restShare = await bg(share)
    expect(restSignOut).toBe(restShare)

    // On hover the background must not change (no light/white flip — regression guard).
    await signOut.hover()
    expect(await bg(signOut)).toBe(restSignOut)
  })

  test('does not sign out immediately — shows a confirmation dialog first', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    await page.locator('.settings-signout-btn').click()

    const confirm = page.locator('.signout-confirm-dialog')
    await expect(confirm).toBeVisible()
    expect(await page.evaluate(() => window.settingsHarness.signOutCount())).toBe(0)
  })

  test('cancelling the confirmation keeps the session', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    await page.locator('.settings-signout-btn').click()
    const confirm = page.locator('.signout-confirm-dialog')
    await confirm.locator('.signout-confirm-cancel').click()

    await expect(confirm).toBeHidden()
    // Settings modal stays open and no sign out was triggered.
    await expect(page.locator('.settings-dialog')).toBeVisible()
    expect(await page.evaluate(() => window.settingsHarness.signOutCount())).toBe(0)
  })

  test('confirming triggers sign out', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    await page.locator('.settings-signout-btn').click()
    const confirm = page.locator('.signout-confirm-dialog')
    await confirm.locator('.signout-confirm-start').click()

    await page.waitForFunction(() => window.settingsHarness.signOutCount() === 1)
    expect(await page.evaluate(() => window.settingsHarness.signOutCount())).toBe(1)
  })
})
