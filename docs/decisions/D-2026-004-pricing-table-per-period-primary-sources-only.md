---
id: D-2026-004
status: accepted
scope: repo
applies_to: src/pricing.ts、src/parse.ts の cache_creation TTL 内訳、--html ツールチップの費用表示
triggers:
  - 新モデルがログに現れて費用が出ない・`price n/a` が出るとき
  - ベンダーが既存モデルの単価を改定したとき
  - 単価テーブルに値を足す・直すとき
  - 「費用が合わない」と言われたとき
watch: []
supersedes: null
decided_at: 2026-09-09
decided_by: ちゅっく
source_session: 7ec244d6-867c-488f-967e-a26d83c5c9e3
summary: API 単価は「モデル × 価格期間」で持ち、日付で引く。値は Anthropic・OpenAI の一次情報で確認したものだけ載せ、単価不明は $0 でなく price n/a と明示する。cache write は 5 分 / 1 時間 TTL を別単価にする。
---

# 単価は期間付きで持ち、一次情報で確認した値だけ載せ、不明は明示する

## Context

2026-09-09 の草 HTML で、9 月の費用が 1 日 $3.73 と表示された。原因は `pricing.ts` が完全一致の単一テーブルで、
凡例 23 モデル中 15 モデル (Fable 5.1 / Opus 5 / Sonnet 5 と GPT 系 12) が未登録、未登録は黙って $0 に落ちる作りだったこと。
本人の指摘: 「3 モデルどころじゃない」「単価は新モデルが出ると替わる。期間ごとに一次情報から全部調べて」。

一次情報 (公式 docs・発表記事・web.archive.org の公式ページ写し) を 2 系統で調べた結果:
- Anthropic は Haiku 3.5 が 2024-12-03 に $1/$5 → $0.80/$4 に改定された以外、既存モデルの基本単価は不変。
  ただし Fable 5.1 の cache read は $0.25 (Fable 5 は $1.00)、Sonnet 5 は $2/$10 (Sonnet 4.6 は $3/$15)
- OpenAI は GPT-5.6 Sol が 2026-08-21 に 20% 値下げ ($5/$30 → $4/$20)、GPT-5.6 Luna が 2026-07-30 に $1/$6 → $0.20/$1.20。
  どちらも本人の使用期間の途中に落ちる
- Claude Code の jsonl は `cache_creation.ephemeral_1h_input_tokens` で 1 時間 TTL の cache write を分けており、
  本人ログでは 1h 55.7 億 / 5m 43.2 億トークン。1h は input の 2x、5m は 1.25x なので、区別しないと数万ドル単位でずれる

## Decision

- `PRICING: Record<model, PricePeriod[]>`。各期間は `from`/`to` (両端含む暦日)、現行は `to` なし。
  `estimateCost(model, tokens, date)` はその日に有効な期間の単価で計算する。改定は発効日以降にだけ効く
- **一次情報で確認した値だけ載せる**。出典 URL をファイル頭のコメントに置き、改定行にはその出典をコメントで添える。
  記憶や第三者まとめサイトの値は書かない (第三者は日付の当たりを付ける用途のみ、必ず公式か archive の公式で裏を取る)
- **単価不明は `price n/a`** と表示し、合計には `+` を付けて「不明分を含まない」ことを示す。黙って $0 にしない
- `TokenBreakdown.cacheWrite1h` を足し、cache write を 5 分 TTL (1.25x) と 1 時間 TTL (2x) で別計算。
  キャッシュ形式が変わるので `CACHE_VERSION` を 2 に上げた (旧キャッシュは全再走査)
- モデル ID の正規化: 日付サフィックス (`-20251101`)・`-latest`・Codex の effort サフィックス (`-high`) を落として検索
- 発売日より前のログ (プレビュー利用) は発売時単価で計算する。退役日より後は不明扱い

## Rejected alternatives and why

- **未登録モデルにファミリー既定値 (例: Opus なら $5/$25) を当てる**: Sonnet 5 は $2/$10、Fable 5.1 の cache read は Fable 5 の 1/4 で、
  同族でも外れる。当て推量の費用は「出ない」より悪い
- **単一テーブルのまま値だけ足す**: 改定を反映すると過去の日が書き換わる。Sol の値下げが使用期間の途中にある時点で成立しない
- **長文脈プレミアム (Claude 4.6 世代の >200K beta、GPT の >272K) とファストモードの反映**: リクエスト単位の判定が要り、日次バケットに無い。
  ログに `speed: "fast"` は 0 件。非対応と明記して見送り
- **3 系列目の単価 (Gemini 等) の先回り登録**: ログに無いものは載せない

## Consequences

- 9 月の費用は 1 日 $350〜$2,000、年間合計は API 換算で約 $124k (本人は定額プランなので実請求ではない。README に注記)
- 新モデルが出たら `price n/a` が見えるので気づける。足す時は一次情報の URL を持って 1 行追加
- D-2026-003 の「GPT 系の単価は載せない」は Amendment 1 で撤回
- `tests/pricing.test.ts` がログに現れる全モデルの現行単価存在・期間境界・TTL 別計算を固定する

## Revisit when

- ベンダーが既存モデルの単価を改定したとき (行を足すだけ。上書きしない)
- 長文脈プレミアムやファストモードの使用がログに出始めたとき (parse.ts でリクエスト単位の判定が要る)
- Codex が `token_count` に cache write を出し始めたとき (GPT-5.6 以降は cache write 1.25x が課金対象)
