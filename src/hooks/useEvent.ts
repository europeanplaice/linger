import { useCallback, useRef } from 'react'

// A ref that always holds the latest `value`, updated during render. Use it to
// read the current value inside callbacks/effects/timeouts that must NOT be
// torn down and recreated whenever the value changes. Replaces the
// `const xRef = useRef(x); useEffect(() => { xRef.current = x }, [x])` pattern,
// which is easy to get subtly wrong (stale closures, missing deps).
export function useLatestRef<T>(value: T) {
  const ref = useRef(value)
  ref.current = value
  return ref
}

// A stable callback whose identity never changes but which always invokes the
// latest `handler`. Lets effects/memoized children depend on it without
// restarting, while still seeing fresh props/state.
export function useEvent<A extends unknown[], R>(handler: (...args: A) => R) {
  const ref = useLatestRef(handler)
  return useCallback((...args: A) => ref.current(...args), [ref])
}
