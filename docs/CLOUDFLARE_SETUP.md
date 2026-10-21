# Cloudflare検証版の公開と開発

アプリ： https://techspresso-coffee-app.hamaoka123123.workers.dev/

Worker：`techspresso-coffee-app`。保存先：今回専用D1 `techspresso-coffee-app-db`。

会計・受け渡し・表示専用はコードなしで使えます。これは実際のD1へ保存する検証版です。旧Apps Scriptの実注文、スプレッドシート、売上シミュレーション、シフト、Discord通知にはまだ接続していません。旧環境の本番切替やデータ移行は行っていません。

## 管理者コードの設定

本人がCloudflareダッシュボードへログインし、Workers & Pages → techspresso-coffee-app → Settings → Variables and Secretsで、種類Secret、名前`ADMIN_CODE`、値12〜200文字のコードを設定・保存してください。
値はGitHub、チャット、スクリーンショットへ含めません。未設定では管理者だけがログインできません。既存のDiscord通知Workerとは別の設定です。

## ローカル開発

Node.js 24を推奨します。

```sh
npm ci --ignore-scripts
npm test
npm run build:cloudflare
npm exec -- wrangler d1 migrations apply techspresso-coffee-app-db --local
npm run dev:cloudflare
```

ローカル検証用のコードは、自分のPCの`.dev.vars`に設定できます。このファイルはGitの対象外です。実際の管理者コードを使う必要はありません。
`npm test`は模擬環境とローカルSQLiteだけを使います。本番へ接続しません。

## 公開

公開担当者が自分のアカウントで`npm exec -- wrangler login`を行い、このWorkerとD1の権限を持っていることを確認します。GitHubの共同編集者になっただけでは、Cloudflareの公開権限は付与されません。

```sh
npm test
npm run build:cloudflare
npm exec -- wrangler deploy --dry-run
npm run deploy:cloudflare
```

DB構造を変更したときだけ、新しいSQLをレビューしてから今回専用DBへ適用します。

```sh
npm exec -- wrangler d1 migrations apply techspresso-coffee-app-db --remote
```

適用済みの初期SQLを後から変更せず、新しいマイグレーションを追加します。コードを戻してもDB構造や注文は自動で戻りません。

## 保存と競合対策

対応中の札・注文は小さな状態行に、注文履歴と操作IDは別テーブルへ保存します。状態バージョンの比較更新とD1のbatchトランザクションで同時確定します。
同じ操作IDの再送は一度だけ記録し、異なる本文での再利用を拒否します。番号札の同時使用、二重提供、古いrevisionからの変更もサーバーで拒否します。
取消時に札がない場合も、会計担当だけで後から実物の受領を確認できます。
セッションは操作から2時間で、自動読込では延長しません。DBにはトークンのハッシュを保存し、管理者コード変更で旧管理者セッションを失効します。

## 確認済みと残る事項

- 既存88件とCloudflare12件の計100件のローカルテストに成功。
- 公開検証版で独立した5セッション、4担当の同時操作、重複再送、二重提供防止、取消・直接受領を確認。
- このPCから27回のAPI通信は中央値118ms、最大252ms。実端末・混雑時の保証ではありません。
- 無料プランで公開。有料プランへ変更していません。無料枠超過時は処理が制限されます。
- 管理者コードは本人のSecret設定が必要。
- 外部連携、表示名除去、旧注文移行、定期バックアップ/保持期間、本番切替は未完了です。外部連携ボタンは未接続の案内を返し、旧環境へ書き込みません。
- GitHub Actionsは手動テストのみ。Cloudflareへの自動公開接続・共同開発者のCloudflare権限は未設定です。
- 初回公開：2026-10-21。検証用の注文履歴は削除せず残していますが、使用した札は全て再使用可能へ戻しました。
