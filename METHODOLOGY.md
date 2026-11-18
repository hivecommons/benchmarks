# Methodology (v1)

How records are selected, measured and published. These rules come from the maintainer decisions
on hivecommons/benchmarks#3. Where this file and the site disagree, this file wins; fix the site.
Cost estimation details are in the [README](README.md#methodology-estimated-cost).

## 1. Canonical task kinds and size

The leaderboard covers four task kinds:

| `task.kind` | Work |
|---|---|
| `issue-fix` | An agent opens a PR to resolve an issue. |
| `ci-repair` | An agent repairs a failing CI run. |
| `pr-review` | An agent reviews someone else's PR (role `reviewer`). |
| `dependency-update` | An agent bumps dependencies. |

* `task.size.bucket` (`xs`, `s`, `m`, `l`, `xl`) is **required for `issue-fix`** records and
  optional for the others, so that issue-fix comparisons can be stratified by size.
* Records of any other kind (`triage`, `release`, `docs`, `security-fix`, `refactor`,
  `experiment`, `other`, `unknown`) are **stored but not shown on the leaderboard**.
* The schema still accepts the wider enum; a missing `size.bucket` on an `issue-fix` record keeps
  the record in the data set but excludes it from the leaderboard until it is supplied.

## 2. Metrics

**Primary**

| Metric | Definition |
|---|---|
| Merge rate | records with `outcome.pr_merged` ÷ records with `outcome.pr_opened`. |
| CI green first try | `ci_green_first_try` true ÷ records where CI was captured (nulls excluded). |
| Cost per merged PR | Σ `cost.usd_est` over merged PRs with a cost ÷ merged PRs with a cost. Estimate, never a bill. |
| 14-day revert rate | merged PRs reverted within 14 days ÷ merged PRs with revert data captured (nulls excluded). |

**Secondary**

| Metric | Definition |
|---|---|
| Median time to merge | Median PR open to merge, read from a 12-bucket log-scale histogram, so a bucket midpoint. |
| Human interventions per record | Σ human interventions ÷ records. |
| Retries | Σ retries ÷ records. |

Rates carry a 95% Wilson score interval and their n.

## 3. Denominators and coverage

* Records without a cost (`cost.basis = unknown`) are excluded from **both** the numerator and the
  denominator of cost per merged PR.
* Cost per merged PR is always displayed with its **coverage**: records with cost ÷ all records in
  the group, so a cheap-looking cell built from a few costed records is visible as such.
* The same rule holds for any metric with nulls: the denominator is the records where the value
  was captured, and n is shown.

## 4. Minimum sample sizes

| Metric | Minimum n | Counted as |
|---|---|---|
| Rate metrics (merge, CI first try, revert) | 10 | denominator of that rate |
| Cost per merged PR | 30 | merged PRs with a cost estimate |

Below the minimum the cell shows **insufficient data**. The rate rule is the same as hive's
outcomebench benchmark.

## 5. Consent for repository names

`task.repo` is published only when **both** hold:

1. the repository is **public**, and
2. an **owner or admin** of that repository (or its org) agreed.

Consent is recorded by a PR adding the repository (or `owner/*`) to
[`consent/repos.txt`](consent/repos.txt), **authored by an account with admin rights** on that
repository or org. **Public status alone is not consent.** CI
([`scripts/check-repo-consent.py`](scripts/check-repo-consent.py), workflow `consent`) checks
every data record against the allow-list. Everything else is anonymised: drop `task.repo` (and
`task.repo_consent`); an anonymised record always passes the check, which is the exemption path.

Existing data is grandfathered: while `consent/enforce-from.txt` is `none` the check only reports
violations and never fails. Setting it to a timestamp makes records published at or after it fail
when their repo is not allow-listed. Withdrawal: remove the line; owners can also use the
`takedown:` issue process in GOVERNANCE.md.

## 6. Hive identity

A hive is identified by a **stable salted hash** of its id, so trends across months work. The hash
is never reversible from public data. A hive may ask for its salt to be **rotated**; after
rotation its later records appear under a new hash and are not linked to earlier ones.

## 7. Synthetic and replay results

Results that are synthetic or replayed (not from a live hive's real work) are accepted **only with
an explicit `synthetic: true`**. They are never mixed into the default leaderboard and are shown
in a separate view (the site's "Include synthetic" toggle excludes them by default).

## Known limitations

Cross-model differences are observational, not experimental.

* **Task assignment is not random.** Bigger models tend to get harder issues, so raw comparisons
  favour or penalise them for reasons unrelated to model quality. Use size bucket and task kind
  filters.
* **Review agents never open PRs.** `pr-review` records have no merge rate in the author sense and
  must not be ranked against authoring agents.
* **Hives run at different ACMM levels** with different policies, review gates and CI. Filter by
  ACMM level before comparing.
* Costs are list-price estimates (see README); `wall_clock_s` is PR open to merge, not agent runtime.
* Small groups are noisy even above the minimum n; read the interval.
