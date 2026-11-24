# Contributing

* Sign off commits (DCO): `git commit -s`.
* Data PRs: add files under `data/<org>/<yyyy-mm>/`, run `scripts/build-index.sh`, confirm it
  passes, and tick the privacy checklist in the PR template. Do **not** commit `data/index.json`;
  CI generates it.
* `scripts/build-index.sh` needs `jq` and `python3`, plus `jsonschema` (`pip install jsonschema`) for validation.
* CI also runs three checks you can run locally before pushing:
  `python3 -m unittest discover -s scripts -p 'test_*.py'` (unit tests for the scripts),
  `node --test site/app.test.js` (unit tests for the leaderboard statistics in `site/app.js`; Node 18+,
  no dependencies) and `scripts/check-no-temp-artifacts.sh` (fails if temp or scratch artifacts are committed).
* Repo names appear only for public repos (owners can opt out with `benchmarks.repo_consent: false`).
  Methodology: [METHODOLOGY.md](METHODOLOGY.md).
* Site PRs: keep `site/` dependency-free (no bundler, no framework). Run `node --test site/app.test.js`,
  then serve the repo root with any static server and open `site/index.html`.
* Schema PRs: change `schema/result.schema.json`, update `data/README.md` and the sample records,
  and explain the hive-side field it maps to (see `docs/INVENTORY.md`).
* Be kind; CNCF Code of Conduct applies.
