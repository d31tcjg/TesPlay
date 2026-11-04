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
const { episodePicker, episodesPath } = await import(moduleUrl('../src/episodes.ts', {
  './types': moduleUrl('../src/types.ts'),
}));
const episode = (id, seasonNumber, episodeNumber, connectionId = 'plex') => ({
  id, seasonNumber, episodeNumber, connectionId, title: id, source: 'Source', type: 'episode',
});

test('episode pickers use full media identity when providers reuse episode IDs', () => {
  const first = episode('same-id', 1, 1, 'first-provider');
  const selected = episode('same-id', 2, 4, 'second-provider');
  const result = episodePicker([first, selected], { ...selected });
  assert.equal(result.selected, selected);
  assert.equal(result.currentSeason, 2);
  assert.equal(result.currentEpisode, 4);
  assert.deepEqual(result.episodes, [selected]);
  assert.equal(episodePicker([first], selected).selected, undefined);
});

test('seasons and episodes sort numerically, keep specials and preserve provider input order', () => {
  const items = [episode('season-ten', 10, 1), episode('second', 2, 2), episode('special', undefined, undefined), episode('first', 2, 1)];
  const original = [...items];
  const result = episodePicker(items, items[1], 2);
  assert.deepEqual(result.seasons, [0, 2, 10]);
  assert.deepEqual(result.episodes.map(item => item.id), ['first', 'second']);
  assert.deepEqual(items, original);
  const specials = episodePicker(items, items[2]);
  assert.equal(specials.currentSeason, 0);
  assert.equal(specials.currentEpisode, 1);
  assert.deepEqual(specials.episodes, [items[2]]);
});

test('refreshes fall back to the selected season when a browsed season disappears', () => {
  const current = episode('current', 3, 2);
  const other = episode('other', 5, 1);
  assert.equal(episodePicker([current, other], current, 5).season, 5);
  const refreshed = episodePicker([current], current, 5);
  assert.equal(refreshed.season, 3);
  assert.deepEqual(refreshed.episodes, [current]);
  const empty = episodePicker([], current, 5);
  assert.equal(empty.currentSeason, 0);
  assert.equal(empty.currentEpisode, 1);
  assert.deepEqual(empty.seasons, []);
  assert.deepEqual(empty.episodes, []);
});

test('episode requests encode provider/item IDs and support series, episodes and folder collections', () => {
  for (const type of ['series', 'episode', 'folder']) {
    const url = new URL(episodesPath({ ...episode('show & episode', 1, 1, 'provider/with spaces'), type }), 'https://tesplay.test');
    assert.equal(url.pathname, '/episodes');
    assert.equal(url.searchParams.get('connectionId'), 'provider/with spaces');
    assert.equal(url.searchParams.get('itemId'), 'show & episode');
    assert.equal(url.searchParams.get('kind'), type);
  }
  assert.equal(new URL(episodesPath({ ...episode('id'), connectionId: undefined }), 'https://tesplay.test').searchParams.get('connectionId'), '');
});
