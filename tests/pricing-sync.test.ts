import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOfficialPrices, reconcilePrices, refreshPrices, SOURCES } from "../scripts/sync-pricing.mjs";
import { getPricing } from "../src/pricing.js";
import { renderHtml } from "../src/html.js";
import { runInNewContext } from "node:vm";

const openai = `### Standard pricing data
| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input |
| --- | --- | --- | --- | --- | --- |
| gpt-future | $2.00 | $0.10 | $2.50 | $10.00 | $4.00 |
| gpt-5.5 (<272K context length) | $5.00 | $0.50 | - | $30.00 | $10.00 |
### Batch pricing data
| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input |
| --- | --- | --- | --- | --- | --- |
| gpt-future | $1.00 | $0.05 | $1.25 | $5.00 | $2.00 |
`;
const anthropic = `## Model pricing
| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Opus 9.1 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Haiku 3.5 ([retired](https://platform.claude.com/)) | $0.80 / MTok | $1 / MTok | $1.60 / MTok | $0.08 / MTok | $4 / MTok |
## Batch pricing
`;

test("official parsers select Standard/short-context prices and explicit cache rates", () => {
  const g = parseOfficialPrices("openai", openai);
  assert.equal(g.get("gpt-future").input, 2);
  assert.equal(g.get("gpt-future").cacheRead, 0.1);
  assert.equal(g.get("gpt-5.5").cacheWrite, 0);
  const a = parseOfficialPrices("anthropic", anthropic);
  assert.equal(a.get("claude-opus-9-1").cacheWrite1h, 8);
  assert.equal(a.get("claude-opus-9-1").cacheRead, 0.2);
  assert.equal(a.get("claude-3-5-haiku").input, 0.8);
  assert.throws(() => parseOfficialPrices("openai", openai.replace("Short context input", "Long context input")), /columns changed/);
  assert.throws(() => parseOfficialPrices("anthropic", anthropic.replace("$4 / MTok", "€4 / MTok")), /Unrecognized USD/);
});

test("new models register automatically; changed existing prices never rewrite history", () => {
  const prices = parseOfficialPrices("openai", openai);
  prices.set("gpt-5.6-sol", { ...prices.get("gpt-future"), input: 1 });
  const previous = { version: 1, models: {} };
  const result = reconcilePrices(previous, prices, ["gpt-future-high", "gpt-5.6-sol", "codex-auto-review"], "2026-10-02");
  assert.deepEqual(result.added, ["gpt-future"]);
  assert.equal(getPricing("gpt-future-high", "2026-10-01", result.state.models)!.input, 2);
  assert.equal(getPricing("gpt-5.6-sol", "2026-08-20", result.state.models)!.input, 5);
  assert.equal(getPricing("gpt-5.6-sol", "2026-10-02", result.state.models)!.input, 4);
  assert.equal(result.state.priceChanges[0].model, "gpt-5.6-sol");
  assert.equal(result.state.unresolved[0].model, "codex-auto-review");
  assert.deepEqual(previous.models, {});
  const retired = reconcilePrices(previous, parseOfficialPrices("anthropic", anthropic), ["claude-3-5-haiku"], "2026-10-02");
  assert.deepEqual(retired.added, []);
  assert.equal(getPricing("claude-3-5-haiku", "2024-11-20", retired.state.models)!.input, 1);
  assert.equal(getPricing("claude-3-5-haiku", "2026-10-02", retired.state.models), null);
});

test("network failure preserves verified catalog and retries hourly; unseen models bypass daily TTL", async () => {
  let calls = 0;
  const fetchPage = async (url: string) => {
    calls++;
    return { ok: true, text: async () => url === SOURCES.openai ? openai : anthropic };
  };
  const now = new Date("2026-10-02T00:00:00Z");
  const first = await refreshPrices({ version: 1, models: {} }, ["gpt-future"], { now, fetchPage });
  assert.equal(calls, 2);
  const second = await refreshPrices(first.state, ["gpt-future"], { now: new Date(+now + 600_000), fetchPage });
  assert.ok(second.skipped);
  assert.equal(calls, 2);
  const third = await refreshPrices(first.state, ["gpt-future", "claude-opus-9-1"], { now: new Date(+now + 600_000), fetchPage });
  assert.equal(calls, 4);
  assert.ok(third.state.models["claude-opus-9-1"]);
  const failure = async () => { calls++; throw new Error("offline"); };
  const failed = await refreshPrices(third.state, ["gpt-future", "claude-opus-9-1"], { now: new Date(+now + 2 * 86_400_000), fetchPage: failure });
  assert.deepEqual(failed.state.models, third.state.models);
  assert.equal(failed.state.errors.length, 2);
  const skipped = await refreshPrices(failed.state, failed.state.observedModels, { now: new Date(+now + 2 * 86_400_000 + 600_000), fetchPage: failure });
  assert.ok(skipped.skipped);
  const recovered = await refreshPrices(failed.state, failed.state.observedModels, { now: new Date(+now + 2 * 86_400_000 + 3_600_000), fetchPage });
  assert.deepEqual(recovered.state.errors, []);
});

test("weekly tooltip preserves unknown prices in either order and across model snapshots", () => {
  for (const costs of [[null, 2], [2, null]]) {
    const html = renderHtml("<svg></svg>", { chartData: costs.map((cost, i) => ({ date: `2026-09-${27 + i}`,
      models: { [`claude-opus-5-5-2026092${i}`]: 100 }, costs: { [`claude-opus-5-5-2026092${i}`]: cost } })) });
    const start = html.indexOf("var wm={},wcm={};");
    const end = html.indexOf("var allWeekKeys=[];", start);
    const D = costs.map((cost, i) => ({ date: `2026-09-${27 + i}`, models: { [`model-${i}`]: 100 }, costs: { [`model-${i}`]: cost } }));
    const context = { D, norm: () => "same-model" };
    runInNewContext(html.slice(start, end), context);
    assert.equal((context as any).wcm["2026-09-27"]["same-model"], null);
  }
});
