import { describe, it, expect, beforeEach } from 'vitest';
import { LocalStorageAdapter } from '../../src/lib/storageAdapter';

describe('LocalStorageAdapter', () => {
  let adapter: LocalStorageAdapter;

  beforeEach(() => {
    localStorage.clear();
    adapter = new LocalStorageAdapter();
  });

  it('reports mode as local', () => {
    expect(adapter.getMode()).toBe('local');
  });

  it('saves and reads entries from local storage', async () => {
    const saved = await adapter.saveEntry('2026-07-05', 'Today was a productive TDD day!');

    expect(saved.entry.content).toBe('Today was a productive TDD day!');
    expect(saved.entry.date).toBe('2026-07-05');

    const loaded = await adapter.getEntry('2026-07-05');
    expect(loaded?.entry.content).toBe('Today was a productive TDD day!');

    const list = await adapter.listEntries();
    expect(list).toContain('2026-07-05');
  });

  it('deletes an entry from local storage', async () => {
    await adapter.saveEntry('2026-07-05', 'To be deleted');
    await adapter.deleteEntry('2026-07-05');

    const loaded = await adapter.getEntry('2026-07-05');
    expect(loaded).toBeNull();

    const list = await adapter.listEntries();
    expect(list).not.toContain('2026-07-05');
  });
});
