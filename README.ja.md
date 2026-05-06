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
- **`/usage` と数字が一致。** トークン集計は `/usage > Stats` と同じ式（`input + output`、cache なし、subagents なし）。

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
| `--since <YYYY-MM-DD>` | 364 日前 | 期間の始め（ローカル時刻） |
| `--until <YYYY-MM-DD>` | 今日 | 期間の終わり（含む） |
| `--theme <dark\|light>` | `dark` | テーマ |
| `--header <string>` | 自動 | ヘッダ文言を上書き |
| `--claude-dir <path>` | `~/.claude` | Claude Code データディレクトリを上書き |
| `--include-subagents` | off | サブエージェントの jsonl も合算（数字が増える） |
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

# サブエージェント込み
npx cc-grass --include-subagents -o grass-with-subs.svg
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

1 日あたりの `tokens` = その日（ローカル時刻）の各エントリの `message.usage.input_tokens` + `message.usage.output_tokens` の合計。Claude Code の `/usage > Stats > Overview` の `Total tokens` と同じ式。`cache_read_input_tokens` と `cache_creation_input_tokens` は含まない。`--include-subagents` を付けるとサブエージェント分が乗るが、それを付けない限り `/usage` の数字と一致する。

なお `--metric prompts` は `type:"user"` で `content` が実際の人間プロンプト（tool_result じゃない）のものだけを数える。`--metric sessions` はその日にアクティブだった jsonl ファイル数。

## プログラム API

```ts
import { parseClaudeProjects, renderSvg } from "cc-grass";

const data = await parseClaudeProjects({ includeSubagents: false });
const svg = renderSvg({
  buckets: data.buckets,
  metric: "tokens",
  since: new Date(Date.now() - 364 * 86_400_000),
  until: new Date(),
  total: data.total,
});
console.log(svg);
```

## ライセンス

[MIT](https://github.com/chuqk/cc-grass/blob/main/LICENSE) © chuqk
