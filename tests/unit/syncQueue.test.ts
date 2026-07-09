import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncQueueManager } from '../../src/lib/syncQueue';

describe('SyncQueueManager', () => {
  let queueManager: SyncQueueManager;

  beforeEach(() => {
    localStorage.clear();
    queueManager = new SyncQueueManager();
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
