---
id: D-2026-001
status: accepted
scope: repo
applies_to: gh-pages デプロイ運用 (scripts/update-pages.sh, gh-pages:.github/workflows/pages.yml)
triggers:
  - gh-pages ブランチの .github/workflows/pages.yml を変更・削除しようとするとき
  - Pages の failed メール・デプロイ失敗を調査するとき
  - update-pages.sh の cron 頻度を変えようとするとき
watch: []
supersedes: null
decided_at: 2026-07-04
decided_by: ちゅっく
source_session: d72c7196-e66c-4670-be02-c709d65cfc0b
summary: Pages デプロイは legacy ビルドでなく gh-pages 上の自前 workflow (リトライ付き)。cron 10分毎は維持。
---

# Pages デプロイは自前 workflow + リトライで行う

## Context

10分毎 cron が gh-pages へ push するたび、GitHub 管理の legacy ビルド (pages-build-deployment) が走る構成だった。2026-07-02 の GitHub Pages インシデント以降、status page が正常表示に戻っても「Deployment failed, try again later.」が約25%の率で16時間以上続き、failed メールが30〜60分に1通届き続けた。legacy フローはリトライを持たず、GitHub 側の一時エラーがそのまま failed メールになる。サイト実害はゼロ (次の cron が拾う) で、壊れていたのは通知の静けさだけ。

## Decision

- Pages の build_type を `legacy` → `workflow` に切替
- gh-pages ブランチに `.github/workflows/pages.yml` を設置 (push で発火、deploy-pages 失敗時は30秒待って1回だけ再試行)
- workflow ファイルは gh-pages に置く (`on: push` は push されたブランチ上のファイルでしか発火しないため)。main には置かない
- cron 10分毎・update-pages.sh の構造は変えない

## Rejected alternatives and why

- **cron を30〜60分毎に間引く**: メールが減るだけでゼロにならない対症療法。鮮度も落ちる
- **Actions 失敗メール通知をオフ**: 全リポ一律でしか切れず、他リポの本物の失敗を見逃す
- **様子見 (GitHub 復旧待ち)**: status 正常表示のまま25%失敗が16時間続いた実績があり、分が悪い

## Consequences

- 一時エラーはリトライで吸収され、届く failed メール = リトライでも救えない本物の異常
- gh-pages ブランチが「自動生成物のみ」でなくなる (workflow ファイル1枚が住む)。update-pages.sh は `git add index.html` のみなので共存に問題なし
- Jekyll ビルドを経由しなくなり、デプロイが速い (~40秒)

## Revisit when

- リトライ込みでも failed メールが頻発する (GitHub 側でなくこちらの構造問題を疑う)
- GitHub が legacy ビルドにリトライを実装した、または Pages のデプロイ信頼性が恒久的に改善した
- gh-pages ブランチを作り直す・履歴を切り詰めるとき (workflow ファイルを消さないこと)
