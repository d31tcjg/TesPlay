import test from 'node:test';
import assert from 'node:assert/strict';
import { createYouTubeResolver, normalizeYouTube, validateYouTubeId } from '../server/youtube.js';
const id = 'eRsGyueVLvQ';
const info = () => ({ id, requested_formats: [
  { url: 'https://test.googlevideo.com/video?signed=secret', vcodec: 'avc1', acodec: 'none', http_headers: { 'User-Agent': 'yt-dlp', Cookie: 'do-not-relay' } },
  { url: 'https://test.googlevideo.com/audio', vcodec: 'none', acodec: 'mp4a.40.2' },
] });
const output = (metadata = info()) => JSON.stringify({ info: { ...metadata, requested_formats: undefined }, formats: metadata.requested_formats ?? 'NA' });
test('YouTube resolver is opt-in and rejects invalid IDs before invoking a process', async () => {
  let calls = 0;
  const resolver = createYouTubeResolver({ enabled: false, resolverUrl: '', run: async () => { calls++; } });
  await assert.rejects(resolver(id), { status: 503 });
  await assert.rejects(resolver('--exec evil'), { status: 400 });
  assert.equal(calls, 0);
  assert.throws(() => validateYouTubeId('https://youtube.com/watch?v=' + id), { status: 400 });
});
test('resolved dual streams reject foreign hosts, DRM and mismatched metadata; only media headers survive', () => {
  const resolved = normalizeYouTube(info(), id);
  assert.ok(resolved.video.url.endsWith('signed=secret'));
  assert.ok(resolved.audio.url.endsWith('/audio'));
  assert.deepEqual(resolved.video.headers, { 'User-Agent': 'yt-dlp' });
  for (const url of ['http://test.googlevideo.com/video', 'https://googlevideo.com.evil.example/video', 'https://127.0.0.1/video']) {
    const bad = info(); bad.requested_formats[0].url = url;
    assert.throws(() => normalizeYouTube(bad, id));
  }
  assert.throws(() => normalizeYouTube({ ...info(), id: 'abcdefghijk' }, id), { status: 422 });
  assert.throws(() => normalizeYouTube({ ...info(), has_drm: true }, id), { status: 422 });
});
test('HLS audio streams without a codec label still remain paired with the video', () => {
  const hls = info();
  hls.requested_formats[1].acodec = undefined;
  hls.requested_formats[1].protocol = 'm3u8_native';
  assert.equal(normalizeYouTube(hls, id).audio.hls, true);
});
test('yt-dlp arguments isolate server config, avoid downloads and sanitize extraction errors', async () => {
  const resolver = createYouTubeResolver({ enabled: true, resolverUrl: '', binary: '/test/yt-dlp', run: async (binary, args, options) => {
    assert.equal(binary, '/test/yt-dlp');
    assert.ok(args.includes('--ignore-config'));
    assert.ok(args.includes('--skip-download'));
    assert.ok(args.includes('--js-runtimes'));
    assert.ok(!args.includes('--dump-single-json'));
    const template = args[args.indexOf('--print') + 1];
    assert.ok(template.includes('requested_formats.:.{url,vcodec,acodec,protocol,http_headers,has_drm}'));
    assert.ok(!template.includes('fragments'));
    assert.deepEqual(args.slice(-2), ['--', `https://www.youtube.com/watch?v=${id}`]);
    assert.equal(options.timeout, 90000);
    assert.equal(options.maxBuffer, 8 * 1024 * 1024);
    return { stdout: output() };
  } });
  assert.ok((await resolver(id)).audio);
  const broken = createYouTubeResolver({ enabled: true, resolverUrl: '', run: async () => { throw new Error('upstream signed=secret'); } });
  await assert.rejects(broken(id), error => error.status === 502 && !error.message.includes('secret'));
});
test('compact output supports combined streams, unlabelled HLS audio and preserves validation', async () => {
  const resolve = metadata => createYouTubeResolver({ enabled: true, resolverUrl: '', run: async () => ({ stdout: output(metadata) }) })(id);
  const combined = { id, is_live: true, url: 'https://test.googlevideo.com/combined', vcodec: 'avc1', acodec: 'mp4a', protocol: 'https' };
  const single = await resolve(combined);
  assert.equal(single.audio, null);
  assert.equal(single.isLive, true);
  assert.equal(single.video.url, combined.url);
  const hls = info(); delete hls.requested_formats[1].acodec;
  hls.requested_formats[1].protocol = 'm3u8_native';
  assert.equal((await resolve(hls)).audio.hls, true);
  for (const metadata of [{ ...info(), id: 'abcdefghijk' }, { ...info(), has_drm: true }, { ...info(), live_status: 'is_upcoming' }, { ...combined, url: 'https://evil.example/video' }]) {
    await assert.rejects(resolve(metadata), { status: 422 });
  }
  const drm = info(); drm.requested_formats[0].has_drm = true;
  await assert.rejects(resolve(drm), { status: 422 });
  const broken = createYouTubeResolver({ enabled: true, resolverUrl: '', run: async () => ({ stdout: '<html>secret upstream error</html>' }) });
  await assert.rejects(broken(id), error => error.status === 502 && !error.message.includes('secret'));
});
test('resolver bounds simultaneous jobs and releases slots after completion', async () => {
  const releases = [];
  const resolver = createYouTubeResolver({ enabled: true, resolverUrl: '', run: () => new Promise(resolve => releases.push(() => resolve({ stdout: output() }))) });
  const first = resolver(id), second = resolver(id);
  await assert.rejects(resolver(id), { status: 429 });
  releases.splice(0).forEach(release => release());
  await Promise.all([first, second]);
  const third = resolver(id); releases[0](); await third;
});
