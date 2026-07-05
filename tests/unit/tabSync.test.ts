import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { broadcastMessage, subscribeTabSync, TabSyncEvent } from '../../src/utils/tabSync';

describe('tabSync utility', () => {
  let mockPostMessage: Mock<(data: any) => void>;
  let mockClose: Mock<() => void>;
  let messageListeners: Array<(e: { data: TabSyncEvent }) => void> = [];

  beforeEach(() => {
    messageListeners = [];
    mockPostMessage = vi.fn((data) => {
      // Simulate broadcasting to other channels in test
      messageListeners.forEach((listener) => listener({ data }));
    });
    mockClose = vi.fn();

    // Mock BroadcastChannel globally if needed or verify mock behavior
    class MockBroadcastChannel {
      name: string;
      onmessage: ((e: { data: any }) => void) | null = null;
      constructor(name: string) {
        this.name = name;
      }
      postMessage(data: any) {
        mockPostMessage(data);
      }
      addEventListener(type: string, listener: any) {
        if (type === 'message') {
          messageListeners.push(listener);
        }
      }
      removeEventListener(type: string, listener: any) {
        if (type === 'message') {
          messageListeners = messageListeners.filter((l) => l !== listener);
        }
      }
      close() {
        mockClose();
      }
    }

    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('broadcasts DIARY_UPDATED message correctly', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeTabSync(handler);

    broadcastMessage({ type: 'DIARY_UPDATED', date: '2026-07-05' });

    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'DIARY_UPDATED', date: '2026-07-05' });
    expect(handler).toHaveBeenCalledWith({ type: 'DIARY_UPDATED', date: '2026-07-05' });

    unsubscribe();
  });

  it('unsubscribes from tab sync messages correctly', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeTabSync(handler);

    unsubscribe();

    broadcastMessage({ type: 'MILESTONES_UPDATED' });

    expect(handler).not.toHaveBeenCalled();
  });
});
