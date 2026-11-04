# Architecture and maintenance

## Application boundaries

- `src/App.tsx` composes views and playback. Focused components handle library browsing, media details, connections, settings and the phone remote.
- `server/index.js` assembles the Express application. Route modules handle authentication, accounts, profiles, connections, libraries, providers and remote sessions.
- `server/store.js` and the schema modules own SQLite persistence, encryption and account/profile-scoped storage.
- `server/media.js` handles authenticated media references, validated upstream destinations, HLS rewriting and request cancellation.
- `vendor/tesplayer` contains the pinned playback engine and contracts; `src/tesplayer-adapter.ts` connects them to TesPlay sources.

## Updating the bundled player

Use an available local checkout of the canonical player and a reviewed full commit revision:

```sh
npm run sync:player -- --source /path/to/TesPlayer --revision <full-commit-sha>
npm run check:player
npm test
npm run build
```

The synchronizer imports immutable source blobs, records SHA-256 digests and excludes reference apps, tests and generated output. Do not edit imported files directly: update the canonical source and synchronize a new revision. Keep provenance and third-party license notices with distributed copies.

## Changes

Retain account/profile permission checks, source URL validation, cancellation and persistent-data compatibility when changing modules. Add meaningful regression coverage for behavior changes. See [verification](verification.md) and [community contributions](../CONTRIBUTING.md).
