#!/usr/bin/env node
// Operational helper: the CLI remains offline and has no runtime dependencies.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultCacheDir } from "../dist/cache.js";
import { parseClaudeProjects } from "../dist/parse.js";
import { getPricing, normalizePricingId, readPricingFile } from "../dist/pricing.js";
import { defaultSinceFor } from "../dist/svg.js";

export const SOURCES = {
  anthropic: "https://platform.claude.com/docs/en/about-claude/pricing.md",
  openai: "https://developers.openai.com/api/docs/pricing.md",
};
const PRICE_FIELDS = ["input", "output", "cacheWrite", "cacheWrite1h", "cacheRead"];
const DAY = 86_400_000;
const HOUR = 3_600_000;

function tableRows(section) {
  const lines = section.split("\n");
  const start = lines.findIndex((line) => /^\|\s*Model\s*\|/i.test(line));
  if (start < 0) throw new Error("Official pricing table header was not found");
  const cells = (line) => line.trim().slice(1, -1).split("|").map((s) => s.trim());
  const header = cells(lines[start]);
  if (!/^\|[\s:|-]+\|$/.test(lines[start + 1] ?? "")) throw new Error("Official table separator changed");
  const rows = [];
  for (let i = start + 2; i < lines.length && lines[i].trim().startsWith("|"); i++) {
    const row = cells(lines[i]);
    if (row.length !== header.length) throw new Error("Official pricing table column count changed");
    rows.push(row);
  }
  if (!rows.length) throw new Error("Official pricing table is empty");
  return { header, rows };
}

function amount(cell, allowFree = false) {
  if (allowFree && /^[-—]$/.test(cell)) return 0;
  const match = /^\$([\d]+(?:\.\d+)?)(?:\s*\/\s*MTok)?(?:<sup>\d+<\/sup>)?$/.exec(cell);
  if (!match) throw new Error(`Unrecognized USD token price: ${cell}`);
  return Number(match[1]);
}

export function parseOfficialPrices(vendor, markdown) {
  const prices = new Map();
  if (vendor === "anthropic") {
    const section = markdown.split("## Model pricing\n")[1]?.split(/^## /m)[0];
    if (!section) throw new Error("Claude model pricing section changed");
    const { header, rows } = tableRows(section);
    if (header.join("|") !== "Model|Base input tokens|5m cache writes|1h cache writes|Cache hits and refreshes|Output tokens") {
      throw new Error("Claude standard pricing columns changed");
    }
    for (const row of rows) {
      const match = /^Claude (Fable|Mythos|Opus|Sonnet|Haiku) (\d+(?:\.\d+)*)(?:\s|$)/.exec(row[0]);
      if (!match) continue;
      const name = match[2].startsWith("3.")
        ? `claude-${match[2].replaceAll(".", "-")}-${match[1].toLowerCase()}`
        : `claude-${match[1].toLowerCase()}-${match[2].replaceAll(".", "-")}`;
      prices.set(name, {
        input: amount(row[1]), cacheWrite: amount(row[2]), cacheWrite1h: amount(row[3]),
        cacheRead: amount(row[4]), output: amount(row[5]), source: SOURCES.anthropic,
      });
    }
  } else if (vendor === "openai") {
    // Limit extraction to Standard. Later tables repeat IDs at Batch/Flex/Fast rates.
    const section = markdown.split("### Standard pricing data\n")[1]?.split("### Batch pricing data")[0];
    if (!section) throw new Error("OpenAI standard pricing section changed");
    const { header, rows } = tableRows(section);
    if (header.slice(0, 5).join("|") !== "Model|Short context input|Short context cached input|Short context cache writes|Short context output") {
      throw new Error("OpenAI standard short-context columns changed");
    }
    for (const row of rows) {
      const name = /^(gpt-[a-z0-9.-]+|o\d[a-z0-9.-]*)(?:\s|$)/.exec(row[0])?.[1];
      // Models without a published cached-input rate cannot price cached tokens.
      if (!name || /^[-—]$/.test(row[2])) continue;
      const cacheWrite = amount(row[3], true);
      prices.set(name, {
        input: amount(row[1]), cacheRead: amount(row[2]), cacheWrite, cacheWrite1h: cacheWrite,
        output: amount(row[4]), source: SOURCES.openai,
      });
    }
  } else {
    throw new Error(`Unknown pricing vendor: ${vendor}`);
  }
  if (!prices.size) throw new Error(`${vendor}: no standard model prices parsed`);
  return prices;
}

/** Add newly observed models. A changed existing price needs an effective date. */
export function reconcilePrices(state, prices, observedModels, date) {
  const next = structuredClone(state);
  next.models ??= {};
  next.unresolved = [];
  next.priceChanges = (next.priceChanges ?? []).filter((change) => !prices.has(change.model));
  const added = [];
  for (const raw of observedModels) {
    const model = normalizePricingId(raw);
    // A retired model is still registered. Never replace its historical periods
    // with a current table row that may describe partner-cloud availability.
    const known = getPricing(raw, undefined, next.models);
    const official = prices.get(model);
    if (!known && !official) {
      next.unresolved.push({ model, reason: "No published standard price in official tables" });
    } else if (!known && official) {
      // 'from' is the observation date, not a guessed launch or price-change date.
      // The existing pre-release fallback uses this first verified rate for previews.
      if (next.models[model]) {
        next.unresolved.push({ model, reason: "Price period ended; effective date needs verification" });
      } else {
        next.models[model] = [{ from: date, ...official }];
        added.push(model);
      }
    } else if (known && official && PRICE_FIELDS.some((key) => known[key] !== official[key])) {
      // A current table alone does not establish when a change took effect.
      // Keep all history unchanged and record the candidate for maintenance.
      next.priceChanges.push({ model, observedOn: date, current: known, candidate: official });
    }
  }
  next.observedModels = [...observedModels].sort();
  return { state: next, added };
}

export async function refreshPrices(state, observedModels, { now = new Date(), fetchPage = fetch, force = false } = {}) {
  const timestamp = now.getTime();
  const lastAttempt = Date.parse(state.attemptedAt ?? "");
  const lastSuccess = Date.parse(state.checkedAt ?? "");
  const newModel = observedModels.some((id) => !state.observedModels?.includes(id));
  if (!force && !newModel && (
    (Number.isFinite(lastAttempt) && timestamp - lastAttempt < HOUR) ||
    (!state.errors?.length && Number.isFinite(lastSuccess) && timestamp - lastSuccess < DAY)
  )) return { state, added: [], skipped: true };

  const responses = await Promise.allSettled(Object.entries(SOURCES).map(async ([vendor, url]) => {
    const response = await fetchPage(url, { signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (!response.ok) throw new Error(`${vendor}: HTTP ${response.status}`);
    const body = await response.text();
    if (body.length > 5_000_000) throw new Error(`${vendor}: oversized pricing document`);
    return parseOfficialPrices(vendor, body);
  }));
  const prices = new Map();
  const errors = [];
  responses.forEach((result, i) => {
    if (result.status === "fulfilled") result.value.forEach((value, key) => prices.set(key, value));
    else errors.push(`${Object.keys(SOURCES)[i]}: ${result.reason.message}`);
  });
  const merged = reconcilePrices(state, prices, observedModels, now.toISOString().slice(0, 10));
  merged.state.version = 1;
  merged.state.attemptedAt = now.toISOString();
  merged.state.errors = errors;
  if (!errors.length) merged.state.checkedAt = now.toISOString();
  return merged;
}

async function main() {
  const file = resolve(process.argv[2] ?? join(defaultCacheDir(), "pricing.json"));
  let state = { version: 1, models: {} };
  try {
    state = JSON.parse(await readFile(file, "utf8"));
    readPricingFile(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error; // Do not overwrite a corrupt catalog.
  }
  const until = new Date();
  until.setHours(23, 59, 59, 999); // Match CLI day boundaries so incremental caches stay enabled.
  const result = await parseClaudeProjects({ since: defaultSinceFor(until), until });
  const observed = [...new Set([...result.buckets.values()].flatMap((b) => [...b.modelTokens.keys()]))].sort();
  const refreshed = await refreshPrices(state, observed);
  if (!refreshed.skipped) {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(refreshed.state, null, 2) + "\n", "utf8");
    readPricingFile(temporary);
    await rename(temporary, file);
    console.error(`Pricing sync: ${refreshed.added.length} models added; ${refreshed.state.unresolved.length} unresolved; ${refreshed.state.priceChanges.length} changes need effective dates`);
    for (const error of refreshed.state.errors) console.error(`Pricing sync: ${error}; keeping last verified rates`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`Pricing sync: ${error.message}`); process.exitCode = 1; });
}
