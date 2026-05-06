#!/usr/bin/env node
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { parseClaudeProjects } from "./parse.js";
import { renderSvg, type Metric, type Theme } from "./svg.js";
import { renderHtml } from "./html.js";

const HELP = `cc-grass — GitHub-style contribution grass for Claude Code usage

Usage:
  cc-grass [options]

Options:
  --metric <prompts|sessions|tokens>   What to count (default: tokens)
  --output <path>, -o <path>           Write to file instead of stdout
  --since <YYYY-MM-DD>                 Start date (default: 364 days ago)
  --until <YYYY-MM-DD>                 End date inclusive (default: today)
  --theme <dark|light>                 Color theme (default: dark)
  --header <string>                    Override header text
  --claude-dir <path>                  Override ~/.claude location
  --include-subagents                  Also count subagent jsonl files (default: off, matches /usage)
  --html                               Output HTML page (with hover tooltips)
  --version, -v                        Print version and exit
  --help, -h                           Show this help

Examples:
  cc-grass > grass.svg
  cc-grass --metric prompts -o prompts.svg
  cc-grass --html --output grass.html
  cc-grass --since 2026-01-01 --until 2026-12-31
`;

const VERSION = "0.1.0";

function parseDateOrExit(s: string, endOfDay: boolean): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) {
    process.stderr.write(`Error: invalid date "${s}", expected YYYY-MM-DD\n`);
    process.exit(2);
  }
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (endOfDay) d.setHours(23, 59, 59, 999);
  else d.setHours(0, 0, 0, 0);
  return d;
}

function isMetric(s: string | undefined): s is Metric {
  return s === "tokens" || s === "prompts" || s === "sessions";
}

function isTheme(s: string | undefined): s is Theme {
  return s === "dark" || s === "light";
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        metric: { type: "string", default: "tokens" },
        output: { type: "string", short: "o" },
        since: { type: "string" },
        until: { type: "string" },
        theme: { type: "string", default: "dark" },
        header: { type: "string" },
        "claude-dir": { type: "string" },
        "include-subagents": { type: "boolean", default: false },
        html: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    process.exit(2);
  }

  const { values } = parsed;

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`cc-grass ${VERSION}\n`);
    return;
  }

  if (!isMetric(values.metric)) {
    process.stderr.write(`Error: --metric must be one of tokens|prompts|sessions\n`);
    process.exit(2);
  }
  if (!isTheme(values.theme)) {
    process.stderr.write(`Error: --theme must be one of dark|light\n`);
    process.exit(2);
  }

  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const until = values.until ? parseDateOrExit(values.until, true) : today;
  const since = values.since
    ? parseDateOrExit(values.since, false)
    : (() => {
        const d = new Date(until);
        d.setDate(d.getDate() - 364);
        d.setHours(0, 0, 0, 0);
        return d;
      })();

  const result = await parseClaudeProjects({
    claudeDir: values["claude-dir"],
    since,
    until,
    includeSubagents: values["include-subagents"],
  });

  const svg = renderSvg({
    buckets: result.buckets,
    metric: values.metric,
    since,
    until,
    theme: values.theme,
    header: values.header,
    total: result.total,
  });

  const out = values.html ? renderHtml(svg, { theme: values.theme, title: "cc-grass" }) : svg;

  if (values.output) {
    writeFileSync(values.output, out, "utf8");
    process.stderr.write(
      `wrote ${values.output} (${result.fileCount} files, ${result.total.tokens.toLocaleString()} tokens)\n`,
    );
  } else {
    process.stdout.write(out);
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${(err as Error).message}\n`);
  process.exit(1);
});
