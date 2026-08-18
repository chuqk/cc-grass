import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { TokenBreakdown } from "./pricing.js";

// Per-file scan cache. Session jsonl files are append-only in practice and the
// vast majority never change again, so re-parsing only files whose mtime/size
// moved keeps runs proportional to today's activity instead of total history.

export interface CachedDay {
  prompts: number;
  tokens: number;
  models: Record<string, TokenBreakdown>;
}

export interface CachedFileEntry {
  mtimeMs: number;
  size: number;
  days: Record<string, CachedDay>;
}

export interface ScanCache {
  version: number;
  files: Record<string, CachedFileEntry>;
}

export const CACHE_VERSION = 1;

export function defaultCacheDir(): string {
  if (process.platform === "win32") {
    const base =
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(base, "cc-grass", "Cache");
  }
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "cc-grass");
}

export function cacheFileFor(cacheDir: string, projectsDir: string): string {
  const hash = createHash("sha1").update(projectsDir).digest("hex").slice(0, 12);
  return join(cacheDir, `scan-${hash}.json`);
}

export async function loadCache(path: string): Promise<ScanCache | null> {
  try {
    const raw = await readFile(path, "utf8");
    const data = JSON.parse(raw) as ScanCache;
    if (data?.version !== CACHE_VERSION) return null;
    if (typeof data.files !== "object" || data.files === null) return null;
    return data;
  } catch {
    return null;
  }
}

export async function saveCache(path: string, cache: ScanCache): Promise<void> {
  // Best-effort: a failed save must never fail the scan. Write-then-rename so
  // concurrent runs never observe a half-written file.
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(cache), "utf8");
    await rename(tmp, path);
  } catch {
    /* ignore */
  }
}
