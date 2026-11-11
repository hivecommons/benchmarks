# Contributing

* Sign off commits (DCO): `git commit -s`.
* Data PRs: add files under `data/<org>/<yyyy-mm>/`, run `scripts/build-index.sh`, confirm it
  passes, and tick the privacy checklist in the PR template. Do **not** commit `data/index.json`;
  CI generates it.
* Site PRs: keep `site/` dependency-free (no bundler, no framework). Test by serving the repo root
  with any static server and opening `site/index.html`.
* Schema PRs: change `schema/result.schema.json`, update `data/README.md` and the sample records,
  and explain the hive-side field it maps to (see `docs/INVENTORY.md`).
* Be kind; CNCF Code of Conduct applies.
