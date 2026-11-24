// Unit tests for the leaderboard statistics in site/app.js. No dependencies:
//   node --test site/app.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const app = require("./app.js");

const close = (actual, expected, eps = 1e-4) =>
  assert.ok(Math.abs(actual - expected) < eps, `expected ${actual} ≈ ${expected}`);

test("wilson: n=0 has no interval", () => {
  assert.equal(app.wilson(0, 0), null);
});

test("wilson: k=0 pins the lower bound at 0", () => {
  const w = app.wilson(0, 10);
  assert.equal(w.rate, 0);
  assert.equal(w.n, 10);
  close(w.lo, 0, 1e-12);
  close(w.hi, 0.27754);   // z²/(n+z²)
});

test("wilson: k=n pins the upper bound at 1", () => {
  const w = app.wilson(10, 10);
  assert.equal(w.rate, 1);
  close(w.lo, 0.72246);   // n/(n+z²)
  close(w.hi, 1, 1e-12);
});

test("wilson: interior point matches the textbook 95% interval", () => {
  const w = app.wilson(5, 10);
  close(w.rate, 0.5);
  close(w.lo, 0.23659);
  close(w.hi, 0.76341);
});

test("histMedian: midpoint of the bucket holding the 50th percentile", () => {
  app.setWallBuckets([1, 4, 24]);
  assert.equal(app.histMedian([0, 3, 1, 0]), 2.5);   // bucket (1, 4]
  assert.equal(app.histMedian([2, 2, 0, 0]), 0.5);   // exactly half in bucket [0, 1]
  assert.equal(app.histMedian([0, 0, 0, 5]), 36);    // overflow bucket (24, 48]
  assert.ok(Number.isNaN(app.histMedian([0, 0, 0, 0])));
});

test("aggregate: sums mixed cells per key and derives rates", () => {
  app.setWallBuckets([1, 4]);
  const cells = [
    { harness: "claude", model: "claude-sonnet-5-5", provider: "anthropic", n: 6, opened: 6, merged: 4, ci_n: 5, ci_green: 3,
      cost_n: 6, cost_usd: 12, cost_merged: 4, cost_merged_usd: 8,
      cost_basis_n: { tokens_x_pricing: 4, fleet_model_median: 2 }, interventions: 1, wall: [1, 2, 1] },
    // Sparse cell: missing counters, cost basis and histogram count as zero.
    { harness: "claude", n: 4, opened: 4, merged: 1 },
    { harness: "codex", n: 2, opened: 0 },
    { harness: "", n: 99 },   // falsy key: dropped
  ];
  const groups = app.aggregate(cells, (c) => c.harness);
  assert.deepEqual(groups.map((g) => g.key), ["claude", "codex"]);
  const [claude, codex] = groups;

  assert.equal(claude.n, 10);
  assert.equal(claude.opened, 10);
  assert.equal(claude.merged, 5);
  assert.equal(claude.mergeRate.rate, 0.5);
  assert.equal(claude.mergeRate.n, 10);
  assert.equal(claude.ciRate.rate, 0.6);
  assert.equal(claude.costPerMerged, 2);
  assert.equal(claude.costPerRecord, 2);
  assert.deepEqual(claude.cost_basis_n, { reported: 0, tokens_x_pricing: 4, fleet_model_median: 2, unknown: 0 });
  assert.equal(claude.attributedShare, 0.4);
  assert.deepEqual(claude.wall, [1, 2, 1]);
  assert.equal(claude.medianWallH, 2.5);
  assert.deepEqual([...claude.variants], [["anthropic / claude-sonnet-5-5 · Claude Code", 6]]);

  // No opened PRs, no cost, no CI data: no rate rather than 0 %.
  assert.equal(codex.mergeRate, null);
  assert.equal(codex.ciRate, null);
  assert.equal(codex.costPerMerged, null);
  assert.equal(codex.attributedShare, 0);
  assert.ok(Number.isNaN(codex.medianWallH));
});

test("rateCell: rates need n >= 10 (MIN_N)", () => {
  assert.equal(app.MIN_N, 10);
  assert.match(app.rateCell(null), /insufficient data<\/td>/);
  assert.match(app.rateCell(app.wilson(9, 9)), /insufficient data \(n=9\)/);
  const shown = app.rateCell(app.wilson(5, 10));
  assert.doesNotMatch(shown, /insufficient/);
  assert.match(shown, /50% <span class="ci">\[24%–76%\] n=10<\/span>/);
});

test("costCell: cost per merged PR needs >= 30 merged PRs with cost (MIN_N_COST)", () => {
  assert.equal(app.MIN_N_COST, 30);
  const group = (merged) => ({ n: 40, cost_n: 20, cost_merged: merged, costPerMerged: 1.5,
    cost_basis_n: { reported: 0, tokens_x_pricing: 10, fleet_model_median: 10, unknown: 0 } });
  assert.match(app.costCell({ costPerMerged: null }), /—/);
  assert.match(app.costCell(group(29)), /insufficient data <span class="ci">\(n=29, 50% cost coverage\)/);
  const shown = app.costCell(group(30));
  assert.doesNotMatch(shown, /insufficient/);
  assert.match(shown, /\$1\.50 <span class="ci">25% attr\. · 50% cost coverage<\/span>/);
});

test("applyFilter: synthetic, field and month filters", () => {
  const cells = [
    { id: 1, role: "author", org: "a", kind: "fix", harness: "claude", runtime: "none", acmm: "3", month: "2026-09" },
    { id: 2, role: "reviewer", org: "a", kind: "fix", harness: "codex", runtime: "none", acmm: "4", month: "2026-10" },
    { id: 3, role: "author", org: "b", kind: "docs", harness: "claude", runtime: "kata", acmm: "3", month: "2026-11", synthetic: true },
  ];
  const ids = (f) => app.applyFilter(cells, f).map((c) => c.id);
  assert.deepEqual(ids({}), [1, 2]);                        // synthetic excluded by default
  assert.deepEqual(ids({ synthetic: true }), [1, 2, 3]);
  assert.deepEqual(ids({ role: "author", synthetic: true }), [1, 3]);
  assert.deepEqual(ids({ role: "" }), [1, 2]);              // "" = both roles
  assert.deepEqual(ids({ harness: "claude", acmm: "3" }), [1]);
  assert.deepEqual(ids({ org: "b", synthetic: true }), [3]);
  assert.deepEqual(ids({ kind: "fix", runtime: "none" }), [1, 2]);
  assert.deepEqual(ids({ since: "2026-10", synthetic: true }), [2, 3]);   // inclusive lower bound
});
