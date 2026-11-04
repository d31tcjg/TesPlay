# TESPLAY contract

Node 22 ESM Express / React TypeScript. Server listens 4174 by default; Vite 5173 proxies /api. App serves dist in production. SQLite persisted under DATA_DIR default ./data. Everything except bootstrap/status/login and assets protected by session cookie. No third party secrets returned to client.

## Core agent owns server/index.js, server/store.js, server/security.js, server/remote.js and tests/core.test.js. Provider agent owns server/providers.js, server/media.js, tests/providers.test.js. Root owns all frontend/config/docs/assets. Coordinate if change.

## Core APIs

GET /api/auth/status -> {setupRequired:boolean,user:null|{id,name,email},profiles:[{id,name,color}],activeProfileId:string|null}
POST /api/auth/setup {name,email,password,setupToken?} -> same authenticated status. Requires SETUP_TOKEN from env or generated token in terminal, only first user. POST /api/auth/login {email,password} -> status. POST /api/auth/logout -> {ok:true}.
GET /api/profiles -> {profiles,activeProfileId}. POST /api/profiles {name,color} -> {profiles,activeProfileId}. POST /api/profiles/:id/select -> status. DELETE /api/profiles/:id.
GET /api/connections -> {connections:[{id,type,name,createdAt,configured:boolean,summary:string}]}.
POST /api/connections {type,name,config:object} -> {connection:publicConnection}. PUT /api/connections/:id {name?,config?} -> public. DELETE /api/connections/:id.
Supported types xtream,m3u,plex,drive,local,youtube.

IPTV config accepts `loadedCategories: null | string[]`. Null (or absent on existing connections) loads all categories, including future ones; an empty array loads no content. Xtream IDs are scoped (`live:0`, `movie:0`, `series:0`); M3U IDs are exact group names, with `__ungrouped__` for channels without a group. Owner-only `GET /api/connections/:id/categories` returns `{categories:[{id,name,kind}],loadedCategories}` and loads category names without requesting Xtream title catalogs. `?refresh=1` reloads the names. Owner-only `POST /api/connections/categories/preview` accepts `{type:"xtream"|"m3u",name?,config}` and returns `{categories:[{id,name,kind}]}` for unsaved settings. It validates the settings without saving credentials, connections, or catalog cache records. Creation includes the chosen `config.loadedCategories` in the existing connection POST. Save later changes through the existing connection PUT route with `{config:{loadedCategories:[...]}}`. Selection persists in encrypted connector settings and intersects household grants. The UI bundles IPTV connections, while playable items retain their original `connectionId` and type.
GET /api/library/state -> {favorites:MediaItem[],progress:[{item:MediaItem,seconds,duration,updatedAt}]}
POST /api/library/favorites {item:MediaItem} toggles -> {favorites}.
POST /api/library/progress {item:MediaItem,seconds,duration} -> {ok:true}.
GET /api/settings -> {serverName,version,publicUrl,remoteEnabled}. No secrets.

### Temporary phone remote media

All routes require an enabled remote, authentication, and the same pairing/account/profile. A guest remote may manage its own uploads and links; only the room's host screen may resolve or stream them. Writes retain the origin/CSRF checks. Binary content is accepted only on the chunk PUT route; other writes remain JSON.

- `GET /api/remote/media?roomId=...` → `{items,maxBytes}` lists sources belonging to this remote (or all room sources for the screen). Incomplete/preparing/failed sources have `unavailable:true` and `unavailableReason`; Remove cancels preparation and frees reserved space.
- `POST /api/remote/media/upload {roomId,name,size,compatibility?}` → `{uploadId,chunkBytes}` reserves up to 1 GiB per video, 2 GiB globally (including conversion input/output), and eight sources per room. Extensions come from `shared/video-formats.json`: MP4/M4V/MOV/WebM/MKV/TS/MTS/M2TS play directly; AVI/DivX/WMV/ASF/FLV/F4V/MPG/MPEG/MPE/VOB/3GP/3G2/OGV/RM/RMVB/MXF convert automatically. `compatibility:true` also converts other video files. M3U8/M3U HLS uploads are limited to 2 MiB.
- `PUT /api/remote/media/upload/:id?roomId=...&offset=...` with `application/octet-stream` → `{received}`. At most 4 MiB per chunk, with exact ordered offsets; incomplete or concurrent writes cannot be finalized.
- `POST /api/remote/media/upload/:id/complete {roomId}` → `{item}` after all declared bytes arrive, or HTTP 202 `{item,preparing:true}` when conversion starts. Uploaded HLS playlists must contain absolute HTTP(S) child/key/map URLs; relative and file references are rejected. Repeat completion requests reuse pending/ready work.
- `POST /api/remote/media/link {roomId,url,title?,compatibility?}` → `{item}` validates a direct HTTP(S) source and identifies HLS/MPEG-TS from content and URL. Legacy formats detected by extension, MIME or AVI/FLV signatures, and explicit compatibility requests, return HTTP 202 `{item,preparing:true}`. The background job downloads the source through the existing DNS/redirect restrictions (up to 1 GiB, three-minute deadline), then converts the local file. HLS stays direct. The original URL is never returned to the phone.
- `GET /api/remote/media/:id/status` → `{item,status,message?}`, with `status` one of `uploading`, `preparing`, `ready`, `failed`. Only the creator or paired host can poll. The phone polls until ready before sending the load command; cancellation/failure deletes the source. Conversion is bounded to two jobs, 30 minutes, four-hour inputs and the available storage budget, outputs first video/audio as H.264/AAC MP4 up to 1080p/30 fps, and verifies duration to reject size-truncated results. FFmpeg receives only local files with file-only protocols and explicit video demuxers.
- `GET /api/remote/media/:id/playback` → TesPlay playback descriptor for the host screen. Authenticated `/api/media/:token` routes serve byte ranges and rewrite HLS child URLs, enforcing the room and host session on every request.
- `POST /api/media/:token/heartbeat` → `{ok:true}` for an owned Plex HLS playback ticket. The server pings the registered Plex transcode session, including while playback is paused. User/profile, library grants, remote scope, stream lease and Plex profile identity checks match media reads; upstream tokens and session IDs stay on the server. Other media types return 400. Closing/completing playback stops the client's 15-second heartbeat.
- `DELETE /api/remote/media/:id` removes a source and revokes its media tokens. Send an empty JSON body.
- Completed sources expire after 12 hours; incomplete uploads after one hour of inactivity. Disconnect and restart remove them. Sources use `providerType:remote-media`; command/state validation restores canonical metadata. These sources cannot be persisted in favorites/playlists/history.
POST /api/remote/pair -> {code,expiresAt}; POST /api/remote/join {code} -> {roomId}; GET /api/remote/events?roomId=... SSE commands; POST /api/remote/command {roomId,command,value?}. All require same account login. Commands play,pause,seek,volume,fullscreen. Pair requester gets roomId too.

## Provider integration hook

Core imports registerProviderRoutes from './providers.js'; calls registerProviderRoutes(app,ctx) after auth middleware for /api. ctx={getConnection(req,id): decrypted {id,type,name,config}, listConnections(req): decrypted[], saveConnection(req,{id?,type,name,config}):publicConnection, requireAuth, getProfileId(req), db}. req.user={id,...}, req.session={id,profileId,...}. Public API helper middleware validates same-origin mutations in core. Provider handlers must use getConnection for ownership.

## Providers APIs

POST /api/connections/:id/test -> {ok:true,message:string} or {error:string} non200
GET /api/catalog?connectionId=...&kind=movie|series|live|all&parentId=...&q=...&page=... -> {items:MediaItem[],categories?:[{id,name}],hasMore?:boolean}. Never all-account secret details. Plex root yields folders/library sections; folders navigable. Xtream series -> episodes via parentId. Local/Drive folders navigable. Max page size 100.
GET /api/playback?connectionId=...&itemId=...&kind=... -> {url:string,type:'hls'|'video'|'audio'|'external',subtitles?:[],message?:string}. For providers playback URL same-origin session-authorized proxy with opaque resource identifiers, never plaintext secrets. Browser resolves item selection through this endpoint. Optional item metadata key may be opaque base64 path, must validated against provider root.
GET /api/epg?connectionId=...&itemId=... -> {programs:[{title,start,end,description}]}.
POST /api/plex/pin -> {id,code,url}; POST /api/plex/pin/check {id,code} -> {pending:true} or {connection,servers:[{name,url,id}]}. Save token encrypted. PIN tracked owner/session, never returned.
GET /api/plex/:connectionId/profiles -> {profiles:[{id,name,thumb,protected:boolean}]}; POST /api/plex/:connectionId/profile {id,pin?} -> {ok:true}. Profile token scoped to local profile.
GET /api/drive/auth?connectionId=... -> redirect Google; GET /api/drive/callback Google OAuth. Validates state, authenticates owner, persists tokens encrypted. Drive config clientId,clientSecret,folderId optional; redirect URI PUBLIC_URL/api/drive/callback.
GET /api/radio?q=... -> {items:MediaItem[]} via Radio Browser directory. Radio playback may use public direct stream URLs, no secrets.

## MediaItem

{id:string,connectionId?:string,title:string,type:'movie'|'series'|'episode'|'live'|'folder'|'video'|'audio',source:string,poster?:string,backdrop?:string,description?:string,year?:string,duration?:number,category?:string,playbackUrl?:string,externalUrl?:string,subtitle?:string}. duration seconds. Providers never return secrets inside item URLs/artwork. Can provide same-origin artwork proxy URLs. The frontend shows connected libraries only; no bundled demo films.

## Security/persistence

One owner manages member accounts and shared-connection grants, with separate household profiles (no public registration after setup). Scrypt passwords; AES-256-GCM connections; persistent generated key file mode 0600; sessions hashes stored sqlite, httpOnly sameSite=strict/lax secure when HTTPS. Trust proxy only explicit env. Rate-limit auth/setup. CSRF by Origin against PUBLIC_URL or request origin with careful proxy policy. Persist no credentials in localStorage.
Provider URL validators allow configured private LAN hosts for Plex/Xtream, reject unsupported protocols, URL username/password and cloud metadata/linklocal. Strict resource authorization prevents open proxy. Range support for videos and server HLS rewrite relative/absolute nested segments. No DRM bypass, Tesla driving lock bypass or generic arbitrary unauthenticated URL fetch.

## TesPlay 0.2 account additions

- `POST /auth/qr/init` → `{id,code,verificationUrl,expiresAt}`; sets an HttpOnly browser binding. Approval credential is in the URL fragment.
- `POST /auth/qr/poll {id}` → `{status:"pending"}` or `{status:"approved",auth}` plus a session cookie; original screen only.
- `POST /auth/qr/details {id,token}` → `{code,expiresAt}` and `POST /auth/qr/approve {id,token}` → `{ok:true}`; require an authenticated approving phone.
- `POST /auth/qr/cancel {id}` invalidates the current screen’s request. All challenges expire after five minutes and are single-use.
- `POST /auth/qr/init {remoteScreen:true}` requests approval followed by phone-remote connection. Details include `remoteScreen:true`; the original screen's poll creates its screen room and connects only the exact approving phone session if it is still authorized. Ordinary sign-in QRs preserve their existing behavior.
- `POST /remote/screen/disconnect {roomId}` requires that room's full-scope host session. It revokes guest remotes, detaches account-authorized remotes, invalidates pending pairing codes and rotates the room. Returns `{roomId}` for a fresh pairing.
- `GET /remote/state?roomId=...` includes `paired:boolean`, based on current authorized remote sessions. Playback telemetry accepts optional `fullscreenLocked:boolean`; a rear-screen player locks page fullscreen and hides the phone's fullscreen toggle. Older publishers can omit the flag.
- `GET /settings` includes `preferences:{autoPlayNext:boolean}`; `PATCH /settings {preferences:{autoPlayNext:false}}` persists it per account. Default is true.
- `GET /connections/:id/config` returns only editable non-secret fields and `configuredFields`; PUT retains stored secrets for blank secret inputs.
- `GET /episodes/next?connectionId=...&itemId=...` → `{item:MediaItem|null}`; supported for Xtream and Plex. Episode items may contain `seriesId`, `seasonNumber`, `episodeNumber`.
- Xtream category IDs are scoped (`live:id`, `movie:id`, `series:id`); the frontend also scopes them by connection.
- YouTube OAuth starts at `/youtube/auth?connectionId=...` and returns to `/youtube/callback`. Config uses `authMode:"oauth"`, `clientId`, `clientSecret`; API-key mode uses `authMode:"apiKey"`, `apiKey`. Tokens remain encrypted server-side.
- Google token refresh rejects expired/revoked grants and invalid OAuth clients with HTTP 409 and an actionable `{error:string}`. Network and provider failures retain their existing status. Parallel browsing of the same connector shares one bounded refresh and persists any rotated refresh token.
- Existing library progress also provides watch history; unknown-duration playback uses duration zero. Media keys include content type so provider numeric IDs do not collide.

## Library presentation and owner-managed members

- `req.user.role` is `owner` or `member`; anonymous users remain outside the private API and frontend. Only the owner can modify connectors or perform provider consent/settings actions.
- `GET /api/accounts` lists accounts and grants. `POST /api/accounts {name,email,password,grants}` creates a member and its initial profile. `PATCH /api/accounts/:id {name?,password?,disabled?,grants?}` changes member access; setting a password or disabling revokes sessions and approved QR challenges. `DELETE` removes a member. These routes require the owner.
- A grant is `{connectionId,kinds:string[],sections:null|string[],categories:null|string[]}`. `null` means all permitted libraries/categories. Members reuse the owner's encrypted connector; public responses omit credentials. Type and source restrictions apply to catalogs, actual playback metadata, saved library entries and ongoing media requests.
- `GET /api/plex/:connectionId/sections` returns `{sections:[{id,title,kind,folderId}]}`. `GET .../hubs?sectionId=` returns real server hubs plus Watchlist/local matches and an All-library shelf. `GET .../list?listId=&page=&q=` follows a server-issued sealed descriptor to a paginated read-only collection; it cannot address another origin or unshared section.
- `GET /api/library/state` additionally returns `{stars,queue}` for the selected profile. `POST /api/library/stars {profileId?,connectionId,kind:channel|category|section,id,title}` toggles a star. `POST /api/library/queue {profileId?,action:add|remove|clear,item?}` maintains the ordered YouTube Watch playlist, capped at 100 videos. Legacy YouTube favorites migrate once into this queue.
- YouTube `/feed?offset=` returns only starred subscriptions with `{items,channelRows:[{id,title,items}],nextOffset,totalChannels,partial,basis}`. Home consumes subsequent pages to include all starred channels. Google-owned playlists remain separately browsable.
- Media items may include `providerType`, `contentKind`, `sectionId`, `accessCategory`, `artwork:poster|thumbnail|logo`, `watched` and `unavailable`. IPTV episodes retain the original access category separately from their season label.

## Opt-in screen troubleshooting

`POST /api/screen-check` accepts `{userAgent,width,height,pixelRatio,viewportWidth,viewportHeight}` and optional `availableWidth`, `availableHeight`, `outerWidth`, `outerHeight`, `visualWidth`, `visualHeight`, `visualScale`. It returns `{id}`. No sign-in is required, but JSON, same-origin protections, numeric bounds and a ten-request-per-minute limit apply. Only recognised display fields, browser identity, generated check code and timestamp are written to the server log as `tesplay-screen-check`. Extra fields and request cookies are omitted. The UI submits a report only when the visitor explicitly opens `/?screen-check=1`; normal visits do not report. The pixel estimate is affected by browser scaling and zoom and does not prove the physical panel resolution.

## Title selection and Plex continuity

- `GET /api/playback/options?connectionId=&itemId=&kind=` reads Plex title metadata without starting a transcode. Returns `{item?,audio:[{id,label,language?,selected?}],subtitles:[{id,label,language?}],qualities:[{id,label}]}`. Only externally accessible text subtitles are advertised for Plex. Other streams discover available tracks and HLS renditions in the browser without creating a player.
- `GET /api/player/preferences` returns `{audioLanguage:string|null,subtitleLanguage:string|null,subtitlesEnabled:boolean,qualityId:'auto'|'1080p'|'720p'|'480p'}` for the authenticated session's selected profile. `PATCH` accepts any nonempty subset of these fields and preserves the others. Language tags must contain 2–3 letters with optional subtags and be no longer than 35 characters. Unknown fields and invalid values return 400. Defaults are automatic audio, subtitles off, and auto quality.
- `POST /api/auth/setup` and `POST /api/accounts` accept optional `playbackDefaults` with the same preference fields, saved atomically to the new account's first profile. Validation happens before account creation. Existing callers may omit it. Browser playback resolves profile defaults to actual track/rendition IDs; explicit per-title choices override them.
- `GET /api/episodes?connectionId=&itemId=&kind=episode|series|folder` returns the complete permitted episode list plus `{previous,next}` for an episode. Plex uses bounded `allLeaves` pagination; Xtream uses the complete series metadata. The existing `/api/episodes/next` response remains `{item}`.
- Plex `/api/playback` accepts `audioTrackId=plex-audio-<streamId>` and `qualityId=auto|1080p|720p|480p`, validates them against current metadata, and selects the requested audio for HLS output. Explicit quality choices request 8/4/2 Mbps and 1920×1080/1280×720/854×480 respectively. `transcode=1` continues to request compatibility. Responses include stable subtitle IDs, transcode audio choices, selected audio and `resumeSeconds`.
- `POST /api/library/progress` additionally accepts `state:playing|paused|stopped`. Plex items report timeline checkpoints with the linked profile token and mark completion at 97%. Local progress remains saved if Plex rejects the update; the successful JSON response then includes a sanitized `plexSyncError`.
- `GET /api/plex/:connectionId/continuity` returns `{progress,watchlist,notes}` for the selected Plex Home profile and permitted libraries. It reads the latest 200 watched/in-progress titles per library and the first 60 cloud Watchlist entries per content kind; complete Watchlist pagination remains available in Plex library browsing. The website merges recent history, exposes Plex Watchlist under My list, and refreshes on library visibility/navigation. Plex playback reads current server resume metadata when opening a title.
- YouTube video lists fetch `videos.list(part=contentDetails)` in batches to add duration in seconds. The Reels / Shorts toggle uses a 180-second threshold, retains entries whose duration is unknown, and stores this non-secret display preference in the browser. The UI explains that this also hides short videos that are not Shorts.
