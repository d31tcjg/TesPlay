import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import {registerProviderRoutes} from '../server/providers.js';
import {registerConnectionRoutes, validateConnection} from '../server/connection-routes.js';
import {allows, assertAllowed, validateGrants} from '../server/access.js';
import {createMediaService, remoteData as upstreamData} from '../server/media.js';
import {registerLibraryRoutes} from '../server/library-routes.js';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

async function listen(t, app) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, {data = {}, access, remoteData, media: useMedia = false} = {}) {
  const calls = [], saved = [];
  const c = {id:'c1', name:'Synthetic DVR', type:'channels', config:{url:'http://192.0.2.10:8089'}, access};
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    if (req.headers.authorization !== 'fixture') return res.status(401).json({error:'Sign in'});
    req.user = {id:req.headers['x-viewer'] || 'owner'};
    req.profile = req.headers['x-profile'] || 'p1';
    req.session = {id:'session', scope:req.headers['x-scope']}; next();
  });
  const ctx = {
    getProfileId:req=>req.profile || 'p1',
    getConnection:(_req,id)=>{if(id !== c.id) throw Object.assign(new Error('Missing'),{status:404}); return c;},
    canAccess:(_req,conn,item)=>allows(conn.access,item),
    assertAccess:(req,conn,item)=>{assertAllowed(conn.access,item); req.mediaAccess = item;},
    saveConnection:(_req,value)=>{Object.assign(c,validateConnection(value));return {id:c.id,type:c.type,name:c.name};},
    getManagedConnection:()=>c,
  };
  if (useMedia) ctx.media = createMediaService(ctx);
  registerConnectionRoutes(app,{store:{visibleConnections:()=>[]},ctx,requireOwner:(_req,_res,next)=>next()});
  registerProviderRoutes(app,ctx,{remoteData:async(input,options={})=>{
    const u = new URL(input); calls.push({path:u.pathname, method:options.method || 'GET', options});
    assert.equal(u.origin, c.config.url);
    assert.deepEqual(options.allowedPrivateHosts,['192.0.2.10']);
    if(remoteData) return remoteData(u,options);
    if(!(u.pathname in data)) throw new Error(`Unexpected synthetic request ${u.pathname}`);
    return structuredClone(data[u.pathname]);
  }});
  if (useMedia) {
    app.get('/api/media/:token',ctx.media.handler);
    app.post('/api/media/:token/heartbeat',ctx.media.heartbeatHandler);
    app.delete('/api/media/:token',ctx.media.releaseHandler);
  }
  registerLibraryRoutes(app,{ctx,store:{saveProgress:(_profile,item,seconds,duration)=>saved.push({item,seconds,duration})},getProfileId:ctx.getProfileId,ownedItem:req=>req.body.item,visibleLibrary:()=>({})});
  app.use((err,_req,res,_next)=>res.status(err.status || 500).json({error:err.message}));
  const base = await listen(t,app);
  const request = (url,options={}) => fetch(base+url,{...options,headers:{authorization:'fixture',...options.headers}});
  return {c,ctx,calls,saved,base,request,
    get:async(path,params={})=>{const r=await request(`/api/${path}?${new URLSearchParams({connectionId:c.id,...params})}`);assert.equal(r.status,200,await r.clone().text());return r.json();},
    post:(path,body)=>request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})};
}

test('Channels connection picker registry and URL form expose a native DVR connection',()=>{
  const load = name => {
    const exports = {};
    const code = ts.transpileModule(readFileSync(new URL(`../src/${name}.ts`,import.meta.url),'utf8'),{
      compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
    }).outputText;
    vm.runInNewContext(code,{exports});return exports;
  };
  const fields=load('connection-fields').connectionFields('channels','apiKey');
  assert.equal(fields.length,1);assert.equal(fields[0].key,'url');assert.equal(fields[0].label,'Channels DVR server URL');
  assert.equal(load('catalog').services.find(s=>s.id==='channels')?.name,'Channels DVR');
});

test('Channels connection can be created and tests its JSON status',async t=>{
  const f=await fixture(t,{data:{'/status':{features:{dvr:true}}}});
  const created=await f.post('/api/connections',{type:'channels',name:'Synthetic DVR',config:{url:f.c.config.url}});
  assert.equal(created.status,201);
  assert.equal((await f.post('/api/connections/c1/test',{})).status,200);
  assert.equal(f.calls[0].path,'/status');
  assert.deepEqual(validateGrants([{connectionId:'c1',kinds:['live','series','movie']}],[f.c])[0].kinds,['live','series','movie']);
});

test('Channels status failures are clean for non-JSON and HTTP errors',async t=>{
  for(const result of [null,[]]) {
    const f=await fixture(t,{data:{'/status':result}});
    const r=await f.post('/api/connections/c1/test',{});
    assert.equal(r.status,502); assert.match((await r.json()).error,/Channels DVR/);
  }
  { // v2: an HTML page means the address is not the DVR API (see tests/channels-guide.test.js).
    const f=await fixture(t,{data:{'/status':'<html>invalid</html>'}});
    const r=await f.post('/api/connections/c1/test',{});
    assert.equal(r.status,400); assert.match((await r.json()).error,/Channels DVR refused this address/);
  }
  const f=await fixture(t,{remoteData:async()=>{throw Object.assign(new Error('Provider returned HTTP 500.'),{status:502});}});
  const r=await f.post('/api/connections/c1/test',{});
  assert.equal(r.status,502); assert.match((await r.json()).error,/Channels DVR/);
});

test('Channels root folders respect household kind grants',async t=>{
  const f=await fixture(t);
  const root=await f.get('catalog');
  assert.deepEqual(root.items.map(x=>[x.id,x.title,x.contentKind]),[
    ['channels:live','Live TV','live'],['channels:shows','TV Shows','series'],['channels:movies','Movies','movie']]);
  assert.ok(root.items.every(x=>x.type==='folder'));
  f.c.access={kinds:['series']};
  assert.deepEqual((await f.get('catalog')).items.map(x=>x.id),['channels:shows']);
  assert.equal((await f.request('/api/catalog?connectionId=c1&parentId=channels:live')).status,403);
});

test('Channels live catalog joins proxied logos, hides hidden channels and sorts numerically before pagination',async t=>{
  const f=await fixture(t,{data:{'/api/v1/channels':[
    {number:'215',name:'Synthetic Cable',source_name:'Cable'},
    {number:'36.1',name:'Synthetic News',source_name:'Antenna'},
    {number:'9.1',name:'Synthetic Local',hd:true,source_name:'Antenna'},
    {number:'101.11',name:'Synthetic Extra'},
    {number:'2',name:'Hidden',hidden:true},
    {number:'../../x',name:'Invalid'}],
    '/devices/ANY/channels':[{GuideNumber:'9.1',Logo:'http://192.0.2.10:8089/logo/9'}]}});
  const all=await f.get('catalog',{parentId:'channels:live'});
  assert.deepEqual(all.items.map(x=>x.id),['live:9.1','live:36.1','live:101.11','live:215']);
  assert.equal(all.items[0].title,'9.1 Synthetic Local'); assert.equal(all.items[0].subtitle,'HD');
  assert.equal(all.items[0].category,'Antenna'); assert.match(all.items[0].poster,/^\/api\/media\//);
  assert.ok(!JSON.stringify(all).includes('192.0.2.10'));
  const page=await f.get('catalog',{parentId:'channels:live',limit:'1',page:'2',q:'Synthetic'});
  assert.equal(page.items[0].id,'live:36.1');assert.equal(page.hasMore,true);
  assert.equal(f.calls.length,2,'list reads use the provider cache');
  await f.get('catalog',{parentId:'channels:live',refresh:'1'}); assert.equal(f.calls.length,4);
});

const episodes = [
  {id:'12',show_id:'Synthetic Show A',title:'Synthetic Show A',episode_title:'Second',season_number:1,episode_number:2,created_at:2000,duration:100.5,playback_time:25.2,path:'/synthetic/private/second.ts',thumbnail_url:'http://192.0.2.10:8089/thumb/12'},
  {id:'11',show_id:'Synthetic Show A',title:'Synthetic Show A',episode_title:'First',season_number:1,episode_number:1,created_at:1000},
  {id:'13',show_id:'Synthetic Show A',title:'Cancelled',cancelled:true},
];
test('Channels shows and episodes encode opaque show ids and never forward recording paths',async t=>{
  const f=await fixture(t,{data:{
    '/api/v1/shows':[{id:'older',name:'Older',last_recorded_at:1000},{id:'Synthetic Show A',name:'Synthetic Show A',summary:'Summary',number_unwatched:2,last_recorded_at:2000,image_url:'https://art.example/show.jpg'}],
    '/api/v1/shows/Synthetic%20Show%20A/episodes':episodes,
    '/api/v1/episodes':episodes,
    '/api/v1/movies':[{id:'99',title:'Synthetic Film',release_year:2020,duration:120,playback_time:30,watched:true,path:'/synthetic/private/film.ts'}],
  }});
  const shows=await f.get('catalog',{parentId:'channels:shows'});
  assert.deepEqual(shows.items.map(x=>x.id),['show:Synthetic Show A','show:older']);
  assert.equal(shows.items[0].unwatchedCount,2);assert.equal(shows.items[0].description,'Summary');
  const list=await f.get('catalog',{parentId:shows.items[0].id});
  assert.deepEqual(list.items.map(x=>x.id),['file:11','file:12']);
  assert.equal(list.items[1].title,'Second');assert.equal(list.items[1].seriesId,'show:Synthetic Show A');
  assert.equal(list.items[1].duration,100.5);assert.equal(list.items[1].resumeSeconds,25.2);
  assert.match(list.items[1].backdrop,/^\/api\/media\//);
  const next=await f.get('episodes/next',{itemId:'file:11'});assert.equal(next.item.id,'file:12');
  const all=await f.get('episodes',{itemId:'show:Synthetic Show A',kind:'series'});assert.equal(all.items.length,2);
  assert.equal((await f.get('episodes/next',{itemId:'file:12'})).item,null);
  const movies=await f.get('catalog',{parentId:'channels:movies'});
  assert.equal(movies.items[0].id,'movie:99');assert.equal(movies.items[0].year,'2020');assert.equal(movies.items[0].watched,true);
  const json=JSON.stringify({shows,list,next,all,movies});
  assert.ok(!json.includes('192.0.2.10'));assert.ok(!json.includes('"path"'));assert.ok(!json.includes('/synthetic/private'));
  f.c.access={kinds:['live']};
  for(const endpoint of ['catalog?connectionId=c1&parentId=channels:shows','catalog?connectionId=c1&parentId=show:Synthetic%20Show%20A','episodes?connectionId=c1&itemId=file:11'])
    assert.equal((await f.request('/api/'+endpoint)).status,403);
});

test('Channels episodes without season/episode metadata fall back to newest creation time',async t=>{
  const f=await fixture(t,{data:{'/api/v1/shows/Synthetic/episodes':[
    {id:'1',title:'Old',created_at:1000},{id:'2',title:'New',created_at:2000}]}});
  assert.deepEqual((await f.get('catalog',{parentId:'show:Synthetic'})).items.map(x=>x.id),['file:2','file:1']);
});

async function upstreamFixture(t, handler) {
  const base=await listen(t,handler), original=http.request;
  // Route only the reserved synthetic DVR host onto this local fake socket.
  // The production URL/DNS/private-host policy is still exercised before here.
  http.request=(url,options,callback)=>{
    assert.equal(url.hostname,'192.0.2.10','no real network destinations permitted');
    return original(new URL(url.pathname+url.search,base),{...options,lookup:undefined,agent:false},callback);
  };
  t.after(()=>{http.request=original;});
}

test('Channels status handles actual synthetic HTTP success, invalid JSON and server errors',async t=>{
  let mode='ok';
  await upstreamFixture(t,(req,res)=>{
    assert.equal(req.url,'/status');
    res.writeHead(mode==='error'?500:200,{'Content-Type':mode==='html'?'text/html':'application/json'});
    res.end(mode==='html'?'<html>Synthetic failure</html>':JSON.stringify({features:{dvr:true}}));
  });
  const f=await fixture(t,{remoteData:upstreamData});
  assert.equal((await f.post('/api/connections/c1/test',{})).status,200);
  for(mode of ['html','error']) {
    const response=await f.post('/api/connections/c1/test',{});
    // v2: an HTML page is the friendly "refused this address" 400; a 5xx stays a 502.
    assert.equal(response.status,mode==='html'?400:502);assert.match((await response.json()).error,/Channels DVR/);
  }
});

test('Channels validates playback ids and proxies live and recording HLS with resume',async t=>{
  const received=[];
  await upstreamFixture(t,(req,res)=>{
    received.push(req.url);res.setHeader('Content-Type','application/vnd.apple.mpegurl');
    res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvariant.m3u8\n');
  });
  const f=await fixture(t,{data:{'/api/v1/episodes':episodes,'/api/v1/movies':[{id:'99',duration:100,playback_time:20}]}});
  for(const itemId of ['live:../../x','file:1/../2','movie:1?x=2','live:123456','live:1.1234','file:12345678901','file:1%2f2','unknown:1']) {
    const r=await f.request('/api/playback?'+new URLSearchParams({connectionId:'c1',itemId}));
    assert.ok([400,404].includes(r.status),itemId);
  }
  assert.equal(received.length,0);assert.equal(f.calls.length,0);
  for(const [itemId,isLive,resume,path] of [
    ['live:9.1',true,undefined,'/devices/ANY/channels/9.1/hls/master.m3u8'],
    ['file:12',false,25.2,'/dvr/files/12/hls/master.m3u8'],
    ['movie:99',false,20,'/dvr/files/99/hls/master.m3u8'],
  ]) {
    const playback=await f.get('playback',{itemId,kind:isLive?'live':itemId.startsWith('file:')?'episode':'movie'});
    assert.match(playback.url,/^\/api\/media\/m_/);assert.equal(playback.type,'hls');assert.equal(playback.provider,'channels');
    assert.equal(playback.isLive,isLive);assert.equal(playback.resumeSeconds,resume);assert.equal(playback.streamKind,'direct-file');
    assert.ok(!JSON.stringify(playback).includes('192.0.2.10'));
    const manifest=await f.request(playback.url);assert.equal(manifest.status,200);
    assert.match(await manifest.text(),/\/api\/media\/m_/);assert.equal(received.at(-1),path);
    assert.equal((await f.request(playback.url,{headers:{'x-profile':'other'}})).status,404);
    assert.equal((await f.request(playback.url,{headers:{'x-scope':'remote'}})).status,403);
    assert.equal((await fetch(f.base+playback.url)).status,401);
    f.c.access={kinds:[]}; assert.equal((await f.request(playback.url)).status,403);f.c.access=undefined;
  }
  assert.deepEqual(await f.get('playback/options',{itemId:'file:12'}),{audio:[],subtitles:[],qualities:[]});
  f.c.access={kinds:['live']};assert.equal((await f.request('/api/playback?connectionId=c1&itemId=file:12&kind=live')).status,403);
});

test('Channels heartbeat PUT and best-effort release DELETE use validated session paths and enforce viewer access',async t=>{
  const received=[];let fail=false,deleted;
  const deletion=new Promise(resolve=>{deleted=resolve;});
  await upstreamFixture(t,(req,res)=>{
    received.push({method:req.method,path:req.url});
    if(req.method==='DELETE') deleted();
    res.writeHead(fail?500:204);res.end();
  });
  const f=await fixture(t,{media:true});
  const playback=await f.get('playback',{itemId:'live:9.1'});
  for(const headers of [{'x-profile':'other'},{'x-viewer':'other'},{'x-scope':'remote'}])
    assert.ok((await f.request(playback.url+'/heartbeat',{method:'POST',headers})).status>=400);
  f.c.access={kinds:['series']}; assert.equal((await f.request(playback.url+'/heartbeat',{method:'POST'})).status,403);f.c.access=undefined;
  assert.equal(received.length,0);
  assert.equal((await f.request(playback.url+'/heartbeat',{method:'POST'})).status,200);
  assert.deepEqual(received,[{method:'PUT',path:'/devices/ANY/channels/9.1/hls'}]);
  fail=true;
  const failure=await f.request(playback.url+'/heartbeat',{method:'POST'});
  assert.equal(failure.status,502);assert.equal((await failure.json()).error,'Channels DVR could not keep this stream active.');
  const req={user:{id:'owner'},profile:'p1'};
  for(const [type,kind,path] of [['channels','hls','/dvr/files/1/../2/hls'],['channels','hls','//other/hls'],['channels','video','/dvr/files/1/hls'],['m3u','hls','/dvr/files/1/hls']]) {
    const c={...f.c,type};
    const ticket=f.ctx.media.register(req,c,{kind,channelsSessionPath:path});
    f.c.type=type;assert.equal((await f.request(ticket+'/heartbeat',{method:'POST'})).status,400);f.c.type='channels';
  }
  assert.equal(received.length,2);
  assert.equal((await f.request(playback.url,{method:'DELETE',headers:{'x-viewer':'other'}})).status,403);
  assert.equal((await f.request(playback.url,{method:'DELETE'})).status,200);
  await Promise.race([deletion,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('No upstream release')),1000);timer.unref();})]);
  assert.deepEqual(received.at(-1),{method:'DELETE',path:'/devices/ANY/channels/9.1/hls'});
  assert.equal((await f.request(playback.url+'/heartbeat',{method:'POST'})).status,404);
  const recording=f.ctx.media.register(req,f.c,{kind:'hls',channelsSessionPath:'/dvr/files/12/hls',allowedPrivateHosts:['192.0.2.10']});
  fail=false;assert.equal((await f.request(recording+'/heartbeat',{method:'POST'})).status,200);
  assert.deepEqual(received.at(-1),{method:'PUT',path:'/dvr/files/12/hls'});
});

test('Channels cached lists expire within a minute and manual refresh replaces the cached snapshot',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1800000000000});
  let revision=1;
  const f=await fixture(t,{remoteData:async()=>[{id:'1',title:`Synthetic Film ${revision}`}]});
  const list=()=>f.get('catalog',{parentId:'channels:movies'});
  assert.equal((await list()).items[0].title,'Synthetic Film 1');revision=2;
  assert.equal((await list()).items[0].title,'Synthetic Film 1');
  await f.get('catalog',{parentId:'channels:movies',refresh:'1'});
  assert.equal((await list()).items[0].title,'Synthetic Film 2');
  revision=3;t.mock.timers.tick(60001);
  assert.equal((await list()).items[0].title,'Synthetic Film 3');
});

test('Channels tickets stop working after the configured DVR changes',async t=>{
  let calls=0;
  await upstreamFixture(t,(_req,res)=>{calls++;res.writeHead(204);res.end();});
  const f=await fixture(t,{media:true});
  const playback=await f.get('playback',{itemId:'live:9.1'});
  f.c.config.url='http://192.0.2.20:8089';
  assert.equal((await f.request(playback.url+'/heartbeat',{method:'POST'})).status,404);
  assert.equal((await f.request(playback.url)).status,404);
  assert.equal((await f.request(playback.url,{method:'DELETE'})).status,200);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0,'release must not delete a session on the new DVR');
});

test('a connection removed after progress validation produces one actionable connection error', async t => {
  const f = await fixture(t);
  f.ctx.getConnection = () => { throw Object.assign(new Error('Missing private detail'), { status: 404 }); };
  const result = await f.post('/api/library/progress', {
    item: { id: 'file:12', connectionId: 'c1', providerType: 'plex', type: 'episode', source: 'Synthetic DVR' },
    seconds: 20, duration: 100, state: 'paused',
  });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    ok: true,
    connectionSyncError: 'Saved in TesPlay, but the source connection is unavailable. Check your connection in Settings and reopen the title.',
  });
  assert.equal(f.saved[0].seconds, 20);
  assert.deepEqual(f.calls, []);
});

test('progress sync selects only the authoritative provider even if the item claims another type', async t => {
  for (const type of ['channels', 'plex', 'youtube']) {
    const f = await fixture(t);
    f.c.type = type;
    const invoked = [];
    for (const provider of ['Plex', 'Channels']) {
      f.ctx[`sync${provider}Progress`] = async () => {
        invoked.push(provider.toLowerCase());
        // Model deletion after preflight but before the matching hook resolves.
        throw new Error('Connection removed; private detail');
      };
    }
    const result = await f.post('/api/library/progress', {
      item: { id: 'file:12', connectionId: 'c1', providerType: type === 'channels' ? 'plex' : 'channels', type: 'episode', source: 'Synthetic' },
      seconds: 20, duration: 100,
    });
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.deepEqual(invoked, type === 'youtube' ? [] : [type]);
    assert.deepEqual(Object.keys(body).sort(), type === 'youtube' ? ['ok'] : [`${type}SyncError`, 'ok'].sort());
    if (type !== 'youtube') assert.match(body[`${type}SyncError`], /Saved in TesPlay.*Check your/);
    assert.equal(f.saved[0].seconds, 20);
    assert.deepEqual(f.calls, []);
  }
});

test('Channels progress validates recording membership before changing a DVR file',async t=>{
  const f=await fixture(t,{remoteData:async()=>[]});
  const result=await f.post('/api/library/progress',{item:{id:'movie:99',connectionId:'c1',type:'movie',source:'Synthetic DVR'},seconds:99,duration:100,state:'stopped'});
  assert.equal(result.status,200);assert.equal((await result.json()).ok,true);
  assert.ok(f.calls.every(call=>call.method==='GET'),'unavailable recordings must not trigger DVR writes');
});

test('Channels watched threshold uses the matched DVR file duration instead of the client duration',async t=>{
  const f=await fixture(t,{remoteData:async(u,options)=>{
    if(u.pathname==='/api/v1/episodes')return [{id:'99',duration:100},{id:'12',duration:200}];
    if(u.pathname==='/api/v1/movies')return [{id:'12',duration:100}];
    assert.equal(options.method,'PUT');return '';
  }});
  // Neither client duration nor item metadata may override the matched DVR record.
  const item={id:'file:12',connectionId:'c1',type:'episode',duration:100,source:'Synthetic DVR'};
  const result=await f.post('/api/library/progress',{item,seconds:99,duration:100,state:'stopped'});
  assert.equal(result.status,200);
  assert.deepEqual(await result.json(),{ok:true});
  assert.equal(f.calls.at(-1).path,'/dvr/files/12/playback_time/99');
  assert.ok(!f.calls.some(x=>x.path.endsWith('/watch')));
});

test('Channels watches at the inclusive DVR 97 percent boundary using unfloored seconds for episodes and movies',async t=>{
  const f=await fixture(t,{remoteData:async(u,options)=>{
    if(u.pathname==='/api/v1/episodes')return [{id:'99',duration:1},{id:'12',duration:200}];
    if(u.pathname==='/api/v1/movies')return [{id:'99',duration:1},{id:'12',duration:100.5}];
    assert.equal(options.method,'PUT');return '';
  }});
  for(const [prefix,type,dvrDuration] of [['file','episode',200],['movie','movie',100.5]]) {
    const item={id:`${prefix}:12`,connectionId:'c1',type,duration:1,source:'Synthetic DVR'};
    for(const clientDuration of [500,0]) {
      for(const [offset,watched] of [[-.001,false],[0,true],[.001,true]]) {
        const seconds=dvrDuration*.97+offset;
        const before=f.calls.length;
        const result=await f.post('/api/library/progress',{item,seconds,duration:clientDuration,state:'stopped'});
        assert.equal(result.status,200);
        assert.deepEqual(await result.json(),{ok:true});
        const writes=f.calls.slice(before).filter(x=>x.method==='PUT').map(x=>x.path);
        assert.deepEqual(writes,[`/dvr/files/12/playback_time/${Math.floor(seconds)}`,...(watched?['/dvr/files/12/watch']:[])]);
      }
    }
  }
});

test('Channels never auto-watches without a valid DVR duration but still saves progress',async t=>{
  for(const duration of [undefined,null,0,-1,NaN,Infinity,-Infinity,'','  ','100','invalid','Infinity',true,false,[],[100],{}]) {
    await t.test(`duration ${String(duration)} (${typeof duration})`,async t=>{
      const f=await fixture(t,{remoteData:async(u,options)=>{
        if(u.pathname==='/api/v1/episodes')return [{id:'12',duration}];
        assert.equal(options.method,'PUT');return '';
      }});
      const item={id:'file:12',connectionId:'c1',type:'episode',source:'Synthetic DVR'};
      const result=await f.post('/api/library/progress',{item,seconds:100,duration:100,state:'stopped'});
      assert.equal(result.status,200);
      assert.deepEqual(await result.json(),{ok:true});
      assert.equal(f.saved.at(-1).seconds,100);
      assert.deepEqual(f.calls.filter(x=>x.method==='PUT').map(x=>x.path),['/dvr/files/12/playback_time/100']);
    });
  }
});

test('Channels progress saves integer seconds, watches only stopped at 97 percent and keeps local progress on failure',async t=>{
  let fail=false;
  const f=await fixture(t,{remoteData:async(u,options)=>{
    if(fail) throw Object.assign(new Error('Synthetic upstream failure'),{status:502});
    if(u.pathname==='/api/v1/episodes')return [{...episodes[0],duration:100}];
    if(u.pathname==='/api/v1/movies')return [{id:'99',duration:100}];
    assert.equal(options.method,'PUT');return '';
  }});
  const item={id:'file:12',connectionId:'c1',type:'episode',source:'Synthetic DVR'};
  const progress=(value,seconds,duration,state)=>f.post('/api/library/progress',{item:value,seconds,duration,state});
  assert.equal((await progress(item,25.9,100,'playing')).status,200);
  assert.equal(f.calls.at(-1).path,'/dvr/files/12/playback_time/25');
  assert.equal(f.calls.at(-1).method,'PUT');
  for(const [seconds,state] of [[97,'playing'],[99,'paused'],[96.99,'stopped']]) await progress(item,seconds,100,state);
  assert.ok(!f.calls.some(x=>x.path.endsWith('/watch')));
  await progress(item,97,100,'stopped');assert.equal(f.calls.at(-1).path,'/dvr/files/12/watch');
  await progress({...item,id:'movie:99',type:'movie'},100,100,'stopped');assert.equal(f.calls.at(-1).path,'/dvr/files/99/watch');
  const before=f.calls.length;
  await progress({...item,id:'live:9.1',type:'live'},0,0,'stopped');assert.equal(f.calls.length,before);
  fail=true;
  const result=await(await progress(item,20,100,'paused')).json();
  assert.equal(result.ok,true);assert.match(result.channelsSyncError,/Saved in TesPlay.*Channels DVR/);
  assert.equal(f.saved.at(-1).seconds,20);
});
