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
    includeSubagents: false,
  });
  assert.equal(r.fileCount, 1, "should find only main jsonl");
  assert.equal(r.total.prompts, 3, "3 human prompts (tool_result excluded)");
  assert.equal(r.total.tokens, 100 + 50 + 200 + 80 + 10 + 5);
  assert.equal(r.total.sessions, 1);
  assert.equal(r.earliest, "2026-05-01");
  assert.equal(r.latest, "2026-05-03");
});

test("parse: includes subagents by default", async () => {
  const r = await parseClaudeProjects({
    claudeDir: FIXTURE,
    includeSubagents: true,
  });
  assert.equal(r.fileCount, 2);
  assert.equal(r.total.prompts, 4);
  assert.equal(r.total.tokens, 100 + 50 + 200 + 80 + 10 + 5 + 50 + 25);
});

test("parse: per-day tokens are correct", async () => {
  const r = await parseClaudeProjects({
    claudeDir: FIXTURE,
    includeSubagents: false,
  });
  const day1 = r.buckets.get("2026-05-01");
  const day2 = r.buckets.get("2026-05-02");
  const day3 = r.buckets.get("2026-05-03");
  assert.equal(day1?.tokens, 150);
  assert.equal(day2?.tokens, 280);
  assert.equal(day3?.tokens, 15);
  assert.equal(day1?.prompts, 1);
});

test("parse: since/until filtering", async () => {
  const r = await parseClaudeProjects({
    claudeDir: FIXTURE,
    includeSubagents: false,
    since: new Date("2026-05-02T00:00:00.000Z"),
    until: new Date("2026-05-02T23:59:59.999Z"),
  });
  assert.equal(r.total.tokens, 280);
  assert.equal(r.total.prompts, 1);
});

test("parse: missing dir returns empty result", async () => {
  const r = await parseClaudeProjects({
    claudeDir: "/nonexistent/path/xyzzy",
  });
  assert.equal(r.fileCount, 0);
  assert.equal(r.total.tokens, 0);
});
