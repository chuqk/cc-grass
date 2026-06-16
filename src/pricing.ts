// USD per million tokens — source: https://docs.anthropic.com/en/docs/about-claude/pricing
export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const PRICING: Record<string, ModelPricing> = {
  "claude-fable-5":             { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  "claude-mythos-5":            { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  "claude-opus-4-8":            { input: 5,  output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-7":            { input: 5,  output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-6":            { input: 5,  output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-5-20251101":   { input: 5,  output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-5":            { input: 5,  output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-1-20250805":   { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4-1":            { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4-20250514":     { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4-0":            { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet-4-6":          { input: 3,  output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-5-20250929": { input: 3,  output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-5":          { input: 3,  output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-20250514":   { input: 3,  output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-0":          { input: 3,  output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5-20251001":  { input: 1,  output: 5,  cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-haiku-4-5":           { input: 1,  output: 5,  cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-3-5-haiku-20241022":  { input: 0.8, output: 4,  cacheWrite: 1,    cacheRead: 0.08 },
  "claude-3-7-sonnet-20250219": { input: 3,  output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-3-5-sonnet-20241022": { input: 3,  output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-3-5-sonnet-20240620": { input: 3,  output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-3-opus-20240229":     { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-3-sonnet-20240229":   { input: 3,  output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-3-haiku-20240307":    { input: 0.25, output: 1.25, cacheWrite: 0.3, cacheRead: 0.03 },
};

export function getPricing(modelId: string): ModelPricing | null {
  return PRICING[modelId] ?? null;
}

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export function estimateCost(model: string, tokens: TokenBreakdown): number {
  const p = getPricing(model);
  if (!p) return 0;
  return (
    (tokens.input * p.input +
      tokens.output * p.output +
      tokens.cacheWrite * p.cacheWrite +
      tokens.cacheRead * p.cacheRead) /
    1_000_000
  );
}
