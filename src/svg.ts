import type { DailyBucket, ParseTotals } from "./parse.js";
import { computeThresholds, levelOf, type Level } from "./levels.js";

export type Metric = "tokens" | "prompts" | "sessions";
export type Theme = "dark" | "light";

export interface RenderOptions {
  buckets: Map<string, DailyBucket>;
  metric: Metric;
  since: Date;
  until: Date;
  theme?: Theme;
  header?: string;
  total: ParseTotals;
}

const CELL = 10;
const GAP = 3;
const STRIDE = CELL + GAP;
const LEFT_PAD = 28;
const TOP_PAD = 22;
const HEADER_HEIGHT = 32;
const FOOTER_HEIGHT = 30;
const BORDER_PAD = 16;
const OUTER_PAD = 8;
const FONT =
  '-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif';

interface ThemeColors {
  bg: string;
  border: string;
  text: string;
  textStrong: string;
  cellStroke: string;
  palette: [string, string, string, string, string];
}

const THEMES: Record<Theme, ThemeColors> = {
  dark: {
    bg: "#0d1117",
    border: "#30363d",
    text: "#7d8590",
    textStrong: "#c9d1d9",
    cellStroke: "rgba(255,255,255,0.05)",
    palette: ["#161b22", "#4a1d05", "#913a05", "#d96a14", "#ff9c47"],
  },
  light: {
    bg: "#ffffff",
    border: "#d0d7de",
    text: "#57606a",
    textStrong: "#1f2328",
    cellStroke: "rgba(27,31,36,0.06)",
    palette: ["#ebedf0", "#ffd9b3", "#ffb066", "#ff8c2a", "#d96a14"],
  },
};

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const MONTH_FULL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ordinalSuffix(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&apos;";
      default:
        return c;
    }
  });
}

export function formatMetricValue(n: number, metric: Metric): string {
  if (metric !== "tokens") return n.toLocaleString("en-US");
  if (n < 1000) return String(n);
  const trim = (v: string) => v.replace(/\.0$/, "");
  if (n < 1_000_000) return `${trim((n / 1_000).toFixed(1))}k`;
  if (n < 1_000_000_000) return `${trim((n / 1_000_000).toFixed(1))}m`;
  return `${trim((n / 1_000_000_000).toFixed(1))}b`;
}

function metricLabel(metric: Metric): string {
  return metric;
}

function formatTooltip(date: Date, value: number, metric: Metric): string {
  const m = MONTH_FULL[date.getMonth()]!;
  const d = date.getDate();
  const ord = ordinalSuffix(d);
  if (value === 0) {
    return `No ${metricLabel(metric)} on ${m} ${d}${ord}.`;
  }
  const formatted = formatMetricValue(value, metric);
  return `${formatted} ${metricLabel(metric)} on ${m} ${d}${ord}.`;
}

function valueOfBucket(b: DailyBucket | undefined, metric: Metric): number {
  if (!b) return 0;
  if (metric === "tokens") return b.tokens;
  if (metric === "prompts") return b.prompts;
  return b.sessionIds.size > 0 ? 1 : 0;
}

export function renderSvg(opts: RenderOptions): string {
  const theme = THEMES[opts.theme ?? "dark"];
  const metric = opts.metric;

  const sinceDay = startOfDay(opts.since);
  const untilDay = startOfDay(opts.until);

  const gridStart = addDays(sinceDay, -sinceDay.getDay());
  const gridEnd = addDays(untilDay, 6 - untilDay.getDay());

  const totalDays = Math.round((gridEnd.getTime() - gridStart.getTime()) / 86_400_000) + 1;
  const weekCount = Math.ceil(totalDays / 7);

  const gridLeft = OUTER_PAD + BORDER_PAD + LEFT_PAD;
  const gridTop = OUTER_PAD + HEADER_HEIGHT + BORDER_PAD + TOP_PAD;
  const gridWidth = weekCount * STRIDE - GAP;
  const gridHeight = 7 * STRIDE - GAP;
  const gridRight = gridLeft + gridWidth;
  const gridBottom = gridTop + gridHeight;

  const totalWidth = gridRight + BORDER_PAD + OUTER_PAD;
  const totalHeight = gridBottom + FOOTER_HEIGHT + BORDER_PAD + OUTER_PAD;

  const borderX = OUTER_PAD;
  const borderY = OUTER_PAD + HEADER_HEIGHT;
  const borderW = totalWidth - 2 * OUTER_PAD;
  const borderH = totalHeight - HEADER_HEIGHT - 2 * OUTER_PAD;

  const totalForMetric =
    metric === "tokens"
      ? opts.total.tokens
      : metric === "prompts"
        ? opts.total.prompts
        : opts.total.sessions;
  const headerText =
    opts.header ??
    `${formatMetricValue(totalForMetric, metric)} ${metricLabel(metric)} in the last year`;

  const valuesInRange: number[] = [];
  for (const [date, b] of opts.buckets) {
    if (date < dateKey(sinceDay) || date > dateKey(untilDay)) continue;
    const v = valueOfBucket(b, metric);
    if (v > 0) valuesInRange.push(v);
  }
  const thresholds = computeThresholds(valuesInRange);

  const cellsXml: string[] = [];
  const colMonths = new Map<number, number>();

  let cur = new Date(gridStart);
  let col = 0;
  const sinceTime = sinceDay.getTime();
  const untilTime = untilDay.getTime();

  while (cur.getTime() <= gridEnd.getTime()) {
    const dow = cur.getDay();
    const t = cur.getTime();
    const inRange = t >= sinceTime && t <= untilTime;

    if (inRange) {
      const dateStr = dateKey(cur);
      const value = valueOfBucket(opts.buckets.get(dateStr), metric);
      const level: Level = levelOf(value, thresholds);
      const x = gridLeft + col * STRIDE;
      const y = gridTop + dow * STRIDE;
      const fill = theme.palette[level];
      const tooltip = formatTooltip(cur, value, metric);
      cellsXml.push(
        `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" ry="2" fill="${fill}" stroke="${theme.cellStroke}" data-date="${dateStr}" data-value="${value}" data-level="${level}"><title>${escapeXml(tooltip)}</title></rect>`,
      );
      if (!colMonths.has(col)) {
        colMonths.set(col, cur.getMonth());
      }
    }

    cur = addDays(cur, 1);
    if (cur.getDay() === 0) col++;
  }

  const monthLabels: { x: number; label: string }[] = [];
  let lastMonthLabeled = -1;
  for (const c of [...colMonths.keys()].sort((a, b) => a - b)) {
    const m = colMonths.get(c)!;
    if (m !== lastMonthLabeled) {
      monthLabels.push({ x: gridLeft + c * STRIDE, label: MONTH_NAMES[m]! });
      lastMonthLabeled = m;
    }
  }

  const monthXml = monthLabels
    .map(
      (l) =>
        `<text x="${l.x}" y="${gridTop - 8}" fill="${theme.text}" font-size="12">${l.label}</text>`,
    )
    .join("");

  const dowLabels: { row: number; label: string }[] = [
    { row: 1, label: "Mon" },
    { row: 3, label: "Wed" },
    { row: 5, label: "Fri" },
  ];
  const dowXml = dowLabels
    .map(
      (l) =>
        `<text x="${gridLeft - 6}" y="${gridTop + l.row * STRIDE + CELL - 1}" fill="${theme.text}" font-size="12" text-anchor="end">${l.label}</text>`,
    )
    .join("");

  const headerXml = `<text x="${OUTER_PAD}" y="${OUTER_PAD + 18}" fill="${theme.textStrong}" font-size="14" font-weight="400">${escapeXml(headerText)}</text>`;

  const legendY = gridBottom + 16;
  const legendRightX = borderX + borderW - BORDER_PAD;
  const moreTextWidth = 32;
  const cellsCount = theme.palette.length;
  const cellsWidth = cellsCount * STRIDE - GAP;
  const legendCellsRight = legendRightX - moreTextWidth;
  const legendCellsLeft = legendCellsRight - cellsWidth;
  const lessTextX = legendCellsLeft - 6;
  const legendCells = theme.palette
    .map((color, i) => {
      const cx = legendCellsLeft + i * STRIDE;
      return `<rect x="${cx}" y="${legendY - 9}" width="${CELL}" height="${CELL}" rx="2" ry="2" fill="${color}" stroke="${theme.cellStroke}"/>`;
    })
    .join("");
  const legendXml = `
    <text x="${lessTextX}" y="${legendY}" fill="${theme.text}" font-size="12" text-anchor="end">Less</text>
    ${legendCells}
    <text x="${legendRightX}" y="${legendY}" fill="${theme.text}" font-size="12" text-anchor="end">More</text>
  `;

  const learnX = OUTER_PAD + BORDER_PAD;
  const learnXml = `<text x="${learnX}" y="${legendY}" fill="${theme.text}" font-size="12">Generated by cc-grass</text>`;

  const borderXml = `<rect x="${borderX}" y="${borderY}" width="${borderW}" height="${borderH}" rx="6" ry="6" fill="${theme.bg}" stroke="${theme.border}"/>`;

  const bgXml = `<rect width="${totalWidth}" height="${totalHeight}" fill="${theme.bg}"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}" font-family='${FONT}'>
${bgXml}
${borderXml}
${headerXml}
${monthXml}
${dowXml}
${cellsXml.join("\n")}
${legendXml}
${learnXml}
</svg>`;
}
