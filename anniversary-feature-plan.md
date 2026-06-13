# 記念日機能（Anniversary Feature）

## Context

ユーザーが記念日（結婚記念日・誕生日など、毎年繰り返す日付）を登録し、日記エントリーを開いたときに「この日は○○記念日の3日前」「○○記念日から2日後」のように近接する記念日との距離をメタデータバーに表示する機能。

データはGoogle Driveに保存し（設定と違い）デバイス間で同期する。

---

## Data Model

```typescript
// src/types.ts に追加
export interface Anniversary {
  id: string        // crypto.randomUUID() or Date.now() fallback
  label: string     // "結婚記念日", "誕生日" etc.
  monthDay: string  // "MM-DD" (毎年繰り返すので年は持たない)
}

export function isAnniversary(v: unknown): v is Anniversary { /* 型ガード */ }
export function isAnniversaryArray(v: unknown): v is Anniversary[] { /* 型ガード */ }
```

- Drive上のファイル: `linger_diary/anniversaries.json` (MIME: `application/json`)
- 内容: `Anniversary[]` をJSONシリアライズしたもの
- localStorage key: `linger_anniversaries` — Driveロード前の即時表示用キャッシュ

---

## Implementation Steps

### 1. `src/types.ts`
`Anniversary` インターフェースと型ガード2つ（`isAnniversary`, `isAnniversaryArray`）を追加。

### 2. `functions/_shared/drive.ts`
小さなJSONファイルの読み書きユーティリティを追加:

```typescript
// 既存の saveEntry と同パターンで multipart upload
export async function readJsonFile<T>(token: string, fileId: string): Promise<T>
export async function writeJsonFile(
  token: string,
  folderId: string,
  fileName: string,       // "anniversaries.json"
  content: unknown,
  existingFileId?: string // 更新時
): Promise<DriveFileMeta>
```

- `readJsonFile` は `getEntryContent` を参考に（Download API）
- `writeJsonFile` は `saveEntry` を参考に（multipart upload, Content-Type: application/json）

### 3. `functions/api/drive/anniversaries.ts`（新規）

```
GET  /api/drive/anniversaries  → Anniversary[]（not found → []）
PUT  /api/drive/anniversaries  → 保存して DriveFileMeta を返す
```

- `onRequestGet`: `ensureFolder` → ファイル名 `anniversaries.json` で検索 → `readJsonFile` → 返す
- `onRequestPut`: body validate → `ensureFolder` → ファイル検索（既存IDがあれば更新）→ `writeJsonFile`

ファイル検索クエリ:
```
name='anniversaries.json' and '{folderId}' in parents and trashed=false
```

### 4. `src/api/driveAnniversaries.ts`（新規）

```typescript
export async function loadAnniversaries(): Promise<Anniversary[]>
export async function saveAnniversaries(list: Anniversary[]): Promise<void>
```

`apiFetch` を使用（`src/api/driveEntries.ts` の既存パターン）。

### 5. `src/hooks/useAnniversaries.ts`（新規）

```typescript
export function useAnniversaries(
  authStatus: string,          // useAuth の status
  onTokenExpired: () => void,  // App.tsx の handleExpired
)
```

- `useState` を localStorage から初期化（即時表示）
- `useEffect([authStatus])`: `signed-in` になったら Drive からロード → localStorage 更新
- 変更時: 楽観的にローカル状態を更新 → localStorage へ → Drive へ非同期保存（失敗は silent、TokenExpiredError は `onTokenExpired` へ）
- 返り値: `{ anniversaries, add, remove, update }`

### 6. `src/utils/date.ts`

以下を追加（`nearestWithDistance` の直後あたり）:

```typescript
export interface AnniversaryProximity {
  label: string
  monthDay: string
  distance: number  // 正: 記念日が先 / 負: 記念日が過去 / 0: 当日
}

// entryDate の年±1 の3年分で最近傍の発生を探す（年またぎ対応）
export function nearestAnniversaryOccurrence(
  entryDate: string,
  monthDay: string,
  label: string,
): AnniversaryProximity | null

// 全記念日を探索し |distance| <= maxDistanceDays のものを距離昇順で返す
export function anniversariesNearEntry(
  entryDate: string,
  anniversaries: ReadonlyArray<{ label: string; monthDay: string }>,
  maxDistanceDays = 7,
): AnniversaryProximity[]
```

- 年またぎ対応: `ey-1, ey, ey+1` の3年分をチェックし最小 `|distance|` を採用
- 2/29はJSのオーバーフローチェック（`anniv.getMonth() !== mm-1`）でスキップ

### 7. `src/i18n.tsx`

`entry` セクションに追加（en/jaペア）:

```typescript
anniversaryOn:     (label: string) => label                              // label / label
anniversaryBefore: (label: string, n: number) => `${label} in ${n}d`    // "Wedding in 3d" / "結婚記念日まで3日"
anniversaryAfter:  (label: string, n: number) => `${label} ${n}d ago`   // "Wedding 2d ago" / "結婚記念日から2日"
```

`settings` セクションに追加（en/jaペア）:

```typescript
anniversaries          // "Anniversaries" / "記念日"
anniversaryAdd         // "Add" / "追加"
anniversaryLabelPlaceholder  // "Name (e.g. Birthday)" / "名前（例：誕生日）"
anniversaryDatePlaceholder   // "MM-DD"
anniversaryInvalidDate // バリデーションエラー文言
anniversaryEmptyLabel  // バリデーションエラー文言
anniversaryNone        // "No anniversaries yet." / "まだ記念日がありません。"
anniversarySave        // "Add" / "追加"
anniversaryCancel      // "Cancel" / "キャンセル"
anniversaryRemove: (label: string) => string  // 削除ボタン aria-label
```

### 8. `src/components/SettingsModal.tsx`

Props 追加:
```typescript
anniversaries: Anniversary[]
onAnniversaryAdd: (label: string, monthDay: string) => void
onAnniversaryRemove: (id: string) => void
```

UI: Holidays 行の直後に「記念日」セクションを追加。
- リスト表示（label + MM-DD + 削除ボタン）
- 追加フォーム（ローカル state: `showAddForm`, `newLabel`, `newMonthDay`, `formErrors`）
- バリデーション: 空ラベル・不正 MM-DD（2000年を使うことで Feb 29 も受容）
- v1 では編集なし（削除 + 再追加で対応）

### 9. `src/components/EntryEditor.tsx`

Props 追加:
```typescript
anniversaries?: Anniversary[]
```

`daysDiff` 計算の直後に追加:
```typescript
const anniversaryBadges = useMemo(
  () => anniversariesNearEntry(date, anniversaries ?? [], 7).slice(0, 3),
  [date, anniversaries]
)
```

`.editor-meta` div 内で `daysAgo/daysAhead` の直後に:
```tsx
{anniversaryBadges.map(({ label, monthDay, distance }) => (
  <span key={monthDay} className={`editor-meta-anniversary${distance === 0 ? ' editor-meta-anniversary--on' : ''}`}>
    {distance === 0 ? t.entry.anniversaryOn(label)
     : distance > 0 ? t.entry.anniversaryBefore(label, distance)
     : t.entry.anniversaryAfter(label, Math.abs(distance))}
  </span>
))}
```

### 10. `src/components/CalendarView.tsx`

Props 追加: `anniversaries?: Anniversary[]`

セル描画時:
```typescript
const mmDd = `${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
const hasAnniversary = anniversaries?.some(a => a.monthDay === mmDd) ?? false
```

セルに `.anniversary` クラスを付与（CSS で右下に小ドット）。

### 11. `src/App.tsx`

```typescript
import { useAnniversaries } from './hooks/useAnniversaries'

const { anniversaries, add: addAnniversary, remove: removeAnniversary } = useAnniversaries(status, handleExpired)
```

`SettingsModal`, `EntryEditor`, `CalendarView` に `anniversaries` と対応ハンドラを追加。

### 12. `src/styles.css`

- `.editor-meta-anniversary` — pill 型バッジ（`--accent` カラー、低透明度背景）
- `.editor-meta-anniversary--on` — 当日は若干濃くする
- `.settings-anniversary-*` — SettingsModal の追加フォームとリスト
- `.cal-day.anniversary::after` — カレンダーセル右下に小ドット

---

## Key Files

| ファイル | 変更種別 |
|---|---|
| `src/types.ts` | 追加 |
| `functions/_shared/drive.ts` | 追加 |
| `functions/api/drive/anniversaries.ts` | **新規** |
| `src/api/driveAnniversaries.ts` | **新規** |
| `src/hooks/useAnniversaries.ts` | **新規** |
| `src/utils/date.ts` | 追加 |
| `src/i18n.tsx` | 追加 |
| `src/components/SettingsModal.tsx` | 追加 |
| `src/components/EntryEditor.tsx` | 追加 |
| `src/components/CalendarView.tsx` | 追加 |
| `src/App.tsx` | 追加 |
| `src/styles.css` | 追加 |

---

## Reuse

- `apiFetch` (`src/api/driveEntries.ts:59`) — Drive API コール
- `ensureFolder`, `driveWithRetry`, `withFolderFallback` (`functions/_shared/drive.ts`) — フォルダ操作
- `saveEntry` pattern — multipart upload の参考実装
- `getEntryContent` pattern — ファイルダウンロードの参考実装
- `TokenExpiredError` — auth エラーのバブルアップ

---

## Verification

1. **型チェック**: `npm run build` でエラーなし
2. **SettingsModal**: 記念日の追加・削除・バリデーション（空ラベル/不正日付）が正常動作
3. **Drive 同期**: 追加後にリロードしても記念日が残る。別デバイスで開くと同期されている
4. **EntryEditor バッジ**: 7日以内の記念日のバッジが表示される。8日以上は表示されない
5. **CalendarView**: 記念日のある日付のセルに小ドットが表示される
6. **言語切替**: 日英切替でバッジ文言が変わる
7. **オフライン**: localStorage から記念日を表示できる（Drive 保存失敗でも UI はクラッシュしない）
8. **うるう年 2/29**: 記念日として登録できる。非うるう年の entries では最近傍の 2/29 が使われる
