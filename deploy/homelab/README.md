# Homelab deployment (personal fork)

Personal, noncommercial deployment of TesPlay. Upstream: <https://github.com/rdvnit/TesPlay>
(PolyForm Noncommercial 1.0.0; keep `LICENSE` and `NOTICE`).

| Item | Value |
| --- | --- |
| Host | `cypherblue@10.42.94.4` (ubuntu-docker-server) |
| Stack path | `~/hermes/stacks/tesplay` (clone of `d31tcjg/TesPlay`, branch `homelab`) |
| Container | `aperture-app-1`, image `tesplay:local` |
| Network | `macvlan_lan`, `10.42.90.44:4174` |
| Data | Docker volume `tesplay-data` (SQLite + `encryption.key`) |
| Public URL | `https://tesplay.cypherit.dev` via NPM (10.42.90.11) + `*.cypherit.dev` cert |

## Server `.env` (never committed, mode 600)

```sh
PUBLIC_URL=https://tesplay.cypherit.dev
TRUST_PROXY=1
DATA_VOLUME_NAME=tesplay-data
MEDIA_DIR=./media
APP_IMAGE=tesplay:local
```

All other values come from `.env.example` defaults.

YouTube playback (added 2026-11-05) also needs these in `.env`:

```sh
COMPOSE_PROFILES=youtube        # build/start the internal yt-dlp resolver
YT_DLP_VERSION=2026.10.26       # bump when YouTube breaks the resolver; rebuild `youtube`
```

The homelab overlay defaults YouTube to 720p; set `YOUTUBE_MAX_HEIGHT` in `.env` to `360`, `480`, `720` or `1080` to override (invalid values warn and fall back to 1080p); recreate `youtube` after changes.

## Members-only YouTube

Members-only, age-restricted and private videos need your signed-in YouTube account. TesPlay always tries anonymously first and retries **once** with cookies only when YouTube reports the video as account-gated. The Google OAuth connection cannot do this (yt-dlp cannot use OAuth for playback).

1. Export cookies on the Mac (any members video works as the target):
   `yt-dlp --cookies-from-browser chrome --cookies cookies.txt --skip-download https://www.youtube.com/watch?v=<members video>`
2. Install on the server (never commit it; `secrets/` is gitignored):
   `install -d ~/hermes/stacks/tesplay/secrets/youtube && install -m 600 cookies.txt ~/hermes/stacks/tesplay/secrets/youtube/cookies.txt`
3. Permissions: the container user must be able to read the file. Check `docker exec aperture-youtube-1 id` and set the owner or group of the file accordingly (mode 600 needs the matching owner).
4. Apply with `docker compose -f compose.yaml -f deploy/homelab/compose.homelab.yaml up -d youtube`. The `youtube` log prints one line, `YouTube account cookies: enabled` or `disabled`. The file is re-read on every retry, so replacing it needs no restart.
5. Refresh when cookies expire (members videos start returning "refresh TesPlay's YouTube cookies"): repeat steps 1-2.
6. Remove: delete the file; cookies are then disabled and gated videos show a "needs cookies" message. A missing file never breaks health.

Account risk: YouTube may flag an account whose cookies are used from a server. Use sparingly and expect to re-export periodically. The mount is read-only and yt-dlp only sees a temporary 0600 copy that is deleted after each attempt.

## Deploy / update

```sh
cd ~/hermes/stacks/tesplay
git pull --ff-only
docker compose -f compose.yaml -f deploy/homelab/compose.homelab.yaml up -d --build
docker exec nginxproxymanager curl -fsS http://10.42.90.44:4174/api/health
docker exec aperture-app-1 node -e "fetch('http://youtube:4180/health').then(r=>console.log(r.status))"
```

To update only yt-dlp: change `YT_DLP_VERSION`, then
`docker compose -f compose.yaml -f deploy/homelab/compose.homelab.yaml up -d --build youtube`.

The first-owner setup code is only printed in the logs before the owner exists:
`docker compose -f compose.yaml -f deploy/homelab/compose.homelab.yaml logs app | grep -i setup`.

Never run `docker compose down -v`: that deletes the database and encryption key.

## Sync with upstream

```sh
git fetch upstream
git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout homelab && git merge main
```

## Rollback

`docker compose -f compose.yaml -f deploy/homelab/compose.homelab.yaml stop app`, then
have Homelab disable the NPM proxy host. The data volume is kept.
