# Security Policy

This repository publishes fleet-contributed benchmark data and the scripts and workflows that
build it. Please report vulnerabilities, and especially **privacy leaks in published data**
(a private repository name, a login, prompt or finding text, or any other content the
[README](README.md) and [METHODOLOGY.md](METHODOLOGY.md) say never leave a hive), privately.

**Do not report these through public GitHub issues, pull requests or discussions.** A public
report exposes the leaked data or weakness before it can be removed.

## Reporting

1. If the repository's **Security** tab shows **Report a vulnerability**, use it (GitHub's
   private security advisory flow).
2. If it does not, contact a maintainer directly (see Contact in the [README](README.md))
   and ask for a private channel before sharing details. Do not put details in a public message.

Please include the affected file or path, what is exposed or exploitable, and how to reproduce it.

## What to expect

- We aim to acknowledge a report within 5 business days.
- For a data leak we remove the content from the current tree first, then assess whether
  history needs to be rewritten, and tell the affected hive owner.
- We coordinate disclosure with you and credit you if you wish.

## Scope

In scope: files under `data/`, `schema/`, `scripts/`, `site/` and CI workflows. Vulnerabilities
in Hive itself belong in [hivecommons/hive](https://github.com/hivecommons/hive).
