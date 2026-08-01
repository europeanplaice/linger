# Cloudflare Workflows を使った S3 バックアップ再設計・実装計画

## 1. 目的と前提

Linger の S3 バックアップは、現在 Pages Functions とブラウザのポーリングで過去エントリを分割処理している。そのため、タブを閉じる、端末がスリープする、ブラウザがバックグラウンド処理を停止する、といった条件でバックフィルが中断する。

この計画では、バックフィルの実行主体を Cloudflare Workflows に移し、次を実現する。

- ブラウザの状態に依存しないバックフィル
- バッチ単位の再開と自動リトライ
- S3 HEAD を使わないエントリ状態表示
- 通常保存、単一エントリ再同期、全件バックフィルの競合制御
- 日記本文を Cloudflare の永続状態に保存しないこと

### 1.1 維持する前提

- Google Drive が日記データの正規の保存先である
- S3 はユーザーが設定したバックアップ先である
- Cloudflare 側に保存するのは同期メタデータだけである
- Pages プロジェクトは当面維持する
- S3 の認証は既存の Google ID Token -> AWS STS AssumeRoleWithWebIdentity を利用する

### 1.2 重要な非目標

- Cloudflare に日記本文をキャッシュ・保存すること
- S3 オブジェクトを Cloudflare R2 に中継保存すること
- Workflow の実行結果だけで Drive の内容を正規化すること

## 2. 採用アーキテクチャ

Pages Functions から Workflow を直接バインドするのではなく、Workflow と Durable Object を含む専用 Worker を Service Binding 経由で呼び出す。

```text
[React / Pages Functions]
       |
       | Service Binding: S3_WORKFLOW_SERVICE
       v
[linger-s3-workflows Worker]
       |-- Workflow: S3BackfillWorkflow
       |-- Durable Object: S3SyncIndex
       |-- KV: SESSIONS (既存 namespace を同じ ID でバインド)
       |
       |-- Google Drive API
       |-- Google OAuth token refresh
       |-- AWS STS / S3
```

Cloudflare の Pages Functions から Workflows を呼ぶ場合、Workflow を別 Worker としてデプロイして Service Binding または HTTP で呼ぶ必要がある。自アカウント内の Worker 呼び出しなので Service Binding を採用する。

参照: [Call Workflows from Pages](https://developers.cloudflare.com/workflows/build/call-workflows-from-pages/)

### 2.1 Worker の責務

専用 Worker は以下の名前付きメソッドを Service Binding に公開する。

```ts
startBackfill(input: StartBackfillInput): Promise<StartBackfillResult>
getJob(input: GetJobInput): Promise<BackfillJob>
getEntryStatus(input: GetEntryStatusInput): Promise<EntrySyncStatus>
```

Service Binding 経由の呼び出しは Pages からのみ許可し、専用 Worker に公開 HTTP API を作らない。HTTP エンドポイントが必要になった場合も、共有シークレットまたは別の認証を必須にする。

### 2.2 Durable Object の責務

`S3SyncIndex` はユーザーアカウント単位で 1 インスタンスを作る。インスタンス ID にはログインセッション ID ではなく、セッション内の安定した `google_sub` を使う。

保存するデータはメタデータだけに限定する。

```ts
type EntrySyncRecord = {
  date: string
  driveVersion?: string
  syncedVersion?: string
  state: 'pending' | 'synced' | 'failed' | 'unknown'
  updatedAt: string
  lastError?: string
}

type BackfillJob = {
  jobId: string
  state: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled'
  total: number
  completed: number
  failed: number
  startedAt: string
  finishedAt?: string
  workflowId: string
}
```

本文、タイトル、本文のハッシュ、OAuth トークン、AWS 一時認証情報は保存しない。DO のメソッド内でバージョン比較とジョブの排他制御を行う。

### 2.3 Pages 側の Service Binding

既存の Pages 用 `wrangler.toml` に Workflow の `[[workflows]]` を追加するのではなく、次を追加する。

```toml
[[services]]
binding = "S3_WORKFLOW_SERVICE"
service = "linger-s3-workflows"
```

Workflow Worker は独立した `workers/s3-workflows/wrangler.jsonc` で管理する。

```jsonc
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "linger-s3-workflows",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "workflows": [
    {
      "name": "s3-backfill-workflow",
      "binding": "S3_BACKFILL_WORKFLOW",
      "class_name": "S3BackfillWorkflow"
    }
  ],
  "kv_namespaces": [
    {
      "binding": "SESSIONS",
      "id": "<既存 SESSIONS namespace の ID>"
    }
  ],
  "durable_objects": {
    "bindings": [
      {
        "name": "S3_SYNC_INDEX",
        "class_name": "S3SyncIndex"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["S3SyncIndex"]
    }
  ]
}
```

実際の namespace ID、Secrets、staging/production の名前は環境ごとに設定する。設定変更後は `wrangler types` で Worker の `Env` 型を生成し、手書きの binding 型を増やさない。

## 3. Workflow の入力と認証

### 3.1 Workflow params に渡してよい値

```ts
type S3BackfillParams = {
  sessionId: string
  accountKey: string
  jobId: string
  scope?: string[]
}
```

`accessToken`、`refreshToken`、`idToken`、AWS の一時認証情報、日記本文は Workflow の params、step の戻り値、ログに含めない。

Workflow は各処理ステップの中で `SESSIONS` KV からセッションを読み込み、既存のトークン更新処理を利用する。更新後のセッションは既存のセッション保存処理を通じて KV に書き戻す。トークンを一つの step から別の step へ返して渡すことは禁止する。

セッション更新が同時実行される可能性があるため、次のいずれかを実装する。

- `S3SyncIndex` のアカウント単位ロックで更新を直列化する
- セッション更新に世代番号を付け、古いスナップショットによる上書きを拒否する

### 3.2 認可

- Pages API は既存 middleware でセッションを検証する
- Service Binding 呼び出しには `sessionId` と `accountKey` を渡す
- Worker は KV のセッションを読み、`accountKey` と `google_sub` が一致することを確認する
- `getJob` と `getEntryStatus` は、要求元セッションのアカウント以外を参照できないようにする
- `jobId` と `workflowId` はクライアントから任意指定させない

## 4. Workflow 処理設計

### 4.1 起動

`startBackfill` は Durable Object 内で次を原子的に行う。

1. S3 バックアップが有効であることを確認
2. 同一アカウントに実行中の全件バックフィルがないことを確認
3. `jobId` と `workflowId` を `crypto.randomUUID()` で生成
4. ジョブを `queued` として記録
5. `S3_BACKFILL_WORKFLOW.create({ id: workflowId, params })` を呼ぶ
6. Workflow の起動失敗時はジョブを `failed` に戻す

同じリクエストを再送しても二重起動しないよう、API は `requestId` を受け取り、短期間 DO に記録する。全件バックフィルはアカウントごとに常に1つだけ許可する。

### 4.2 Workflow のステップ

Workflow の状態には、一覧全件や本文を保持しない。対象一覧はページングし、各 step の戻り値は小さなメタデータに限定する。

```ts
async run(event: WorkflowEvent<S3BackfillParams>, step: WorkflowStep) {
  const { sessionId, accountKey, jobId, scope } = event.payload

  const target = await step.do('snapshot-target-page-0000', async () => {
    // Drive のメタデータだけを最大 N 件取得する。
    // 本文、アクセストークン、refresh token は戻り値に含めない。
    return discoverTargetPage({ sessionId, accountKey, scope })
  })

  for (const batch of chunk(target.entries, BATCH_SIZE)) {
    await step.do(
      `backup-batch-${target.page}-${batch[0].date}`,
      {
        retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
        timeout: '2 minutes'
      },
      async () => processBackupBatch({ sessionId, accountKey, jobId }, batch),
    )
  }

  // 次ページがある場合は、決定的なページ番号で同じ処理を続ける。
  // 全ページ完了後のみジョブを complete にする。
}
```

実装上の注意事項:

- ページサイズとバッチサイズは本文サイズに依存するため設定値にする
- 非ストリームの step 戻り値は 1 MiB 未満に抑える
- 1 バッチの処理は逐次または低い並列数で行い、Worker のメモリと S3/Drive のレート制限を守る
- バッチ処理の途中で一部成功しても再実行できるよう、S3 書き込みとインデックス更新を冪等にする
- バッチ全体の一時障害は例外として返し、Workflow の step retry を発動させる
- 個別エントリの恒久的失敗は `failed` として記録し、同じバッチ全体を無限に再試行しない

### 4.3 1 エントリの処理

1. Workflow step 内でセッションと最新の Google トークンを取得
2. Drive から対象ファイルの最新メタデータを再確認
3. Drive の本文をメモリ上で取得
4. `putObjectIfNewer` で S3 に書き込む
5. 書き込み成功後、DO の `markSynced(date, driveVersion)` を呼ぶ
6. DO は既存の `syncedVersion` より新しい場合だけ更新する
7. step の戻り値には `{ date, state, version }` だけを返し、本文は返さない

Workflow が開始した後に Drive の本文が更新されても、古いバージョンが新しいバージョンを上書きしないことを `putObjectIfNewer` と DO の両方で保証する。

## 5. 同期状態と既存処理の統合

### 5.1 状態の正規データ

Phase 1 では S3 の HEAD を `entry-status` の判定に使わず、`S3SyncIndex` を正規の同期状態として扱う。

状態の遷移は次の通りとする。

```text
unknown -> pending -> synced
unknown -> pending -> failed
synced  -> pending -> synced  (新しい Drive version)
synced  -> pending -> failed
```

S3 の書き込み成功前に `synced` にしてはいけない。DO 更新に失敗した場合は `synced` とみなさず、再試行可能な状態として扱う。

### 5.2 通常保存・削除・単一再同期

既存の以下の処理にもインデックス更新を追加する。

- `mirrorEntrySave`
- `mirrorEntryDelete`
- `resyncSingleEntry`
- `backfillAllEntries` の置き換え対象処理

通常保存は次の順序にする。

1. Drive 保存完了
2. DO を `pending` にする
3. `context.waitUntil` で S3 mirror を実行
4. S3 成功後に DO を `synced`
5. 失敗時は DO を `failed`

削除は S3 削除成功後にインデックスから削除済み状態へ更新する。S3 削除が不明な場合に、インデックスだけを成功扱いにしない。

### 5.3 `entry-status` API

`/api/s3/entry-status/[date]` は Service Binding の `getEntryStatus` を呼ぶ。S3 HEAD、STS AssumeRole、Drive の設定ファイル読み込みを通常の閲覧経路から除去する。

要求された Drive version とインデックスの `syncedVersion` を比較し、次の結果を返す。

- `synced`: `syncedVersion >= requestedVersion`
- `pending`: 対象が現在処理中
- `failed`: 最後の処理が失敗
- `unconfirmed`: インデックスに情報がない
- `disabled`: S3 バックアップ無効

`unconfirmed` を `synced` と誤判定しない。既存 UI の `backfilling`、`unconfirmed`、`failed` との互換性を確認してからレスポンス名を確定する。

## 6. Cloudflare 側に保持するデータの境界

### 6.1 保持してよいもの

- `google_sub` と内部アカウント識別子
- 日付
- Drive file ID
- Drive version
- S3 同期状態
- ジョブ ID、Workflow ID、件数、時刻、エラー分類

### 6.2 保持してはいけないもの

- 日記本文
- タイトル
- OAuth access token、refresh token、ID token
- AWS access key、secret key、session token
- 本文の検索インデックス
- 本文を復元できるキャッシュやログ

Workflows は step の状態を永続化するため、本文をローカル変数で一時的に扱う処理と、step の戻り値・ログ・例外メッセージを明確に分離する。エラーに API レスポンス本文やリクエストヘッダーを含めない。

## 7. API とファイル変更計画

### Phase 1: Worker と型の追加

対象:

- `workers/s3-workflows/wrangler.jsonc`
- `workers/s3-workflows/src/index.ts`
- `workers/s3-workflows/src/workflow.ts`
- `workers/s3-workflows/src/syncIndex.ts`
- `workers/s3-workflows/src/types.ts`
- Pages 用 `wrangler.toml` の `[[services]]`
- 生成された Worker `Env` 型

実施内容:

- Workflow Worker を単独で起動・デプロイできるようにする
- Service Binding の named method を実装する
- `S3SyncIndex` の migration とメタデータ schema を追加する
- production/staging の binding を分離する

### Phase 2: Workflow の最小実装

対象:

- `workers/s3-workflows/src/workflow.ts`
- Google Drive / OAuth / S3 の共通処理モジュール

実施内容:

- 1件または小さい固定バッチで Drive -> S3 -> DO 更新を通す
- access token を params や step state に含めないことをテストする
- `putObjectIfNewer` の冪等性を確認する
- retry、timeout、恒久エラーの分類を実装する

### Phase 3: 起動 API とジョブ状態

対象:

- `functions/api/s3/resync.ts`
- `functions/api/s3/backfill-retry.ts`
- `functions/api/s3/backfill-continue.ts`
- `functions/api/s3/settings.ts`

実施内容:

- `resync` と `backfill-retry` を Service Binding 経由の起動に変更する
- HTTP 応答は `202` と `jobId` を返す
- `backfill-continue` は削除するが、旧クライアント向けに一定期間 `410 Gone` を返すかを決める
- 既存の Drive `s3_sync_status.json` は移行期間中の監査・フォールバック用として残す
- 移行完了後に Drive 上の進捗状態を廃止するか判断する

### Phase 4: エントリ状態の切り替え

対象:

- `functions/api/s3/entry-status/[date].ts`
- `functions/api/s3/entry-resync/[date].ts`
- `functions/_shared/s3Settings.ts`
- `src/hooks/useS3Backfill.ts`
- `EntryEditor.tsx` の実際の配置場所

実施内容:

- entry status を DO インデックス参照へ切り替える
- 通常保存・削除・単一再同期から DO を更新する
- UI のポーリングは 2 秒固定ではなく、ジョブ状態表示用に 5〜10 秒程度へ下げる
- Workflow の状態 API と日付単位の同期状態 API を混同しない
- 古いクライアントが存在する期間は API の互換レスポンスを維持する

### Phase 5: 旧実装の撤去

- 旧 `backfill-continue` の呼び出しを全クライアントから削除
- 旧ポーリングが残っていないことを検索で確認
- Drive の進捗状態を正規データとして参照するコードを削除
- 不要になった `isBackfillRunActive` と旧 chunk bookkeeping を整理
- 撤去前に production の未完了ジョブを再実行または完了扱いにする手順を用意する

## 8. 無料枠・実行制限への対策

Free plan の数値を前提にするが、無料枠内を保証するものではない。Workflows の steps、Workers の requests、Workflow state storage はアカウント全体の使用量として監視する。

制御値:

- 同一アカウントの同時バックフィル: 1
- `BATCH_SIZE`: 初期値 20、本文サイズに応じて調整
- 1ジョブの最大対象件数: 設定値で制限
- step timeout: 2 分以下から開始
- step retry: 最大 3 回
- 失敗バッチの自動再試行: 上限を設ける
- Workflow instance retention: 完了・失敗後に必要な最短期間へ設定

Cloudflare の Free plan では Workflows に 3,000 steps/day、100,000 requests/day、1 GB storage が含まれる。Workflow の状態は完了済み・失敗済みインスタンスもストレージを消費するため、Retention と削除方針を明示する。

参照: [Workflows Pricing](https://developers.cloudflare.com/workflows/reference/pricing/)

## 9. テスト・検証計画

### 9.1 単体テスト

- DO の version 比較
- `pending -> synced` / `failed` の状態遷移
- 同一 `requestId` の二重起動防止
- 同一アカウントの同時ジョブ拒否
- 異なるアカウントのデータ分離
- 古い version が新しい version を上書きしないこと
- 本文、トークン、AWS 認証情報が state/result/log に含まれないこと

### 9.2 Workflow 統合テスト

- Workflow create と status 取得
- Drive API の一時失敗からの自動 retry
- S3 API の一時失敗からの自動 retry
- バッチ途中での Worker 中断後の再開
- 一部エントリ失敗時に他エントリが継続すること
- OAuth access token 期限切れ時の更新
- refresh token 無効時にジョブが安全に失敗すること
- 1 MiB 未満の step state 制約と大量エントリのページング

### 9.3 E2E / 手動検証

- 起動後すぐにタブを閉じても完了すること
- モバイル端末をスリープさせても完了すること
- 通常保存と全件バックフィルを同時に実行すること
- 保存、削除、単一再同期と全件バックフィルを競合させること
- Drive 側の本文更新中にバックフィルを実行すること
- Workflow が `errored` になった後の再実行
- staging と production の binding が混線しないこと

## 10. 完了条件

次をすべて満たした時点で本番切り替えとする。

- Pages から Service Binding 経由で Workflow を起動できる
- Workflow params と state に本文・OAuth トークンがない
- 1,000件以上のメタデータをページングして処理できる
- タブを閉じても処理が継続する
- S3 の同一オブジェクトを再試行しても重複・逆戻りが起きない
- `entry-status` が S3 HEAD なしで正しく判定できる
- 通常保存とバックフィルの version 競合を解決できる
- 同一アカウントの二重バックフィルを防止できる
- Workflow の失敗と再試行が UI から確認できる
- Free plan の使用量を測定でき、上限前に新規ジョブを抑制できる
