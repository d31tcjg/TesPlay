# Feature scope and limits

TesPlay brings media from accounts and sources you configure into its own browser interface. It does not supply a media catalog, provider subscription or streaming credentials. The [README integration table](../README.md#made-for-your-collection) describes supported sources.

## Supported scope

- Plex libraries, collections, Home selection, compatible streams and viewing continuity.
- Authorized Xtream Codes/M3U sources, source/category browsing and Xtream short EPG.
- Google Drive browsing through your own OAuth client.
- Stremio addon catalogs and supported direct HTTP(S)/HLS sources.
- YouTube browsing and optional resolver playback; radio streams.
- Household accounts, profiles, saved lists, progress and a paired phone remote.
- Temporary phone-video upload and supported FFmpeg conversion.

## Current limits

Native Crunchyroll playback, Jellyfin/Emby adapters, raw torrent playback, DRM circumvention, general screen mirroring, games and widgets are not implemented. M3U XMLTV import, YouTube account watch-history import and Stremio cloud-history synchronization are not implemented.

Browser decoding, service authorization, upstream restrictions and provider stream allowances still determine what can play. Plex compatibility depends on the connected server. FFmpeg conversion for temporary phone media is separate from a general-purpose live transcoding service.

TesPlay has no access to the vehicle's gear state and does not claim a safety interlock. Use it only while safely parked in Park. See [tested vehicles](compatibility.md) and [player details](tesplayer.md).
