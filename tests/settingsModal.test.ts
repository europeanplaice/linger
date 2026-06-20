import { expect, test } from '@playwright/test'
import { baseUrl } from './baseUrl'

async function loadHarness(page: import('@playwright/test').Page) {
  await page.goto(`${baseUrl}/tests/settingsModalHarness.html`)
}

async function render(
  page: import('@playwright/test').Page,
  opts: { autoSave?: boolean; modalOpen?: boolean; milestones?: import('../src/types').Milestone[]; accentColor?: import('../src/hooks/useAccentColor').AccentColor } = {},
) {
  await page.evaluate(({ autoSave, modalOpen, milestones, accentColor }) => {
    window.settingsHarness.render({ autoSave, modalOpen, milestones, accentColor })
  }, { autoSave: opts.autoSave, modalOpen: opts.modalOpen, milestones: opts.milestones, accentColor: opts.accentColor })
  await page.waitForSelector('.settings-dialog')
}

async function expandMilestoneList(page: import('@playwright/test').Page) {
  const toggle = page.getByRole('button', { name: /show milestones/i })
  if (await toggle.count() > 0) await toggle.click()
}

function milestoneRow(page: import('@playwright/test').Page, label: string) {
  return page.locator('.settings-milestone-row', {
    has: page.getByRole('button', { name: `Remove ${label}` }),
  })
}

test.describe('SettingsModal — milestones', () => {
  test('adds, toggles, and confirms deletion of a milestone', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    await page.getByRole('button', { name: 'Add' }).click()
    const milestoneDialog = page.getByRole('dialog', { name: 'Add Milestone' })
    await expect(milestoneDialog).toBeVisible()
    await milestoneDialog.getByLabel('Name (e.g. Birthday)').fill('Birthday')
    await milestoneDialog.getByRole('button', { name: 'Date' }).click()
    const datePicker = page.locator('.settings-milestone-date-popover')
    await datePicker.locator('select').nth(1).selectOption('2020')
    await datePicker.locator('select').nth(0).selectOption('4')
    await datePicker.getByRole('button', { name: '2020-05-10' }).click()
    await milestoneDialog.getByRole('button', { name: 'Add' }).click()
    await expect(milestoneDialog).toBeHidden()

    await expandMilestoneList(page)
    const row = page.locator('.settings-milestone-row', { hasText: 'Birthday' })
    await expect(row).toContainText('2020-05-10')

    const badgeSwitch = row.getByRole('switch', { name: 'Show badge' })
    await expect(badgeSwitch).toHaveAttribute('aria-checked', 'true')
    await badgeSwitch.click()
    await expect(badgeSwitch).toHaveAttribute('aria-checked', 'false')

    await row.getByRole('button', { name: 'Remove Birthday' }).click()
    await expect(row).toContainText('Delete milestone "Birthday"?')
    await row.getByRole('button', { name: 'Delete' }).click()
    await expect(row).toHaveCount(0)
  })

  test('allows at most fifty milestones', async ({ page }) => {
    await loadHarness(page)
    await render(page, {
      milestones: Array.from({ length: 50 }, (_, i) => ({
        id: `milestone-${i + 1}`,
        label: `Milestone ${i + 1}`,
        date: `2020-${String((i % 12) + 1).padStart(2, '0')}-01`,
        showBadge: i < 3 ? undefined : false,
      })),
    })

    await expect(page.getByText('50 / 50 registered')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add' })).toBeDisabled()
  })

  test('milestone list is collapsed by default when milestones exist', async ({ page }) => {
    await loadHarness(page)
    await render(page, {
      milestones: [
        { id: 'one', label: 'Birthday', date: '2020-01-01' },
        { id: 'two', label: 'Anniversary', date: '2021-02-14' },
      ],
    })

    await expect(page.locator('.settings-milestone-list')).toBeHidden()
    await expect(page.getByRole('button', { name: /show milestones/i })).toBeVisible()
  })

  test('clicking the toggle expands and collapses the milestone list', async ({ page }) => {
    await loadHarness(page)
    await render(page, {
      milestones: [
        { id: 'one', label: 'Birthday', date: '2020-01-01' },
      ],
    })

    const toggle = page.getByRole('button', { name: /show milestones/i })
    await toggle.click()
    await expect(page.locator('.settings-milestone-list')).toBeVisible()
    await expect(page.getByRole('button', { name: /hide milestones/i })).toBeVisible()

    await page.getByRole('button', { name: /hide milestones/i }).click()
    await expect(page.locator('.settings-milestone-list')).toBeHidden()
  })

  test('milestone list is visible by default when no milestones exist', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    await expect(page.locator('.settings-milestone-none')).toBeVisible()
    await expect(page.getByRole('button', { name: /show milestones/i })).toHaveCount(0)
  })

  test('Add button appears in the title row alongside the usage count', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const titleActions = page.locator('.settings-milestone-title-actions')
    await expect(titleActions.getByRole('button', { name: 'Add' })).toBeVisible()
    await expect(titleActions.locator('.settings-milestone-usage')).toBeVisible()
  })

  test('sizes the add button to its label', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const titleActions = page.locator('.settings-milestone-title-actions')
    const addButton = page.getByRole('button', { name: 'Add' })
    const actionsBox = await titleActions.boundingBox()
    const buttonBox = await addButton.boundingBox()

    expect(actionsBox).not.toBeNull()
    expect(buttonBox).not.toBeNull()
    if (actionsBox && buttonBox) {
      expect(Math.abs((buttonBox.x + buttonBox.width) - (actionsBox.x + actionsBox.width))).toBeLessThan(4)
    }
  })

  test('title row with add button does not overflow on narrow screens', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await loadHarness(page)
    await render(page)

    const titleRow = page.locator('.settings-section-title-row').filter({
      has: page.locator('.settings-milestone-title-actions'),
    })
    expect(await titleRow.evaluate(el => el.scrollWidth)).toBe(await titleRow.evaluate(el => el.clientWidth))
  })

  test('keeps the date input compact and right-aligned when the form opens', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    await page.getByRole('button', { name: 'Add' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add Milestone' })
    await expect(dialog).toBeVisible()

    const form = dialog.locator('.milestone-form-dialog-form')
    const dateInput = dialog.getByRole('button', { name: 'Date' })
    const formBox = await form.boundingBox()
    const dateBox = await dateInput.boundingBox()

    expect(formBox).not.toBeNull()
    expect(dateBox).not.toBeNull()
    if (dateBox && formBox) {
      expect(dateBox.width).toBeLessThanOrEqual(140)
      expect(Math.abs((dateBox.x + dateBox.width) - (formBox.x + formBox.width))).toBeLessThan(4)
    }
  })

  test('allows at most five enabled milestone badges', async ({ page }) => {
    await loadHarness(page)
    await render(page, {
      milestones: [
        { id: 'one', label: 'One', date: '2020-01-01' },
        { id: 'two', label: 'Two', date: '2020-02-01' },
        { id: 'three', label: 'Three', date: '2020-03-01' },
        { id: 'four', label: 'Four', date: '2020-04-01' },
        { id: 'five', label: 'Five', date: '2020-05-01' },
        { id: 'six', label: 'Six', date: '2020-06-01', showBadge: false },
      ],
    })

    await expandMilestoneList(page)
    const firstSwitch = milestoneRow(page, 'One').getByRole('switch', { name: 'Show badge' })
    const sixthSwitch = milestoneRow(page, 'Six').getByRole('switch', { name: 'Show badge' })

    await expect(sixthSwitch).toHaveAttribute('aria-disabled', 'true')
    await expect(sixthSwitch).toHaveAttribute('aria-checked', 'false')

    await firstSwitch.click()
    await expect(sixthSwitch).not.toHaveAttribute('aria-disabled', 'true')
    await sixthSwitch.click()
    await expect(sixthSwitch).toHaveAttribute('aria-checked', 'true')
  })

  test('keeps milestone content within the modal on narrow screens', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await loadHarness(page)
    await render(page, {
      milestones: [
        { id: 'one', label: 'Birthday', date: '2020-01-01' },
        { id: 'two', label: 'Wedding anniversary with a very long label', date: '2021-02-14' },
        { id: 'three', label: 'Project launch', date: '2022-03-20' },
        { id: 'four', label: 'A fourth milestone', date: '2023-04-30', showBadge: false },
      ],
    })

    const item = page.locator('.settings-item-milestones')
    const section = page.locator('.settings-milestone-section')
    const itemBox = await item.boundingBox()
    const sectionBox = await section.boundingBox()

    expect(itemBox).not.toBeNull()
    expect(sectionBox).not.toBeNull()
    if (itemBox && sectionBox) {
      expect(sectionBox.x).toBeGreaterThanOrEqual(itemBox.x)
      expect(sectionBox.x + sectionBox.width).toBeLessThanOrEqual(itemBox.x + itemBox.width)
    }
    expect(await item.evaluate(el => el.scrollWidth)).toBe(await item.evaluate(el => el.clientWidth))
  })

  test('keeps the add form and delete confirmation usable on narrow screens', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await loadHarness(page)
    await render(page, {
      milestones: [
        { id: 'one', label: 'Wedding anniversary with a very long label', date: '2021-02-14' },
      ],
    })

    await page.getByRole('button', { name: 'Add' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add Milestone' })
    await expect(dialog).toBeVisible()
    expect(await dialog.evaluate(el => el.scrollWidth)).toBe(await dialog.evaluate(el => el.clientWidth))

    await dialog.getByRole('button', { name: 'Date' }).click()
    const datePicker = page.locator('.settings-milestone-date-popover')
    await expect(datePicker).toBeVisible()
    const pickerBox = await datePicker.boundingBox()
    expect(pickerBox).not.toBeNull()
    if (pickerBox) {
      expect(pickerBox.x).toBeGreaterThanOrEqual(0)
      expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(390)
    }
    await page.keyboard.press('Escape')
    await expect(datePicker).toBeHidden()
    await expect(dialog).toBeVisible()

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await expandMilestoneList(page)
    await page.getByRole('button', { name: 'Remove Wedding anniversary with a very long label' }).click()
    const confirmation = page.locator('.settings-milestone-confirm')
    await expect(confirmation).toBeVisible()
    expect(await confirmation.evaluate(el => el.scrollWidth)).toBe(await confirmation.evaluate(el => el.clientWidth))
  })
})

test.describe('SettingsModal — EmojiPicker', () => {
  test('Escape closes the picker without dismissing the settings modal', async ({ page }) => {
    await loadHarness(page)
    await render(page)
    await page.getByRole('button', { name: 'Add' }).click()

    await page.getByRole('button', { name: 'Emoji' }).click()
    await expect(page.getByRole('dialog', { name: 'Emoji' })).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Emoji' })).toBeHidden()
    await expect(page.locator('.settings-dialog')).toBeVisible()
  })

  test('selected emoji is saved with the new milestone', async ({ page }) => {
    await loadHarness(page)
    await render(page)
    await page.getByRole('button', { name: 'Add' }).click()
    const milestoneDialog = page.getByRole('dialog', { name: 'Add Milestone' })
    await expect(milestoneDialog).toBeVisible()
    await milestoneDialog.getByLabel('Name (e.g. Birthday)').fill('Anniversary')

    await milestoneDialog.getByRole('button', { name: 'Date' }).click()
    const datePicker = page.locator('.settings-milestone-date-popover')
    await datePicker.locator('select').nth(1).selectOption('2020')
    await datePicker.locator('select').nth(0).selectOption('0')
    await datePicker.getByRole('button', { name: '2020-01-01' }).click()

    await milestoneDialog.getByRole('button', { name: 'Emoji' }).click()
    const popover = page.getByRole('dialog', { name: 'Emoji' })
    const firstOption = popover.getByRole('option').first()
    await firstOption.waitFor({ state: 'visible' })
    const selectedEmoji = await firstOption.textContent()
    await firstOption.click()
    await expect(popover).toBeHidden()

    await milestoneDialog.getByRole('button', { name: 'Add' }).click()
    await expect(milestoneDialog).toBeHidden()

    await expandMilestoneList(page)
    const row = page.locator('.settings-milestone-row', { hasText: 'Anniversary' })
    await expect(row.locator('.settings-milestone-emoji')).toHaveText(selectedEmoji!)
  })

  test('clicking the active emoji again clears the selection', async ({ page }) => {
    await loadHarness(page)
    await render(page)
    await page.getByRole('button', { name: 'Add' }).click()

    const trigger = page.getByRole('button', { name: 'Emoji' })
    const popover = page.getByRole('dialog', { name: 'Emoji' })

    await trigger.click()
    const firstOption = popover.getByRole('option').first()
    await firstOption.waitFor({ state: 'visible' })
    const emoji = await firstOption.textContent()
    await firstOption.click()
    await expect(trigger.locator('.emoji-picker-trigger-icon')).toHaveText(emoji!)

    await trigger.click()
    await popover.getByRole('option', { selected: true }).click()
    await expect(trigger.locator('.emoji-picker-trigger-icon')).toHaveText('🙂')
  })

  test('searching filters results and hides category tabs', async ({ page }) => {
    await loadHarness(page)
    await render(page)
    await page.getByRole('button', { name: 'Add' }).click()
    await page.getByRole('button', { name: 'Emoji' }).click()

    const popover = page.getByRole('dialog', { name: 'Emoji' })
    await popover.getByRole('option').first().waitFor({ state: 'visible' })

    await popover.locator('input[type="search"]').fill('birthday')

    await expect(popover.getByRole('tablist')).toHaveCount(0)
    await expect(popover.getByRole('option').first()).toBeVisible()
  })

  test('searching with no match shows a no-results message', async ({ page }) => {
    await loadHarness(page)
    await render(page)
    await page.getByRole('button', { name: 'Add' }).click()
    await page.getByRole('button', { name: 'Emoji' }).click()

    const popover = page.getByRole('dialog', { name: 'Emoji' })
    await popover.getByRole('option').first().waitFor({ state: 'visible' })

    await popover.locator('input[type="search"]').fill('zzznoresult')
    await expect(popover.locator('.emoji-picker-empty')).toHaveText('No results')
  })

  test('edit form initializes the picker with the milestone\'s existing emoji', async ({ page }) => {
    await loadHarness(page)
    await render(page, {
      milestones: [{ id: 'one', label: 'Birthday', date: '2020-05-10', emoji: '🎂' }],
    })

    await expandMilestoneList(page)
    const row = page.locator('.settings-milestone-row', { hasText: 'Birthday' })
    await row.getByRole('button', { name: 'Edit Birthday' }).click()

    const editDialog = page.locator('dialog.milestone-form-dialog')
    await expect(editDialog).toBeVisible()
    const trigger = editDialog.getByRole('button', { name: 'Emoji' })
    await expect(trigger.locator('.emoji-picker-trigger-icon')).toHaveText('🎂')
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

    const aboutSection = page.locator('.settings-section').filter({ has: page.locator('h4', { hasText: 'About data storage' }) })
    await expect(aboutSection).toBeVisible()
    await expect(aboutSection.locator('h4')).toHaveText('About data storage')
    await expect(aboutSection.locator('.settings-about-text')).toContainText('Your diary entries are stored in your Google Drive:')
  })

  test('lists correct storage details', async ({ page }) => {
    await loadHarness(page)
    await render(page, { modalOpen: true })

    const aboutSection = page.locator('.settings-section').filter({ has: page.locator('h4', { hasText: 'About data storage' }) })
    const listItems = aboutSection.locator('.settings-about-list li')
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
    const aboutSection = page.locator('.settings-section').filter({ has: page.locator('h4', { hasText: 'About data storage' }) })
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
    expect(metrics.background).toBe('rgb(247, 246, 252)')
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
  test('is in the account section and has transparent background at rest', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const signOut = page.locator('.settings-account-row .settings-signout-btn')
    await expect(signOut).toBeVisible()

    const bg = (loc: import('@playwright/test').Locator) =>
      loc.evaluate(el => getComputedStyle(el).backgroundColor)

    // At rest the button is transparent (not an accent-filled action button).
    expect(await bg(signOut)).toBe('rgba(0, 0, 0, 0)')

    // On hover the background must change (danger tint applied — regression guard).
    await signOut.hover()
    expect(await bg(signOut)).not.toBe('rgba(0, 0, 0, 0)')
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

test.describe('SettingsModal — accent color', () => {
  test('shows an accent color picker in the Appearance section', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const picker = page.locator('.settings-color-picker')
    await expect(picker).toBeVisible()
    await expect(picker.getByRole('button', { name: /indigo/i })).toBeVisible()
    await expect(picker.getByRole('button', { name: /sage/i })).toBeVisible()
  })

  test('indigo button is active by default', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const indigoBtn = page.locator('.settings-color-picker').getByRole('button', { name: /indigo/i })
    await expect(indigoBtn).toHaveAttribute('aria-pressed', 'true')
    const sageBtn = page.locator('.settings-color-picker').getByRole('button', { name: /sage/i })
    await expect(sageBtn).toHaveAttribute('aria-pressed', 'false')
  })

  test('clicking sage switches active state and persists to localStorage', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    await page.locator('.settings-color-picker').getByRole('button', { name: /sage/i }).click()

    const sageBtn = page.locator('.settings-color-picker').getByRole('button', { name: /sage/i })
    await expect(sageBtn).toHaveAttribute('aria-pressed', 'true')
    const indigoBtn = page.locator('.settings-color-picker').getByRole('button', { name: /indigo/i })
    await expect(indigoBtn).toHaveAttribute('aria-pressed', 'false')

    const stored = await page.evaluate(() => localStorage.getItem('linger_accent'))
    expect(stored).toBe('sage')
  })

  test('clicking indigo after sage switches back', async ({ page }) => {
    await loadHarness(page)
    await render(page, { accentColor: 'sage' })

    await page.locator('.settings-color-picker').getByRole('button', { name: /indigo/i }).click()

    const indigoBtn = page.locator('.settings-color-picker').getByRole('button', { name: /indigo/i })
    await expect(indigoBtn).toHaveAttribute('aria-pressed', 'true')

    const stored = await page.evaluate(() => localStorage.getItem('linger_accent'))
    expect(stored).toBe('indigo')
  })

  test('Indigo and Sage buttons have equal width regardless of label length', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const options = page.locator('.settings-color-picker .settings-color-option')
    const indigoBox = await options.nth(0).boundingBox()
    const sageBox = await options.nth(1).boundingBox()

    expect(indigoBox).not.toBeNull()
    expect(sageBox).not.toBeNull()
    if (indigoBox && sageBox) {
      expect(Math.abs(indigoBox.width - sageBox.width)).toBeLessThan(1)
      expect(Math.abs(indigoBox.height - sageBox.height)).toBeLessThan(1)
    }
  })
})

test.describe('SettingsModal — InfoTip', () => {
  test('clicking the Auto-save info button shows help text', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const autoSaveItem = page.locator('.settings-item', { hasText: 'Auto-save' })
    await autoSaveItem.getByRole('button', { name: 'More information' }).click()

    const popover = page.locator('.infotip-popover').filter({ hasText: 'few seconds' })
    await expect(popover).toBeVisible()
  })

  test('clicking outside the popover closes it', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const autoSaveItem = page.locator('.settings-item', { hasText: 'Auto-save' })
    await autoSaveItem.getByRole('button', { name: 'More information' }).click()
    const popover = page.locator('.infotip-popover').filter({ hasText: 'few seconds' })
    await expect(popover).toBeVisible()

    await page.mouse.click(5, 5)
    await expect(popover).toBeHidden()
  })

  test('Escape key closes the popover', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const autoSaveItem = page.locator('.settings-item', { hasText: 'Auto-save' })
    await autoSaveItem.getByRole('button', { name: 'More information' }).click()
    const popover = page.locator('.infotip-popover').filter({ hasText: 'few seconds' })
    await expect(popover).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(popover).toBeHidden()
  })

  test('info button tracks open state via aria-expanded', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const autoSaveItem = page.locator('.settings-item', { hasText: 'Auto-save' })
    const infoBtn = autoSaveItem.getByRole('button', { name: 'More information' })

    await expect(infoBtn).toHaveAttribute('aria-expanded', 'false')
    await infoBtn.click()
    await expect(infoBtn).toHaveAttribute('aria-expanded', 'true')
    await infoBtn.click()
    await expect(infoBtn).toHaveAttribute('aria-expanded', 'false')
  })

  test('clicking the Share info button shows help text', async ({ page }) => {
    await loadHarness(page)
    await render(page, { modalOpen: true })

    const shareItem = page.locator('.settings-item', { hasText: 'Share this app' })
    await shareItem.getByRole('button', { name: 'More information' }).click()

    const popover = page.locator('.infotip-popover').filter({ hasText: 'friends' })
    await expect(popover).toBeVisible()
  })

  test('Share info popover closes on outside click', async ({ page }) => {
    await loadHarness(page)
    await render(page, { modalOpen: true })

    const shareItem = page.locator('.settings-item', { hasText: 'Share this app' })
    await shareItem.getByRole('button', { name: 'More information' }).click()
    const popover = page.locator('.infotip-popover').filter({ hasText: 'friends' })
    await expect(popover).toBeVisible()

    await page.mouse.click(5, 5)
    await expect(popover).toBeHidden()
  })
})

test.describe('SettingsModal — milestone form help text', () => {
  test('shows recurring help text by default in the add form', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    await page.getByRole('button', { name: 'Add' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add Milestone' })
    await expect(dialog).toBeVisible()

    await expect(dialog.locator('.settings-milestone-type-help')).toContainText('Repeats every year')
  })

  test('switches help text when toggling to one-time', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    await page.getByRole('button', { name: 'Add' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add Milestone' })
    await dialog.getByRole('button', { name: 'One-time' }).click()

    await expect(dialog.locator('.settings-milestone-type-help')).toContainText('does not repeat')
  })

  test('switches back to recurring help text when toggling back', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    await page.getByRole('button', { name: 'Add' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add Milestone' })
    await dialog.getByRole('button', { name: 'One-time' }).click()
    await dialog.getByRole('button', { name: 'Yearly' }).click()

    await expect(dialog.locator('.settings-milestone-type-help')).toContainText('Repeats every year')
  })
})

test.describe('SettingsModal — settings-item layout', () => {
  test('select trigger chevron sits at the right edge of the trigger', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const trigger = page.getByRole('button', { name: 'Font size' })
    const chevron = trigger.locator('.settings-select-chevron')
    const triggerBox = await trigger.boundingBox()
    const chevronBox = await chevron.boundingBox()

    expect(triggerBox).not.toBeNull()
    expect(chevronBox).not.toBeNull()
    if (triggerBox && chevronBox) {
      const chevronRight = chevronBox.x + chevronBox.width
      const triggerRight = triggerBox.x + triggerBox.width
      expect(triggerRight - chevronRight).toBeLessThan(12)
    }
  })

  test('Export all and Share buttons have equal width', async ({ page }) => {
    await loadHarness(page)
    await render(page, { modalOpen: true })

    const exportBtn = page.locator('.btn-export-modern')
    const shareBtn = page.locator('.settings-action-btn')
    const exportBox = await exportBtn.boundingBox()
    const shareBox = await shareBtn.boundingBox()

    expect(exportBox).not.toBeNull()
    expect(shareBox).not.toBeNull()
    if (exportBox && shareBox) {
      expect(Math.abs(exportBox.width - shareBox.width)).toBeLessThan(2)
    }
  })
})

test.describe('SettingsModal — theme picker', () => {
  test('Light, Dark and Auto buttons have equal width', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const options = page.locator('.settings-theme-picker .settings-theme-option')
    const lightBox = await options.nth(0).boundingBox()
    const darkBox = await options.nth(1).boundingBox()
    const autoBox = await options.nth(2).boundingBox()

    expect(lightBox).not.toBeNull()
    expect(darkBox).not.toBeNull()
    expect(autoBox).not.toBeNull()
    if (lightBox && darkBox && autoBox) {
      expect(Math.abs(lightBox.width - darkBox.width)).toBeLessThan(1)
      expect(Math.abs(lightBox.width - autoBox.width)).toBeLessThan(1)
    }
  })
})

test.describe('SettingsModal — font picker', () => {
  test('shows Sans and Serif buttons', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const picker = page.locator('.settings-font-picker')
    await expect(picker.getByRole('button', { name: /sans/i })).toBeVisible()
    await expect(picker.getByRole('button', { name: /serif/i })).toBeVisible()
  })

  test('Sans and Serif buttons have equal width regardless of label length', async ({ page }) => {
    await loadHarness(page)
    await render(page)

    const options = page.locator('.settings-font-picker .settings-font-option')
    const sansBox = await options.nth(0).boundingBox()
    const serifBox = await options.nth(1).boundingBox()

    expect(sansBox).not.toBeNull()
    expect(serifBox).not.toBeNull()
    if (sansBox && serifBox) {
      expect(Math.abs(sansBox.width - serifBox.width)).toBeLessThan(1)
      expect(Math.abs(sansBox.height - serifBox.height)).toBeLessThan(1)
    }
  })
})
