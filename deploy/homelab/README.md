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

## Deploy / update

```sh
cd ~/hermes/stacks/tesplay
git pull --ff-only
docker compose -f compose.yaml -f deploy/homelab/compose.homelab.yaml up -d --build app
docker exec nginxproxymanager curl -fsS http://10.42.90.44:4174/api/health
```

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
