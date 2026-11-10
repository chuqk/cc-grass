import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { TokenBreakdown } from "./pricing.js";
import {
  consumeLines,
  lineSink,
  loadCatalogs,
  openArchiveFile,
  readTar,
  realpathOrNull,
  type CatalogEntry,
  type TarSink,
} from "./archive.js";
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
  /**
   * Catalog(s) of transcripts that were moved out of the scanned folders
   * (JSONL, one line per moved transcript; see README "Archived transcripts").
   * Moved transcripts keep counting, and are re-read from their archived copies
   * whenever the cache does not hold them. Default: none (moved files drop out).
   */
  archiveCatalog?: string | string[];
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

export interface ArchiveStats {
  /** Catalog lines that point into the scanned folders. */
  entries: number;
  /** Files counted from the archive because they are no longer on disk. */
  files: number;
  /** Archived transcripts read back from their archived copies in this run. */
  restored: number;
  /** Archived transcripts whose copies could not be read; their days may be missing or stale. */
  unreadable: number;
  /** Up to 5 archived copies that failed to read, for error messages. */
  unreadablePaths: string[];
  /** Catalog files that do not exist (yet). */
  missingCatalogs: string[];
}

export interface ParseResult {
  buckets: Map<string, DailyBucket>;
  total: ParseTotals;
  earliest: string | null;
  latest: string | null;
  fileCount: number;
  /** Present when the incremental cache was in effect for this run. */
  cacheStats?: CacheStats;
  /** Present when an archive catalog was given. */
  archive?: ArchiveStats;
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

type LineHandler = (line: string) => void;

function newDay(days: Record<string, CachedDay>, date: string): CachedDay {
  let day = days[date];
  if (!day) {
    day = { prompts: 0, tokens: 0, models: {} };
    days[date] = day;
  }
  return day;
}

function claudeLineHandler(
  days: Record<string, CachedDay>,
  sinceMs?: number,
  untilMs?: number,
): LineHandler {
  return (line) => {
    if (!line) return;
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line) as JsonlEntry;
    } catch {
      return;
    }
    const ts = entry.timestamp;
    if (!ts) return;
    const tsMs = new Date(ts).getTime();
    if (Number.isNaN(tsMs)) return;
    if (sinceMs !== undefined && tsMs < sinceMs) return;
    if (untilMs !== undefined && tsMs > untilMs) return;
    const date = toLocalDateStr(ts);
    if (!date) return;

    const day = newDay(days, date);

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
  };
}

// Codex emits a `token_count` event after every model response carrying the
// session-cumulative `total_token_usage`. The same event is sometimes written
// twice, so we attribute the *delta of the cumulative counters* rather than
// summing the per-response `last_token_usage` (which double counts).
// `cached_input_tokens` is a subset of `input_tokens`, so the billable total is
// input + cache_write + output.
function codexLineHandler(
  days: Record<string, CachedDay>,
  sinceMs?: number,
  untilMs?: number,
): LineHandler {
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
  return (line) => {
    if (!line) return;
    let entry: CodexEntry;
    try {
      entry = JSON.parse(line) as CodexEntry;
    } catch {
      return;
    }
    const payload = entry.payload;
    if (!payload) return;

    if (entry.type === "session_meta" || entry.type === "turn_context") {
      if (typeof payload.model === "string" && payload.model) model = payload.model;
      return;
    }
    if (entry.type !== "event_msg") return;

    const ts = entry.timestamp;
    if (!ts) return;
    const tsMs = new Date(ts).getTime();
    if (Number.isNaN(tsMs)) return;

    if (payload.type === "token_count") {
      const tot = payload.info?.total_token_usage;
      if (!tot) return;
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
      if (model === null) return;
      // Counters reset (new thread in the same file) or duplicate event: skip.
      if (dIn < 0 || dOut < 0 || dCached < 0 || dWrite < 0) return;
      const tk = dIn + dWrite + dOut;
      if (tk <= 0) return;
      if (sinceMs !== undefined && tsMs < sinceMs) return;
      if (untilMs !== undefined && tsMs > untilMs) return;
      const date = toLocalDateStr(ts);
      if (!date) return;
      const day = newDay(days, date);
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
      if (sinceMs !== undefined && tsMs < sinceMs) return;
      if (untilMs !== undefined && tsMs > untilMs) return;
      const date = toLocalDateStr(ts);
      if (!date) return;
      newDay(days, date).prompts += 1;
    }
  };
}

const HANDLERS: Record<SourceKind, typeof claudeLineHandler> = {
  claude: claudeLineHandler,
  codex: codexLineHandler,
};

async function parseLiveFile(
  kind: SourceKind,
  file: string,
  sinceMs?: number,
  untilMs?: number,
): Promise<Record<string, CachedDay>> {
  const days: Record<string, CachedDay> = {};
  const onLine = HANDLERS[kind](days, sinceMs, untilMs);
  try {
    const rl = createInterface({
      input: createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) onLine(line);
  } catch {
    // Unreadable file — keep whatever was aggregated before the failure.
  }
  return days;
}

// The live scan stops at the first line that throws (e.g. a bare `null`) and
// keeps what came before; archived copies must be read the same way.
function stopOnThrow(onLine: LineHandler): LineHandler {
  let dead = false;
  return (line) => {
    if (dead) return;
    try {
      onLine(line);
    } catch {
      dead = true;
    }
  };
}

// ---- archived transcripts -------------------------------------------------

interface ArchivedFile {
  days: Record<string, CachedDay>;
  size: number;
  mtimeMs: number;
}

type Need = "none" | "unit" | "companion";

interface RestoreTask {
  unit: CatalogEntry;
  kind: SourceKind;
  need: Exclude<Need, "none">;
  /** `<dir>/<name-without-.jsonl>` — where a Claude transcript keeps subagents etc. */
  companionDir: string | null;
  results: Map<string, ArchivedFile>;
  failure: string | null;
}

function companionDirOf(source: string): string {
  return join(dirname(source), basename(source, ".jsonl"));
}

function hasSkippedDir(rel: string): boolean {
  return rel.split(/[\\/]/).slice(0, -1).some((d) => SKIP_DIR_NAMES.has(d));
}

async function isDir(p: string): Promise<boolean> {
  const st = await stat(p).catch(() => null);
  return st !== null && st.isDirectory();
}

function fileSink(
  task: RestoreTask,
  key: string,
  meta: { mtimeMs: number },
  window: [number | undefined, number | undefined],
): TarSink {
  const days: Record<string, CachedDay> = {};
  const inner = lineSink(stopOnThrow(HANDLERS[task.kind](days, ...window)));
  let size = 0;
  return {
    write: (chunk) => {
      size += chunk.length;
      return inner.write(chunk);
    },
    end: async () => {
      await inner.end();
      task.results.set(key, { days, size, mtimeMs: meta.mtimeMs });
    },
  };
}

/**
 * Read archived copies back. Bundles (tar with many transcripts) are read once
 * for every task that needs something from them. A task fails as a whole if
 * any of its parts cannot be read, so a half-restored transcript is never
 * stored as if it were complete.
 */
async function runRestores(
  tasks: RestoreTask[],
  live: Set<string>,
  window: [number | undefined, number | undefined],
  onTaskDone: (task: RestoreTask) => Promise<void>,
): Promise<void> {
  // Group every read by the archive file it touches.
  type Want = { task: RestoreTask; main?: string; prefix?: string };
  const tarReads = new Map<string, Want[]>();
  const plainReads: RestoreTask[] = [];
  const pending = new Map<RestoreTask, number>();
  const addTar = (path: string, want: Want) => {
    let list = tarReads.get(path);
    if (!list) tarReads.set(path, (list = []));
    list.push(want);
    pending.set(want.task, (pending.get(want.task) ?? 0) + 1);
  };
  for (const task of tasks) {
    const { unit } = task;
    if (task.need === "unit") {
      if (unit.member !== undefined) addTar(unit.archivePath, { task, main: unit.member });
      else {
        plainReads.push(task);
        pending.set(task, (pending.get(task) ?? 0) + 1);
      }
    }
    if (task.companionDir) {
      if (unit.dirArchive !== undefined) addTar(unit.dirArchive, { task, prefix: "" });
      else if (unit.member !== undefined)
        addTar(unit.archivePath, { task, prefix: `${unit.member.replace(/\.jsonl$/, "")}/` });
    }
  }

  const finish = async (task: RestoreTask) => {
    const left = (pending.get(task) ?? 1) - 1;
    pending.set(task, left);
    if (left === 0) await onTaskDone(task);
  };

  for (const task of plainReads) {
    try {
      const input = openArchiveFile(task.unit.archivePath);
      const days: Record<string, CachedDay> = {};
      let size = 0;
      input.on("data", (c: Buffer) => (size += c.length));
      await consumeLines(input, stopOnThrow(HANDLERS[task.kind](days, ...window)));
      task.results.set(task.unit.source, { days, size, mtimeMs: task.unit.mtimeMs ?? 0 });
    } catch (err) {
      task.failure ??= `${task.unit.archivePath}: ${(err as Error).message}`;
    }
    await finish(task);
  }

  for (const [path, wants] of tarReads) {
    const mains = new Map<string, Want>();
    const prefixes = new Map<string, Want[]>();
    for (const w of wants) {
      if (w.main !== undefined) mains.set(w.main.replace(/^(\.\/)+/, ""), w);
      else {
        const list = prefixes.get(w.prefix!) ?? [];
        list.push(w);
        prefixes.set(w.prefix!, list);
      }
    }
    const foundMain = new Set<Want>();
    try {
      await readTar(openArchiveFile(path), (file) => {
        const main = mains.get(file.name);
        if (main) {
          foundMain.add(main);
          return fileSink(main.task, main.task.unit.source, file, window);
        }
        if (!file.name.endsWith(".jsonl")) return null;
        // Companion files: "<prefix><rel>" where prefix is "" (folder archive)
        // or "<member-without-.jsonl>/" (bundle).
        const candidates: string[] = [""];
        for (let i = file.name.indexOf("/"); i !== -1; i = file.name.indexOf("/", i + 1)) {
          candidates.push(file.name.slice(0, i + 1));
        }
        for (const prefix of candidates) {
          const list = prefixes.get(prefix);
          if (!list) continue;
          const rel = file.name.slice(prefix.length);
          if (!rel || hasSkippedDir(rel)) continue;
          // One member can serve a single task; bundles never repeat a transcript.
          const want = list.find((w) => {
            const key = join(w.task.companionDir!, rel);
            return !live.has(key) && !w.task.results.has(key);
          });
          if (want) return fileSink(want.task, join(want.task.companionDir!, rel), file, window);
        }
        return null;
      });
      for (const w of mains.values()) {
        if (!foundMain.has(w)) w.task.failure ??= `${path}: member ${w.main} not found`;
      }
    } catch (err) {
      for (const w of wants) w.task.failure ??= `${path}: ${(err as Error).message}`;
    }
    for (const w of wants) await finish(w.task);
  }
}

export async function parseClaudeProjects(opts: ParseOptions = {}): Promise<ParseResult> {
  const claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
  const projectsDir = join(claudeDir, "projects");
  const includeSubagents = opts.includeSubagents ?? true;
  const catalogPaths =
    opts.archiveCatalog === undefined ? [] : ([] as string[]).concat(opts.archiveCatalog);
  const archiveMode = catalogPaths.length > 0;

  // With a catalog, scan real paths (catalogs record where files really lived)
  // and always walk subagents, so every file of a transcript is in the cache
  // before it is moved; --no-include-subagents is applied when counting.
  const claudeRoot = archiveMode
    ? ((await realpathOrNull(projectsDir)) ?? resolve(projectsDir))
    : projectsDir;
  const codexRoots: string[] = [];
  if (opts.includeCodex ?? true) {
    const codexDir = opts.codexDir ?? join(homedir(), ".codex");
    for (const sub of ["sessions", "archived_sessions"]) {
      const root = join(codexDir, sub);
      codexRoots.push(archiveMode ? ((await realpathOrNull(root)) ?? resolve(root)) : root);
    }
  }

  const files: SourceFile[] = (
    await walkJsonl(claudeRoot, archiveMode || includeSubagents)
  ).map((path) => ({ path, kind: "claude" as const }));
  for (const root of codexRoots) {
    for (const path of await walkJsonl(root, true)) {
      files.push({ path, kind: "codex" });
    }
  }

  const counted = (file: string, kind: SourceKind): boolean =>
    !archiveMode ||
    includeSubagents ||
    kind !== "claude" ||
    !relative(claudeRoot, file).split(sep).slice(0, -1).includes("subagents");

  const aligned = isLocalDayStart(opts.since) && isLocalDayEnd(opts.until);
  const useCache = (opts.cache ?? true) && aligned;

  const sinceDay = opts.since ? localDayStr(opts.since) : undefined;
  const untilDay = opts.until ? localDayStr(opts.until) : undefined;

  let cachePath: string | null = null;
  let cached: ScanCache | null = null;
  if (useCache) {
    // Archive mode keeps its own cache file: a run without the catalog would
    // otherwise prune the archived entries and force re-reading the archive.
    const cacheKey = archiveMode
      ? [projectsDir, ...catalogPaths.map((c) => resolve(c))].join("\0")
      : projectsDir;
    cachePath = cacheFileFor(opts.cacheDir ?? defaultCacheDir(), cacheKey);
    cached = await loadCache(cachePath);
  }

  const nextFiles: Record<string, CachedFileEntry> = {};
  const perFileDays: Array<[string, Record<string, CachedDay>, SourceKind]> = [];
  let unchanged = 0;
  let parsed = 0;

  for (const { path: file, kind } of files) {
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
        days = await parseLiveFile(kind, file);
        parsed++;
      }
      if (st) nextFiles[file] = { mtimeMs: st.mtimeMs, size: st.size, days };
    } else {
      days = await parseLiveFile(kind, file, opts.since?.getTime(), opts.until?.getTime());
      parsed++;
    }
    perFileDays.push([file, days, kind]);
  }

  let archive: ArchiveStats | undefined;
  const nextArchives: Record<string, string> = {};
  if (archiveMode) {
    const { entries: catalog, missing } = await loadCatalogs(catalogPaths);
    const live = new Set(files.map((f) => f.path));
    const under = (root: string, p: string) => p.startsWith(root.endsWith(sep) ? root : root + sep);
    const kindOf = (source: string): SourceKind | null => {
      if (!source.endsWith(".jsonl")) return null;
      if (under(claudeRoot, source)) {
        return hasSkippedDir(relative(claudeRoot, source)) ? null : "claude";
      }
      return codexRoots.some((r) => under(r, source)) ? "codex" : null;
    };
    // The catalog unit a vanished file belongs to: the transcript itself, or
    // the Claude transcript whose companion folder holds it.
    const unitOf = (key: string): string | null => {
      if (catalog.has(key)) return key;
      if (!under(claudeRoot, key)) return null;
      for (let d = dirname(key); under(claudeRoot, d); d = dirname(d)) {
        if (catalog.has(`${d}.jsonl`)) return `${d}.jsonl`;
      }
      return null;
    };
    const covered = new Map<string, string[]>();
    if (cached) {
      for (const key of Object.keys(cached.files)) {
        if (live.has(key)) continue;
        const unit = unitOf(key);
        if (unit === null) continue;
        let list = covered.get(unit);
        if (!list) covered.set(unit, (list = []));
        list.push(key);
      }
    }

    // archived[key] = days of files no longer on disk that still count.
    const archived = new Map<string, { days: Record<string, CachedDay>; kind: SourceKind }>();
    const unitKeys = new Map<string, string[]>();
    const tasks: RestoreTask[] = [];
    let entries = 0;
    for (const unit of catalog.values()) {
      const kind = kindOf(unit.source);
      if (kind === null) continue;
      entries++;
      const mainLive = live.has(unit.source);
      const companionDir = kind === "claude" ? companionDirOf(unit.source) : null;
      const hasCompanionArchive =
        companionDir !== null && (unit.dirArchive !== undefined || unit.member !== undefined);
      const keys = covered.get(unit.source) ?? [];
      // Keep what the cache knows (possibly stale) until a restore replaces it.
      for (const key of keys) {
        const hit = cached!.files[key]!;
        archived.set(key, { days: hit.days, kind });
        nextFiles[key] = hit;
      }
      unitKeys.set(unit.source, keys);

      let need: Need;
      if (
        useCache &&
        cached?.archives?.[unit.source] === unit.id &&
        (mainLive || cached.files[unit.source] !== undefined)
      ) {
        need = "none";
      } else if (!mainLive) {
        const hit = useCache ? cached?.files[unit.source] : undefined;
        const fresh =
          hit !== undefined &&
          (unit.mtimeMs === undefined || Math.abs(hit.mtimeMs - unit.mtimeMs) <= 1000);
        need = fresh ? "none" : "unit";
      } else if (
        hasCompanionArchive &&
        (!useCache || keys.length === 0) &&
        !(await isDir(companionDir!))
      ) {
        need = "companion";
      } else {
        need = "none";
      }
      if (need === "none") {
        nextArchives[unit.source] = unit.id;
      } else {
        tasks.push({
          unit,
          kind,
          need,
          companionDir: hasCompanionArchive ? companionDir : null,
          results: new Map(),
          failure: null,
        });
      }
    }

    let restored = 0;
    const failed: RestoreTask[] = [];
    let lastSave = Date.now();
    const snapshot = () => ({
      version: CACHE_VERSION,
      files: nextFiles,
      archives: nextArchives,
    });
    await runRestores(
      tasks,
      live,
      useCache ? [undefined, undefined] : [opts.since?.getTime(), opts.until?.getTime()],
      async (task) => {
        if (task.failure !== null) {
          failed.push(task);
          return;
        }
        restored++;
        for (const key of unitKeys.get(task.unit.source) ?? []) {
          archived.delete(key);
          delete nextFiles[key];
        }
        for (const [key, file] of task.results) {
          if (live.has(key)) continue;
          archived.set(key, { days: file.days, kind: task.kind });
          if (useCache) nextFiles[key] = { mtimeMs: file.mtimeMs, size: file.size, days: file.days };
        }
        nextArchives[task.unit.source] = task.unit.id;
        // Long restores (a lost cache over a large archive) save progress so an
        // interrupted run does not start over.
        if (useCache && cachePath && Date.now() - lastSave > 30_000) {
          await saveCache(cachePath, snapshot());
          lastSave = Date.now();
        }
      },
    );

    for (const [key, { days, kind }] of archived) perFileDays.push([key, days, kind]);
    archive = {
      entries,
      files: archived.size,
      restored,
      unreadable: failed.length,
      unreadablePaths: failed.slice(0, 5).map((t) => t.failure!),
      missingCatalogs: missing,
    };
  }

  const buckets = new Map<string, DailyBucket>();
  const allSessionIds = new Set<string>();
  let totalPrompts = 0;
  let totalTokens = 0;
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const [file, days, kind] of perFileDays) {
    if (!counted(file, kind)) continue;
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
    const archivesChanged =
      archiveMode &&
      JSON.stringify(Object.entries(nextArchives).sort()) !==
        JSON.stringify(Object.entries(cached?.archives ?? {}).sort());
    if (parsed > 0 || pruned || archivesChanged || (archive?.restored ?? 0) > 0) {
      await saveCache(cachePath, {
        version: CACHE_VERSION,
        files: nextFiles,
        ...(archiveMode ? { archives: nextArchives } : {}),
      });
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
    fileCount: archiveMode ? files.filter((f) => counted(f.path, f.kind)).length : files.length,
    ...(useCache ? { cacheStats: { unchanged, parsed } } : {}),
    ...(archive ? { archive } : {}),
  };
}
