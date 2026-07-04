import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import type { ChangeEvent } from 'react'
import type JSZip from 'jszip'
import { useI18n } from '../i18n'
import type { ImportResult } from '../hooks/useDiary'
import { normalizeMilestones, type Milestone } from '../types'

interface ParsedEntry {
  date: string
  content: string
}

interface ParsedZip {
  entries: ParsedEntry[]
  milestones: Milestone[]
}

interface MilestoneImportResult {
  imported: number
  skipped: number
}

interface ImportButtonProps {
  existingDates: string[]
  onImport: (entries: ParsedEntry[], onProgress: (done: number, total: number) => void) => Promise<ImportResult>
  existingMilestones?: Milestone[]
  onImportMilestones?: (milestones: Milestone[]) => MilestoneImportResult
}

// Matches the app's own export filenames and the raw files Google Drive
// produces when a user downloads the linger_diary folder directly — both
// flat and nested inside a folder path within the zip.
const DIARY_FILENAME = /^diary-(\d{4}-\d{2}-\d{2})\.(?:txt|md)$/
const MILESTONES_FILENAME = 'milestones.json'
const LEGACY_MILESTONES_FILENAME = 'anniversaries.json'

// Legacy .md entries carry a `---\ndate: …\n---` frontmatter block; the date
// there is never authoritative (the filename is), so only the body is kept.
function stripFrontmatter(text: string): string {
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/)
  return match ? match[1].replace(/^\n/, '') : text
}

async function parseZip(file: File): Promise<ParsedZip> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(file)
  const entries: ParsedEntry[] = []
  let milestonesEntry: JSZip.JSZipObject | null = null

  for (const zipEntry of Object.values(zip.files)) {
    if (zipEntry.dir) continue
    const basename = zipEntry.name.split('/').pop() ?? ''

    const diaryMatch = DIARY_FILENAME.exec(basename)
    if (diaryMatch) {
      const content = await zipEntry.async('string')
      entries.push({ date: diaryMatch[1], content: stripFrontmatter(content) })
      continue
    }

    // milestones.json (current) always wins over anniversaries.json (legacy)
    // regardless of which order the zip happens to iterate them in.
    if (basename === MILESTONES_FILENAME) {
      milestonesEntry = zipEntry
    } else if (basename === LEGACY_MILESTONES_FILENAME && !milestonesEntry) {
      milestonesEntry = zipEntry
    }
  }

  let milestones: Milestone[] = []
  if (milestonesEntry) {
    try {
      milestones = normalizeMilestones(JSON.parse(await milestonesEntry.async('string')))
    } catch (err) {
      console.error('Import: failed to parse milestones file', err)
    }
  }

  return { entries, milestones }
}

type Phase = 'idle' | 'confirming' | 'importing' | 'done' | 'error'

export function ImportButton({ existingDates, onImport, existingMilestones = [], onImportMilestones }: ImportButtonProps) {
  const { t } = useI18n()
  const [phase, setPhase] = useState<Phase>('idle')
  const [parsed, setParsed] = useState<ParsedZip | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [milestoneResult, setMilestoneResult] = useState<MilestoneImportResult | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const existingDatesSet = useMemo(() => new Set(existingDates), [existingDates])
  const toSkipCount = useMemo(() => parsed?.entries.filter(e => existingDatesSet.has(e.date)).length ?? 0, [parsed, existingDatesSet])
  const toImportCount = (parsed?.entries.length ?? 0) - toSkipCount

  const existingMilestoneKeys = useMemo(() => new Set(existingMilestones.map(m => `${m.date}|${m.label}`)), [existingMilestones])
  const milestoneToSkipCount = useMemo(
    () => parsed?.milestones.filter(m => existingMilestoneKeys.has(`${m.date}|${m.label}`)).length ?? 0,
    [parsed, existingMilestoneKeys],
  )
  const milestoneToImportCount = (parsed?.milestones.length ?? 0) - milestoneToSkipCount

  const dialogOpen = phase !== 'idle'

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (dialogOpen) {
      dialog.showModal()
    } else if (dialog.open) {
      dialog.close()
    }
  }, [dialogOpen])

  const close = useCallback(() => {
    if (phase === 'importing') return
    setPhase('idle')
    setParsed(null)
    setResult(null)
    setMilestoneResult(null)
    setErrorMsg(null)
    setProgress(null)
  }, [phase])

  const handleButtonClick = () => {
    inputRef.current?.click()
  }

  const handleFileChange = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    try {
      const zip = await parseZip(file)
      if (zip.entries.length === 0 && zip.milestones.length === 0) {
        setErrorMsg(t.import.noEntriesFound)
        setPhase('error')
        return
      }
      setParsed(zip)
      setPhase('confirming')
    } catch (err) {
      console.error('Import parse failed:', err)
      setErrorMsg(t.import.invalidFile)
      setPhase('error')
    }
  }, [t])

  const doImport = useCallback(async () => {
    if (!parsed) return
    setPhase('importing')
    setProgress({ done: 0, total: parsed.entries.length })
    try {
      if (parsed.entries.length > 0) {
        const res = await onImport(parsed.entries, (done, total) => setProgress({ done, total }))
        setResult(res)
      }
      if (parsed.milestones.length > 0 && onImportMilestones) {
        setMilestoneResult(onImportMilestones(parsed.milestones))
      }
      setPhase('done')
    } catch (err) {
      // A global session-expired flow (triggered inside onImport itself)
      // takes over the screen in the realistic failure case here, so this
      // dialog just steps out of the way rather than showing a stale message.
      console.error('Import failed:', err)
      setPhase('idle')
      setParsed(null)
      setProgress(null)
    }
  }, [parsed, onImport, onImportMilestones])

  return (
    <div className="settings-import">
      <input
        ref={inputRef}
        type="file"
        accept=".zip"
        hidden
        onChange={e => { void handleFileChange(e) }}
      />
      <button
        className="btn-import-modern"
        onClick={handleButtonClick}
        disabled={phase !== 'idle'}
        title={t.import.title}
      >
        <svg className="btn-import-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <span>{t.import.importEntries}</span>
      </button>

      <dialog
        ref={dialogRef}
        className="import-confirm-dialog"
        aria-labelledby="import-confirm-title"
        onCancel={e => { e.preventDefault(); close() }}
        onClick={e => { if (e.target === dialogRef.current) close() }}
      >
        {phase === 'confirming' && parsed && (
          <>
            <h4 id="import-confirm-title" className="import-confirm-title">{t.import.confirmTitle}</h4>
            {parsed.entries.length > 0 && (
              <p className="import-confirm-desc">{t.import.confirmDesc(toImportCount, toSkipCount)}</p>
            )}
            {parsed.milestones.length > 0 && (
              <p className="import-confirm-desc">{t.import.confirmDescMilestones(milestoneToImportCount, milestoneToSkipCount)}</p>
            )}
            <div className="import-confirm-actions">
              <button className="import-confirm-cancel" onClick={close}>{t.common.cancel}</button>
              <button className="import-confirm-start" onClick={() => { void doImport() }}>{t.import.start}</button>
            </div>
          </>
        )}
        {phase === 'importing' && (
          <>
            <h4 id="import-confirm-title" className="import-confirm-title">{t.import.importEntries}</h4>
            <p className="import-confirm-desc">{progress ? t.import.progress(progress.done, progress.total) : ''}</p>
          </>
        )}
        {phase === 'done' && (result || milestoneResult) && (
          <>
            <h4 id="import-confirm-title" className="import-confirm-title">{t.import.importEntries}</h4>
            {result && (
              <p className="import-confirm-desc">{t.import.resultSummary(result.imported.length, result.skipped.length, result.failed.length)}</p>
            )}
            {milestoneResult && (
              <p className="import-confirm-desc">{t.import.resultSummaryMilestones(milestoneResult.imported, milestoneResult.skipped)}</p>
            )}
            <div className="import-confirm-actions">
              <button className="import-confirm-start" onClick={close}>{t.import.done}</button>
            </div>
          </>
        )}
        {phase === 'error' && (
          <>
            <h4 id="import-confirm-title" className="import-confirm-title">{t.import.importEntries}</h4>
            <p className="import-confirm-desc">{errorMsg}</p>
            <div className="import-confirm-actions">
              <button className="import-confirm-start" onClick={close}>{t.common.close}</button>
            </div>
          </>
        )}
      </dialog>
    </div>
  )
}
