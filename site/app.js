/* Hive Commons benchmarks — vanilla JS, no build step.
 * Loads ../data/index.json (or data/index.json when served from the Pages root),
 * applies filters, and renders three leaderboards plus summary stats. */
(() => {
  "use strict";

  const MIN_N = 10;            // below this a rate is "not reported" (outcomebench rule)
  const Z95 = 1.96;            // Wilson interval z for 95 %
  const DATA_PATHS = ["data/index.json", "../data/index.json"];

  const $ = (sel) => document.querySelector(sel);
  const fmtPct = (x) => (x * 100).toFixed(0) + "%";
  const fmtUsd = (x) => "$" + x.toFixed(2);

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

  // ---- grouping ---------------------------------------------------------
  function aggregate(records, keyFn) {
    const groups = new Map();
    for (const r of records) {
      const key = keyFn(r);
      if (!key) continue;
      let g = groups.get(key);
      if (!g) { g = { key, n: 0, opened: 0, merged: 0, ciN: 0, ciGreen: 0, costUsd: 0, costMerged: 0, costN: 0, wall: [], interventions: 0, retries: 0, reverted: 0, revertN: 0 }; groups.set(key, g); }
      g.n++;
      const o = r.outcome || {};
      if (o.pr_opened) g.opened++;
      if (o.pr_merged) g.merged++;
      if (o.ci_green_first_try === true || o.ci_green_first_try === false) { g.ciN++; if (o.ci_green_first_try) g.ciGreen++; }
      if (r.cost && typeof r.cost.usd === "number") { g.costN++; g.costUsd += r.cost.usd; if (o.pr_merged) g.costMerged++; }
      if (typeof o.wall_clock_s === "number" && o.pr_merged) g.wall.push(o.wall_clock_s);
      g.interventions += o.human_interventions || 0;
      g.retries += o.retries || 0;
      const q = r.quality || {};
      if (q.reverted_within_14d === true || q.reverted_within_14d === false) { g.revertN++; if (q.reverted_within_14d) g.reverted++; }
    }
    return [...groups.values()].map((g) => ({
      ...g,
      mergeRate: wilson(g.merged, g.opened),
      ciRate: wilson(g.ciGreen, g.ciN),
      revertRate: wilson(g.reverted, g.revertN),
      costPerMerged: g.costMerged > 0 ? g.costUsd / g.costMerged : null,
      medianWallH: median(g.wall) / 3600,
    }));
  }

  function median(xs) {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
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
    { id: "n", label: "records", num: true, sort: (a, b) => b.n - a.n, cell: (g) => `<td class="num">${g.n}</td>` },
    { id: "merge", label: "merge rate", num: true, sort: (a, b) => (b.mergeRate?.rate ?? -1) - (a.mergeRate?.rate ?? -1), cell: (g) => rateCell(g.mergeRate) },
    { id: "ci", label: "CI green 1st try", num: true, sort: (a, b) => (b.ciRate?.rate ?? -1) - (a.ciRate?.rate ?? -1), cell: (g) => rateCell(g.ciRate) },
    { id: "cost", label: "cost / merged PR", num: true, sort: (a, b) => (a.costPerMerged ?? Infinity) - (b.costPerMerged ?? Infinity), cell: (g) => numCell(g.costPerMerged, fmtUsd) },
    { id: "wall", label: "median h to merge", num: true, sort: (a, b) => (a.medianWallH || Infinity) - (b.medianWallH || Infinity), cell: (g) => numCell(g.medianWallH, (x) => x.toFixed(1)) },
    { id: "revert", label: "reverted ≤14d", num: true, sort: (a, b) => (a.revertRate?.rate ?? 2) - (b.revertRate?.rate ?? 2), cell: (g) => rateCell(g.revertRate) },
    { id: "hi", label: "human interventions / rec", num: true, sort: (a, b) => a.interventions / a.n - b.interventions / b.n, cell: (g) => `<td class="num">${(g.interventions / g.n).toFixed(2)}</td>` },
  ];

  const sortState = {};
  function renderTable(containerId, groups, firstLabel) {
    const el = document.getElementById(containerId);
    if (!groups.length) { el.innerHTML = '<p class="nr">no records match the current filters</p>'; return; }
    const sortId = sortState[containerId] || "merge";
    const col = COLUMNS.find((c) => c.id === sortId);
    const rows = [...groups].sort(col.sort);
    el.innerHTML = `<table><thead><tr>${COLUMNS.map((c) => `<th data-col="${c.id}" class="${c.num ? "num" : ""} ${c.id === sortId ? "sorted" : ""}">${c.id === "key" ? firstLabel : c.label}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((g) => `<tr>${COLUMNS.map((c) => c.cell(g)).join("")}</tr>`).join("")}</tbody></table>`;
    el.querySelectorAll("th").forEach((th) => th.addEventListener("click", () => { sortState[containerId] = th.dataset.col; renderTable(containerId, groups, firstLabel); }));
  }

  function renderStats(records) {
    const merged = records.filter((r) => r.outcome?.pr_merged).length;
    const opened = records.filter((r) => r.outcome?.pr_opened).length;
    const usd = records.reduce((s, r) => s + (r.cost?.usd || 0), 0);
    const hives = new Set(records.map((r) => r.source?.hive_id || r.source?.hive_name).filter(Boolean)).size;
    const models = new Set(records.map((r) => r.model?.name).filter(Boolean)).size;
    $("#stats").innerHTML = [
      [records.length, "records"], [hives, "hives"], [models, "models"],
      [opened ? fmtPct(merged / opened) : "—", `merged (${merged}/${opened} PRs)`],
      [fmtUsd(usd), "estimated spend in view"],
    ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  // ---- filters ----------------------------------------------------------
  function fillSelect(id, values) {
    const sel = document.getElementById(id);
    [...values].filter(Boolean).sort().forEach((v) => { const o = document.createElement("option"); o.value = o.textContent = v; sel.appendChild(o); });
  }
  function currentFilter() {
    return {
      org: $("#f-org").value, kind: $("#f-kind").value, harness: $("#f-harness").value, runtime: $("#f-runtime").value,
      acmm: $("#f-acmm").value, since: $("#f-since").value, synthetic: $("#f-synthetic").checked,
    };
  }
  function applyFilter(records, f) {
    return records.filter((r) =>
      (f.synthetic || !r.synthetic) &&
      (!f.org || r.source?.org === f.org) &&
      (!f.kind || r.task?.kind === f.kind) &&
      (!f.harness || r.agent?.harness === f.harness) &&
      (!f.runtime || r.sandbox_runtime === f.runtime) &&
      (!f.acmm || String(r.task?.acmm_level ?? r.quality?.acmm_level ?? "") === f.acmm) &&
      (!f.since || r.published_at >= f.since));
  }

  // ---- main -------------------------------------------------------------
  load().then((index) => {
    const all = index.records || [];
    $("#meta").textContent = `${index.count ?? all.length} records (${index.synthetic_count ?? 0} synthetic) · generated ${index.generated_at ?? "?"} · commit ${index.source_commit ?? "?"}`;
    if (all.length && all.every((r) => r.synthetic)) {
      const b = $("#banner"); b.hidden = false;
      b.textContent = "Only synthetic sample records are published so far. Tick “Include synthetic” to see the layout. Real exports arrive via hive's /api/benchmarks/export (see issues).";
    }
    fillSelect("f-org", new Set(all.map((r) => r.source?.org)));
    fillSelect("f-kind", new Set(all.map((r) => r.task?.kind)));
    fillSelect("f-harness", new Set(all.map((r) => r.agent?.harness)));
    fillSelect("f-runtime", new Set(all.map((r) => r.sandbox_runtime)));
    fillSelect("f-acmm", new Set(all.map((r) => r.task?.acmm_level ?? r.quality?.acmm_level).map((x) => x == null ? "" : String(x))));

    const render = () => {
      const recs = applyFilter(all, currentFilter());
      renderStats(recs);
      renderTable("by-model", aggregate(recs, (r) => r.model?.name && `${r.model.provider || "?"} / ${r.model.name}`), "model");
      renderTable("by-harness", aggregate(recs, (r) => r.agent?.harness), "harness");
      renderTable("by-runtime", aggregate(recs, (r) => r.sandbox_runtime), "runtime");
    };
    document.getElementById("filters").addEventListener("input", render);
    render();
  }).catch((err) => {
    $("#meta").textContent = err.message;
  });
})();
