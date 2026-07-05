import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncQueueManager, QueueItem } from '../../src/lib/syncQueue';

describe('SyncQueueManager', () => {
  let queueManager: SyncQueueManager;

  beforeEach(() => {
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
});
