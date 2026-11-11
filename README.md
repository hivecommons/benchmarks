# hivecommons/benchmarks

Published benchmark results for the coding agents, models and sandbox runtimes used by
[Hive Commons](https://github.com/hivecommons/hive) and [Project Bluefin](https://projectbluefin.io)
hives.

**Site:** https://hivecommons.dev/benchmarks/ · **Data:** [`data/`](data/) (CC-BY-4.0) ·
**Schema:** [`schema/result.schema.json`](schema/result.schema.json)

## Why

Hive and Bluefin's "clanker" agents already run thousands of real pull requests a month across
several harnesses (Claude Code, Codex, Copilot CLI, Gemini, …), models and sandbox runtimes
(Podman, Kubernetes Jobs, OpenShell). Each hive keeps signed per-PR evidence, token/cost
estimates and review verdicts — but every hive keeps them to itself, and the one published
benchmark (hive's monthly *mediated vs unmediated* report) does not split results by model,
harness or runtime.

This repo came out of a Discord conversation between the two projects in November 2026: the data
already exists, so a shared, public results site is mostly glue. It is deliberately
**zero-infra**: JSON files in git, a `jq` script to build an index, and a static page on GitHub
Pages.

## How data flows

```
hive spoke ──GET /api/benchmarks/export──▶ hub (opt-in aggregation, redaction)
                                              │
                                              ▼  PR with data/<org>/<yyyy-mm>/*.json
                                      hivecommons/benchmarks ──build-index.sh──▶ data/index.json
                                                                                   │
                                                                   GitHub Pages ◀──┘  site/
```

1. Every hive publishes **anonymized** records by default: model, harness, sandbox runtime,
   outcome, cost, time-to-merge and ACMM level, keyed by a stable hash of the hive id. Owners can
   opt out with `benchmarks.publish: false` in `hive.yaml`.
2. Repository and org names are included only for **public** repositories (activity on a public
   repo is already public). Private repos stay anonymous. No logins, prompts, finding text or code
   ever leave the spoke.
3. The hub pulls `GET /api/benchmarks/export?since=` from every registered spoke **hourly**, batches
   the records and pushes them to `data/fleet/<hive_hash>/<yyyy-mm>.json` here. Pages rebuilds on
   push, so the site lags the fleet by at most about an hour. Until that publisher ships
   (hivecommons/hive#17694), `scripts/backfill-from-cluster.sh` does the same from `kubectl`, and a
   nightly workflow rebuilds the index.

Each hive's hash is shown to its owner in the dashboard (Settings → Benchmarks) and listed in the
"Contributing hives" table on the site. What hive already collects is written up in
[docs/INVENTORY.md](docs/INVENTORY.md).

## What the site shows

Leaderboards by **model**, **agent harness** and **sandbox runtime**: merge rate, CI green on
first push, cost per merged PR, median hours to merge, 14-day revert rate, human interventions
per record — each rate with n and a 95 % Wilson interval, and *not reported* below n = 10.
Two kinds of work: *agent-authored PRs* (default) and *agent reviews*. Filters: org, task kind,
harness, runtime, ACMM level, month. A "Contributing hives" table lists every hive hash with its
record counts.

## Contribute a result

* **One-off / manual:** open a [Submit a result](https://github.com/hivecommons/benchmarks/issues/new?template=submit-result.yml)
  issue or a PR adding `data/<org>/<yyyy-mm>/<file>.json`. Run `scripts/build-index.sh` locally to validate.
* **New metric or task kind:** open a [Propose a metric](https://github.com/hivecommons/benchmarks/issues/new?template=propose-metric.yml) issue.
* **Code:** `site/` is vanilla HTML/JS, no build step. `scripts/build-index.sh` needs `jq` plus
  either `python3` + `jsonschema` or `node`/`npm`.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Contact

* Issues here, or `#hive` on the Hive Commons Discord.
* Maintainers: @clubanderson (Hive Commons). Project Bluefin participants welcome as co-maintainers.

## License

Code: [Apache-2.0](LICENSE). Data under `data/`: [CC-BY-4.0](LICENSE-DATA).
