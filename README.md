<p align="center">
  <picture>
    <source media="(max-width: 600px)" srcset="docs/assets/readme-header-mobile.svg">
    <img src="docs/assets/readme-header.svg" alt="TesPlay — Your media. Your Tesla screen. A personal cinema, hosted by you." width="1200">
  </picture>
</p>

<p align="center">
  Bring your libraries together in the Tesla browser.<br>
  Browse on the big screen, control it from your phone, and keep your place.
</p>

<p align="center">
  <a href="#quick-start"><strong>Get started</strong></a> &nbsp; · &nbsp;
  <a href="#on-your-tesla">Tesla setup</a> &nbsp; · &nbsp;
  <a href="#on-the-rear-screen">Rear screen</a> &nbsp; · &nbsp;
  <a href="#screenshots">Screenshots</a> &nbsp; · &nbsp;
  <a href="docs/usage.md">User guide</a> &nbsp; · &nbsp;
  <a href="#license--credit">License</a>
</p>

<p align="center">
  <sub>Self-hosted &nbsp; / &nbsp; Your own media &nbsp; / &nbsp; No TesPlay subscription</sub>
</p>

![TesPlay home with a demonstration media library](docs/screenshots/home.png)

> **Try it out on your Tesla screen** — [set up your own instance](#quick-start), open its HTTPS address in your Tesla browser, and sign in with your phone. Use TesPlay only while safely parked, with the vehicle in Park.

## Made for your collection

| Your libraries, together | Your phone, in control |
| :--- | :--- |
| Browse movies, shows and live TV. Search connected sources and pick an episode from the title details. | Pair by QR code, browse your library and control playback, seeking, volume and the queue. |
| **Pick up where you left off**<br>Profiles, My list, history, saved progress and automatic next-episode playback. | **Send it to the screen**<br>Send a direct video/HLS link or a temporary phone upload. Convert supported uploads with FFmpeg. |
| **Playback that fits the source**<br>TesPlayer supports compatible files, HLS, MPEG-TS and audio, with available track and quality choices. | **A space for your household**<br>Owner-managed accounts, library permissions, encrypted credentials and revocable browser access. |

Connect **Plex · Xtream Codes · M3U · Google Drive · Stremio addons · YouTube · Radio**. You supply your own media, accounts and any required service access.

<details>
<summary><strong>Explore integrations, playback support and limits</strong></summary>

| Source | Supported capabilities | What you bring |
| --- | --- | --- |
| Plex | Libraries, collections, Plex Home selection, Watchlist, progress sync and compatible playback/transcoding | A reachable Plex server and authorized account |
| Xtream Codes IPTV | Live TV, short EPG, movies, series and selectable categories | Your legally authorized provider URL and credentials |
| M3U IPTV | Playlist import and grouped channels | Your own authorized playlist; XMLTV guide import is not implemented |
| Google Drive | OAuth, folder browsing and streaming supported media | Your Google OAuth web client and enabled Drive API |
| Stremio addons | Account/QR linking or configured addon links, catalogs, search, episodes and direct HTTP(S)/HLS sources | Authorized addons and any access they require; raw torrents and DRM sources are unsupported |
| YouTube | Search, Google-authorized channel subscriptions/playlists and optional TesPlayer playback | Data API key or OAuth client for browsing; optional yt-dlp resolver for playback |
| Radio | Station search, favorites and audio playback | A reachable, compatible station stream |

Service availability, codecs, provider quotas and simultaneous-stream limits still apply. Native Crunchyroll, Jellyfin/Emby adapters, DRM playback and general screen mirroring are not implemented. Existing server-folder connections remain supported, but Local/SMB is not offered as a new connection in the UI.

TesPlayer uses WebCodecs, canvas and Web Audio. Plex can provide compatibility transcoding. Recognized Tesla rear-screen browser/display combinations open a remote-first interface; support depends on vehicle firmware and browser capabilities.

Run on Node.js with SQLite or use Docker Compose on a Mac, Linux host or 64-bit Raspberry Pi. The player source is bundled, so there is no second repository to clone. The maintainer has tested six Intel/AMD Tesla configurations; see [tested vehicles](docs/compatibility.md). Raspberry Pi hardware has not been verified.

</details>

## Screenshots

<details>
<summary><strong>Take a closer look — library, connections and phone</strong></summary>

### Browse your collection

![Movie browsing with a source filter and demo posters](docs/screenshots/library.png)

### Connect your services

![Settings with the supported connection options](docs/screenshots/connections.png)

### Choose from your phone

<p align="center">
  <img src="docs/screenshots/phone.png" alt="Title details and playback settings on a narrow phone display" width="280">
</p>

</details>

<sub>Screenshots show the actual interface with a disposable account, fictional titles and illustrative artwork. No catalog or playable content is bundled. These are interface previews, not photographs or hardware compatibility tests of a Tesla screen.</sub>

## Quick start

**Docker Compose** is the quickest path. You need Git, a running Docker engine and Compose v2. Raspberry Pi requires a 64-bit OS.

```sh
git clone https://github.com/rdvnit/TesPlay.git
cd TesPlay
cp .env.example .env
chmod 600 .env
mkdir -p media
docker compose up -d --build app
docker compose logs app
```

**Then open [localhost:4174](http://127.0.0.1:4174).** Use the setup code in the logs to create the owner account with a password of at least 12 characters. Add your services in **Settings → Connections** and other people in **Settings → Household accounts**.

> **Connecting your car or phone?** The default port is available only on the host computer. Continue with [Tesla setup](#on-your-tesla) to configure reachable HTTPS access.

<details>
<summary><strong>Storage and Docker defaults</strong></summary>

SQLite and the encryption key persist in the `aperture-data` Docker volume. The `./media` folder is mounted read-only at `/media`. Docker includes FFmpeg/FFprobe for temporary phone-video conversion. Keep the host running while you use TesPlay.

</details>

<details>
<summary><strong>Prefer Node.js? Install without Docker</strong></summary>

Use **Node.js 22.13 or newer**, npm and Git. Install FFmpeg/FFprobe separately if you want phone-video conversion. Node's built-in SQLite may print an experimental-feature notice on some supported versions.

```sh
git clone https://github.com/rdvnit/TesPlay.git
cd TesPlay
npm ci
cp .env.example .env
chmod 600 .env
npm run build
npm start
```

Open **http://127.0.0.1:4174** and use the terminal's setup code. `npm start` loads `.env` when present. For local development, use `npm run dev`: Vite serves the UI at **http://127.0.0.1:5173** and proxies the API to port 4174. Keep development servers private.

</details>

## On your Tesla

Both devices must be able to reach the same installation. Playback needs a secure browser context and supported WebCodecs decoders, so use **HTTPS** for your car/phone deployment.

1. Choose a hostname you control, such as `media.example.com`. Configure an HTTPS reverse proxy or tunnel to the app. TesPlay does not provision a domain, certificates or tunnel for you.
2. In your private `.env`, set `PUBLIC_URL=https://media.example.com`. This exact browser origin controls QR links, OAuth callbacks and secure cookies.
3. Set `TRUST_PROXY=1` only when there is one trusted proxy hop and the app's origin is reachable solely through it. Otherwise retain the default `0` or configure your actual trusted proxy topology.
4. Restart the app: `docker compose up -d app` for Docker, or restart `npm start` for Node. Use the HTTPS address to sign in once HTTPS is configured.
5. Open the same address in the Tesla browser **while parked**. Choose **Sign in with your phone**, scan the QR, compare the displayed code and approve the screen. Pair playback controls through **Settings → Account → Pair a phone with this screen**.

<details>
<summary><strong>Cloudflare Tunnel, Access and proxy details</strong></summary>

The optional Compose tunnel profile works with an existing remotely managed Cloudflare Tunnel. Set its private `CLOUDFLARE_TUNNEL_TOKEN` in `.env`, configure the tunnel route to `http://app:4174`, and run:

```sh
docker compose --profile tunnel up -d --build
```

If you use Cloudflare Access, both your phone and vehicle browser must complete that login as well as TesPlay sign-in. For a proxy running on the Docker host, the upstream is `http://127.0.0.1:4174`. `localhost` in a QR link refers to the device scanning it, so leave loopback URLs for host-only testing. See the [deployment guide](docs/deployment.md) for network, OAuth, backup and acceptance details.

</details>

## On the rear screen

**Launch your deployed TesPlay website through a link in a YouTube video description.** Use your own video; setting its visibility to **Private is recommended**.

### 1. Prepare your launch link

Create or choose a regular YouTube video you can access on the car. Add your deployed TesPlay **HTTPS address** to its description, for example:

```text
Open TesPlay:
https://media.example.com
```

Replace the example with your installation's address. Use the website URL, not the GitHub repository URL or `localhost`. For a private video, the rear-screen YouTube app must be signed into an account allowed to view it. See [YouTube's private-video guidance](https://support.google.com/youtube/answer/77272).

### 2. Open it on the Tesla rear screen

While safely parked with the vehicle in Park:

1. Open **YouTube on the rear screen** and open your video.
2. Expand the video's **description** and tap the link to your deployed TesPlay website. Confirm opening the website if prompted.
3. TesPlay opens in the rear-screen browser. On supported rear-screen displays, its phone-pairing interface appears automatically.
4. **Scan the QR code with your phone.** If the screen is signed out, sign in on your phone, match the displayed code and approve the screen. An already authorized screen can pair your phone directly.
5. On your phone, open **Browse**, choose a title and press **Play**. Video fills the rear screen; use the phone to pause, seek and adjust volume. If prompted, tap the rear screen once to enable playback or sound.

If the description URL is not clickable, use a regular video rather than a Short and check [YouTube's external-link requirements](https://support.google.com/youtube/answer/13748639), including access to advanced features.

The YouTube video supplies the launch link. Opening TesPlay this way does **not** require enabling TesPlay's optional YouTube playback resolver.

| Pair your phone | Ready to choose a title |
| :--- | :--- |
| ![TesPlay rear-screen interface waiting for a phone to scan the pairing QR](docs/screenshots/rear-pairing.png) | ![TesPlay rear screen after the phone has connected](docs/screenshots/rear-connected.png) |

<p align="center">
  <img src="docs/screenshots/rear-phone-remote.png" alt="TesPlay phone remote paired with the rear screen" width="280">
</p>

<sub>Interface previews use a disposable demo installation with simulated rear-screen browser properties. The QR points to a nonfunctional example address. Browser controls and link-opening behavior can vary with vehicle firmware.</sub>

## Tested vehicles

The maintainer reports **no issues** on the following configurations:

| Vehicle | Model year | Processor |
| :--- | :--- | :--- |
| Model 3 Long Range | 2019, 2021 | Intel |
| Model 3 Long Range | 2023 | AMD |
| Model Y Long Range | 2023 | AMD |
| Model 3 Performance | 2026 | AMD |
| Model Y Performance | 2026 | AMD |

These are the only vehicle configurations tested. See [compatibility details](docs/compatibility.md) for scope and reporting another configuration.

## Install with your AI

Copy this into your coding assistant:

```text
Install TesPlay from https://github.com/rdvnit/TesPlay for personal,
noncommercial use. Read README.md and .env.example, then use Docker
Compose or Node.js 22.13+. Preserve existing settings and data, keep
credentials private, build and start the app, and verify /api/health.
Show me where to find the owner setup code. Help configure my own
HTTPS hostname and PUBLIC_URL for my parked Tesla and phone. Ask for
any missing credentials. Do not change repository visibility or
supply media or unauthorized content.
```

## Setup & maintenance

| Looking for… | Start here |
| :--- | :--- |
| QR sign-in, profiles, playlists and rear-screen help | [User guide](docs/usage.md) |
| HTTPS, Google OAuth, backups and moving hosts | [Deployment guide](docs/deployment.md) |
| The bundled player and supported playback paths | [TesPlayer integration](docs/tesplayer.md) |

<a name="optional-youtube-resolver"></a>

<details>
<summary><strong>Enable optional YouTube playback</strong></summary>

YouTube playback is opt-in. With Docker:

```sh
docker compose --profile youtube up -d --build
# If you also use the configured tunnel:
docker compose --profile youtube --profile tunnel up -d --build
```

The resolver runs privately on the Compose network and does not publish a host port. Browsing still needs your own YouTube Data API key or Google OAuth client. OAuth enables channel subscriptions and playlists; YouTube account watch history and Home recommendations are not imported.

For a native install, install [yt-dlp with its default extras](https://github.com/yt-dlp/yt-dlp#installation), set `YOUTUBE_ENABLED=true` in `.env` and restart the server. Set `YT_DLP_PATH` if needed. The Docker resolver version is pinned through `YT_DLP_VERSION` in `.env.example`; upstream changes can require updating it. Restricted or unresolved videos may fail.

Google Drive and YouTube OAuth require your own Google web client, the relevant enabled API and exact redirect URIs: `https://media.example.com/api/drive/callback` and `https://media.example.com/api/youtube/callback`. Configure clients through Connections or the installation-level `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. See [Google OAuth setup](docs/deployment.md#google-drive-oauth).

</details>

<details>
<summary><strong>Back up, update or verify an installation</strong></summary>

Back up **both the SQLite database and its encryption key** before updating. Native installs can use:

```sh
node --env-file=.env scripts/backup.mjs ./data ./backups
```

An environment-supplied `ENCRYPTION_KEY` must also be retained; the backup helper records it privately. See [Docker backup and restore](docs/deployment.md#backups-and-moving-hosts) for container commands.

To update an installation after making a backup:

```sh
git pull --ff-only
docker compose up -d --build app
# Native alternative:
# npm ci && npm run build && npm start
```

Restart an existing native process rather than launching a second copy on the same port. Stop an old native process before replacing its dependencies/build. If you enabled the YouTube profile, include it when rebuilding that service. **Do not run `docker compose down -v` during updates**: it deletes saved application data.

To verify a source checkout:

```sh
npm ci
npm test
npm run build
```

Automated tests use controlled fixtures. The [compatibility list](docs/compatibility.md) records the maintainer’s vehicle results. Provider authorization, your network setup and unlisted devices require separate checks; Raspberry Pi hardware remains unverified. [Usage and troubleshooting](docs/usage.md) cover rear screens, QR sign-in, profiles, playlists and playback settings. [TesPlayer integration](docs/tesplayer.md) documents the bundled engine.

</details>

## Community reports

Built and maintained by **[rdvnit](https://github.com/rdvnit)**, a single developer. There is no dedicated support service. Report reproducible bugs through [GitHub Issues](https://github.com/rdvnit/TesPlay/issues); community reports guide fixes when time permits, with no guaranteed response or turnaround.

Read [how to report an issue](SUPPORT.md), [contribution guidance](CONTRIBUTING.md) and the [changelog](CHANGELOG.md).

## Before you use it

- **No content is provided.** The author does not provide, host, sell or distribute movies, TV channels, IPTV subscriptions, playlists, streaming credentials or media libraries. Connect only content and accounts you are authorized to access.
- **No endorsement of piracy.** TesPlay and its author do not endorse, encourage or authorize copyright infringement. You are responsible for your sources, permissions and compliance with applicable law and service terms. Connecting an addon or provider does not grant rights to its content.
- **Parked use only.** Do not use TesPlay while your Tesla is in Drive, moving or being driven. Do not watch video or operate the interface while driving. Use it only when safely parked with the vehicle in Park, follow vehicle safety restrictions, and never attempt to bypass them.
- **Independent project.** TesPlay is not affiliated with, endorsed by or sponsored by Tesla or any connected media service. Names and trademarks belong to their respective owners.
- **No access-control or DRM bypass.** TesPlay does not grant access to paid services or implement DRM circumvention. Third-party accounts, permissions and fees remain your responsibility.
- **Provided as is.** Availability, browser compatibility and uninterrupted playback are not guaranteed. The license contains the applicable warranty and liability terms.

## License & credit

Created by **[rdvnit](https://github.com/rdvnit)**. The original TesPlay code and bundled owner-authored TesPlayer code are available under the [PolyForm Noncommercial License 1.0.0](LICENSE), with the [required attribution notice](NOTICE).

You may use, study, modify and share it for permitted noncommercial purposes, keeping the license and credit notice with redistributed copies and modifications. Commercial use, including selling the code or a commercial derivative/service, requires separate permission from the author. This is **noncommercial source-available software**, not an OSI-approved open-source license. Third-party dependencies, fonts and components retain their own licenses; see [credits](docs/credits.md).
