# Release checks

## Version 0.2.0 — 4 November 2026

The release source was exported into a fresh repository with one initial commit. It contains the maintained source, documentation, demo screenshots and required license notices. Runtime environment files, databases, credentials, recovery copies and private development records are excluded. Commit attribution uses the maintainer's public GitHub handle and noreply email address.

Gitleaks 8.30.1 scanned the release source and Git history with no confirmed secrets. The checked-in configuration narrowly allows SHA-256 source-provenance entries and one public player feature identifier; these are not credentials. Automated detection cannot guarantee that every possible secret will be identified.

The release passes the regression tests, production build, Docker packaging and repository privacy checks. See [verification](verification.md) and the [maintainer-tested vehicles](compatibility.md).

## Repeat the scan

Install Gitleaks, then run:

```sh
gitleaks git . --log-opts="--all" --redact=100
```

Keep scanner reports and repository backups outside source control. Reports may contain sensitive context even when matched values are redacted. Use a GitHub noreply email address when committing changes.
