import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseClaudeProjects } from "../src/parse.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = join(__dirname, "fixtures");

test("parse: counts tokens, prompts, sessions from main jsonl (no subagents)", async () => {
  const r = await parseClaudeProjects({
    claudeDir: FIXTURE,
    includeCodex: false,
    includeSubagents: false,
    cache: false,
  });
  assert.equal(r.fileCount, 1, "should find only main jsonl");
  assert.equal(r.total.prompts, 3, "3 human prompts (tool_result excluded)");
  assert.equal(r.total.tokens, 100 + 50 + (200 + 80 + 1000 + 500) + 10 + 5);
  assert.equal(r.total.sessions, 1);
  assert.equal(r.earliest, "2026-05-01");
  assert.equal(r.latest, "2026-05-03");
});

test("parse: includes subagents by default", async () => {
  const r = await parseClaudeProjects({
    claudeDir: FIXTURE,
    includeCodex: false,
    includeSubagents: true,
    cache: false,
  });
  assert.equal(r.fileCount, 2);
  assert.equal(r.total.prompts, 4);
  assert.equal(r.total.tokens, 100 + 50 + (200 + 80 + 1000 + 500) + 10 + 5 + 50 + 25);
});

test("parse: per-day tokens are correct", async () => {
  const r = await parseClaudeProjects({
    claudeDir: FIXTURE,
    includeCodex: false,
    includeSubagents: false,
    cache: false,
  });
  const day1 = r.buckets.get("2026-05-01");
  const day2 = r.buckets.get("2026-05-02");
  const day3 = r.buckets.get("2026-05-03");
  assert.equal(day1?.tokens, 150);
  assert.equal(day2?.tokens, 1780);
  assert.equal(day3?.tokens, 15);
  assert.equal(day1?.prompts, 1);
});

test("parse: since/until filtering", async () => {
  const r = await parseClaudeProjects({
    claudeDir: FIXTURE,
    includeCodex: false,
    includeSubagents: false,
    cache: false,
    since: new Date("2026-05-02T00:00:00.000Z"),
    until: new Date("2026-05-02T23:59:59.999Z"),
  });
  assert.equal(r.total.tokens, 1780);
  assert.equal(r.total.prompts, 1);
});

test("parse: model tokens are tracked per day", async () => {
  const r = await parseClaudeProjects({
    claudeDir: FIXTURE,
    includeCodex: false,
    includeSubagents: false,
    cache: false,
  });
  const day1 = r.buckets.get("2026-05-01");
  const day2 = r.buckets.get("2026-05-02");
  assert.equal(day1?.modelTokens.get("claude-opus-4-8"), 150);
  assert.equal(day2?.modelTokens.get("claude-sonnet-4-6"), 1780);
  assert.equal(day1?.modelTokens.has("claude-sonnet-4-6"), false);
});

test("parse: missing dir returns empty result", async () => {
  const r = await parseClaudeProjects({
    claudeDir: "/nonexistent/path/xyzzy",
    includeCodex: false,
    cache: false,
  });
  assert.equal(r.fileCount, 0);
  assert.equal(r.total.tokens, 0);
});

test("parse: counts Codex CLI sessions (delta of cumulative token_count, dup-safe)", async () => {
  const r = await parseClaudeProjects({
    claudeDir: join(FIXTURE, "no-such-dir"),
    codexDir: join(FIXTURE, "codex"),
    cache: false,
  });
  assert.equal(r.fileCount, 2);
  // File 1: cumulative counters end at input 3000 + output 280; duplicate and
  // info:null events are ignored. File 2 is a fork: its first token_count
  // carries the parent's 3280 (baseline, not counted) and then adds 500 + 20.
  assert.equal(r.total.tokens, 3000 + 280 + 500 + 20);
  assert.equal(r.total.prompts, 2, "one task_started = one prompt");
  const fork = r.buckets.get("2026-09-08");
  assert.equal(fork?.tokens, 520);
  assert.deepEqual([...fork!.modelTokens.keys()], ["gpt-5.5"]);
  const day = r.buckets.get("2026-09-07");
  assert.ok(day);
  // Model comes from turn_context (gpt-6-astra), overriding session_meta (gpt-5.5).
  assert.deepEqual([...day!.modelTokens.keys()], ["gpt-6-astra"]);
  assert.equal(day!.modelTokens.get("gpt-6-astra"), 3280);
  const bd = day!.modelBreakdown.get("gpt-6-astra")!;
  assert.equal(bd.cacheRead, 400, "cached_input_tokens -> cacheRead");
  assert.equal(bd.input, 3000 - 400, "non-cached input");
  assert.equal(bd.output, 280);
});

test("parse: includeCodex=false skips ~/.codex entirely", async () => {
  const r = await parseClaudeProjects({
    claudeDir: join(FIXTURE, "no-such-dir"),
    codexDir: join(FIXTURE, "codex"),
    includeCodex: false,
    cache: false,
  });
  assert.equal(r.fileCount, 0);
});
