import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTabSync } from '../../src/hooks/useTabSync';
import * as tabSync from '../../src/utils/tabSync';

describe('useTabSync hook', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('subscribes to tab sync events on mount and unsubscribes on unmount', () => {
    const mockUnsubscribe = vi.fn();
    let listener: any = null;
    vi.spyOn(tabSync, 'subscribeTabSync').mockImplementation((fn) => {
      listener = fn;
      return mockUnsubscribe;
    });

    const onSync = vi.fn();
    const { unmount } = renderHook(() => useTabSync(onSync));

    expect(listener).toBeTypeOf('function');
    listener({ type: 'DIARY_UPDATED', date: '2026-07-05' });
    expect(onSync).toHaveBeenCalledWith({ type: 'DIARY_UPDATED', date: '2026-07-05' });

    unmount();
    expect(mockUnsubscribe).toHaveBeenCalled();
  });
});
