# 工大祭2026 TECHSPRESSO 受け渡し管理

ドリンク7種類の注文、カップごとの提供、番号札の回収と会計側への返却確認を管理するApps Script Webアプリです。会計・売上・商品別注文数の基準はAirレジです。

## 共同開発・Cloudflare移行

現行Apps Script版を基準に、Cloudflare Workers + D1版へ移行するためのリポジトリです。
Cloudflare版はスタッフ用と開発用を、別のURL・別のデータベースで公開しています。旧Apps Script版の本番やシミュレーション接続先は変更していません。

**[スタッフ用を開く](https://techspresso-coffee-app.hamaoka123123.workers.dev/)** ／ **[開発・テスト用を開く](https://techspresso-coffee-app-dev.hamaoka123123.workers.dev/)**

一般担当はコード不要。管理者コードの設定、開発・公開方法、未接続の機能は[Cloudflare設定手順](docs/CLOUDFLARE_SETUP.md)を参照してください。GitHubへのpushやマージだけでは自動公開されません。

開発用リポジトリ：[Shintaro123-isct/techspresso-coffee-app](https://github.com/Shintaro123-isct/techspresso-coffee-app)

- [共同開発の進め方](CONTRIBUTING.md)
- [GitHub初期設定](docs/GITHUB_SETUP.md)
- [Cloudflareへの移行方針](docs/CLOUDFLARE_MIGRATION.md)

## 現行版の機能

会計担当・受け渡し担当・管理者・表示専用の4つの担当があります。表示名入力はありません。

一般スタッフと表示専用はコードなし、管理者は管理者用コードでログインします。一般は会計・受け渡しを切替可能。認証は最後のサーバー操作から2時間、自動一覧更新では延長しません。同じ端末・通常ブラウザーのlocalStorageにセッション・入力途中・未確認操作を保存し、コード自体は保存しません。

未提供警告は初期15分、管理者が1〜180分に変更できます。赤い警告とDiscord DMに対応し、通知音は鳴らしません。DMはCloudflare Workersの通知専用中継を利用します。

取消時に番号札の「ある/ない」を選択します。「ある」は即再使用可能。「ない」でも後から会計担当だけで実物の受領確認を完了できます。未提供・札再使用・二重送信は注文ID、revision、操作IDで検証します。

注文記録は日本時間の受付日で10/8までのテスト、10/9前日テスト、10/10、10/11に分類。「当日注文一覧」は本番2日だけです。「操作記録」が保存元で、一覧への直接編集ではアプリ状態は変更できません。

シミュレーション側は専用記録シートから15分ごとの7種類の注文数のみ取得します。提供杯数は連携しません。既存Bot・仮シフトには書き込みません。

## ソースと検証

- src/core.js：状態遷移・権限・札の重複使用防止
- src/backend.gs：認証・台帳保存・日付別表示
- src/client.js・Index.html・styles.css：操作画面
- deploy/：Apps Scriptへ反映する成果物
- demo/index.html：Googleへ接続しない体験版。実記録とは分離
- tests/：Node.jsの状態・サーバー模擬・UIハンドラー試験
- discord-relay/worker.mjs：現在の通知専用Worker。注文アプリの本体ではありません。
- docs/：共同開発の設定・移行方針

Node.js 22以上、外部パッケージ不要。リポジトリのフォルダーで実行：

```text
npm run test:unit
npm run build
```

模擬テストはGoogle、Discord、本番D1へ接続しません。旧PCにあるシミュレーション照合試験・本番から取得したスナップショット・作業ログは共有対象外です。

現行版の更新には、ビルドしたCode.gs・Index.htmlの照合とApps Script側のデプロイ更新が別途必要です。既存の保存先・権限・認証設定は維持します。

STAFF_CODE・ADMIN_CODEの更新は、本人がスクリプトプロパティへ異なる12〜200文字の値を入力し、rotateStaffAdminCodes_を呼ぶ一時入口を本人が実行します。全員の認証が失効しますが注文は保持します。一時入口は公開せず、実行後に除去します。

複数端末の実通信、通信遅延・ブラウザー終了後の復帰は模擬テストだけでは保証できません。返却保存中も他画面で入力できますが、次の保存・札再利用は保存確認待ちです。0.5秒以内の保存保証はありません。
