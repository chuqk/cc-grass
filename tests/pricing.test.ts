import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCost, getPricing, hasPricing, pricingKey } from "../src/pricing.js";

const M = 1_000_000;

test("pricingKey: exact, dated snapshot, -latest, and effort suffix all resolve", () => {
  assert.equal(pricingKey("claude-opus-5"), "claude-opus-5");
  assert.equal(pricingKey("claude-opus-4-5-20251101"), "claude-opus-4-5");
  assert.equal(pricingKey("claude-sonnet-4-20250514"), "claude-sonnet-4");
  assert.equal(pricingKey("claude-3-5-haiku-latest"), "claude-3-5-haiku");
  assert.equal(pricingKey("gpt-5.4-high"), "gpt-5.4");
  assert.equal(pricingKey("no-such-model"), null);
});

test("every model that shows up in Claude Code / Codex logs has a current price", () => {
  for (const id of [
    "claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7",
    "claude-opus-4-6", "claude-opus-4-5-20251101", "claude-sonnet-5", "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001",
    "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini",
    "gpt-5.3-codex", "gpt-5.2", "gpt-5.2-codex", "gpt-5.1", "gpt-5", "gpt-5-codex",
  ]) {
    assert.ok(hasPricing(id, "2026-09-09"), `${id} has no price on 2026-09-09`);
  }
});

test("period lookup: GPT-5.6 Sol price cut on 2026-08-21", () => {
  assert.equal(getPricing("gpt-5.6-sol", "2026-08-20")!.input, 5);
  assert.equal(getPricing("gpt-5.6-sol", "2026-08-21")!.input, 4);
  assert.equal(getPricing("gpt-5.6-sol")!.input, 4); // no date → current
});

test("period lookup: Haiku 3.5 launch price vs cut, and nothing after retirement", () => {
  assert.equal(getPricing("claude-3-5-haiku-20241022", "2024-11-20")!.input, 1);
  assert.equal(getPricing("claude-3-5-haiku-20241022", "2024-12-03")!.input, 0.8);
  assert.equal(getPricing("claude-3-5-haiku-20241022", "2026-03-01"), null);
});

test("usage before a model's launch date falls back to its launch price", () => {
  assert.equal(getPricing("claude-fable-5-1", "2026-08-20")!.input, 10);
});

test("Fable 5.1 cache read is 0.25 while Fable 5 is 1.00; Sonnet 5 is 2/10", () => {
  assert.equal(getPricing("claude-fable-5-1")!.cacheRead, 0.25);
  assert.equal(getPricing("claude-fable-5")!.cacheRead, 1);
  assert.deepEqual(
    [getPricing("claude-sonnet-5")!.input, getPricing("claude-sonnet-5")!.output],
    [2, 10],
  );
});

test("estimateCost splits cache writes into 5m (1.25x) and 1h (2x) tiers", () => {
  const bd = { input: 0, output: 0, cacheWrite: 2 * M, cacheWrite1h: 1 * M, cacheRead: 0 };
  // Opus 5: 1M @ 6.25 + 1M @ 10
  assert.equal(estimateCost("claude-opus-5", bd, "2026-09-01"), 16.25);
});

test("estimateCost: full Opus 5 breakdown and unknown model", () => {
  const bd = { input: 1 * M, output: 1 * M, cacheWrite: 1 * M, cacheWrite1h: 0, cacheRead: 10 * M };
  assert.equal(estimateCost("claude-opus-5", bd, "2026-09-01"), 5 + 25 + 6.25 + 5);
  assert.equal(estimateCost("unknown-model", bd, "2026-09-01"), 0);
  assert.equal(hasPricing("unknown-model"), false);
});

test("estimateCost: Codex breakdown (non-cached input + cached read, no cache-write charge pre-5.6)", () => {
  const bd = { input: 1 * M, output: 1 * M, cacheWrite: 1 * M, cacheWrite1h: 0, cacheRead: 1 * M };
  assert.equal(estimateCost("gpt-5.5", bd, "2026-06-01"), 5 + 30 + 0 + 0.5);
  assert.equal(estimateCost("gpt-6-astra", bd, "2026-09-06"), 10 + 50 + 12.5 + 1);
});
