<!-- Title prefix: ✨ feature · 🐛 fix · 📖 docs · 📊 data · 🌱 other -->

## What

## Privacy checklist (data PRs)
- [ ] No `task.repo` unless the repo is public AND listed in `consent/repos.txt` (added by a PR from an owner/admin account); public status alone is not consent
- [ ] No logins, prompts, transcripts, finding text, paths or session ids
- [ ] Hive owner opted in (`benchmarks.publish: true`)
- [ ] `scripts/build-index.sh` passes locally
