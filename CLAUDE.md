# cc-grass

`~/.claude/projects/**/*.jsonl` を読んで、GitHub プロフィール用の **草 SVG** を生成する OSS CLI。

このファイルはプロジェクトの DNA。新規セッションはまずこれを読む。詳しい経緯は `SESSION_LOG.md` を参照。

## 哲学

- **依存ゼロ** — ccusage 等を経由せず `~/.claude` を直接 parse する。`fs`/`path`/`os` だけで完結。
- **クロスプラットフォーム** — Win / Mac / Linux 全部で動く。Node のバージョンも幅広く（>=18）。
- **シンプル** — SVG 生成だけ。push / cron / GitHub Action テンプレ等は本体に含めない。ユーザー側で `gh`+cron で組む。
- **GitHub 草パロディ** — 見た目は GitHub の dark mode contribution graph をピクセルパーフェクト再現。「あ、本物コピーだ」と一目で分かるパロ感が肝。

## 確定事項

- Repo: `chuqk/cc-grass` (public)
- License: MIT
- Lang: TypeScript + Node.js
- Distribution: npm (`npx cc-grass`)
- README: 多言語（en root + zh-CN + ja）
- 草の対象先: 作者は `chuqk/chuqk` プロフィール README に貼るが、OSS としては誰でも自分の repo に貼れる

## CLI 仕様（草案、未実装）

```
npx cc-grass [options]

  --metric prompts|sessions|tokens   default: prompts
  --output <path>                    default: stdout
  --since <YYYY-MM-DD>               default: 364日前
  --until <YYYY-MM-DD>               default: today
  --theme dark|light                 default: dark
  --header <string>                  default: "X contributions in the last year"
  --claude-dir <path>                default: ~/.claude
```

## SVG 仕様（GitHub dark mode 完全模倣）

| 要素 | 値 |
|---|---|
| セル | 10×10px, rx=2 |
| gap | 3px |
| 0 contrib | `#161b22` |
| level 1 | `#0e4429` |
| level 2 | `#006d32` |
| level 3 | `#26a641` |
| level 4 | `#39d353` |
| 行ラベル | Mon / Wed / Fri 表示、12px `-apple-system` |
| 月ラベル | 月初週の上、12px |
| legend | `Less ▣▣▣▣▣ More` 右下 |
| ヘッダー | `X contributions in the last year` 左上 |
| 枠 | rounded border、`#30363d` |

5段階の閾値（contrib 数 → level）は GitHub の挙動を観察して決める。とりあえず全期間の**非ゼロ日**の四分位で 1〜4 に振るのが妥当そう。

## データソース

`~/.claude/projects/<project-id>/<session-id>.jsonl` 形式。各行が JSON。subagents は `<session-id>/subagents/agent-*.jsonl` に入る。

各行（推定。実物を見て確かめる）：
- `timestamp`: ISO8601、bucket key
- `type`: `"user"` / `"assistant"` / etc.
- `message.usage.input_tokens` / `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens`

カウント定義の最初のたたき台：
- `prompts`: 各 jsonl 内の `type === "user"` (tool_result 由来は除く) の数
- `sessions`: jsonl ファイル数（subagents 含むかは要相談、デフォは含めない）
- `tokens`: `usage.*` 全部足す

## 未確定事項（最初に user に確認）

1. パッケージマネージャ: npm / pnpm / bun
2. テスト: vitest / node:test
3. カウントのデフォルトは `prompts` で良いか
4. 多言語 README は en + zh + ja の3言語で良いか
5. subagents jsonl を sessions/prompts カウントに含めるか

## 最初の一歩

1. `npm init -y` → `package.json` に `"bin": { "cc-grass": "./dist/cli.js" }`
2. `tsconfig.json`（target ES2022, module Node, strict）
3. ファイル分割の方針:
   - `src/parse.ts` — jsonl → 日別 bucket
   - `src/svg.ts` — bucket → SVG 文字列
   - `src/cli.ts` — 引数 parse、parse() → svg() を繋ぐ
4. **手始めに**: 自分（chuqk）の `~/.claude/projects` の jsonl を1個サンプルとして読み、`type` フィールドの分布、`usage` の構造を実物で確認してから集計ロジックを書く。推測で書かない。
5. 最小実装が動いたら `chuqk/chuqk` の README に貼って動作確認。
6. README × 3言語 + MIT LICENSE + GitHub repo 作成 + 初回 push。
7. npm publish は最後でいい（`npx --package=github:chuqk/cc-grass cc-grass` で配布前テスト可能）。

## 環境メモ

- Node: `~/.nvm/versions/node/v22.18.0/bin/node` (v22)
- gh CLI: 認証済み (user `chuqk`)
- bashboard: `~/dev/bashboard/` 配下。`bashboard.yml` を repo root に置けば cron 自動取り込み（`.gitignore` に追加）

## やらないこと

- ccusage / ccheatmap 等の外部 CLI への依存
- `git push` / リモート repo 編集ロジックの内蔵
- WakaTime 系との連携（一度試したが要件と違ったので撤去済み）
