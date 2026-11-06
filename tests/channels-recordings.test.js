import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const load = name => {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
  }).outputText;
  vm.runInNewContext(code, {exports, Date, Math, Number, Set, Array, Object, JSON, Intl});
  return exports;
};
const r = load('channels-recordings');
const plain = v => JSON.parse(JSON.stringify(v));
const item = (id, extra = {}) => ({id, title: `T${id}`, type: 'episode', source: 'S', ...extra});

test('row formatting: date, channel, duration and subtitle', () => {
  const when = '2026-11-04T22:00:00.000Z';
  assert.equal(r.formatRecordedAt(when, {locale: 'en-US', timeZone: 'UTC'}), 'Wed, Nov 4 · 10:00 PM');
  assert.equal(r.formatRecordedAt(undefined), ''); assert.equal(r.formatRecordedAt('garbage'), '');
  assert.equal(r.formatDuration(5700), '1h 35m'); assert.equal(r.formatDuration(3600), '1h'); assert.equal(r.formatDuration(2700), '45m');
  assert.equal(r.formatDuration(10), '1m'); assert.equal(r.formatDuration(0), ''); assert.equal(r.formatDuration(undefined), '');
  const row = r.recordingRow(item('1', {subtitle: 'Show', recordedAt: when, channel: '36.1', duration: 1800}), {locale: 'en-US', timeZone: 'UTC'});
  assert.deepEqual(plain(row), {title: 'T1', subtitle: 'Show', when: 'Wed, Nov 4 · 10:00 PM', channel: '36.1', duration: '30m', watched: false, meta: 'Wed, Nov 4 · 10:00 PM · 36.1 · 30m'});
  assert.equal(r.recordingRow(item('2', {type: 'movie', subtitle: 'ignored'})).subtitle, '', 'movies have no show subtitle');
});

test('row progress and watched state', () => {
  assert.equal(r.recordingRow(item('1', {duration: 100, resumeSeconds: 25})).progress, 25);
  assert.equal(r.recordingRow(item('1', {duration: 100, resumeSeconds: 0})).progress, undefined);
  assert.equal(r.recordingRow(item('1', {}), {libraryPercent: 40}).progress, 40, 'falls back to TesPlay progress');
  const watched = r.recordingRow(item('1', {watched: true, duration: 100, resumeSeconds: 50}));
  assert.equal(watched.watched, true); assert.equal(watched.progress, undefined, 'no progress bar once watched');
  assert.equal(r.recordingRow(item('1', {duration: 100, resumeSeconds: 98})).watched, true);
});

test('infinite scroll: load only near the end, once, and not after a failure', () => {
  const base = {hasMore: true, loading: false, failed: false, distanceToEnd: 100};
  assert.equal(r.shouldLoadMore(base), true);
  assert.equal(r.shouldLoadMore({...base, distanceToEnd: r.LOAD_MORE_MARGIN + 1}), false, 'far from the end');
  assert.equal(r.shouldLoadMore({...base, distanceToEnd: -50}), true, 'sentinel already on screen');
  assert.equal(r.shouldLoadMore({...base, hasMore: false}), false);
  assert.equal(r.shouldLoadMore({...base, loading: true}), false);
  assert.equal(r.shouldLoadMore({...base, failed: true}), false, 'a failed page waits for Try again');
});

test('page merge keeps order and drops duplicates', () => {
  const first = [item('3'), item('2')];
  assert.deepEqual(plain(r.mergePage(first, [item('2'), item('1'), item('1')]).map(i => i.id)), ['3', '2', '1']);
  assert.equal(r.mergePage(first, [item('3')]), first, 'nothing new returns the same array');
  assert.deepEqual(plain(r.mergePage([], [item('9')]).map(i => i.id)), ['9']);
});

test('recordings folder helpers', () => {
  assert.equal(r.RECORDINGS_FOLDER_ID, 'channels:recordings');
  const folder = r.recordingsFolder({id: 'c1', name: 'DVR'});
  assert.deepEqual(plain(folder), {id: 'channels:recordings', title: 'Recordings', type: 'folder', source: 'DVR', connectionId: 'c1', contentKind: 'series'});
  assert.equal(r.isRecordingsFolder({type: 'channels'}, folder), true);
  assert.equal(r.isRecordingsFolder({type: 'plex'}, folder), false, 'scoped to Channels');
  assert.equal(r.isRecordingsFolder({type: 'channels'}, {id: 'channels:shows'}), false);
  assert.equal(r.isRecordingsFolder({type: 'channels'}, undefined), false);
});
