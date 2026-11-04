import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/index.js';
import {stremioManifestUrl,stremioManifest,stremioSupports,stremioIdentity,stremioStreamReason} from '../server/stremio.js';
import {catalogManifest,streamManifest,configuredUrl,stremioProviderFixture} from './helpers/stremio-fixture.js';

async function fixture(t){
  const dataDir=await mkdtemp(join(tmpdir(),'tesplay-stremio-'));
  const provider=stremioProviderFixture();let now=Date.now();
  const instance=await createApp({dataDir,quiet:true,providerDependencies:{remoteData:provider.request,now:()=>now,requestRemote:async()=>({headers:{'content-type':'application/vnd.apple.mpegurl'},resume(){}})}});
  const resources=[];const register=instance.ctx.media.register;instance.ctx.media.register=(req,c,value)=>{resources.push(value);return register(req,c,value);};
  const owner=instance.store.createOwner({name:'Owner',username:'owner',email:'owner@example.test',passwordHash:'fixture'});
  instance.store.createSession(owner.id,'fixture-stremio-owner-token-0000000000');
  const server=instance.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(path,body,method=body?'POST':'GET',token='fixture-stremio-owner-token-0000000000')=>{
    const response=await fetch(base+'/api'+path,{method,redirect:'manual',headers:{cookie:`aperture_session=${token}`,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const raw=await response.text();return {status:response.status,data:response.headers.get('content-type')?.includes('json')?JSON.parse(raw):raw,headers:response.headers};
  };
  const connect=async()=>{provider.state.approved=true;const link=await request('/stremio/link',{});const result=await request('/stremio/link/check',{id:link.data.id});assert.equal(result.status,200);return result.data.connection;};
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));instance.close();await rm(dataDir,{recursive:true,force:true});});
  return {...instance,...provider,dataDir,owner,request,connect,resources,base,advance:ms=>{now+=ms;}};
}
const query=(connection,itemId,more={})=>'?' + new URLSearchParams({connectionId:connection.id,itemId,...more});

test('configured URLs, resource filters and unsupported stream kinds are validated',()=>{
  assert.equal(stremioManifestUrl(configuredUrl.replace('https:','stremio:')),configuredUrl);
  for(const raw of ['file:///x/manifest.json','http://example.com/manifest.json','https://user:pass@example.com/manifest.json','https://example.com/configure','https://127.0.0.1/manifest.json'])assert.throws(()=>stremioManifestUrl(raw));
  assert.throws(()=>stremioManifest({name:'Invalid'}));
  const addon={enabled:true,manifest:stremioManifest(streamManifest)};
  assert.ok(stremioSupports(addon,'stream','series','tt123:1:2'));
  assert.equal(stremioSupports(addon,'stream','movie','custom:1'),false);
  assert.equal(stremioSupports({...addon,enabled:false},'stream','movie','tt123'),false);
  assert.match(stremioStreamReason({infoHash:'a'.repeat(40)}),/torrent/i);
  assert.match(stremioStreamReason({externalUrl:'https://example.com'}),/website/);
  assert.match(stremioStreamReason({url:'https://example.com/file.mp4',drm:true}),/DRM/);
});

test('account linking polls automatically, is session-bound, saves encrypted addon credentials and never changes the Stremio account',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/stremio/link',{},'POST','anonymous')).status,401);
  const link=await f.request('/stremio/link',{});assert.equal(link.status,200);assert.match(link.data.url,/^https:\/\/link.stremio.com\//);
  assert.equal((await f.request('/stremio/link/check',{id:link.data.id})).data.pending,true);
  f.store.createSession(f.owner.id,'another-owner-session-token-00000000');
  assert.equal((await f.request('/stremio/link/check',{id:link.data.id},'POST','another-owner-session-token-00000000')).status,410);
  f.state.approved=true;f.advance(3500);
  const approved=await f.request('/stremio/link/check',{id:link.data.id});assert.ok(approved.data.connection);
  const c=approved.data.connection;
  assert.equal((await f.request('/stremio/link/check',{id:link.data.id})).data.connection.id,c.id);
  const settings=await f.request(`/stremio/${c.id}/settings`);assert.equal(settings.data.addons.length,2);assert.equal(settings.data.linked,true);
  const all=JSON.stringify([approved.data,settings.data,(await f.request('/connections')).data,(await f.request(`/connections/${c.id}/config`)).data]);
  for(const secret of ['private-stremio-auth-key','debrid-private-key',configuredUrl])assert.ok(!all.includes(secret));
  const raw=await readFile(join(f.dataDir,'aperture.sqlite'));assert.ok(!raw.includes(Buffer.from('debrid-private-key')));assert.ok(!raw.includes(Buffer.from('private-stremio-auth-key')));
  assert.ok(f.state.calls.some(call=>call.url.endsWith('addonCollectionGet')&&JSON.parse(call.options.body).authKey==='private-stremio-auth-key'));
  assert.ok(!f.state.requests.some(url=>/addonCollectionSet|datastorePut/.test(url)));
  assert.equal((await f.request(`/connections/${c.id}`,{config:{authKey:'forged',addons:[]}},'PUT')).status,400);
});

test('cancelled and expired sign-ins do not create connections',async t=>{
  const f=await fixture(t);const link=(await f.request('/stremio/link',{})).data;
  assert.equal((await f.request(`/stremio/link/${link.id}`,{},'DELETE')).status,200);f.state.approved=true;
  assert.equal((await f.request('/stremio/link/check',{id:link.id})).status,410);
  const second=(await f.request('/stremio/link',{})).data;f.advance(301000);
  assert.equal((await f.request('/stremio/link/check',{id:second.id})).status,410);
  assert.equal((await f.request('/connections')).data.connections.length,0);
});

test('addon selection, hidden catalogs, configured-link edits and reimport preserve local choices',async t=>{
  const f=await fixture(t),c=await f.connect();let settings=(await f.request(`/stremio/${c.id}/settings`)).data;
  const catalog=settings.addons.find(a=>a.name==='Cinemeta'),source=settings.addons.find(a=>a.name==='My sources');
  assert.equal((await f.request(`/stremio/${c.id}/addons/${catalog.key}`,{showCatalogs:false},'PATCH')).status,200);
  assert.deepEqual((await f.request(`/stremio/${c.id}/catalogs`)).data.catalogs,[]);
  await f.request(`/stremio/${c.id}/addons/${source.key}`,{enabled:false},'PATCH');
  assert.equal((await f.request('/playback/options'+query(c,stremioIdentity('movie','ttmovie')))).data.sources.length,0);
  settings=(await f.request(`/stremio/${c.id}/sync`,{})).data;
  assert.equal(settings.addons.find(a=>a.key===source.key).enabled,false);assert.equal(settings.addons.find(a=>a.key===catalog.key).showCatalogs,false);
  const changed=await f.request(`/stremio/${c.id}/addons/${source.key}`,{url:'stremio://addon.example/new-private-key/manifest.json',enabled:true},'PATCH');assert.equal(changed.status,200);
  assert.ok(!JSON.stringify(changed.data).includes('new-private-key'));
  assert.equal(f.store.getConnection(f.owner.id,c.id).config.addons.find(a=>a.key===source.key).url,'https://addon.example/new-private-key/manifest.json');
  const reimported=await f.request(`/stremio/${c.id}/sync`,{});assert.equal(reimported.data.addons.length,2);
  assert.equal(f.store.getConnection(f.owner.id,c.id).config.addons.find(a=>a.key===source.key).url,'https://addon.example/new-private-key/manifest.json');
  const configure=await f.request(`/stremio/${c.id}/addons/${source.key}/configure`);assert.equal(configure.status,302);assert.equal(configure.headers.get('referrer-policy'),'no-referrer');
  assert.equal((await f.request(`/stremio/${c.id}/addons/${source.key}`,{},'DELETE')).status,200);
  assert.equal((await f.request(`/stremio/${c.id}/sync`,{})).data.addons.length,1);
});

test('a configured addon link can create a connection without an account, with Cinemeta metadata',async t=>{
  const f=await fixture(t),result=await f.request('/stremio/addon',{url:configuredUrl.replace('https:','stremio:')});assert.equal(result.status,201);
  assert.equal(result.data.linked,false);assert.equal(result.data.addons.length,2);
  assert.equal((await f.request('/stremio/addon',{connectionId:result.data.connection.id,url:configuredUrl})).status,400);
  assert.equal((await f.request('/stremio/addon',{url:'https://addon.example/configure'})).status,400);
});

test('catalogs search and paginate without exposing URLs; episode IDs and next navigation stay exact',async t=>{
  const f=await fixture(t),c=await f.connect();
  const root=await f.request(`/stremio/${c.id}/catalogs`);assert.equal(root.data.catalogs.length,2);
  const category=root.data.catalogs.find(row=>row.type==='movie').id;
  const first=await f.request('/catalog'+query(c,'',{category,kind:'movie',limit:'12',page:'1'}));assert.equal(first.data.items.length,12);assert.equal(first.data.hasMore,true);
  const second=await f.request('/catalog'+query(c,'',{category,kind:'movie',limit:'12',page:'2'}));assert.equal(second.data.items[0].title,'Flower 12');
  await f.request('/catalog'+query(c,'',{category,kind:'movie',q:'a / & b'}));
  assert.ok(f.state.requests.some(url=>url.includes('search=a%20%2F%20%26%20b')));
  assert.ok(first.data.items[0].poster.startsWith('/api/media/a_'));assert.ok(!JSON.stringify(first.data).includes('images.example'));
  const raw=stremioIdentity('series','ttseries'),episodes=await f.request('/episodes'+query(c,raw));assert.equal(episodes.data.items.length,3);
  const firstEpisode=episodes.data.items[1];assert.equal(firstEpisode.seasonNumber,1);assert.equal(firstEpisode.seriesId,raw);
  const next=await f.request('/episodes/next'+query(c,firstEpisode.id));assert.equal(next.data.item.id,episodes.data.items[2].id);
  await f.request('/playback/options'+query(c,firstEpisode.id));assert.ok(f.state.requests.some(url=>url.includes('/stream/series/ttseries%3Afirst.json')));
  assert.equal((await f.request('/episodes'+query(c,'not-a-media-id'))).status,400);
});

test('sources resolve to authenticated TesPlayer media, reject torrents, renew and invalidate when addons change',async t=>{
  const f=await fixture(t),c=await f.connect(),id=stremioIdentity('movie','ttmovie');
  const options=await f.request('/playback/options'+query(c,id));assert.equal(options.data.sources.length,3);assert.equal(options.data.sources[0].unavailable,true);
  assert.ok(!JSON.stringify(options.data).includes('private-playback-token'));
  assert.equal((await f.request('/playback'+query(c,id,{sourceId:options.data.sources[0].id}))).status,400);
  const playback=await f.request('/playback'+query(c,id,{sourceId:options.data.sources[1].id}));assert.equal(playback.status,200);assert.equal(playback.data.provider,'stremio');assert.equal(playback.data.type,'video');assert.match(playback.data.url,/^\/api\/media\/m_/);assert.equal(playback.data.subtitles.length,1);
  assert.ok(!JSON.stringify(playback.data).includes('private-'));assert.ok(!JSON.stringify(playback.data).includes('video.example'));
  const direct=f.resources.find(resource=>resource.url?.includes('private-playback-token'));
  assert.equal(direct.headers['User-Agent'],'Fixture player');assert.equal(direct.headers.Host,undefined);assert.equal(direct.headers['X-Bad'],undefined);
  const hls=await f.request('/playback'+query(c,id,{sourceId:options.data.sources[2].id}));assert.equal(hls.data.type,'hls');
  assert.equal((await f.request('/playback'+query(c,id,{sourceId:'f'.repeat(32)}))).status,400);
  const settings=(await f.request(`/stremio/${c.id}/settings`)).data,source=settings.addons.find(a=>a.name==='My sources');
  await f.request(`/stremio/${c.id}/addons/${source.key}`,{enabled:false},'PATCH');
  const revoked=await f.request(playback.data.url.slice(4));assert.equal(revoked.status,404);assert.match(revoked.data.error,/changed/);
  assert.equal((await f.request('/playback/options'+query(c,id))).data.sources.length,0);
});

test('one failing addon does not hide healthy sources and extensionless HLS is detected',async t=>{
  const f=await fixture(t),c=await f.connect(),id=stremioIdentity('movie','ttmovie');
  await f.request('/stremio/addon',{connectionId:c.id,url:'https://broken.example/manifest.json'});f.state.broken.add('broken.example');
  f.state.streams=[{name:'Extensionless',url:'https://video.example/watch?id=1'}];
  const options=await f.request('/playback/options'+query(c,id));assert.equal(options.data.sources.length,1);assert.match(options.data.note,/Some addons/);
  const playback=await f.request('/playback'+query(c,id));assert.equal(playback.data.type,'hls');
});

test('shared accounts and remote sessions can browse and choose sources, but cannot access settings or change addons',async t=>{
  const f=await fixture(t),c=await f.connect(),id=stremioIdentity('movie','ttmovie');
  const member=f.store.createMember({name:'Passenger',username:'passenger',passwordHash:'fixture',grants:[{connectionId:c.id,kinds:['movie'],sections:null,categories:null}]});
  f.store.createSession(member.id,'fixture-stremio-member-token-00000000');
  const request=(path,body,method)=>f.request(path,body,method,'fixture-stremio-member-token-00000000');
  const addon=(await f.request(`/stremio/${c.id}/settings`)).data.addons.find(a=>a.name==='My sources');
  for(const [path,body,method] of [
    [`/stremio/${c.id}/settings`],
    ['/stremio/link',{connectionId:c.id}],
    [`/stremio/${c.id}/sync`,{}],
    ['/stremio/addon',{connectionId:c.id,url:configuredUrl}],
    [`/stremio/${c.id}/addons/${addon.key}`,{enabled:false},'PATCH'],
    [`/stremio/${c.id}/addons/${addon.key}`,{},'DELETE'],
    [`/stremio/${c.id}/addons/${addon.key}/configure`],
  ])assert.equal((await request(path,body,method)).status,403,path);
  const memberLink=await request('/stremio/link',{});assert.equal(memberLink.status,200);
  const own=await request('/stremio/link/check',{id:memberLink.data.id});assert.equal(own.status,200);
  assert.equal((await request(`/stremio/${own.data.connection.id}/settings`)).status,200);
  assert.equal(f.store.getConnection(member.id,own.data.connection.id).type,'stremio');
  assert.equal((await request('/playback/options'+query(c,id))).status,200);
  assert.equal((await request('/episodes'+query(c,stremioIdentity('series','ttseries')))).status,403);
  const catalogs=(await request(`/stremio/${c.id}/catalogs`)).data.catalogs;assert.ok(catalogs.every(row=>row.type==='movie'));
  const profileId=f.store.profiles(member.id)[0].id;
  const memberSession=f.store.getSession('fixture-stremio-member-token-00000000').session;
  const screen=f.store.ensureScreen({user:member,session:memberSession});
  f.store.createSession(member.id,'fixture-stremio-remote-token-00000000',{scope:'remote',profileId,roomId:screen.id,parentSessionId:memberSession.id});
  const remote=(path,body,method)=>f.request(path,body,method,'fixture-stremio-remote-token-00000000');
  assert.equal((await remote('/playback/options'+query(c,id))).status,200);
  assert.equal((await remote(`/stremio/${c.id}/catalogs`)).status,200);
  assert.equal((await remote(`/stremio/${c.id}/settings`)).status,403);assert.equal((await remote('/playback'+query(c,id))).status,403);
  assert.equal((await remote('/stremio/link',{})).status,403);
  assert.equal((await remote(`/stremio/${own.data.connection.id}/settings`)).status,403);
});

test('the phone forwards an opaque selected source to its paired screen without provider credentials',async t=>{
  const f=await fixture(t),c=await f.connect(),id=stremioIdentity('movie','ttmovie');
  const choices=(await f.request('/playback/options'+query(c,id))).data.sources;
  const sourceId=choices.find(source=>!source.unavailable).id;
  const pair=(await f.request('/remote/pair',{})).data;
  const redeemed=await f.request('/auth/remote/redeem',{code:pair.code,token:pair.token},'POST','anonymous');
  assert.equal(redeemed.status,200);
  const token=redeemed.headers.get('set-cookie').split(';')[0].split('=')[1];
  const events=await fetch(`${f.base}/api/remote/events?roomId=${pair.roomId}`,{headers:{cookie:'aperture_session=fixture-stremio-owner-token-0000000000'},signal:AbortSignal.timeout(3000)});
  assert.equal(events.status,200);const reader=events.body.getReader();await reader.read();
  const item={id,title:'Flower',type:'movie',source:'Stremio',connectionId:c.id,providerType:'stremio'};
  assert.equal((await f.request('/remote/command',{roomId:pair.roomId,command:'load',item,settings:{sourceId}},'POST',token)).status,200);
  const payload=new TextDecoder().decode((await reader.read()).value);
  assert.ok(payload.includes(sourceId));assert.ok(payload.includes('"settings"'));assert.ok(!payload.includes('private-'));
  assert.equal((await f.request('/remote/command',{roomId:pair.roomId,command:'load',item,settings:{sourceId:'https://not-a-source.example'}},'POST',token)).status,400);
  await reader.cancel();
});
