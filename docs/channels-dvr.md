# Channels DVR connection: design spec (fork feature)

Status: design approved by Developer (Opus) on 2026-11-04 for implementation on branch `feature/channels-dvr`.
API facts below were observed read-only against a real Channels DVR server (version with `/api/v1`) and
from the Channels admin web player bundle. **Tests must use synthetic fixtures only.** Never embed real titles,
paths, IPs, or server responses in tests.

## Goal

Add a native `channels` connection type. TesPlay can then browse and play **live TV, recorded TV shows
and recorded movies** from a LAN Channels DVR server, with resume and watched-state sync. Playback goes
through TesPlay's existing authenticated media proxy (`media.register`). The Channels server stays LAN-only
and is never exposed to the browser.

## Channels DVR server API (no auth, LAN only)

Base URL comes from the connection config, e.g. `http://192.0.2.10:8089` (synthetic).

| Purpose | Request | Notes |
| --- | --- | --- |
| Health/test | `GET /status` | JSON object, includes a `features` object |
| Live channels | `GET /api/v1/channels` | `[{id, number, name, hd, hidden, source_id, source_name}]`; `number` like `"9.1"`, `"36.1"`, `"215"`, `"101.11"` |
| Channel logos | `GET /devices/ANY/channels` | `[{GuideNumber, GuideName, Logo, HD, Hidden, VideoCodec, AudioCodec, ...}]`; join on `GuideNumber === number` |
| Recorded shows | `GET /api/v1/shows` | `[{id, name, summary, image_url, release_year, genres, categories, episode_count, number_unwatched, favorited, last_recorded_at, created_at, updated_at}]`. `id` is usually numeric but **may contain letters and spaces**: treat it as an opaque string and `encodeURIComponent` it in paths |
| Episodes of a show | `GET /api/v1/shows/{id}/episodes` | same shape as `/api/v1/episodes` items |
| All episodes | `GET /api/v1/episodes` | items: `id` (numeric string), `show_id`, `title`, `episode_title?`, `season_number?`, `episode_number?`, `summary?`, `image_url`, `thumbnail_url`, `duration?` (seconds, float), `playback_time` (seconds), `watched`, `completed`, `processed`, `cancelled`, `corrupted`, `delayed`, `original_air_date?`, `channel`, `genres`, `tags`, `created_at` (ms). **Never forward `path`** (filesystem path) |
| Movies | `GET /api/v1/movies` | episode-like plus `release_year`, `content_rating?`, `duration` |
| Query params | `?limit=N`, `?watched=false`, `?sort=…&order=desc` | observed working on `/api/v1/episodes` |
| Live HLS | `GET /devices/ANY/channels/{number}/hls/master.m3u8` | Channels' web player uses this with hls.js, so it is expected to be H.264/AAC. Codec output is verified separately during live acceptance, not in tests |
| Recording HLS | `GET /dvr/files/{id}/hls/master.m3u8` | VOD |
| Keep session alive | `PUT /devices/ANY/channels/{number}/hls` or `PUT /dvr/files/{id}/hls` | The Channels web player sends this **every 2 s** while the player is open, and treats a non-OK response as a dropped session |
| Release session | `DELETE` on the same `…/hls` base | Frees the tuner/transcoder. Important: OTA tuners and IPTV connection slots are limited |
| Save position | `PUT /dvr/files/{id}/playback_time/{integerSeconds}` | |
| Mark watched | `PUT /dvr/files/{id}/watch` | |
| Commercial chapters | `GET {hlsBase}/chapters.vtt` | optional, out of scope for v1 |

Image URLs: `image_url` is usually an external HTTPS CDN URL. Some `image_url` values and all
`thumbnail_url` values point at the Channels server itself. Register both via the existing
`art()` helper with `allowedPrivateHosts: privateHosts(c.config.url)`.

## Server changes

1. `server/connection-routes.js`: add `"channels"` to `supportedConnections`. Config is `{ url }`; there is no secret.
2. `server/access.js`: `supportedKinds.channels = ['live', 'series', 'movie']`.
3. `server/providers.js`, following the existing per-type pattern:
   - `channelsRequest(c, path, options)`: builds the URL **only** from `validateRemoteUrl(c.config.url)` plus a
     server-built path, using `allowedPrivateHosts: privateHosts(c.config.url)`. Never pass client-supplied URLs or paths through.
   - `/api/connections/:id/test`: call `GET /status`; on failure, raise a clear `providerError`.
   - `/api/catalog`:
     - Root (no `parentId`): three folders, `Live TV` (`channels:live`), `TV Shows` (`channels:shows`) and `Movies` (`channels:movies`).
       Each folder goes through `permitted(...)` for its kind.
     - `channels:live`: channels from `/api/v1/channels`, joined with logos from `/devices/ANY/channels`. Exclude `hidden` channels.
       Each item is `type:'live'`, `id:'live:<number>'`, `category: source_name` (for filtering), with title `"<number> <name>"` and an HD badge if `hd`.
       Sort numerically by channel number (`9.1` before `36.1` before `215`).
     - `channels:shows`: series items, `id:'show:<id>'`, artwork, summary, unwatched count. Sort by `last_recorded_at` desc.
     - `show:<id>`: episodes from `/api/v1/shows/{id}/episodes`, as `type:'episode'` items with `id:'file:<fileId>'`, `seriesId`,
       season/episode when present, `duration`, and resume position from `playback_time`. Exclude `cancelled`. Sort by season/episode when both
       are present, otherwise by `created_at` desc.
     - `channels:movies`: movie items, `id:'movie:<fileId>'`.
     - Support the existing `q` (title filter) and pagination via `paginate`/`pageData` like the other providers. Cache list
       reads with the existing provider cache (`cached`/`catalogCached`); keep the TTL short (≤60 s) because recordings change.
   - `/api/playback`:
     - `live:<number>`: validate `^\d{1,5}(\.\d{1,3})?$`. Register `{kind:'hls', url: base+'/master.m3u8', channelsSessionPath: base, allowedPrivateHosts}`
       where `base = /devices/ANY/channels/<number>/hls`. Respond `{url, type:'hls', isLive:true, streamKind:<what m3u/xtream HLS live uses>, provider:'channels'}`.
     - `file:<id>` / `movie:<id>`: validate `^\d{1,10}$`. Fetch metadata for the resume position, then use `base = /dvr/files/<id>/hls`. Respond with
       `isLive:false`, `provider:'channels'`, plus the resume position in whatever field the Plex path uses (look at how Plex provides resume time and mirror it).
     - Always call `ensure(req, c, {type: kind, ...})` before registering.
   - `/api/playback/options`: return `{audio:[], subtitles:[], qualities:[]}` for channels, as xtream does.
   - `/api/episodes` and `/api/episodes/next`: support channels series so next-episode autoplay works (order as in the catalog).
   - Progress: extend the progress hook. Either add `ctx.syncChannelsProgress` called next to `ctx.syncPlexProgress` in
     `server/library-routes.js`, or generalize it. For `file:`/`movie:` items: `PUT /dvr/files/{id}/playback_time/{floor(seconds)}`. On `stopped`
     at ≥97% of duration, also `PUT /dvr/files/{id}/watch`. Never call this for live items. Sync failures must keep the local progress (match the Plex behavior).
4. `server/media.js`:
   - `heartbeatHandler`: additionally accept `connection.type === 'channels' && item.kind === 'hls'` when `item.channelsSessionPath` matches
     `^/(devices/ANY/channels/\d{1,5}(\.\d{1,3})?|dvr/files/\d{1,10})/hls$`. Send `PUT <config.url><channelsSessionPath>` with a 10 s timeout and the
     same abort/controller handling as Plex. 2xx means ok and refreshes `item.expires`. Otherwise return 502 "Channels DVR could not keep this stream active."
   - `releaseHandler`: for released resources that carry `channelsSessionPath`, fire a best-effort `DELETE <config.url><channelsSessionPath>` with a short timeout.
     Do not block or fail the release response on it, and never throw.
5. Do not modify `vendor/tesplayer` (provenance-checked by `npm run check:player`).

## Frontend changes

- `src/connection-fields.ts`: add a `channels` entry with a single `url` field, label "Channels DVR server URL", placeholder `http://192.168.1.20:8089`.
- Add `channels` to the connection-type picker (e.g. `src/ConnectionServices.tsx` / `ConnectionEditor.tsx`, wherever types are listed), named "Channels DVR".
- `src/types.ts`: add `'channels'` to the `provider` union.
- Generalize `src/plex-playback-heartbeat.ts` (keep the exported name or add a wrapper so the existing tests stay valid) so that
  `provider === 'channels'` HLS playback pings `POST ${playback.url}/heartbeat` every **5 s**, while Plex stays at 15 s. It keeps running while paused,
  as Plex does. Wire it in `src/TesPlayer.tsx` where the Plex heartbeat starts.
- Any provider icon or label maps: add a sensible entry for `channels`.

## Tests (synthetic only), new file `tests/channels.test.js`

Use the existing `createApp`/`registerProviderRoutes` test seams with an injected `remoteData` (see `tests/providers.test.js`), and a local
fake HTTP server where `media.js` upstream calls (heartbeat/release) need a real socket. Cover at least:

1. Connection create/test: `/status` OK passes; non-JSON or 500 gives a clean error.
2. Root catalog returns the three folders; household access grants with kinds limit which folders appear.
3. Live list: hidden channels excluded, logos joined, numeric sort, `live:` ids, and no Channels base URL in the response JSON.
4. Shows → episodes: ordering, `cancelled` excluded, `path` never present anywhere in responses, show ids with spaces are path-encoded.
5. Playback: invalid ids rejected (400/404), with traversal attempts such as `live:../../x` and `file:1/../2`. A valid live/file returns an `/api/media/m_…` URL;
   fetching it proxies `master.m3u8` from the fake server.
6. Heartbeat sends `PUT` to the exact session path; a non-channels or invalid `channelsSessionPath` gives 400. Release sends a best-effort `DELETE`.
7. Progress sync: `PUT playback_time/<int>`; `watch` only at ≥97% plus stopped; live items never sync; upstream failure keeps local progress.
8. Frontend heartbeat helper: 5 s interval for channels and 15 s for Plex (extend `tests/plex-playback-heartbeat.test.js` style).

## Out of scope for v1

Guide/EPG now-next, commercial-skip chapters, DVR scheduling/deleting, Channels virtual channels/collections, video groups.
