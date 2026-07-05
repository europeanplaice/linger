import type { StorageMode } from '../types';

export type TabSyncEvent =
  | { type: 'DIARY_UPDATED'; date: string }
  | { type: 'DIARY_REMOVED'; date: string }
  | { type: 'MILESTONES_UPDATED' }
  | { type: 'STORAGE_MODE_CHANGED'; mode: StorageMode };

const CHANNEL_NAME = 'linger_tab_sync';

let channelInstance: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return null;
  }
  if (!channelInstance) {
    try {
      channelInstance = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      channelInstance = null;
    }
  }
  return channelInstance;
}

export function broadcastMessage(event: TabSyncEvent): void {
  const channel = getChannel();
  if (channel) {
    channel.postMessage(event);
  }
}

export function subscribeTabSync(handler: (event: TabSyncEvent) => void): () => void {
  const channel = getChannel();
  if (!channel) {
    return () => {};
  }

  const listener = (e: MessageEvent<TabSyncEvent>) => {
    if (e.data && typeof e.data === 'object' && 'type' in e.data) {
      handler(e.data);
    }
  };

  channel.addEventListener('message', listener);

  return () => {
    channel.removeEventListener('message', listener);
  };
}
