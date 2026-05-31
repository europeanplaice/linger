const supported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'

const vibrate = (pattern: number | number[]) => {
  if (supported) navigator.vibrate(pattern)
}

export const haptics = {
  tap: () => vibrate(10),
  success: () => vibrate(10),
  warning: () => vibrate([0, 30, 60, 30]),
  error: () => vibrate([0, 40, 50, 40]),
  delete: () => vibrate([0, 20, 40, 20]),
}
