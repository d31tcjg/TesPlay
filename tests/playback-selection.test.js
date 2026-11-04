import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function moduleUrl(path,replacements={}){
  let code=ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
  for(const [name,url] of Object.entries(replacements))code=code.replaceAll(`'${name}'`,`'${url}'`).replaceAll(`"${name}"`,`"${url}"`);
  return 'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
}
const apiUrl=moduleUrl('../src/api.ts');
const preferencesUrl=moduleUrl('../src/player-preferences.ts');
const {defaultPlaybackSettings,preferredSubtitleTrack}=await import(preferencesUrl);
const selectionUrl=moduleUrl('../src/playback-selection.ts',{'./api':apiUrl,'./player-preferences':preferencesUrl,mediabunny:import.meta.resolve('mediabunny')});
const {playbackPath,resolvePlayback}=await import(selectionUrl);
const adapterUrl=moduleUrl('../src/tesplayer-adapter.ts',{'./api':apiUrl,'./player-preferences':preferencesUrl,'./playback-selection':selectionUrl,'@canvas-stream-player/contracts':import.meta.resolve('@canvas-stream-player/contracts'),'@canvas-stream-player/player':import.meta.resolve('@canvas-stream-player/player')});
const {createTesPlayAdapter}=await import(adapterUrl);
const typesUrl=moduleUrl('../src/types.ts');
const {mergePlexContinuity}=await import(moduleUrl('../src/plex-continuity.ts',{'./types':typesUrl}));

test('temporary phone media resolves its authenticated descriptor instead of treating JSON as video', async t => {
  const oldFetch=globalThis.fetch,oldLocation=globalThis.location;
  globalThis.location={origin:'https://tesplay.test',href:'https://tesplay.test/'};
  t.after(()=>{globalThis.fetch=oldFetch;if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;});
  const requests=[];
  globalThis.fetch=async input=>{requests.push(String(input));return Response.json({url:'/api/media/temporary-source',type:'hls'});};
  const item={id:'remote-12345678-abcd-1234-1234-123456789abc',source:'Video link',type:'video',playbackUrl:'/api/remote/media/remote-12345678-abcd-1234-1234-123456789abc/playback'};
  const playback=await resolvePlayback(item,{},new AbortController().signal,{audioLanguage:null,subtitleLanguage:null,subtitlesEnabled:false,qualityId:'auto'});
  assert.deepEqual(requests,[item.playbackUrl]);
  assert.equal(playback.url,'/api/media/temporary-source');assert.equal(playback.type,'hls');
});

test('playback settings are encoded independently and direct playback starts with automatic defaults',()=>{
  const item={id:'movie 1',type:'movie',connectionId:'server&1'};
  const selected=new URL(playbackPath(item,{audioTrackId:'plex-audio-62',qualityId:'720p',compatibility:true,subtitleTrackId:'off'}),'https://tesplay.test');
  assert.equal(selected.searchParams.get('connectionId'),'server&1');assert.equal(selected.searchParams.get('audioTrackId'),'plex-audio-62');assert.equal(selected.searchParams.get('qualityId'),'720p');assert.equal(selected.searchParams.get('transcode'),'1');
  assert.equal(new URL(playbackPath(item),'https://tesplay.test').searchParams.has('audioTrackId'),false);
  assert.equal(new URL(playbackPath(item,{audioTrackId:'default'}),'https://tesplay.test').searchParams.has('audioTrackId'),false);
});

test('saved defaults match language aliases and available quality while absent tracks stay automatic or off',()=>{
  const preferences={audioLanguage:'nl-NL',subtitleLanguage:'en',subtitlesEnabled:true,qualityId:'720p'};
  const options={audio:[{id:'en',language:'eng'},{id:'nl',language:'nld'}],subtitles:[{id:'caption',language:'eng'}],qualities:[{id:'auto',label:'Auto'},{id:'high',label:'1080p'},{id:'medium',label:'720p'},{id:'low',label:'480p'}]};
  assert.deepEqual(defaultPlaybackSettings(options,preferences),{audioTrackId:'nl',subtitleTrackId:'caption',qualityId:'medium'});
  assert.equal(defaultPlaybackSettings({...options,qualities:options.qualities.filter(q=>q.id!=='medium')},preferences).qualityId,'low');
  assert.deepEqual(defaultPlaybackSettings({audio:[],subtitles:[],qualities:[]},preferences),{audioTrackId:'default',subtitleTrackId:'off',qualityId:'auto'});
  assert.equal(preferredSubtitleTrack(options.subtitles,{...preferences,subtitleLanguage:null}).id,'caption');
  assert.equal(preferredSubtitleTrack(options.subtitles,{...preferences,subtitlesEnabled:false}),undefined);
});

test('direct Plex playback reads saved defaults and explicit title choices take priority',async t=>{
  const oldFetch=globalThis.fetch,oldLocation=globalThis.location;
  globalThis.location={origin:'https://tesplay.test',href:'https://tesplay.test/'};
  t.after(()=>{globalThis.fetch=oldFetch;if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;});
  const requests=[],preferences={audioLanguage:'nl',subtitleLanguage:'en',subtitlesEnabled:true,qualityId:'720p'};
  globalThis.fetch=async input=>{
    const url=new URL(String(input),'https://tesplay.test');requests.push(url);
    if(url.pathname==='/api/player/preferences')return Response.json(preferences);
    if(url.pathname==='/api/playback/options')return Response.json({audio:[{id:'plex-audio-61',language:'eng'},{id:'plex-audio-62',language:'nld'}],subtitles:[],qualities:[]});
    return Response.json({provider:'plex',type:'hls',url:'/api/media/stream'});
  };
  const item={id:'movie',connectionId:'server',type:'movie',source:'Plex',providerType:'plex'};
  const playback=await resolvePlayback(item,{},new AbortController().signal);
  assert.equal(requests.at(-1).searchParams.get('audioTrackId'),'plex-audio-62');assert.equal(requests.at(-1).searchParams.get('qualityId'),'720p');assert.deepEqual(playback.defaults,preferences);
  await resolvePlayback(item,{audioTrackId:'default',qualityId:'auto',subtitleTrackId:'off'},new AbortController().signal);
  assert.equal(requests.at(-1).searchParams.has('audioTrackId'),false);assert.equal(requests.at(-1).searchParams.get('qualityId'),'auto');
});

test('HLS audio and quality selections preserve each other, subtitles are discovered, and stale requests cannot replace a session',async t=>{
  const oldFetch=globalThis.fetch,oldLocation=globalThis.location;
  globalThis.location={origin:'https://tesplay.test',href:'https://tesplay.test/'};
  t.after(()=>{globalThis.fetch=oldFetch;if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;});
  const root='#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="/api/media/audioEN"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="Dutch",LANGUAGE="nl",URI="/api/media/audioNL"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="captions",NAME="English",LANGUAGE="en",URI="/api/media/captions"\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,AUDIO="sound"\n/api/media/q1080\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720,AUDIO="sound"\n/api/media/q720\n';
  globalThis.fetch=async(input,init)=>init?.method==='DELETE'?Response.json({ok:true}):new Response(new URL(String(input)).pathname==='/api/media/root'?root:'#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/api/media/segment\n#EXT-X-ENDLIST\n');
  const lifetime=new AbortController();t.after(()=>lifetime.abort());
  const adapter=await createTesPlayAdapter({type:'hls',url:'/api/media/root',settings:{audioTrackId:'hls-audio-nl-Dutch',qualityId:'quality-1'}},{id:'film',type:'movie',source:'fixture'},lifetime.signal);
  assert.equal(adapter.session.selectedQualityId,'quality-1');assert.equal(adapter.session.selectedAudioTrackId,'hls-audio-nl-Dutch');assert.match(adapter.session.endpoints[0].accessUrl,/q720$/);assert.match(adapter.session.endpoints[1].accessUrl,/audioNL$/);assert.equal(adapter.session.subtitles[0].deliveryFormat,'hls-webvtt');assert.equal(adapter.session.subtitles[0].url,'/api/v1/media/captions');
  const defaults={audioLanguage:'nl',subtitleLanguage:'en',subtitlesEnabled:true,qualityId:'720p'};
  const fromDefaults=await createTesPlayAdapter({type:'hls',url:'/api/media/root',defaults},{id:'film',type:'movie',source:'fixture'},lifetime.signal);
  assert.equal(fromDefaults.session.selectedQualityId,'quality-1');assert.equal(fromDefaults.session.selectedAudioTrackId,'hls-audio-nl-Dutch');assert.match(fromDefaults.session.endpoints[1].accessUrl,/audioNL$/);
  const explicit=await createTesPlayAdapter({type:'hls',url:'/api/media/root',defaults,settings:{audioTrackId:'hls-audio-en-English',qualityId:'auto'}},{id:'film',type:'movie',source:'fixture'},lifetime.signal);
  assert.equal(explicit.session.selectedQualityId,'auto');assert.equal(explicit.session.selectedAudioTrackId,'hls-audio-en-English');
  const switched=await adapter.services.requestSelection(adapter.session.id,{audioTrackId:'hls-audio-en-English',expectedGenerationId:adapter.session.generationId},lifetime.signal);
  assert.equal(switched.selectedQualityId,'quality-1');assert.match(switched.endpoints[1].accessUrl,/audioEN$/);
  const quality=await adapter.services.requestSelection(switched.id,{qualityId:'quality-0',expectedGenerationId:switched.generationId},lifetime.signal);
  assert.equal(quality.selectedAudioTrackId,'hls-audio-en-English');assert.match(quality.endpoints[0].accessUrl,/q1080$/);
  await assert.rejects(adapter.services.requestSelection(adapter.session.id,{audioTrackId:'hls-audio-nl-Dutch',expectedGenerationId:adapter.session.generationId},lifetime.signal),/out of date/);
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(adapter.services.requestSelection(quality.id,{audioTrackId:'hls-audio-nl-Dutch',expectedGenerationId:quality.generationId},cancelled.signal));
  const stillCurrent=await adapter.services.requestSelection(quality.id,{qualityId:'quality-1',expectedGenerationId:quality.generationId},lifetime.signal);assert.equal(stillCurrent.selectedAudioTrackId,'hls-audio-en-English');
});

test('Plex continuity merges newer server watch time, preserves unsynced local checkpoints and deduplicates watchlist',()=>{
  const item={id:'1',connectionId:'plex',source:'Plex',type:'movie',title:'Movie'},other={...item,id:'2'};
  const local={favorites:[],progress:[{item,seconds:60,duration:120,updatedAt:'2026-10-01T00:00:00Z'},{item:other,seconds:75,duration:120,updatedAt:'2026-10-09T00:00:00Z'}]};
  const server={progress:[{item,seconds:90,duration:120,updatedAt:'2026-10-08T00:00:00Z'},{item:other,seconds:20,duration:120,updatedAt:'2026-10-01T00:00:00Z'}],watchlist:[item,item]};
  const result=mergePlexContinuity(local,[server]);assert.equal(result.progress.find(p=>p.item.id==='1').seconds,90);assert.equal(result.progress.find(p=>p.item.id==='2').seconds,75);assert.equal(result.plexWatchlist.length,1);
});

test('direct files discover actual audio tracks with valid pinned selectors and can switch the second track',async t=>{
  const bytes=readFileSync(new URL('./fixtures/two-audio.m4a',import.meta.url)),oldFetch=globalThis.fetch,oldLocation=globalThis.location;
  globalThis.location={origin:'https://tesplay.test',href:'https://tesplay.test/'};
  t.after(()=>{globalThis.fetch=oldFetch;if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;});
  globalThis.fetch=async(_input,init)=>{
    if(init?.method==='DELETE')return Response.json({ok:true});
    init?.signal?.throwIfAborted();
    const range=/bytes=(\d+)-(\d*)/.exec(new Headers(init?.headers).get('range')||'');
    const start=range?Number(range[1]):0,end=range?.[2]?Math.min(bytes.length-1,Number(range[2])):bytes.length-1;
    return new Response(bytes.subarray(start,end+1),{status:range?206:200,headers:{'Content-Type':'audio/mp4','X-Csp-Representation-Id':'mr1_'+ 'a'.repeat(43),'Content-Length':String(end-start+1),...(range?{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}:{})}});
  };
  const lifetime=new AbortController();t.after(()=>lifetime.abort());
  const adapter=await createTesPlayAdapter({type:'audio',url:'/api/media/file',defaults:{audioLanguage:'nl',subtitleLanguage:null,subtitlesEnabled:false,qualityId:'720p'}},{id:'file',type:'audio',source:'fixture'},lifetime.signal);
  assert.equal(adapter.session.tracks.length,2);assert.deepEqual(adapter.session.tracks.map(t=>t.language),['eng','nld']);
  assert.equal(adapter.session.selectedAudioTrackId,adapter.session.tracks[1].id);assert.equal(adapter.session.selectedQualityId,null);
  const endpoint=adapter.session.endpoints[0];assert.match(endpoint.representationId,/^mr1_[A-Za-z0-9_-]{43}$/);assert.equal(endpoint.representation,'mediabunny-track-number-per-type-v1');
  for(const track of adapter.session.tracks){assert.equal(track.selector.representationId,endpoint.representationId);assert.equal(track.selector.resourceId,endpoint.resourceId);assert.equal(track.selector.kind,'file-track');}
  const switched=await adapter.services.requestSelection(adapter.session.id,{audioTrackId:adapter.session.tracks[1].id,expectedGenerationId:adapter.session.generationId},lifetime.signal);
  assert.equal(switched.selectedAudioTrackId,adapter.session.tracks[1].id);assert.equal(switched.endpoints[0].representationId,endpoint.representationId);
});
