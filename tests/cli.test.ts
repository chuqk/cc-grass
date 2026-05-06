import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

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
