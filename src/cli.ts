#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { parseClaudeProjects } from "./parse.js";
import { renderSvg, type Metric, type Theme } from "./svg.js";
import { renderHtml } from "./html.js";

const PKG = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
const VERSION = PKG.version;

const HELP = `cc-grass — GitHub-style contribution grass for Claude Code usage

Usage:
  cc-grass [options]

Options:
  --metric <prompts|sessions|tokens>   What to count (default: tokens)
  --output <path>, -o <path>           Write to file instead of stdout
  --since <YYYY-MM-DD>                 Start date (default: Sunday 52 weeks before --until)
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

function parseDateOrExit(s: string, endOfDay: boolean): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) {
    process.stderr.write(`Error: invalid date "${s}", expected YYYY-MM-DD\n`);
    process.exit(2);
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  const d = new Date(y, mo - 1, da);
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) {
    process.stderr.write(`Error: invalid date "${s}" (no such day on the calendar)\n`);
    process.exit(2);
  }
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

// Mirrors GitHub's contribution graph: the grid starts on the Sunday that
// belongs to the week 52 weeks before `until`, so the chart always shows
// exactly 53 columns regardless of which weekday `until` lands on.
export function defaultSinceFor(until: Date): Date {
  const d = new Date(until);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay() - 364);
  return d;
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
    : defaultSinceFor(until);

  if (since.getTime() > until.getTime()) {
    process.stderr.write(
      `Error: --since (${values.since ?? "auto"}) is after --until (${values.until ?? "today"})\n`,
    );
    process.exit(2);
  }

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

  const chartData = values.html
    ? [...result.buckets.values()]
        .filter((b) => b.modelTokens.size > 0)
        .map((b) => ({
          date: b.date,
          models: Object.fromEntries(b.modelTokens),
        }))
        .sort((a, b) => a.date.localeCompare(b.date))
    : undefined;

  const fmtDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const out = values.html
    ? renderHtml(svg, {
        theme: values.theme,
        title: "cc-grass",
        chartData,
        chartSince: fmtDate(since),
        chartUntil: fmtDate(until),
      })
    : svg;

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
