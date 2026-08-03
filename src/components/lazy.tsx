import { lazy } from 'react'

// Code-split the heavy modal components: they're only ever rendered after
// explicit user action (opening settings/history/milestone forms), so their
// JS — and that of their transitive deps (EmojiPicker + emoji data, jszip,
// diff) — is fetched on demand instead of with the initial page load.
// Harnesses and unit tests import the real components directly, so this
// module is the only place that decides "lazy" vs "eager".
export const SettingsModal = lazy(() => import('./SettingsModal').then(m => ({ default: m.SettingsModal })))
export const RecollectionJourney = lazy(() => import('./RecollectionJourney').then(m => ({ default: m.RecollectionJourney })))
export const HistoryModal = lazy(() => import('./HistoryModal').then(m => ({ default: m.HistoryModal })))
export const MilestoneFormModal = lazy(() => import('./MilestoneFormModal').then(m => ({ default: m.MilestoneFormModal })))
