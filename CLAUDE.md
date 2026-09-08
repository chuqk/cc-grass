# cc-grass

`~/.claude/projects/**/*.jsonl` (と、あれば `~/.codex/sessions` の Codex CLI ログ) を読んで、GitHub プロフィール用の **草 SVG** を生成する OSS CLI。

経緯は `SESSION_LOG.md` を参照。

## 哲学

- **依存ゼロ** — `fs`/`path`/`os` だけで完結
- **クロスプラットフォーム** — Win / Mac / Linux、Node >=18
- **シンプル** — SVG 生成だけ。push / cron は含めない
- **GitHub 草パロディ** — dark mode contribution graph のピクセルパーフェクト再現

## トークン計算

全4種別を合算: `input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens`。subagents はデフォルト込み (`--no-include-subagents` で除外可)。

Codex CLI (`~/.codex/sessions`、`--no-codex` で除外可) は `token_count` イベントの累計値の差分で数える (同一イベントが二重記録されるため合算は不可)。`cached_input_tokens` は `input_tokens` の内数なので cacheRead に写し、請求対象は `input + cache_write + output`。モデル名は `turn_context.payload.model` (例 `gpt-6-astra`)。GPT 系の単価は `pricing.ts` 未登録 (ツールチップに費用は出ない)。

`--html` 出力の棒グラフツールチップにはモデル別の推定API費用を表示 (`src/pricing.ts` に単価テーブル)。

## ソース構成

| ファイル | 役割 |
|---|---|
| `src/parse.ts` | jsonl → 日別 bucket (トークン4種別 × モデル別)。Claude Code 形式と Codex rollout 形式の2パーサ。増分キャッシュ統合 |
| `src/cache.ts` | ファイル単位の増分スキャンキャッシュ (mtime+size キー、`~/.cache/cc-grass/`) |
| `src/pricing.ts` | モデル別 API 単価テーブル |
| `src/levels.ts` | 値 → 草レベル (0-4) の閾値計算 |
| `src/svg.ts` | bucket → SVG 文字列 |
| `src/html.ts` | SVG + 棒グラフ付き HTML ページ。配色は既知モデルの固定表 `PAL` + 系列別グラデ `RAMP` (新モデルは系列色の未使用シェードを自動割当・新しいほど濃い)。凡例は系列ごとに1行 |
| `src/cli.ts` | CLI エントリポイント |

## 公開先

| 場所 | URL |
|---|---|
| GitHub | https://github.com/chuqk/cc-grass |
| npm | https://www.npmjs.com/package/cc-grass |
| Pages | https://chuqk.github.io/cc-grass/ |
| Profile | https://github.com/chuqk |

## 運用

- `scripts/update-pages.sh` が gh-pages を更新 (bashboard cron 10分毎)
- Pages デプロイは gh-pages ブランチ上の `.github/workflows/pages.yml` が実行 (build_type=workflow、計3試行、失敗通知は2 run 連続全滅時のみ)
- npm publish: `npm version patch && npm publish --access=public && git push --follow-tags`

## やらないこと

- ccusage 等の外部 CLI への依存
- `git push` / リモート repo 編集ロジックの内蔵
- WakaTime 系との連携
