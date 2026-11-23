// Parses a diary file body. The authoritative date comes from the filename and
// is passed in via `date`. Legacy files carry a `---\ndate: …\n---` frontmatter
// block: when present it is stripped from the body, and its date is used as a
// fallback if no `date` was provided. New files have no frontmatter, so the
// whole text is the body. Never throws.
export function parseDriveEntry(text: string, date: string): { date: string; content: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (match) {
    const frontmatter = match[1]
    const fmDate = frontmatter.match(/^date:\s*(.+)$/m)?.[1]?.trim() ?? ''
    // Ordinary Markdown separators are diary text, not a legacy file header.
    if (/^\d{4}-\d{2}-\d{2}$/.test(fmDate)) {
      const content = match[2].replace(/^\r?\n/, '')
      return { date: date || fmDate, content }
    }
  }
  return { date, content: text }
}
