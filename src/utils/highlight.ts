export type TextSegment = string | { text: string; highlight: true }

/**
 * Splits `text` into plain and highlighted segments based on `tokens`.
 *
 * Tokens are matched case-insensitively on NFKC-normalized text so that
 * TF-IDF bigrams (which are generated from normalized input) map back to
 * the original characters. Adjacent or overlapping matches are merged into
 * a single span — this means consecutive bigrams like '今日' + '日は' produce
 * a single '今日は' highlight rather than two overlapping markers.
 *
 * Positions are tracked as Unicode codepoint indices (via [...str]) rather
 * than UTF-16 code unit indices so that emoji and other astral-plane
 * characters are handled correctly.
 */
export function highlightText(text: string, tokens: string[]): TextSegment[] {
  if (!text) return [text]
  if (tokens.length === 0) return [text]

  const chars = [...text]
  const normalized = [...text.normalize('NFKC').toLowerCase()]

  // Find all [start, end) ranges in codepoint space
  const ranges: [number, number][] = []
  for (const token of tokens) {
    const tChars = [...token]
    const tLen = tChars.length
    if (tLen === 0) continue
    outer: for (let i = 0; i <= normalized.length - tLen; i++) {
      for (let j = 0; j < tLen; j++) {
        if (normalized[i + j] !== tChars[j]) continue outer
      }
      ranges.push([i, i + tLen])
    }
  }

  if (ranges.length === 0) return [text]

  // Sort and merge overlapping/adjacent ranges
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: [number, number][] = []
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end)
    } else {
      merged.push([start, end])
    }
  }

  // Build segment array from merged ranges
  const segments: TextSegment[] = []
  let pos = 0
  for (const [start, end] of merged) {
    if (pos < start) segments.push(chars.slice(pos, start).join(''))
    segments.push({ text: chars.slice(start, end).join(''), highlight: true })
    pos = end
  }
  if (pos < chars.length) segments.push(chars.slice(pos).join(''))

  return segments
}
