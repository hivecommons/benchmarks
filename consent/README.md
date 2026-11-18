# consent/

* `repos.txt`: allow-list of repositories whose names may appear as `task.repo` in `data/`.
  Format and rules are in the file header.
* `enforce-from.txt`: either `none` (report-only: the CI check lists violations but never fails)
  or an ISO date/time such as `2026-12-01T00:00:00Z`. Records with `published_at` at or after
  that moment fail the check if their `task.repo` is not allow-listed; older records stay
  grandfathered and are only reported. Changing this file is a maintainer decision.

Check locally: `python3 scripts/check-repo-consent.py`.
