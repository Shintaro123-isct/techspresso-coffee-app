# Cloudflareのスタッフ用・開発用

スタッフ用： https://techspresso-coffee-app.hamaoka123123.workers.dev/

開発用： https://techspresso-coffee-app-dev.hamaoka123123.workers.dev/

お客様用本番： https://techspresso-coffee-app.hamaoka123123.workers.dev/order

お客様用開発： https://techspresso-coffee-app-dev.hamaoka123123.workers.dev/order

2026-10-21のUI統一リリースで、注文QR・レジ手入力・提供の3画面を本番へ反映します。操作手順は[注文QRガイド](ORDER_QR.md)を参照してください。

| 環境 | Worker | D1 |
| --- | --- | --- |
| スタッフ用 | techspresso-coffee-app | techspresso-coffee-app-production-db |
| 開発用 | techspresso-coffee-app-dev | techspresso-coffee-app-db |

URL、注文・操作記録、ログイン、設定値、管理者コードを分離します。開発用を更新してもスタッフ用のコードは変わりません。初回のテスト履歴は開発用に残し、スタッフ用は空の記録から開始します。

会計・受け渡し・表示専用はコードなしで使えます。両方とも実際のD1へ保存します。旧Apps Scriptの実注文、スプレッドシート、売上シミュレーション、シフト、Discord通知にはまだ接続していません。旧環境の本番切替やデータ移行は行っていません。

## 管理者コードの設定

本人がCloudflareダッシュボードへログインし、Workers & Pages → techspresso-coffee-app → Settings → Variables and Secretsで、種類Secret、名前`ADMIN_CODE`、値12〜200文字のコードを設定・保存してください。
値はGitHub、チャット、スクリーンショットへ含めません。未設定では管理者だけがログインできません。既存のDiscord通知Workerとは別の設定です。

開発用の管理者操作も試す場合は、`techspresso-coffee-app-dev`へ別のコードを設定します。スタッフ用のSecretは開発用に自動ではコピーされません。

## ローカル開発

Node.js 24を推奨します。

```sh
npm ci --ignore-scripts
npm test
npm run build:cloudflare
npm exec -- wrangler d1 migrations apply techspresso-coffee-app-db --local --env dev
npm run dev:cloudflare
```

ローカル検証用のコードは、自分のPCの`.dev.vars`に設定できます。このファイルはGitの対象外です。実際の管理者コードを使う必要はありません。
`npm test`は模擬環境とローカルSQLiteだけを使います。本番へ接続しません。

## 公開

公開担当者が自分のアカウントで`npm exec -- wrangler login`を行い、このWorkerとD1の権限を持っていることを確認します。GitHubの共同編集者になっただけでは、Cloudflareの公開権限は付与されません。

```sh
npm test
npm run build:cloudflare
npm exec -- wrangler deploy --env dev --dry-run
npm run deploy:dev
```

開発用で機能を確認し、スタッフ用へ反映すると決めた場合だけ、`npm run deploy:production`を実行します。`npm run deploy:cloudflare`は誤公開を避けるため開発用へ向けています。

DB構造を変更したときだけ、新しいSQLをレビューして対象DBへ適用します。

```sh
npm exec -- wrangler d1 migrations apply techspresso-coffee-app-db --remote --env dev
# スタッフ用へ反映する段階でのみ実行
npm exec -- wrangler d1 migrations apply techspresso-coffee-app-production-db --remote
```

適用済みの初期SQLを後から変更せず、新しいマイグレーションを追加します。コードを戻してもDB構造や注文は自動で戻りません。

## 保存と競合対策

対応中の札・注文は小さな状態行に、注文履歴と操作IDは別テーブルへ保存します。状態バージョンの比較更新とD1のbatchトランザクションで同時確定します。
同じ操作IDの再送は一度だけ記録し、異なる本文での再利用を拒否します。番号札の同時使用、二重提供、古いrevisionからの変更もサーバーで拒否します。
取消時に札がない場合も、会計担当だけで後から実物の受領を確認できます。
セッションは操作から2時間で、自動読込では延長しません。DBにはトークンのハッシュを保存し、管理者コード変更で旧管理者セッションを失効します。

## 確認済みと残る事項

- 既存88件とCloudflare25件の計113件のローカルテストに成功。環境間のデータとセッションの分離も確認。
- 公開検証版で独立した5セッション、4担当の同時操作、重複再送、二重提供防止、取消・直接受領を確認。
- このPCから27回のAPI通信は中央値118ms、最大252ms。実端末・混雑時の保証ではありません。
- 無料プランで公開。有料プランへ変更していません。無料枠超過時は処理が制限されます。
- 管理者コードは本人のSecret設定が必要。
- 外部連携、表示名除去、旧注文移行、定期バックアップ/保持期間、本番切替は未完了です。外部連携ボタンは未接続の案内を返し、旧環境へ書き込みません。
- GitHub Actionsは手動テストのみ。Cloudflareへの自動公開接続・共同開発者のCloudflare権限は未設定です。
- 初回公開：2026-10-21。検証履歴は開発用に残し、使用した札は全て再使用可能へ戻しました。スタッフ用へテスト注文はコピーしません。
