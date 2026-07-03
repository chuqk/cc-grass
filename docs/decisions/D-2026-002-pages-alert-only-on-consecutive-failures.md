---
id: D-2026-002
status: accepted
scope: repo
applies_to: gh-pages デプロイ運用 (gh-pages:.github/workflows/pages.yml)
triggers:
  - pages workflow の失敗通知・リトライ段数を変えようとするとき
  - 「デプロイが失敗しているのに run が success」の理由を調べるとき
  - Pages の failed メールについて議論するとき
watch: []
supersedes: null
decided_at: 2026-07-04
decided_by: ちゅっく
source_session: d72c7196-e66c-4670-be02-c709d65cfc0b
summary: デプロイ失敗の通知は「2 run 連続全滅 = サイト20分以上 stale」のみ。単発失敗は無音 (次 cron が自己回復するため通知価値ゼロ)。
---

# Pages デプロイの失敗通知は連続 run 全滅時に限定する

## Context

D-2026-001 (自前 workflow + リトライ1回) 導入後も、GitHub 側の "Deployment failed, try again later." のエラー率が高止まりし (試行単位 ~25-30% が丸2日継続)、リトライ1回では run 単位 ~9% が失敗 = 1日13通ペースでメールが残った。10分毎 cron の自己回復構造により単発失敗の実害はゼロで、通知だけが偽陽性アラートとして残っていた。

## Decision

- deploy-pages の試行を計3回に増強 (間隔 30秒 → 90秒、バースト失敗を跨ぐ)
- 3試行全滅でも**直前の run が成功していれば job は success で終える** (無音)。次の cron が10分後に拾う
- **直前 run も失敗していた場合のみ exit 1** = メール通知は「サイトが20分以上更新停止」の本物アラートに限定
- 直前 run の判定は workflow 内で `gh run list` (permissions: actions: read、GITHUB_TOKEN で完結)

## Rejected alternatives and why

- **リトライ増強のみ**: エラー率25%が続く限り確率的にメールが残る (3試行でも1日2-3通)。確率で戦わず構造で止める
- **Actions 失敗メール通知のオフ**: 全リポ一律でしか切れず、本物の異常も見逃す
- **Discord アラートへの置換**: public repo に bot token の secret 管理を持ち込むことになる。GitHub 標準メールで十分
- **外部死活監視 (bashboard 側で stale 検知)**: 監視主体が分散する。workflow 内で完結する方が追いやすい

## Consequences

- 「run が success なのにデプロイは失敗している」状態が正常に存在する (ログ末尾に Staying green と明示)。デプロイ実態は environment (github-pages) の deployment 履歴で見る
- メール = 20分以上の継続障害のみ。受信箱の静けさが意味を取り戻す
- 全滅時の run 時間は最大 ~4分 (30+90秒待ち + 3試行)。10分間隔なので重複なし (concurrency ガードもあり)

## Revisit when

- 「2 run 連続全滅」メールが実際に届いたとき (GitHub 側の大規模障害 or こちらの構造問題を切り分ける)
- GitHub Pages のデプロイ信頼性が恒久回復し、リトライ3段が過剰になったとき (段数を戻してよい)
- cron 頻度を変えるとき (「20分 stale」の閾値が連動して変わる)
