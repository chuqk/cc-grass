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
  /** Codex CLI data directory (default: ~/.codex). Its sessions/ and archived_sessions/ are scanned. */
  codexDir?: string;
  /** Also count OpenAI Codex CLI sessions when the directory exists (default: true). */
  includeCodex?: boolean;
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
      // TTL split of cache_creation_input_tokens (1h writes cost 2x input vs 1.25x for 5m).
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
    };
  };
}

// Codex CLI rollout format (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
}

interface CodexEntry {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    model?: string;
    info?: { total_token_usage?: CodexTokenUsage } | null;
  };
}

type SourceKind = "claude" | "codex";

interface SourceFile {
  path: string;
  kind: SourceKind;
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
            bd = { input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 };
            day.models[model] = bd;
          }
          bd.input += u.input_tokens ?? 0;
          bd.output += u.output_tokens ?? 0;
          bd.cacheWrite += u.cache_creation_input_tokens ?? 0;
          bd.cacheWrite1h += u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
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

// Codex emits a `token_count` event after every model response carrying the
// session-cumulative `total_token_usage`. The same event is sometimes written
// twice, so we attribute the *delta of the cumulative counters* rather than
// summing the per-response `last_token_usage` (which double counts).
// `cached_input_tokens` is a subset of `input_tokens`, so the billable total is
// input + cache_write + output.
async function parseCodexFileDays(
  file: string,
  sinceMs?: number,
  untilMs?: number,
): Promise<Record<string, CachedDay>> {
  const days: Record<string, CachedDay> = {};
  // Unknown until turn_context/session_meta names the model. A forked thread
  // starts with a token_count that carries the parent's cumulative usage
  // (already counted in the parent's file), so counters seen before the model
  // is known only set the baseline.
  let model: string | null = null;
  let prev: Required<CodexTokenUsage> = {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
  };
  try {
    const rl = createInterface({
      input: createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line) continue;
      let entry: CodexEntry;
      try {
        entry = JSON.parse(line) as CodexEntry;
      } catch {
        continue;
      }
      const payload = entry.payload;
      if (!payload) continue;

      if (entry.type === "session_meta" || entry.type === "turn_context") {
        if (typeof payload.model === "string" && payload.model) model = payload.model;
        continue;
      }
      if (entry.type !== "event_msg") continue;

      const ts = entry.timestamp;
      if (!ts) continue;
      const tsMs = new Date(ts).getTime();
      if (Number.isNaN(tsMs)) continue;

      if (payload.type === "token_count") {
        const tot = payload.info?.total_token_usage;
        if (!tot) continue;
        const cur: Required<CodexTokenUsage> = {
          input_tokens: tot.input_tokens ?? 0,
          cached_input_tokens: tot.cached_input_tokens ?? 0,
          cache_write_input_tokens: tot.cache_write_input_tokens ?? 0,
          output_tokens: tot.output_tokens ?? 0,
        };
        const dIn = cur.input_tokens - prev.input_tokens;
        const dCached = cur.cached_input_tokens - prev.cached_input_tokens;
        const dWrite = cur.cache_write_input_tokens - prev.cache_write_input_tokens;
        const dOut = cur.output_tokens - prev.output_tokens;
        prev = cur;
        if (model === null) continue;
        // Counters reset (new thread in the same file) or duplicate event: skip.
        if (dIn < 0 || dOut < 0 || dCached < 0 || dWrite < 0) continue;
        const tk = dIn + dWrite + dOut;
        if (tk <= 0) continue;
        if (sinceMs !== undefined && tsMs < sinceMs) continue;
        if (untilMs !== undefined && tsMs > untilMs) continue;
        const date = toLocalDateStr(ts);
        if (!date) continue;
        let day = days[date];
        if (!day) {
          day = { prompts: 0, tokens: 0, models: {} };
          days[date] = day;
        }
        day.tokens += tk;
        let bd = day.models[model];
        if (!bd) {
          bd = { input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 };
          day.models[model] = bd;
        }
        bd.input += Math.max(0, dIn - dCached);
        bd.cacheRead += Math.min(dCached, dIn);
        bd.cacheWrite += dWrite;
        bd.output += dOut;
      } else if (payload.type === "task_started") {
        if (sinceMs !== undefined && tsMs < sinceMs) continue;
        if (untilMs !== undefined && tsMs > untilMs) continue;
        const date = toLocalDateStr(ts);
        if (!date) continue;
        let day = days[date];
        if (!day) {
          day = { prompts: 0, tokens: 0, models: {} };
          days[date] = day;
        }
        day.prompts += 1;
      }
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

  const files: SourceFile[] = (await walkJsonl(projectsDir, includeSubagents)).map((path) => ({
    path,
    kind: "claude" as const,
  }));
  if (opts.includeCodex ?? true) {
    const codexDir = opts.codexDir ?? join(homedir(), ".codex");
    for (const sub of ["sessions", "archived_sessions"]) {
      for (const path of await walkJsonl(join(codexDir, sub), true)) {
        files.push({ path, kind: "codex" });
      }
    }
  }

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

  for (const { path: file, kind } of files) {
    const parseDays = kind === "codex" ? parseCodexFileDays : parseFileDays;
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
        days = await parseDays(file);
        parsed++;
      }
      if (st) nextFiles[file] = { mtimeMs: st.mtimeMs, size: st.size, days };
    } else {
      days = await parseDays(file, opts.since?.getTime(), opts.until?.getTime());
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
          acc = { input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 };
          bucket.modelBreakdown.set(model, acc);
        }
        acc.input += bd.input;
        acc.output += bd.output;
        acc.cacheWrite += bd.cacheWrite;
        acc.cacheWrite1h += bd.cacheWrite1h ?? 0;
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
