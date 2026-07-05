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

  it('returns stable version and modifiedTime that match the last save', async () => {
    const first = await adapter.saveEntry('2026-07-05', 'First draft');
    const second = await adapter.saveEntry('2026-07-05', 'Second draft');

    expect(Number(second.meta.version)).toBeGreaterThan(Number(first.meta.version));

    const loadedA = await adapter.getEntry('2026-07-05');
    const loadedB = await adapter.getEntry('2026-07-05');
    expect(loadedA?.meta.version).toBe(second.meta.version);
    expect(loadedA?.meta.modifiedTime).toBe(second.meta.modifiedTime);
    expect(loadedB?.meta.modifiedTime).toBe(loadedA?.meta.modifiedTime);
  });

  it('reads a legacy plain-string record as content', async () => {
    localStorage.setItem('linger_local_entry_2026-01-01', 'Plain legacy content');

    const loaded = await adapter.getEntry('2026-01-01');
    expect(loaded?.entry.content).toBe('Plain legacy content');
    expect(loaded?.meta.version).toBe('1');
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
