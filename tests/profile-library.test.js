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
const typesUrl = moduleUrl('../src/types.ts');
const { ProfileLibrary, createLibraryIdentity } = await import(moduleUrl('../src/profile-library.ts', {
  './api': moduleUrl('../src/api.ts'),
  './types': typesUrl,
  './plex-continuity': moduleUrl('../src/plex-continuity.ts', { './types': typesUrl }),
}));
const item = (id, connectionId = 'source') => ({ id, connectionId, type: 'movie', title: id, source: 'Library' });
const library = (favorites = [], progress = []) => ({ favorites, progress });
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture(request, connections = []) {
  const messages = [];
  const controller = new ProfileLibrary({ request, connections: () => connections, onToast: message => messages.push(message), now: () => '2026-10-10T12:00:00.000Z' });
  let currentIdentity = createLibraryIdentity('account', 'profile-a');
  controller.setIdentity(currentIdentity);
  const identity = currentIdentity;
  const switchIdentity = (userId, profileId) => {
    currentIdentity = createLibraryIdentity(userId, profileId, currentIdentity);
    controller.setIdentity(currentIdentity);
    return currentIdentity;
  };
  return { controller, identity, messages, switchIdentity };
}

test('a slow favorite cannot overwrite the next profile and sends its originating profile to the server', async () => {
  const delayed = deferred(), requests = [];
  const f = fixture(async (path, body) => {
    requests.push({ path, body });
    return path === '/library/favorites' ? delayed.promise : library([item('profile-b-film')]);
  });
  const favorite = f.controller.favorite(item('profile-a-film'));
  f.switchIdentity('account', 'profile-b');
  await f.controller.load();
  delayed.resolve({ favorites: [item('profile-a-film')] });
  await favorite;
  assert.equal(requests[0].body.profileId, 'profile-a');
  assert.deepEqual(f.controller.getSnapshot().value.favorites.map(value => value.id), ['profile-b-film']);
  assert.deepEqual(f.messages, []);
});

test('returning to the same profile invalidates earlier loads, stars and queue responses', async () => {
  for (const operation of ['load', 'star', 'updateQueue']) {
    const delayed = deferred();
    const f = fixture(() => delayed.promise);
    const pending = operation === 'star'
      ? f.controller.star({ connectionId: 'source', kind: 'category', id: 'category', title: 'Category' })
      : operation === 'updateQueue' ? f.controller.updateQueue('add', item('old')) : f.controller.load();
    f.switchIdentity('account', 'profile-b');
    const returned = f.switchIdentity('account', 'profile-a');
    delayed.resolve({ ...library([item('old')]), stars: [{ id: 'old' }], queue: [item('old')] });
    await pending;
    assert.notEqual(returned, f.identity);
    assert.notEqual(f.controller.getSnapshot().identity, returned, operation);
    assert.deepEqual(f.controller.getSnapshot().value, library(), operation);
  }
});

test('the latest library load wins when requests finish out of order', async () => {
  const first = deferred(), second = deferred();
  let count = 0;
  const f = fixture(() => (++count === 1 ? first : second).promise);
  const older = f.controller.load(), newer = f.controller.load();
  second.resolve(library([item('newer')]));
  await newer;
  first.resolve(library([item('older')]));
  await older;
  assert.deepEqual(f.controller.getSnapshot().value.favorites.map(value => value.id), ['newer']);
});

test('Plex continuity combines successful connections with local state and reports failed connections', async () => {
  const localItem = item('local'), plexItem = item('plex', 'plex-good');
  const localProgress = { item: localItem, seconds: 10, duration: 100, updatedAt: '2026-10-09T12:00:00.000Z' };
  const plexProgress = { item: plexItem, seconds: 20, duration: 100, updatedAt: '2026-10-10T12:00:00.000Z' };
  const f = fixture(async path => {
    if (path === '/library/state') return { ...library([localItem], [localProgress]), queue: [localItem] };
    if (path.includes('plex-good')) return { progress: [plexProgress], watchlist: [plexItem] };
    throw new Error('Connection unavailable');
  }, [{ id: 'plex-good', type: 'plex' }, { id: 'plex-bad', type: 'plex' }]);
  await f.controller.load();
  const value = f.controller.getSnapshot().value;
  assert.deepEqual(value.favorites, [localItem]);
  assert.deepEqual(value.queue, [localItem]);
  assert.deepEqual(value.progress, [plexProgress, localProgress]);
  assert.deepEqual(value.plexWatchlist, [plexItem]);
  assert.match(value.plexNotes[0], /Plex continuity could not refresh/);
});

test('a delayed Plex refresh cannot publish into a different account with the same profile ID', async () => {
  const delayed = deferred();
  const f = fixture(async path => path === '/library/state' ? library([item('local')]) : delayed.promise, [{ id: 'plex', type: 'plex' }]);
  const pending = f.controller.load();
  await Promise.resolve();
  f.switchIdentity('another-account', 'profile-a');
  delayed.resolve({ progress: [], watchlist: [item('old-plex')] });
  await pending;
  assert.equal(f.controller.getSnapshot().identity, f.identity);
  assert.equal(f.controller.getSnapshot().value.plexWatchlist, undefined);
});

test('progress checkpoints stay ordered, continue after a failed save and retain keepalive/profile metadata', async () => {
  const first = deferred(), requests = [];
  const f = fixture(async (path, body, method, signal, keepalive) => {
    requests.push({ path, body, method, signal, keepalive });
    return requests.length === 1 ? first.promise : {};
  });
  const playing = f.controller.saveProgress(f.identity, item('film'), 10, 100, 'playing');
  const paused = f.controller.saveProgress(f.identity, item('film'), 20, 100, 'paused');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  first.reject(new Error('Network interrupted'));
  await Promise.all([playing, paused]);
  assert.deepEqual(requests.map(request => [request.body.seconds, request.body.state, request.body.profileId, request.keepalive]), [
    [10, 'playing', 'profile-a', true], [20, 'paused', 'profile-a', true],
  ]);
  assert.match(f.messages[0], /Watch progress could not be saved: Network interrupted/);
  assert.equal(f.controller.getSnapshot().value.progress[0].seconds, 20);
});

test('a profile switch finishes ordered checkpoints for the originating profile without updating the new profile', async () => {
  const delayed = deferred(), requests = [];
  const currentLibrary = library([item('profile-b-film')]);
  const f = fixture(async (path, body, method, signal, keepalive) => {
    if (path === '/library/state') return currentLibrary;
    requests.push({ path, body, keepalive });
    return requests.length === 1 ? delayed.promise : { plexSyncError: 'Old-profile synchronization note' };
  });
  const first = f.controller.saveProgress(f.identity, item('film'), 10, 100, 'playing');
  const queued = f.controller.saveProgress(f.identity, item('film'), 20, 100, 'paused');
  await new Promise(resolve => setImmediate(resolve));
  const nextProfile = f.switchIdentity('account', 'profile-b');
  assert.equal(nextProfile.accountSession, f.identity.accountSession);
  await f.controller.load();
  const final = f.controller.saveProgress(f.identity, item('film'), 30, 100, 'stopped');
  assert.equal(requests.length, 1);
  delayed.resolve({});
  await Promise.all([first, queued, final]);
  assert.deepEqual(requests.map(request => [request.body.seconds, request.body.state, request.body.profileId, request.keepalive]), [
    [10, 'playing', 'profile-a', true], [20, 'paused', 'profile-a', true], [30, 'stopped', 'profile-a', true],
  ]);
  assert.equal(f.controller.getSnapshot().identity, nextProfile);
  assert.deepEqual(f.controller.getSnapshot().value, currentLibrary);
  assert.deepEqual(f.messages, []);
});

test('account changes and logout/relogin invalidate old progress without delaying new-session checkpoints', async () => {
  for (const intermediateAccount of ['another-account', null]) {
    const delayed = deferred(), requests = [];
    const f = fixture(async (path, body) => {
      requests.push({ path, body });
      return requests.length === 1 ? delayed.promise : {};
    });
    const original = f.controller.saveProgress(f.identity, item('film'), 10, 100);
    const queued = f.controller.saveProgress(f.identity, item('film'), 20, 100);
    await new Promise(resolve => setImmediate(resolve));
    f.switchIdentity(intermediateAccount, intermediateAccount ? 'profile-a' : null);
    const relogin = f.switchIdentity('account', 'profile-a');
    assert.notEqual(relogin.accountSession, f.identity.accountSession);
    await f.controller.saveProgress(relogin, item('film'), 90, 100);
    assert.deepEqual(requests.map(request => request.body.seconds), [10, 90]);
    delayed.resolve({});
    await Promise.all([original, queued]);
    await f.controller.saveProgress(f.identity, item('film'), 30, 100);
    assert.deepEqual(requests.map(request => request.body.seconds), [10, 90]);
    assert.equal(f.controller.getSnapshot().identity, relogin);
    assert.equal(f.controller.getSnapshot().value.progress[0].seconds, 90);
    assert.deepEqual(f.messages, []);
  }
});

test('preparing an uncommitted identity does not invalidate the active account or its pending requests', async () => {
  const delayed = deferred();
  const f = fixture(() => delayed.promise);
  const pending = f.controller.saveProgress(f.identity, item('film'), 10, 100);
  await new Promise(resolve => setImmediate(resolve));
  const abandonedRender = createLibraryIdentity('another-account', 'profile-b', f.identity);
  assert.notEqual(abandonedRender.accountSession, f.identity.accountSession);
  assert.equal(f.controller.isCurrent(f.identity), true);
  delayed.resolve({});
  await pending;
  assert.equal(f.controller.getSnapshot().identity, f.identity);
  assert.equal(f.controller.getSnapshot().value.progress[0].seconds, 10);
});

test('switching account discards queued progress and suppresses old results and errors', async () => {
  const delayed = deferred(), requests = [];
  const f = fixture(async (path, body) => { requests.push({ path, body }); return delayed.promise; });
  const pending = f.controller.saveProgress(f.identity, item('film'), 10, 100);
  const queued = f.controller.saveProgress(f.identity, item('film'), 20, 100);
  await new Promise(resolve => setImmediate(resolve));
  f.switchIdentity('another-account', 'profile-a');
  delayed.reject(new Error('The active profile changed'));
  await Promise.all([pending, queued]);
  await f.controller.saveProgress(f.identity, item('film'), 30, 100);
  assert.equal(requests.length, 1);
  assert.deepEqual(f.controller.getSnapshot().value.progress, []);
  assert.deepEqual(f.messages, []);
});

test('YouTube favorites keep using the Watch playlist while ordinary unsigned favorites require sign-in', async () => {
  const requests = [], video = { ...item('video', 'youtube'), type: 'video' };
  const f = fixture(async (path, body) => {
    requests.push({ path, body });
    return { queue: body.action === 'add' ? [body.item] : [] };
  }, [{ id: 'youtube', type: 'youtube' }]);
  await f.controller.favorite(video);
  await f.controller.favorite(video);
  assert.deepEqual(requests.map(request => [request.path, request.body.action]), [['/library/queue', 'add'], ['/library/queue', 'remove']]);
  assert.deepEqual(f.messages, ['Added to Watch playlist', 'Removed from Watch playlist']);
  f.switchIdentity(null, null);
  await f.controller.favorite(item('film'));
  assert.equal(requests.length, 2);
  assert.equal(f.messages.at(-1), 'Sign in to save your personal watchlist.');
});
