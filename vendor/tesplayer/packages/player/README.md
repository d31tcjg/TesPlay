# TesPlayer engine

TesPlayer is a reusable, headless TypeScript/ESM browser playback engine: Mediabunny demuxing, WebCodecs decoding, Canvas2D video and Web Audio sound. "Headless" means it does not ship controls or require React; it still needs a browser DOM and canvas. It is not an HTMLVideoElement/MSE wrapper or a general-purpose server player.

The engine and reference application are integrated on main, using contract freeze `2026-09-29.1`. Implementation and recorded fixture evidence are not universal browser, provider or physical-Tesla certification. See [the integration checkpoint](../../docs/INTEGRATION_CHECKPOINT.md) and [detailed feature checklist](../../docs/FEATURE_MATRIX.md).

The product name is **TesPlayer**. The package ID remains `@canvas-stream-player/player` to avoid breaking existing imports, lockfiles and deployments. It is private and `UNLICENSED`; there is no public npm release or authorized open-source license yet.

## Minimum requirements, without the website

### Viewer runtime

- HTTPS or a supported secure-local development origin.
- A browser DOM, Canvas2D, Fetch/ReadableStream and WebCodecs `VideoDecoder` supporting the actual stream configuration. Codec names alone do not establish support for a particular profile, resolution or device.
- Web Audio for audible playback, unlocked through a real user gesture. Native audio also needs support for the actual `AudioDecoder` configuration; the MP2 fallback needs Web Workers and WebAssembly.
- CORS-readable authorized direct media or same-origin authenticated gateway endpoints. Seekable files need the required Range behavior; HLS must expose all permitted child playlists, segments and keys.
- A host-provided canvas, measured capabilities, service adapter and valid `PlayerLoadRequest`/`PlaybackSession`.

**React, the reference website, Docker, Node.js and a dedicated player server are not browser-engine runtime requirements.** Direct media can work with a contract-compatible host adapter. Resolution, proxying, remuxing, transcoding and embedded-caption extraction require the appropriate backend or an equivalent service. Transcoding still cannot compensate for an entirely missing browser VideoDecoder: its output uses the same canvas decoding path.

### Resource figures and what they mean

There is **no measured minimum CPU count, CPU speed or total RAM requirement** for the standalone engine. No browser benchmark was performed for this documentation. Hardware decoding, codec/profile, resolution, frame rate, dual inputs and rendering size all affect consumption. Do not advertise a fixed RAM minimum from these policy values.

| Source-derived setting                    | Default           | Scope                                                                                 |
| ----------------------------------------- | ----------------- | ------------------------------------------------------------------------------------- |
| Demux/source cache allowance              | 64 MiB per source | `maxBufferedBytes`; dual input can configure two caches, 128 MiB combined allowance   |
| Video queue / accepted decode submissions | 12                | Frame/submission limits, not a byte budget                                            |
| Video controller frame handles            | 13                | Callback-inclusive ownership budget, not all native decoder/GPU surfaces              |
| Audio scheduling threshold                | 8 seconds         | Checked before admitting another PCM buffer; not an exact eight-second memory ceiling |
| Decode lookahead                          | 2 seconds         | Scheduling policy, not reserved RAM                                                   |
| Display-canvas pixel ceiling              | 8,294,400         | Display sizing only; scratch/source rasters and browser/GPU copies are additional     |

Policy-backed cache, queue and timing settings are configurable within `PlayerPolicySchema`; the display-canvas pixel ceiling is a hard-coded engine constant, not a policy field. These are local bounds and thresholds, not one aggregate allocation cap. Dependency buffers, producer-held PCM, native decoder reference frames, worker/WASM memory, canvas copies, GPU, browser and OS overhead are additional.

For scale only: at 1920×1080, twelve tightly packed 8-bit YUV420 frames would occupy about 35.6 MiB; one RGBA raster about 7.9 MiB. Eight seconds of 48 kHz stereo Float32 PCM would occupy about 2.93 MiB. Actual representations and retained objects vary. These calculated examples are **not measured usage or minimum RAM**, and should not simply be added into a claimed total.

A minified browser-ESM bundle of the full engine export surface and dependencies, excluding React, the reference website and backend, measured **1,004,141 bytes** uncompressed and **282,357 bytes** gzip for this branding update. This is transfer size, not heap size; consumer tree shaking and bundler options can change it. See [measurement evidence](../../docs/evidence/tesplayer-engine.json).

## What it can do

| Capability                                                      | Engine responsibility                                                                   | Host/backend responsibility                                                   |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Direct files, HTTP Range, separate audio/video                  | Demux, decode, synchronize and seek                                                     | Provide authorized endpoints and an accurate session catalogue                |
| Live/VOD TS or fMP4 HLS, standard authorized AES-128            | Playlist/segment ingestion, decode, timing, live windows and bounded recovery           | Make all authorized resources readable; gateway rewriting when required       |
| Continuous MPEG-TS                                              | Stream ingestion and playback                                                           | Supply a readable bounded stream                                              |
| AVC/HEVC/VP8/VP9/AV1 and supported audio/container combinations | Probe actual decoder configurations and play supported ones; MP2 fallback               | Normalize unsupported combinations when compatibility is available            |
| FLV and unsupported codecs                                      | Consume a replacement supported output                                                  | FLV-to-fMP4 codec-copy remux or FFmpeg normalization, not browser transcoding |
| Playback controls                                               | Commands for play/pause/stop/seek, rate, volume/mute, A/V offset, rotation and fit/fill | Render buttons/sliders, keyboard/touch interactions and fullscreen            |
| Quality and audio selection                                     | Resolve exact representation/resource-bound selectors                                   | Return validated replacement sessions; preserve expected-generation checks    |
| Text subtitles                                                  | WebVTT/SRT and HLS text-cue timelines, selection/off and seek behavior                  | Render a safe caption overlay; extract supported embedded text when needed    |
| Diagnostics and recovery                                        | Events, snapshots, typed errors, clocks, retry/backpressure and cleanup                 | Display errors/diagnostics and implement permitted service escalation         |
| YouTube, M3U/Xtream catalogues, login, favorites and resume     | Consume the resulting session/request                                                   | Resolver/library/authentication/persistence services, not engine features     |

"Auto" quality is policy selection, not a conventional bandwidth-estimating adaptive-bitrate controller. Codec vocabulary does not mean every browser supports every codec. Fullscreen and Media Session belong to the host UI rather than the engine renderer.

## How another website uses it

Include both workspace packages and their pinned dependencies in your build. There is no current public `npm install tesplayer` package or `play(url)` shortcut. Your integration must supply a complete session and implement `PlayerEngineServices`; see [the reuse guide](../../docs/ENGINE_REUSE.md) for authorization and origin boundaries.

This typed example accepts the host's session request and services rather than inventing a backend or hard-coded media URL:

```ts
import type {
  PlayerEngineServices,
  PlayerEvent,
  PlayerLoadRequest,
} from '@canvas-stream-player/contracts';
import {
  createTesPlayerEngine,
  probeMediaCapabilities,
} from '@canvas-stream-player/player';

export async function mountTesPlayer(
  canvas: HTMLCanvasElement,
  request: PlayerLoadRequest,
  services: PlayerEngineServices,
  onEvent: (event: PlayerEvent) => void,
) {
  const capabilities = await probeMediaCapabilities();
  const player = createTesPlayerEngine({ canvas, capabilities, services });
  const unsubscribe = player.subscribe(onEvent);
  try {
    await player.load({ ...request, autoplay: false });
  } catch (error) {
    unsubscribe();
    await player.destroy();
    throw error;
  }
  return {
    player,
    // Call directly from the host's real click/touch handler.
    async playFromUserGesture() {
      await player.unlockAudio();
      await player.dispatch({ type: 'play' });
    },
    async dispose() {
      unsubscribe();
      await player.destroy();
    },
  };
}
```

The host wires state/events into its own controls and captions, validates service responses, and closes its backend playback session separately when leaving. `destroy()` releases engine resources; it does not revoke the server session. `apps/web/src/player-services.ts` and `apps/web/src/pages/Player.tsx` are implemented integration examples, not dependencies you must import wholesale. Optional service methods become necessary when exposing their workflows. Unsupported compatibility should fail explicitly, not return a fabricated session.

## Can the design be different?

**Yes.** The engine receives a canvas and exposes `subscribe`, `getSnapshot`, `dispatch`, `unlockAudio`, `load` and `destroy`. It does not own the website layout, CSS, icons, controls or caption overlay. A host can use plain JavaScript, React or another frontend to build compact, touch-first, light/dark or otherwise custom controls while retaining the same playback engine. Canvas geometry already supports fit/fill and quarter-turn rotation.

There is no packaged plug-and-play skin system yet. The reference site's styling can be changed separately; a reusable skin/component library would be additional distribution work. Preserve user-gesture audio unlock, accessible controls, safe caption rendering, generation checks and teardown when redesigning.

## What remains or is intentionally unsupported

- **Release/distribution:** choose an authorized project license; review dependency notices, covered-source availability and decoder replacement/relinking; package and publish a deliberate SDK or embed product. Making a repository public alone does not grant reuse rights. [Dependency notes](LICENSES.md) are not a completed redistribution-compliance audit.
- **Integration ergonomics:** a ready-made `play(url)` SDK, supported host examples and reusable skins are not shipped. A shared cross-origin backend/iframe requires a separately approved authentication/origin design. The deployed site deliberately denies iframe embedding.
- **Resource/device acceptance:** measured standalone CPU/RAM minimums, broad browser/device benchmarking, physical Tesla/audio-listening acceptance and long-duration production soak are unclaimed. Current local queue limits do not certify all native/GPU memory.
- **Capability reporting:** WebGL and Canvas2D are probed on separate canvases, with regression coverage for exclusive context modes. Reported codec support still depends on the actual browser/device configuration.
- **Playback limits:** no principal HTML video/MSE fallback or conventional bandwidth-based ABR. No DRM/subscription bypass or support for EME DRM/SAMPLE-AES. Bitmap captions and ASS/SSA styling are unsupported.
- **Catalogue limits:** the reference backend's Xtream integration imports the `get.php` M3U catalogue subset, not full portal/EPG/series browsing. Generic provider interfaces are not arbitrary provider integrations.
- **Evidence:** fine-grained feature-matrix acceptance remains separate from implementation coverage. Automated local browser/playback checks are authorized; real-provider and Tesla acceptance remain user-owned. See [current project status](../../docs/PROJECT_STATUS.md) for current checks and CI results.

## Public UI-facing API

- `createTesPlayerEngine(options)` is the branded factory. `createPlayerEngine` remains an identical compatibility alias. Callers pass `canvas`, optional `audioContext`, optional `policy`, `services`, and measured `capabilities`.
- `TesPlayerEngine` is the branded class export; `CanvasPlayerEngine` remains the identical constructor. Its optional `dependencies` field is a focused package-test seam; production callers should omit it.
- `probeMediaCapabilities`, `probeTrackDecoderCapability`, and `probeTrackDecoderConfig` safely probe actual WebCodecs configurations. Missing or rejecting decoder APIs return unsupported results rather than throwing generic failures.
- `computeVideoLayout`, clock, HLS, subtitle, and MPEG Layer-II helpers are exported for deterministic policy tests.

The engine always emits `snapshot.aspectMode`; its default is `fit`. It accepts `set-aspect-mode` with `fit` or `fill` and applies rotated-source geometry for 0°, 90°, 180°, and 270°.

## Runtime design

The principal path is Mediabunny 1.60.0 demux and WebCodecs decode, Canvas2D presentation, and decoded PCM Web Audio scheduling. No `HTMLVideoElement` or MSE renderer is used.

Each public call has an immutable invocation identity and an explicitly transferred operation lease. A call may transfer that lease only when it owns a legitimate generation transition. Catches test that exact lease rather than reading `this.operation`; late ordinary rejections from stale open, selection, subtitle, demotion, compatibility, or audio-unlock work reject only their caller with `STALE_OPERATION`. Inputs are registered immediately and disposed once.

Direct routes use `credentials: omit`; owned/gateway routes use `same-origin`. All direct and child fetches use `referrerPolicy: no-referrer`, finite attempt timeouts, finite retries, and safe diagnostics. Public errors, events, demotion reasons, and diagnostic values pass through centralized URL/token redaction.

HLS fetches use parser-assigned resource roles. Known segment/map bodies are never cloned or sniffed; playlist/key bodies are consumed once under byte limits and rebuilt for the demuxer. Playlist expansion and rotating media identities are bounded, and trusted-direct children cannot cross the trusted root origin. Only structural key-fetch/key-length failures become `HLS_KEY_FAILED`; later corruption/decode failures are not blanket-remapped merely because the session declared AES-128. URI-tag/IV grammar is validated by the HLS policy helper; exact variant acceptance is tracked in the feature checklist.

Video uses an engine-owned `EncodedPacketSink` + `VideoDecoder` path with admission checks and explicit frame ownership/close tracking. Parent fixture playback passes, but sampled queue counters are not independent proof that every frame is counted and closed exactly once or that all admission paths satisfy `maxVideoFrames`. Allocation instrumentation remains an acceptance gate. No claim is made to byte-bound opaque codec/GPU reference memory inside the browser decoder. Live timeline continuity and independent content-sync evidence also remain open.

Subtitles use a selection epoch plus their own abort controller. Single-file WebVTT/SRT and segmented WebVTT paths exist, with refresh, segment identity dedupe and timestamp maps. The `extract-subtitles` action asks the bounded server worker for the default/first supported embedded text track; selecting a demuxed subtitle requests its exact track ID. Only validated WebVTT results are published; turning subtitles off or selecting the result does not replace media endpoints. Bitmap subtitles (including PGS/DVD/DVB) and styled subtitle formats (including ASS/SSA styling) are intentionally unsupported rather than flattened or represented with invented metadata.

MPEG Layer-II fallback validates an aligned, length-correct MPEG frame. The pinned wrapper is registered immediately as an operation resource; abort/destroy calls its inherited `Worker.terminate()` directly because its cooperative `free()` queues behind hung ready/decode work.

## Lifecycle and ownership

- `destroy()` is repeated-call idempotent and drains generation tasks with bounded cleanup.
- Internally created AudioContexts are closed; injected AudioContexts are never closed by the engine.
- Normal waits remove abort listeners, ended audio nodes disconnect, and pause/seek/destroy reset measured queue diagnostics.
- Recovery is generation-serialized. Diagnostics are detached and cannot block correctness or create concurrent recovery attempts.

## Development harness, not a viewer requirement

`harness/server.mjs` binds `127.0.0.1` by default. Container binding requires `HARNESS_CONTAINER_BIND=1`. It serves only the harness files, built player assets, owned negative-test assets, and a configured fixture root; it rejects unsupported methods, malformed encoding, traversal, and realpath/symlink escapes and does not emit wildcard CORS.

Build in the pinned Node image:

    npm install --package-lock=false --ignore-scripts
    npm run build --workspace @canvas-stream-player/contracts
    npm run build --workspace @canvas-stream-player/player
    npm run build:harness --workspace @canvas-stream-player/player

Automated local browser/playback checks are authorized by the current testing boundary in [REQUEST.md](../../docs/REQUEST.md); real-provider and physical-Tesla acceptance remain user-owned. The browser runner needs a hardened loopback harness, the separate loopback Python fixture server for dynamic live/throttled cases, native disposable-profile Chrome, and an existing Python environment containing `websockets`. Pass the actual fixture origin explicitly; no fixed fixture port is required:

    /path/to/hermes/venv/bin/python packages/player/harness/run-browser.py \
      --harness-url 'http://127.0.0.1:<harness-port>/?fixtures=http://127.0.0.1:<fixture-port>' \
      --fixture-manifest /path/to/generated/manifest.json

The runner uses fresh disposable profiles in bounded batches and writes evidence after every completed batch. Evidence schema v2 records commit, dirty working-tree identity, working-source/bundle/fixture-manifest digests, browser version, policy, and exact argv. A dirty build is explicitly not labeled an exact-HEAD run.

## Integration boundary

The engine cannot create proxy, selection, remux, or FFmpeg output. `requestRouteDemotion`, `requestSelection`, and `requestCompatibility` return replacement `PlaybackSession` values which are rechecked after each await. Backend-owned FLV remux, real FFmpeg compatibility, authenticated broker cookies and full-stack authorization are implemented in the reference stack and have separate recorded integration evidence. Package fixtures alone do not prove those server workflows or a second host's integration.

Freeze `2026-09-29.1` includes exact selectors. Finite-file selection resolves `track.number` only after matching resource, media type and representation identity; audio selection checks pairability. Missing/mismatched selectors fail rather than selecting a nearest metadata match and relabeling it. The reference API guards replacement publication by the expected playback generation. Custom adapters must preserve these identity and generation invariants.
