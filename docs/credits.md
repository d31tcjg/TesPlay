# Credits and licenses

## TesPlay

Required Notice: Copyright 2026 rdvnit. TesPlay — https://github.com/rdvnit/TesPlay

The original TesPlay code and the owner-authored TesPlayer engine/contracts bundled here are available under the [PolyForm Noncommercial License 1.0.0](../LICENSE). Keep the [required credit notice](../NOTICE) with copies and modifications. The licenses below continue to govern third-party material.

## Fonts

The interface self-hosts DM Sans (weights 400, 500, 600 and 700) and Manrope (weights 400, 500, 600, 700 and 800). Both are distributed under the **SIL Open Font License 1.1**. The full copyright notices and license texts are included beside the font files and are copied into production builds.

| Font | Copyright | Included license | Official source |
|---|---|---|---|
| DM Sans | Copyright 2014 The DM Sans Project Authors | [LICENSE-DM-Sans.txt](../public/fonts/LICENSE-DM-Sans.txt) | [Google Fonts OFL.txt](https://github.com/google/fonts/blob/main/ofl/dmsans/OFL.txt) |
| Manrope | Copyright 2018 The Manrope Project Authors | [LICENSE-Manrope.txt](../public/fonts/LICENSE-Manrope.txt) | [Google Fonts OFL.txt](https://github.com/google/fonts/blob/main/ofl/manrope/OFL.txt) |

## TesPlayer engine

The user-owned canvas-stream-player source is pinned and retained in `vendor/tesplayer`. Player dependency notices and licenses are shipped in [public/licenses](../public/licenses), including Mediabunny (MPL-2.0), the MPEG audio decoder wrapper (MIT), embedded mpg123 (LGPL-2.1), web-worker (Apache-2.0) and puff (zlib). MPEG audio decoder code is emitted as an independent browser module. See [integration notes](tesplayer.md).

TesPlayer's controls use SVG artwork adapted from Mux's [Sutro theme](https://player.style/themes/sutro), distributed under the [MIT license](../vendor/sutro/LICENSE). The canvas playback engine remains canvas-stream-player.
