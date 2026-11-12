import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActiveAccount } from '../../src/lib/accountSession';
import { unlockVaultWithKey } from '../../src/lib/passkeyVault';
import { SyncQueueManager } from '../../src/lib/syncQueue';

describe('SyncQueueManager', () => {
  let queueManager: SyncQueueManager;

  const setAccount = (email: string) => { setActiveAccount(`email:${email}`, false, email); unlockVaultWithKey(email, new Uint8Array(32).fill(email.startsWith('a') ? 1 : 2)); };
  beforeEach(() => {
    localStorage.clear();
    const email = `${crypto.randomUUID()}@example.com`;
    setAccount(email);
    queueManager = new SyncQueueManager(email);
  });

  it('retains independent operations from multiple tab instances', async () => {
    const other = new SyncQueueManager();
    await Promise.all([
      queueManager.enqueue({ id: 'a', type: 'REMOVE', date: '2026-05-01', timestamp: 1 }),
      other.enqueue({ id: 'b', type: 'REMOVE', date: '2026-05-02', timestamp: 2 }),
    ]);
    expect((await new SyncQueueManager().getPending()).map(item => item.id)).toEqual(['a', 'b']);
  });

  it('does not resurrect another tab\'s completed operation from stale memory', async () => {
    await queueManager.enqueue({ id: 'a', type: 'REMOVE', date: '2026-05-01', timestamp: 1 });
    const other = new SyncQueueManager();
    await other.dequeue('a');
    await queueManager.enqueue({ id: 'b', type: 'REMOVE', date: '2026-05-02', timestamp: 2 });
    expect((await other.getPending()).map(item => item.id)).toEqual(['b']);
  });

  it('preserves a replacement queued while an earlier operation is processing', async () => {
    await queueManager.enqueue({ id: 'a', type: 'REMOVE', date: '2026-05-01', timestamp: 1 });
    await queueManager.process(async () => {
      await new SyncQueueManager().enqueue({ id: 'b', type: 'REMOVE', date: '2026-05-01', timestamp: 2 });
      return true;
    });
    expect((await queueManager.getPending()).map(item => item.id)).toEqual(['b']);
  });

  it('partitions queues by account and prevents reading another account', async () => {
    setAccount('a@example.com');
    const a = new SyncQueueManager('a@example.com');
    await a.enqueue({ id: 'a', type: 'REMOVE', date: '2026-05-01', timestamp: 1 });
    setAccount('b@example.com');
    const b = new SyncQueueManager('b@example.com');
    await b.enqueue({ id: 'b', type: 'REMOVE', date: '2026-05-01', timestamp: 2 });
    await expect(a.getPending()).rejects.toThrow();
    await b.clear();
    setAccount('a@example.com');
    expect((await a.getPending()).map(item => item.id)).toEqual(['a']);
  });

  it('migrates a legacy queue for its owner without importing it into another account', async () => {
    setAccount('a@example.com');
    await new SyncQueueManager('a@example.com').clear();
    localStorage.setItem('linger_session_user', 'a@example.com');
    localStorage.setItem('linger_pending_sync_queue', JSON.stringify([{ id: 'a', type: 'REMOVE', date: '2026-05-01', timestamp: 1 }]));
    setAccount('b@example.com');
    expect(await new SyncQueueManager('b@example.com').getPending()).toEqual([]);
    setAccount('a@example.com');
    const a = new SyncQueueManager('a@example.com');
    expect(await a.getPending()).toEqual([]);
    await a.recoverLegacy();
    expect((await a.getPending()).map(item => item.id)).toEqual(['a']);
    expect(localStorage.getItem('linger_pending_sync_queue')).toBeNull();
  });

  it('reports a storage failure instead of pretending the operation was saved', async () => {
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    try {
      await expect(queueManager.enqueue({ id: 'a', type: 'REMOVE', date: '2026-05-01', timestamp: 1 })).rejects.toThrow();
      expect(await queueManager.getPending()).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it('keeps legacy operations when migration cannot write encrypted storage', async () => {
    const owner = 'legacy@example.com';
    setAccount(owner);
    localStorage.setItem('linger_session_user', owner);
    const raw = JSON.stringify([{ id: 'a', type: 'REMOVE', date: '2026-05-01', timestamp: 1 }]);
    localStorage.setItem('linger_pending_sync_queue', raw);
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    try {
      await expect(new SyncQueueManager(owner).recoverLegacy()).rejects.toThrow();
      expect(localStorage.getItem('linger_pending_sync_queue')).toBe(raw);
    } finally { spy.mockRestore(); }
  });

  it('adds items to queue and gets pending items', async () => {
    await queueManager.enqueue({
      id: 'item-1',
      type: 'SAVE',
      date: '2026-07-05',
      content: 'Hello offline',
      timestamp: Date.now(),
    });

    const pending = await queueManager.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toBe('Hello offline');
  });

  it('removes item from queue after successful sync', async () => {
    await queueManager.enqueue({
      id: 'item-1',
      type: 'SAVE',
      date: '2026-07-05',
      content: 'Hello offline',
      timestamp: Date.now(),
    });

    await queueManager.dequeue('item-1');

    const pending = await queueManager.getPending();
    expect(pending).toHaveLength(0);
  });

  it('processes pending queue sequentially with a worker handler', async () => {
    const handler = vi.fn().mockResolvedValue(true);

    await queueManager.enqueue({
      id: 'item-1',
      type: 'SAVE',
      date: '2026-07-05',
      content: 'Content 1',
      timestamp: Date.now(),
    });

    await queueManager.enqueue({
      id: 'item-2',
      type: 'REMOVE',
      date: '2026-07-04',
      timestamp: Date.now(),
    });

    await queueManager.process(handler);

    expect(handler).toHaveBeenCalledTimes(2);
    const remaining = await queueManager.getPending();
    expect(remaining).toHaveLength(0);
  });

  it('continues past a failing item, keeps it queued, and rethrows the error', async () => {
    await queueManager.enqueue({
      id: 'item-1',
      type: 'SAVE',
      date: '2026-07-05',
      content: 'Fails forever',
      timestamp: Date.now(),
    });
    await queueManager.enqueue({
      id: 'item-2',
      type: 'SAVE',
      date: '2026-07-04',
      content: 'Should still sync',
      timestamp: Date.now(),
    });

    const handler = vi.fn(async (item: { id: string }) => {
      if (item.id === 'item-1') throw new Error('sync failed');
      return true;
    });

    await expect(queueManager.process(handler)).rejects.toThrow('Failed to sync some queued diary changes');

    expect(handler).toHaveBeenCalledTimes(2);
    const remaining = await queueManager.getPending();
    expect(remaining.map((i) => i.id)).toEqual(['item-1']);
  });

  it('clear drops all queued items and the persisted record', async () => {
    await queueManager.enqueue({
      id: 'item-1',
      type: 'REMOVE',
      date: '2026-07-05',
      timestamp: Date.now(),
    });

    await queueManager.clear();

    expect(await queueManager.getPending()).toHaveLength(0);
    expect(localStorage.getItem('linger_pending_sync_queue')).toBeNull();
    // A fresh manager (e.g. after reload) must not resurrect the items.
    expect(await new SyncQueueManager().getPending()).toHaveLength(0);
  });

  it('stops processing when the handler returns false, keeping remaining items', async () => {
    await queueManager.enqueue({
      id: 'item-1',
      type: 'SAVE',
      date: '2026-07-05',
      content: 'Content 1',
      timestamp: Date.now(),
    });
    await queueManager.enqueue({
      id: 'item-2',
      type: 'SAVE',
      date: '2026-07-04',
      content: 'Content 2',
      timestamp: Date.now(),
    });

    const handler = vi.fn().mockResolvedValue(false);

    await queueManager.process(handler);

    expect(handler).toHaveBeenCalledTimes(1);
    const remaining = await queueManager.getPending();
    expect(remaining).toHaveLength(2);
  });
});
