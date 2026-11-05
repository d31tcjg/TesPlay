import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { validateConnection } from '../server/connection-routes.js';

// Render the real editor and its dependencies without starting a server or
// running browser effects. No provider requests or saved connections are used.
const bundle = await build({
  entryPoints: [new URL('../src/ConnectionEditor.tsx', import.meta.url).pathname],
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
});
const module = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, require: createRequire(import.meta.url),
  location: { search: '' }, URLSearchParams, AbortController,
});
const ConnectionEditor = module.exports.default;
function render(overrides = {}) {
  return renderToStaticMarkup(React.createElement(ConnectionEditor, {
    adding: 'channels', editing: null, editConfig: {}, configuredFields: [],
    preview: false, busy: false, error: '', notice: '',
    publicUrl: 'https://tesplay.example', plexPin: null,
    onClose() {}, onSignIn() {}, onPhoneSetup() {}, onTypeChange() {},
    async onSubmit() {}, async startPlex() {}, async checkPlex() {},
    ...overrides,
  }));
}

test('Channels quality select defaults to original, restores saved values, and is Channels-only', () => {
  const html = render();
  assert.match(html, /Max streaming quality/);
  assert.match(html, /<select name="maxQuality" aria-describedby="channels-quality-help">/);
  assert.match(html, /<option value="original" selected="">Original<\/option>/);
  for (const [value,label] of [['8000-1080','8 Mbps · 1080p'],['4000-720','4 Mbps · 720p'],['2000-720','2 Mbps · 720p'],['1000-576','1 Mbps · 576p']]) {
    assert.ok(html.includes(`<option value="${value}">${label}</option>`));
    assert.ok(render({editing:{id:'dvr',type:'channels',name:'DVR'},editConfig:{maxQuality:value},configuredFields:['url','maxQuality']}).includes(`<option value="${value}" selected="">`));
  }
  assert.match(html, /Lower quality uses less data\. Applies to TesPlay only; your other Channels apps are unaffected\./);
  for (const adding of ['plex','m3u','xtream','drive','youtube','local']) {
    assert.doesNotMatch(render({adding,editing:{id:'other',type:adding,name:'Other'}}), /name="maxQuality"|channels-quality-help/);
  }
});

test('Channels creation explains DVR API access before save with one associated URL hint', () => {
  const html = render();
  assert.match(html, /<input(?=[^>]*name="url")(?=[^>]*aria-describedby="channels-url-help")[^>]*>/);
  assert.equal((html.match(/id="channels-url-help"/g) || []).length, 1);
  assert.match(html, /reachable from the TesPlay server/);
  assert.match(html, /public or reverse-proxy URL can still reject DVR API access \(403\)/);
  assert.match(html, /local network address/);
  assert.match(html, /Test the connection after saving/);
  assert.doesNotMatch(html, /role="alert"/);
});

// Do not infer public/private routing from a hostname or HTTPS scheme. These
// are configuration values only; validation and rendering never contact them.
for (const url of [
  'http://10.42.94.3:8089', 'http://172.16.0.20:8089', 'http://192.168.1.20:8089',
  'http://[fd12::20]:8089', 'http://channels:8089', 'http://dvr.local:8089',
  'https://dvr.home.arpa', 'https://dvr.example.test', 'https://tv.cypherit.dev',
]) {
  test(`Channels URL guidance is advisory and preserves ${url}`, () => {
    const validated = validateConnection({ type: 'channels', name: 'Synthetic DVR', config: { url } });
    assert.equal(validated.config.url, url);
    const html = render({ editConfig: { url } });
    assert.ok(html.includes(`value="${url}"`));
    const input = html.match(/<input(?=[^>]*name="url")[^>]*>/)?.[0];
    assert.ok(input);
    assert.doesNotMatch(input, /disabled|pattern=|aria-invalid/);
    assert.match(html, /<button type="submit" class="button primary full">/);
    assert.equal((html.match(/id="channels-url-help"/g) || []).length, 1);
    assert.doesNotMatch(html, /role="alert"/);
  });
}

test('Channels editing retains one hint and one existing runtime error', () => {
  const error = "Channels DVR refused this address. Use the server's local network address, for example http://192.168.1.20:8089.";
  const html = render({ editing: { id: 'fixture', type: 'channels', name: 'Synthetic DVR' }, error });
  assert.equal((html.match(/id="channels-url-help"/g) || []).length, 1);
  assert.equal((html.match(/role="alert"/g) || []).length, 1);
  assert.equal((html.match(/Channels DVR refused this address/g) || []).length, 1);
});

test('Channels hint is absent from other providers and signed-out preview', () => {
  for (const props of [{ adding: 'xtream' }, { adding: 'm3u' }, { adding: 'plex', editing: { id: 'p', name: 'Plex' } }, { preview: true }]) {
    assert.doesNotMatch(render(props), /channels-url-help|reject DVR API access/);
  }
});
