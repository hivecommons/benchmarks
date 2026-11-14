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
  const BASES = ["reported", "tokens_x_pricing", "fleet_model_median", "unknown"];
  const COST_TIP = "Estimate, not a bill. tokens_x_pricing = hive's per-kick token counts × list prices (schema/pricing.json), attributed to the PR via kick refs; fleet_model_median = no attribution for this PR, median of attributed PRs for the same model & role (or median token mix × this model's price). See Methodology → Cost basis.";
  const EST = `<abbr class="est" title="${COST_TIP}">est.</abbr>`;
  const fmtInt = (x) => x.toLocaleString();
  const SPLIT_KEY = "benchmarks.split";   // localStorage key for the split-by-runtime toggle
  const SPLIT_PARAM = "split";            // ?split=runtime
  // Harness ids as hive reports them → the CLI/runtime people know them by.
  const HARNESS_LABELS = { copilot: "Copilot CLI", claude: "Claude Code", codex: "Codex CLI", gemini: "Gemini CLI", bob: "Bob",
    goose: "Goose", pi: "pi", omp: "omp", agy: "agy", aider: "Aider", cline: "Cline", kilo: "Kilo", muse: "Muse", omnigent: "Omnigent",
    opencode: "OpenCode", openhands: "OpenHands", clanker: "Clanker", other: "other" };
  const harnessLabel = (h) => HARNESS_LABELS[h] || h || "?";
  // Display name of a canonical model: "vendor / id"; a runtime auto-select has no vendor.
  const modelLabel = (c) => c.canonical === "auto" ? "runtime auto-select" : `${c.vendor || "?"} / ${c.canonical}`;

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
    return { key, variants: new Map(), n: 0, opened: 0, merged: 0, ci_n: 0, ci_green: 0, cost_n: 0, cost_usd: 0, cost_merged: 0, cost_merged_usd: 0,
      cost_basis_n: Object.fromEntries(BASES.map((b) => [b, 0])), revert_n: 0, reverted: 0, interventions: 0, retries: 0, wall: new Array(WALL_BUCKETS_H.length + 1).fill(0) };
  }

  function aggregate(cells, keyFn) {
    const groups = new Map();
    for (const c of cells) {
      const key = keyFn(c);
      if (!key) continue;
      let g = groups.get(key);
      if (!g) { g = emptyGroup(key); groups.set(key, g); }
      for (const f of ["n", "opened", "merged", "ci_n", "ci_green", "cost_n", "cost_usd", "cost_merged", "cost_merged_usd", "revert_n", "reverted", "interventions", "retries"]) g[f] += c[f] || 0;
      for (const b of BASES) g.cost_basis_n[b] += (c.cost_basis_n || {})[b] || 0;
      (c.wall || []).forEach((v, i) => { g.wall[i] += v; });
      if (c.model) {
        const vk = `${c.provider || "?"} / ${c.model}${c.effort ? " (" + c.effort + ")" : ""} · ${harnessLabel(c.harness)}`;
        g.variants.set(vk, (g.variants.get(vk) || 0) + (c.n || 0));
      }
    }
    return [...groups.values()].map((g) => ({
      ...g,
      mergeRate: wilson(g.merged, g.opened),
      ciRate: wilson(g.ci_green, g.ci_n),
      revertRate: wilson(g.reverted, g.revert_n),
      costPerMerged: g.cost_merged > 0 ? g.cost_merged_usd / g.cost_merged : null,
      costPerRecord: g.cost_n > 0 ? g.cost_usd / g.cost_n : null,
      attributedShare: g.cost_n > 0 ? (g.cost_basis_n.reported + g.cost_basis_n.tokens_x_pricing) / g.n : 0,
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
  // Cost per merged PR with the attribution mix: how many of the group's records
  // carry a PR-attributed cost vs a fleet-median imputation.
  function costCell(g) {
    if (g.costPerMerged == null) return '<td class="num nr">—</td>';
    const attr = g.cost_basis_n.reported + g.cost_basis_n.tokens_x_pricing;
    const tip = `${fmtInt(g.cost_merged)} merged PRs with cost; basis: ${attr} attributed, ${g.cost_basis_n.fleet_model_median} fleet-median, ${g.cost_basis_n.unknown} unknown`;
    return `<td class="num" title="${tip}">${fmtUsd(g.costPerMerged)} <span class="ci">${fmtPct(attr / g.n)} attr.</span></td>`;
  }
  function numCell(x, fmt) {
    return `<td class="num">${x == null || Number.isNaN(x) ? '<span class="nr">—</span>' : fmt(x)}</td>`;
  }

  const COLUMNS = [
    { id: "key", label: "", sort: (a, b) => a.key.localeCompare(b.key), cell: (g) => keyCell(g) },
    { id: "n", label: "records", num: true, sort: (a, b) => b.n - a.n, cell: (g) => `<td class="num">${fmtInt(g.n)}</td>` },
    { id: "merge", label: "merge rate", num: true, sort: (a, b) => (b.mergeRate?.rate ?? -1) - (a.mergeRate?.rate ?? -1), cell: (g) => rateCell(g.mergeRate) },
    { id: "ci", label: "CI green 1st try", num: true, sort: (a, b) => (b.ciRate?.rate ?? -1) - (a.ciRate?.rate ?? -1), cell: (g) => rateCell(g.ciRate) },
    { id: "cost", label: `${EST} cost / merged PR`, num: true, sort: (a, b) => (a.costPerMerged ?? Infinity) - (b.costPerMerged ?? Infinity), cell: (g) => costCell(g) },
    { id: "wall", label: "median h to merge", num: true, sort: (a, b) => (a.medianWallH || Infinity) - (b.medianWallH || Infinity), cell: (g) => numCell(g.medianWallH, (x) => x < 10 ? x.toFixed(1) : x.toFixed(0)) },
    { id: "revert", label: "reverted ≤14d", num: true, sort: (a, b) => (a.revertRate?.rate ?? 2) - (b.revertRate?.rate ?? 2), cell: (g) => rateCell(g.revertRate) },
    { id: "hi", label: "human interventions / rec", num: true, sort: (a, b) => a.interventions / a.n - b.interventions / b.n, cell: (g) => `<td class="num">${(g.interventions / g.n).toFixed(2)}</td>` },
  ];

  // "reported as" tooltip: every raw id the harnesses reported for this group, with counts.
  function variantsTip(g) {
    if (!g.variants || !g.variants.size) return "";
    const rows = [...g.variants.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${fmtInt(n)}`);
    return escapeHtml(`reported as\n${rows.join("\n")}`);
  }
  function keyCell(g) {
    const tip = variantsTip(g);
    const label = g.label != null ? g.label : g.key;
    if (g.sub) return `<td class="sub"${tip ? ` title="${tip}"` : ""}><span class="via">· ${escapeHtml(label)}</span></td>`;
    return `<td${tip ? ` title="${tip}"` : ""}>${escapeHtml(label)}${g.children ? ` <span class="ci">${g.children.length} runtimes</span>` : ""}</td>`;
  }

  const sortState = {};
  function renderTable(containerId, groups, firstLabel) {
    const el = document.getElementById(containerId);
    if (!groups.length) { el.innerHTML = '<p class="nr">no records match the current filters</p>'; return; }
    const sortId = sortState[containerId] || "n";
    const col = COLUMNS.find((c) => c.id === sortId);
    const rows = [...groups].sort(col.sort);
    const tr = (g) => `<tr${g.sub ? ' class="sub"' : g.children ? ' class="group"' : ""}>${COLUMNS.map((c) => c.cell(g)).join("")}</tr>`;
    // A group row (model) is followed by its children (model × runtime), each sorted by the same column.
    const body = rows.map((g) => tr(g) + (g.children ? [...g.children].sort(col.sort).map(tr).join("") : "")).join("");
    el.innerHTML = `<table><thead><tr>${COLUMNS.map((c) => `<th data-col="${c.id}" class="${c.num ? "num" : ""} ${c.id === sortId ? "sorted" : ""}">${c.id === "key" ? firstLabel : c.label}</th>`).join("")}</tr></thead>
      <tbody>${body}</tbody></table>`;
    el.querySelectorAll("th").forEach((th) => th.addEventListener("click", () => { sortState[containerId] = th.dataset.col; renderTable(containerId, groups, firstLabel); }));
  }

  function renderHives(hives) {
    const rows = hives.filter((h) => !h.synthetic);
    document.getElementById("by-hive").innerHTML = `<table><thead><tr><th>hive id</th><th>cluster</th><th>hive version</th><th>public orgs</th><th class="num">records</th><th class="num">attributed</th><th class="num">authored</th><th class="num">reviews</th><th>months</th></tr></thead>
      <tbody>${rows.map((h) => `<tr><td><code>${escapeHtml(h.hive_id)}</code></td><td>${escapeHtml(h.cluster || "")}</td><td>${escapeHtml(h.hive_version || "")}</td><td>${escapeHtml((h.orgs || []).join(", ")) || '<span class="nr">anonymized</span>'}</td><td class="num">${fmtInt(h.records)}</td><td class="num">${fmtInt(h.attributed)}</td><td class="num">${fmtInt(h.authored)}</td><td class="num">${fmtInt(h.reviews)}</td><td>${h.first}${h.first !== h.last ? " → " + h.last : ""}</td></tr>`).join("")}</tbody></table>`;
  }

  // One row per canonical model; with split on, each model row heads a group
  // of (model × harness) rows carrying their own metrics.
  function modelGroups(cells, split) {
    const byModel = new Map();
    for (const c of cells) if (c.canonical) byModel.set(`${c.vendor}\u0000${c.canonical}`, c);
    const models = aggregate(cells, (c) => c.canonical && `${c.vendor}\u0000${c.canonical}`);
    for (const g of models) {
      const c = byModel.get(g.key);
      g.label = modelLabel(c);
      g.key = g.label;
      if (!split) continue;
      const kids = aggregate(cells.filter((x) => x.canonical === c.canonical && x.vendor === c.vendor), (x) => `${g.label} · ${harnessLabel(x.harness)}`);
      g.children = kids.map((k) => ({ ...k, sub: true, label: harnessLabel(k.key.slice(g.label.length + 3)) }));
    }
    return models;
  }

  function splitFromState() {
    const q = new URLSearchParams(location.search).get(SPLIT_PARAM);
    if (q != null) return q === "runtime";
    try { return localStorage.getItem(SPLIT_KEY) === "runtime"; } catch (_) { return false; }
  }
  function persistSplit(on) {
    try { localStorage.setItem(SPLIT_KEY, on ? "runtime" : "model"); } catch (_) { /* private mode */ }
    const url = new URL(location.href);
    if (on) url.searchParams.set(SPLIT_PARAM, "runtime"); else url.searchParams.delete(SPLIT_PARAM);
    history.replaceState(null, "", url);
  }

  function renderStats(cells) {
    const t = aggregate(cells, () => "all")[0] || emptyGroup("all");
    const hives = new Set(cells.map((c) => c.hive_id)).size;
    const models = new Set(cells.filter((c) => c.canonical).map((c) => `${c.vendor}/${c.canonical}`)).size;
    $("#stats").innerHTML = [
      [fmtInt(t.n), "records in view"], [hives, "hives"], [models, "models"],
      [t.opened ? fmtPct(t.merged / t.opened) : "—", `merged (${fmtInt(t.merged)}/${fmtInt(t.opened)} PRs)`],
      [t.ci_n ? fmtPct(t.ci_green / t.ci_n) : "—", `CI green first try (n=${fmtInt(t.ci_n)})`],
      [t.cost_n ? fmtUsd(t.cost_usd) : "—", `${EST} total cost (n=${fmtInt(t.cost_n)} with cost data)`],
      [t.costPerMerged != null ? fmtUsd(t.costPerMerged) : "—", `${EST} cost per merged PR (${fmtInt(t.cost_merged)} merged PRs)`],
      [t.n ? fmtPct((t.cost_basis_n.reported + t.cost_basis_n.tokens_x_pricing) / t.n) : "—", `records with PR-attributed cost; ${t.n ? fmtPct(t.cost_basis_n.fleet_model_median / t.n) : "—"} fleet-median imputed`],
    ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");
  }

  function renderCostBasis(cost) {
    const el = document.getElementById("cost-basis");
    if (!el) return;
    const n = cost.basis_n || {};
    const meds = (cost.medians || []).filter((m) => m.role === "author").sort((a, b) => b.n - a.n);
    el.innerHTML = `<p>Price table as of <b>${escapeHtml(cost.price_table_as_of || "?")}</b> (<a href="schema/pricing.json">schema/pricing.json</a>). Records by basis: ${BASES.map((b) => `<code>${b}</code> ${fmtInt(n[b] || 0)}`).join(" · ")}.</p>
      <details><summary>Fleet medians used for imputation (agent-authored PRs)</summary>
      <table><thead><tr><th>model (normalized)</th><th class="num">${EST} USD / PR</th><th class="num">n</th><th>how</th></tr></thead>
      <tbody>${meds.map((m) => `<tr><td><code>${escapeHtml(m.model)}</code></td><td class="num">${fmtUsd(m.usd)}</td><td class="num">${fmtInt(m.n)}</td><td>${m.how === "model" ? "median of this model's attributed PRs" : "median token mix for the role × this model's list price"}</td></tr>`).join("")}</tbody></table></details>`;
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
    renderCostBasis(index.cost || {});

    const render = () => {
      const view = applyFilter(cells, currentFilter());
      renderStats(view);
      renderTable("by-model", modelGroups(view, $("#f-split").checked), "model");
      renderTable("by-harness", aggregate(view, (c) => c.harness), "harness");
      renderTable("by-runtime", aggregate(view, (c) => c.runtime), "runtime");
    };
    document.getElementById("filters").addEventListener("input", render);
    $("#f-split").checked = splitFromState();
    $("#f-split").addEventListener("change", () => { persistSplit($("#f-split").checked); render(); });
    render();
  }).catch((err) => {
    $("#meta").textContent = err.message;
  });
})();
