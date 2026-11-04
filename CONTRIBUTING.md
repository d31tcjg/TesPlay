# Contributing

TesPlay was created by **rdvnit**, its sole developer and maintainer. Community bug reports and focused improvements are welcome; there is no dedicated support team.

For a bug, follow [the issue-reporting guide](SUPPORT.md). For a substantial code change, open an issue first to discuss scope. Keep pull requests focused and describe the behavior changed and how it was checked.

```sh
npm ci
npm test
npm run build
```

Install FFmpeg/FFprobe to run the conversion integration tests. See [verification](docs/verification.md) for Docker and device checks. Use a GitHub noreply email address for commits. Never commit credentials, personal data or runtime databases. Do not modify vendored player source directly; see [architecture and maintenance](docs/refactor-audit.md).

Contributions must be compatible with the [PolyForm Noncommercial license](LICENSE). Preserve the [credit notice](NOTICE) and third-party licenses. The maintainer reviews and merges changes when time permits; opening an issue or pull request does not guarantee a response or acceptance.
