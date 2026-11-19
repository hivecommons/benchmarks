# Contributing

* Sign off commits (DCO): `git commit -s`.
* Data PRs: add files under `data/<org>/<yyyy-mm>/`, run `scripts/build-index.sh`, confirm it
  passes, and tick the privacy checklist in the PR template. Do **not** commit `data/index.json`;
  CI generates it.
* `scripts/build-index.sh` needs `jq` and `python3`, plus `jsonschema` (`pip install jsonschema`) or
  `node`/`npm` for validation.
* Repo names appear only for public repos (owners can opt out with `benchmarks.repo_consent: false`).
  Methodology: [METHODOLOGY.md](METHODOLOGY.md).
* Script PRs: run the unit tests with `python3 -m unittest discover -s scripts -p 'test_*.py'`
  (needs only `python3`), then `scripts/build-index.sh` followed by
  `scripts/check-no-temp-artifacts.sh`, which fails if the build left untracked files behind.
  CI runs the same three steps.
* Site PRs: keep `site/` dependency-free (no bundler, no framework). Test by serving the repo root
  with any static server and opening `site/index.html`.
* Schema PRs: change `schema/result.schema.json`, update `data/README.md` and the sample records,
  and explain the hive-side field it maps to (see `docs/INVENTORY.md`).
* Be kind; CNCF Code of Conduct applies.
