import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir,networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import http from 'node:http';
import {createApp} from '../server/index.js';
import {createStore} from '../server/store.js';
import {hashPassword} from '../server/security.js';
const password='test password for libraries';
async function fixture(t,dependencies={}) {
  const dataDir=await mkdtemp(join(tmpdir(),'tesplay-accounts-'));
  const instance=await createApp({dataDir,setupToken:'fixture-owner-setup',quiet:true,providerDependencies:dependencies});
  const server=instance.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port;
  const client=()=>{let cookie='';const request=async(path,body,method=body?'POST':'GET')=>{const response=await fetch(base+path,{method,headers:{cookie,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual'});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];const text=await response.text();return{status:response.status,data:response.headers.get('content-type')?.includes('json')?JSON.parse(text):text};};request.cookie=()=>cookie;return request;};
  const owner=client();await owner('/api/auth/setup',{name:'Owner',email:'owner@tesplay.test',password,setupToken:'fixture-owner-setup'});
  const connection=(type,config,name=type)=>instance.store.saveConnection(instance.store.findUser('owner@tesplay.test').id,{type,name,config});
  const member=async(grants=[])=>{const created=await owner('/api/accounts',{name:'Passenger',email:'passenger@tesplay.test',password,grants});assert.equal(created.status,201);const request=client();const login=await request('/api/auth/login',{email:'passenger@tesplay.test',password});assert.equal(login.status,200);return{request,id:created.data.account.id,profileId:login.data.activeProfileId};};
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));instance.close();await rm(dataDir,{recursive:true,force:true});});
  return {...instance,dataDir,base,owner,client,connection,member};
}
const grant=(id,kinds,extra={})=>({connectionId:id,kinds,sections:null,categories:null,...extra});

test('Shorts preferences belong to each account across profiles and remote sessions cannot change them', async t => {
  const f = await fixture(t), member = await f.member(), anonymous = f.client();
  assert.deepEqual((await f.owner('/api/settings')).data.preferences, {autoPlayNext: true});
  assert.deepEqual((await member.request('/api/settings')).data.preferences, {autoPlayNext: true});
  assert.equal((await f.owner('/api/settings', {preferences: {hideYouTubeShorts: true}}, 'PATCH')).status, 200);
  assert.deepEqual((await member.request('/api/settings', {preferences: {autoPlayNext: false, hideYouTubeShorts: false}}, 'PATCH')).data.preferences,
    {autoPlayNext: false, hideYouTubeShorts: false});
  const profiles = (await member.request('/api/profiles', {name: 'Another profile', color: '#658a73'})).data.profiles;
  const second = profiles.find(profile => profile.id !== member.profileId);
  assert.equal((await member.request(`/api/profiles/${second.id}/select`, {})).status, 200);
  assert.deepEqual((await member.request('/api/settings')).data.preferences, {autoPlayNext: false, hideYouTubeShorts: false});
  assert.deepEqual((await f.owner('/api/settings')).data.preferences, {autoPlayNext: true, hideYouTubeShorts: true});
  const remote = f.client(), pairing = (await member.request('/api/remote/pair', {})).data;
  assert.equal((await remote('/api/auth/remote/redeem', {code: pairing.code, token: pairing.token})).status, 200);
  assert.deepEqual((await remote('/api/settings')).data.preferences, {autoPlayNext: false, hideYouTubeShorts: false});
  for (const body of [
    {preferences: {hideYouTubeShorts: true}},
    {preferences: {hideYouTubeShorts: true}, initializeYouTubeShorts: true},
  ]) {
    assert.equal((await remote('/api/settings', body, 'PATCH')).status, 403);
    assert.equal((await anonymous('/api/settings', body, 'PATCH')).status, 401);
  }
  assert.equal((await anonymous('/api/settings')).status, 401);
  assert.deepEqual((await member.request('/api/settings')).data.preferences, {autoPlayNext: false, hideYouTubeShorts: false});
});

test('legacy account preference rows migrate in place and initialized Shorts choices survive reopening', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tesplay-account-preferences-migration-'));
  t.after(() => rm(dataDir, {recursive: true, force: true}));
  const original = createStore({dataDir});
  let owner, member, rows;
  try {
    owner = original.createOwner({name: 'Existing owner', username: 'owner', passwordHash: 'fixture-hash'});
    member = original.createMember({name: 'Existing member', username: 'member', passwordHash: 'fixture-hash', grants: []});
    original.savePreferences(owner.id, {autoPlayNext: false});
    original.savePreferences(member.id, {autoPlayNext: true});
    rows = original.db.prepare('SELECT user_id,auto_play_next FROM user_preferences ORDER BY rowid').all();
  } finally { original.close(); }
  const legacy = new DatabaseSync(join(dataDir, 'aperture.sqlite'));
  try {
    legacy.exec(`BEGIN;
      ALTER TABLE user_preferences RENAME TO old_user_preferences;
      CREATE TABLE user_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, auto_play_next INTEGER NOT NULL DEFAULT 1 CHECK(auto_play_next IN (0,1)));
      INSERT INTO user_preferences SELECT user_id,auto_play_next FROM old_user_preferences ORDER BY rowid;
      DROP TABLE old_user_preferences;
      COMMIT;`);
  } finally { legacy.close(); }
  const migrated = createStore({dataDir});
  try {
    assert.deepEqual(migrated.db.prepare('SELECT user_id,auto_play_next FROM user_preferences ORDER BY rowid').all(), rows);
    assert.equal(migrated.db.prepare('SELECT hide_youtube_shorts FROM user_preferences WHERE user_id=?').get(owner.id).hide_youtube_shorts, null);
    assert.deepEqual(migrated.preferences(owner.id), {autoPlayNext: false});
    assert.deepEqual(migrated.preferences(member.id), {autoPlayNext: true});
    assert.deepEqual(migrated.savePreferences(owner.id, {hideYouTubeShorts: false}, {initializeYouTubeShorts: true}),
      {autoPlayNext: false, hideYouTubeShorts: false});
    // A separate connection represents another browser/server observing and
    // attempting to initialize the same already-configured account.
    const other = createStore({dataDir});
    try {
      assert.deepEqual(other.savePreferences(owner.id, {hideYouTubeShorts: true}, {initializeYouTubeShorts: true}),
        {autoPlayNext: false, hideYouTubeShorts: false});
    } finally { other.close(); }
    assert.deepEqual(migrated.savePreferences(member.id, {hideYouTubeShorts: true}, {initializeYouTubeShorts: true}),
      {autoPlayNext: true, hideYouTubeShorts: true});
    assert.throws(() => migrated.db.prepare('UPDATE user_preferences SET hide_youtube_shorts=2 WHERE user_id=?').run(owner.id), /CHECK constraint failed/);
    assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { migrated.close(); }
  const reopened = createStore({dataDir});
  try {
    assert.deepEqual(reopened.preferences(owner.id), {autoPlayNext: false, hideYouTubeShorts: false});
    assert.deepEqual(reopened.savePreferences(owner.id, {autoPlayNext: true}), {autoPlayNext: true, hideYouTubeShorts: false});
    assert.deepEqual(reopened.preferences(member.id), {autoPlayNext: true, hideYouTubeShorts: true});
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM user_preferences').get().count, 2);
  } finally { reopened.close(); }
});

test('owner creates members, shares encrypted connectors, resets passwords and disables accounts',async t=>{
  const f=await fixture(t),c=f.connection('youtube',{authMode:'apiKey',apiKey:'private-fixture-key'});
  const m=await f.member([grant(c.id,['video'])]);
  const visible=await m.request('/api/connections');assert.equal(visible.data.connections.length,1);assert.equal(visible.data.connections[0].shared,true);assert.ok(!JSON.stringify(visible.data).includes('private-fixture-key'));
  assert.equal((await m.request('/api/accounts')).status,403);
  assert.equal((await m.request('/api/accounts',{name:'Intruder',email:'another@tesplay.test',password})).status,403);
  assert.equal((await m.request('/api/connections',{name:'Own connector',type:'local',config:{rootPath:'/tmp'}})).status,403);
  assert.equal((await m.request(`/api/connections/${c.id}/config`)).status,403);
  assert.equal((await m.request(`/api/youtube/auth?connectionId=${c.id}`)).status,403);
  const reset=await f.owner(`/api/accounts/${m.id}`,{password:'replacement member password'},'PATCH');assert.equal(reset.status,200);
  assert.equal((await m.request('/api/connections')).status,401);
  assert.equal((await m.request('/api/auth/login',{email:'passenger@tesplay.test',password})).status,401);
  assert.equal((await m.request('/api/auth/login',{email:'passenger@tesplay.test',password:'replacement member password'})).status,200);
  await f.owner(`/api/accounts/${m.id}`,{disabled:true},'PATCH');
  assert.equal((await m.request('/api/auth/status')).data.user,null);
  assert.equal((await m.request('/api/auth/login',{email:'passenger@tesplay.test',password:'replacement member password'})).status,401);
  assert.equal((await f.owner(`/api/accounts/${m.id}`,{disabled:false},'PATCH')).status,200);
  assert.equal((await m.request('/api/auth/login',{email:'passenger@tesplay.test',password:'replacement member password'})).status,200);
  assert.equal((await m.request('/api/connections')).data.connections.length,1);
  const ownerId=f.store.findUser('owner@tesplay.test').id;
  assert.equal((await f.owner(`/api/accounts/${ownerId}`,{disabled:true},'PATCH')).status,404);
  assert.equal((await f.owner('/api/accounts')).data.accounts.find(a=>a.id===ownerId).role,'owner');
});

test('owner deletes a member and their private state while keeping the owner, other members and shared connections',async t=>{
  const f=await fixture(t),c=f.connection('youtube',{authMode:'apiKey',apiKey:'private-fixture-key'});
  const member=await f.member([grant(c.id,['video'])]);
  const ownerId=f.store.findUser('owner@tesplay.test').id;
  const other=await f.owner('/api/accounts',{name:'Other member',username:'other_member',password,grants:[grant(c.id,['video'])]});
  assert.equal(other.status,201);
  const item={id:'abcdefghijk',title:'Saved video',type:'video',source:'YouTube',connectionId:c.id};
  f.store.toggleFavorite(member.profileId,item);
  f.store.saveProgress(member.profileId,item,45,120);
  f.store.updateQueue(member.profileId,'add',item);
  f.store.toggleStar(member.profileId,{connectionId:c.id,kind:'channel',id:'UC'+'a'.repeat(22),title:'Saved channel'});
  f.store.savePreferences(member.id,{autoPlayNext:false});
  f.store.savePlayerPreferences(member.id,member.profileId,{subtitleLanguage:'en',subtitlesEnabled:true});
  f.store.createProfile(member.id,'Second profile','#658a73');
  const secondSession=f.store.createSession(member.id,'member-second-session-of-sufficient-length');
  assert.equal((await member.request(`/api/accounts/${other.data.account.id}`,{},'DELETE')).status,403);
  assert.equal((await f.client()(`/api/accounts/${member.id}`,{},'DELETE')).status,401);
  assert.equal((await f.owner(`/api/accounts/${ownerId}`,{},'DELETE')).status,404);
  assert.equal((await f.owner(`/api/accounts/${member.id}`,{},'DELETE')).status,200);
  assert.equal((await member.request('/api/connections')).status,401);
  assert.equal((await member.request('/api/auth/login',{username:'passenger',password})).status,401);
  assert.equal(f.store.getSession('member-second-session-of-sufficient-length'),null);
  assert.equal(f.store.db.prepare('SELECT id FROM sessions WHERE id=?').get(secondSession.id),undefined);
  assert.equal(f.store.findUserById(member.id),null);
  assert.deepEqual(f.store.profiles(member.id),[]);
  for(const table of ['favorites','progress','watch_queue','profile_stars','profile_player_preferences'])assert.equal(f.store.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE profile_id=?`).get(member.profileId).count,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM connection_grants WHERE user_id=?').get(member.id).count,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM user_preferences WHERE user_id=?').get(member.id).count,0);
  assert.ok(f.store.findUserById(ownerId));assert.ok(f.store.findUserById(other.data.account.id));
  assert.equal(f.store.getConnection(ownerId,c.id).config.apiKey,'private-fixture-key');
  assert.equal((await f.owner('/api/accounts')).data.accounts.length,2);
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal((await f.owner(`/api/accounts/${member.id}`,{},'DELETE')).status,404);
});

test('legacy demo saves no longer appear while connected titles and radio remain visible',async t=>{
  const f=await fixture(t),owner=f.store.findUser('owner@tesplay.test'),profile=f.store.profiles(owner.id)[0];
  const c=f.connection('plex',{baseUrl:'https://plex.test',token:'private-fixture-token'});
  const demo={id:'sintel',title:'Sintel',type:'movie',source:'Open cinema'};
  const connected={...demo,connectionId:c.id};
  const radio={id:'station',title:'My radio station',type:'audio',source:'Radio'};
  for(const item of [demo,connected,radio]){f.store.toggleFavorite(profile.id,item);f.store.saveProgress(profile.id,item,45,120);}
  const state=await f.owner('/api/library/state');assert.equal(state.status,200);
  assert.equal(state.data.favorites.length,2);assert.equal(state.data.progress.length,2);
  assert.ok(state.data.favorites.some(item=>item.connectionId===c.id));
  assert.ok(state.data.favorites.some(item=>item.id==='station'));
  assert.ok(!state.data.favorites.some(item=>item.id==='sintel'&&!item.connectionId));
});

test('legacy singleton migration preserves the owner, credentials, profiles, sessions and foreign keys',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'tesplay-legacy-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let store=createStore({dataDir:dir});const owner=store.createOwner({name:'Existing',email:'existing@tesplay.test',passwordHash:await hashPassword(password)});
  const c=store.saveConnection(owner.id,{type:'youtube',name:'Existing library',config:{apiKey:'existing-fixture-secret'}});
  const token='legacy-test-session-token-of-sufficient-length',session=store.createSession(owner.id,token),profile=store.profiles(owner.id)[0];
  store.saveProgress(profile.id,{id:'abcdefghijk',title:'Saved video',type:'video',source:'YouTube',connectionId:c.id},45,120);store.close();
  const legacy=new DatabaseSync(join(dir,'aperture.sqlite'));
  legacy.exec(`PRAGMA foreign_keys=OFF;BEGIN;
    CREATE TABLE users_old (id TEXT PRIMARY KEY,singleton INTEGER NOT NULL UNIQUE DEFAULT 1 CHECK(singleton=1),name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,created_at TEXT NOT NULL);
    INSERT INTO users_old (id,name,email,password_hash,created_at) SELECT id,name,email,password_hash,created_at FROM users;
    DROP TABLE users; ALTER TABLE users_old RENAME TO users;COMMIT;`);legacy.close();
  store=createStore({dataDir:dir});
  assert.equal(store.findUser(owner.email).role,'owner');assert.equal(store.getSession(token).session.id,session.id);
  assert.equal(store.profiles(owner.id)[0].id,profile.id);assert.equal(store.getConnection(owner.id,c.id).config.apiKey,'existing-fixture-secret');
  assert.equal(store.libraryState(profile.id).progress[0].seconds,45);assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  store.createMember({name:'New member',email:'new@tesplay.test',passwordHash:await hashPassword(password),grants:[]});assert.equal(store.listAccounts().length,2);store.close();
});

test('IPTV grants filter categories and reject direct playback and episode requests for unshared titles',async t=>{
  const f=await fixture(t,{remoteData:async input=>{const u=new URL(input),action=u.searchParams.get('action');if(action==='get_vod_streams')return[{stream_id:1,name:'Allowed movie',category_id:10},{stream_id:2,name:'Private movie',category_id:20}];if(action==='get_vod_categories')return[{category_id:10,category_name:'Allowed'},{category_id:20,category_name:'Private'}];if(action==='get_vod_info')return{movie_data:{container_extension:'mp4'}};if(action==='get_series')return[{series_id:3,name:'Private show',category_id:30}];throw Error('Unexpected provider request '+action);}});
  const c=f.connection('xtream',{url:'https://iptv.example.test',username:'fixture',password:'private-fixture'});
  const m=await f.member([grant(c.id,['movie'],{categories:['movie:10']})]);
  const result=await m.request(`/api/catalog?connectionId=${c.id}&kind=movie`);assert.equal(result.status,200);assert.deepEqual(result.data.items.map(i=>i.title),['Allowed movie']);assert.deepEqual(result.data.categories.map(i=>i.id),['movie:10']);
  assert.equal((await m.request(`/api/playback?connectionId=${c.id}&kind=movie&itemId=2`)).status,403);
  assert.equal((await m.request(`/api/playback?connectionId=${c.id}&kind=movie&itemId=1`)).status,200);
  assert.equal((await m.request(`/api/catalog?connectionId=${c.id}&kind=series`)).status,403);
  assert.equal((await m.request(`/api/catalog?connectionId=${c.id}&parentId=3`)).status,403);
  assert.equal((await m.request(`/api/episodes/next?connectionId=${c.id}&itemId=3:4:mp4`)).status,403);
  assert.equal((await m.request(`/api/playback?connectionId=${c.id}&kind=episode&itemId=3:4:mp4`)).status,403);
  const other=f.connection('local',{rootPath:'/tmp'});assert.equal((await m.request(`/api/catalog?connectionId=${other.id}`)).status,403);
});

test('separate accounts stream concurrently and media references cannot cross accounts or survive revoked grants',async t=>{
  const lan=Object.values(networkInterfaces()).flat().find(x=>x.family==='IPv4'&&!x.internal)?.address;if(!lan)return t.skip('LAN interface required for protected upstream fixture');
  const upstream=http.createServer((req,res)=>res.end('fixture stream'));await new Promise(r=>upstream.listen(0,'0.0.0.0',r));t.after(()=>new Promise(r=>upstream.close(r)));
  const origin=`http://${lan}:${upstream.address().port}`,f=await fixture(t),c=f.connection('m3u',{url:origin+'/playlist.m3u',content:`#EXTM3U\n#EXTINF:-1 group-title="Shared",One\n${origin}/stream.mp4`});
  const m=await f.member([grant(c.id,['live'])]);const catalog=await m.request(`/api/catalog?connectionId=${c.id}`),id=catalog.data.items[0].id;
  const [ownerStream,memberStream]=await Promise.all([f.owner(`/api/playback?connectionId=${c.id}&itemId=${id}`),m.request(`/api/playback?connectionId=${c.id}&itemId=${id}`)]);
  assert.equal(ownerStream.status,200);assert.equal(memberStream.status,200);assert.notEqual(ownerStream.data.url,memberStream.data.url);
  assert.equal((await m.request(ownerStream.data.url)).status,404);
  const [a,b]=await Promise.all([f.owner(ownerStream.data.url),m.request(memberStream.data.url)]);assert.equal(a.data,'fixture stream');assert.equal(b.data,'fixture stream');
  await f.owner(`/api/accounts/${m.id}`,{grants:[]},'PATCH');assert.equal((await m.request(memberStream.data.url)).status,403);assert.equal((await m.request('/api/connections')).data.connections.length,0);
});

test('Plex hubs preserve server lists, watched posters and full-list pagination while enforcing library grants',async t=>{
  const movie={ratingKey:'11',title:'Watched film',type:'movie',librarySectionID:'6',viewCount:1,thumb:'/poster/11',Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',Part:[{key:'/library/parts/11/movie.mp4'}]}]};
  const unshared={...movie,ratingKey:'private',title:'Private film',librarySectionID:'7'};
  const f=await fixture(t,{remoteData:async input=>{const u=new URL(input);let data;
    if(u.hostname==='discover.provider.plex.tv')data={Metadata:[{ratingKey:'remote',guid:'plex://movie/fixture',title:'Watchlist title',type:'movie'}],totalSize:1};
    else if(u.pathname==='/library/sections')data={Directory:[{key:'6',type:'movie',title:'Movies'},{key:'7',type:'show',title:'TV Shows'}]};
    else if(u.pathname==='/hubs/sections/6')data={Hub:[{title:'Recently Added in Movies',key:'/library/sections/6/all?sort=addedAt:desc',Metadata:[movie]},{title:'Movies soon to be removed',key:'/library/collections/900/children',Metadata:[movie,unshared]}]};
    else if(u.pathname==='/library/all')data={Metadata:[movie]};
    else if(u.pathname==='/library/metadata/99')data={Metadata:[{ratingKey:'99',type:'show',librarySectionID:'7'}]};
    else if(u.pathname==='/library/metadata/11')data={Metadata:[movie]};
    else if(u.pathname==='/library/collections/900/children'||u.pathname==='/library/sections/6/all')data={Metadata:[movie,unshared],totalSize:125};
    else throw Error('Unexpected Plex request '+u.pathname);
    return JSON.stringify({MediaContainer:data});
  }});
  const c=f.connection('plex',{url:'https://plex.example.test',token:'private-plex-fixture',userToken:'private-account-fixture',ownerProfileId:(await f.owner('/api/auth/status')).data.activeProfileId});
  const m=await f.member([grant(c.id,['movie'],{sections:['6']})]);
  const sections=await m.request(`/api/plex/${c.id}/sections`);assert.deepEqual(sections.data.sections.map(s=>s.title),['Movies']);
  const result=await m.request(`/api/plex/${c.id}/hubs?sectionId=6`);assert.equal(result.status,200);
  assert.ok(result.data.hubs.some(h=>h.title==='Watchlist'));const hub=result.data.hubs.find(h=>h.title==='Movies soon to be removed');
  assert.equal(hub.items.length,1);
  assert.equal(hub.items[0].watched,true);assert.equal(hub.items[0].artwork,'poster');assert.ok(!JSON.stringify(result.data).includes('private-plex-fixture'));
  const full=await m.request(`/api/plex/${c.id}/list?listId=${encodeURIComponent(hub.id)}&page=2`);assert.equal(full.status,200);assert.equal(full.data.hasMore,true);assert.equal(full.data.items[0].id,'11');assert.equal(full.data.items.length,1);
  assert.equal((await m.request(`/api/plex/${c.id}/hubs?sectionId=7`)).status,403);
  const folder=Buffer.from('/library/metadata/99/children').toString('base64url');assert.equal((await m.request(`/api/catalog?connectionId=${c.id}&parentId=${folder}`)).status,403);
  assert.equal((await m.request(`/api/playback?connectionId=${c.id}&itemId=11&kind=movie`)).status,200);
  const fake=f.store.sealMedia({purpose:'plex-list',connectionId:c.id,sectionId:'6',kind:'movie',path:'https://evil.example/secret'});
  assert.equal((await m.request(`/api/plex/${c.id}/list?listId=${fake}`)).status,400);
});

test('starred YouTube feeds and ordered watch playlists are isolated by profile and persist',async t=>{
  const a='UC'+'a'.repeat(22),b='UC'+'b'.repeat(22);
  const f=await fixture(t,{remoteData:async input=>{const u=new URL(input);if(u.pathname.endsWith('/subscriptions'))return{items:[a,b].map(id=>({snippet:{resourceId:{channelId:id}}}))};if(u.pathname.endsWith('/channels')){assert.equal(u.searchParams.get('id'),a);return{items:[{contentDetails:{relatedPlaylists:{uploads:'UU'+'a'.repeat(22)}}}]};}if(u.pathname.endsWith('/playlistItems'))return{items:[{contentDetails:{videoId:'abcdefghijk'},snippet:{title:'Latest upload',channelId:a}},{contentDetails:{videoId:'lmnopqrstuv'},snippet:{title:'Earlier upload',channelId:a}}]};throw Error('Unexpected YouTube request');}});
  const c=f.connection('youtube',{authMode:'oauth',accessToken:'fixture-access',refreshToken:'fixture-refresh',expiresAt:Date.now()+3600000},'API');
  assert.deepEqual((await f.owner(`/api/youtube/${c.id}/feed`)).data.items,[]);
  const original=(await f.owner('/api/auth/status')).data.activeProfileId;
  await f.owner('/api/library/stars',{connectionId:c.id,id:a,kind:'channel',title:'My favorite channel'});
  const feed=await f.owner(`/api/youtube/${c.id}/feed`);assert.equal(feed.data.totalChannels,1);assert.equal(feed.data.channelRows[0].items[0].title,'Latest upload');assert.equal(feed.data.items[0].source,'YouTube');
  for(const item of feed.data.items)assert.equal((await f.owner('/api/library/queue',{action:'add',item})).status,200);
  const state=await f.owner('/api/library/state');assert.deepEqual(state.data.queue.map(i=>i.title),['Latest upload','Earlier upload']);assert.equal(state.data.favorites.length,0);
  const second=await f.owner('/api/profiles',{name:'Second',color:'#658a73'});const id=second.data.profiles.find(p=>p.id!==original).id;
  await f.owner(`/api/profiles/${id}/select`,{});assert.deepEqual((await f.owner('/api/library/state')).data.queue,[]);assert.deepEqual((await f.owner(`/api/youtube/${c.id}/feed`)).data.items,[]);
  await f.owner(`/api/profiles/${original}/select`,{});assert.equal((await f.owner('/api/library/state')).data.queue.length,2);
  const reopened=createStore({dataDir:f.dataDir});assert.equal(reopened.queue(original).length,2);assert.equal(reopened.stars(original)[0].id,a);reopened.close();
});

test('anonymous visitors cannot read libraries, playback, sharing or saved queues',async t=>{
  const f=await fixture(t),anonymous=f.client();
  for(const path of ['/api/connections','/api/catalog','/api/playback','/api/library/state','/api/accounts','/api/media/unknown'])assert.equal((await anonymous(path)).status,401,path);
  assert.equal((await anonymous('/api/library/queue',{action:'clear'})).status,401);
  assert.equal((await anonymous('/api/library/stars',{connectionId:'unknown',kind:'channel',id:'UC'+'a'.repeat(22),title:'A'})).status,401);
});

test('allowed series episodes retain their provider category in saved progress and favorites',async t=>{
  const f=await fixture(t,{remoteData:async input=>{const u=new URL(input),action=u.searchParams.get('action');if(action==='get_series')return[{series_id:3,name:'Shared series',category_id:10}];if(action==='get_series_info')return{info:{name:'Shared series'},episodes:{1:[{id:4,title:'Allowed episode',episode_num:1,container_extension:'mp4'}]}};throw Error('Unexpected request');}});
  const c=f.connection('xtream',{url:'https://iptv.example.test',username:'fixture',password:'fixture'}),m=await f.member([grant(c.id,['series'],{categories:['series:10']})]);
  const result=await m.request(`/api/catalog?connectionId=${c.id}&parentId=3`);assert.equal(result.status,200);const item=result.data.items[0];assert.equal(item.accessCategory,'series:10');
  assert.equal((await m.request('/api/library/favorites',{item})).status,200);assert.equal((await m.request('/api/library/progress',{item,seconds:10,duration:100,profileId:m.profileId})).status,200);
  const saved=await m.request('/api/library/state');assert.equal(saved.data.favorites.length,1);assert.equal(saved.data.progress.length,1);
});

test('resetting a member password also revokes a previously approved sign-in QR',async t=>{
  const f=await fixture(t),m=await f.member(),screen=f.client();
  const init=await screen('/api/auth/qr/init',{});const token=new URLSearchParams(new URL(init.data.verificationUrl).hash.slice(1)).get('token');
  assert.equal((await m.request('/api/auth/qr/approve',{id:init.data.id,token})).status,200);
  await f.owner(`/api/accounts/${m.id}`,{password:'another replacement password'},'PATCH');
  assert.equal((await screen('/api/auth/qr/poll',{id:init.data.id})).status,410);
});

test('existing YouTube favorites migrate once into the ordered watch playlist',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'tesplay-queue-migration-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let store=createStore({dataDir:dir});const owner=store.createOwner({name:'Owner',email:'queue@tesplay.test',passwordHash:await hashPassword(password)});
  const c=store.saveConnection(owner.id,{type:'youtube',name:'API',config:{authMode:'apiKey',apiKey:'fixture'}}),p=store.profiles(owner.id)[0];
  for(const id of ['abcdefghijk','lmnopqrstuv'])store.toggleFavorite(p.id,{id,type:'video',title:id,source:'API',connectionId:c.id});
  store.toggleFavorite(p.id,{id:'movie',type:'movie',title:'Retained movie',source:'Plex'});
  store.db.prepare("DELETE FROM schema_migrations WHERE name='youtube-watch-playlist'").run();store.close();
  store=createStore({dataDir:dir});assert.deepEqual(store.queue(p.id).map(i=>i.id),['abcdefghijk','lmnopqrstuv']);assert.deepEqual(store.libraryState(p.id).favorites.map(i=>i.id),['movie']);store.close();
  store=createStore({dataDir:dir});assert.equal(store.queue(p.id).length,2);assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);store.close();
});

test('username accounts need no email, log in case-insensitively, and keep legacy owner email login working',async t=>{
 const f=await fixture(t);
 const created=await f.owner('/api/accounts',{name:'Passenger',username:'movie_fan',password,grants:[]});assert.equal(created.status,201);assert.equal(created.data.account.username,'movie_fan');assert.equal(created.data.account.email,null);
 const member=f.client();assert.equal((await member('/api/auth/login',{username:'MOVIE_FAN',password})).status,200);
 assert.equal((await f.owner('/api/accounts',{name:'Duplicate',username:'Movie_Fan',password,grants:[]})).status,409);
 assert.equal((await f.client()('/api/auth/login',{email:'owner@tesplay.test',password})).status,200);
 assert.equal((await f.owner('/api/accounts',{name:'Invalid',username:'bad name',password,grants:[]})).status,400);
 assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('phone selection sends a playable title only to its paired screen and preserves account and profile boundaries',async t=>{
 const f=await fixture(t),c=f.connection('youtube',{authMode:'apiKey',apiKey:'fixture'});
 const phone=f.client();await phone('/api/auth/login',{email:'owner@tesplay.test',password});
 const pair=(await f.owner('/api/remote/pair',{})).data;assert.equal((await phone('/api/remote/join',{code:pair.code})).status,200);
 // A phone cannot become a second command listener that plays its own cast.
 assert.equal((await phone(`/api/remote/events?roomId=${pair.roomId}`)).status,403);
 const abort=new AbortController();
 const response=await fetch(`${f.base}/api/remote/events?roomId=${pair.roomId}`,{headers:{cookie:f.owner.cookie()},signal:abort.signal});
 const reader=response.body.getReader();await reader.read();t.after(()=>{abort.abort();void reader.cancel().catch(()=>{});});
 const item={id:'abcdefghijk',connectionId:c.id,type:'video',title:'Selected on phone',source:'YouTube'};
 assert.equal((await phone('/api/remote/command',{roomId:pair.roomId,command:'load',item})).status,200);
 assert.equal((await phone('/api/remote/command',{roomId:pair.roomId,command:'load',item:{...item,type:'folder'}})).status,400);
 assert.equal((await phone('/api/remote/command',{roomId:pair.roomId,command:'load',item:{...item,connectionId:'not-shared'}})).status,404);
 const m=await f.member([grant(c.id,['video'])]);assert.equal((await m.request('/api/remote/command',{roomId:pair.roomId,command:'load',item})).status,404);
 assert.equal((await m.request(`/api/remote/state?roomId=${pair.roomId}`)).status,404);
 const profile=(await f.owner('/api/profiles',{name:'Other',color:'#658a73'})).data.profiles.find(p=>p.name==='Other');
 await phone(`/api/profiles/${profile.id}/select`,{});assert.equal((await phone(`/api/remote/state?roomId=${pair.roomId}`)).status,404);assert.equal((await phone('/api/remote/command',{roomId:pair.roomId,command:'load',item})).status,404);
});

test('subtitle preference belongs to the selected profile, survives selection, and is deleted with the profile',async t=>{
 const f=await fixture(t);const original=(await f.owner('/api/auth/status')).data.activeProfileId;
 assert.deepEqual((await f.owner('/api/player/preferences')).data,{subtitleLanguage:null,subtitlesEnabled:false,audioLanguage:null,qualityId:'auto'});
 assert.equal((await f.owner('/api/player/preferences',{subtitleLanguage:'eng',subtitlesEnabled:true},'PATCH')).status,200);
 const second=(await f.owner('/api/profiles',{name:'Second',color:'#658a73'})).data.profiles.find(p=>p.id!==original);
 await f.owner(`/api/profiles/${second.id}/select`,{});
 assert.deepEqual((await f.owner('/api/player/preferences')).data,{subtitleLanguage:null,subtitlesEnabled:false,audioLanguage:null,qualityId:'auto'});
 assert.equal((await f.owner('/api/player/preferences',{subtitleLanguage:'en',subtitlesEnabled:'yes'},'PATCH')).status,400);
 await f.owner(`/api/profiles/${original}/select`,{});
 assert.deepEqual((await f.owner('/api/player/preferences')).data,{subtitleLanguage:'eng',subtitlesEnabled:true,audioLanguage:null,qualityId:'auto'});
 assert.equal((await f.owner(`/api/profiles/${original}`,{},'DELETE')).status,200);
 assert.deepEqual((await f.owner('/api/player/preferences')).data,{subtitleLanguage:null,subtitlesEnabled:false,audioLanguage:null,qualityId:'auto'});
 assert.equal((await f.owner(`/api/profiles/${second.id}`,{},'DELETE')).status,400);
 assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
 const member=await f.member();assert.equal((await member.request(`/api/profiles/${second.id}`,{},'DELETE')).status,404);
});

test('Plex continuity reads linked-profile history/watchlist and playback checkpoints sync without losing local progress on failure',async t=>{
  const calls=[];let fail=false;
  const movie={ratingKey:'11',type:'movie',title:'Film',librarySectionID:'6',duration:120000,viewOffset:45000,lastViewedAt:1790000000,viewCount:1,guid:'plex://movie/11',Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',Part:[{key:'/library/parts/11/file.mp4',Stream:[]}]}]};
  const blocked={...movie,ratingKey:'12',title:'Private',librarySectionID:'7'};
  const f=await fixture(t,{remoteData:async(input,options)=>{const u=new URL(input);calls.push({u,method:options.method||'GET',token:options.headers['X-Plex-Token'],session:options.headers['X-Plex-Session-Identifier']});if(u.pathname==='/:/timeline'){if(fail)throw Error('Plex offline');return '';}if(u.pathname==='/:/scrobble')return '';let data={};if(u.pathname==='/library/sections')data={Directory:[{key:'6',title:'Movies',type:'movie'},{key:'7',title:'Private',type:'movie'}]};else if(u.hostname==='discover.provider.plex.tv')data={Metadata:[movie]};else if(u.pathname==='/library/all')data={Metadata:[movie]};else if(u.pathname.endsWith('/all'))data={Metadata:[movie,blocked]};else if(u.pathname==='/library/metadata/11')data={Metadata:[movie]};else if(u.pathname==='/library/metadata/12')data={Metadata:[blocked]};return JSON.stringify({MediaContainer:data});}});
  const profile=(await f.owner('/api/auth/status')).data.activeProfileId;
  const c=f.connection('plex',{url:'https://plex.example.test',token:'owner-secret',userToken:'cloud-secret',ownerProfileId:profile,profileTokens:{[profile]:{token:'linked-profile-secret'}}});
  const result=await f.owner(`/api/plex/${c.id}/continuity`);assert.equal(result.status,200);assert.equal(result.data.progress.find(p=>p.item.id==='11').seconds,45);assert.equal(result.data.watchlist[0].id,'11');assert.ok(calls.every(c=>c.token==='linked-profile-secret'));assert.ok(!JSON.stringify(result.data).includes('secret'));
  calls.length=0;
  const item=result.data.progress.find(p=>p.item.id==='11').item;
  assert.equal((await f.owner('/api/library/progress',{item,seconds:55,duration:120,state:'paused'})).status,200);
  let timeline=calls.find(c=>c.u.pathname==='/:/timeline');assert.equal(timeline.u.searchParams.get('time'),'55000');assert.equal(timeline.u.searchParams.get('state'),'paused');assert.equal(timeline.token,'linked-profile-secret');assert.equal(timeline.method,'POST');assert.match(timeline.session,/^[a-f0-9]{64}$/);assert.ok(!calls.some(c=>c.u.pathname==='/:/scrobble'));
  calls.length=0;await f.owner('/api/library/progress',{item,seconds:120,duration:120,state:'stopped'});assert.ok(calls.some(c=>c.u.pathname==='/:/scrobble'&&c.method==='PUT'));
  fail=true;const failed=await f.owner('/api/library/progress',{item,seconds:70,duration:120,state:'paused'});assert.equal(failed.status,200);assert.match(failed.data.plexSyncError,/Saved in TesPlay/);assert.equal((await f.owner('/api/library/state')).data.progress[0].seconds,70);
  fail=false;calls.length=0;
  const m=await f.member([grant(c.id,['movie'],{sections:['6']})]);
  const restricted=await m.request(`/api/plex/${c.id}/continuity`);assert.equal(restricted.status,200);assert.deepEqual(restricted.data.progress.map(p=>p.item.id),['11']);assert.ok(!calls.some(c=>c.u.pathname==='/library/sections/7/all'));
  assert.equal((await m.request(`/api/playback/options?connectionId=${c.id}&itemId=12&kind=movie`)).status,403);
  assert.equal((await m.request(`/api/playback/options?connectionId=${c.id}&itemId=11&kind=movie`)).status,200);
  const before=calls.length;await m.request('/api/library/progress',{item:{...item,id:'12'},seconds:10,duration:120,state:'playing'});assert.ok(!calls.slice(before).some(c=>c.u.pathname==='/:/timeline'));
  assert.equal((await f.client()(`/api/plex/${c.id}/continuity`)).status,401);
});

test('Plex episode selector inherits the authorized series library when allLeaves entries omit section metadata',async t=>{
  const f=await fixture(t,{remoteData:async input=>{const u=new URL(input);return JSON.stringify({MediaContainer:{Metadata:u.pathname.endsWith('/allLeaves')?[{ratingKey:'101',type:'episode',title:'Pilot',parentIndex:1,index:1,Media:[{}]}]:[{ratingKey:'900',type:'show',librarySectionID:'7'}]}});}});
  const c=f.connection('plex',{url:'https://plex.example',token:'fixture'}),m=await f.member([grant(c.id,['series'],{sections:['7']})]);
  const show=Buffer.from('/library/metadata/900/children').toString('base64url');const result=await m.request(`/api/episodes?connectionId=${c.id}&itemId=${show}&kind=series`);assert.equal(result.status,200);assert.equal(result.data.items[0].sectionId,'7');assert.equal(result.data.items[0].type,'episode');
});

test('a QR remote can read its screen profile episode catalogue and continuity while retaining connection grants and playback restrictions',async t=>{
  const f=await fixture(t,{remoteData:async input=>{
    const u=new URL(input);
    const content=u.pathname==='/library/sections'?{Directory:[{key:'7',type:'show',title:'Allowed shows'}]}:
      u.pathname.endsWith('/allLeaves')?{Metadata:[{ratingKey:'101',type:'episode',title:'Pilot',parentIndex:1,index:1,Media:[{}]}]}:
      u.pathname.startsWith('/library/metadata/')?{Metadata:[{ratingKey:'900',type:'show',librarySectionID:'7'}]}:{Metadata:[]};
    return JSON.stringify({MediaContainer:content});
  }});
  const c=f.connection('plex',{url:'https://plex.example',token:'private-fixture-token'});
  const hidden=f.connection('plex',{url:'https://other-plex.example',token:'hidden-fixture-token'});
  const m=await f.member([grant(c.id,['series'],{sections:['7']})]);
  const qr=(await m.request('/api/remote/pair',{})).data,phone=f.client();
  const redeemed=await phone('/api/auth/remote/redeem',{code:qr.code,token:qr.token});
  assert.equal(redeemed.data.scope,'remote');assert.equal(redeemed.data.activeProfileId,m.profileId);
  const show=Buffer.from('/library/metadata/900/children').toString('base64url');
  const result=await phone(`/api/episodes?connectionId=${c.id}&itemId=${show}&kind=series`);
  assert.equal(result.status,200);assert.equal(result.data.items[0].sectionId,'7');
  assert.equal(result.data.items[0].seasonNumber,1);assert.equal(result.data.items[0].episodeNumber,1);
  assert.ok(!JSON.stringify(result.data).includes('private-fixture-token'));
  assert.equal((await phone(`/api/plex/${c.id}/continuity`)).status,200);
  assert.equal((await phone(`/api/episodes?connectionId=${hidden.id}&itemId=${show}&kind=series`)).status,403);
  assert.equal((await phone(`/api/plex/${hidden.id}/continuity`)).status,403);
  for(const endpoint of ['/api/playback?itemId=101','/api/playback/options?itemId=101','/api/browsers'])assert.equal((await phone(endpoint)).status,403);
  assert.equal((await phone('/api/episodes',{})).status,403);
  assert.equal((await phone('/api/library/progress',{item:result.data.items[0],seconds:20,duration:120})).status,403);
});

test('household creation saves independent playback defaults and profile writes cannot cross accounts',async t=>{
  const f=await fixture(t),defaults={audioLanguage:'de',subtitleLanguage:'nl',subtitlesEnabled:true,qualityId:'480p'};
  const created=await f.owner('/api/accounts',{name:'New viewer',username:'new-viewer',password,playbackDefaults:defaults});
  assert.equal(created.status,201);
  const viewer=f.client(),login=await viewer('/api/auth/login',{username:'new-viewer',password});
  assert.equal(login.status,200);assert.deepEqual((await viewer('/api/player/preferences')).data,defaults);
  assert.deepEqual((await f.owner('/api/player/preferences')).data,{audioLanguage:null,subtitleLanguage:null,subtitlesEnabled:false,qualityId:'auto'});
  assert.throws(()=>f.store.savePlayerPreferences(f.store.findUser('owner@tesplay.test').id,login.data.activeProfileId,{qualityId:'720p'}),/profile was not found/);
  await viewer('/api/player/preferences',{audioLanguage:'en'},'PATCH');
  assert.deepEqual((await viewer('/api/player/preferences')).data,{...defaults,audioLanguage:'en'});
});

test('legacy subtitle preferences migrate without losing captions and new defaults remain available after reopening',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'tesplay-defaults-migration-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const original=createStore({dataDir});
  const user=original.createOwner({name:'Existing viewer',username:'existing',passwordHash:'fixture-hash'}),profile=original.profiles(user.id)[0];
  original.savePlayerPreferences(user.id,profile.id,{subtitleLanguage:'eng',subtitlesEnabled:true});original.close();
  const legacy=new DatabaseSync(join(dataDir,'aperture.sqlite'));
  legacy.exec('ALTER TABLE profile_player_preferences RENAME TO old_player_preferences; CREATE TABLE profile_player_preferences (profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,subtitle_language TEXT,subtitles_enabled INTEGER NOT NULL DEFAULT 0); INSERT INTO profile_player_preferences SELECT profile_id,subtitle_language,subtitles_enabled FROM old_player_preferences; DROP TABLE old_player_preferences;');
  legacy.close();
  const migrated=createStore({dataDir});
  assert.deepEqual(migrated.playerPreferences(user.id,profile.id),{subtitleLanguage:'eng',subtitlesEnabled:true,audioLanguage:null,qualityId:'auto'});
  migrated.savePlayerPreferences(user.id,profile.id,{audioLanguage:'nl',qualityId:'720p'});migrated.close();
  const reopened=createStore({dataDir});
  try { assert.deepEqual(reopened.playerPreferences(user.id,profile.id),{subtitleLanguage:'eng',subtitlesEnabled:true,audioLanguage:'nl',qualityId:'720p'}); }
  finally { reopened.close(); }
});

test('modular account and shared connection routes retain anonymous, member and remote authorization gates', async t => {
  const f = await fixture(t);
  const c = f.connection('youtube', {authMode: 'apiKey', apiKey: 'modular-route-secret'});
  const member = await f.member([grant(c.id, ['video'])]);
  const remote = f.client();
  const pairing = (await f.owner('/api/remote/pair', {})).data;
  assert.equal((await remote('/api/auth/remote/redeem', {code: pairing.code, token: pairing.token})).status, 200);
  assert.equal((await remote('/api/auth/status')).data.scope, 'remote');

  const ownerRoutes = [
    ['/api/accounts'],
    ['/api/accounts', {name: 'Forbidden', username: 'forbidden_user', password}],
    [`/api/accounts/${member.id}`, {name: 'Forbidden'}, 'PATCH'],
    [`/api/accounts/${member.id}`, {}, 'DELETE'],
    [`/api/connections/${c.id}/config`],
    [`/api/connections/${c.id}`, {config: {apiKey: 'replacement'}}, 'PUT'],
    [`/api/connections/${c.id}`, {}, 'DELETE'],
  ];
  for (const [request, status] of [[f.client(), 401], [member.request, 403], [remote, 403]]) {
    for (const args of ownerRoutes) {
      assert.equal((await request(...args)).status, status, `${args[2] || (args[1] ? 'POST' : 'GET')} ${args[0]}`);
    }
  }
  for (const [request, status] of [[f.client(), 401], [remote, 403]]) {
    assert.equal((await request('/api/connections', {type: 'youtube', config: {apiKey: 'replacement'}})).status, status);
  }
  const owner = f.store.findUser('owner@tesplay.test');
  assert.equal(f.store.getConnection(owner.id, c.id).config.apiKey, 'modular-route-secret');
  assert.equal(f.store.findUserById(member.id).name, 'Passenger');
  assert.equal((await f.owner('/api/accounts')).data.accounts.length, 2);
  assert.equal((await member.request('/api/connections')).status, 200);
  assert.equal((await remote('/api/connections')).status, 200);
});

test('household accounts manage personal connections alongside read-only shared libraries', async t => {
  const f = await fixture(t);
  const content = '#EXTM3U\n#EXTINF:-1 group-title="Sports",Sport\nhttps://streams.example.test/sport.m3u8';
  const shared = f.connection('m3u', {content}, 'Shared TV');
  const sharedPlex = f.connection('plex', {url: 'https://plex.example.test', token: 'owner-secret'});
  const member = await f.member([grant(shared.id, ['live']), grant(sharedPlex.id, ['movie'])]);
  assert.equal((await member.request('/api/auth/status')).data.user.canManageConnections, true);
  assert.equal((await member.request('/api/connection-capabilities')).data.canUseLocal, false);
  const other = await f.owner('/api/accounts', {name: 'Other', username: 'other', password, grants: []});
  const otherClient = f.client();
  await otherClient('/api/auth/login', {username: 'other', password});

  const preview = await member.request('/api/connections/categories/preview', {type: 'm3u', config: {content}});
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.data.categories.map(c => c.id), ['Sports']);
  const saved = await member.request('/api/connections', {type: 'm3u', name: 'My TV', config: {content, loadedCategories: ['Sports']}});
  assert.equal(saved.status, 201);
  const own = saved.data.connection;
  assert.equal(f.store.getConnection(member.id, own.id).config.content, content);
  assert.equal((await member.request(`/api/connections/${own.id}/test`, {})).status, 200);
  assert.equal((await member.request(`/api/connections/${own.id}/categories`)).status, 200);
  assert.equal((await member.request(`/api/connections/${own.id}/config`)).status, 200);
  const catalog = await member.request(`/api/catalog?connectionId=${own.id}&kind=live`);
  assert.equal(catalog.status, 200);
  assert.equal(catalog.data.items[0].title, 'Sport');
  assert.equal((await member.request(`/api/playback?connectionId=${own.id}&itemId=${catalog.data.items[0].id}&kind=live`)).status, 200);
  assert.equal((await member.request('/api/library/favorites', {item: catalog.data.items[0]})).status, 200);
  assert.equal((await member.request('/api/library/state')).data.favorites[0].connectionId, own.id);
  const visible = (await member.request('/api/connections')).data.connections;
  assert.equal(visible.length, 3);
  assert.ok(!visible.find(c => c.id === own.id).shared);
  assert.equal(visible.find(c => c.id === shared.id).shared, true);
  assert.ok(!JSON.stringify(visible).includes('owner-secret'));
  assert.deepEqual((await otherClient('/api/connections')).data.connections, []);
  assert.ok(!(await f.owner('/api/connections')).data.connections.some(c => c.id === own.id));
  assert.equal((await otherClient(`/api/connections/${own.id}/config`)).status, 403);
  assert.equal((await f.owner(`/api/connections/${own.id}/config`)).status, 404);

  for (const args of [
    [`/api/connections/${shared.id}/config`],
    [`/api/connections/${shared.id}/categories`],
    [`/api/connections/${shared.id}/test`, {}],
    [`/api/connections/${shared.id}`, {name: 'Changed'}, 'PUT'],
    [`/api/connections/${shared.id}`, {}, 'DELETE'],
    ['/api/connections', {id: shared.id, type: 'm3u', config: {content}}],
    [`/api/plex/${sharedPlex.id}/servers`],
    [`/api/plex/${sharedPlex.id}/server`, {id: 'server', url: 'https://plex.example.test'}],
    [`/api/plex/${sharedPlex.id}/profiles`],
    [`/api/plex/${sharedPlex.id}/profile`, {id: '1'}],
  ]) assert.equal((await member.request(...args)).status, 403, args[0]);
  assert.equal((await member.request('/api/connections', {type: 'local', config: {rootPath: '/tmp'}})).status, 403);
  assert.equal((await member.request(`/api/connections/${own.id}`, {name: 'Renamed TV', config: {loadedCategories: []}}, 'PUT')).status, 200);
  assert.deepEqual((await member.request(`/api/catalog?connectionId=${own.id}&kind=live`)).data.items, []);
  await f.owner(`/api/accounts/${member.id}`, {grants: []}, 'PATCH');
  assert.deepEqual((await member.request('/api/connections')).data.connections.map(c => c.id), [own.id]);
  assert.equal((await member.request(`/api/connections/${own.id}`, {}, 'DELETE')).status, 200);
  assert.deepEqual((await member.request('/api/connections')).data.connections, []);
  assert.equal(f.store.getConnection(f.store.findUser('owner@tesplay.test').id, shared.id).name, 'Shared TV');
  assert.ok(f.store.findUserById(other.data.account.id));
});
