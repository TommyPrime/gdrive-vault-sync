# CLAUDE.md — GDrive Vault Sync（Obsidian同期プラグイン）

このリポジトリは、Obsidian の Vault を Google Drive と双方向同期する個人用プラグインです。
macOS / Windows / iPadOS / Android の 4 端末で同じ Vault を使うことを目的とします。
設計書：「Obsidian マルチデバイス構成 設計書」（https://claude.ai/artifact/95xfSrFyubDSxLFMpvHWev）の第4章が正の仕様です。
仕様と実装が食い違う場合は、勝手に決めずに確認してください。

## 最重要の原則
1. **データを失わないことが最優先。** 判断に迷ったら、ファイルを残す側に倒す（削除より変更を優先、競合は両方残す）。
2. **完全削除はしない。** Drive 側は `files.update({trashed: true})`、端末側は `.trash/` への移動のみ。
3. **判定ロジック（planner）は副作用のない純粋関数に保ち、必ずテストを先に書く。**
4. Google の権限は `https://www.googleapis.com/auth/drive.file` のみ。それより広い権限は追加しない。

## 技術スタック
- TypeScript（strict）、esbuild。Obsidian 公式 sample plugin の構成に従う。
- テスト：Vitest。
- `manifest.json` は `isDesktopOnly: false`。
- HTTP 通信はすべて Obsidian API の `requestUrl` を使う（`fetch` は使わない。モバイルで CORS に阻まれるため）。
- ファイル操作は `app.vault.adapter` を使う（`.obsidian/` などの隠しフォルダも扱うため）。
- Node.js の API（`fs`、`http` など）は使わない。例外は `src/auth/desktopLoopback.ts` のみで、`Platform.isDesktopApp` で分岐し、動的 import する。
- ハッシュは MD5（spark-md5）。Drive の `md5Checksum` とそのまま比較する。
- 端末ごとの状態は IndexedDB に保存する。トークンは `app.saveLocalStorage` に保存する。どちらも Vault には書かない。

## ディレクトリ構成
```
src/
  main.ts              プラグインの入口。トリガー登録（起動時、60秒ごと、保存後10秒、visibilitychange、手動）
  settings.ts          設定の型と既定値、設定画面
  auth/
    oauth.ts           PKCE、トークンの更新、invalid_grant の検出
    desktopLoopback.ts 127.0.0.1 で待ち受けてログイン（デスクトップのみ）
    mobileToken.ts     モバイルへのトークン受け渡し（表示とインポート）
  drive/
    client.ts          Drive API v3 のラッパー（list, changes.list, create, update, download, trash, resumable upload）
    retry.ts           指数バックオフ（403 rateLimit / 429 / 5xx、最大5回）
  local/
    scanner.ts         Vault の走査、除外パターン、mtime+size によるハッシュのキャッシュ
  state/
    store.ts           前回状態（path → md5, size, mtime, remoteId, remoteMd5）と pageToken
  sync/
    planner.ts         3点比較で実行計画を作る純粋関数
    safety.ts          安全チェック（削除しきい値、空Vault、vaultId不一致）
    executor.ts        計画の実行（並列度3、操作ごとに前回状態を更新）
    conflict.ts        競合コピーの命名
  ui/
    statusBar.ts  previewModal.ts  logView.ts
tests/
  planner.test.ts  safety.test.ts  fakes/fakeDrive.ts  fakes/fakeVault.ts  multiDevice.test.ts
```

## 同期の仕様（要約。詳細は設計書 4.4〜4.7）
- Drive 上の配置：`マイドライブ/Obsidian/<Vault名>/` 以下に Vault と同じ階層で置く。
- 各ファイルの `appProperties` に `vaultId` とパスを付ける。パスは 124 バイトの上限があるので `p0`、`p1` に分ける（`docs/spec-questions.md` Q1）。一覧は `appProperties has { key='vaultId' and value='…' } and trashed=false` で取得する。
- `vaultId` は初回に作る UUID。Drive ルートの `vault.json` に保存する。
- 初回は全件を一覧し、以降は `changes.list` で差分を取る。

### 判定表（planner が満たすべき仕様。全行をテストすること）
「変更」＝前回状態と MD5 が異なる。
| 端末側 | Drive側 | 処理 |
|---|---|---|
| 変更なし | 変更なし | 何もしない |
| 変更あり | 変更なし | upload |
| 変更なし | 変更あり | download |
| 変更あり | 変更あり（同じMD5） | 前回状態の更新のみ |
| 変更あり | 変更あり（違うMD5） | 競合：Drive版を正式名で取り込み、端末版は `名前 (conflict YYYY-MM-DD HHmm 端末名).拡張子` として保存し upload |
| 新規 | なし | upload |
| なし | 新規 | download |
| 新規 | 新規 | 同じMD5なら前回状態に登録。違えば競合 |
| 削除 | 変更なし | Drive側を trash |
| 削除 | 変更あり | download（復活） |
| 変更なし | 削除 | 端末側を `.trash/` へ |
| 変更あり | 削除 | upload（復活） |
| 削除 | 削除 | 前回状態から消す |

- 名前の変更は MVP では「削除＋新規」として扱う。
- 最後の変更から3秒以内のファイルは、download で上書きしない（次回へ回す）。

### 安全装置（safety.ts）
- 初回同期はプレビュー画面で承認されるまで実行しない。
- 削除予定が全体の10%超、または50件超なら停止して確認する（しきい値は設定で変更可）。
- 端末側が空、Drive ルートが見つからない、`vaultId` が不一致のときは停止する。
- 試行モードでは計画をログに出すだけで、何も書き込まない。

### 既定の除外パターン
`.git/**`, `.trash/**`, `**/.DS_Store`, `.obsidian/workspace*.json`, `.obsidian/cache/**`, `**/node_modules/**`
大きいファイル：5MB超は resumable upload。モバイルでは50MB超をスキップする（設定で変更可）。

## 開発の進め方
- 設計書 第5章の段階（0→6）に沿って進める。段階を飛ばさない。
- 1つの変更は小さく。planner / safety を変えるときは、先にテストを追加・修正してから実装する。
- 実際の Google Drive に触るテストは、テスト用の Vault とテスト用フォルダ（例：`Obsidian/_test-vault/`）だけで行う。本番の Vault のパスを、コードやテストに書かない。
- 認証情報（client_secret、refresh_token）はコミットしない。`.env.local` に置き、`.gitignore` に入れる。

## よく使うコマンド
```
npm install
npm run dev      # esbuild の watch。テスト用 Vault の .obsidian/plugins/gdrive-vault-sync/ に出力
npm run build    # 本番ビルド（main.js, manifest.json, styles.css）
npm test         # Vitest
npm run lint
```

## 完了の定義（各タスク共通）
- `npm test` と `npm run lint` が通る。
- 判定・安全装置に関わる変更には、対応するテストがある。
- Obsidian の外から編集されたファイル（Claude Code など）も、次回の同期でハッシュの差分として正しく拾われる。
- 変更内容と、手動で確認すべき点を短くまとめて報告する。

## してはいけないこと
- `drive.file` より広い権限の追加。
- Drive ファイルの完全削除（`files.delete`）。
- Vault 内へのログやトークンの書き込み。
- 安全装置を無効にする既定値。
- 仕様にない自動マージ（Markdown の自動マージは第6段階で別途設計する）。

## 参考
- NSync（MIT）：3点比較と安全停止の設計を参考にする。コードを流用する場合は、LICENSE と著作権表示を残す。
- Obsidian API：`requestUrl`, `Platform`, `Vault.adapter`, `app.saveLocalStorage` / `loadLocalStorage`
- Google Drive API v3：`files.list`, `changes.getStartPageToken`, `changes.list`, `files.create`（multipart / resumable）, `files.update`, `files.get?alt=media`
