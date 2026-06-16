# cc-grass

`~/.claude/projects/**/*.jsonl` を読んで、GitHub プロフィール用の **草 SVG** を生成する OSS CLI。

経緯は `SESSION_LOG.md` を参照。

## 哲学

- **依存ゼロ** — `fs`/`path`/`os` だけで完結
- **クロスプラットフォーム** — Win / Mac / Linux、Node >=18
- **シンプル** — SVG 生成だけ。push / cron は含めない
- **GitHub 草パロディ** — dark mode contribution graph のピクセルパーフェクト再現

## トークン計算

全4種別を合算: `input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens`。subagents はデフォルト込み (`--no-include-subagents` で除外可)。

`--html` 出力の棒グラフツールチップにはモデル別の推定API費用を表示 (`src/pricing.ts` に単価テーブル)。

## ソース構成

| ファイル | 役割 |
|---|---|
| `src/parse.ts` | jsonl → 日別 bucket (トークン4種別 × モデル別) |
| `src/pricing.ts` | モデル別 API 単価テーブル |
| `src/levels.ts` | 値 → 草レベル (0-4) の閾値計算 |
| `src/svg.ts` | bucket → SVG 文字列 |
| `src/html.ts` | SVG + 棒グラフ付き HTML ページ |
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
- npm publish: `npm version patch && npm publish --access=public && git push --follow-tags`

## やらないこと

- ccusage 等の外部 CLI への依存
- `git push` / リモート repo 編集ロジックの内蔵
- WakaTime 系との連携
