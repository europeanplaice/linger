export function excerpt(content: string, max = 140): string {
  const text = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean).join('  ')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
