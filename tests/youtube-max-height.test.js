import test from 'node:test';
import assert from 'node:assert/strict';
import { createYouTubeResolver } from '../server/youtube.js';
import { readFileSync } from 'node:fs';

const originalFormat = 'bv[protocol^=m3u8][height<=1080][vcodec^=avc1]+ba[protocol^=m3u8]/bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=1080][ext=mp4]';
const id = 'eRsGyueVLvQ';
function captureResolver(options = {}) {
  const formats = [];
  const resolve = createYouTubeResolver({
    enabled: true, resolverUrl: '', ...options,
    run: async (_binary, args) => {
      formats.push(args[args.indexOf('-f') + 1]);
      return { stdout: JSON.stringify({ info: { id, url: 'https://test.googlevideo.com/video', vcodec: 'avc1', acodec: 'mp4a' } }) };
    },
  });
  return { resolve, formats };
}

for (const value of [undefined, '360', '480', '720', '1080', '', 'garbage', '721', '0', '720p', '720.0', ' 720', '720][ext=webm']) {
  test(`YOUTUBE_MAX_HEIGHT=${JSON.stringify(value)} selects an allowed cap or warns once and falls back`, async (t) => {
    const previous = process.env.YOUTUBE_MAX_HEIGHT;
    t.after(() => {
      if (previous === undefined) delete process.env.YOUTUBE_MAX_HEIGHT;
      else process.env.YOUTUBE_MAX_HEIGHT = previous;
    });
    if (value === undefined) delete process.env.YOUTUBE_MAX_HEIGHT;
    else process.env.YOUTUBE_MAX_HEIGHT = value;
    const warning = t.mock.method(console, 'warn', () => {});
    const valid = ['360', '480', '720', '1080'].includes(value);
    const { resolve, formats } = captureResolver();
    await resolve(id);
    await resolve(id);
    const expected = originalFormat.replaceAll('height<=1080', `height<=${valid ? value : 1080}`);
    assert.deepEqual(formats, [expected, expected]);
    assert.equal(warning.mock.callCount(), value !== undefined && !valid ? 1 : 0);
    if (value !== undefined && !valid) assert.match(warning.mock.calls[0].arguments[0], /YOUTUBE_MAX_HEIGHT.*1080/);
  });
}

test('injected maxHeight overrides the environment and rejects unsupported options', async (t) => {
  const previous = process.env.YOUTUBE_MAX_HEIGHT;
  t.after(() => {
    if (previous === undefined) delete process.env.YOUTUBE_MAX_HEIGHT;
    else process.env.YOUTUBE_MAX_HEIGHT = previous;
  });
  process.env.YOUTUBE_MAX_HEIGHT = '480';
  const warning = t.mock.method(console, 'warn', () => {});
  for (const maxHeight of [720, '360', 721, null, false]) {
    const valid = [720, '360'].includes(maxHeight);
    const { resolve, formats } = captureResolver({ maxHeight });
    await resolve(id);
    assert.deepEqual(formats, [originalFormat.replaceAll('height<=1080', `height<=${valid ? maxHeight : 1080}`)]);
  }
  assert.equal(warning.mock.callCount(), 3);
});

test('homelab overlay sets only the youtube cap and preserves the original app block', () => {
  const overlay = readFileSync(new URL('../deploy/homelab/compose.homelab.yaml', import.meta.url), 'utf8');
  assert.match(overlay, /^  youtube:\n    environment:\n      YOUTUBE_MAX_HEIGHT: \$\{YOUTUBE_MAX_HEIGHT:-720\}$/m);
  const originalApp = '  app:\n    ports: !reset []\n    networks:\n      macvlan_lan:\n        ipv4_address: 10.42.90.44\n        gw_priority: 100\n      default: {}\n';
  assert.equal(overlay.match(/^  app:\n[\s\S]*?(?=\n  \w|\nnetworks:)/m)?.[0], originalApp);
});

for (const maxHeight of [360, 480, 720, 1080]) {
  test(`injected YouTube maxHeight ${maxHeight} changes only all three height caps`, async () => {
    const { resolve, formats } = captureResolver({ maxHeight });
    await resolve(id);
    assert.deepEqual(formats, [originalFormat.replaceAll('height<=1080', `height<=${maxHeight}`)]);
  });
}
