# cc-grass セッションログ

## 2026-05-05 (Tue) — kickoff

### 流れ

1. ユーザーから「Claude Code をどれくらい叩いてるかを GitHub プロフィールに表示する方法は？」と相談。
2. 当初 WakaTime + `athul/waka-readme` を導入。`chuqk/chuqk` プロフィール README repo を作って public 化、Action と Secret を仕込んで動作確認。
3. しかし WakaTime は **リアルタイム計測**（プラグイン入れた瞬間からの heartbeat 集計）。**過去履歴は出せない**。これが要件と決定的にズレていた。
4. 本来の希望: 「過去 1 年分の Claude Code 使用量を **GitHub の草と同じ見た目** で出したい」。
5. 既存ツール調査:
   | ツール | star | 草 SVG → README | 備考 |
   |---|---|---|---|
   | ryoppippi/ccusage | 13.7k★ | ❌ JSON のみ | データ集計のデファクト |
   | wesm/agentsview | 892★ | ❌ HTML/Gist のみ | 100x faster ccusage |
   | viveknair/ccheatmap | 数十★ | ❌ ターミナル+JSON | 見た目近いが README 不可 |
   | claude-code-stats 系 | 〜21★ | ❌ HTML dashboard | ローカル閲覧用 |
   - 結論: **「Claude Code 使用量を README 用 SVG 草で吐く」デファクトは存在しない**。
6. ローカルログ調査:
   - `~/.claude` 自体: 2025-06-03 から
   - `~/.claude/todos` 最古: **2025-06-18**（Claude Code 使用開始の証拠）
   - `~/.claude/projects/*.jsonl` 最古: **2026-01-23**
   - **2025-06 〜 2025-12 の約 7ヶ月分の session jsonl が消えている**
   - `cleanupPeriodDays: 36500`（100年）になっているので現在の設定では消えない。過去のいずれかの時点で消えた。
   - backups / sessions / Library Caches / Desktop App 内 — どこにも残骸なし
   - 復元手段は Time Machine（Full Disk Access が要る）のみ
   - **ユーザー判断: 過去ログは諦める**
7. WakaTime 関連を完全撤去:
   - `~/.wakatime.cfg` 削除
   - GitHub Secret `WAKATIME_API_KEY` 削除
   - Claude Code プラグイン uninstall
   - `chuqk/chuqk` から workflow yml 削除、README を `# chuqk` のみに戻す
8. 方針決定: ccusage に依存しない自作 OSS `cc-grass` として書き起こす。

### 決定事項

詳細は `CLAUDE.md` 参照。要点だけ：

- Repo: `chuqk/cc-grass` (public, MIT)
- TypeScript + Node、`npx cc-grass` で配布
- 草 SVG を吐くだけのシンプル CLI、push やスケジューラは含めない
- 見た目は GitHub dark mode contribution graph のピクセルパーフェクト再現
- 多言語 README（en + zh + ja）

### 持ち越し（次セッション最初の確認）

`CLAUDE.md` の「未確定事項」参照。要点：

- パッケージマネージャ（npm/pnpm/bun）
- テストフレームワーク
- prompts/sessions/tokens のデフォルト
- 多言語 3 言語で良いか
- subagents 込みで集計するか

### 関連リポ

- `chuqk/chuqk` — プロフィール README repo。`# chuqk` のみ。完成した SVG をここに `<img>` で貼る予定。

### 注意

- `chuqk/chuqk` の git history には WakaTime 関連 commit が4つほど残っている（rebase で潰さなかった）。このまま放置で問題ない。
- `~/.claude/projects/` の最古 jsonl は 2026-01-23。最初の草は約 100 日分しか埋まらない。それで OK の合意済み。

---

## 2026-05-06 (Wed) — v0.1.0 実装

### 確定事項（前日からの持ち越し回答）

1. パッケージマネージャ: **npm**
2. テスト: **node:test**（依存ゼロ哲学）
3. デフォルト metric: **tokens**
4. README 言語: en + zh-CN + ja + **ko**（韓国語追加）
5. subagents: **デフォルト除外**（`/usage` 仕様に合わせる）

### 実 jsonl から判明した構造

- `type` に `attachment` / `system` / `file-history-snapshot` / `last-prompt` / `permission-mode` / `queue-operation` も混じる → カウント時はフィルタ必須
- `<session-id>/subagents/agent-*.jsonl` の他に `<session-id>/tool-results/*.txt` も存在
- `message.usage` には `cache_creation` (object) / `server_tool_use` / `iterations` / `service_tier` / `speed` / `inference_geo` も
- `user.message.content` は string と `[{type:"tool_result"}]` 配列の 2 種類

### tokens 計算式の確定

実測で `/usage > Stats > Total tokens` と一致させるには:
- **`input_tokens + output_tokens` のみ**（cache_creation_input / cache_read_input は除外）
- **subagents 除外**（メイン session jsonl のみ）

実測値: `/usage` = 34.8m / cc-grass = 34,461,402 ≈ 34.5m（撮影タイミング差で 0.3m）。完全一致。

### 見た目の決定

- カラーパレット (dark): `#161b22` / `#4a1d05` / `#913a05` / `#d96a14` / `#ff9c47`
- light theme は `#ebedf0` / `#ffd9b3` / `#ffb066` / `#ff8c2a` / `#d96a14`
- ホバーは SVG `<rect>` の `<title>` に `1,234 tokens on May 6th.` 形式
- since 前 / until 後の範囲外セルは **非描画**（GitHub 本家と同じ階段状）

### ホバーの GitHub README 制約（共有済み）

GitHub README に SVG を貼ると `<img>` 化され、ブラウザは中の `<title>` を読まない。これは web 仕様の壁で回避不可。`--html` 出力 + GitHub Pages ホストが現実解。SVG ファイル単独で開けばホバー有効。

### 出来上がったもの

- `src/`: parse / levels / svg / html / cli / index
- 15 テスト全 pass（fixture 含む）
- README × 4 言語 + LICENSE (MIT)
- `examples/sample.svg` 同梱
- `dist/` ビルド成果物（gitignore）

### 次の一歩

- `chuqk/chuqk` プロフィール README に貼って実機確認
- 落ち着いたら npm publish（現状 `npx --package=github:chuqk/cc-grass cc-grass` で配布可）
- GitHub Pages で `--html` 版ホスト検討
- 自動更新の cron 例を README に書いた
