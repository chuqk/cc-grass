# cc-grass

> 把 Claude Code 的用量画成 **橙色版 GitHub 贡献草**。直接读取 `~/.claude/projects/**/*.jsonl`，输出可贴到 profile README 的 SVG。

[English](https://github.com/chuqk/cc-grass/blob/main/README.md) · [日本語](https://github.com/chuqk/cc-grass/blob/main/README.ja.md) · [한국어](https://github.com/chuqk/cc-grass/blob/main/README.ko.md)

<p align="center">
  <img src="https://raw.githubusercontent.com/chuqk/cc-grass/main/examples/sample.svg" alt="cc-grass example" width="760">
</p>

<p align="center">
  <a href="https://chuqk.github.io/cc-grass/">▶ 交互版本（hover 查看每日 token 数）</a>
</p>

> **隐私提醒**：上面的示例 SVG 和交互页面展示的是作者本人 `~/.claude` 的真实活动数据。在你自己机器上运行 cc-grass 会输出 **你的** 活动数据（每日 token 用量、活跃时段、休息的日子都会暴露），请有意识地选择发布位置。

## 这是什么

Claude Code 的 `/usage > Stats` 里其实已经有一张贡献图了，但它只活在终端里。**cc-grass** 用同一份数据画一张和 GitHub 贡献图像素级一致的 SVG，颜色换成橙色，让你贴到 GitHub profile README、个人主页、随便哪儿。

- **零依赖。** 只用 `fs` / `path` / `os`。不依赖 `ccusage`，不调任何 API。
- **跨平台。** macOS / Linux / Windows，Node ≥ 18。
- **只输出 SVG。** 不内置 daemon、cron 或 GitHub Action 模板。怎么调度由你定。
- **像素级复刻 GitHub。** 10×10 方格、3px 间距、圆角、Mon/Wed/Fri 行标签、月份表头、*Less / More* 图例都在。
- **数字对得上 `/usage`。** Token 计算逻辑和 `/usage > Stats` 完全一致（`input + output`，不含 cache，不含 subagent）。

## 快速开始

```bash
# 写到文件
npx cc-grass --output grass.svg

# 直接管道到 stdout
npx cc-grass > grass.svg

# 输出 HTML（在真实浏览器里 hover 能看每天的数字）
npx cc-grass --html --output grass.html
```

然后贴进 README:

```md
![Claude Code grass](./grass.svg)
```

## 选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `--metric <prompts\|sessions\|tokens>` | `tokens` | 每天统计什么 |
| `--output <path>`, `-o` | stdout | 输出到文件 |
| `--since <YYYY-MM-DD>` | `--until` 所在周的 52 周前周日 | 起始日期（本地时区，对齐 GitHub 草图） |
| `--until <YYYY-MM-DD>` | 今天 | 结束日期（含当天） |
| `--theme <dark\|light>` | `dark` | 主题 |
| `--header <string>` | 自动 | 覆盖标题文字 |
| `--claude-dir <path>` | `~/.claude` | 指定 Claude Code 数据目录 |
| `--include-subagents` | off | 同时统计 subagent jsonl（会让数字变大） |
| `--html` | off | 包成最小 HTML 页面，hover tooltip 可用 |
| `--version`, `-v` | — | 版本号 |
| `--help`, `-h` | — | 帮助 |

## 示例

```bash
# 最近 30 天
npx cc-grass --since 2026-04-06 --until 2026-05-06 -o month.svg

# 数 prompt 数量而不是 token
npx cc-grass --metric prompts -o prompts.svg

# 浅色主题
npx cc-grass --theme light -o grass-light.svg

# 包含 subagent
npx cc-grass --include-subagents -o grass-with-subs.svg
```

## Hover tooltip 与 GitHub README 的限制

每个方格都带 `<title>1,234 tokens on May 6th.</title>`，**直接在浏览器里打开 SVG** 或者用 `--html` 输出，hover 都能正常显示。但**贴在 GitHub README 里就不行**——GitHub 会把 SVG 当 `<img>` 渲染，浏览器不会读取 `<img>` 加载的 SVG 内部的 `<title>`。这不是 bug，是 web 平台的硬性限制。`<title>` 对屏幕阅读器和直接打开 SVG 的场景仍然有效。

如果一定要 hover，可以把 `--html` 输出托管到 GitHub Pages，README 里放个链接。

## 定时更新

cc-grass 故意不内置调度器，自己挑顺手的方式：

```bash
# crontab: 每小时跑一次，有变化就 commit + push
0 * * * * cd ~/profile-repo && npx -y cc-grass -o grass.svg && git add grass.svg && (git diff --cached --quiet || (git commit -m "update grass" && git push))
```

`(... || (... && ...))` 的括号是有意为之。如果写成扁平的 `A && B && C || D`，bash 会按 `((A && B) && C) || D` 解析，导致 `A`/`B`/`C` 任一失败时 `D` 的 commit + push 仍会执行。用子 shell 分组才能确保 commit + push 只在确实有变化时被触发。

或者 GitHub Actions 的 `workflow_dispatch`，或者每次往 profile repo 提交别的东西时顺手跑一下，都行。

## Token 计算

每天的 `tokens` = 当天（本地时区）所有条目的 `message.usage.input_tokens` + `message.usage.output_tokens` 之和。这跟 Claude Code `/usage > Stats > Overview` 显示的 `Total tokens` 是同一个公式。默认不算 `cache_read_input_tokens` 和 `cache_creation_input_tokens`。除非你显式加了 `--include-subagents`，否则数字会跟 `/usage` 对得上。

`--metric prompts` 只数 `type:"user"` 且 `content` 是真实人类 prompt（不是 tool_result）的条目；`--metric sessions` 数当天活跃过的 jsonl 文件数。

## 编程接口

```ts
import { parseClaudeProjects, renderSvg } from "cc-grass";

// 与 CLI 默认值一致：until 所在周的 52 周前周日
const until = new Date();
const since = new Date(until);
since.setHours(0, 0, 0, 0);
since.setDate(since.getDate() - since.getDay() - 364);

const data = await parseClaudeProjects({ includeSubagents: false });
const svg = renderSvg({
  buckets: data.buckets,
  metric: "tokens",
  since,
  until,
  total: data.total,
});
console.log(svg);
```

## License

[MIT](https://github.com/chuqk/cc-grass/blob/main/LICENSE) © chuqk
