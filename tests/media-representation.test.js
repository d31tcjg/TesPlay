import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createMediaService, parseRange } from '../server/media.js';
import { CanvasPlayerEngine } from '../vendor/tesplayer/packages/player/dist/engine.js';

async function fixture(t) {
  let redirects = 0;
  const state = { bytes: Buffer.from('same episode file'), etag: null, modified: null };
  const credentials = [];
  const provider = http.createServer((req, res) => {
    credentials.push({ entry: req.url === '/episode.mp4', authorization: req.headers.authorization });
    if (req.url === '/episode.mp4') {
      res.writeHead(302, { Location: `http://203.0.113.11/temporary/viewer-${++redirects}.mp4` });
      return res.end();
    }
    const range = parseRange(req.headers.range, state.bytes.length);
    assert.ok(range, 'the player must retain its range request through the redirect');
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Length': range.end - range.start + 1,
      'Content-Range': `bytes ${range.start}-${range.end}/${state.bytes.length}`,
      ...(state.etag ? { ETag: state.etag } : {}),
      ...(state.modified ? { 'Last-Modified': state.modified } : {}),
    });
    res.end(state.bytes.subarray(range.start, range.end + 1));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const original = http.request;
  http.request = (url, options, callback) => original(
    new URL(`http://127.0.0.1:${provider.address().port}${url.pathname}`),
    { ...options, agent: false, lookup: undefined }, callback,
  );
  const service = createMediaService({ getProfileId: () => 'profile', getConnection: () => null });
  const app = express();
  app.use((req, _res, next) => { req.user = { id: req.headers['x-viewer'] || 'viewer' }; next(); });
  app.get('/api/media/:token', service.handler);
  app.delete('/api/media/:token', service.releaseHandler);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: 'Media unavailable' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const ticket = () => service.register({ user: { id: 'viewer' } }, null, {
    url: 'http://203.0.113.10/episode.mp4', headers: { Authorization: 'Bearer provider-secret' }, kind: 'video',
  });
  const path = ticket(), url = `http://127.0.0.1:${server.address().port}${path}`;
  const player = new CanvasPlayerEngine({
    canvas: { getContext: () => ({ save() {}, fillRect() {}, restore() {} }) }, capabilities: {},
    services: { now: () => performance.now() }, dependencies: { fetch },
  });
  const probe = async () => {
    const response = await fetch(url, { headers: { Range: 'bytes=0-3' } });
    assert.equal(response.status, 206);
    await response.arrayBuffer();
    const id = response.headers.get('x-csp-representation-id');
    assert.match(id, /^mr1_[A-Za-z0-9_-]{43}$/);
    return { accessUrl: url, route: 'secure-proxy', representationId: id };
  };
  const read = endpoint => player.policyFetch(endpoint, url, { headers: { Range: 'bytes=4-7' } },
    { streamKind: 'direct-file' }, player.operation);
  t.after(async () => {
    await player.destroy();
    await fetch(url, { method: 'DELETE' });
    http.request = original;
    server.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]);
  });
  return { state, credentials, probe, read, url, ticket, base: `http://127.0.0.1:${server.address().port}`,
    redirectCount: () => redirects };
}

test('file playback and seeking survive rotating provider redirects without content validators', async t => {
  const f = await fixture(t), endpoint = await f.probe();
  for (let i = 0; i < 3; i++) {
    const response = await f.read(endpoint);
    assert.equal(response.status, 206);
    assert.equal(await response.text(), ' epi');
  }
  assert.equal(f.redirectCount(), 4, 'every read received a different temporary URL');
  assert.ok(f.credentials.filter(x => x.entry).every(x => x.authorization === 'Bearer provider-secret'));
  assert.ok(f.credentials.filter(x => !x.entry).every(x => x.authorization === undefined),
    'stable file identity must preserve the cross-origin credential boundary');
  assert.equal((await fetch(f.url, { headers: { 'x-viewer': 'another-user' } })).status, 404);
  const separate = await fetch(f.base + f.ticket(), { headers: { Range: 'bytes=0-3' } });
  await separate.arrayBuffer();
  assert.notEqual(separate.headers.get('x-csp-representation-id'), endpoint.representationId,
    'representation IDs must remain bound to their owned media ticket');
});

test('rotating redirects still reject changed file size, ETag and Last-Modified', async t => {
  const f = await fixture(t);
  const original = await f.probe();
  f.state.bytes = Buffer.from('a different longer episode');
  await assert.rejects(f.read(original), { code: 'DEMUX_FAILED' });
  f.state.etag = '"first-version"';
  const tagged = await f.probe();
  f.state.etag = '"second-version"';
  await assert.rejects(f.read(tagged), { code: 'DEMUX_FAILED' });
  f.state.modified = 'Mon, 12 Oct 2026 10:00:00 GMT';
  const dated = await f.probe();
  f.state.modified = 'Mon, 12 Oct 2026 11:00:00 GMT';
  await assert.rejects(f.read(dated), { code: 'DEMUX_FAILED' });
});
