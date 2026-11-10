import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaudeProjects, type ParseOptions, type ParseResult } from "../src/parse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "fixtures");
const CLI = join(__dirname, "..", "dist", "cli.js");
const HAS_PYTHON = spawnSync("python3", ["--version"]).status === 0;

// Moves transcripts the way a real archiver does (Python tarfile/gzip, like
// the flow that motivated this feature): one .jsonl.gz per transcript plus a
// .dir.tar.gz of its companion folder (arcname "."), or a bundle tar.gz holding
// many transcripts (`member`) with companion folders as "<stem>/...".
const FLOW_PY = String.raw`
import gzip, json, os, shutil, sys, tarfile
from datetime import datetime
from pathlib import Path
cfg = json.load(sys.stdin)
nas, catalog = Path(cfg["nas"]), Path(cfg["catalog"])
lines = []
def entry(src, dest, **extra):
    st = src.stat()
    return {"id": src.stem, "agent": cfg.get("agent", "claude"), "class": "interactive", "slug": src.parent.name,
            "source_path": str(src.resolve()), "nas_path": str(dest), "bytes": st.st_size,
            "mtime": datetime.fromtimestamp(st.st_mtime).astimezone().isoformat(timespec="seconds"),
            "flowed_at": datetime.now().astimezone().isoformat(timespec="seconds"), **extra}
for p in cfg.get("one", []):
    src = Path(p); sib = src.with_suffix("")
    dest = nas / src.parent.name / (src.name + ".gz"); dest.parent.mkdir(parents=True, exist_ok=True)
    with open(src, "rb") as fin, gzip.open(dest, "wb") as fout: shutil.copyfileobj(fin, fout)
    e = entry(src, dest)
    if sib.is_dir():
        tar_dest = dest.with_name(src.stem + ".dir.tar.gz")
        with tarfile.open(tar_dest, "w:gz") as tar: tar.add(sib, arcname=".")
        e["nas_dir_archive"] = str(tar_dest)
    lines.append(e)
if cfg.get("bundle"):
    dest = nas / Path(cfg["bundle"][0]).parent.name / "unattended-1.tar.gz"; dest.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(dest, "w:gz") as tar:
        for p in cfg["bundle"]:
            src = Path(p); sib = src.with_suffix("")
            tar.add(src, arcname=src.name)
            if sib.is_dir(): tar.add(sib, arcname=src.stem)
    lines += [entry(Path(p), dest, member=Path(p).name, **{"class": "unattended"}) for p in cfg["bundle"]]
with open(catalog, "a") as f:
    for e in lines: f.write(json.dumps(e) + "\n")
for e in lines:
    src = Path(e["source_path"]); sib = src.with_suffix("")
    src.unlink()
    if sib.is_dir(): shutil.rmtree(sib)
`;

interface Env {
  root: string;
  claudeDir: string;
  codexDir: string;
  projects: string;
  nas: string;
  catalog: string;
  cacheDir: string;
}

function setup(): Env {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cc-grass-archive-")));
  const claudeDir = join(root, "claude");
  const projects = join(claudeDir, "projects", "-proj");
  const src = join(FIXTURE, "projects", "test-proj");
  mkdirSync(projects, { recursive: true });
  // a: moved alone (gz + companion folder archive); b, c: moved in a bundle;
  // keep: stays on disk; gone: deleted without a catalog line.
  for (const id of ["a", "b", "c", "keep", "gone"]) {
    cpSync(join(src, "session-a.jsonl"), join(projects, `${id}.jsonl`));
  }
  for (const id of ["a", "b"]) {
    cpSync(join(src, "session-a", "subagents"), join(projects, id, "subagents"), { recursive: true });
    mkdirSync(join(projects, id, "tool-results"), { recursive: true });
    writeFileSync(join(projects, id, "tool-results", "big.txt"), "not a transcript");
  }
  const codexDir = join(root, "codex");
  cpSync(join(FIXTURE, "codex", "sessions"), join(codexDir, "sessions"), { recursive: true });
  mkdirSync(join(codexDir, "archived_sessions"), { recursive: true });
  cpSync(
    join(FIXTURE, "codex", "sessions", "2026", "09", "08", "rollout-2026-09-08T01-00-00-fork.jsonl"),
    join(codexDir, "archived_sessions", "rollout-2026-09-08T01-00-00-fork.jsonl"),
  );
  return {
    root,
    claudeDir,
    codexDir,
    projects,
    nas: join(root, "nas"),
    catalog: join(root, "catalog.jsonl"),
    cacheDir: join(root, "cache"),
  };
}

function flow(env: Env, spec: { one?: string[]; bundle?: string[] }): void {
  const r = spawnSync("python3", ["-c", FLOW_PY], {
    input: JSON.stringify({ nas: env.nas, catalog: env.catalog, ...spec }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
}

function flowAll(env: Env): void {
  flow(env, { one: [join(env.projects, "a.jsonl")] });
  flow(env, { bundle: [join(env.projects, "b.jsonl"), join(env.projects, "c.jsonl")] });
  const rollout = join(env.codexDir, "sessions", "2026", "09", "07", "rollout-2026-09-07T14-20-59-test.jsonl");
  flow(env, { one: [rollout] });
  flow(env, { bundle: [join(env.codexDir, "archived_sessions", "rollout-2026-09-08T01-00-00-fork.jsonl")] });
}

function run(env: Env, extra: ParseOptions = {}): Promise<ParseResult> {
  return parseClaudeProjects({
    claudeDir: env.claudeDir,
    codexDir: env.codexDir,
    cacheDir: env.cacheDir,
    archiveCatalog: env.catalog,
    ...extra,
  });
}

function days(r: ParseResult) {
  return {
    total: r.total,
    earliest: r.earliest,
    latest: r.latest,
    days: [...r.buckets.values()]
      .map((b) => ({
        date: b.date,
        prompts: b.prompts,
        tokens: b.tokens,
        sessions: b.sessionIds.size,
        models: Object.fromEntries([...b.modelTokens].sort()),
        breakdown: Object.fromEntries([...b.modelBreakdown].sort()),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

const skip = HAS_PYTHON ? false : "python3 is needed to build tar archives like a real archiver";

test("archive: without a catalog, moved transcripts drop out as before", { skip }, async () => {
  const env = setup();
  const before = await run(env, { archiveCatalog: undefined, cache: false });
  flowAll(env);
  const after = await run(env, { archiveCatalog: undefined, cache: false });
  assert.equal(after.archive, undefined);
  assert.ok(after.total.tokens < before.total.tokens);
  assert.equal(after.fileCount, before.fileCount - 7, "a, a/agent, b, b/agent, c and 2 rollouts left");
  rmSync(env.root, { recursive: true, force: true });
});

test("archive: catalog mode counts the same as the default before anything moves", { skip }, async () => {
  const env = setup();
  for (const includeSubagents of [true, false]) {
    const plain = await run(env, { archiveCatalog: undefined, includeSubagents, cache: false });
    const withCatalog = await run(env, { includeSubagents });
    assert.deepEqual(days(withCatalog), days(plain));
    assert.equal(withCatalog.fileCount, plain.fileCount);
    assert.deepEqual(withCatalog.archive?.missingCatalogs, [env.catalog]);
  }
  rmSync(env.root, { recursive: true, force: true });
});

test("archive: (a) moved days stay, (b) and come back from the archive after the cache is lost", { skip }, async () => {
  const env = setup();
  const before = days(await run(env));
  flowAll(env);

  const after = await run(env);
  assert.deepEqual(days(after), before, "(a) identical right after moving");
  assert.equal(after.archive?.restored, 0, "fresh cache entries are adopted without reading the archive");
  assert.equal(after.archive?.entries, 5);
  assert.equal(after.archive?.files, 7);

  rmSync(env.cacheDir, { recursive: true, force: true });
  const rebuilt = await run(env);
  assert.deepEqual(days(rebuilt), before, "(b) identical after the cache is deleted");
  assert.equal(rebuilt.archive?.restored, 5);
  assert.equal(rebuilt.archive?.unreadable, 0);

  const warm = await run(env);
  assert.deepEqual(days(warm), before);
  assert.equal(warm.archive?.restored, 0, "the archive is not read again once restored");

  // Without the cache at all, the archive is read on every run.
  assert.deepEqual(days(await run(env, { cache: false })), before);
  rmSync(env.root, { recursive: true, force: true });
});

test("archive: --no-include-subagents and day windows match the pre-move result", { skip }, async () => {
  const env = setup();
  const since = new Date(2026, 4, 2);
  const until = new Date(2026, 8, 7, 23, 59, 59, 999);
  const subtle = new Date(2026, 4, 2, 12, 0, 0); // not day-aligned: bypasses the cache
  const beforeNoSub = days(await run(env, { includeSubagents: false }));
  const beforeWindow = days(await run(env, { since, until }));
  const beforeSubtle = days(await run(env, { since: subtle, cache: false }));
  flowAll(env);
  rmSync(env.cacheDir, { recursive: true, force: true });
  assert.deepEqual(days(await run(env, { includeSubagents: false })), beforeNoSub);
  assert.deepEqual(days(await run(env, { since, until })), beforeWindow);
  assert.deepEqual(days(await run(env, { since: subtle })), beforeSubtle);
  rmSync(env.root, { recursive: true, force: true });
});

test("archive: (c) unreadable archive is reported, not cached, and retried", { skip }, async () => {
  const env = setup();
  const before = days(await run(env));
  flowAll(env);
  rmSync(env.cacheDir, { recursive: true, force: true });
  const offline = join(env.root, "nas-offline");
  renameSync(env.nas, offline);

  const missing = await run(env);
  assert.equal(missing.archive?.unreadable, 5);
  assert.ok(missing.total.tokens < before.total.tokens);
  const again = await run(env);
  assert.equal(again.archive?.unreadable, 5, "nothing was stored as if complete");

  const cli = spawnSync(
    "node",
    [CLI, "--claude-dir", env.claudeDir, "--codex-dir", env.codexDir, "--cache-dir", env.cacheDir,
      "--archive-catalog", env.catalog, "-o", join(env.root, "out.svg")],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 3);
  assert.match(cli.stderr, /could not read 5 archived transcript/);

  renameSync(offline, env.nas);
  const back = await run(env);
  assert.equal(back.archive?.unreadable, 0);
  assert.equal(back.archive?.restored, 5);
  assert.deepEqual(days(back), before);
  rmSync(env.root, { recursive: true, force: true });
});

test("archive: (d) a file removed without a catalog line still drops out", { skip }, async () => {
  const env = setup();
  await run(env);
  flowAll(env);
  const withGone = await run(env);
  rmSync(join(env.projects, "gone.jsonl"));
  const without = await run(env);
  assert.equal(without.total.sessions, withGone.total.sessions - 1);
  assert.ok(without.total.tokens < withGone.total.tokens);
  rmSync(env.root, { recursive: true, force: true });
});

test("archive: a transcript copied back from the archive is not counted twice", { skip }, async () => {
  const env = setup();
  const before = days(await run(env));
  flowAll(env);
  await run(env);
  const a = join(env.projects, "a.jsonl");
  writeFileSync(a, gunzipSync(readFileSync(join(env.nas, "-proj", "a.jsonl.gz"))));
  assert.deepEqual(days(await run(env)), before);
  rmSync(env.cacheDir, { recursive: true, force: true });
  assert.deepEqual(days(await run(env)), before, "companion folder comes from the archive, main from disk");
  rmSync(env.root, { recursive: true, force: true });
});

test("archive: catalog paths through a symlinked config folder still match", { skip }, async () => {
  const env = setup();
  const alias = join(env.root, "claude-alias");
  symlinkSync(env.claudeDir, alias);
  const aliased = { ...env, claudeDir: alias };
  const before = days(await run(aliased));
  flowAll(env);
  rmSync(env.cacheDir, { recursive: true, force: true });
  assert.deepEqual(days(await run(aliased)), before);
  assert.ok(existsSync(env.catalog));
  rmSync(env.root, { recursive: true, force: true });
});

test("archive: a transcript that changed after the last scan is re-read from the archive", { skip }, async () => {
  const env = setup();
  await run(env);
  const a = join(env.projects, "a.jsonl");
  const extra =
    '{"type":"user","timestamp":"2026-05-04T10:00:00.000Z","message":{"role":"user","content":"late"}}\n' +
    '{"type":"assistant","timestamp":"2026-05-04T10:00:01.000Z","message":{"role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":7,"output_tokens":3}}}\n';
  writeFileSync(a, readFileSync(a, "utf8") + extra);
  const later = new Date(Date.now() + 120_000);
  utimesSync(a, later, later);
  const expected = days(await run(env, { archiveCatalog: undefined, cache: false }));
  flowAll(env);
  const r = await run(env);
  assert.equal(r.archive?.restored, 1, "only the stale transcript is read back");
  assert.deepEqual(days(r), expected);
  rmSync(env.root, { recursive: true, force: true });
});

test("archive: long and non-ASCII member names (pax headers) are read", { skip }, async () => {
  const env = setup();
  const long = `agent-${"x".repeat(120)}-草.jsonl`;
  cpSync(join(FIXTURE, "projects", "test-proj", "session-a", "subagents", "agent-1.jsonl"), join(env.projects, "a", "subagents", long));
  cpSync(join(FIXTURE, "projects", "test-proj", "session-a", "subagents", "agent-1.jsonl"), join(env.projects, "b", "subagents", long));
  const before = days(await run(env));
  flowAll(env);
  rmSync(env.cacheDir, { recursive: true, force: true });
  const r = await run(env);
  assert.equal(r.archive?.unreadable, 0);
  assert.equal(r.archive?.files, 9);
  assert.deepEqual(days(r), before);
  rmSync(env.root, { recursive: true, force: true });
});
