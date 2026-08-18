import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaudeProjects, type ParseResult } from "../src/parse.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = join(__dirname, "fixtures");

function setup(): { claudeDir: string; cacheDir: string } {
  const claudeDir = mkdtempSync(join(tmpdir(), "cc-grass-claude-"));
  cpSync(join(FIXTURE, "projects"), join(claudeDir, "projects"), {
    recursive: true,
  });
  const cacheDir = mkdtempSync(join(tmpdir(), "cc-grass-cache-"));
  return { claudeDir, cacheDir };
}

function snapshot(r: ParseResult) {
  return {
    total: r.total,
    earliest: r.earliest,
    latest: r.latest,
    fileCount: r.fileCount,
    days: [...r.buckets.values()]
      .map((b) => ({
        date: b.date,
        prompts: b.prompts,
        tokens: b.tokens,
        sessions: [...b.sessionIds].sort(),
        models: Object.fromEntries([...b.modelTokens].sort()),
        breakdown: Object.fromEntries([...b.modelBreakdown].sort()),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

test("cache: warm run hits cache and returns identical results", async () => {
  const { claudeDir, cacheDir } = setup();
  const cold = await parseClaudeProjects({ claudeDir, cacheDir });
  assert.deepEqual(cold.cacheStats, { unchanged: 0, parsed: 2 });

  const warm = await parseClaudeProjects({ claudeDir, cacheDir });
  assert.deepEqual(warm.cacheStats, { unchanged: 2, parsed: 0 });
  assert.deepEqual(snapshot(warm), snapshot(cold));
});

test("cache: changed file is re-parsed, unchanged file stays cached", async () => {
  const { claudeDir, cacheDir } = setup();
  const cold = await parseClaudeProjects({ claudeDir, cacheDir });

  const sessionFile = join(claudeDir, "projects", "test-proj", "session-a.jsonl");
  appendFileSync(
    sessionFile,
    `\n{"type":"assistant","timestamp":"2026-05-04T09:00:00.000Z","message":{"role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":4,"output_tokens":3}}}\n`,
  );

  const warm = await parseClaudeProjects({ claudeDir, cacheDir });
  assert.deepEqual(warm.cacheStats, { unchanged: 1, parsed: 1 });
  assert.equal(warm.total.tokens, cold.total.tokens + 7);
  assert.equal(warm.buckets.get("2026-05-04")?.tokens, 7);
});

test("cache: corrupt cache file falls back to a full scan", async () => {
  const { claudeDir, cacheDir } = setup();
  const cold = await parseClaudeProjects({ claudeDir, cacheDir });

  const cacheFiles = readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
  assert.equal(cacheFiles.length, 1);
  writeFileSync(join(cacheDir, cacheFiles[0]), "not json at all", "utf8");

  const recovered = await parseClaudeProjects({ claudeDir, cacheDir });
  assert.deepEqual(recovered.cacheStats, { unchanged: 0, parsed: 2 });
  assert.deepEqual(snapshot(recovered), snapshot(cold));
});

test("cache: deleted file is pruned from results on the next run", async () => {
  const { claudeDir, cacheDir } = setup();
  await parseClaudeProjects({ claudeDir, cacheDir });

  rmSync(join(claudeDir, "projects", "test-proj", "session-a", "subagents", "agent-1.jsonl"));

  const after = await parseClaudeProjects({ claudeDir, cacheDir });
  assert.equal(after.fileCount, 1);
  assert.equal(after.total.tokens, 100 + 50 + (200 + 80 + 1000 + 500) + 10 + 5);
  assert.deepEqual(after.cacheStats, { unchanged: 1, parsed: 0 });
});

test("cache: sub-day since/until window bypasses the cache", async () => {
  const { claudeDir, cacheDir } = setup();
  // 09:30 local time is not a day boundary in any timezone.
  const since = new Date(2026, 4, 1, 9, 30);
  const until = new Date(2026, 4, 3, 23, 59, 59, 999);

  const exact = await parseClaudeProjects({ claudeDir, cacheDir, since, until });
  assert.equal(exact.cacheStats, undefined);

  const uncached = await parseClaudeProjects({
    claudeDir,
    cache: false,
    since,
    until,
  });
  assert.deepEqual(snapshot(exact), snapshot(uncached));
  assert.equal(readdirSync(cacheDir).length, 0, "bypass must not write a cache");
});

test("cache: day-aligned since/until uses cache and matches uncached scan", async () => {
  const { claudeDir, cacheDir } = setup();
  const since = new Date(2026, 4, 2, 0, 0, 0, 0);
  const until = new Date(2026, 4, 2, 23, 59, 59, 999);

  const cold = await parseClaudeProjects({ claudeDir, cacheDir, since, until });
  assert.deepEqual(cold.cacheStats, { unchanged: 0, parsed: 2 });
  const warm = await parseClaudeProjects({ claudeDir, cacheDir, since, until });
  assert.deepEqual(warm.cacheStats, { unchanged: 2, parsed: 0 });

  const uncached = await parseClaudeProjects({ claudeDir, cache: false, since, until });
  assert.deepEqual(snapshot(warm), snapshot(uncached));
});

test("cache: cache=false writes no cache file", async () => {
  const { claudeDir, cacheDir } = setup();
  const r = await parseClaudeProjects({ claudeDir, cacheDir, cache: false });
  assert.equal(r.cacheStats, undefined);
  assert.equal(readdirSync(cacheDir).length, 0);
});
