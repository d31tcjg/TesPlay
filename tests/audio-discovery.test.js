import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Input } from 'mediabunny';
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
const apiUrl = moduleUrl('../src/api.ts');
const preferencesUrl = moduleUrl('../src/player-preferences.ts');
const selectionUrl = moduleUrl('../src/playback-selection.ts', {
  './api': apiUrl, './player-preferences': preferencesUrl, mediabunny: import.meta.resolve('mediabunny'),
});
const { discoverAudioTracks } = await import(selectionUrl);
const { createTesPlayAdapter } = await import(moduleUrl('../src/tesplayer-adapter.ts', {
  './api': apiUrl, './player-preferences': preferencesUrl, './playback-selection': selectionUrl,
  '@canvas-stream-player/contracts': import.meta.resolve('@canvas-stream-player/contracts'),
  '@canvas-stream-player/player': import.meta.resolve('@canvas-stream-player/player'),
}));
const bytes = readFileSync(new URL('./fixtures/two-audio.m4a', import.meta.url));
const identity = 'mr1_' + 'a'.repeat(43);
const changedIdentity = 'mr1_' + 'b'.repeat(43);
const url = 'https://tesplay.test/api/media/file';
const originalDispose = Input.prototype.dispose;

function fixture(t, fetch) {
  const oldFetch = globalThis.fetch, oldLocation = globalThis.location;
  globalThis.location = { origin: 'https://tesplay.test', href: 'https://tesplay.test/' };
  globalThis.fetch = fetch;
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (oldLocation === undefined) delete globalThis.location;
    else globalThis.location = oldLocation;
  });
  return t.mock.method(Input.prototype, 'dispose', function () { return originalDispose.call(this); });
}

function rangeResponse(init, { representation = identity, limit = Infinity, data = bytes, body } = {}) {
  const range = /bytes=(\d+)-(\d*)/.exec(new Headers(init?.headers).get('range') || '');
  const start = Number(range?.[1] || 0);
  const end = Math.min(data.length - 1, range?.[2] ? Number(range[2]) : Infinity, start + limit - 1);
  return new Response(body || data.subarray(start, end + 1), { status: 206, headers: {
    'Content-Type': 'audio/mp4', 'Content-Length': String(end - start + 1),
    'Content-Range': `bytes ${start}-${end}/${data.length}`,
    ...(representation ? { 'X-Csp-Representation-Id': representation } : {}),
  } });
}

test('already-aborted discovery performs no fetch and preserves the caller reason', async t => {
  let requests = 0;
  const dispose = fixture(t, async () => { requests++; return rangeResponse(); });
  const controller = new AbortController(), reason = new DOMException('Closed', 'AbortError');
  controller.abort(reason);
  await assert.rejects(discoverAudioTracks(url, 'picture', controller.signal), error => error === reason);
  assert.equal(requests, 0);
  assert.equal(dispose.mock.callCount(), 0);
});

test('changed or missing representation identity stops real container reads without retries', async t => {
  for (const representation of [changedIdentity, null]) {
    await t.test(representation ? 'changed identity' : 'missing identity', async t => {
      let requests = 0, cancelled = 0;
      const dispose = fixture(t, async (_url, init) => {
        if (++requests === 1) return rangeResponse(init, { limit: 32 });
        const body = new ReadableStream({ cancel() { cancelled++; } });
        return rangeResponse(init, { representation, body });
      });
      const controller = new AbortController();
      await assert.rejects(discoverAudioTracks(url, 'picture', controller.signal), /file changed/);
      assert.equal(requests, 2);
      assert.equal(cancelled, 1);
      assert.equal(dispose.mock.callCount(), 1);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      await nextTurn();
      assert.equal(requests, 2);
    });
  }
});

test('abort after headers immediately disposes pending reads and schedules no retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0, fetchSignal;
  const dispose = fixture(t, async (_url, init) => {
    requests++;
    fetchSignal = init.signal;
    return rangeResponse(init, { body: new ReadableStream() });
  });
  const controller = new AbortController(), reason = new DOMException('Details closed', 'AbortError');
  const discovery = discoverAudioTracks(url, 'picture', controller.signal);
  const rejected = assert.rejects(discovery, error => error === reason);
  await nextTurn();
  assert.equal(requests, 1);
  controller.abort(reason);
  assert.equal(dispose.mock.callCount(), 1);
  assert.equal(fetchSignal.aborted, true);
  await rejected;
  t.mock.timers.tick(60000);
  await nextTurn();
  assert.equal(requests, 1);
  assert.equal(dispose.mock.callCount(), 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('the whole-probe deadline settles even when fetch ignores its abort signal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0, fetchSignal;
  const dispose = fixture(t, async (_url, init) => {
    requests++;
    fetchSignal = init.signal;
    return new Promise(() => {});
  });
  const controller = new AbortController();
  const discovery = discoverAudioTracks(url, 'picture', controller.signal);
  const rejected = assert.rejects(discovery, error => error.name === 'TimeoutError');
  await nextTurn();
  t.mock.timers.tick(10000);
  assert.equal(dispose.mock.callCount(), 1);
  assert.equal(fetchSignal.aborted, true);
  await rejected;
  assert.equal(controller.signal.aborted, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  t.mock.timers.tick(60000);
  await nextTurn();
  assert.equal(requests, 1);
});

test('repeated transport errors exhaust a finite retry allowance', async t => {
  t.mock.method(console, 'error', () => {});
  let requests = 0;
  const reason = new Error('Temporary network failure');
  const dispose = fixture(t, async () => { requests++; throw reason; });
  const controller = new AbortController();
  await assert.rejects(discoverAudioTracks(url, 'picture', controller.signal), error => error === reason);
  assert.equal(requests, 3);
  assert.equal(dispose.mock.callCount(), 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('body-read resumptions share the retry allowance instead of resetting it', async t => {
  t.mock.method(console, 'error', () => {});
  let requests = 0;
  const reason = new Error('Temporary body read failure');
  fixture(t, async (_url, init) => {
    requests++;
    return rangeResponse(init, { body: new ReadableStream({ start(controller) { controller.error(reason); } }) });
  });
  await assert.rejects(discoverAudioTracks(url, 'picture', new AbortController().signal), error => error === reason);
  assert.equal(requests, 3);
});

test('a transient failure can recover and keep both real tracks and pinned selectors', async t => {
  t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0;
  const dispose = fixture(t, async (_url, init) => {
    if (++requests === 1) throw new Error('Temporary failure');
    return rangeResponse(init);
  });
  const controller = new AbortController();
  const discovery = discoverAudioTracks(url, 'picture', controller.signal);
  await nextTurn();
  t.mock.timers.tick(250);
  const result = await discovery;
  assert.equal(requests, 2);
  assert.equal(result.representationId, identity);
  assert.deepEqual(result.tracks.map(track => track.language), ['eng', 'nld']);
  assert.deepEqual(result.tracks.map(track => track.selector.trackNumber), [1, 2]);
  assert.ok(result.tracks.every(track => track.selector.resourceId === 'picture' && track.selector.representationId === identity));
  assert.equal(dispose.mock.callCount(), 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  t.mock.timers.tick(60000);
  await nextTurn();
  assert.equal(dispose.mock.callCount(), 1);
  assert.equal(requests, 2);
});

test('expired access sessions are terminal instead of consuming retries', async t => {
  let requests = 0;
  fixture(t, async () => { requests++; return new Response('', { status: 401, headers: { 'Content-Type': 'text/html' } }); });
  await assert.rejects(discoverAudioTracks(url, 'picture', new AbortController().signal), /sign-in expired/);
  assert.equal(requests, 1);
});

test('unsupported metadata degrades to empty adapter options while explicit cancellation propagates', async t => {
  let requests = 0;
  fixture(t, async (_url, init) => {
    if (init?.method === 'DELETE') return Response.json({ ok: true });
    requests++;
    return rangeResponse(init, { data: Buffer.from('This is not a media container.') });
  });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const playback = { type: 'video', url }, item = { id: 'file', type: 'movie', source: 'fixture' };
  const adapter = await createTesPlayAdapter(playback, item, controller.signal);
  assert.deepEqual(adapter.session.tracks, []);
  assert.equal(adapter.session.endpoints[0].representationId, undefined);
  assert.equal(requests, 1);
  const cancelled = new AbortController(), reason = new DOMException('Closed', 'AbortError');
  cancelled.abort(reason);
  await assert.rejects(createTesPlayAdapter(playback, item, cancelled.signal), error => error === reason);
  assert.equal(requests, 1);
});
