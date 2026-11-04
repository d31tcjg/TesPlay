import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function moduleUrl(path, replacements = {}) {
  let source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  for (const [specifier, url] of Object.entries(replacements)) source = source.replaceAll(`'${specifier}'`, `'${url}'`);
  return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
}
const typesUrl = moduleUrl('../src/types.ts');
const { itemKey } = await import(typesUrl);
const { createDetailsState, detailsReducer, detailsCanPlay, detailsPlaybackSettings, startDetailsDiscovery, detailsDiscoveryTimeoutMs } = await import(moduleUrl('../src/media-details-state.ts', {
  './types': typesUrl,
  './player-preferences': moduleUrl('../src/player-preferences.ts'),
}));
const episode = id => ({ id, connectionId: 'iptv', source: 'IPTV', title: id, type: 'episode' });
const identity = state => ({ key: itemKey(state.selected), selectionId: state.selectionId });
const preferences = { audioLanguage: 'nl', subtitleLanguage: 'en', subtitlesEnabled: true, qualityId: '720p' };
const options = {
  audio: [{ id: 'en', label: 'English', language: 'en' }, { id: 'nl', label: 'Dutch', language: 'nl' }],
  subtitles: [{ id: 'subs-en', label: 'English', language: 'en' }],
  qualities: [{ id: 'auto', label: 'Auto' }, { id: '720p', label: '720p' }],
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function clock() {
  let callback, milliseconds, canceled = 0;
  return {
    schedule: (run, ms) => { callback = run; milliseconds = ms; return () => { canceled++; }; },
    expire: () => callback(),
    get milliseconds() { return milliseconds; },
    get canceled() { return canceled; },
  };
}

test('Play needs a real selected episode, independently of pending discovery or unavailable options', () => {
  let state = createDetailsState(null);
  assert.equal(detailsCanPlay(state), false);
  state = detailsReducer(state, { type: 'select-initial', item: episode('first') });
  assert.equal(state.status, 'pending');
  assert.equal(detailsCanPlay(state), true);
  assert.deepEqual(detailsPlaybackSettings(state), {}, 'unset audio and quality allow player profile preferences to resolve');
  state = detailsReducer(state, { type: 'failed', identity: identity(state), error: 'No track choices available' });
  assert.equal(detailsCanPlay(state), true);
  assert.deepEqual(detailsPlaybackSettings(state), {});
  assert.equal(detailsCanPlay(state, true), false);
  assert.equal(detailsCanPlay(createDetailsState({ ...episode('missing'), unavailable: true })), false);
  assert.equal(detailsCanPlay(createDetailsState({ ...episode('series'), type: 'series' })), false);
  assert.equal(detailsCanPlay(createDetailsState({ ...episode('folder'), type: 'folder' })), false);
});

test('late profile defaults preserve Start from beginning, compatibility and explicit user choices', () => {
  let state = createDetailsState(episode('first'));
  state = detailsReducer(state, { type: 'edit', patch: { startOver: true, compatibility: true, audioTrackId: 'en' } });
  assert.deepEqual(detailsPlaybackSettings(state), { startOver: true, compatibility: true, audioTrackId: 'en' });
  state = detailsReducer(state, { type: 'resolved', identity: identity(state), options, preferences });
  assert.deepEqual(state.profileSettings, { audioTrackId: 'nl', subtitleTrackId: 'subs-en', qualityId: '720p' });
  assert.deepEqual(detailsPlaybackSettings(state), { audioTrackId: 'en', subtitleTrackId: 'subs-en', qualityId: '720p', startOver: true, compatibility: true });
  state = detailsReducer(state, { type: 'edit', patch: { startOver: false, subtitleTrackId: 'off', qualityId: 'auto' } });
  assert.deepEqual(detailsPlaybackSettings(state), { audioTrackId: 'en', subtitleTrackId: 'off', qualityId: 'auto', startOver: false, compatibility: true });
});

test('unresolved option lists leave profile choices to the player instead of forcing source defaults', () => {
  let state = createDetailsState(episode('first'));
  state = detailsReducer(state, { type: 'edit', patch: { startOver: true } });
  state = detailsReducer(state, { type: 'resolved', identity: identity(state), options: { audio: [], subtitles: [], qualities: [] }, preferences });
  assert.equal(state.status, 'complete');
  assert.deepEqual(detailsPlaybackSettings(state), { startOver: true });
  state = detailsReducer(state, { type: 'select', item: episode('second') });
  state = detailsReducer(state, { type: 'resolved', identity: identity(state), options: { ...options, audio: [], qualities: [] }, preferences });
  assert.deepEqual(detailsPlaybackSettings(state), { subtitleTrackId: 'subs-en' }, 'known subtitle defaults apply without forcing undiscovered audio or quality');
});

test('episode switches clear old options and reject stale completions even after switching back', () => {
  let state = createDetailsState(episode('first'));
  const firstRequest = identity(state);
  state = detailsReducer(state, { type: 'resolved', identity: firstRequest, options: { ...options, item: state.selected }, preferences });
  state = detailsReducer(state, { type: 'select', item: episode('second') });
  assert.equal(state.selected.id, 'second');
  assert.equal(detailsCanPlay(state), true);
  assert.deepEqual(state.options, { audio: [], subtitles: [], qualities: [] });
  assert.deepEqual(detailsPlaybackSettings(state), {});
  assert.equal(detailsReducer(state, { type: 'resolved', identity: firstRequest, options, preferences }), state);
  state = detailsReducer(state, { type: 'select', item: episode('first') });
  assert.equal(detailsReducer(state, { type: 'resolved', identity: firstRequest, options, preferences }), state);
});

test('a fulfilled discovery publishes choices once and releases temporary media without blocking Play', async () => {
  let state = createDetailsState(episode('first')), signal, released = 0, results = 0;
  const request = deferred(), timer = clock(), requestIdentity = identity(state);
  const stop = startDetailsDiscovery(value => {
    signal = value;
    signal.addEventListener('abort', () => { released++; }, { once: true });
    return request.promise;
  }, {
    onResult: value => { results++; state = detailsReducer(state, { type: 'resolved', identity: requestIdentity, ...value }); },
    onError: reason => { throw reason; },
  }, { schedule: timer.schedule });
  await flush();
  assert.equal(detailsCanPlay(state), true);
  assert.equal(signal.aborted, false);
  state = detailsReducer(state, { type: 'edit', patch: { startOver: true } });
  request.resolve({ options, preferences });
  await flush();
  assert.equal(state.status, 'complete');
  assert.equal(detailsPlaybackSettings(state).startOver, true);
  assert.equal(signal.aborted, true);
  assert.equal(released, 1);
  assert.equal(results, 1);
  assert.equal(timer.canceled, 1);
  stop(); timer.expire();
  assert.equal(results, 1);
  assert.equal(released, 1);
});

test('rejected discovery keeps default playback usable and cleans resources', async () => {
  let state = createDetailsState(episode('first')), signal;
  const requestIdentity = identity(state), timer = clock();
  startDetailsDiscovery(value => { signal = value; return Promise.reject(new Error('Unsupported optional metadata')); }, {
    onResult: () => assert.fail('rejected discovery cannot publish options'),
    onError: reason => { state = detailsReducer(state, { type: 'failed', identity: requestIdentity, error: reason.message }); },
  }, { schedule: timer.schedule });
  await flush();
  assert.equal(state.status, 'failed');
  assert.equal(state.error, 'Unsupported optional metadata');
  assert.equal(detailsCanPlay(state), true);
  assert.deepEqual(detailsPlaybackSettings(state), {});
  assert.equal(signal.aborted, true);
});

test('the whole-flow deadline stops a never-settling resolver, clears loading and ignores late results', async () => {
  let state = createDetailsState(episode('first')), signal, errors = 0;
  const request = deferred(), timer = clock(), requestIdentity = identity(state);
  startDetailsDiscovery(value => { signal = value; return request.promise; }, {
    onResult: () => assert.fail('timed-out discovery cannot publish late options'),
    onError: reason => { errors++; state = detailsReducer(state, { type: 'failed', identity: requestIdentity, error: reason.message }); },
  }, { schedule: timer.schedule });
  await flush();
  assert.equal(timer.milliseconds, detailsDiscoveryTimeoutMs);
  timer.expire();
  assert.equal(state.status, 'failed');
  assert.equal(detailsCanPlay(state), true);
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.name, 'TimeoutError');
  request.resolve({ options, preferences });
  await flush();
  assert.equal(errors, 1);
  assert.equal(state.options.audio.length, 0);
});

test('close or episode-switch cancellation releases discovery and suppresses every late UI result', async () => {
  for (const completion of ['resolve', 'reject']) {
    const request = deferred(), timer = clock();
    let signal, published = 0, released = 0;
    const stop = startDetailsDiscovery(value => {
      signal = value;
      signal.addEventListener('abort', () => { released++; }, { once: true });
      return request.promise;
    }, { onResult: () => { published++; }, onError: () => { published++; } }, { schedule: timer.schedule });
    await flush();
    stop(); stop();
    request[completion](new Error('Late completion'));
    timer.expire();
    await flush();
    assert.equal(signal.aborted, true);
    assert.equal(released, 1);
    assert.equal(published, 0);
  }
});
