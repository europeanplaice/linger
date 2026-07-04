import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import type { ChangeEvent } from 'react'
import { useI18n } from '../i18n'
import type { ImportResult } from '../hooks/useDiary'

interface ParsedEntry {
  date: string
  content: string
}

interface ImportButtonProps {
  existingDates: string[]
  onImport: (entries: ParsedEntry[], onProgress: (done: number, total: number) => void) => Promise<ImportResult>
}

// Matches the app's own export filenames and the raw files Google Drive
// produces when a user downloads the linger_diary folder directly — both
// flat and nested inside a folder path within the zip.
const DIARY_FILENAME = /^diary-(\d{4}-\d{2}-\d{2})\.(?:txt|md)$/

// Legacy .md entries carry a `---\ndate: …\n---` frontmatter block; the date
// there is never authoritative (the filename is), so only the body is kept.
function stripFrontmatter(text: string): string {
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/)
  return match ? match[1].replace(/^\n/, '') : text
}

async function parseZip(file: File): Promise<ParsedEntry[]> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(file)
  const entries: ParsedEntry[] = []
  for (const zipEntry of Object.values(zip.files)) {
    if (zipEntry.dir) continue
    const basename = zipEntry.name.split('/').pop() ?? ''
    const match = DIARY_FILENAME.exec(basename)
    if (!match) continue
    const content = await zipEntry.async('string')
    entries.push({ date: match[1], content: stripFrontmatter(content) })
  }
  return entries
}

type Phase = 'idle' | 'confirming' | 'importing' | 'done' | 'error'

export function ImportButton({ existingDates, onImport }: ImportButtonProps) {
  const { t } = useI18n()
  const [phase, setPhase] = useState<Phase>('idle')
  const [parsed, setParsed] = useState<ParsedEntry[] | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const existingSet = useMemo(() => new Set(existingDates), [existingDates])
  const toSkipCount = useMemo(() => parsed?.filter(e => existingSet.has(e.date)).length ?? 0, [parsed, existingSet])
  const toImportCount = (parsed?.length ?? 0) - toSkipCount

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
      const entries = await parseZip(file)
      if (entries.length === 0) {
        setErrorMsg(t.import.noEntriesFound)
        setPhase('error')
        return
      }
      setParsed(entries)
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
    setProgress({ done: 0, total: parsed.length })
    try {
      const res = await onImport(parsed, (done, total) => setProgress({ done, total }))
      setResult(res)
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
  }, [parsed, onImport])

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
        {phase === 'confirming' && (
          <>
            <h4 id="import-confirm-title" className="import-confirm-title">{t.import.confirmTitle}</h4>
            <p className="import-confirm-desc">{t.import.confirmDesc(toImportCount, toSkipCount)}</p>
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
        {phase === 'done' && result && (
          <>
            <h4 id="import-confirm-title" className="import-confirm-title">{t.import.importEntries}</h4>
            <p className="import-confirm-desc">{t.import.resultSummary(result.imported.length, result.skipped.length, result.failed.length)}</p>
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
