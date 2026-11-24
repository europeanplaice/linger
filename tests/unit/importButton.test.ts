import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { ArchiveTooLargeError, parseZip } from '../../src/components/ImportButton'

async function makeZipFile(files: Record<string, string>, name = 'export.zip'): Promise<File> {
  const zip = new JSZip()
  for (const [entryName, content] of Object.entries(files)) {
    zip.file(entryName, content)
  }
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  return new File([new Uint8Array(bytes)], name, { type: 'application/zip' })
}

const smallLimits = {
  maxZipFileBytes: 100_000,
  maxZipFiles: 5,
  maxEntryChars: 50,
  maxMilestonesChars: 100,
  maxTotalExtractedChars: 120,
}

describe('ImportButton parseZip bounds', () => {
  it('parses a valid ZIP within limits', async () => {
    const file = await makeZipFile({
      'diary-2026-05-01.txt': 'hello world',
      'milestones.json': JSON.stringify([{ id: 'm1', label: 'Start', date: '2026-05-01' }]),
    })
    const result = await parseZip(file, smallLimits)
    expect(result.entries).toEqual([{ date: '2026-05-01', content: 'hello world' }])
    expect(result.milestones).toHaveLength(1)
  })

  it('rejects a ZIP archive larger than maxZipFileBytes before decompression', async () => {
    const file = await makeZipFile({ 'diary-2026-05-01.txt': 'hello' })
    await expect(parseZip(file, { ...smallLimits, maxZipFileBytes: 10 })).rejects.toBeInstanceOf(ArchiveTooLargeError)
  })

  it('rejects a ZIP containing more than maxZipFiles entries', async () => {
    const file = await makeZipFile({
      'a.txt': '1', 'b.txt': '2', 'c.txt': '3', 'd.txt': '4', 'e.txt': '5', 'f.txt': '6',
    })
    await expect(parseZip(file, smallLimits)).rejects.toBeInstanceOf(ArchiveTooLargeError)
  })

  it('rejects an individual diary entry larger than maxEntryChars', async () => {
    const file = await makeZipFile({ 'diary-2026-05-01.txt': 'x'.repeat(51) })
    await expect(parseZip(file, smallLimits)).rejects.toBeInstanceOf(ArchiveTooLargeError)
  })

  it('rejects cumulative decompressed content exceeding maxTotalExtractedChars', async () => {
    const file = await makeZipFile({
      'diary-2026-05-01.txt': 'a'.repeat(45),
      'diary-2026-05-02.txt': 'b'.repeat(45),
      'diary-2026-05-03.txt': 'c'.repeat(45),
    })
    await expect(parseZip(file, smallLimits)).rejects.toBeInstanceOf(ArchiveTooLargeError)
  })

  it('rejects an oversized milestones.json file', async () => {
    const file = await makeZipFile({
      'milestones.json': JSON.stringify([{ id: 'm1', label: 'x'.repeat(120), date: '2026-05-01' }]),
    })
    await expect(parseZip(file, smallLimits)).rejects.toBeInstanceOf(ArchiveTooLargeError)
  })
})
