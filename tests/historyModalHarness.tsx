import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HistoryModal } from '../src/components/HistoryModal'
import { EntryConflictError } from '../src/hooks/useDiary'
import type { LoadedDiaryEntry } from '../src/types'
import { I18nProvider } from '../src/i18n'
import '../src/styles.css'

type FetchCall = { url: string; method: string }
type Response_ = { status: number; body: unknown; delayMs?: number }
type SaveCall = { date: string; content: string; baseVersion: string | null; force?: boolean }
type FullSaveCall = SaveCall & { baseContent?: string | null }

const fetchCalls: FetchCall[] = []
// Responses are matched by URL so concurrent prefetch requests resolve deterministically.
let listResponse: Response_ | null = null
const contentResponses = new Map<string, Response_>()
let renderCount = 0
const saveCalls: SaveCall[] = []
const fullSaveCalls: FullSaveCall[] = []
const restoredCalls: LoadedDiaryEntry[] = []
let closeCalls = 0
let expiredCalls = 0
let saveReject: 'conflict' | 'error' | null = null

// content URL: /api/drive/revisions/<fileId>/<revisionId>
const CONTENT_RE = /\/api\/drive\/revisions\/[^/]+\/([^/]+)$/

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  fetchCalls.push({ url, method: String(init?.method ?? 'GET') })

  const match = url.match(CONTENT_RE)
  const resp = match ? contentResponses.get(match[1]) : listResponse

  // Unconfigured content (e.g. a revision the test didn't supply) resolves as 404
  // so background prefetch fails quietly without throwing.
  const effective: Response_ = resp ?? { status: 404, body: { error: 'Not found' } }

  if (effective.delayMs) {
    await new Promise(r => setTimeout(r, effective.delayMs))
  }
  return {
    status: effective.status,
    ok: effective.status >= 200 && effective.status < 300,
    headers: new Headers(),
    json: async () => effective.body,
    text: async () => JSON.stringify(effective.body),
  } as Response
}

interface AppProps {
  date: string
  fileId: string
  baseVersion: string | null
  text: string
  savedText: string
  isDirty: boolean
  autoSave: boolean
}

function App({ date, fileId, baseVersion, text, savedText, isDirty, autoSave }: AppProps) {
  const [open, setOpen] = useState(true)

  if (!open) return <div id="modal-closed">closed</div>

  return (
    <HistoryModal
      date={date}
      fileId={fileId}
      baseVersion={baseVersion}
      text={text}
      savedText={savedText}
      isDirty={isDirty}
      autoSave={autoSave}
      onSave={async (d, content, bv, force, baseContent) => {
        saveCalls.push({ date: d, content, baseVersion: bv, force })
        fullSaveCalls.push({ date: d, content, baseVersion: bv, force, baseContent })
        if (saveReject === 'conflict') {
          const remote: LoadedDiaryEntry = {
            entry: { date: d, content: 'remote' },
            meta: { id: fileId, name: `diary-${d}.json`, version: '99' },
          }
          throw new EntryConflictError(remote)
        }
        if (saveReject === 'error') throw new Error('Network error')
        return {
          entry: { date: d, content },
          meta: { id: fileId, name: `diary-${d}.json`, version: '10' },
        }
      }}
      onRestored={(result) => {
        restoredCalls.push(result)
        setOpen(false)
      }}
      onClose={() => { closeCalls++; setOpen(false) }}
      onExpired={() => { expiredCalls++ }}
    />
  )
}

const root = createRoot(document.getElementById('root') as HTMLElement)

type RenderOpts = { date?: string; fileId?: string; baseVersion?: string | null; text?: string; savedText?: string; isDirty?: boolean; autoSave?: boolean }

window.historyHarness = {
  // Configure the revision list response.
  list: (resp: Response_) => { listResponse = resp },
  // Configure per-revision content responses, keyed by revision id.
  content: (responses: Record<string, Response_>) => {
    for (const [id, resp] of Object.entries(responses)) contentResponses.set(id, resp)
  },
  render: (opts: RenderOpts = {}) => {
    fetchCalls.splice(0)
    saveCalls.splice(0)
    fullSaveCalls.splice(0)
    restoredCalls.splice(0)
    closeCalls = 0
    expiredCalls = 0
    saveReject = null
    root.render(
      <I18nProvider>
        <App
          date={opts.date ?? '2026-05-01'}
          fileId={opts.fileId ?? 'file-123'}
          baseVersion={opts.baseVersion ?? null}
          text={opts.text ?? ''}
          savedText={opts.savedText ?? ''}
          isDirty={opts.isDirty ?? false}
          autoSave={opts.autoSave ?? true}
          key={++renderCount}
        />
      </I18nProvider>
    )
  },
  reset: () => {
    listResponse = null
    contentResponses.clear()
  },
  calls: () => [...fetchCalls],
  saveCalls: () => [...saveCalls],
  saveCallsWithBaseContent: () => [...fullSaveCalls],
  restoredCalls: () => [...restoredCalls],
  closeCalls: () => closeCalls,
  expiredCalls: () => expiredCalls,
  setSaveReject: (v: 'conflict' | 'error' | null) => { saveReject = v },
}
