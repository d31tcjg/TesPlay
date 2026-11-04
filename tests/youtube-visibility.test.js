import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function moduleUrl(path, replacements = {}) {
  let code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  for (const [name, url] of Object.entries(replacements)) {
    code = code.replaceAll(`'${name}'`, `'${url}'`).replaceAll(`"${name}"`, `"${url}"`);
  }
  return 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
}
const { youtubeItemVisible, filterYouTubeItems, filterYouTubeShelves, filterLibraryForYouTubeVisibility, visibleQueueNeighbors } = await import(moduleUrl('../src/youtube-visibility.ts', {
  './types': moduleUrl('../src/types.ts'),
}));
const { homeFeatures, readHomePreview, writeHomePreview } = await import(moduleUrl('../src/home-library.ts'));
const connection = { id: 'youtube-account', type: 'youtube', name: 'YouTube account', configured: true, authMode: 'oauth', oauthAuthorized: true };
const video = (id, duration, extra = {}) => ({ id, title: id, type: 'video', source: 'YouTube', providerType: 'youtube', connectionId: connection.id, duration, ...extra });

test('the YouTube duration heuristic hides only known positive lengths up to and including three minutes', () => {
  for (const duration of [0.01, 30, 179.99, 180]) assert.equal(youtubeItemVisible(video('short', duration), true), false, String(duration));
  for (const duration of [180.01, 181, 600]) assert.equal(youtubeItemVisible(video('long', duration), true), true, String(duration));
  for (const duration of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(youtubeItemVisible(video('unknown', duration), true), true, String(duration));
  assert.equal(youtubeItemVisible(video('short', 20), false), true);
});

test('short non-YouTube videos and live/audio media stay visible, including when marked as reels', () => {
  for (const providerType of ['plex', 'local', 'drive', 'xtream']) {
    assert.equal(youtubeItemVisible(video('other', 20, { providerType, source: providerType, connectionId: providerType, contentKind: 'shorts' }), true, [connection]), true, providerType);
  }
  for (const type of ['live', 'audio', 'movie', 'episode', 'folder', 'series']) {
    assert.equal(youtubeItemVisible(video('not-video', 20, { type, contentKind: 'shorts' }), true), true, type);
  }
});

test('provider inference handles normalized source metadata and legacy connector-only YouTube items', () => {
  assert.equal(youtubeItemVisible(video('source', 60, { providerType: undefined, connectionId: undefined }), true), false);
  const legacy = video('legacy', 60, { providerType: undefined, source: 'My account' });
  assert.equal(youtubeItemVisible(legacy, true), true);
  assert.equal(youtubeItemVisible(legacy, true, [connection]), false);
  assert.equal(youtubeItemVisible({ id: 'unknown', type: 'video' }, true), true);
});

test('explicit YouTube Shorts/Reels metadata overrides missing or long duration while ordinary watch URLs do not', () => {
  for (const contentKind of ['short', 'shorts', 'reel', 'Reels', ' SHORTS ']) {
    assert.equal(youtubeItemVisible(video('explicit', 600, { contentKind }), true), false, contentKind);
  }
  for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com']) {
    assert.equal(youtubeItemVisible(video('linked', undefined, { providerType: undefined, source: 'Saved link', externalUrl: `https://${host}/shorts/abcdefghijk?feature=share` }), true), false, host);
  }
  assert.equal(youtubeItemVisible(video('watch', undefined, { playbackUrl: 'https://www.youtube.com/watch?v=abcdefghijk' }), true), true);
  assert.equal(youtubeItemVisible(video('foreign', undefined, { providerType: 'local', source: 'Local', externalUrl: 'https://example.test/shorts/abcdefghijk' }), true), true);
});

test('visible library projections use measured history duration without changing saved items or removing data', () => {
  const short = video('short', 60), long = video('long', 600), unknown = video('unknown');
  const local = video('local', 30, { source: 'Local', providerType: 'local', connectionId: 'local' });
  const progress = [
    { item: unknown, seconds: 20, duration: 60, updatedAt: '2026-10-10' },
    { item: video('zero', 0), seconds: 20, duration: 180, updatedAt: '2026-10-10' },
    { item: long, seconds: 20, duration: 60, updatedAt: '2026-10-10' },
    { item: local, seconds: 20, duration: 30, updatedAt: '2026-10-10' },
  ];
  const original = { favorites: [short, long, local], queue: [short, unknown, long], plexWatchlist: [local], progress, stars: [] };
  const before = structuredClone(original);
  Object.freeze(original);
  for (const values of [original.favorites, original.queue, original.plexWatchlist, original.progress]) Object.freeze(values);
  const visible = filterLibraryForYouTubeVisibility(original, true, [connection]);
  assert.deepEqual(visible.favorites.map(item => item.id), ['long', 'local']);
  assert.deepEqual(visible.queue.map(item => item.id), ['long']);
  assert.deepEqual(visible.progress.map(entry => entry.item.id), ['long', 'local']);
  assert.equal(visible.stars, original.stars);
  assert.equal(visible.progress[0], progress[2]);
  assert.deepEqual(original, before);
  assert.equal(filterLibraryForYouTubeVisibility(original, false), original);
  assert.deepEqual(filterLibraryForYouTubeVisibility({ favorites: [], progress: [] }, true), { favorites: [], progress: [] });
});

test('recorded playback duration hides pasted favorites and queue entries without mutating saved data', () => {
  const pasted = video('pasted'), unmeasured = video('unmeasured'), measuredLong = video('measured-long');
  const local = video('pasted', undefined, { source: 'Local', providerType: 'local', connectionId: 'local' });
  const knownLong = video('known-long', 600);
  const progress = [
    { item: { ...pasted }, duration: 60 },
    { item: { ...measuredLong }, duration: 600 },
    { item: { ...knownLong }, duration: 60 },
    { item: { ...local }, duration: 60 },
  ];
  const library = { favorites: [pasted, unmeasured, measuredLong, knownLong, local], queue: [pasted, unmeasured, local], progress };
  const before = structuredClone(library);
  for (const item of [...library.favorites, ...progress.map(entry => entry.item)]) Object.freeze(item);
  const visible = filterLibraryForYouTubeVisibility(library, true, [connection]);
  assert.deepEqual(visible.favorites, [unmeasured, measuredLong, knownLong, local]);
  assert.deepEqual(visible.queue, [unmeasured, local]);
  assert.deepEqual(visible.progress, progress.slice(1));
  assert.equal(visible.favorites[1], measuredLong);
  assert.equal(visible.queue[0], unmeasured);
  assert.deepEqual(library, before);
  assert.equal(pasted.duration, undefined);
  assert.equal(filterLibraryForYouTubeVisibility(library, false, [connection]), library);
});

test('queue navigation skips recorded Shorts before and after the raw playing entry while restoring them when disabled', () => {
  const previous = video('previous', 600), before = video('before'), current = video('current'), after = video('after');
  const unknown = video('unknown');
  const progress = [before, current, after].map(item => ({ item: { ...item }, duration: 60 }));
  const queue = [previous, before, current, after, unknown];
  assert.deepEqual(visibleQueueNeighbors(queue, current, true, [connection], progress), { inQueue: true, previous, next: unknown });
  assert.deepEqual(visibleQueueNeighbors(queue, current, false, [connection], progress), { inQueue: true, previous: before, next: after });
  assert.deepEqual(visibleQueueNeighbors(queue, current, true, [connection]), { inQueue: true, previous: before, next: after });
  assert.equal(queue[1], before);
  assert.equal(before.duration, undefined);
});

test('invalid item lengths use only positive finite playback measurements and preserve provider identity', () => {
  for (const duration of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const item = video('invalid-length', duration);
    const local = video('invalid-length', duration, { source: 'Local', providerType: 'local', connectionId: 'local' });
    const library = { favorites: [item, local], queue: [item, local], progress: [{ item, duration: 180 }] };
    assert.deepEqual(filterLibraryForYouTubeVisibility(library, true).favorites, [local], String(duration));
    assert.deepEqual(filterLibraryForYouTubeVisibility(library, true).queue, [local], String(duration));
  }
  for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const item = video('unknown');
    const library = { favorites: [item], queue: [item], progress: [{ item, duration }] };
    assert.deepEqual(filterLibraryForYouTubeVisibility(library, true).favorites, [item], String(duration));
    assert.deepEqual(filterLibraryForYouTubeVisibility(library, true).queue, [item], String(duration));
  }
});

test('fetched unknown-duration videos and shelves reuse playback measurements without changing fetched metadata', () => {
  const measuredShort = video('measured-short'), unknown = video('unknown'), knownLong = video('known-long', 600);
  const local = video('measured-short', undefined, { source: 'Local', providerType: 'local', connectionId: 'local' });
  const progress = [{ item: { ...measuredShort }, duration: 60 }, { item: { ...knownLong }, duration: 60 }];
  const items = [measuredShort, unknown, knownLong, local];
  const shelves = [{ id: 'hidden', items: [measuredShort] }, { id: 'mixed', items }];
  const before = structuredClone(shelves);
  assert.deepEqual(filterYouTubeItems(items, true, [connection], progress), [unknown, knownLong, local]);
  const visible = filterYouTubeShelves(shelves, true, [connection], progress);
  assert.deepEqual(visible, [{ id: 'mixed', items: [unknown, knownLong, local] }]);
  assert.equal(visible[0].items[0], unknown);
  assert.deepEqual(shelves, before);
  assert.equal(measuredShort.duration, undefined);
  assert.equal(filterYouTubeItems(items, false, [connection], progress), items);
  assert.deepEqual(filterYouTubeShelves(shelves, false, [connection], progress), shelves);
});

test('queue navigation skips hidden entries around a currently playing Short and preserves ordering', () => {
  const previous = video('previous', 600), next = video('next', 600);
  const current = video('playing-short', 60);
  const queue = [previous, video('before', 30), current, video('after', 20), next];
  assert.deepEqual(visibleQueueNeighbors(queue, current, true), { inQueue: true, previous, next });
  assert.deepEqual(visibleQueueNeighbors(queue, current, false), { inQueue: true, previous: queue[1], next: queue[3] });
  assert.deepEqual(visibleQueueNeighbors(queue, video('missing', 60), true), { inQueue: false });
  assert.deepEqual(visibleQueueNeighbors([current], current, true), { inQueue: true, previous: undefined, next: undefined });
  assert.deepEqual(queue.map(item => item.id), ['previous', 'before', 'playing-short', 'after', 'next']);
});

test('queue neighbors keep short local videos and unknown YouTube lengths and match complete media identity', () => {
  const current = video('same-id', 60);
  const local = video('same-id', 20, { source: 'Local', providerType: 'local', connectionId: 'local' });
  const unknown = video('unknown');
  assert.deepEqual(visibleQueueNeighbors([local, current, unknown], { ...current }, true, [connection]), { inQueue: true, previous: local, next: unknown });
});

test('cached Home shelves filter before Highlights selection and restore immediately when hiding is disabled', () => {
  const saved = new Map();
  const storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const short = video('new-short', 30, { publishedAt: '2026-10-10T00:00:00Z' });
  const long = Array.from({ length: 6 }, (_, index) => video(`long-${index}`, 600, { publishedAt: `2026-10-0${index + 1}T00:00:00Z` }));
  const result = { shelves: [
    { id: 'short-only', title: 'Short channel', connectionId: connection.id, items: [short] },
    { id: 'mixed', title: 'Mixed channel', connectionId: connection.id, items: [short, ...long] },
  ], issues: [] };
  writeHomePreview('account:profile', connection, [], result, storage);
  const cachedJson = [...saved.values()][0];
  const cached = readHomePreview('account:profile', connection, [], storage);
  const visible = filterYouTubeShelves(cached.shelves, true, [connection]);
  assert.deepEqual(visible.map(shelf => shelf.id), ['mixed']);
  const featured = homeFeatures(visible);
  assert.equal(featured.length, 6);
  assert.ok(featured.every(item => item.id.startsWith('long-')));
  assert.equal(homeFeatures(filterYouTubeShelves(cached.shelves, false))[0].id, 'new-short');
  assert.equal([...saved.values()][0], cachedJson);
  assert.equal(cached.shelves[0].items[0].id, 'new-short');
});

test('filtered Highlights remain balanced across connectors without hiding short non-YouTube films', () => {
  const youtubeItems = [video('recent-short', 30, { publishedAt: '2026-10-10' }), ...Array.from({ length: 3 }, (_, index) => video(`youtube-${index}`, 600, { publishedAt: `2026-10-0${index + 1}` }))];
  const plexItems = Array.from({ length: 3 }, (_, index) => video(`plex-${index}`, 30, { type: 'movie', source: 'Plex', providerType: 'plex', connectionId: 'plex', publishedAt: `2026-10-0${index + 1}` }));
  const shelves = [{ connectionId: connection.id, items: youtubeItems }, { connectionId: 'plex', items: plexItems }];
  const featured = homeFeatures(filterYouTubeShelves(shelves, true, [connection]));
  assert.equal(featured.length, 6);
  assert.deepEqual(featured.map(item => item.id), ['youtube-2', 'plex-2', 'youtube-1', 'plex-1', 'youtube-0', 'plex-0']);
  assert.equal(filterYouTubeItems(youtubeItems, false), youtubeItems);
});
