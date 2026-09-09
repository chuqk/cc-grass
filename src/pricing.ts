// USD per million tokens, per model, per price period. Standard-tier API rates.
//
// Verified against primary sources on 2026-09-09 (live docs + launch posts +
// web.archive.org captures of the vendors' pricing pages):
//   Anthropic  https://platform.claude.com/docs/en/about-claude/pricing
//              https://platform.claude.com/docs/en/models/<name>/overview
//              https://www.anthropic.com/news/<launch post>
//   OpenAI     https://developers.openai.com/api/docs/pricing
//              https://developers.openai.com/api/docs/models/<slug>
//              https://openai.com/index/<launch post>
//
// A model gets one row per price period: `from` and `to` are inclusive calendar
// days (YYYY-MM-DD); omit `to` for the price currently in force. A day's cost uses
// the row in force that day, so a vendor price change never rewrites history.
//
// Not modelled (would need per-request data the daily buckets don't keep):
//   - long-context premiums (Claude 4.6-era >200K beta, GPT >272K: 2x in / 1.5x out)
//   - Anthropic fast mode (`speed: "fast"`), Batch / Flex / Priority tiers

export interface ModelPricing {
  input: number;
  output: number;
  /** cache write, 5-minute TTL (Anthropic 1.25x input; OpenAI GPT-5.6+ 1.25x, older 0) */
  cacheWrite: number;
  /** cache write, 1-hour TTL (Anthropic 2x input; OpenAI has no TTL tiers → same as cacheWrite) */
  cacheWrite1h: number;
  cacheRead: number;
}

export interface PricePeriod extends ModelPricing {
  from: string;
  to?: string;
}

// Anthropic multipliers: 5m write 1.25x, 1h write 2x, read 0.1x (Fable 5.1 / Mythos 5.1: 0.025x).
const A = (input: number, output: number, cacheRead = input / 10): ModelPricing => ({
  input,
  output,
  cacheWrite: input * 1.25,
  cacheWrite1h: input * 2,
  cacheRead,
});
// OpenAI: cached input 10% of input (o-series differ → explicit). Cache writes are free
// before GPT-5.6, 1.25x input from GPT-5.6 on.
const G = (input: number, output: number, cacheRead = input / 10, cacheWrite = 0): ModelPricing => ({
  input,
  output,
  cacheWrite,
  cacheWrite1h: cacheWrite,
  cacheRead,
});

const FABLE = A(10, 50);
const FABLE_51 = A(10, 50, 0.25);
const OPUS = A(5, 25);
const OPUS_LEGACY = A(15, 75);
const SONNET = A(3, 15);
const SONNET_5 = A(2, 10);
const HAIKU_45 = A(1, 5);

const PRICING: Record<string, PricePeriod[]> = {
  // ---- Anthropic ---------------------------------------------------------
  "claude-fable-5-1":  [{ from: "2026-09-01", ...FABLE_51 }],
  "claude-mythos-5-1": [{ from: "2026-09-01", ...FABLE_51 }],
  "claude-fable-5":    [{ from: "2026-06-09", ...FABLE }],
  "claude-mythos-5":   [{ from: "2026-06-09", ...FABLE }],
  "claude-opus-5":     [{ from: "2026-07-24", ...OPUS }],
  "claude-opus-4-8":   [{ from: "2026-05-28", ...OPUS }],
  "claude-opus-4-7":   [{ from: "2026-04-16", ...OPUS }],
  "claude-opus-4-6":   [{ from: "2026-02-05", ...OPUS }],
  "claude-opus-4-5":   [{ from: "2025-11-24", ...OPUS }],
  "claude-opus-4-1":   [{ from: "2025-08-05", to: "2026-08-05", ...OPUS_LEGACY }],
  "claude-opus-4-0":   [{ from: "2025-05-22", to: "2026-06-15", ...OPUS_LEGACY }],
  "claude-opus-4":     [{ from: "2025-05-22", to: "2026-06-15", ...OPUS_LEGACY }],
  "claude-sonnet-5":   [{ from: "2026-06-30", ...SONNET_5 }],
  "claude-sonnet-4-6": [{ from: "2026-02-17", ...SONNET }],
  "claude-sonnet-4-5": [{ from: "2025-09-29", ...SONNET }],
  "claude-sonnet-4-0": [{ from: "2025-05-22", to: "2026-06-15", ...SONNET }],
  "claude-sonnet-4":   [{ from: "2025-05-22", to: "2026-06-15", ...SONNET }],
  "claude-3-7-sonnet": [{ from: "2025-02-24", to: "2026-02-19", ...SONNET }],
  "claude-3-5-sonnet": [{ from: "2024-06-21", to: "2025-10-28", ...SONNET }],
  "claude-haiku-4-5":  [{ from: "2025-10-15", ...HAIKU_45 }],
  // Haiku 3.5 launched at $1 / $5 and was cut to $0.80 / $4 on 2024-12-03
  // (anthropic.com/news/3-5-models-and-computer-use, "Update (12/03/2024)").
  "claude-3-5-haiku": [
    { from: "2024-11-04", to: "2024-12-02", ...A(1, 5) },
    { from: "2024-12-03", to: "2026-02-19", ...A(0.8, 4) },
  ],
  "claude-3-opus":  [{ from: "2024-03-04", to: "2026-01-05", ...OPUS_LEGACY }],
  "claude-3-haiku": [{ from: "2024-03-04", to: "2026-04-20", ...A(0.25, 1.25) }],

  // ---- OpenAI (Codex CLI) -------------------------------------------------
  "gpt-6-astra": [{ from: "2026-09-03", ...G(10, 50, 1, 12.5) }],
  // GPT-5.6 Sol: launch price, then a 20% cut on 2026-08-21
  // (community.openai.com/t/20-price-reduction-for-gpt-5-6-sol-api-codex-credits-and-chatgpt-work/1391726).
  "gpt-5.6-sol": [
    { from: "2026-07-09", to: "2026-08-20", ...G(5, 30, 0.5, 6.25) },
    { from: "2026-08-21", ...G(4, 20, 0.4, 5) },
  ],
  "gpt-5.6": [
    { from: "2026-07-09", to: "2026-08-20", ...G(5, 30, 0.5, 6.25) },
    { from: "2026-08-21", ...G(4, 20, 0.4, 5) },
  ],
  // GPT-5.6 Luna: $1 / $6 at launch, $0.20 / $1.20 from 2026-07-30
  // (openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6).
  "gpt-5.6-luna": [
    { from: "2026-07-09", to: "2026-07-29", ...G(1, 6, 0.1, 1.25) },
    { from: "2026-07-30", ...G(0.2, 1.2, 0.02, 0.25) },
  ],
  "gpt-5.5":       [{ from: "2026-04-23", ...G(5, 30) }],
  "gpt-5.4":       [{ from: "2026-03-05", ...G(2.5, 15) }],
  "gpt-5.4-mini":  [{ from: "2026-03-17", ...G(0.75, 4.5) }],
  "gpt-5.3-codex": [{ from: "2026-02-05", ...G(1.75, 14) }],
  "gpt-5.2-codex": [{ from: "2026-01-14", ...G(1.75, 14) }],
  "gpt-5.2":       [{ from: "2025-12-11", ...G(1.75, 14) }],
  "gpt-5.1":       [{ from: "2025-11-13", ...G(1.25, 10) }],
  "gpt-5-codex":   [{ from: "2025-09-15", ...G(1.25, 10) }],
  "gpt-5":         [{ from: "2025-08-07", ...G(1.25, 10) }],
  // o3 was cut 80% on 2025-06-10 (pre-cut cached-input rate not printed on any
  // fetched page; 2.50 follows the 75% cached discount then in force).
  "o3": [
    { from: "2025-04-16", to: "2025-06-09", ...G(10, 40, 2.5) },
    { from: "2025-06-10", ...G(2, 8, 0.5) },
  ],
  "o3-pro":  [{ from: "2025-06-10", ...G(20, 80, 20) }],
  "o4-mini": [{ from: "2025-04-16", ...G(1.1, 4.4, 0.275) }],
  "o1":      [{ from: "2024-12-17", ...G(15, 60, 7.5) }],
  "o1-pro":  [{ from: "2025-03-19", ...G(150, 600, 150) }],
};

// Map a logged model id to a pricing key. Claude ids may carry a dated snapshot
// suffix or `-latest` (claude-opus-4-5-20251101 → claude-opus-4-5); Codex slugs
// may carry a reasoning-effort suffix (gpt-5.4-high → gpt-5.4).
export function pricingKey(modelId: string): string | null {
  if (PRICING[modelId]) return modelId;
  const undated = modelId.replace(/-(\d{8}|latest)$/, "");
  if (PRICING[undated]) return undated;
  const noEffort = modelId.replace(/-(minimal|low|medium|high|xhigh|max)$/, "");
  if (PRICING[noEffort]) return noEffort;
  return null;
}

/** Price in force on `date` (YYYY-MM-DD). Without a date, the current (or last) price. */
export function getPricing(modelId: string, date?: string): ModelPricing | null {
  const key = pricingKey(modelId);
  if (!key) return null;
  const periods = PRICING[key];
  if (date === undefined) {
    return periods.find((p) => p.to === undefined) ?? periods[periods.length - 1];
  }
  const hit = periods.find((p) => p.from <= date && (p.to === undefined || date <= p.to));
  if (hit) return hit;
  // Usage logged before the first listed price (pre-release / preview access):
  // use the launch price rather than silently dropping the cost. Usage after a
  // model's retirement has no price.
  const first = periods.reduce((a, b) => (a.from <= b.from ? a : b));
  return date < first.from ? first : null;
}

export function hasPricing(modelId: string, date?: string): boolean {
  return getPricing(modelId, date) !== null;
}

/** All pricing keys (for docs / tests). */
export function pricedModels(): string[] {
  return Object.keys(PRICING);
}

export interface TokenBreakdown {
  input: number;
  output: number;
  /** all cache-write tokens (5m + 1h) */
  cacheWrite: number;
  /** the 1h-TTL subset of cacheWrite (0 when the log has no TTL split) */
  cacheWrite1h: number;
  cacheRead: number;
}

export function estimateCost(model: string, tokens: TokenBreakdown, date?: string): number {
  const p = getPricing(model, date);
  if (!p) return 0;
  const write1h = Math.min(tokens.cacheWrite1h ?? 0, tokens.cacheWrite);
  const write5m = tokens.cacheWrite - write1h;
  return (
    (tokens.input * p.input +
      tokens.output * p.output +
      write5m * p.cacheWrite +
      write1h * p.cacheWrite1h +
      tokens.cacheRead * p.cacheRead) /
    1_000_000
  );
}
