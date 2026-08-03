import { beforeAll, describe, expect, test } from 'vitest'
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = process.cwd()
const DIST = resolve(ROOT, 'dist')
const ASSETS = resolve(DIST, 'assets')

const SPLITS = [
  { name: 'SettingsModal', marker: 'settings-dialog' },
  { name: 'RecollectionJourney', marker: 'recollection-dialog' },
  { name: 'HistoryModal', marker: 'history-dialog' },
  { name: 'MilestoneFormModal', marker: 'milestone-form-dialog' },
]

beforeAll(() => {
  execSync('npx vite build', { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
}, 120_000)

function jsChunks(): string[] {
  return readdirSync(ASSETS)
    .filter((file) => file.endsWith('.js'))
    .map((file) => resolve(ASSETS, file))
}

function entryChunk(): string {
  const html = readFileSync(resolve(DIST, 'index.html'), 'utf-8')
  const match = html.match(/src="\/assets\/(index-[^"]+\.js)"/)
  if (!match) throw new Error('entry script tag not found in dist/index.html')
  return resolve(ASSETS, match[1])
}

describe('code splitting', () => {
  test('heavy modal components are split out of the entry chunk', () => {
    const entry = readFileSync(entryChunk(), 'utf-8')
    for (const { name, marker } of SPLITS) {
      expect(entry, `${name} should not be bundled into the entry chunk`).not.toContain(marker)
    }
  })

  test('each split component lives in its own non-entry chunk', () => {
    const chunks = jsChunks()
    const entry = entryChunk()
    const nonEntry = chunks.filter((chunk) => chunk !== entry)
    for (const { name, marker } of SPLITS) {
      const owner = nonEntry.find((chunk) => readFileSync(chunk, 'utf-8').includes(marker))
      expect(owner, `${name} should have its own lazy chunk`).toBeDefined()
    }
  })
})
