# Governance

Small repo, small rules.

## Roles

* **Maintainers** merge PRs and own the schema. Initially @clubanderson; any regular contributor
  from a participating project (Hive Commons, Project Bluefin) may be added by an existing
  maintainer after two merged PRs.
* **Data publishers** are hive owners who opt in. They own their records and may request removal at any time.

## Decisions

Lazy consensus on issues/PRs; 72 h for schema changes. Schema changes bump `schema_version`
and must keep `scripts/build-index.sh` passing on existing data.

## Publication and privacy rules

These apply to every record under `data/`, whether exported by hive or written by hand.

1. **Anonymized by default, opt-out.** Every hive exports anonymized records (no repo, no org, no
   people) unless its owner sets `benchmarks.publish: false`.
2. **Repository names** appear only when `task.repo_consent: true`, which the exporter sets for
   repositories GitHub reports as public. Private repos never appear (the schema rejects `task.repo`
   without consent). An owner may force anonymity for public repos too with
   `benchmarks.repo_consent: false`.
3. **Never published:** GitHub logins, prompts, agent transcripts, review finding text or file
   paths, session ids, Nous/experiment questions, secrets, private repo names.
4. **Cost** is published as estimated USD per record. Owners who do not want absolute spend
   visible may omit `cost.usd` and keep token counts.
5. **Hive identity** is `sha256("hivecommons-benchmarks/v1/" + hive id)[:16]`; hive ids are not
   public, and the owner sees their hash in the dashboard (Settings → Benchmarks).
6. **Small-n suppression.** The site never shows a rate for a group with n < 10.
7. **Takedown.** A publisher may open an issue titled `takedown: <hive_id>`; maintainers remove the
   records and rebuild within 7 days, no questions asked.

## Code of conduct

[CNCF Code of Conduct](https://github.com/cncf/foundation/blob/main/code-of-conduct.md). See CODE_OF_CONDUCT.md.
