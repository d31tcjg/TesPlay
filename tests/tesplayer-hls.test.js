import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CanvasPlayerEngine } from '../vendor/tesplayer/packages/player/dist/engine.js';
import {Input,Logging} from 'mediabunny';
const testCanvas=()=>({width:1,height:1,getContext:()=>({save(){},fillRect(){},restore(){}})});
const playlist = (count, prefix, live = false) => '#EXTM3U\n#EXT-X-TARGETDURATION:2\n' + Array.from({ length: count }, (_, i) => `#EXTINF:2,\n${prefix}-${i}.ts\n`).join('') + (live ? '' : '#EXT-X-ENDLIST\n');
function fixture(live = false) {
  const player = new CanvasPlayerEngine({ canvas: { getContext: () => ({}) }, capabilities: {}, services: { now: () => performance.now() }, dependencies: { fetch: async () => new Response('segment') } });
  player.session = { isLive: live };
  return player;
}

test('opaque HLS playlists are complete bounded documents, with fresh live reads and no file-range warning',async()=>{
  const requests=[],warnings=[];let source;
  const remove=Logging.on('warn',args=>warnings.push(args));
  const player=new CanvasPlayerEngine({canvas:testCanvas(),capabilities:{},services:{now:()=>performance.now()},dependencies:{
    fetch:async(url,init)=>{requests.push({url,range:new Headers(init.headers).get('range')});return new Response(playlist(2,'segment',true));},
    createInput:options=>{source=options.source;return new Input(options);},
  }});
  const root='https://tesplay.test/api/media/opaque',session={streamKind:'hls-live-ts',isLive:true,route:'secure-proxy',endpoints:[{role:'manifest',accessUrl:root,route:'secure-proxy'}]};
  player.session=session;
  player.chooseVideoTrack=async(input)=>{assert.equal(await input.canRead(),true);return {track:null,id:null};};
  player.chooseAudioTrack=async()=>({track:null,id:null});player.startupDuration=async()=>null;
  try{
    await player.openPipeline(session,player.operation);
    assert.equal(requests.length,1);assert.equal(requests[0].range,null);
    await source.requestHandler({path:root,isRoot:false});assert.equal(requests.length,2,'live refresh must fetch a fresh playlist');
    assert.equal(warnings.length,0,'playlist format probing must not declare the whole video non-seekable');
    await assert.rejects(source.requestHandler({path:'https://foreign.test/unclassified.ts',isRoot:false}),{code:'HLS_MANIFEST_INVALID'});assert.equal(requests.length,2);
    player.dependencies.fetch=async()=>new Response('#EXTM3U\n#'+ 'x'.repeat(2*1024*1024));
    await assert.rejects(source.requestHandler({path:root,isRoot:false}),{code:'HLS_MANIFEST_INVALID'});
  }finally{remove();await player.destroy();}
});

test('temporary HTTP and transport failures retry within a bound while denied and cancelled requests stop',async()=>{
  let attempts=0;const player=new CanvasPlayerEngine({canvas:testCanvas(),capabilities:{},services:{now:()=>performance.now()},policy:{segmentRetryBaseMs:50,segmentAttempts:3},dependencies:{fetch:async(_url,init)=>{
    assert.equal(new Headers(init.headers).get('range'),'bytes=100-199');attempts++;
    return attempts===1?new Response('Temporary failure',{status:502}):new Response('selected bytes',{status:206,headers:{'Content-Range':'bytes 100-199/1000'}});
  }}});
  const endpoint={route:'secure-proxy'},url='https://tesplay.test/api/media/opaque',session={streamKind:'direct-file'},init={headers:{Range:'bytes=100-199'}};
  try {
    const resumed=await player.policyFetch(endpoint,url,init,session,player.operation);assert.equal(resumed.status,206);assert.equal(attempts,2);assert.equal(await resumed.text(),'selected bytes');
    attempts=0;player.dependencies.fetch=async()=>{attempts++;return new Response('Still unavailable',{status:502});};
    assert.equal((await player.policyFetch(endpoint,url,{},session,player.operation)).status,502);assert.equal(attempts,3);
    attempts=0;player.dependencies.fetch=async()=>{attempts++;return new Response('Sign in',{status:401});};
    assert.equal((await player.policyFetch(endpoint,url,{},session,player.operation)).status,401);assert.equal(attempts,1);
    attempts=0;player.dependencies.fetch=async()=>{attempts++;if(attempts===1)throw new TypeError('Network connection lost');return new Response('reconnected');};
    assert.equal(await (await player.policyFetch(endpoint,url,{},session,player.operation)).text(),'reconnected');assert.equal(attempts,2);
    const worker=new AbortController();attempts=0;player.dependencies.fetch=async()=>{attempts++;worker.abort();return new Response('Temporary failure',{status:503});};
    await assert.rejects(player.policyFetch(endpoint,url,{signal:worker.signal},session,player.operation),{name:'AbortError'});assert.equal(attempts,1);
  }finally{await player.destroy();}
});
test('long VOD keeps its first segment available across probing and seeking with separate audio', async () => {
  const player = fixture(), operation = player.operation;
  const base = 'https://tesplay.example/video.m3u8';
  for (let pass = 0; pass < 2; pass++) for (const prefix of ['video', 'audio']) {
    await operation.hls.validateResponse(new Response(playlist(6788, prefix)), base, { kind: 'playlist', depth: 0 });
  }
  for (const role of ['video', 'audio']) for (const index of [0, 1000, 6787]) {
    const response = await player.policyFetch({ route: 'secure-proxy' }, `https://tesplay.example/${role}-${index}.ts`, {}, { streamKind: 'hls-vod-ts' }, operation);
    assert.equal(await response.text(), 'segment');
  }
  assert.equal(operation.hls.mediaOrder.length, 13576);
});
test('rolling live resource ownership stays bounded and does not authorize an unknown segment', async () => {
  const player = fixture(true), operation = player.operation;
  await operation.hls.validateResponse(new Response(playlist(700, 'live', true)), 'https://tesplay.example/live.m3u8', { kind: 'playlist', depth: 0 });
  assert.equal(operation.hls.mediaOrder.length, 500);
  assert.ok(operation.hls.getResource('https://tesplay.example/live-699.ts'));
  await assert.rejects(player.policyFetch({ route: 'secure-proxy' }, 'https://tesplay.example/foreign.ts', {}, { streamKind: 'hls-live-ts' }, operation), { code: 'HLS_MANIFEST_INVALID' });
});

test('a provider can prepare a segment beyond the direct probe deadline', async () => {
  const player = new CanvasPlayerEngine({ canvas: { getContext: () => ({}) }, capabilities: {}, services: { now: () => performance.now() },
    policy: { directProbeTimeoutMs: 250, startupTimeoutMs: { provider: 1000 } },
    dependencies: { fetch: (_url, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response('media')), 400);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }) },
  });
  const session = { streamKind: 'direct-file' };
  const provider = await player.policyFetch({ route: 'secure-proxy' }, 'https://tesplay.example/segment.ts', {}, session, player.operation);
  assert.equal(await provider.text(), 'media');
  await assert.rejects(player.policyFetch({ route: 'direct' }, 'https://media.example/segment.ts', {}, session, player.operation), { code: 'NETWORK_TIMEOUT' });
});

test('cancelling range workers after headers releases their HTTP streams, including operation cleanup', async () => {
  let active = 0;
  const closed = [];
  const server = http.createServer((_request, response) => {
    active++;
    let resolveClose;
    closed.push(new Promise(resolve => { resolveClose = resolve; }));
    response.on('close', () => { active--; resolveClose(); });
    response.writeHead(206, { 'Content-Type': 'video/x-matroska', 'Content-Range': 'bytes 0-999999/1000000' });
    response.write('media'); // An open-ended range stream: headers arrive before the body finishes.
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const player = new CanvasPlayerEngine({ canvas: { getContext: () => ({}) }, capabilities: {}, services: { now: () => performance.now() }, dependencies: { fetch } });
  try {
    for (let i = 0; i < 8; i++) {
      const worker = new AbortController();
      const response = await player.fetchWithTimeout(`http://127.0.0.1:${server.address().port}/media`, { signal: worker.signal }, player.operation, 1000);
      const reader = response.body.getReader();
      assert.equal(new TextDecoder().decode((await reader.read()).value), 'media');
      const reason = new DOMException('Range worker finished', 'AbortError');
      if (i === 7) player.operation.controller.abort(reason);
      else worker.abort(reason);
      let timer;
      try {
        await Promise.race([
          Promise.all([assert.rejects(reader.read(), { name: 'AbortError' }), closed.at(-1)]),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cancelled media stream kept its connection open')), 1500); }),
        ]);
      } finally { clearTimeout(timer); reader.releaseLock(); }
      assert.equal(active, 0, 'old range streams must not accumulate during continuous playback');
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('startup uses metadata for long films without fetching the tail, but falls back for files without duration metadata',async()=>{
 const player=fixture();let scans=0;
 const input={getDurationFromMetadata:async()=>7200,computeDuration:async()=>{scans++;return 7201;}};
 assert.equal(await player.startupDuration(input,[],{isLive:false}),7200);assert.equal(scans,0);
 input.getDurationFromMetadata=async()=>null;
 assert.equal(await player.startupDuration(input,[],{isLive:false}),7201);assert.equal(scans,1);
 assert.equal(await player.startupDuration(input,[],{isLive:true}),null);assert.equal(scans,1);
});

test('watchdog recovery has a deadline after replacing the operation and publishes a terminal error',async()=>{
 const player=new CanvasPlayerEngine({canvas:{getContext:()=>({})},capabilities:{},services:{now:()=>performance.now(),reportDiagnostic:async()=>{}},policy:{startupTimeoutMs:{provider:35}}});
 player.session={route:'secure-proxy',isLive:false};player.state.phase='playing';player.state.positionSeconds=288;
 const events=[];player.subscribe(e=>{if(e.type==='error')events.push(e.error.code);});
 player.seek=async(_position,_resume,invocation)=>{player.replaceOperation(undefined,invocation);return new Promise(()=>{});};
 await assert.rejects(player.recover(false,'test stalled pipeline',player.operation),{code:'NETWORK_TIMEOUT'});
 assert.equal(player.getSnapshot().phase,'error');assert.deepEqual(events,['NETWORK_TIMEOUT']);assert.equal(player.operation.invocations.size,0);
});

test('a direct Plex file with an unsupported browser codec requests full compatibility at the saved position',async()=>{
 const player=fixture();player.state.positionSeconds=288;const selected=[];
 player.requestCompatibility=async(mode,reason,seek)=>{selected.push({mode,seek});};
 const videoTrack={getDecoderConfig:async()=>null,getCodecParameterString:async()=>'av01',getCodedWidth:async()=>1280,getCodedHeight:async()=>720};
 const operation=player.operation,invocation=player.createInvocation(operation);
 const metadata=await player.inspectTracks({videoTrack,audioTrack:null,duration:1470,seekableStart:0,seekableEnd:1470},operation,invocation);
 assert.equal(metadata,null);assert.deepEqual(selected,[{mode:'full',seek:288}]);player.releaseInvocation(invocation);
});
