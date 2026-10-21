# Cloudflareへの移行方針

## 合意した方向

- アプリの実行先：Cloudflare Workers
- 注文と提供記録の保存先：Cloudflare D1
- ソース管理：今回専用の公開GitHubリポジトリ（本人が公開を許可）
- 開発、検証、公開を複数人で分担できるようにする
- 無料プラン内で設計し、課金プランへ自動変更しない
- スプレッドシートのシミュレーション連携を維持する

## 今回のGitHub準備に含むもの

現行Apps Script版のコード、独立した模擬テスト、公式ロゴ、通知中継コード、共同開発手順。
2026-10-21にCloudflare版を実装し、開発用とスタッフ用を別Worker・別D1で公開しました。URLと操作手順は[CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md)を参照してください。
旧Apps Scriptの接続先は維持しています。Cloudflare版のスプレッドシート・シミュレーション・Discord連携と、本番営業への切替はまだ行っていません。

## 次の段階

1. GitHubログイン、今回専用の公開リポジトリ作成、初回pushを完了する。既存の別アプリのリポジトリには触れない。
2. 各メンバーの権限と無料利用枠・予算を確認する。
3. Cloudflareの無料プランで開発用Workerと検証用D1を作る。
4. 現行の注文・提供・取消・札返却と再使用・担当認証を移植する。
5. 注文ID、操作ID、revision検証をD1のトランザクション/制約へ対応させる。
6. シミュレーションへ取り込む注文の形式、取消、手動補正、切断/再接続を検証する。
7. GitHub連携の対象をこのリポジトリだけに絞り、まず検証環境へ接続する。
8. 複数端末・応答時間・無料枠使用量・データ移行と復帰手順を検証後、本番切替を行う。

## 公開管理

Cloudflare Workers BuildsはGitHubの選択したブランチへのpushからデプロイできる。
接続・権限承認前に、対象リポジトリ、ブランチ、環境、データベースを確認する。
現行Apps Scriptや既存のDiscord通知Workerを接続先に流用しない。
DBの構造変更はアプリのコードを戻すだけでは取り消せないため、移行・バックアップを別途管理する。

## 公式資料

- https://developers.cloudflare.com/workers/ci-cd/builds/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/workers/platform/pricing/
