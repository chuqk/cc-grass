import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSvg, formatMetricValue } from "../src/svg.js";
import type { DailyBucket } from "../src/parse.js";

function emptyBuckets(): Map<string, DailyBucket> {
  return new Map();
}

test("svg: renders valid SVG root with width/height", () => {
  const since = new Date(2026, 0, 1);
  const until = new Date(2026, 11, 31);
  const out = renderSvg({
    buckets: emptyBuckets(),
    metric: "tokens",
    since,
    until,
    total: { tokens: 0, prompts: 0, sessions: 0 },
  });
  assert.match(out, /^<svg /);
  assert.match(out, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(out, /width="\d+"/);
  assert.match(out, /height="\d+"/);
  assert.match(out, /<\/svg>$/);
});

test("svg: contains GitHub-style labels", () => {
  const since = new Date(2026, 0, 1);
  const until = new Date(2026, 11, 31);
  const out = renderSvg({
    buckets: emptyBuckets(),
    metric: "tokens",
    since,
    until,
    total: { tokens: 0, prompts: 0, sessions: 0 },
  });
  assert.ok(out.includes(">Mon<"));
  assert.ok(out.includes(">Wed<"));
  assert.ok(out.includes(">Fri<"));
  assert.ok(out.includes(">Less<"));
  assert.ok(out.includes(">More<"));
});

test("svg: header reflects total tokens", () => {
  const since = new Date(2026, 0, 1);
  const until = new Date(2026, 11, 31);
  const out = renderSvg({
    buckets: emptyBuckets(),
    metric: "tokens",
    since,
    until,
    total: { tokens: 34_800_000, prompts: 0, sessions: 0 },
  });
  assert.ok(out.includes("34.8m tokens in the last year"));
});

test("svg: tooltip in <title> for in-range cells", () => {
  const since = new Date(2026, 4, 1);
  const until = new Date(2026, 4, 5);
  const buckets: Map<string, DailyBucket> = new Map();
  buckets.set("2026-05-03", {
    date: "2026-05-03",
    tokens: 1234,
    prompts: 5,
    sessionIds: new Set(["x"]),
  });
  const out = renderSvg({
    buckets,
    metric: "tokens",
    since,
    until,
    total: { tokens: 1234, prompts: 5, sessions: 1 },
  });
  assert.ok(out.includes("1,234 tokens on May 3rd."));
});

test("formatMetricValue: tokens use k/m/b suffix", () => {
  assert.equal(formatMetricValue(0, "tokens"), "0");
  assert.equal(formatMetricValue(999, "tokens"), "999");
  assert.equal(formatMetricValue(1500, "tokens"), "1.5k");
  assert.equal(formatMetricValue(34_800_000, "tokens"), "34.8m");
  assert.equal(formatMetricValue(1_500_000_000, "tokens"), "1.5b");
});

test("formatMetricValue: prompts use comma format", () => {
  assert.equal(formatMetricValue(1474, "prompts"), "1,474");
});
