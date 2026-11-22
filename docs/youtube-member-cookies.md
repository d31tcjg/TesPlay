# YouTube: members-only / sign-in-required playback via account cookies

Status: spec, 2026-11-21 (Developer). Cesar chose to play members-only videos (e.g. `JApE9dxTiLk`, a channel-membership tier video) through TesPlay. The Google OAuth connection (`youtube.readonly`) only covers the Data API (browsing). yt-dlp can't use OAuth for playback (YouTube blocked it in 2024). The only supported route is browser cookies (Netscape `cookies.txt`) from Cesar's signed-in account.

## Behaviour

1. **New env `YOUTUBE_COOKIES_FILE`** (resolver side, `createYouTubeResolver({ cookiesFile })`). Default unset = feature off. Behaviour is then byte-identical to today.
2. **Anonymous first; cookies only on retry.** Every resolve first runs exactly today's args, with no cookies. Retry **once** with cookies only when the first attempt failed with an account-gated error and a cookies file is configured and readable. Account-gated means yt-dlp stderr matches (case-insensitive) any of:
   - `members on level` or `available to this channel's members` or `join this channel`
   - `sign in to confirm your age` or `age-restricted`
   - `private video`
   - `sign in to confirm you('|’)re not a bot` (bot check)

   Any other failure keeps today's 502 path, with no cookie retry.
3. **Never hand yt-dlp the mounted file.** yt-dlp rewrites its cookie jar on exit, and the mount is read-only. For each retry:
   - Copy the file into a fresh `fs.mkdtemp` dir under `os.tmpdir()`, mode `0600`.
   - Pass `--cookies <copy>`, then `rm -rf` the temp dir in `finally`, even on error or abort.
   - Never write the copy back.
4. **Cookie hygiene (must be tested):**
   - Never log, print, or return cookie contents, the cookies path, or yt-dlp stderr lines that contain `cookie`.
   - Don't include stderr in error messages sent to clients.
   - Errors carry only fixed strings.
   - Startup logs at most one line: `YouTube account cookies: enabled` or `disabled`.
   - Don't read the file at startup beyond an `fs.access(R_OK)` check. Read it fresh on each retry, so Cesar can replace it without a restart.
5. **Clear errors instead of a bare 502** (a fixed message, status 403):
   - Members-only, no cookies configured: "This is a members-only YouTube video. TesPlay needs your YouTube account cookies on the server to play it."
   - Members-only, cookies configured but the retry still gated: "YouTube refused this members-only video for your account. Check your channel membership, or refresh TesPlay's YouTube cookies."
   - Age-restricted or private, with or without cookies: the equivalent "Sign-in required…" or "…refresh cookies" pair.
   - Bot check, no cookies: today's 502 message.
6. **Pass the status and message through to the app.**
   - `youtube-service.js` already relays `error.status` and `error.message`.
   - In `server/youtube.js`, the resolver-URL branch must map a resolver **403** to `providerError(<resolver's JSON error message, if it is one of the fixed strings above>, 403)`. Keep 429 and 502 as they are. Whitelist the fixed strings; never relay arbitrary text.
   - Confirm the player UI shows the message. If the existing playback error toast already shows the server's error text, no UI change is needed. Otherwise make the minimal change.
7. **Compose (homelab overlay only), `services.youtube`:**
   - `volumes: ["./secrets/youtube:/run/secrets/youtube:ro"]`
   - `environment.YOUTUBE_COOKIES_FILE: /run/secrets/youtube/cookies.txt`
   - A missing file means cookies are disabled, with no crash and health still 200. Compose creates an empty dir if `./secrets/youtube` is missing, which is fine.
   - `secrets/` is already gitignored. Add a test asserting `secrets/youtube/cookies.txt` matches `.gitignore`.
   - The `app` service gets **no** mount. Base `compose.yaml` is unchanged.
8. **Docs:** add a README section "Members-only YouTube" to `deploy/homelab/README.md`. Cover:
   - How Cesar exports cookies on the Mac (`yt-dlp --cookies-from-browser chrome --cookies <file> --skip-download <members video>`).
   - Installing the file with `install -m 600` into `~/hermes/stacks/tesplay/secrets/youtube/cookies.txt`.
   - The uid/permission note: the file must be readable by the container user. Check `docker exec aperture-youtube-1 id` and set the owner or group accordingly.
   - Refreshing when cookies expire; removal (delete the file to disable); and the account-risk note.

## Tests (synthetic only, fake `run`, temp dirs)

- No env set: one run, args identical to today (snapshot).
- Env set, first run succeeds: one run, no `--cookies`.
- Members-only failure plus cookies:
  - Second run includes `--cookies <path in a temp dir ≠ mounted path>`.
  - The copy exists during the run with mode 0600.
  - The temp dir is gone afterwards, on success, on failure, and on abort.
- Every gated pattern is covered. Non-gated errors don't retry.
- Missing or unreadable cookies file: no retry, and the fixed "needs cookies" 403.
- Log, error, and response bodies never contain the cookie file contents (use a sentinel value), the path, or stderr text.
- Resolver-URL branch: a 403 with a whitelisted message is relayed as 403. A non-whitelisted message becomes a generic 502.
- Overlay yaml: the youtube block has the mount and env; the app block is unchanged; the `.gitignore` assertion passes.

## Acceptance and deploy

- Exact gate: `npm ci && npm test && npm run build`. `vendor/` unchanged.
- Opus review covers cookie-hygiene tests, revert discrimination, and the diff scope.
- Deploy:
  - Backup, then `up -d --build`, then layered health checks.
  - Public video still resolves anonymously.
  - With no cookies yet, `JApE9dxTiLk` returns the 403 "needs cookies" message.
  - After Cesar installs the cookies, `JApE9dxTiLk` resolves.
- Rollback: `1e024cc`, or simply delete the cookies file.

## Implementation notes (2026-11-21)

- Resolver: `server/youtube.js` (`cookiesFile` option / `YOUTUBE_COOKIES_FILE`); gated stderr is classified into members/age/private/bot, never relayed. After a cookie retry, a still-gated bot check also gets the "refresh cookies" 403 (bot check without cookies stays the generic 502).
- `server/youtube-service.js` logs one line (`YouTube account cookies: enabled|disabled`) based on an `access(R_OK)` check only; the resolver re-reads the file on every retry.
- No UI change: `src/api.ts` surfaces the server `error` text via `ApiError`, and `Player.tsx` shows `errorMessage(e)`.
- Tests: `tests/youtube-cookies.test.js`; the overlay assertion in `tests/youtube-max-height.test.js` was loosened (it anchored on end-of-block).
