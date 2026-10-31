import type { Data, Env } from './session'
import { jsonResponse } from './session'

export interface DiaryWriterAuth {
  sessionId: string
  accountKey: string
}

export interface DiaryMutationInput extends DiaryWriterAuth {
  date: string
  method: 'POST' | 'DELETE'
  body?: string
  fileId?: string
  baseVersion?: string
}

export interface DiaryWriterService {
  ensureDiaryFolder(input: DiaryWriterAuth): Promise<string>
  mutateDiaryEntry(input: DiaryMutationInput): Promise<Response>
}

// Never fall back to an uncoordinated write when the service is unavailable.
export const forwardDiaryMutation: PagesFunction<Env, 'date', Data> = async context => {
  const date = context.params.date as string
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonResponse({ error: 'Invalid date' }, 400)
  const accountKey = context.data.session?.google_sub
  if (!accountKey) return jsonResponse({ error: 'Please sign in again' }, 401)
  const writer = context.env.S3_WORKFLOW_SERVICE
  if (!writer) return jsonResponse({ error: 'Diary writer temporarily unavailable' }, 503)

  let body: string | undefined
  if (context.request.method === 'POST') {
    // Bound the actual streamed body, including requests without Content-Length.
    const reader = context.request.body?.getReader()
    if (!reader) return jsonResponse({ error: 'Invalid JSON body' }, 400)
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 1_000_000) {
        await reader.cancel()
        return jsonResponse({ error: 'Entry is too large' }, 413)
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    body = new TextDecoder().decode(bytes)
  }
  try {
    return await writer.mutateDiaryEntry({
      sessionId: context.data.sessionId, accountKey, date,
      method: context.request.method === 'DELETE' ? 'DELETE' : 'POST', body,
      fileId: context.request.headers.get('X-Linger-File-Id') ?? undefined,
      baseVersion: context.request.headers.get('If-Match') ?? undefined,
    })
  } catch {
    return jsonResponse({ error: 'Diary writer temporarily unavailable' }, 503)
  }
}
