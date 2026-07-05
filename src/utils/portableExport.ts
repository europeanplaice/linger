import { escapeHtml } from './escapeHtml';

export interface DiaryExportEntry {
  date: string;
  content: string;
}

export function exportPortableHtml(entries: DiaryExportEntry[]): string {
  // Serialize JSON safely so script tags or quotes within contents cannot break out of HTML
  const safeJson = JSON.stringify(entries)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Linger Diary Backup</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #6366f1;
    }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 2rem;
      line-height: 1.6;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
    }
    header {
      margin-bottom: 2rem;
      border-bottom: 1px solid #334155;
      padding-bottom: 1rem;
    }
    .search-box {
      width: 100%;
      padding: 0.75rem;
      border-radius: 8px;
      border: 1px solid #334155;
      background: var(--card-bg);
      color: var(--text);
      font-size: 1rem;
      margin-bottom: 1.5rem;
      box-sizing: border-box;
    }
    .entry-card {
      background: var(--card-bg);
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    }
    .entry-date {
      font-size: 0.875rem;
      color: var(--accent);
      font-weight: 600;
      margin-bottom: 0.5rem;
    }
    .entry-content {
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>📖 Linger Diary Backup</h1>
      <p style="color: var(--text-muted)">Portable Standalone Viewer</p>
    </header>
    <input type="text" id="search" class="search-box" placeholder="Search entries..." oninput="filterEntries()" />
    <div id="entries-container"></div>
  </div>
  <script id="export-data" type="application/json">${safeJson}</script>
  <script>
    const data = JSON.parse(document.getElementById('export-data').textContent || '[]');
    function render(list) {
      const container = document.getElementById('entries-container');
      container.innerHTML = list.map(e => \`
        <div class="entry-card">
          <div class="entry-date">\${escapeHtml(e.date)}</div>
          <div class="entry-content">\${escapeHtml(e.content)}</div>
        </div>
      \`).join('');
    }
    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }
    function filterEntries() {
      const q = document.getElementById('search').value.toLowerCase();
      const filtered = data.filter(e => e.date.includes(q) || e.content.toLowerCase().includes(q));
      render(filtered);
    }
    render(data);
  </script>
</body>
</html>`;
}

export function generateDiaryCardHtml(entry: DiaryExportEntry): string {
  const safeDate = escapeHtml(entry.date);
  const safeContent = escapeHtml(entry.content);

  return `<div class="diary-card" style="background: linear-gradient(135deg, #1e1b4b 0%, #312e81 100%); color: #f8fafc; padding: 2rem; border-radius: 16px; font-family: sans-serif; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3); max-width: 500px;">
  <div style="font-size: 0.875rem; color: #a5b4fc; text-transform: uppercase; tracking: 0.05em; font-weight: 700; margin-bottom: 0.75rem;">${safeDate}</div>
  <div style="font-size: 1.125rem; line-height: 1.6; white-space: pre-wrap;">${safeContent}</div>
  <div style="margin-top: 1.5rem; text-align: right; font-size: 0.75rem; color: #818cf8;">✨ Written with Linger</div>
</div>`;
}
