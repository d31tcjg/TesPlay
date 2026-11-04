# Verification

## Automated checks

Use Node.js 22.13 or newer and FFmpeg/FFprobe for conversion integration tests:

```sh
npm ci
npm test
npm run build
docker build -t tesplay:check .
```

Tests verify player provenance and rebuild the bundled packages before running. Coverage includes account/profile isolation, connection permissions, encrypted persistence, catalog caching, IPTV categories, source selection, media transport, cancellation, Plex continuity, phone pairing/uploads and playback state.

The GitHub Actions workflow runs the dependency audit, tests, production build and Docker packaging checks. These checks use controlled fixtures and do not certify every provider or device.

## Vehicle checks

The maintainer's actual vehicle results are listed in [compatibility](compatibility.md). Browser simulations verify layout and detection logic; they are separate from those vehicle tests. Raspberry Pi hardware has not been verified.

## Check your installation

Follow the [deployment acceptance check](deployment.md#acceptance-check). Confirm that accounts and libraries survive restart, QR login reaches the correct origin, permitted media plays and seeks, and the phone controls the intended screen. Use authorized sources and test only while safely parked in Park.

## Reporting a problem

Use the [community issue-reporting process](../SUPPORT.md). Include the version, relevant model/processor, reproduction steps and sanitized diagnostics. Never attach provider credentials, personal media libraries, databases, encryption keys or environment files.
