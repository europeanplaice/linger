import { lazy } from 'react'

// Code-split the authenticated app shell and heavy modal components so
// first-time / signed-out visitors only download Landing + PasskeyGate, while
// authenticated shell and modal deps (EntryEditor, CalendarView, motion/react,
// EmojiPicker + emoji data, jszip, diff) are fetched on demand.
// Harnesses and unit tests import the real components directly, so this
// module is the only place that decides "lazy" vs "eager".
export const loadAuthenticatedApp = () => import('./AuthenticatedApp')
export const AuthenticatedApp = lazy(() => loadAuthenticatedApp().then(m => ({ default: m.AuthenticatedApp })))
export const SettingsModal = lazy(() => import('./SettingsModal').then(m => ({ default: m.SettingsModal })))
export const RecollectionJourney = lazy(() => import('./RecollectionJourney').then(m => ({ default: m.RecollectionJourney })))
export const HistoryModal = lazy(() => import('./HistoryModal').then(m => ({ default: m.HistoryModal })))
export const MilestoneFormModal = lazy(() => import('./MilestoneFormModal').then(m => ({ default: m.MilestoneFormModal })))
export const KeyboardShortcutsModal = lazy(() => import('./KeyboardShortcutsModal').then(m => ({ default: m.KeyboardShortcutsModal })))
