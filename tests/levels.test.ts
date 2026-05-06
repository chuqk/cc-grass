import { test } from "node:test";
import assert from "node:assert/strict";
import { computeThresholds, levelOf } from "../src/levels.js";

test("levels: empty values give safe default thresholds", () => {
  const t = computeThresholds([]);
  assert.equal(levelOf(0, t), 0);
  assert.equal(levelOf(100, t), 4);
});

test("levels: uniform distribution buckets correctly", () => {
  const values = [0, 0, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const t = computeThresholds(values);
  assert.equal(levelOf(0, t), 0);
  assert.equal(levelOf(10, t), 1);
  assert.ok(levelOf(100, t) === 4);
  assert.ok(levelOf(60, t) >= 2);
});

test("levels: zero is always level 0", () => {
  const t = computeThresholds([1, 2, 3, 4, 5]);
  assert.equal(levelOf(0, t), 0);
  assert.equal(levelOf(-5, t), 0);
});

test("levels: smallest non-zero is at least level 1", () => {
  const t = computeThresholds([100, 200, 300, 400, 500]);
  assert.ok(levelOf(1, t) >= 1);
});
