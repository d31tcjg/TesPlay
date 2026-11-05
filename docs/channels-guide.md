# Channels DVR: TV guide and recordings (fork feature v2)

Status: design by Developer (Opus), 2026-11-05. Builds on the deployed Channels DVR connection (`docs/channels-dvr.md`, `homelab` @ adb493b).
Cesar's feedback after using v1 in the car: *"I want to see the TV guide, what's on now, scroll and pick a channel, and also see my recordings."*
In v1, the Live TV tab only showed the Channels connection as an opaque folder, and recordings were only reachable through Connections → Browse.

**Tests use synthetic fixtures only.** No real titles, IPs or paths.

## Observed Channels guide API (read-only, LAN, no auth)

| Request | Shape |
| --- | --- |
| `GET /devices/ANY/guide?time=<unixSec>&duration=<sec>` | `[{Channel, Airings[]}]`, one row per *visible* lineup channel (hidden channels are not included). About 1.6 MB raw for 3 h × 313 channels. |
| `GET /devices/ANY/guide/now` | Same shape, with 0–1 airings per row (the current program). About 0.6 MB raw. |
| `Channel` | `{ChannelID, Number, Name, CallSign?, DeviceID, Hidden, Image?, Station?}`. `Number` matches `/api/v1/channels` `number` and the v1 `live:<number>` ids. |
| `Airing` | `{Channel, Time (unix sec), Duration (sec), Title, EpisodeTitle?, Summary?, FullSummary?, Image?, Genres[], Categories[], Tags[] (e.g. "New","Live","HD 1080i"), SeriesID?, ProgramID, OriginalDate?, ReleaseYear?, SeasonNumber?, EpisodeNumber?, Raw?, SearchScore?}` |

`/dvr/guide` and `/api/v1/guide` return 404. Do not use them.

## Server

Extend `server/providers.js` (Channels section). Reuse `channelsRequest`, `ensure`, `art()`, `cached`, and the existing id validators.

1. `GET /api/channels/:connectionId/guide?start=<unixSec>&hours=<1-6>`
   - Connection must be `type==='channels'`. `ensure(req,c,{type:'live'})`, which applies the same access rules as live playback (honors household grants).
   - Clamp `hours` to 1–6 (default 3) and `start` to [now − 2 h, now + 7 days]. **Align start down to the half hour.** Cache per (connection, aligned start, hours) for 60 s.
   - Upstream: `/devices/ANY/guide?time=<aligned>&duration=<hours*3600>`.
   - Output (trimmed, so no `Raw`, `FullSummary`, `SearchScore`, `ProgramID`, or `Station` reaches the client):
     ```
     { start, end, channels: [{ id:'live:<number>', number, name, callSign?, logo?: <art() media URL>, hd?: bool,
         source?: <source_name joined from /api/v1/channels by number>,
         airings: [{ start, end, title, episodeTitle?, summary? (≤400 chars), image?: <art() URL>,
                     season?, episode?, isNew, isLive, genres? (≤3) , seriesId? }] }] }
     ```
   - Keep only airings overlapping [start,end) and sort them by start. Sort channels numerically by number (reuse the v1 comparator). Drop channels whose number fails the v1 `channelsNumber` regex.
   - Channel `logo` uses `art()`. **Airing images**: register via `art()` only for airings that are currently on (now ∈ [start,end)). Other airings get `image` lazily through endpoint 3, to bound the number of encrypted artwork descriptors per response (target < 400 `art()` calls per response).
   - HD and source come from a cached `/api/v1/channels` read (already used by the v1 catalog). Hidden channels from `/api/v1/channels` are excluded too.
2. `GET /api/channels/:connectionId/now`: the same output shape from `/devices/ANY/guide/now`, with each channel holding at most one airing, plus `next` (the following airing, from the same request as the 3 h guide when cached, otherwise omitted). Used by the phone and narrow "On now" list. Cache 60 s.
3. `GET /api/channels/:connectionId/airing?channel=<number>&time=<unixSec>`: returns one airing's details, including `image` via `art()` and `summary` (≤1500 chars). Validate the channel with `channelsNumber` and `time` as an integer. Read from the cached guide window that contains `time` (fetch a 1 h window if none). 404 if not found.
4. Remote-scope: allow phone remote sessions to `GET` endpoints 1–3 (add these to the remote allowlist regex in `server/index.js`: `^/channels/[^/]+/(guide|now|airing)$`). **This is the one permitted `server/index.js` change.**
5. Connection test error message: when `/status` responds 401/403 or a non-JSON HTML page (for example, a remote-access URL behind a proxy), raise `providerError('Channels DVR refused this address. Use the server\'s local network address, for example http://192.168.1.20:8089.', 400)`. Background: Cesar created a second connection using his public remote hostname, and every browse returned "Provider returned HTTP 403".

## Frontend

### A. Live TV tab: guide grid (screen) — `src/ChannelsGuide.tsx` + `src/channels-guide.css` + pure helpers in `src/channels-guide.ts`

When the user has at least one `channels` connection, the **Live TV** view (`LibraryBrowser` mode `live`) shows the guide at the top. If there are several Channels connections, add a connection switcher. Other live sources (M3U/Xtream) keep their existing shelves below it.

- Layout: a sticky left column (channel logo, number, name; about 150 px wide), a sticky time header with 30-minute ticks, program cells sized by duration (default 1 min = 6 px, about 360 px per hour), and a vertical **now line**. Current-program cells are highlighted.
- Opens scrolled so "now" is near the left edge. A **Now** button jumps back. Horizontal scroll loads the next 3 h window when the user is within 1 h of the loaded end (max 24 h ahead). Vertical scroll covers all channels.
- **Performance (Tesla browsers, older Intel Atom included):** use row virtualization, rendering only visible rows plus about 6 overscan rows, based on scrollTop and a fixed row height (about 72 px). No per-cell timers: a single 30 s interval updates the now-line position and "on now" state. Avoid heavy shadows or filters on cells.
- **Interactions (touch-first, ≥44 px targets, no hover-only UI):**
  - Tap a **channel logo** or a **current** program to play that channel. Use the existing `onOpen` with the v1 live MediaItem (`id:'live:<number>'`, `type:'live'`, `providerType:'channels'`, `connectionId`, title `"<number> <name>"`).
  - Tap a **future or past** program to open a details sheet (endpoint 3): title, episode, time range, summary, image, and a **Watch channel** button. No recording scheduling in v2.
- Filters (chips): All · each `source` value (e.g. antenna / IPTV / sports lineups) · **Favorites**. Favorites = channels the user starred through the existing `onStar`/stars mechanism with `{connectionId, kind:'category'?}` → add `kind:'channel'` if `Starred.kind` allows it; otherwise use `favorites` of the live MediaItem. Pick whichever fits the existing types with the smallest change, and document it.
- Search box: filters channels by number, name, or the current program's title.
- Narrow layout (< 700 px, i.e. phone or portrait): render the **On now** list instead of the grid (B).

### B. On now list — `src/ChannelsOnNow.tsx`

A vertical list, one row per channel: logo, number, name, current title with a thin progress bar (elapsed/duration), and "Next: <title> <time>". Tap to play. Same filters and search as the grid. Used:
- In the narrow layout of A.
- In the **phone remote** (`src/RemoteLibrary.tsx`) when browsing a Channels connection's Live TV: tapping sends that channel to the screen through the existing remote `load` command path (the same path the phone uses for any playable title).

### C. Recordings everywhere

- `src/library-browser.ts` `unifiedShelves`: add `channels`:
  - mode `series` → shelf "<name> · Recorded shows" from catalog parent `channels:shows` (12 items).
  - mode `movies` → shelf "<name> · Recorded movies" from `channels:movies`.
  - mode `live` → no shelf (the guide replaces it).
  - Opening a series item (`show:<id>`) must reach the existing episodes view through the v1 catalog. Verify `onBrowseSeries`/`SourceBrowser` handles `show:` items as series.
- **Home**: add a "Recently recorded" shelf for each Channels connection: the latest 12 completed and not-yet-watched episodes and movies across all shows, newest first, with resume progress. If the existing catalog can't produce this cross-show list cheaply, add `kind=recent` support to the v1 Channels catalog, served from `/api/v1/episodes` + `/api/v1/movies` (exclude cancelled/corrupted, sort by `created_at` desc, limit 12). Follow the existing `home-library.ts` preview caching pattern.

## Tests (synthetic only)

New `tests/channels-guide.test.js` (server, with injected `remoteData`, as in `tests/channels.test.js`) covering:
1. Guide: half-hour alignment, clamp on `hours` and `start`, numeric sort, hidden-channel exclusion, overlap filter, trimmed fields (assert no `Raw`/`FullSummary`/`ProgramID`/`Station`/Channels base URL/`path` in the JSON), source/hd join, art registered only for current airings.
2. `/now` shape, and the `/airing` lookup plus validation (bad channel/time → 400; missing → 404).
3. Access: a household account without a `live` grant on the connection gets 403. A remote-scope session can GET guide/now/airing but nothing new beyond that. A non-channels connection id gets 400.
4. Caching: two calls within 60 s make one upstream request.
5. Connection test: 403 or an HTML page produces the new friendly message.

Frontend pure helpers in `src/channels-guide.ts` with `tests/channels-guide-ui.test.js` (the repo tests TS helpers the same way existing `*-ui`/helper tests do; mirror that approach), covering: time→pixel mapping, now-line position, the visible-row window computation (virtualization), the next-window trigger, filter/search logic, and the narrow-layout switch threshold.

`unifiedShelves` channels branches: add cases to the existing library-browser tests, if present, or to the new test file.

## Visual verification (required)

Add `scripts/fake-channels-dvr.mjs`, a dev-only synthetic Channels server on 127.0.0.1 serving `/status`, `/api/v1/channels`, `/devices/ANY/channels`, `/devices/ANY/guide`, `/devices/ANY/guide/now`, `/api/v1/shows`, `/api/v1/shows/:id/episodes`, `/api/v1/episodes`, and `/api/v1/movies`. Use about 40 synthetic channels across 3 sources, generated programs, synthetic titles, and placeholder SVG/data images. No media needs to play.
Run `npm run dev` against it with a disposable `DATA_DIR`. Capture screenshots in Chrome at **1920×1200** (front screen), **1280×720** (rear screen), and **390×844** (phone): Live TV guide, the details sheet, On now, the TV Shows shelf with recordings, and the Home "Recently recorded" shelf. Save them under `docs/screenshots/channels-guide/` and **look at them**, fixing obvious layout breakage before submitting. Note that the dev CSP is off; production CSP allows `img-src https: data:`.

## Constraints

- Do not modify `vendor/tesplayer/**`.
- Do not change v1 Channels playback, heartbeat, or release behavior.
- Keep everything inside the existing auth, profile, access, and remote-scope model.
- Run the full suite: `npm test && npm run build`.

## Out of scope

Scheduling or cancelling recordings, deleting recordings, a guide for M3U/Xtream sources, commercial skip, and Channels collections/virtual channels.
