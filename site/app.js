/* Hive Commons benchmarks — vanilla JS, no build step.
 * Loads data/index.json (pre-aggregated cells built by scripts/build-index.py),
 * applies filters, and renders leaderboards by model / harness / runtime plus
 * a per-hive contribution table. */
(() => {
  "use strict";

  const MIN_N = 10;            // below this a rate is "not reported" (outcomebench rule)
  const Z95 = 1.96;            // Wilson interval z for 95 %
  const DATA_PATHS = ["data/index.json", "../data/index.json"];

  const $ = (sel) => document.querySelector(sel);
  const fmtPct = (x) => (x * 100).toFixed(0) + "%";
  const fmtUsd = (x) => "$" + x.toFixed(2);
  const fmtInt = (x) => x.toLocaleString();

  function wilson(k, n) {
    if (n === 0) return null;
    const p = k / n, z2 = Z95 * Z95;
    const denom = 1 + z2 / n;
    const centre = p + z2 / (2 * n);
    const half = Z95 * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    return { rate: p, lo: (centre - half) / denom, hi: (centre + half) / denom, n };
  }

  async function load() {
    for (const p of DATA_PATHS) {
      try {
        const r = await fetch(p, { cache: "no-store" });
        if (r.ok) return r.json();
      } catch (_) { /* try next */ }
    }
    throw new Error("data/index.json not found — run scripts/build-index.sh");
  }

  // ---- aggregation over cells ------------------------------------------
  let WALL_BUCKETS_H = [];

  function emptyGroup(key) {
    return { key, n: 0, opened: 0, merged: 0, ci_n: 0, ci_green: 0, cost_n: 0, cost_usd: 0, cost_merged: 0,
      revert_n: 0, reverted: 0, interventions: 0, retries: 0, wall: new Array(WALL_BUCKETS_H.length + 1).fill(0) };
  }

  function aggregate(cells, keyFn) {
    const groups = new Map();
    for (const c of cells) {
      const key = keyFn(c);
      if (!key) continue;
      let g = groups.get(key);
      if (!g) { g = emptyGroup(key); groups.set(key, g); }
      for (const f of ["n", "opened", "merged", "ci_n", "ci_green", "cost_n", "cost_usd", "cost_merged", "revert_n", "reverted", "interventions", "retries"]) g[f] += c[f] || 0;
      (c.wall || []).forEach((v, i) => { g.wall[i] += v; });
    }
    return [...groups.values()].map((g) => ({
      ...g,
      mergeRate: wilson(g.merged, g.opened),
      ciRate: wilson(g.ci_green, g.ci_n),
      revertRate: wilson(g.reverted, g.revert_n),
      costPerMerged: g.cost_merged > 0 ? g.cost_usd / g.cost_merged : null,
      medianWallH: histMedian(g.wall),
    }));
  }

  // Median from the log-scale histogram: midpoint of the bucket holding the 50th percentile.
  function histMedian(hist) {
    const total = hist.reduce((a, b) => a + b, 0);
    if (!total) return NaN;
    let acc = 0;
    for (let i = 0; i < hist.length; i++) {
      acc += hist[i];
      if (acc * 2 >= total) {
        const lo = i === 0 ? 0 : WALL_BUCKETS_H[i - 1];
        const hi = i < WALL_BUCKETS_H.length ? WALL_BUCKETS_H[i] : WALL_BUCKETS_H[WALL_BUCKETS_H.length - 1] * 2;
        return (lo + hi) / 2;
      }
    }
    return NaN;
  }

  // ---- rendering --------------------------------------------------------
  function rateCell(w) {
    if (!w || w.n < MIN_N) return `<td class="num nr">not reported${w ? ` (n=${w.n})` : ""}</td>`;
    const width = Math.round(w.rate * 60);
    return `<td class="num"><span class="bar" style="width:${width}px"></span>${fmtPct(w.rate)} <span class="ci">[${fmtPct(w.lo)}–${fmtPct(w.hi)}] n=${w.n}</span></td>`;
  }
  function numCell(x, fmt) {
    return `<td class="num">${x == null || Number.isNaN(x) ? '<span class="nr">—</span>' : fmt(x)}</td>`;
  }

  const COLUMNS = [
    { id: "key", label: "", sort: (a, b) => a.key.localeCompare(b.key), cell: (g) => `<td>${escapeHtml(g.key)}</td>` },
    { id: "n", label: "records", num: true, sort: (a, b) => b.n - a.n, cell: (g) => `<td class="num">${fmtInt(g.n)}</td>` },
    { id: "merge", label: "merge rate", num: true, sort: (a, b) => (b.mergeRate?.rate ?? -1) - (a.mergeRate?.rate ?? -1), cell: (g) => rateCell(g.mergeRate) },
    { id: "ci", label: "CI green 1st try", num: true, sort: (a, b) => (b.ciRate?.rate ?? -1) - (a.ciRate?.rate ?? -1), cell: (g) => rateCell(g.ciRate) },
    { id: "cost", label: "cost / merged PR", num: true, sort: (a, b) => (a.costPerMerged ?? Infinity) - (b.costPerMerged ?? Infinity), cell: (g) => numCell(g.costPerMerged, fmtUsd) },
    { id: "wall", label: "median h to merge", num: true, sort: (a, b) => (a.medianWallH || Infinity) - (b.medianWallH || Infinity), cell: (g) => numCell(g.medianWallH, (x) => x < 10 ? x.toFixed(1) : x.toFixed(0)) },
    { id: "revert", label: "reverted ≤14d", num: true, sort: (a, b) => (a.revertRate?.rate ?? 2) - (b.revertRate?.rate ?? 2), cell: (g) => rateCell(g.revertRate) },
    { id: "hi", label: "human interventions / rec", num: true, sort: (a, b) => a.interventions / a.n - b.interventions / b.n, cell: (g) => `<td class="num">${(g.interventions / g.n).toFixed(2)}</td>` },
  ];

  const sortState = {};
  function renderTable(containerId, groups, firstLabel) {
    const el = document.getElementById(containerId);
    if (!groups.length) { el.innerHTML = '<p class="nr">no records match the current filters</p>'; return; }
    const sortId = sortState[containerId] || "n";
    const col = COLUMNS.find((c) => c.id === sortId);
    const rows = [...groups].sort(col.sort);
    el.innerHTML = `<table><thead><tr>${COLUMNS.map((c) => `<th data-col="${c.id}" class="${c.num ? "num" : ""} ${c.id === sortId ? "sorted" : ""}">${c.id === "key" ? firstLabel : c.label}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((g) => `<tr>${COLUMNS.map((c) => c.cell(g)).join("")}</tr>`).join("")}</tbody></table>`;
    el.querySelectorAll("th").forEach((th) => th.addEventListener("click", () => { sortState[containerId] = th.dataset.col; renderTable(containerId, groups, firstLabel); }));
  }

  function renderHives(hives) {
    const rows = hives.filter((h) => !h.synthetic);
    document.getElementById("by-hive").innerHTML = `<table><thead><tr><th>hive id</th><th>cluster</th><th>hive version</th><th>public orgs</th><th class="num">records</th><th class="num">attributed</th><th class="num">authored</th><th class="num">reviews</th><th>months</th></tr></thead>
      <tbody>${rows.map((h) => `<tr><td><code>${escapeHtml(h.hive_id)}</code></td><td>${escapeHtml(h.cluster || "")}</td><td>${escapeHtml(h.hive_version || "")}</td><td>${escapeHtml((h.orgs || []).join(", ")) || '<span class="nr">anonymized</span>'}</td><td class="num">${fmtInt(h.records)}</td><td class="num">${fmtInt(h.attributed)}</td><td class="num">${fmtInt(h.authored)}</td><td class="num">${fmtInt(h.reviews)}</td><td>${h.first}${h.first !== h.last ? " → " + h.last : ""}</td></tr>`).join("")}</tbody></table>`;
  }

  function renderStats(cells) {
    const t = aggregate(cells, () => "all")[0] || emptyGroup("all");
    const hives = new Set(cells.map((c) => c.hive_id)).size;
    const models = new Set(cells.map((c) => c.model)).size;
    $("#stats").innerHTML = [
      [fmtInt(t.n), "records in view"], [hives, "hives"], [models, "models"],
      [t.opened ? fmtPct(t.merged / t.opened) : "—", `merged (${fmtInt(t.merged)}/${fmtInt(t.opened)} PRs)`],
      [t.ci_n ? fmtPct(t.ci_green / t.ci_n) : "—", `CI green first try (n=${fmtInt(t.ci_n)})`],
      [t.cost_n ? fmtUsd(t.cost_usd) : "—", "estimated spend (where metered)"],
    ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  // ---- filters ----------------------------------------------------------
  function fillSelect(id, values) {
    const sel = document.getElementById(id);
    [...values].filter((v) => v !== "" && v != null).sort().forEach((v) => { const o = document.createElement("option"); o.value = o.textContent = v; sel.appendChild(o); });
  }
  function currentFilter() {
    return {
      role: $("#f-role").value, org: $("#f-org").value, kind: $("#f-kind").value, harness: $("#f-harness").value, runtime: $("#f-runtime").value,
      acmm: $("#f-acmm").value, since: $("#f-since").value, synthetic: $("#f-synthetic").checked,
    };
  }
  function applyFilter(cells, f) {
    return cells.filter((c) =>
      (f.synthetic || !c.synthetic) &&
      (!f.role || c.role === f.role) &&
      (!f.org || c.org === f.org) &&
      (!f.kind || c.kind === f.kind) &&
      (!f.harness || c.harness === f.harness) &&
      (!f.runtime || c.runtime === f.runtime) &&
      (!f.acmm || c.acmm === f.acmm) &&
      (!f.since || c.month >= f.since));
  }

  // ---- main -------------------------------------------------------------
  load().then((index) => {
    WALL_BUCKETS_H = index.wall_buckets_h || [];
    const cells = index.cells || [];
    const realCount = index.count - (index.synthetic_count || 0);
    const updated = index.latest_published_at || index.generated_at;
    $("#meta").textContent = `last updated ${updated ? new Date(updated).toUTCString() : "?"} · ${index.hive_count ?? "?"} hives · ${fmtInt(realCount)} records (attributed ${fmtInt(index.attributed_count || 0)} / anonymized ${fmtInt(index.anonymized_count || 0)}) · ${index.synthetic_count || 0} synthetic samples excluded · built from ${(index.source_commit || "local").slice(0, 7)}`;
    if (realCount === 0) {
      const b = $("#banner"); b.hidden = false;
      b.textContent = "Only synthetic sample records are published so far. Tick “Include synthetic” to see the layout.";
    }
    fillSelect("f-org", new Set(cells.map((c) => c.org)));
    fillSelect("f-kind", new Set(cells.map((c) => c.kind)));
    fillSelect("f-harness", new Set(cells.map((c) => c.harness)));
    fillSelect("f-runtime", new Set(cells.map((c) => c.runtime)));
    fillSelect("f-acmm", new Set(cells.map((c) => c.acmm)));
    renderHives(index.hives || []);

    const render = () => {
      const view = applyFilter(cells, currentFilter());
      renderStats(view);
      renderTable("by-model", aggregate(view, (c) => c.model && `${c.provider || "?"} / ${c.model}`), "model");
      renderTable("by-harness", aggregate(view, (c) => c.harness), "harness");
      renderTable("by-runtime", aggregate(view, (c) => c.runtime), "runtime");
    };
    document.getElementById("filters").addEventListener("input", render);
    render();
  }).catch((err) => {
    $("#meta").textContent = err.message;
  });
})();
