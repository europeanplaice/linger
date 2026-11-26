export interface DiffLine {
  text: string
  changed: boolean
}

export interface SideBySideDiff {
  localLines: DiffLine[]
  remoteLines: DiffLine[]
}

const MAX_LCS_CELLS = 250_000

function splitLines(text: string): string[] {
  if (text === '') return []
  return text.replace(/\r\n/g, '\n').split('\n')
}

/**
 * Computes a side-by-side line diff marking lines that differ between
 * `local` and `remote`. Falls back to a simple set/index comparison for
 * very large texts to keep UI rendering instantaneous.
 */
export function diffConflictLines(local: string, remote: string): SideBySideDiff {
  const a = splitLines(local)
  const b = splitLines(remote)
  const m = a.length
  const n = b.length

  if (m === 0 || n === 0) {
    return {
      localLines: a.map(text => ({ text, changed: true })),
      remoteLines: b.map(text => ({ text, changed: true })),
    }
  }

  if (m * n > MAX_LCS_CELLS) {
    const bSet = new Set(b)
    const aSet = new Set(a)
    return {
      localLines: a.map(text => ({ text, changed: !bSet.has(text) })),
      remoteLines: b.map(text => ({ text, changed: !aSet.has(text) })),
    }
  }

  // Standard LCS DP table using a flat Uint32Array for speed and low GC pressure.
  const stride = n + 1
  const dp = new Uint32Array((m + 1) * stride)
  for (let i = m - 1; i >= 0; i--) {
    const row = i * stride
    const nextRow = (i + 1) * stride
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[row + j] = dp[nextRow + j + 1] + 1
      } else {
        const down = dp[nextRow + j]
        const right = dp[row + j + 1]
        dp[row + j] = down >= right ? down : right
      }
    }
  }

  const localLines: DiffLine[] = []
  const remoteLines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      localLines.push({ text: a[i], changed: false })
      remoteLines.push({ text: b[j], changed: false })
      i++
      j++
    } else if (dp[(i + 1) * stride + j] >= dp[i * stride + (j + 1)]) {
      localLines.push({ text: a[i], changed: true })
      i++
    } else {
      remoteLines.push({ text: b[j], changed: true })
      j++
    }
  }
  while (i < m) {
    localLines.push({ text: a[i], changed: true })
    i++
  }
  while (j < n) {
    remoteLines.push({ text: b[j], changed: true })
    j++
  }

  return { localLines, remoteLines }
}

export interface MergeConflictResult {
  text: string
  kind: 'auto-append' | 'combined'
}

function joinSegments(first: string, second: string): string {
  if (!first) return second
  if (!second) return first
  if (first.endsWith('\n') || second.startsWith('\n')) return first + second
  return `${first}\n${second}`
}

/**
 * Combines `local` and `remote` texts without losing content.
 *
 * When both devices only appended text after the same non-empty `base`,
 * merges cleanly by keeping `base` once followed by both additions
 * (`kind: 'auto-append'`). Otherwise combines both versions with a clear
 * separator (`kind: 'combined'`).
 */
export function mergeConflictTexts(
  local: string,
  remote: string,
  base: string | null | undefined,
  separator = '\n\n---\n\n',
): MergeConflictResult {
  if (local === remote) return { text: local, kind: 'auto-append' }
  if (!local.trim()) return { text: remote, kind: 'auto-append' }
  if (!remote.trim()) return { text: local, kind: 'auto-append' }

  if (base && local.startsWith(base) && remote.startsWith(base)) {
    const localAdded = local.slice(base.length)
    const remoteAdded = remote.slice(base.length)
    if (!localAdded) return { text: remote, kind: 'auto-append' }
    if (!remoteAdded) return { text: local, kind: 'auto-append' }
    if (localAdded === remoteAdded) return { text: local, kind: 'auto-append' }
    return {
      text: joinSegments(remote, localAdded.replace(/^\n+/, '')),
      kind: 'auto-append',
    }
  }

  return {
    text: `${remote.trimEnd()}${separator}${local.trimStart()}`,
    kind: 'combined',
  }
}
