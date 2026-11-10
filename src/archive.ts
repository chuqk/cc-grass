import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { PassThrough, pipeline, type Readable } from "node:stream";
import { createGunzip } from "node:zlib";

// Archived transcripts: people who move old session logs out of ~/.claude or
// ~/.codex (to a NAS, cold storage, ...) can hand cc-grass a catalog of what
// they moved, so those days stay on the grass. The catalog is JSONL, one line
// per moved transcript; see README "Archived transcripts" for the contract.

export interface CatalogEntry {
  /** Where the transcript lived before it was moved (symlinks resolved). */
  source: string;
  /** The archived copy: plain/.gz jsonl, or a tar/.tar.gz bundle when `member` is set. */
  archivePath: string;
  /** Name of the transcript inside the bundle at `archivePath`. */
  member?: string;
  /** tar/.tar.gz of the transcript's companion folder (`<name>/`, e.g. subagents/). */
  dirArchive?: string;
  /** Last-modified time of the transcript when it was moved. */
  mtimeMs?: number;
  /** Identity of this archived copy; a change means "re-check the archive". */
  id: string;
}

export interface LoadedCatalog {
  /** Keyed by normalized source path. Later lines (and later catalogs) win. */
  entries: Map<string, CatalogEntry>;
  /** Catalog files that do not exist (yet). */
  missing: string[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

// Resolve symlinks in the part of `p` that still exists, so a catalog written
// with ~/.claude-x/projects (a symlink) matches the real ~/.claude/projects.
async function normalizePath(p: string, memo: Map<string, string>): Promise<string> {
  const abs = resolve(p);
  const dir = dirname(abs);
  let real = memo.get(dir);
  if (real === undefined) {
    real = await realpathOrNull(dir) ?? (dir === dirname(dir) ? dir : await normalizePath(dir, memo));
    memo.set(dir, real);
  }
  return join(real, basename(abs));
}

export async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

export async function loadCatalogs(paths: string[]): Promise<LoadedCatalog> {
  const entries = new Map<string, CatalogEntry>();
  const missing: string[] = [];
  const memo = new Map<string, string>();
  for (const catalogPath of paths) {
    let raw: string;
    try {
      raw = await readFile(catalogPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        missing.push(catalogPath);
        continue;
      }
      throw new Error(`cannot read archive catalog ${catalogPath}: ${(err as Error).message}`);
    }
    const base = dirname(resolve(catalogPath));
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!row || typeof row !== "object") continue;
      const sourcePath = str(row.source_path);
      const archivePath = str(row.nas_path);
      if (!sourcePath || !archivePath || !isAbsolute(sourcePath)) continue;
      const member = str(row.member);
      const dirArchive = str(row.nas_dir_archive);
      const mtimeRaw = str(row.mtime);
      const mtimeMs = mtimeRaw !== undefined ? Date.parse(mtimeRaw) : NaN;
      const source = await normalizePath(sourcePath, memo);
      // Relative archive paths are taken relative to the catalog file.
      const archiveAbs = resolve(base, archivePath);
      const dirArchiveAbs = dirArchive !== undefined ? resolve(base, dirArchive) : undefined;
      entries.set(source, {
        source,
        archivePath: archiveAbs,
        ...(member !== undefined ? { member } : {}),
        ...(dirArchiveAbs !== undefined ? { dirArchive: dirArchiveAbs } : {}),
        ...(Number.isNaN(mtimeMs) ? {} : { mtimeMs }),
        id: createHash("sha1")
          .update(JSON.stringify([archiveAbs, member ?? null, dirArchiveAbs ?? null, mtimeRaw ?? null]))
          .digest("hex")
          .slice(0, 16),
      });
    }
  }
  return { entries, missing };
}

const GZIP_EXT = /\.(gz|tgz)$/i;

/** Open an archived file, gunzipping by extension (.gz / .tgz). Errors surface on the returned stream. */
export function openArchiveFile(path: string): Readable {
  const src = createReadStream(path);
  if (!GZIP_EXT.test(path)) return src;
  const gunzip = createGunzip();
  pipeline(src, gunzip, () => {
    /* errors are re-emitted on gunzip, which the consumer watches */
  });
  return gunzip;
}

/**
 * Feed every line of `input` to `onLine` (same line splitting as the live scan)
 * and reject if the stream fails — an archived copy that cannot be read fully
 * must not be mistaken for a short transcript.
 */
export async function consumeLines(input: Readable, onLine: (line: string) => void): Promise<void> {
  let failure: unknown = null;
  const rl = createInterface({ input, crlfDelay: Infinity });
  input.on("error", (err) => {
    failure ??= err;
    rl.close();
  });
  for await (const line of rl) onLine(line);
  if (failure) throw failure;
}

export interface TarFile {
  /** Member path with any leading "./" removed. */
  name: string;
  size: number;
  mtimeMs: number;
}

export interface TarSink {
  write(chunk: Buffer): Promise<void>;
  end(): Promise<void>;
}

/** A sink that streams one tar member's bytes through `consumeLines`. */
export function lineSink(onLine: (line: string) => void): TarSink {
  const pass = new PassThrough();
  const done = consumeLines(pass, onLine);
  return {
    write: (chunk) =>
      new Promise<void>((res) => {
        if (pass.write(chunk)) res();
        else pass.once("drain", res);
      }),
    end: async () => {
      pass.end();
      await done;
    },
  };
}

function cstr(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString("utf8");
}

function num(buf: Buffer, start: number, len: number): number {
  if (buf[start]! & 0x80) {
    // GNU base-256 for values that do not fit in octal.
    let v = buf[start]! & 0x7f;
    for (let i = start + 1; i < start + len; i++) v = v * 256 + buf[i]!;
    return v;
  }
  const s = cstr(buf, start, len).trim();
  return s ? parseInt(s, 8) : 0;
}

function parsePax(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp === -1) break;
    const len = parseInt(buf.subarray(i, sp).toString("ascii"), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = buf.subarray(sp + 1, i + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq !== -1) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

const BLOCK = 512;
const MAX_META = 1 << 20;

/**
 * Minimal streaming tar reader (ustar + pax + GNU long names). `onFile` is
 * called for each regular file; return a sink to receive its bytes, or null
 * to skip it. Rejects on a malformed header or a truncated stream.
 */
export async function readTar(
  input: Readable,
  onFile: (file: TarFile) => TarSink | null,
): Promise<void> {
  const header = Buffer.alloc(BLOCK);
  let headerLen = 0;
  // Mutated inside startEntry(); the casts stop TS from narrowing them to their initial values.
  let state = "header" as "header" | "data" | "meta" | "pad";
  let remaining = 0;
  let pad = 0;
  let sink = null as TarSink | null;
  let metaType = "";
  let metaChunks: Buffer[] = [];
  let pax: Record<string, string> = {};
  let longName: string | null = null;

  const startEntry = async (): Promise<void> => {
    if (header.every((b) => b === 0)) {
      state = "header"; // end-of-archive marker (or padding): keep skipping
      return;
    }
    const stored = num(header, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
    if (sum !== stored) throw new Error("tar: bad header checksum");

    const type = String.fromCharCode(header[156]!);
    let size = num(header, 124, 12);
    pad = (BLOCK - (size % BLOCK)) % BLOCK;

    if (type === "x" || type === "g" || type === "L" || type === "K") {
      if (size > MAX_META) throw new Error("tar: oversized extended header");
      metaType = type;
      metaChunks = [];
      remaining = size;
      state = remaining > 0 ? "meta" : pad > 0 ? "pad" : "header";
      if (remaining === 0) finishMeta();
      return;
    }

    let name = cstr(header, 0, 100);
    const magic = cstr(header, 257, 6);
    const prefix = magic.startsWith("ustar") ? cstr(header, 345, 155) : "";
    if (prefix) name = `${prefix}/${name}`;
    if (longName !== null) name = longName;
    if (pax.path !== undefined) name = pax.path;
    if (pax.size !== undefined) {
      size = Number(pax.size);
      pad = (BLOCK - (size % BLOCK)) % BLOCK;
    }
    const mtimeMs = (pax.mtime !== undefined ? Number(pax.mtime) : num(header, 136, 12)) * 1000;
    pax = {};
    longName = null;

    const isFile = type === "0" || type === "\0" || type === "7";
    sink = isFile ? onFile({ name: name.replace(/^(\.\/)+/, ""), size, mtimeMs }) : null;
    remaining = size;
    if (remaining === 0) {
      if (sink) await sink.end();
      sink = null;
      state = pad > 0 ? "pad" : "header";
    } else {
      state = "data";
    }
  };

  function finishMeta(): void {
    const data = Buffer.concat(metaChunks);
    if (metaType === "x") pax = parsePax(data);
    else if (metaType === "L") longName = cstr(data, 0, data.length);
    // "g" (global pax) and "K" (long link name) do not affect file names we read.
    metaChunks = [];
  }

  for await (const chunk of input as AsyncIterable<Buffer>) {
    let off = 0;
    while (off < chunk.length) {
      const avail = chunk.length - off;
      if (state === "header") {
        const n = Math.min(BLOCK - headerLen, avail);
        chunk.copy(header, headerLen, off, off + n);
        headerLen += n;
        off += n;
        if (headerLen === BLOCK) {
          headerLen = 0;
          await startEntry();
        }
      } else if (state === "data") {
        const n = Math.min(remaining, avail);
        if (sink) await sink.write(chunk.subarray(off, off + n));
        remaining -= n;
        off += n;
        if (remaining === 0) {
          if (sink) await sink.end();
          sink = null;
          state = pad > 0 ? "pad" : "header";
        }
      } else if (state === "meta") {
        const n = Math.min(remaining, avail);
        metaChunks.push(Buffer.from(chunk.subarray(off, off + n)));
        remaining -= n;
        off += n;
        if (remaining === 0) {
          finishMeta();
          state = pad > 0 ? "pad" : "header";
        }
      } else {
        const n = Math.min(pad, avail);
        pad -= n;
        off += n;
        if (pad === 0) state = "header";
      }
    }
  }
  if (state === "data" || state === "meta" || headerLen !== 0) {
    if (sink) await sink.end().catch(() => {});
    throw new Error("tar: truncated archive");
  }
}
