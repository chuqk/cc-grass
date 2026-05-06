export type Level = 0 | 1 | 2 | 3 | 4;

export interface LevelThresholds {
  level1: number;
  level2: number;
  level3: number;
  level4: number;
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo]!;
  if (lo === hi) return a;
  const b = sorted[hi]!;
  const w = idx - lo;
  return a * (1 - w) + b * w;
}

export function computeThresholds(values: number[]): LevelThresholds {
  const nonZero = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (nonZero.length === 0) {
    return { level1: 1, level2: 2, level3: 3, level4: 4 };
  }
  const q1 = quantile(nonZero, 0.25);
  const q2 = quantile(nonZero, 0.5);
  const q3 = quantile(nonZero, 0.75);
  return {
    level1: 1,
    level2: Math.max(q1, 2),
    level3: Math.max(q2, 3),
    level4: Math.max(q3, 4),
  };
}

export function levelOf(value: number, t: LevelThresholds): Level {
  if (value <= 0) return 0;
  if (value >= t.level4) return 4;
  if (value >= t.level3) return 3;
  if (value >= t.level2) return 2;
  return 1;
}
