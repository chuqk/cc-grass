import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ParseOptions {
  claudeDir?: string;
  since?: Date;
  until?: Date;
  includeSubagents?: boolean;
}

export interface DailyBucket {
  date: string;
  prompts: number;
  tokens: number;
  sessionIds: Set<string>;
}

export interface ParseTotals {
  prompts: number;
  tokens: number;
  sessions: number;
}

export interface ParseResult {
  buckets: Map<string, DailyBucket>;
  total: ParseTotals;
  earliest: string | null;
  latest: string | null;
  fileCount: number;
}

interface JsonlEntry {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

const SKIP_DIR_NAMES = new Set(["tool-results", "memory", "node_modules"]);

function isHumanUserPrompt(entry: JsonlEntry): boolean {
  if (entry.type !== "user") return false;
  const content = entry.message?.content;
  if (typeof content === "string") return true;
  if (Array.isArray(content)) {
    return content.some(
      (c) => c && typeof c === "object" && (c as { type?: unknown }).type !== "tool_result",
    );
  }
  return false;
}

function tokensOf(entry: JsonlEntry): number {
  const u = entry.message?.usage;
  if (!u) return 0;
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
}

function toLocalDateStr(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function walkJsonl(dir: string, includeSubagents: boolean): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      if (e.name === "subagents" && !includeSubagents) continue;
      out.push(...(await walkJsonl(p, includeSubagents)));
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      out.push(p);
    }
  }
  return out;
}

export async function parseClaudeProjects(opts: ParseOptions = {}): Promise<ParseResult> {
  const claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
  const projectsDir = join(claudeDir, "projects");
  const includeSubagents = opts.includeSubagents ?? false;

  const sinceMs = opts.since?.getTime();
  const untilMs = opts.until?.getTime();

  const files = await walkJsonl(projectsDir, includeSubagents);

  const buckets = new Map<string, DailyBucket>();
  const allSessionIds = new Set<string>();
  let totalPrompts = 0;
  let totalTokens = 0;
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const sessionId = file;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let entry: JsonlEntry;
      try {
        entry = JSON.parse(line) as JsonlEntry;
      } catch {
        continue;
      }
      const ts = entry.timestamp;
      if (!ts) continue;
      const tsMs = new Date(ts).getTime();
      if (Number.isNaN(tsMs)) continue;
      if (sinceMs !== undefined && tsMs < sinceMs) continue;
      if (untilMs !== undefined && tsMs > untilMs) continue;
      const date = toLocalDateStr(ts);
      if (!date) continue;

      let bucket = buckets.get(date);
      if (!bucket) {
        bucket = { date, prompts: 0, tokens: 0, sessionIds: new Set() };
        buckets.set(date, bucket);
      }

      const tk = tokensOf(entry);
      if (tk > 0) {
        bucket.tokens += tk;
        totalTokens += tk;
      }

      if (isHumanUserPrompt(entry)) {
        bucket.prompts += 1;
        totalPrompts += 1;
      }

      bucket.sessionIds.add(sessionId);
      allSessionIds.add(sessionId);

      if (earliest === null || date < earliest) earliest = date;
      if (latest === null || date > latest) latest = date;
    }
  }

  return {
    buckets,
    total: {
      prompts: totalPrompts,
      tokens: totalTokens,
      sessions: allSessionIds.size,
    },
    earliest,
    latest,
    fileCount: files.length,
  };
}
