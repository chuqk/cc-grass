import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { defaultSinceFor } from "../src/cli.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI = join(__dirname, "..", "dist", "cli.js");
const FIXTURE = join(__dirname, "fixtures");
const PKG_VERSION = (
  JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;

function run(args: string[]) {
  return spawnSync("node", [CLI, "--claude-dir", FIXTURE, ...args], {
    encoding: "utf8",
  });
}

test("cli: --version matches package.json", () => {
  const r = spawnSync("node", [CLI, "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), `cc-grass ${PKG_VERSION}`);
});

test("cli: rejects malformed date string", () => {
  const r = run(["--since", "20260205"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /invalid date/);
});

test("cli: rejects nonexistent calendar date", () => {
  const r = run(["--since", "2026-02-31"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no such day/);
});

test("cli: rejects month out of range", () => {
  const r = run(["--since", "2026-13-01"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no such day/);
});

test("cli: rejects since after until", () => {
  const r = run(["--since", "2026-05-10", "--until", "2026-05-05"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--since.*after.*--until/);
});

test("cli: accepts valid date range and writes SVG to stdout", () => {
  const r = run(["--since", "2026-05-01", "--until", "2026-05-05"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^<svg /);
  assert.match(r.stdout, /<\/svg>\s*$/);
});

test("defaultSinceFor: Thursday until → Sunday 364 days earlier", () => {
  // 2026-05-07 is a Thursday; the contributing week starts Sun 2026-05-03.
  // Mirroring GitHub: the grid starts 52 weeks before that Sunday.
  const until = new Date(2026, 4, 7, 23, 59, 59, 999);
  const since = defaultSinceFor(until);
  assert.equal(since.getFullYear(), 2025);
  assert.equal(since.getMonth(), 4); // May
  assert.equal(since.getDate(), 4);
  assert.equal(since.getDay(), 0); // Sunday
  assert.equal(since.getHours(), 0);
  assert.equal(since.getMinutes(), 0);
});

test("defaultSinceFor: Sunday until → 52 weeks earlier Sunday", () => {
  // 2026-05-03 is a Sunday (dow=0), so since = 2026-05-03 - 0 - 364 = 2025-05-04 (Sun).
  const until = new Date(2026, 4, 3, 23, 59, 59, 999);
  const since = defaultSinceFor(until);
  assert.equal(since.getFullYear(), 2025);
  assert.equal(since.getMonth(), 4);
  assert.equal(since.getDate(), 4);
  assert.equal(since.getDay(), 0);
});

test("defaultSinceFor: Saturday until → previous Sunday minus 364 days", () => {
  // 2026-05-09 is a Saturday (dow=6); since = 2026-05-09 - 6 - 364 = 2025-05-04 (Sun).
  const until = new Date(2026, 4, 9, 23, 59, 59, 999);
  const since = defaultSinceFor(until);
  assert.equal(since.getFullYear(), 2025);
  assert.equal(since.getMonth(), 4);
  assert.equal(since.getDate(), 4);
  assert.equal(since.getDay(), 0);
});
