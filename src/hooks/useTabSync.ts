import { useEffect, useRef } from 'react';
import { subscribeTabSync, TabSyncEvent } from '../utils/tabSync';

export function useTabSync(onSyncEvent: (event: TabSyncEvent) => void): void {
  const handlerRef = useRef(onSyncEvent);

  useEffect(() => {
    handlerRef.current = onSyncEvent;
  });

  useEffect(() => {
    const unsubscribe = subscribeTabSync((event) => {
      handlerRef.current(event);
    });
    return () => {
      unsubscribe();
    };
  }, []);
}
