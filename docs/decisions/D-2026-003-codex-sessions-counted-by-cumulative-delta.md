---
id: D-2026-003
status: accepted
scope: repo
applies_to: src/parse.ts の Codex パーサ、--codex-dir / --no-codex、README のトークン計算式
triggers:
  - Codex / GPT のトークン数が ccusage や Codex 側の表示と合わないと言われたとき
  - Codex ログの読み方 (token_count / token_usage_record / last_token_usage) を変えようとするとき
  - cc-grass を Claude Code 専用に戻す・他ツールのログを足す議論が出たとき
watch: []
supersedes: null
decided_at: 2026-09-08
decided_by: ちゅっく
source_session: a60facbb-297a-4c6f-b04a-431acd52a1a3
summary: Codex CLI の ~/.codex/sessions を既定で計上する。数え方は token_count の累計値の差分 (合算は二重記録で過大)。モデル確定前の累計はフォークの持ち越しとみなし読み捨てる。
---

# Codex CLI セッションを既定で計上し、累計値の差分で数える

## Context

本人は 2026-07 以降 Claude Code と Codex CLI の二刀流 (D-2026-186)。GPT-6 の使用が cc-grass に出ないという
指摘を追うと、GPT の使用履歴は `~/.claude` にはなく `~/.codex/sessions/**/rollout-*.jsonl` にあった。
Codex の rollout は Claude Code の jsonl と形式が全く違う: 使用量は `event_msg` の `token_count` に
セッション累計 (`total_token_usage`) と直前応答分 (`last_token_usage`) で載り、モデル名は `turn_context` /
`session_meta` の `payload.model` にある。

## Decision

- `~/.codex/sessions` と `archived_sessions` を **既定で計上** する (`--no-codex` で除外、`--codex-dir` で場所指定)。
  ディレクトリが無ければ無音で 0 件
- トークンは **`total_token_usage` の差分** で数える。`cached_input_tokens` は `input_tokens` の内数なので
  cacheRead に写し、非キャッシュ input = input − cached。請求対象 = input + cache_write + output
- **モデルが確定する前に来た累計はベースライン** として読み捨てる。フォークしたスレッドは先頭の `token_count` に
  親の累計を持ち越しており、親ファイルで既に数えている
- プロンプト数は `task_started` イベント 1 件 = 1
- GPT 系の単価は pricing.ts に載せない (公開単価を確認していない値を書かない。費用は表示されない)

## Rejected alternatives and why

- **`last_token_usage` の合算**: 同じ `token_count` が二重記録される箇所があり、実測で累計より約 3% 過大
- **`token_usage_record` を使う**: 新しい Codex でしか出ない (869 ファイル中 10 ファイル)。過去分が欠ける
- **Claude Code 専用に留める (Codex は別ツール)**: 本人の実使用は二刀流で、GPT 分が抜けた草は「AI コーディング使用量」として嘘になる。
  「依存ゼロ・SVG 生成だけ」の哲学はログを1種類増やしても崩れない
- **Codex 用に別キャッシュファイル**: ファイルパスがキーなので同居で衝突しない。分けると `--no-codex` 切替時の prune が複雑になるだけ

## Consequences

- テストで `claudeDir` をフィクスチャに向けても、`includeCodex: false` (CLI は `--no-codex`) を付けないと本物の `~/.codex` を読む
- 凡例の GPT 系列は sol / luna / astra などコードネーム付きの変種がそのまま並ぶ (統合しない)
- Codex 側の `/status` や rate limit 表示とは一致しない (それらは窓ベースの割合)

## Revisit when

- Codex が rollout 形式を変え、`token_count` の累計が取れなくなったとき
- GPT 系の公開単価が確定し、費用推定を出したくなったとき
- 第3のツール (Gemini CLI 等) を足す話が出たとき — 同じ「別パーサ + 同居キャッシュ + --no-X」の型で足す
