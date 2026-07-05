import { describe, it, expect } from 'vitest';
import { exportPortableHtml, generateDiaryCardHtml } from '../../src/utils/portableExport';

describe('portableExport utility', () => {
  const sampleEntries = [
    { date: '2026-07-05', content: 'Awesome day writing TDD code with Antigravity AI!' },
    { date: '2026-07-04', content: 'Relaxing weekend reading books.' },
  ];

  it('generates self-contained HTML containing all diary entries', () => {
    const html = exportPortableHtml(sampleEntries);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Linger Diary Backup');
    expect(html).toContain('2026-07-05');
    expect(html).toContain('Awesome day writing TDD code with Antigravity AI!');
  });

  it('safely escapes XSS injection attempts in entries and scripts', () => {
    const maliciousEntries = [
      {
        date: '2026-07-05"><script>alert("xss")</script>',
        content: '</script><script>console.log("hacked")</script>',
      },
    ];

    const html = exportPortableHtml(maliciousEntries);
    // Should use application/json script block or escape script tags
    expect(html).not.toContain('</script><script>console.log("hacked")</script>');
    expect(html).toContain('type="application/json"');

    const cardHtml = generateDiaryCardHtml(maliciousEntries[0]);
    expect(cardHtml).not.toContain('<script>');
    expect(cardHtml).toContain('&lt;script&gt;');
  });
});
