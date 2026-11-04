# Using TesPlay

[Back to the README](../README.md)

## Tesla rear screen

On a Tesla browser reporting 1280 × 720 (measured Model 3 rear-browser size) or 1280 × 800 (supplied panel specification), TesPlay opens the Soft Glass phone-remote screen automatically. Detection uses the reported display size and pixel ratio, including CSS-pixel rounding, rather than the browser viewport. A desktop or tablet at the same resolution keeps the regular interface; other Tesla display resolutions also keep it.

Scan the QR on your phone. A signed-out screen asks you to sign in and approve it on the phone, then opens that phone's remote automatically. An authorized screen pairs a guest phone directly. Once connected, the QR disappears and a short icon guide, connection indicator and Disconnect remote button appear. Media selection and playback controls stay on the phone; video fills the rear-screen page. Disconnect stops playback, revokes guest remotes and replaces the pairing code. Some browser versions require one tap to enable sound. Exact vehicle-model identification and the browser's surrounding system UI remain firmware-dependent; verify the flow on the actual rear screen.


## QR login and account settings

On the screen choose **Sign in with your phone**, scan the QR, sign in on the phone if necessary, compare the six-digit code, and explicitly approve the screen. The code expires after five minutes and works once. The QR contains a short-lived approval credential, not your password. It is rendered locally; no QR service receives it. First-time owners can create their account on the phone using the server setup token before approving the screen.

In **Settings → Your connections → Set up with QR**, scan to open account settings on your phone. Add or edit provider URLs, passwords, API keys, playlists and OAuth connections there. Your screen refreshes the connections while the setup panel is open. Empty secret fields on an edit preserve saved values. Changing a Google OAuth client requires fresh consent for that client.

Both devices must reach the same installation. A QR containing `localhost` or `127.0.0.1` cannot connect a phone to your Mac: publish the installation and set `PUBLIC_URL=https://media.example.com`, or configure a reachable LAN address for local testing. Any existing Cloudflare Access login remains required on both devices. QR login authenticates TesPlay; it does not bypass the outer Access layer.

**Watch history** includes started and completed titles for the selected profile. Progress is checkpointed during playback, pauses and leaving the player. **Settings → Play next episode automatically** defaults on and is saved to your account. Xtream and Plex episode metadata determine the next episode across seasons, including when resumed from history. There is a five-second countdown with a **Stay here** option.

Existing accounts keep using the original database filename, session cookie, Plex client identifiers and Docker volume name. These internal names are retained deliberately so the TesPlay rename does not create a fresh installation or sign out saved accounts.


## Libraries, playlists and shared accounts

Plex opens with its actual library sections in the sidebar. Movies/TV libraries show the server’s existing hubs and collections, including recently added/watched and removal collections when supplied by that server. Click a row heading or **View all** for the complete paginated list. Plex Watchlist matches saved titles to the local server; titles absent from the server are shown as unavailable.

Home keeps the last successful preview across page reloads. IPTV and playlist catalogs persist encrypted on the server until you press **Refresh** or change the connection settings; there is no timed catalog refresh. A failed manual refresh retains the saved catalog. IPTV Home previews prefer recent titles with artwork supplied by the provider, while Movies and Series keep the complete collection.

Settings uses an overview dashboard for connections, authorized browsers, profiles and playback preferences. The compact browser table marks the current browser and lets you revoke access. The phone remote fits the viewport; Browse and Queue scroll inside the fixed header and bottom menu.

Movies, Series and Live TV combine supported libraries from connected services, with a connector filter beside search. Posters, contained channel logos and wide YouTube thumbnails follow their source. Star sidebar categories or Plex sections to keep them first.

In **YouTube → Subscriptions**, star channels to show their newest-first rows in **For you** and on Home. The add button saves videos to **YouTube → Playlists → Watch playlist** in order. **Play all** starts the first video; TesPlayer advances after its five-second countdown. This is a saved TesPlay playlist, separate from Google-owned playlists. Existing YouTube favorites migrate into it.

The owner manages people in **Settings → Household accounts**: create an account, share selected connectors and content types, restrict Plex libraries or IPTV categories, reset passwords, or disable access. Each account can also add and manage its own connections under **Settings → Connections**, alongside the libraries shared with it. Personal connections stay private to that account; shared connections can only be edited or reauthorized by their owner. Only the server owner can connect folders on the server. Shared credentials remain encrypted on the server. Each account has independent profiles, history, stars and playlists. Password resets/disable revoke sessions and approved sign-in QR codes. Changing grants takes effect on ongoing media requests too. Multiple accounts can stream independently, within the connected provider’s own simultaneous-stream allowance.

Anonymous visitors see only the QR/password login screen; private catalog, account and playback APIs require authentication.


## Rear screen troubleshooting

Open `/?screen-check=1` on the vehicle screen to see its browser identity, CSS screen size, pixel ratio and page dimensions. This opt-in page sends only those readings to the server log under `tesplay-screen-check` and displays a check code. Normal visits do not send diagnostic reports. The scaled pixel estimate is not a hardware measurement, particularly when page zoom is enabled. Rear mode recognises either the `Tesla` or `QtCarBrowser` browser identifier and still requires the specified display resolution.


## Title details, episodes and Plex continuity

Click a poster/title or its **ⓘ** to open the cinematic information modal, with artwork and title above the synopsis and playback settings. Choose audio, subtitles, quality and whether to start over before pressing Play. The play overlay starts that title directly. For a series, tap the **S/E** button to expand the floating season and episode number grids. Selecting an episode prepares its settings without playing it, and **Play S2 · E4** starts the selected episode. A resume indicator shows its current watch time. Phone browsers use a compact bottom sheet with a small poster, expandable summary and tappable audio/subtitle/quality rows. Play remains visible while the content scrolls; Plex compatibility mode is under **More options**. The player has audio selection beside subtitles, previous/next controls beside play/pause, and the same floating picker below the picture. The phone remote uses its season rail. Previous/next follow series order or the saved Watch playlist.

Available tracks depend on the source. Plex lists its audio and accessible text subtitles before playback, and can transcode to the selected quality when its server supports it. Direct files expose their container audio tracks; HLS exposes advertised audio, subtitle and quality renditions. Unsupported/absent tracks are not manufactured.

Account creation includes **Playback defaults** for audio language, subtitles and quality. Change them later under **Settings → Playback** for the selected profile. Direct playback applies these defaults, and the information modal preselects the matching available options. A title's selections take priority. Missing languages fall back to the source's audio or no subtitles; unavailable HLS resolutions use the nearest supported quality, and direct files retain their original resolution. Existing profiles keep their subtitle preferences while audio and quality begin at Automatic / Auto.

**My list → Plex Watchlist** reflects the connected Plex account; the plus button continues to manage your separate TesPlay list. **History** includes recent Plex viewing and resume positions. Opening a Plex title reads its current watch time, while TesPlay sends playback/pause/stop checkpoints back to Plex. Use the matching **Plex Home profile** for each TesPlay profile. Failed synchronization keeps local progress and shows a message. History synchronization is limited to the latest 200 titles per library, and cloud Watchlist preview to 60 entries per content kind; larger Watchlists remain paginated in Plex library browsing.

**Settings → Content → Hide YouTube Reels / Shorts** applies across Home, Highlights, YouTube, search, saved lists, history and phone browsing. It is saved to your account and shared across profiles and browsers. YouTube videos with known duration up to three minutes are hidden, including ordinary short uploads; explicitly marked Shorts are also hidden, while videos with unknown duration may remain visible. Hidden saved items are retained and return when you turn the setting off. Automatic queue navigation skips hidden videos without interrupting current playback. An existing browser choice is imported once when the account has no saved choice.
