import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { broadcastMessage, subscribeTabSync } from '../../src/utils/tabSync';

// Spec-compliant mock: BroadcastChannel delivers a posted message to every
// OTHER channel object with the same name — never back to the posting
// instance itself. tabSync shares one singleton channel per tab, so a tab
// never receives its own broadcasts.
const channels = new Set<MockBroadcastChannel>();

class MockBroadcastChannel {
  listeners: Array<(e: { data: unknown }) => void> = [];
  constructor(public name: string) {
    channels.add(this);
  }
  postMessage(data: unknown) {
    for (const ch of channels) {
      if (ch !== this && ch.name === this.name) {
        ch.listeners.forEach((listener) => listener({ data }));
      }
    }
  }
  addEventListener(type: string, listener: (e: { data: unknown }) => void) {
    if (type === 'message') this.listeners.push(listener);
  }
  removeEventListener(type: string, listener: (e: { data: unknown }) => void) {
    if (type === 'message') this.listeners = this.listeners.filter((l) => l !== listener);
  }
  close() {
    channels.delete(this);
  }
}

function openOtherTab(): MockBroadcastChannel {
  return new (globalThis.BroadcastChannel as unknown as typeof MockBroadcastChannel)('linger_tab_sync');
}

describe('tabSync utility', () => {
  beforeAll(() => {
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('delivers broadcasts to other tabs but not back to the broadcasting tab', () => {
    const sameTabHandler = vi.fn();
    const unsubscribe = subscribeTabSync(sameTabHandler);
    const otherTab = openOtherTab();
    const otherTabListener = vi.fn();
    otherTab.addEventListener('message', otherTabListener);

    broadcastMessage({ type: 'DIARY_UPDATED', date: '2026-07-05' });

    expect(otherTabListener).toHaveBeenCalledWith({ data: { type: 'DIARY_UPDATED', date: '2026-07-05' } });
    expect(sameTabHandler).not.toHaveBeenCalled();

    unsubscribe();
    otherTab.close();
  });

  it('receives events broadcast from another tab', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeTabSync(handler);
    const otherTab = openOtherTab();

    otherTab.postMessage({ type: 'DIARY_UPDATED', date: '2026-07-05' });

    expect(handler).toHaveBeenCalledWith({ type: 'DIARY_UPDATED', date: '2026-07-05' });

    unsubscribe();
    otherTab.close();
  });

  it('ignores malformed messages', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeTabSync(handler);
    const otherTab = openOtherTab();

    otherTab.postMessage('not-an-event');
    otherTab.postMessage(null);

    expect(handler).not.toHaveBeenCalled();

    unsubscribe();
    otherTab.close();
  });

  it('unsubscribes from tab sync messages correctly', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeTabSync(handler);
    const otherTab = openOtherTab();

    unsubscribe();

    otherTab.postMessage({ type: 'MILESTONES_UPDATED' });

    expect(handler).not.toHaveBeenCalled();
    otherTab.close();
  });
});
