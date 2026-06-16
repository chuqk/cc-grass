# cc-grass

> Claude Code の使用量で **オレンジ色の GitHub 草** を生やす CLI。`~/.claude/projects/**/*.jsonl` を直接読んで、プロフィール README に貼れる SVG を出します。

[English](https://github.com/chuqk/cc-grass/blob/main/README.md) · [简体中文](https://github.com/chuqk/cc-grass/blob/main/README.zh-CN.md) · [한국어](https://github.com/chuqk/cc-grass/blob/main/README.ko.md)

<p align="center">
  <img src="https://raw.githubusercontent.com/chuqk/cc-grass/main/examples/sample.svg" alt="cc-grass example" width="760">
</p>

<p align="center">
  <a href="https://chuqk.github.io/cc-grass/">▶ インタラクティブ版（ホバーで日別 token 数）</a>
</p>

> **プライバシー注意**: 上のサンプル画像とインタラクティブページは作者本人の `~/.claude` の実数値です。自分の環境で `cc-grass` を実行すると **あなた自身の活動量** が出力される（日別 token 量・稼働時間帯・休んだ日まで分かる）ので、どこに貼るかは意識して。

## なにこれ

Claude Code の `/usage > Stats` には既に GitHub 風の草が出ているけど、それはターミナルの中でしか見られない。**cc-grass** は同じデータを読んで、GitHub の contribution graph と寸分違わぬレイアウトの SVG を吐く。色だけオレンジ。これを GitHub プロフィール README に貼る。

- **依存ゼロ。** `fs` / `path` / `os` だけで完結。`ccusage` も API も使わない。
- **クロスプラットフォーム。** macOS / Linux / Windows、Node ≥ 18。
- **SVG を吐くだけ。** デーモンも cron もバンドルしない。実行頻度は自分で決める。
- **GitHub 草の完全再現。** 10×10 セル、3px gap、角丸、Mon/Wed/Fri ラベル、月ヘッダ、Less/More 凡例まで。
- **全課金トークンを集計。** API が課金する全てを数える: `input`、`output`、`cache_creation`、`cache_read` — サブエージェントもデフォルトで含む。

## さっそく使う

```bash
# ファイルに書き出す
npx cc-grass --output grass.svg

# stdout に
npx cc-grass > grass.svg

# hover 動く HTML 版（実ブラウザで日付ホバーで詳細）
npx cc-grass --html --output grass.html
```

README に貼る:

```md
![Claude Code grass](./grass.svg)
```

## オプション

| オプション | デフォルト | 説明 |
|---|---|---|
| `--metric <prompts\|sessions\|tokens>` | `tokens` | 何を 1 日あたりカウントするか |
| `--output <path>`, `-o` | stdout | ファイル出力 |
| `--since <YYYY-MM-DD>` | `--until` の 52 週前の日曜 | 期間の始め（ローカル時刻、GitHub のグリッドと一致） |
| `--until <YYYY-MM-DD>` | 今日 | 期間の終わり（含む） |
| `--theme <dark\|light>` | `dark` | テーマ |
| `--header <string>` | 自動 | ヘッダ文言を上書き |
| `--claude-dir <path>` | `~/.claude` | Claude Code データディレクトリを上書き |
| `--include-subagents` | on | サブエージェントの jsonl も合算（`--no-include-subagents` で除外） |
| `--html` | off | hover ツールチップが効く HTML として出力 |
| `--version`, `-v` | — | バージョン表示 |
| `--help`, `-h` | — | ヘルプ |

## 例

```bash
# 直近 30 日
npx cc-grass --since 2026-04-06 --until 2026-05-06 -o month.svg

# トークンじゃなくプロンプト数で草を生やす
npx cc-grass --metric prompts -o prompts.svg

# ライトテーマ
npx cc-grass --theme light -o grass-light.svg

# サブエージェント除外（Claude Code /usage の数字と一致）
npx cc-grass --no-include-subagents -o grass-main-only.svg
```

## ホバーツールチップと GitHub README の制約

各セルには `<title>1,234 tokens on May 6th.</title>` が仕込んであって、SVG をブラウザで直接開けばホバーで日付＋トークン数が出る。`--html` で出力した HTML 版でも動く。**ただし GitHub README に貼った場合は効かない** — GitHub は SVG を `<img>` で埋め込むので、ブラウザは中身の `<title>` を読まない。これは仕様の壁で cc-grass のバグじゃない。`<title>` はスクリーンリーダーや SVG 単独閲覧時にはちゃんと使える。

ホバーが必須なら `--html` 出力を GitHub Pages にホストして、README からはリンクで飛ばすのが現実解。

## 自動更新

cc-grass はあえてスケジューラを内蔵していない。好きな方法で：

```bash
# crontab: 毎時走らせて差分があったら commit + push
0 * * * * cd ~/profile-repo && npx -y cc-grass -o grass.svg && git add grass.svg && (git diff --cached --quiet || (git commit -m "update grass" && git push))
```

`(... || (... && ...))` の括弧は意図的。フラットに `A && B && C || D` と書くと bash は `((A && B) && C) || D` と評価するので、`A`/`B`/`C` のどれかが失敗しても `D` の commit + push が走ってしまう。サブシェルで囲むことで「差分がある時だけ」commit + push が起動するように保証している。

GitHub Actions の `workflow_dispatch` を手元から叩く方式でも、profile repo に commit する直前に手で走らせるでも、なんでも。

## トークン計算式

1 日あたりの `tokens` = その日（ローカル時刻）の各エントリの 4 つの `usage` フィールドの合計: `input_tokens` + `output_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens`。API が課金する全トークンを数える。サブエージェントの jsonl はデフォルトで含まれる。`--no-include-subagents` を渡すと除外できる（Claude Code の `/usage` の数字と一致する）。

`--html` 出力にはインタラクティブな棒グラフが含まれ、ツールチップにモデル別の推定 API コストが表示される。コストは各モデルの公開 per-MTok レートを使い、4 つのトークンカテゴリそれぞれの単価で算出される（cache read は安く、cache write はベース input より高い）。

なお `--metric prompts` は `type:"user"` で `content` が実際の人間プロンプト（tool_result じゃない）のものだけを数える。`--metric sessions` はその日にアクティブだった jsonl ファイル数。

## プログラム API

```ts
import { parseClaudeProjects, renderSvg } from "cc-grass";

// CLI のデフォルトと同じ：until の 52 週前の日曜
const until = new Date();
const since = new Date(until);
since.setHours(0, 0, 0, 0);
since.setDate(since.getDate() - since.getDay() - 364);

const data = await parseClaudeProjects();
const svg = renderSvg({
  buckets: data.buckets,
  metric: "tokens",
  since,
  until,
  total: data.total,
});
console.log(svg);
```

## ライセンス

[MIT](https://github.com/chuqk/cc-grass/blob/main/LICENSE) © chuqk
