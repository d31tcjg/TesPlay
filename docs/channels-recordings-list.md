# Channels DVR: one Recordings list, newest first

Status: spec, 2026-11-05 (Developer). Cesar's request: "I would prefer just 1 list starting with the most recent recording and scroll down."

## Today (homelab `6c708f2`)

- Channels source root folders: **Live TV**, **TV Shows** (show → episodes, sorted by season/episode), **Movies**. Built in `channelsCatalog()` in `server/providers.js`.
- The unified TV Shows page adds a "<name> · Recorded shows" shelf (`channels:shows`). The Movies page adds "<name> · Recorded movies" (`channels:movies`). See `unifiedShelves` in `src/library-browser.ts`.
- Home has "<name> · Recently recorded" (`channels:recent`): unwatched only, capped at 60, preview 12.
- The phone remote (`RemoteLibrary.tsx`) has **On now / Recordings** chips. Recordings shows the root folders.
- The live DVR currently holds about 545 files.

## Required behaviour

1. **New catalog folder `channels:recordings`**, titled "Recordings". It holds every recording on the DVR (episodes + movies) in a single list, **sorted by recorded time `created_at`, newest first**. Ties break by id descending.
   - Exclude `cancelled`, `corrupted`, and `processed === false`. Include in-progress recordings only if Channels lists them as `completed` or processed; otherwise exclude.
   - Include watched recordings: the list is the full library, not just unwatched. Watched items keep `watched:true` so the UI can show a check.
   - Episodes need a `series` grant and movies a `movie` grant (the existing `ensure`/`permitted` rules). If one kind is not permitted, the list contains only the other. If neither is, return 403 as today.
   - Item fields: reuse `channelsRecording()`. For episodes, `title` = episode title (fall back to the show name), and add `subtitle` = show name. Also add a compact `recordedAt` (ISO, from `created_at`) and `channel` (number string, if present) so the row can show "Tue Nov 4 · 10:00 PM · 36.1". Keep `seriesId` so the details/episode navigation still works.
   - **Paging:** use the existing catalog paging (`pageData` page/limit, `hasMore`). The whole list must never be serialized in one response; the default page size stays as is (≤60). Use the existing 30 s `channelsList` cache, and keep refresh/`force` behaviour.
2. **Root folders become Live TV + Recordings.** Remove TV Shows and Movies from the root listing. **Keep the `channels:shows`, `show:<id>`, `channels:movies` and `channels:recent` handlers working unchanged**, so saved favorites, history, resume and existing links keep resolving.
3. **The Recordings view is one vertical list** (one recording per row), not a poster grid and not grouped by show. It must work on every surface where the Channels Recordings folder opens: desktop/front screen, rear screen 1280×720 and phone 390×844.
   - Each row shows a thumbnail (`backdrop` or `poster`), title, a show-name subtitle for episodes, recorded date/time + channel, duration, a resume progress bar when `resumeSeconds > 0`, and a watched check.
   - Load more pages as the user scrolls down (infinite scroll), with no "page 2" buttons. Use row virtualization or windowing if the existing browser has it; otherwise incremental rendering is fine. 545+ rows must scroll smoothly on the Tesla browser.
   - Tapping a row opens the same details/play flow a recording opens today: resume works, and the play action is unchanged.
   - Use the existing list-row styles if `LibraryBrowser`/`SourceBrowser` has a list/row mode. Otherwise add a minimal list layout scoped to this folder. Don't restyle other providers.
4. **Entry points:**
   - Phone remote **Recordings** chip: opens the Recordings list directly, not the folder picker.
   - Unified **TV Shows** page: replace "<name> · Recorded shows" with "<name> · Recordings" (`channels:recordings`, newest first). Its **View all** opens the list.
   - Unified **Movies** page: remove the Channels "Recorded movies" shelf, because movies are now in the one list.
   - **Home** "Recently recorded" stays as is (unwatched, newest), but its **View all** now opens the Recordings list instead of the folder root.
5. No change to playback, keepalive/release, the quality cap, the progress/watched sync, the guide or On now.

## Tests (synthetic only; injected `remoteData` / fake DVR as in `tests/channels.test.js`)

- Server, `channels:recordings`:
  - Episodes and movies are merged and sorted by `created_at` desc, with id tiebreak.
  - Exclusions: cancelled, corrupted, unprocessed.
  - Watched items are included and flagged.
  - Grant matrix: series only, movie only, both, none (403).
  - Paging: correct `hasMore` and page boundaries, with no item lost or duplicated across pages.
  - Item fields include `subtitle`, `recordedAt` and `channel`. No `path` or Channels base URL leaks.
- Root listing is `[channels:live, channels:recordings]`, and the legacy folders still resolve.
- `unifiedShelves`: series mode returns the Recordings shelf; movies mode returns no Channels shelf; live mode is unchanged.
- UI helpers: row formatting (date/channel/duration), plus the infinite-scroll trigger and page merge (dedupe by id).
- Browser harness (follow `tests/channels-guide-layout.browser.mjs` and `scripts/fake-channels-dvr.mjs`, extending the fake to ~300 recordings with mixed `created_at`):
  - Screenshots at **1920×1200, 1280×720, 390×844** of the Recordings list top, and after scrolling past page 1, plus the phone Recordings chip.
  - Save them under `docs/screenshots/channels-recordings/` and **look at them**.
  - Assert that the first row is the newest recording and that rows are in descending order after loading page 2.

## Acceptance

- Exact gate on the final commit: `npm ci && npm test && npm run build`. `vendor/` must be unchanged vs `homelab`.
- Opus review: diff scope, screenshots, per-file revert discrimination.
- Deploy needs Cesar's OK. After deploy, a read-only check on live: the first page is newest-first and its count matches the DVR's usable file count.
