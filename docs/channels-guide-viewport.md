# Guide viewport and paint-order regression

Local-only polish for `t_37d0cced`, based on accepted guide commit `c0780c05e3e95b521f45c1b29f3df30a11488f85`. No backend, player, vendor, deployment or real DVR changes.

## Cause and fix

- The library collection hero and duplicate library search put the initial rear-screen grid at y=471, leaving one full row. Guide pages now have a compact desktop heading and use the guide's search. For mixed live sources, the library shelf search is retained **below** the guide. Other library modes and source browsing keep their existing headings/search.
- Grid height was recomputed from `getBoundingClientRect().top` on every page scroll. Scrolling enlarged the grid, enlarged the page, and allowed further scrolling until the time header was above the viewport. Grid sizing now uses its stable document-flow position (`rect.top + scrollY`), observes the scroller/filter wrapper for layout changes, and no longer listens to page scrolling. Vertical/horizontal channel scrolling is owned by `.cg-scroller`; the time header remains sticky inside that container, not the document.
- The transformed virtual-row body created a stacking context below the sibling now-line. Position the virtual window using absolute `top` instead. Paint order is now cells < marker (3) < opaque text strips (4) < sticky channel column (5) < sticky header (6). Text strips use the same opaque composite fill as the cell. The now marker remains visible in padding and between title/metadata without crossing glyphs. Virtualization, 72px rows, label pinning and existing scrolling/loading logic remain intact.

## Reproduction and verification

Prerequisites: Node compatible with the repo, `npm ci`, and Google Chrome (macOS default path, or set `CHROME_PATH`). All test data is synthetic; no backend service or login is needed. The isolated Vite fixture renders the real `LibraryBrowser`, `Navigation`, `ChannelsGuide` and phone `ChannelsOnNow` with the real styles and an in-memory API fixture. It is not real-DVR or Tesla-hardware evidence.

```sh
node tests/channels-guide-layout.browser.mjs ../evidence/after
npm test && npm run build
git diff --check
```

The browser command starts and stops its own loopback Vite/headless Chrome, captures initial/grid-bottom/page-bottom/title-crossing screenshots at 1280x720 and 1920x1200 plus a 390x844 phone view, and writes `results.json`. It asserts multi-row initial layout, dock clearance, sticky header hit testing at grid bottom and intermediate/maximum page scroll, stable grid height, bounded rendered rows, and phone On now/no horizontal overflow. A screenshot-pixel test proves the now marker is masked behind title starts but still painted in the gap between text lines; DOM hit testing alone cannot prove that because the marker uses `pointer-events:none`.

The same browser fixture fails on the unmodified accepted baseline for all three reported defects. The task attachment contains before/after screenshots, measured results, command logs and an applyable source patch.

Measured after fix: rear screen shows 4 full rows, grid y=248..610 (362px high), dock starts at y=626. At maximum page scroll the header is still visible at y=167 and the grid remains 362px high. Desktop initially shows 10 full rows; phone remains On now with no horizontal overflow. Screenshot samples at title starts change from marker RGB(245,101,69) to cell-fill RGB(57,31,27), while the marker remains RGB(245,101,69) between labels.

Scope caveat: ordinary page scrolling past a guide to other providers' shelves is still ordinary document navigation; this does not turn the guide into a viewport-fixed overlay over unrelated shelves. No actual playback, hardware, deployment, push or shared-checkout mutation was performed. Withhold the patch to roll back; after integration, revert only this polish commit.
