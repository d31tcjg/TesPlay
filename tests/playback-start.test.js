import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasPlayerEngine } from '../vendor/tesplayer/packages/player/dist/engine.js';

function fixture({audio = true, running = false} = {}) {
  let now = 0;
  const context = {
    state: running ? 'running' : 'suspended', currentTime: 0, destination: {},
    async resume() { this.state = 'running'; },
    createGain() { return {connect() {}, disconnect() {}, gain: {setValueAtTime() {}}}; },
  };
  const player = new CanvasPlayerEngine({
    canvas: {width: 1, height: 1, getContext: () => ({save() {}, fillRect() {}, restore() {}})},
    capabilities: {}, services: {now: () => now}, audioContext: context,
  });
  player.session = {isLive: false, route: 'direct', streamKind: 'direct-file'};
  player.request = {autoplay: true};
  player.operation.pipeline = {videoTrack: {}, audioTrack: audio ? {} : null, timelineOrigin: 0};
  Object.assign(player.state, {phase: 'ready', positionSeconds: 12, durationSeconds: 120, seekableStartSeconds: 0, seekableEndSeconds: 120});
  const started = [];
  for (const kind of ['Video', 'Audio']) player[`run${kind}`] = (_track, _origin, _start, operation) => {
    started.push(kind);
    return new Promise(resolve => operation.controller.signal.addEventListener('abort', resolve, {once: true}));
  };
  const events = [];
  player.subscribe(event => events.push(event));
  return {player, context, started, events, advance: ms => {now += ms;}};
}

test('remote autoplay waits for screen audio permission without advancing progress or starting decoders', async () => {
  const f = fixture();
  try {
    await f.player.dispatch({type: 'play'});
    f.advance(15000);
    assert.equal(f.player.getSnapshot().phase, 'ready');
    assert.equal(f.player.getSnapshot().positionSeconds, 12);
    assert.equal(f.player.getSnapshot().audioUnlocked, false);
    assert.deepEqual(f.started, []);
    assert.ok(f.events.some(event => event.type === 'audio-unlock-required'));
    assert.ok(!f.events.some(event => event.type === 'state' && event.snapshot.phase === 'playing'));
    await f.player.unlockAudio();
    await f.player.dispatch({type: 'play'});
    assert.equal(f.player.getSnapshot().phase, 'playing');
    assert.equal(f.player.getSnapshot().positionSeconds, 12);
    assert.deepEqual(f.started, ['Video', 'Audio']);
  } finally {await f.player.destroy();}
});

test('remote autoplay starts immediately when the pairing gesture already enabled screen audio', async () => {
  const f = fixture({running: true});
  try {
    await f.player.dispatch({type: 'play'});
    assert.equal(f.player.getSnapshot().phase, 'playing');
    assert.deepEqual(f.started, ['Video', 'Audio']);
  } finally {await f.player.destroy();}
});

test('silent video uses a moving presentation clock even with a suspended audio context', async () => {
  const f = fixture({audio: false});
  try {
    await f.player.dispatch({type: 'play'});
    f.advance(2000);
    assert.equal(f.player.getSnapshot().positionSeconds, 14);
    assert.equal(f.player.presentationNow(), 2);
    assert.deepEqual(f.started, ['Video']);
  } finally {await f.player.destroy();}
});

test('a shared context enabled after engine creation updates its unlocked state at playback start', async () => {
  const f = fixture();
  try {
    await f.context.resume();
    await f.player.dispatch({type: 'play'});
    assert.equal(f.player.getSnapshot().audioUnlocked, true);
    assert.equal(f.player.getSnapshot().diagnostics.audioContextState, 'running');
  } finally {await f.player.destroy();}
});
