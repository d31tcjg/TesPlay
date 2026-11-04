import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL('../src/Player.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

// Exercise the actual parent component's JSX and callbacks with controlled
// browser effects. TesPlayer reports onError('') when it enters playing.
async function mount() {
  const slots = [], calls = [], events = [];
  let cursor = 0, pending = [];
  function slot(create) { const index = cursor++; return slots[index] ??= create(); }
  const hooks = {
    useState(initial) {
      const current = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }));
      return [current.value, value => { current.value = typeof value === 'function' ? value(current.value) : value; }];
    },
    useRef(initial) { return slot(() => ({ current: initial })); },
    useEffect(effect, dependencies) {
      const current = slot(() => ({}));
      if (!current.dependencies || dependencies?.some((value, i) => !Object.is(value, current.dependencies[i]))) {
        pending.push(() => { current.cleanup?.(); current.cleanup = effect(); });
        current.dependencies = dependencies;
      }
    },
  };
  function TesPlayerStub() {}
  class ApiError extends Error {}
  const modules = {
    react: hooks,
    'react/jsx-runtime': require('react/jsx-runtime'),
    'lucide-react': { X: 'icon', LoaderCircle: 'icon', SkipForward: 'icon', MonitorPlay: 'icon' },
    './playback-audio': { getPlaybackAudio() {} },
    './retain-player-dialog': { retainPlayerDialog: () => () => {} },
    './api': {
      ApiError, errorMessage: error => error.message,
      async api(path, body) { calls.push({ path, body }); return {}; },
    },
    './playback-selection': { async resolvePlayback() { return { url: '/api/media/fixture', type: 'video' }; } },
    './TesPlayer': { default: TesPlayerStub },
    './EpisodeSelector': { default: () => null },
    './remote-state': { idleRemotePlayback: {} },
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports, crypto: webcrypto, AbortController,
    require(name) { if (name.endsWith('.css')) return {}; assert.ok(modules[name], `Unexpected dependency ${name}`); return modules[name]; },
    EventSource: class { constructor(url) { this.url = url; this.closed = false; events.push(this); } close() { this.closed = true; } },
    window: { addEventListener() {}, removeEventListener() {}, setInterval: () => 1, clearInterval() {} },
  });
  const props = { item: { id: 'fixture', type: 'video', title: 'Playback regression', source: 'Local' }, onClose() {} };
  let tree;
  function render() {
    cursor = 0; pending = []; tree = exports.default(props);
    for (const effect of pending) effect();
    return tree;
  }
  function find(value, predicate) {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) { for (const child of value) { const match = find(child, predicate); if (match) return match; } return null; }
    if (predicate(value)) return value;
    return find(value.props?.children, predicate);
  }
  render();
  await new Promise(resolve => setImmediate(resolve));
  render();
  const player = () => find(tree, node => node.type === TesPlayerStub);
  assert.ok(player(), 'Resolved playback mounts TesPlayer');
  return { player, calls, events, render, alert: () => find(tree, node => node.props?.role === 'alert') };
}

test('the playing error-clear callback retains the resolved video', async () => {
  const f = await mount();
  f.player().props.onError('');
  f.render();
  assert.ok(f.player(), 'A successful playing state must not unmount the video');
  assert.equal(f.calls.length, 0, 'Playback does not require billing or stream acquisition');
  assert.equal(f.alert(), null);
});

test('a real player error removes the failed video and displays its message', async () => {
  const f = await mount();
  f.player().props.onError('The decoder could not play this source.');
  f.render();
  assert.equal(f.player(), null);
  assert.ok(f.alert());
});
