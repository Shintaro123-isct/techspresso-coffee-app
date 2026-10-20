# 共同開発の進め方

このリポジトリはTECHSPRESSO受け渡し管理Webアプリの開発用です。
現在のApps Script版を基準に、Cloudflare Workers + D1版を別の開発ブランチで作ります。
公開中のApps Script、注文台帳、旧Bot、シフトはこのリポジトリへのpushで変更されません。

## 開発開始

GitとNode.js 22以上を用意し、リポジトリをcloneして実行します。

```sh
npm run test:unit
npm run build
```

現段階のコードには外部npm依存関係がありません。
`deploy/`と`demo/`はビルドで生成します。Gitへ追加しません。

## 変更とレビュー

1. 最新のmainから`codex/変更内容`などの作業ブランチを作ります。
2. コードと必要なテストを変更します。
3. 上記のテストとビルドを実行します。
4. pushしてPull Requestを作ります。
5. 他のメンバーが確認し、mainへマージします。

GitHubの権限によってはレビュー必須を強制できないため、無料プランでは運用ルールとして守ります。
自分のGitHubアカウントを使用し、パスワード・トークンを共用しません。
参加メンバーへの招待は所有者がGitHubのSettings > Collaboratorsから行います。

## 費用と権限

- リポジトリは非公開を前提とします。
- GitHub Actionsは初期状態では手動実行のみです。所有者が無料枠と課金予算を確認するまで実行しません。
- Actionsは読み取り権限のみで、CloudflareやGoogleの認証情報は登録しません。
- 本番の公開担当と確認手順は、Cloudflare接続前に決めます。

## 共有しないもの

利用コード、Discordトークン、Google認証JSON、Cloudflareトークン、`.env`、`.dev.vars`、注文台帳、個人情報を含むエクスポート・画像・作業ログは追加しません。
`.gitignore`は共有対象を明示的に許可する形式です。新しいファイルを追加するときは除外設定も確認してください。
認証情報はCloudflareやGoogle側の設定で管理します。
