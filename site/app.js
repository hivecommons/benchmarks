/* Hive Commons benchmarks — vanilla JS, no build step.
 * Loads data/index.json (pre-aggregated cells built by scripts/build-index.py),
 * applies filters, and renders leaderboards by model / harness / runtime plus
 * a per-hive contribution table. */
(() => {
  "use strict";

  const MIN_N = 10;            // below this a rate is "insufficient data" (outcomebench rule)
  const MIN_N_COST = 30;       // merged PRs with a cost needed to show cost per merged PR (METHODOLOGY.md)
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
    if (!w || w.n < MIN_N) return `<td class="num nr">insufficient data${w ? ` (n=${w.n})` : ""}</td>`;
    const width = Math.round(w.rate * 60);
    return `<td class="num"><span class="bar" style="width:${width}px"></span>${fmtPct(w.rate)} <span class="ci">[${fmtPct(w.lo)}–${fmtPct(w.hi)}] n=${w.n}</span></td>`;
  }
  // Cost per merged PR with the attribution mix: how many of the group's records
  // carry a PR-attributed cost vs a fleet-median imputation.
  function costCell(g) {
    if (g.costPerMerged == null) return '<td class="num nr">—</td>';
    const cov = `${fmtPct(g.cost_n / g.n)} cost coverage`;
    if (g.cost_merged < MIN_N_COST) return `<td class="num nr" title="needs ${MIN_N_COST} merged PRs with cost">insufficient data <span class="ci">(n=${g.cost_merged}, ${cov})</span></td>`;
    const attr = g.cost_basis_n.reported + g.cost_basis_n.tokens_x_pricing;
    const tip = `${fmtInt(g.cost_merged)} merged PRs with cost; basis: ${attr} attributed, ${g.cost_basis_n.fleet_model_median} fleet-median, ${g.cost_basis_n.unknown} unknown`;
    return `<td class="num" title="${tip}">${fmtUsd(g.costPerMerged)} <span class="ci">${fmtPct(attr / g.n)} attr. · ${cov}</span></td>`;
  }
  function numCell(x, fmt) {
    return `<td class="num">${x == null || Number.isNaN(x) ? '<span class="nr">—</span>' : fmt(x)}</td>`;
  }

  const COLUMNS = [
    { id: "key", label: "", sort: (a, b) => a.key.localeCompare(b.key), cell: (g, dim) => keyCell(g, dim) },
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
  function keyCell(g, dim) {
    const tip = variantsTip(g);
    const label = g.label != null ? g.label : g.key;
    if (dim && !g.sub) {
      const on = sel && sel.dim === dim && sel.id === (g.id ?? g.key);
      return `<td${tip ? ` title="${tip}"` : ""}><button type="button" class="pick${on ? " on" : ""}" data-dim="${dim}" data-id="${escapeHtml(g.id ?? g.key)}" aria-pressed="${on}">${escapeHtml(label)}</button>${g.children ? ` <span class="ci">${g.children.length} runtimes</span>` : ""}</td>`;
    }
    if (g.sub) return `<td class="sub"${tip ? ` title="${tip}"` : ""}><span class="via">· ${escapeHtml(label)}</span></td>`;
    return `<td${tip ? ` title="${tip}"` : ""}>${escapeHtml(label)}${g.children ? ` <span class="ci">${g.children.length} runtimes</span>` : ""}</td>`;
  }

  const sortState = {};
  function renderTable(containerId, groups, firstLabel, dim) {
    const el = document.getElementById(containerId);
    if (!groups.length) { el.innerHTML = '<p class="nr">no records match the current filters</p>'; return; }
    const sortId = sortState[containerId] || "n";
    const col = COLUMNS.find((c) => c.id === sortId);
    const rows = [...groups].sort(col.sort);
    const tr = (g) => `<tr${g.sub ? ' class="sub"' : g.children ? ' class="group"' : ""}>${COLUMNS.map((c) => c.cell(g, dim)).join("")}</tr>`;
    // A group row (model) is followed by its children (model × runtime), each sorted by the same column.
    const body = rows.map((g) => tr(g) + (g.children ? [...g.children].sort(col.sort).map(tr).join("") : "")).join("");
    el.innerHTML = `<table><thead><tr>${COLUMNS.map((c) => `<th data-col="${c.id}" class="${c.num ? "num" : ""} ${c.id === sortId ? "sorted" : ""}">${c.id === "key" ? firstLabel : c.label}</th>`).join("")}</tr></thead>
      <tbody>${body}</tbody></table>`;
    el.querySelectorAll("th").forEach((th) => th.addEventListener("click", () => { sortState[containerId] = th.dataset.col; renderTable(containerId, groups, firstLabel, dim); syncUrl(); }));
    el.querySelectorAll("button.pick").forEach((b) => b.addEventListener("click", () => select(b.dataset.dim, b.dataset.id)));
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
      g.id = `${c.vendor}/${c.canonical}`;
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

  // ---- shareable state (query string) -------------------------------------
  // Filters, sort, split, drill-down selection and compare pair live in the URL.
  let sel = null;                 // { dim: "model" | "harness", id } drill-down target
  let cmp = ["", ""];             // model ids (vendor/canonical) in compare mode
  let rerender = () => {};
  const FILTER_PARAMS = { role: "f-role", org: "f-org", kind: "f-kind", harness: "f-harness", runtime: "f-runtime", acmm: "f-acmm", since: "f-since" };
  const DEFAULT_ROLE = "author";
  const ROLE_BOTH = "both";       // role="" (both) is spelled ?role=both
  const SORT_PARAMS = { "by-model": "sort_model", "by-harness": "sort_harness", "by-runtime": "sort_runtime" };
  const DIMS = ["model", "harness"];

  function readUrl() {
    const q = new URLSearchParams(location.search);
    for (const [param, id] of Object.entries(FILTER_PARAMS)) {
      const v = q.get(param);
      if (v == null) continue;
      const el = document.getElementById(id);
      el.value = param === "role" && v === ROLE_BOTH ? "" : v;
    }
    $("#f-synthetic").checked = q.get("synthetic") === "1";
    for (const [cid, param] of Object.entries(SORT_PARAMS)) {
      const v = q.get(param);
      if (v && COLUMNS.some((c) => c.id === v)) sortState[cid] = v;
    }
    for (const d of DIMS) if (q.get(d)) sel = { dim: d, id: q.get(d) };
    cmp = [q.get("a") || "", q.get("b") || ""];
  }
  function syncUrl() {
    const url = new URL(location.href);
    const set = (k, v) => { if (v) url.searchParams.set(k, v); else url.searchParams.delete(k); };
    for (const [param, id] of Object.entries(FILTER_PARAMS)) {
      const v = document.getElementById(id).value;
      set(param, param === "role" ? (v === DEFAULT_ROLE ? "" : v || ROLE_BOTH) : v);
    }
    set("synthetic", $("#f-synthetic").checked ? "1" : "");
    for (const [cid, param] of Object.entries(SORT_PARAMS)) set(param, sortState[cid] && sortState[cid] !== "n" ? sortState[cid] : "");
    for (const d of DIMS) set(d, sel && sel.dim === d ? sel.id : "");
    set("a", cmp[0]); set("b", cmp[1]);
    history.replaceState(null, "", url);
  }
  function select(dim, id) {
    sel = sel && sel.dim === dim && sel.id === id ? null : { dim, id };   // click again to close
    syncUrl(); rerender();
    if (sel) document.getElementById("drill").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // ---- charts (inline SVG; colours come from CSS variables) -----------------
  const SVG_W = 840, LABEL_W = 230, PLOT_X0 = 240, PLOT_X1 = 500, ROW_H = 24, AXIS_H = 22, MAX_CHART_ROWS = 20, LABEL_CHARS = 34;
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const costOk = (g) => g.costPerMerged != null && g.cost_merged >= MIN_N_COST;
  const rateOk = (w) => w && w.n >= MIN_N;
  const covPct = (g) => fmtPct(g.n ? g.cost_n / g.n : 0);

  // One dot per row; whisker = [lo, hi] when present. rows: {label,id,dim,v,lo,hi,text}
  function dotChart(rows, max, ticks, tickFmt, title) {
    const h = AXIS_H + rows.length * ROW_H + 4;
    const x = (v) => PLOT_X0 + (v / max) * (PLOT_X1 - PLOT_X0);
    const grid = ticks.map((t) => `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${AXIS_H - 4}" y2="${h - 4}"/><text class="tick" x="${x(t)}" y="12" text-anchor="middle">${tickFmt(t)}</text>`).join("");
    const body = rows.map((r, i) => {
      const y = AXIS_H + i * ROW_H + ROW_H / 2;
      const on = sel && sel.dim === r.dim && sel.id === r.id;
      const wh = r.lo != null ? `<line class="whisker" x1="${x(r.lo)}" x2="${x(r.hi)}" y1="${y}" y2="${y}"/><line class="whisker" x1="${x(r.lo)}" x2="${x(r.lo)}" y1="${y - 4}" y2="${y + 4}"/><line class="whisker" x1="${x(r.hi)}" x2="${x(r.hi)}" y1="${y - 4}" y2="${y + 4}"/>` : "";
      return `<g class="row${on ? " on" : ""}" tabindex="0" role="button" aria-label="${escapeHtml(r.label)}: ${escapeHtml(r.text)}" data-dim="${r.dim}" data-id="${escapeHtml(r.id)}">
        <rect class="hit" x="0" y="${y - ROW_H / 2}" width="${SVG_W}" height="${ROW_H}"/>
        <text class="lab" x="${LABEL_W}" y="${y + 4}" text-anchor="end"><title>${escapeHtml(r.label)}</title>${escapeHtml(clip(r.label, LABEL_CHARS))}</text>
        ${wh}<circle class="dot" cx="${x(r.v)}" cy="${y}" r="4.5"/>
        <text class="val" x="${PLOT_X1 + 12}" y="${y + 4}">${escapeHtml(r.text)}</text></g>`;
    }).join("");
    return `<svg class="chart" viewBox="0 0 ${SVG_W} ${h}" role="img" aria-label="${escapeHtml(title)}">${grid}${body}</svg>`;
  }

  function niceMax(v) {
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    const m = [1, 2, 2.5, 5, 10].find((k) => k * pow >= v);
    return m * pow;
  }

  function renderCharts(models) {
    const el = $("#charts");
    // Merge rate with Wilson whiskers.
    const rate = models.filter((g) => rateOk(g.mergeRate)).sort((a, b) => b.mergeRate.rate - a.mergeRate.rate);
    const rateRows = rate.slice(0, MAX_CHART_ROWS).map((g) => ({ dim: "model", id: g.id, label: g.label, v: g.mergeRate.rate, lo: g.mergeRate.lo, hi: g.mergeRate.hi,
      text: `${fmtPct(g.mergeRate.rate)} [${fmtPct(g.mergeRate.lo)}–${fmtPct(g.mergeRate.hi)}] n=${g.mergeRate.n}` }));
    const hidRate = models.length - rate.length;
    // Cost per merged PR (point estimate: the index has no per-PR cost variance, so no whisker).
    const cost = models.filter(costOk).sort((a, b) => a.costPerMerged - b.costPerMerged);
    const cmax = cost.length ? niceMax(Math.max(...cost.map((g) => g.costPerMerged))) : 1;
    const costRows = cost.slice(0, MAX_CHART_ROWS).map((g) => ({ dim: "model", id: g.id, label: g.label, v: g.costPerMerged,
      text: `${fmtUsd(g.costPerMerged)} · ${covPct(g)} cost coverage · n=${g.cost_merged}` }));
    const hidCost = models.length - cost.length;
    const note = (hid, rule) => hid ? `<p class="ci">${hid} model${hid === 1 ? "" : "s"} not shown: <span class="nr">insufficient data</span> (${rule}).</p>` : "";
    el.innerHTML = `
      <figure><figcaption>Merge rate, 95% Wilson interval (n = PRs opened)</figcaption>
        ${rateRows.length ? dotChart(rateRows, 1, [0, 0.25, 0.5, 0.75, 1], (t) => fmtPct(t), "Merge rate per model") : '<p class="nr">insufficient data</p>'}${note(hidRate, `n &lt; ${MIN_N}`)}</figure>
      <figure><figcaption>${EST} cost per merged PR (point estimate, no interval; coverage = records with cost / all records)</figcaption>
        ${costRows.length ? dotChart(costRows, cmax, [0, cmax / 4, cmax / 2, (3 * cmax) / 4, cmax], (t) => fmtUsd(t), "Cost per merged PR per model") : '<p class="nr">insufficient data</p>'}${note(hidCost, `fewer than ${MIN_N_COST} merged PRs with a cost estimate`)}</figure>`;
    el.querySelectorAll("g.row").forEach((g) => {
      const go = () => select(g.dataset.dim, g.dataset.id);
      g.addEventListener("click", go);
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  }

  // Monthly trend: one point per month, drawn only where the same minimum-n rules hold.
  const TREND_W = 520, TREND_H = 150, TREND_PAD = { l: 44, r: 12, t: 12, b: 24 };
  function trendChart(months, pts, max, fmt, title) {
    const iw = TREND_W - TREND_PAD.l - TREND_PAD.r, ih = TREND_H - TREND_PAD.t - TREND_PAD.b;
    const x = (i) => TREND_PAD.l + (months.length < 2 ? iw / 2 : (i / (months.length - 1)) * iw);
    const y = (v) => TREND_PAD.t + ih - (v / max) * ih;
    const grid = [0, 0.5, 1].map((f) => `<line class="grid" x1="${TREND_PAD.l}" x2="${TREND_W - TREND_PAD.r}" y1="${y(f * max)}" y2="${y(f * max)}"/><text class="tick" x="${TREND_PAD.l - 6}" y="${y(f * max) + 4}" text-anchor="end">${fmt(f * max)}</text>`).join("");
    const labels = months.map((m, i) => (months.length <= 8 || i % 2 === 0) ? `<text class="tick" x="${x(i)}" y="${TREND_H - 6}" text-anchor="middle">${m.slice(2)}</text>` : "").join("");
    // Break the line across months that have no reportable value.
    let d = "", pen = false;
    const marks = [];
    pts.forEach((p, i) => {
      if (!p) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i)},${y(p.v)} `; pen = true;
      const wh = p.lo != null ? `<line class="whisker" x1="${x(i)}" x2="${x(i)}" y1="${y(p.lo)}" y2="${y(p.hi)}"/>` : "";
      marks.push(`${wh}<circle class="dot" cx="${x(i)}" cy="${y(p.v)}" r="3.5"><title>${escapeHtml(months[i])}: ${escapeHtml(p.text)}</title></circle>`);
    });
    return `<svg class="chart" viewBox="0 0 ${TREND_W} ${TREND_H}" role="img" aria-label="${escapeHtml(title)}">${grid}${labels}<path class="line" d="${d}"/>${marks.join("")}</svg>`;
  }

  function monthSeries(cells) {
    const all = [...new Set(cells.map((c) => c.month).filter(Boolean))].sort();
    if (!all.length) return { months: [], by: new Map() };
    // Fill gaps so the x axis is a continuous calendar.
    const months = [];
    let [yy, mm] = all[0].split("-").map(Number);
    const [ey, em] = all[all.length - 1].split("-").map(Number);
    while (yy < ey || (yy === ey && mm <= em)) { months.push(`${yy}-${String(mm).padStart(2, "0")}`); if (++mm > 12) { mm = 1; yy++; } }
    return { months, by: new Map(aggregate(cells, (c) => c.month).map((g) => [g.key, g])) };
  }

  // ---- drill-down ---------------------------------------------------------------
  const DRILL_SPECS = {
    model: [["kind", "task kind", (c) => c.kind], ["acmm", "ACMM level", (c) => c.acmm === "" || c.acmm == null ? "" : `L${c.acmm}`], ["harness", "harness", (c) => c.harness], ["runtime", "sandbox runtime", (c) => c.runtime]],
    harness: [["model", "model", (c) => c.canonical && modelLabel(c)], ["kind", "task kind", (c) => c.kind], ["acmm", "ACMM level", (c) => c.acmm === "" || c.acmm == null ? "" : `L${c.acmm}`], ["runtime", "sandbox runtime", (c) => c.runtime]],
  };
  const matchSel = (c, s) => s.dim === "model" ? `${c.vendor}/${c.canonical}` === s.id : c.harness === s.id;

  function renderDrill(view, models) {
    const el = $("#drill");
    if (!sel) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    const cells = view.filter((c) => matchSel(c, sel));
    const name = sel.dim === "model" ? (models.find((g) => g.id === sel.id)?.label || sel.id) : harnessLabel(sel.id);
    if (!cells.length) {
      el.innerHTML = `<h2>${escapeHtml(name)}</h2><p class="nr">no records for this ${sel.dim} under the current filters. <button type="button" class="pick" id="drill-close">close</button></p>`;
      $("#drill-close").addEventListener("click", () => select(sel.dim, sel.id));
      return;
    }
    const t = aggregate(cells, () => "all")[0];
    const { months, by } = monthSeries(cells);
    const ratePts = months.map((mo) => { const g = by.get(mo); return g && rateOk(g.mergeRate) ? { v: g.mergeRate.rate, lo: g.mergeRate.lo, hi: g.mergeRate.hi, text: `${fmtPct(g.mergeRate.rate)} [${fmtPct(g.mergeRate.lo)}–${fmtPct(g.mergeRate.hi)}] n=${g.mergeRate.n}` } : null; });
    const costPts = months.map((mo) => { const g = by.get(mo); return g && costOk(g) ? { v: g.costPerMerged, text: `${fmtUsd(g.costPerMerged)} · ${covPct(g)} cost coverage · n=${g.cost_merged}` } : null; });
    const cmax = costPts.some(Boolean) ? niceMax(Math.max(...costPts.filter(Boolean).map((p) => p.v))) : 1;
    const trend = (pts, max, fmt, title, rule) => pts.some(Boolean)
      ? trendChart(months, pts, max, fmt, title) + (pts.some((p) => !p) ? `<p class="ci">Months without a point: <span class="nr">insufficient data</span> (${rule}).</p>` : "")
      : `<p class="nr">insufficient data in every month (${rule})</p>`;
    el.innerHTML = `<h2>${escapeHtml(name)} <span class="ci">${sel.dim} drill-down · ${fmtInt(t.n)} records under the current filters</span> <button type="button" class="pick" id="drill-close">close</button></h2>
      <div class="trends">
        <figure><figcaption>Merge rate by month (95% Wilson)</figcaption>${trend(ratePts, 1, (v) => fmtPct(v), "Monthly merge rate", `n &lt; ${MIN_N}`)}</figure>
        <figure><figcaption>${EST} cost per merged PR by month</figcaption>${trend(costPts, cmax, (v) => fmtUsd(v), "Monthly cost per merged PR", `&lt; ${MIN_N_COST} merged PRs with cost`)}</figure>
      </div>
      <div class="breakdowns">${DRILL_SPECS[sel.dim].map(([id, label]) => `<div><h3>By ${label}</h3><div id="dd-${id}"></div></div>`).join("")}</div>`;
    $("#drill-close").addEventListener("click", () => select(sel.dim, sel.id));
    for (const [id, label, fn] of DRILL_SPECS[sel.dim]) {
      renderTable(`dd-${id}`, aggregate(cells, (c) => fn(c) || null), label);
    }
  }

  // ---- compare ---------------------------------------------------------------------
  function renderCompare(models) {
    const el = $("#compare");
    const opts = (cur) => `<option value="">choose…</option>` + models.map((g) => `<option value="${escapeHtml(g.id)}"${g.id === cur ? " selected" : ""}>${escapeHtml(g.label)}</option>`).join("");
    const [A, B] = cmp.map((id) => models.find((g) => g.id === id));
    let out = "";
    if (A && B) {
      const ov = (a, b) => !rateOk(a) || !rateOk(b) ? '<span class="nr">insufficient data</span>' : (a.lo <= b.hi && b.lo <= a.hi ? "intervals overlap: no clear difference" : "intervals do not overlap");
      const rate = (g) => rateOk(g.mergeRate) ? `${fmtPct(g.mergeRate.rate)} <span class="ci">[${fmtPct(g.mergeRate.lo)}–${fmtPct(g.mergeRate.hi)}] n=${g.mergeRate.n}</span>` : `<span class="nr">insufficient data (n=${g.mergeRate?.n ?? 0})</span>`;
      const ciR = (g) => rateOk(g.ciRate) ? `${fmtPct(g.ciRate.rate)} <span class="ci">[${fmtPct(g.ciRate.lo)}–${fmtPct(g.ciRate.hi)}] n=${g.ciRate.n}</span>` : `<span class="nr">insufficient data (n=${g.ciRate?.n ?? 0})</span>`;
      const cst = (g) => costOk(g) ? `${fmtUsd(g.costPerMerged)} <span class="ci">${covPct(g)} cost coverage · n=${g.cost_merged}</span>` : `<span class="nr">insufficient data (n=${g.cost_merged}, ${covPct(g)} cost coverage)</span>`;
      const diff = (a, b, f) => f(b - a);
      const pp = (d) => `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(0)} pp`;
      const usd = (d) => `${d >= 0 ? "+" : "−"}${fmtUsd(Math.abs(d))}`;
      out = `<table><thead><tr><th>metric</th><th>${escapeHtml(A.label)}</th><th>${escapeHtml(B.label)}</th><th>B − A</th><th>95% intervals</th></tr></thead><tbody>
        <tr><td>records</td><td class="num">${fmtInt(A.n)}</td><td class="num">${fmtInt(B.n)}</td><td></td><td></td></tr>
        <tr><td>merge rate</td><td class="num">${rate(A)}</td><td class="num">${rate(B)}</td><td class="num">${rateOk(A.mergeRate) && rateOk(B.mergeRate) ? diff(A.mergeRate.rate, B.mergeRate.rate, pp) : "—"}</td><td>${ov(A.mergeRate, B.mergeRate)}</td></tr>
        <tr><td>CI green 1st try</td><td class="num">${ciR(A)}</td><td class="num">${ciR(B)}</td><td class="num">${rateOk(A.ciRate) && rateOk(B.ciRate) ? diff(A.ciRate.rate, B.ciRate.rate, pp) : "—"}</td><td>${ov(A.ciRate, B.ciRate)}</td></tr>
        <tr><td>${EST} cost / merged PR</td><td class="num">${cst(A)}</td><td class="num">${cst(B)}</td><td class="num">${costOk(A) && costOk(B) ? diff(A.costPerMerged, B.costPerMerged, usd) : "—"}</td><td class="nr">no interval available for cost</td></tr></tbody></table>
        <p class="ci">Overlapping intervals mean the data cannot separate the two models; non-overlap is a screen, not a significance test. Models are not assigned to tasks at random: narrow by task kind and ACMM level first.</p>`;
    } else out = '<p class="ci">Pick two models to compare under the current filters.</p>';
    el.innerHTML = `<div class="filters"><label>Model A <select id="cmp-a">${opts(cmp[0])}</select></label><label>Model B <select id="cmp-b">${opts(cmp[1])}</select></label></div>${out}`;
    for (const [i, id] of [[0, "#cmp-a"], [1, "#cmp-b"]]) $(id).addEventListener("change", (e) => { cmp[i] = e.target.value; syncUrl(); rerender(); });
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

    readUrl();
    $("#f-split").checked = splitFromState();
    const render = () => {
      const view = applyFilter(cells, currentFilter());
      const models = modelGroups(view, $("#f-split").checked);
      renderStats(view);
      renderCharts(models);
      renderTable("by-model", models, "model", "model");
      renderTable("by-harness", aggregate(view, (c) => c.harness), "harness", "harness");
      renderTable("by-runtime", aggregate(view, (c) => c.runtime), "runtime");
      renderDrill(view, models);
      renderCompare(models);
    };
    rerender = render;
    document.getElementById("filters").addEventListener("input", () => { syncUrl(); render(); });
    $("#f-split").addEventListener("change", () => { persistSplit($("#f-split").checked); render(); });
    render();
  }).catch((err) => {
    $("#meta").textContent = err.message;
  });
})();
