import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TokenBreakdown } from "./pricing.js";
import {
  CACHE_VERSION,
  cacheFileFor,
  defaultCacheDir,
  loadCache,
  saveCache,
  type CachedDay,
  type CachedFileEntry,
  type ScanCache,
} from "./cache.js";

export interface ParseOptions {
  claudeDir?: string;
  since?: Date;
  until?: Date;
  includeSubagents?: boolean;
  /** Reuse per-file day aggregates from previous runs (default: true). */
  cache?: boolean;
  /** Override the cache directory (default: ~/.cache/cc-grass). */
  cacheDir?: string;
}

export interface DailyBucket {
  date: string;
  prompts: number;
  tokens: number;
  sessionIds: Set<string>;
  modelTokens: Map<string, number>;
  modelBreakdown: Map<string, TokenBreakdown>;
}

export interface ParseTotals {
  prompts: number;
  tokens: number;
  sessions: number;
}

export interface CacheStats {
  unchanged: number;
  parsed: number;
}

export interface ParseResult {
  buckets: Map<string, DailyBucket>;
  total: ParseTotals;
  earliest: string | null;
  latest: string | null;
  fileCount: number;
  /** Present when the incremental cache was in effect for this run. */
  cacheStats?: CacheStats;
}

interface JsonlEntry {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
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
  return (
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0)
  );
}

function localDayStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toLocalDateStr(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return localDayStr(d);
}

// The cache stores per-day aggregates, so it can only serve windows that sit
// on local day boundaries. The CLI always produces such windows (--since is
// midnight, --until is 23:59:59.999); anything else falls back to the exact
// per-entry scan below.
function isLocalDayStart(d: Date | undefined): boolean {
  return (
    !d ||
    (d.getHours() === 0 &&
      d.getMinutes() === 0 &&
      d.getSeconds() === 0 &&
      d.getMilliseconds() === 0)
  );
}

function isLocalDayEnd(d: Date | undefined): boolean {
  return (
    !d ||
    (d.getHours() === 23 &&
      d.getMinutes() === 59 &&
      d.getSeconds() === 59 &&
      d.getMilliseconds() === 999)
  );
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

async function parseFileDays(
  file: string,
  sinceMs?: number,
  untilMs?: number,
): Promise<Record<string, CachedDay>> {
  const days: Record<string, CachedDay> = {};
  try {
    const rl = createInterface({
      input: createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
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

      let day = days[date];
      if (!day) {
        day = { prompts: 0, tokens: 0, models: {} };
        days[date] = day;
      }

      const tk = tokensOf(entry);
      if (tk > 0) {
        day.tokens += tk;
        const model = entry.message?.model;
        if (model) {
          const u = entry.message!.usage!;
          let bd = day.models[model];
          if (!bd) {
            bd = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
            day.models[model] = bd;
          }
          bd.input += u.input_tokens ?? 0;
          bd.output += u.output_tokens ?? 0;
          bd.cacheWrite += u.cache_creation_input_tokens ?? 0;
          bd.cacheRead += u.cache_read_input_tokens ?? 0;
        }
      }

      if (isHumanUserPrompt(entry)) day.prompts += 1;
    }
  } catch {
    // Unreadable file — keep whatever was aggregated before the failure.
  }
  return days;
}

export async function parseClaudeProjects(opts: ParseOptions = {}): Promise<ParseResult> {
  const claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
  const projectsDir = join(claudeDir, "projects");
  const includeSubagents = opts.includeSubagents ?? true;

  const files = await walkJsonl(projectsDir, includeSubagents);

  const aligned = isLocalDayStart(opts.since) && isLocalDayEnd(opts.until);
  const useCache = (opts.cache ?? true) && aligned;

  const sinceDay = opts.since ? localDayStr(opts.since) : undefined;
  const untilDay = opts.until ? localDayStr(opts.until) : undefined;

  let cachePath: string | null = null;
  let cached: ScanCache | null = null;
  if (useCache) {
    cachePath = cacheFileFor(opts.cacheDir ?? defaultCacheDir(), projectsDir);
    cached = await loadCache(cachePath);
  }

  const nextFiles: Record<string, CachedFileEntry> = {};
  const perFileDays: Array<[string, Record<string, CachedDay>]> = [];
  let unchanged = 0;
  let parsed = 0;

  for (const file of files) {
    let days: Record<string, CachedDay>;
    if (useCache) {
      // Stat before reading: if the file grows mid-parse we cache newer content
      // under an older mtime, which just forces a re-parse next run (fail-safe).
      const st = await stat(file).catch(() => null);
      const hit = st ? cached?.files[file] : undefined;
      if (hit && hit.mtimeMs === st!.mtimeMs && hit.size === st!.size) {
        days = hit.days;
        unchanged++;
      } else {
        days = await parseFileDays(file);
        parsed++;
      }
      if (st) nextFiles[file] = { mtimeMs: st.mtimeMs, size: st.size, days };
    } else {
      days = await parseFileDays(file, opts.since?.getTime(), opts.until?.getTime());
      parsed++;
    }
    perFileDays.push([file, days]);
  }

  const buckets = new Map<string, DailyBucket>();
  const allSessionIds = new Set<string>();
  let totalPrompts = 0;
  let totalTokens = 0;
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const [file, days] of perFileDays) {
    for (const [date, day] of Object.entries(days)) {
      if (sinceDay !== undefined && date < sinceDay) continue;
      if (untilDay !== undefined && date > untilDay) continue;

      let bucket = buckets.get(date);
      if (!bucket) {
        bucket = { date, prompts: 0, tokens: 0, sessionIds: new Set(), modelTokens: new Map(), modelBreakdown: new Map() };
        buckets.set(date, bucket);
      }

      bucket.tokens += day.tokens;
      totalTokens += day.tokens;
      bucket.prompts += day.prompts;
      totalPrompts += day.prompts;

      for (const [model, bd] of Object.entries(day.models)) {
        const tk = bd.input + bd.output + bd.cacheWrite + bd.cacheRead;
        bucket.modelTokens.set(model, (bucket.modelTokens.get(model) ?? 0) + tk);
        let acc = bucket.modelBreakdown.get(model);
        if (!acc) {
          acc = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
          bucket.modelBreakdown.set(model, acc);
        }
        acc.input += bd.input;
        acc.output += bd.output;
        acc.cacheWrite += bd.cacheWrite;
        acc.cacheRead += bd.cacheRead;
      }

      bucket.sessionIds.add(file);
      allSessionIds.add(file);

      if (earliest === null || date < earliest) earliest = date;
      if (latest === null || date > latest) latest = date;
    }
  }

  if (useCache && cachePath) {
    const pruned =
      cached !== null &&
      Object.keys(cached.files).some((k) => !(k in nextFiles));
    if (parsed > 0 || pruned) {
      await saveCache(cachePath, { version: CACHE_VERSION, files: nextFiles });
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
    ...(useCache ? { cacheStats: { unchanged, parsed } } : {}),
  };
}
