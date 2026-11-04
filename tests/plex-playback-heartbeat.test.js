import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {createMediaService} from '../server/media.js';

const code = ts.transpileModule(readFileSync(new URL('../src/plex-playback-heartbeat.ts', import.meta.url), 'utf8'), {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;

test('Plex playback pings while paused for a minute, serializes requests and stops on teardown or completion', async () => {
  const callbacks = new Map(), calls = [];
  let serial = 0, pending, active = true;
  const exports = {};
  vm.runInNewContext(code, {exports, require: () => ({tesPlayFetch: async (url, options) => {
    calls.push({url, options});
    if (pending) await pending;
    return {ok: true};
  }}), window: {setInterval(callback, ms) {assert.equal(ms, 15000); callbacks.set(++serial, callback); return serial;}, clearInterval(id) {callbacks.delete(id);}}});
  const playback = {provider: 'plex', type: 'hls', url: '/api/media/m_fixture'};
  const controller = new AbortController();
  exports.startPlexPlaybackHeartbeat(playback, controller.signal, () => active);
  await new Promise(resolve => setImmediate(resolve));
  for (let elapsed = 15; elapsed <= 60; elapsed += 15) {
    callbacks.get(1)();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(calls.length, 5, 'paused playback keeps the same Plex session warm');
  assert.ok(calls.every(call => call.url === '/api/media/m_fixture/heartbeat' && call.options.method === 'POST'));
  let release; pending = new Promise(resolve => {release = resolve;});
  callbacks.get(1)(); callbacks.get(1)();
  assert.equal(calls.length, 6, 'slow pings must not overlap');
  release(); await new Promise(resolve => setImmediate(resolve));
  active = false; callbacks.get(1)(); assert.equal(calls.length, 6);
  controller.abort(); assert.equal(callbacks.size, 0); assert.equal(calls.at(-1).options.signal.aborted, true);
  for (const other of [{...playback, type: 'video'}, {...playback, provider: 'xtream'}, {...playback, url: 'https://other.test/api/media/m_fixture'}])
    exports.startPlexPlaybackHeartbeat(other, new AbortController().signal, () => true);
  assert.equal(callbacks.size, 0);
});

test('Plex keepalive uses the registered transcode session and enforces media authorization before contacting Plex', async () => {
  const received = [];
  const provider = http.createServer((req, res) => {received.push({url: req.url, token: req.headers['x-plex-token']}); res.writeHead(200); res.end();});
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const original = http.request;
  http.request = (url, options, callback) => original(new URL(url.pathname + url.search, `http://127.0.0.1:${provider.address().port}`), {...options, lookup: undefined, agent: false}, callback);
  const connection = {id: 'plex', type: 'plex', config: {url: 'http://203.0.113.10:32400', token: 'private-fixture-token'}};
  let denied = false;
  const service = createMediaService({
    getProfileId: req => req.headers?.['x-profile'] || 'profile', getConnection: () => connection,
    assertAccess() {if (denied) throw Object.assign(new Error('Denied'), {status: 403});},
  });
  const app = express();
  app.use((req, _res, next) => {req.user = {id: req.headers['x-viewer'] || 'viewer'}; req.session = {id: req.headers['x-session'] || 'screen', scope: req.headers['x-scope']}; next();});
  app.post('/api/media/:token/heartbeat', service.heartbeatHandler);
  app.delete('/api/media/:token', service.releaseHandler);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({error: error.message}));
  const viewer = app.listen(0, '127.0.0.1'); await new Promise(resolve => viewer.once('listening', resolve));
  const request = {user: {id: 'viewer'}};
  const resource = {url: 'http://203.0.113.10:32400/video/:/transcode/universal/start.m3u8', kind: 'hls', plexSessionId: 'a'.repeat(24), headers: {'X-Plex-Token': 'private-fixture-token'}, access: {sectionId: '1'}};
  const ticket = service.register(request, connection, resource), base = `http://127.0.0.1:${viewer.address().port}`;
  const ping = headers => fetch(base + ticket + '/heartbeat', {method: 'POST', headers});
  try {
    for (const headers of [{'x-viewer': 'other'}, {'x-profile': 'other'}, {'x-scope': 'remote'}]) assert.ok((await ping(headers)).status >= 400);
    denied = true; assert.equal((await ping()).status, 403); denied = false;
    connection.config.token = 'changed'; assert.equal((await ping()).status, 404); connection.config.token = 'private-fixture-token';
    assert.equal(received.length, 0, 'denied pings must never contact the upstream');
    const response = await ping(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), {ok: true});
    assert.deepEqual(received, [{url: '/video/:/transcode/universal/ping?session=' + 'a'.repeat(24), token: 'private-fixture-token'}]);
    const direct = service.register(request, connection, {...resource, kind: 'video', plexSessionId: undefined});
    assert.equal((await fetch(base + direct + '/heartbeat', {method: 'POST'})).status, 400);
    await fetch(base + ticket, {method: 'DELETE'}); assert.equal((await ping()).status, 404);
    assert.equal(received.length, 1);
  } finally {
    http.request = original; provider.closeAllConnections(); viewer.closeAllConnections();
    await Promise.all([new Promise(resolve => provider.close(resolve)), new Promise(resolve => viewer.close(resolve))]);
  }
});
