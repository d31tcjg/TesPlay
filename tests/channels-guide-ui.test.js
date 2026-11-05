import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Objects built inside the vm context have another realm's prototypes: compare JSON shapes.
const deepEqual = (actual, expected, message) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message);
// Frontend helpers are pure TypeScript; transpile and run them without a DOM (synthetic data only).
const load = name => {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
  }).outputText;
  vm.runInNewContext(code, {exports, URLSearchParams, Error, Date, Math, Number, Map, Set, Array, Object, JSON, Promise});
  return exports;
};
const g = load('channels-guide'), {unifiedShelves} = load('library-browser'), {loadHomeConnection} = load('home-library');

const O = 1800000000; // grid origin
const ch = (number, source, airings, extra = {}) => ({id: `live:${number}`, number, name: `Chan ${number}`, source, airings, ...extra});
const a = (start, minutes, title = `T${start}`) => ({start, end: start + minutes * 60, title});

test('time maps to pixels at 6 px per minute and back', () => {
  assert.equal(g.PX_PER_MINUTE, 6);
  assert.equal(g.timeToX(O, O), 0); assert.equal(g.timeToX(O + 3600, O), 360); assert.equal(g.timeToX(O + 90, O), 9);
  assert.equal(g.xToTime(360, O), O + 3600);
  assert.equal(g.gridWidth(O, O + 3 * 3600), 1080);
  deepEqual({...g.cellLayout(a(O + 600, 30), O, O + 10800)}, {left: 60, width: 180});
  deepEqual({...g.cellLayout(a(O - 1800, 60), O, O + 10800)}, {left: 0, width: 180}, 'started before the grid: clipped at the origin');
  deepEqual({...g.cellLayout(a(O + 10200, 60), O, O + 10800)}, {left: 1020, width: 60}, 'runs past the loaded end: clipped there');
  assert.equal(g.cellLayout(a(O + 20000, 30), O, O + 10800).width, 0);
});

test('cell labels follow the visible time edge without escaping the cell', () => {
  assert.equal(g.cellLabelOffset(100, 120, 180), 0, 'fully visible cell stays unchanged');
  assert.equal(g.cellLabelOffset(156, 0, 358), 156, 'current cell title clears the sticky channel column');
  assert.equal(g.cellLabelOffset(330, 0, 358), 0, 'less than MIN_CELL remains: leave the label alone');
  assert.equal(g.cellLabelOffset(900, 0, 2000), 900, 'cell wider than the viewport follows its left edge');
  assert.equal(g.cellLabelOffset(322, 0, 358), 322, 'exactly MIN_CELL remains inside the cell');
});

test('the now line sits at the elapsed minutes and "now" scrolls near the left edge', () => {
  assert.equal(g.nowLineX(O + 1800, O), 180);
  assert.equal(g.scrollForNow(O + 1800, O), 180 - 24); assert.equal(g.scrollForNow(O, O), 0, 'never negative');
  assert.equal(g.isCurrent(a(O, 30), O), true); assert.equal(g.isCurrent(a(O, 30), O + 1800), false, 'end is exclusive');
  assert.equal(g.airingProgress(a(O, 60), O + 900), 25); assert.equal(g.airingProgress(a(O, 60), O - 5), 0); assert.equal(g.airingProgress(a(O, 60), O + 99999), 100);
});

test('grid height clears the floating navigation in normal page flow', () => {
  assert.equal(g.gridViewportHeight(720, 471), 139, 'rear screen: header, scrollbar and a full 72px row fit');
  assert.equal(g.gridViewportHeight(1200, 493), 597, 'front screen stays above the dock');
  assert.equal(g.gridViewportHeight(1600, 100), 820, 'keep the existing maximum');
  assert.equal(g.gridViewportHeight(600, 550), 134, 'never smaller than a header, scrollbar and one row');
});

test('visible row window renders only the viewport plus overscan', () => {
  const H = g.ROW_HEIGHT; assert.equal(H, 72); assert.equal(g.OVERSCAN_ROWS, 6);
  deepEqual(g.visibleRows(0, 720, 300), {start: 0, end: 16, offset: 0}, '10 visible + 6 overscan');
  const mid = g.visibleRows(72 * 100 + 10, 720, 300);
  assert.equal(mid.start, 94); assert.equal(mid.end, 100 + 11 + 6); assert.equal(mid.offset, 94 * 72);
  assert.ok(mid.end - mid.start < 30, 'never renders the whole 300-channel list');
  deepEqual(g.visibleRows(1e9, 720, 300).end, 300, 'clamped at the bottom');
  assert.ok(g.visibleRows(1e9, 720, 300).start < 300);
  deepEqual(g.visibleRows(0, 720, 0), {start: 0, end: 0, offset: 0});
  deepEqual(g.visibleRows(-50, 720, 3), {start: 0, end: 3, offset: 0});
});

test('the next 3 h window loads within 1 h of the loaded end, up to 24 h ahead', () => {
  const end = O + 3 * 3600, now = O + 1800;
  assert.equal(g.needsNextWindow(0, 400, O, end, now), false, 'viewport ends well before the loaded end');
  assert.equal(g.needsNextWindow(500, 1000, O, end, now), true, 'visible right edge is past the loaded end');
  // exactly one hour of margin triggers; just over does not.
  assert.equal(g.needsNextWindow(0, 2 * 360, O, end, now), true);
  assert.equal(g.needsNextWindow(0, 2 * 360 - 6, O, end, now), false);
  // max 24 h ahead of now
  const limit = now + 24 * 3600;
  assert.equal(g.needsNextWindow(1e6, 1000, O, limit, now), false);
  deepEqual({...g.nextWindow(end, now)}, {start: end, hours: 3});
  deepEqual({...g.nextWindow(limit - 3600, now)}, {start: limit - 3600, hours: 1}, 'last window is trimmed to the ceiling');
  assert.equal(g.nextWindow(limit, now), undefined);
});

test('merging a later window keeps channel order and de-duplicates airings at the seam', () => {
  const first = {start: O, end: O + 10800, channels: [ch('9.1', 'Antenna', [a(O, 60), a(O + 7200, 60)]), ch('215', 'Cable', [a(O, 180)])]};
  const second = {start: O + 10800, end: O + 21600, channels: [ch('215', 'Cable', [a(O, 180), a(O + 10800, 60)]), ch('9.1', 'Antenna', [a(O + 10800, 30)]), ch('500', 'New', [a(O + 10800, 30)])]};
  const merged = g.mergeGuide(first, second);
  assert.equal(merged.start, O); assert.equal(merged.end, O + 21600);
  deepEqual(merged.channels.map(c => c.id), ['live:9.1', 'live:215', 'live:500']);
  deepEqual(merged.channels[1].airings.map(x => x.start), [O, O + 10800], 'duplicate seam airing dropped');
  assert.equal(g.mergeGuide(undefined, second), second);
});

test('filters combine source, favorites and a search over number, name and current program', () => {
  const now = O + 600;
  const channels = [
    ch('9.1', 'Antenna', [a(O, 60, 'Evening News')]), ch('36.1', 'Antenna', [a(O, 60, 'Cooking Hour')]),
    ch('215', 'Cable', [a(O - 3600, 30, 'Old Show'), a(O, 60, 'Big Game')], {name: 'Sports Net'}), ch('300', 'IPTV', []),
  ];
  const none = {source: '', favorites: false, query: ''}, ids = new Set(['live:215', 'live:300']);
  const run = (f, fav = ids) => g.filterChannels(channels, {...none, ...f}, fav, now).map(c => c.number);
  deepEqual(run({}), ['9.1', '36.1', '215', '300']);
  deepEqual(run({source: 'Antenna'}), ['9.1', '36.1']);
  deepEqual(run({favorites: true}), ['215', '300']);
  deepEqual(run({favorites: true, source: 'Cable'}), ['215']);
  deepEqual(run({query: 'news'}), ['9.1'], 'matches the current program title');
  deepEqual(run({query: 'old show'}), [], 'not the current program');
  deepEqual(run({query: 'sports'}), ['215'], 'matches the channel name');
  deepEqual(run({query: '36'}), ['36.1'], 'matches the number');
  deepEqual(run({query: '  '}), ['9.1', '36.1', '215', '300']);
  deepEqual(g.channelSources(channels), ['Antenna', 'Cable', 'IPTV']);
});

test('narrow layout switches to On now below 700 px', () => {
  assert.equal(g.NARROW_BREAKPOINT, 700);
  assert.equal(g.isNarrowLayout(390), true); assert.equal(g.isNarrowLayout(699), true);
  assert.equal(g.isNarrowLayout(700), false); assert.equal(g.isNarrowLayout(1280), false);
});

test('channel tiles become the v1 live MediaItem and favorites match by connection and id', () => {
  const item = g.liveItem({id: 'c1', name: 'Synthetic DVR'}, {id: 'live:9.1', number: '9.1', name: 'Local', hd: true, source: 'Antenna', logo: '/api/media/x'});
  deepEqual({...item}, {id: 'live:9.1', connectionId: 'c1', type: 'live', providerType: 'channels', source: 'Synthetic DVR', title: '9.1 Local', poster: '/api/media/x', category: 'Antenna', subtitle: 'HD'});
  assert.equal(g.channelFavorite([item], 'c1', 'live:9.1'), true);
  assert.equal(g.channelFavorite([item], 'c2', 'live:9.1'), false);
  assert.equal(g.channelFavorite(undefined, 'c1', 'live:9.1'), false);
});

test('labels and ticks', () => {
  assert.equal(g.episodeLabel({season: 2, episode: 4, episodeTitle: 'Pilot'}), 'S2 E4 · Pilot');
  assert.equal(g.episodeLabel({episodeTitle: 'Only'}), 'Only'); assert.equal(g.episodeLabel({}), '');
  deepEqual(g.timeTicks(O + 100, O + 3700), [O + 1800, O + 3600]);
});

test('unifiedShelves: Channels adds recorded shows and movies shelves and nothing for Live TV', async () => {
  const c = {id: 'c1', name: 'Synthetic DVR', type: 'channels', configured: true};
  const paths = [], request = async path => {paths.push(path); return {items: [{id: 'show:1', type: 'series', title: 'Synthetic Show'}]};};
  const signal = new AbortController().signal;
  const series = await unifiedShelves(c, 'series', request, signal);
  assert.equal(series.length, 1); assert.equal(series[0].title, 'Synthetic DVR · Recorded shows');
  assert.equal(series[0].parent.id, 'channels:shows'); assert.equal(series[0].parent.type, 'folder');
  assert.equal(series[0].items[0].id, 'show:1');
  const query = new URL(paths[0], 'https://x.test').searchParams;
  assert.equal(query.get('parentId'), 'channels:shows'); assert.equal(query.get('limit'), '12'); assert.equal(query.get('connectionId'), 'c1');
  const movies = await unifiedShelves(c, 'movies', request, signal);
  assert.equal(movies[0].title, 'Synthetic DVR · Recorded movies'); assert.equal(movies[0].parent.id, 'channels:movies');
  paths.length = 0;
  deepEqual(await unifiedShelves(c, 'live', request, signal), []); assert.equal(paths.length, 0, 'the guide replaces the live shelf');
  deepEqual(await unifiedShelves({...c, access: {kinds: ['live']}}, 'series', request, signal), [], 'household kind grants still apply');
});

test('Home asks each Channels connection for recently recorded titles', async () => {
  const c = {id: 'c1', name: 'Synthetic DVR', type: 'channels', configured: true};
  const paths = [];
  const result = await loadHomeConnection(c, async path => {paths.push(path); return {items: [{id: 'file:1', type: 'episode', title: 'Pilot'}, {id: 'movie:2', type: 'movie', title: 'Film'}]};}, new AbortController().signal);
  assert.equal(result.issues.length, 0); assert.equal(result.shelves.length, 1);
  assert.equal(result.shelves[0].title, 'Synthetic DVR · Recently recorded'); assert.equal(result.shelves[0].items.length, 2);
  const query = new URL(paths[0], 'https://x.test').searchParams;
  assert.equal(query.get('parentId'), 'channels:recent'); assert.equal(query.get('limit'), '12');
  const failed = await loadHomeConnection(c, async () => {throw new Error('DVR offline');}, new AbortController().signal);
  assert.match(failed.issues[0], /Recently recorded: DVR offline/);
});
