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

1. A hive owner sets `benchmarks.publish: true` in `hive.yaml` (default **false**).
2. The spoke exports schema records built from its evidence bundles, cost collector and agent
   config; the hub (or the owner, by hand) redacts them per [GOVERNANCE.md](GOVERNANCE.md).
3. Records land here by pull request. CI validates them against the schema, rebuilds
   `data/index.json`, and deploys the site.

The exporter does not exist yet — see the help-wanted issues. What hive already has is written up
in [docs/INVENTORY.md](docs/INVENTORY.md).

## What the site shows

Leaderboards by **model**, **agent harness** and **sandbox runtime**: merge rate, CI green on
first push, cost per merged PR, median hours to merge, 14-day revert rate, human interventions
per record — each rate with n and a 95 % Wilson interval, and *not reported* below n = 10.
Filters: org, task kind, harness, runtime, ACMM level, date.

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
