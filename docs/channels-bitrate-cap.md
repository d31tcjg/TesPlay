# Channels DVR: per-connection max quality (bitrate cap)

Status: spec, 2026-11-05 (Developer). Requested by Cesar: "limit Channels DVR playback to 2 Mbps max", at **720p**.

## Live evidence (read-only probe, recording 3533 = OTA 36.1, Channels idle, no tuner, sessions DELETEd)

Channels `…/hls/master.m3u8` with **no query**, which is what TesPlay requests today, returns an ABR ladder. Each variant URL is `…/hls/stream.m3u8?<params>`:

| BANDWIDTH | RESOLUTION | variant params (abridged) |
|---|---|---|
| 10000000 | 1920x1080 | `abitrate=256&achannels=6&acodec=aac&bitrate=9488&resolution=1080` |
| 8000000 / 6000000 | 1920x1080 | `bitrate=7488` / `5488` |
| 4300000 / 3000000 / 2350000 | 1280x720 | `abitrate=192/128/128`, `bitrate=3916/2744/2094`, `resolution=720` |
| 1000000 … 375000 | 1024x576 … 682x384 | `bitrate=808 … 247` |

All variants also carry `deinterlacer=linear&encoder=software&indexed=true&ssize=1&vcodec=h264`. `indexed`/`ssize` are recording-specific; live channel variants were not captured, so don't hard-code the set.

- TesPlayer takes the highest variant ≤1080p, which is about 10 Mbps. One measured segment was 8.7 Mbps.
- `master.m3u8?bitrate=2000` caps the ladder: the top entry becomes `BANDWIDTH=2000000, RESOLUTION=1024x576, bitrate=1744, resolution=576`. Channels picks **576p** for 2 Mbps, and `&resolution=720` on the master is **ignored**.
- `master.m3u8?abr=false` gives a single variant (the top of the ladder).
- Requesting `stream.m3u8?abitrate=128&acodec=aac&bitrate=1872&…&resolution=720&…` directly returns **1280x720** H.264. Measured over 3 segments it averaged about **2379 kbps** total, because this recording has **two AAC tracks** (2 × ~128 kbps) and rate control varies in short windows.
- The same session path is used throughout, so keepalive `PUT …/hls` and release `DELETE …/hls` are unchanged.

## Requirement

1. New Channels connection setting **`maxQuality`**, edited in the Channels connection form as a select labelled "Max streaming quality". Options:
   - `original` (default; current behaviour, no change)
   - `8000-1080`: 8 Mbps · 1080p
   - `4000-720`: 4 Mbps · 720p
   - `2000-720`: 2 Mbps · 720p
   - `1000-576`: 1 Mbps · 576p

   Cesar will pick `2000-720`. Persist it in the encrypted connection config. It is not secret, so add it to the editable public fields in `server/connection-routes.js` and validate it against the allowlist. Unknown values: 400. A missing value means `original`.
2. Applies to **live channels and recordings** of that connection only. No change for Plex, IPTV, YouTube or other connections, and no Channels server-wide setting change (`PATCH /hls` is forbidden).
3. When capped, TesPlay must end up requesting **one** variant at the chosen resolution with a **total** average of at most the cap:
   - Fetch Channels' own `master.m3u8?bitrate=<cap>&abr=false` (or `?bitrate=<cap>`, then keep the first variant).
   - Rewrite **that variant's** URL query: set `resolution=<720|576|1080>`, set `bitrate=<videoKbps>`, set `abitrate=128`, and drop `achannels` (stereo).
   - Set `videoKbps = floor(cap × 0.85) − 2 × 128`, with a minimum of 300. For 2000 that gives 1444. The 15 % headroom plus room for two audio tracks keeps the measured total under the cap.
   - Preserve every other Channels param exactly as Channels emitted it, which keeps live vs recording params correct.
   - Rewrite `#EXT-X-STREAM-INF` to match: `BANDWIDTH=<cap×1000>,RESOLUTION=<w>x<h>` (1280x720 / 1024x576 / 1920x1080).
   - Then continue through the existing `rewriteHls`/media-proxy registration, so the browser only ever sees opaque `/api/media/…` URLs. The variant must remain on the same Channels host and session path (`allowedPrivateHosts`/path checks unchanged).
   - Where to implement is the implementer's choice: the `/api/playback` channels branch in `server/providers.js` and/or the master rewrite in `server/media.js`. Keep the existing security invariants: `validateRemoteUrl`, private-host allowlist, `channelsSessionPath` regex, and keepalive/release unchanged.
4. `original` must produce byte-identical behaviour to today, so the existing tests stay green unchanged.
5. The UI shows the select only for `channels` connections, with help text: "Lower quality uses less data. Applies to TesPlay only; your other Channels apps are unaffected."

## Tests (synthetic only; fake Channels server or injected fetch)

- Settings: validation (allowlist, default, persisted round-trip, editable without re-entering URL).
- For each cap and for live (`/devices/ANY/channels/<n>/hls`) and recording (`/dvr/files/<id>/hls`) paths, the upstream master request carries `bitrate=<cap>`. The playlist served to the player has exactly one variant, with `resolution`/`bitrate`/`abitrate` rewritten, `achannels` removed, the other params preserved byte-for-byte, and `BANDWIDTH`/`RESOLUTION` updated.
- `original`: identical upstream URL and identical served playlist to today (golden).
- Variant URL host/path tampering in the fake master (another host, another file id, a path outside the session) is rejected as today.
- Keepalive/release still hit `channelsSessionPath`.
- UI: the select renders for channels only and saves `maxQuality`.

## Acceptance (Opus, then live)

- Exact gate: `npm ci && npm test && npm run build` on the final commit, with `vendor/` unchanged vs `homelab`.
- After deploy, a live check with Cesar's approval. On one recording **and** one live channel, run 20 s each and ffprobe a segment: confirm 1280x720 and an average over ≥10 segments of ≤2000 kbps total. Then confirm release (activity clears).

## Out of scope

Plex/IPTV caps, per-profile settings, adaptive switching, and any Channels server setting.

## Implementation notes

- `server/providers.js` selects the per-connection cap only in the Channels playback branch, and registers the original session path plus a capped master URL (`bitrate=<cap>&abr=false`). Missing/`original` retains the previous URL and resource behavior.
- `server/media.js` applies `capChannelsMaster` only to capped Channels root masters, immediately before the existing `rewriteHls` pipeline. It retains the first Channels-authored variant and rewrites its resolution, video budget, and 128 kbps audio budget; removes `achannels`; preserves uncontrolled query components verbatim, including escaping, duplicate keys and recording/live-specific flags. The master advertises the cap and selected dimensions, removes stale average-bandwidth and alternate I-frame variants, and preserves audio rendition tags through the opaque proxy.
- Capped playlist children are checked against the configured DVR origin (including port/protocol) and exact session directory, with that boundary inherited by nested playlists. `validateRemoteUrl`, private-host authorization, the session regex, heartbeat and release implementations remain unchanged. Only the root carries `channelsSessionPath`, avoiding duplicate tuner releases from children.
- The Channels-only editor select is a named native form control, so the existing FormData save pipeline sends `maxQuality`. Allowlist validation and the editable-public-field list support encrypted persistence and quality-only edits without re-entering the hidden URL. No changes to `src/connection-fields.ts` are needed: its existing URL-only field registry stays unchanged.
- Synthetic coverage: every cap × live/episode/movie, original/missing golden, malformed masters, cross-origin/session tampering, nested tampering, encoded/duplicate query params, two audio renditions, cached probe reads, actual child/segment proxy requests, and heartbeat/release. New settings tests exercise the real local app's encrypted connection routes. Existing tests are unchanged (only additional cases were inserted).
- Additional UI execution: `TMPDIR=<scratch-directory> node tests/channels-quality.browser.mjs` runs isolated headless Chrome against an in-memory bundle on loopback. It checks default/restored selections, real native FormData submission for create/edit with blank saved URL, and absence for six other providers. It makes no provider requests.
- Final verification and exact commit/test counts are recorded in Kanban `t_1f4e72a2`. Gate: `npm ci && npm test && npm run build`, using npm offline/no-audit environment settings to avoid external network calls; `git diff --quiet homelab -- vendor` must exit 0.
- No implementation-spec deviations. No live bandwidth/codec measurements, server/DB configuration changes, pushes or deployment were performed. The 720p/≤2000 kbps measured acceptance check still requires Cesar's separate approval after Opus acceptance and deployment. Rollback before deployment: keep the existing homelab code unchanged; after any approved deploy, follow the acceptance/deploy card's rollback to `ac7cdb4`.
