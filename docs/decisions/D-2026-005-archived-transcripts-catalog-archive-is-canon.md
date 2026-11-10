---
id: D-2026-005
status: accepted
scope: repo
applies_to: src/archive.ts、src/parse.ts の archive 経路、--archive-catalog、ScanCache.archives、scripts/update-pages.sh、README「Archived transcripts」
triggers:
  - 会話ログを母艦から別の場所 (NAS 等) へ流す仕組みを変える・増やすとき
  - キャッシュの形式 (CACHE_VERSION) を上げる、キャッシュの鍵を変えるとき
  - 流したはずの日の草が欠けた・二重になったと言われたとき
watch: []
supersedes: null
decided_at: 2026-11-10
decided_by: ちゅっく (daimon 発注書 2026-11-10「直してから流す・過去の草は失わない」・課長召喚で施工)
source_session: cc-grass 課長 2026-11-10 (発注書 postbox/cc-grass/2026-11-10-daimon-order-keep-archived-history.md)
summary: 流した会話ログは「流した先の目録」(JSONL) を --archive-catalog で渡すと草に残る。流した先の写しが正本・キャッシュは派生物 — キャッシュに無い分だけ写しから 1 回読み直し、読めなければ終了コード 3 で欠けを確定保存しない。目録ありの走行は別のキャッシュファイルを使う。オプションなしの振る舞いは不変。
---

# 流した会話ログは目録で残し、流した先の写しを正本にする

## Context

母艦の会話ログ (Claude Code `~/.claude/projects`・Codex `~/.codex`) を古い分から NAS へ流す夜便が本番前。
cc-grass のキャッシュは走査で見つからないファイルを捨てる (prune) ので、流した日の過去の草が次の 10 分便で消える。
影響面はプロフィールの草 (chuqk `update-grass.sh` = npm 最新版) と Pages (`update-pages.sh` = ローカル dist)。
cc-grass は公開 OSS なので、特定の流し方の名前を持ち込まず一般機能として出す。

## Decision

- **`--archive-catalog <path>` (繰り返し可) / `parseClaudeProjects({ archiveCatalog })`**。目録 = JSONL 1 行 1 本、
  欄は `source_path` (流す前の実体パス・必須)・`nas_path` (写し・必須・.gz 可、`member` があれば tar(.gz) の束)・`member`・
  `nas_dir_archive` (兄弟 folder `<id>/` の tar(.gz))・`mtime`。同じ `source_path` は後の行が勝つ
- **流した先の写しが正本・キャッシュは派生物**。消えたファイルのうち目録に載る分 (本体と `<id>/` 配下) はキャッシュの集計を残す。
  キャッシュに無い・古い (目録の `mtime` とキャッシュの mtime が 1 秒超ずれる) 分だけ写しから読み直す。一度数え終えた本は
  `ScanCache.archives[source_path] = 写しの識別子 (hash)` で印を付け、以後は NAS を読まない
- **読めなかった時**: 「読めなかった N 本」を標準エラーに出し、出力は書くが **終了コード 3**。その本は印を付けずキャッシュに
  確定保存しない (古い集計があれば残す) → 次の回で読み直す。`set -e` の更新スクリプトは公開を見送り、前回の良い草が残る
- **目録ありの走行は別のキャッシュファイル** (鍵 = projects パス + 目録パス)。目録なしの走行 (旧版の npx を含む) と同じファイルを
  共有すると、目録なし側が流した分を prune → 目録あり側が NAS から読み直す、を 10 分ごとに繰り返すため
- 目録ありでは **実体パスで走査し、subagents を常に走査する** (数える時に `--no-include-subagents` を当てる)。目録の `source_path` は
  symlink 解決済みで、流す前に兄弟 folder の全ファイルがキャッシュに入っている必要があるため
- 目録に無い消滅 (改名・本当の削除) は従来どおり外す。流した本を元の場所へ戻した時はパスが同じなので 1 回だけ数える
- オプションなしの既定は従来と同じ (実データで 0.3.2 と HTML/SVG がバイト一致を確認)

## Rejected alternatives and why

- **流した分の集計を別ファイルに凍結する**: その別ファイルを失うと過去が戻らない (正本が派生物の側に移る)。
  キャッシュを派生物に保てば、削除・版上げ・初回のどれでも写しから再構成できる
- **キャッシュの prune をやめる (消えたファイルを全部残す)**: 改名で二重に数える。目録という「流した」証拠がある分だけ残す
- **キャッシュ消失時に毎回 NAS を読む / 流した直後に必ず NAS で照合する**: 初回 20GB 規模を 10 分便ごとに読むことになる。
  写しは中身が変わらないので、mtime が一致するキャッシュは信用し、印で 1 回きりにする
- **NAS が読めない時も終了コード 0**: 欠けた草が公開面 (プロフィール) に出る。出力は書くが失敗として返し、公開は呼ぶ側の `set -e` に止めさせる
- **欄名を一般名 (`archive_path` 等) に変える・別名を受ける**: 実在する目録の形に合わせ、README に約束を書けば足りる

## Consequences

- 目録ありの初回はキャッシュが空なので全走査 (実測 約 90 秒・母艦 106k ファイル)。以後の 10 分便は 6.7 万行の目録で 約 2.0 秒 (なし 1.5 秒)、
  キャッシュは 34MB → 44MB
- キャッシュ消失・`CACHE_VERSION` の版上げの後は、流した分を NAS から 1 回読み直す (初回の流し量 20GB 規模なら長い)。30 秒ごとに途中保存するので中断しても続きから
- chuqk の `update-grass.sh` は npm に新版が出てから `--archive-catalog` を足す。足す前に夜便が流しても、足した後の初回に NAS から戻る (NAS が読める限り)
