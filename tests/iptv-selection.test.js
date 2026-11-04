import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { createApp } from '../server/index.js';
import { createStore } from '../server/store.js';

async function fixture(t, remoteData, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'tesplay-iptv-selection-'));
  const instance = await createApp({ dataDir, setupToken:'iptv-fixture-setup', quiet:true, providerDependencies:{remoteData}, ...options });
  const server = instance.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (path, body, method = body === undefined ? 'GET' : 'POST') => {
      const response = await fetch(base + path, {method, headers:{cookie,...(body === undefined ? {} : {'Content-Type':'application/json'})},...(body === undefined ? {} : {body:JSON.stringify(body)})});
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return {status:response.status,data:await response.json()};
    };
  };
  const owner = client(), password = 'iptv fixture password';
  await owner('/api/auth/setup', {name:'Owner',email:'owner@iptv.test',password,setupToken:'iptv-fixture-setup'});
  const add = async (config = {}, type = 'xtream', name = 'IPTV') => {
    const r = await owner('/api/connections', {type,name,config:{url:'https://iptv.example.test',username:'fixture',password:'private-fixture',...config}});
    assert.equal(r.status,201); return r.data.connection;
  };
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); instance.close(); await rm(dataDir,{recursive:true,force:true}); });
  return {...instance,dataDir,owner,add,client,password};
}
const provider = (calls = []) => async input => {
  const u = new URL(input), action = u.searchParams.get('action'); calls.push({action,category:u.searchParams.get('category_id')});
  if (action?.endsWith('_categories')) return [{category_id:0,category_name:'Sports'},{category_id:1,category_name:'News'}];
  if (['get_live_streams','get_vod_streams','get_series'].includes(action)) return [
    {stream_id:7,series_id:7,category_id:0,name:'Selected title'},
    {stream_id:8,series_id:8,category_id:1,name:'Excluded title'},
  ];
  if (action === 'get_vod_info') return {movie_data:{container_extension:'mp4'}};
  return {user_info:{auth:1}};
};

test('IPTV setup previews unsaved categories without storing credentials, connections or catalogs', async t => {
  const calls = [], f = await fixture(t,provider(calls));
  const config = {url:'https://iptv.example.test',username:'fixture',password:'private-fixture'};
  const result = await f.owner('/api/connections/categories/preview',{type:'xtream',name:'New IPTV',config});
  assert.equal(result.status,200); assert.equal(result.data.categories.length,6);
  assert.ok(calls.every(c => c.action.endsWith('_categories')));
  assert.deepEqual((await f.owner('/api/connections')).data.connections,[]);
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM provider_catalog_cache').get().count,0);
  assert.ok(!JSON.stringify(result.data).includes('private-fixture'));
  const c = await f.add({...config,loadedCategories:['live:0','movie:1']});
  assert.deepEqual(c.loadedCategories,['live:0','movie:1']);
  assert.deepEqual((await f.owner(`/api/catalog?connectionId=${c.id}&kind=all`)).data.items.map(i=>[i.type,i.id]),[['movie','8'],['live','7']]);
});

test('draft category discovery validates input and lets household members preview their own setup', async t => {
  const calls = [], f = await fixture(t,provider(calls));
  const endpoint = '/api/connections/categories/preview';
  for (const value of [null,{type:'plex',config:{}},{type:'xtream',config:{}},{type:'m3u',config:{}},{type:'xtream',config:{url:'x'.repeat(25_000)}}])
    assert.equal((await f.owner(endpoint,value)).status,400);
  assert.equal(calls.length,0);
  const body = {type:'xtream',config:{url:'https://iptv.example.test',username:'fixture',password:'private-fixture'}};
  assert.equal((await f.client()(endpoint,body)).status,401);
  await f.owner('/api/accounts',{name:'Member',email:'member@iptv.test',password:f.password,grants:[]});
  const member = f.client(); await member('/api/auth/login',{email:'member@iptv.test',password:f.password});
  assert.equal((await member(endpoint,body)).status,200);
  assert.equal(calls.length,3);
  assert.deepEqual((await f.owner('/api/connections')).data.connections,[]);
});

test('IPTV setup preserves provider failure messages through gateways without saving a draft', async t => {
  let failure;
  const f = await fixture(t, async () => { throw failure; });
  const endpoint = '/api/connections/categories/preview';
  for (const type of ['xtream', 'm3u']) {
    for (const status of [502, 503, 504]) {
      const message = 'The provider address could not be resolved. Check its current address with the provider.';
      failure = Object.assign(new Error(message), { status });
      const result = await f.owner(endpoint, {type, config:{url:'https://iptv.example.test',username:'fixture',password:'private-fixture'}});
      assert.equal(result.status,422);
      assert.equal(result.data.code,'IPTV_PROVIDER_UNAVAILABLE');
      assert.equal(result.data.error,`Could not load IPTV categories. ${message}`);
      assert.ok(!JSON.stringify(result.data).includes('private-fixture'));
    }
  }
  failure = Object.assign(new Error('The IPTV provider rejected these credentials.'), { status:400 });
  const rejected = await f.owner(endpoint, {type:'xtream', config:{url:'https://iptv.example.test',username:'fixture',password:'private-fixture'}});
  assert.equal(rejected.status,400);
  assert.equal(rejected.data.error,failure.message);
  failure = new Error('Unexpected private-fixture implementation details');
  const unexpected = await f.owner(endpoint, {type:'xtream', config:{url:'https://iptv.example.test',username:'fixture',password:'private-fixture'}});
  assert.equal(unexpected.status,500);
  assert.equal(unexpected.data.error,'The server could not complete this request.');
  assert.deepEqual((await f.owner('/api/connections')).data.connections,[]);
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM provider_catalog_cache').get().count,0);
});

test('independent accounts manage only their own IPTV categories and retain category filtering', async t => {
  const calls = [], f = await fixture(t,provider(calls));
  const ownerConnection = await f.add({loadedCategories:['live:0']});
  const first = f.client(), second = f.client();
  // Previously created independent accounts retain their own connections.
  for (const [name, username] of [['First','first-iptv'], ['Second','second-iptv']]) {
    f.store.createMember({name, username, passwordHash:f.store.findUser('owner@iptv.test').password_hash, grants:[], independent:true});
  }
  const signup = await first('/api/auth/login',{username:'first-iptv',password:f.password});
  assert.equal(signup.status,200);
  assert.equal((await second('/api/auth/login',{username:'second-iptv',password:f.password})).status,200);
  const config = {url:'https://iptv.example.test',username:'fixture',password:'private-fixture',loadedCategories:['live:0']};
  assert.equal((await first('/api/connections/categories/preview',{type:'xtream',config})).status,200);
  const saved = await first('/api/connections',{type:'xtream',name:'Personal IPTV',config});
  assert.equal(saved.status,201);
  const connection = saved.data.connection;
  assert.equal((await first(`/api/connections/${connection.id}/categories`)).status,200);
  assert.equal((await first(`/api/connections/${ownerConnection.id}/categories`)).status,404);
  assert.equal((await second(`/api/connections/${connection.id}/categories`)).status,404);
  assert.deepEqual((await second('/api/connections')).data.connections,[]);
  const catalog = await first(`/api/catalog?connectionId=${connection.id}&kind=live`);
  assert.equal(catalog.status,200);
  assert.deepEqual(catalog.data.items.map(item=>item.id),['7']);
  const selected = catalog.data.items[0];
  assert.equal(f.store.visibleItem(signup.data.user.id,selected),true);
  assert.equal(f.store.visibleItem(signup.data.user.id,{...selected,id:'8',category:'live:1',accessCategory:'live:1'}),false);
});

test('M3U setup discovers pasted groups before saving a selected playlist', async t => {
  const f = await fixture(t,provider());
  const content = '#EXTM3U\n#EXTINF:-1 group-title="Sports",Sport\nhttps://streams.example.test/sport.m3u8\n#EXTINF:-1 group-title="News",News\nhttps://streams.example.test/news.m3u8';
  const result = await f.owner('/api/connections/categories/preview',{type:'m3u',config:{content}});
  assert.equal(result.status,200);
  assert.deepEqual(result.data.categories.map(c=>c.id),['Sports','News']);
  assert.deepEqual((await f.owner('/api/connections')).data.connections,[]);
  const c = await f.add({content,loadedCategories:['Sports']},'m3u');
  assert.deepEqual((await f.owner(`/api/catalog?connectionId=${c.id}&kind=live`)).data.items.map(i=>i.title),['Sport']);
});

test('IPTV discovers names without downloading titles, then fetches only selected scoped categories and preserves providers', async t => {
  const calls = [], f = await fixture(t,provider(calls));
  const first = await f.add({loadedCategories:['live:0','movie:0']}), second = await f.add({loadedCategories:['live:0']},'xtream','Second IPTV');
  const categories = await f.owner(`/api/connections/${first.id}/categories`);
  assert.equal(categories.status,200); assert.equal(categories.data.categories.length,6);
  assert.ok(categories.data.categories.some(c => c.id === 'live:0'));
  assert.ok(categories.data.categories.some(c => c.id === 'movie:0'));
  assert.ok(calls.every(c => c.action.endsWith('_categories')));
  calls.length = 0;
  const one = (await f.owner(`/api/catalog?connectionId=${first.id}&kind=all`)).data;
  const two = (await f.owner(`/api/catalog?connectionId=${second.id}&kind=live`)).data;
  assert.deepEqual(one.items.map(i => [i.type,i.id,i.connectionId]), [['movie','7',first.id],['live','7',first.id]]);
  assert.equal(two.items[0].connectionId,second.id);
  assert.deepEqual(one.categories.map(c => c.id),['movie:0','live:0']);
  assert.ok(calls.filter(c => ['get_live_streams','get_vod_streams','get_series'].includes(c.action)).every(c => c.category === '0'));
  assert.ok(!calls.some(c => c.action === 'get_series'));
  const streamsBefore = calls.filter(c => c.action === 'get_live_streams').length;
  await f.owner(`/api/catalog?connectionId=${second.id}&kind=live`);
  assert.equal(calls.filter(c => c.action === 'get_live_streams').length,streamsBefore);
  const reopened = createStore({dataDir:f.dataDir});
  try { assert.deepEqual(reopened.listConnections(reopened.findUser('owner@iptv.test').id,true)[0].config.loadedCategories,['live:0','movie:0']); }
  finally { reopened.close(); }
  assert.ok(!JSON.stringify(one).includes('private-fixture'));
});

test('empty IPTV selection requests no streams and changing selection blocks disabled playback and saved items', async t => {
  const calls = [], f = await fixture(t,provider(calls)), c = await f.add({loadedCategories:[]});
  assert.deepEqual((await f.owner(`/api/catalog?connectionId=${c.id}&kind=all`)).data.items,[]);
  assert.ok(!calls.some(c => c.action?.endsWith('_streams') || c.action === 'get_series'));
  assert.equal((await f.owner(`/api/playback?connectionId=${c.id}&kind=live&itemId=7`)).status,404);
  assert.equal((await f.owner(`/api/connections/${c.id}`,{config:{loadedCategories:['live:0']}},'PUT')).status,200);
  const item = (await f.owner(`/api/catalog?connectionId=${c.id}&kind=live`)).data.items[0];
  const playback = await f.owner(`/api/playback?connectionId=${c.id}&kind=live&itemId=7`);
  assert.equal(playback.status,200);
  assert.equal((await f.owner('/api/library/favorites',{item})).status,200);
  await f.owner(`/api/connections/${c.id}`,{config:{loadedCategories:[]}},'PUT');
  assert.deepEqual((await f.owner('/api/library/state')).data.favorites,[]);
  assert.equal((await f.owner(playback.data.url)).status,403);
});

test('IPTV category selection intersects household grants and settings remain owner-only', async t => {
  const f = await fixture(t,provider()), c = await f.add({loadedCategories:['movie:0','movie:1']});
  await f.owner('/api/accounts',{name:'Member',email:'member@iptv.test',password:f.password,grants:[{connectionId:c.id,kinds:['movie'],sections:null,categories:['movie:1']}]});
  const member = f.client(); await member('/api/auth/login',{email:'member@iptv.test',password:f.password});
  assert.equal((await member(`/api/connections/${c.id}/categories`)).status,403);
  assert.equal((await member(`/api/connections/${c.id}`,{config:{loadedCategories:null}},'PUT')).status,403);
  assert.deepEqual((await member(`/api/catalog?connectionId=${c.id}&kind=movie`)).data.items.map(i => i.id),['8']);
  await f.owner(`/api/connections/${c.id}`,{config:{loadedCategories:['movie:0']}},'PUT');
  assert.deepEqual((await member(`/api/catalog?connectionId=${c.id}&kind=movie`)).data.items,[]);
  assert.equal((await member(`/api/playback?connectionId=${c.id}&kind=movie&itemId=8`)).status,404);
});

test('IPTV selection validates config, preserves credentials on edit, and supports explicit all categories', async t => {
  const f = await fixture(t,provider()), c = await f.add({loadedCategories:['live:0']});
  for (const loadedCategories of ['live:0',{},[0],['bad'],['live:0&password=leak']]) {
    assert.equal((await f.owner(`/api/connections/${c.id}`,{config:{loadedCategories}},'PUT')).status,400);
  }
  await f.owner(`/api/connections/${c.id}`,{config:{loadedCategories:null,password:''}},'PUT');
  assert.equal(f.store.visibleConnection(f.store.findUser('owner@iptv.test').id,c.id).config.password,'private-fixture');
  assert.equal((await f.owner(`/api/connections/${c.id}/categories`)).data.loadedCategories,null);
  assert.equal((await f.owner(`/api/catalog?connectionId=${c.id}&kind=live`)).data.items.length,2);
  assert.equal((await f.owner('/api/connections',{type:'plex',config:{loadedCategories:[]}})).status,400);
});

test('M3U imports only selected groups, including uncategorized channels, and blocks other groups', async t => {
  const f = await fixture(t,provider()), c = await f.add({loadedCategories:['Sports','__ungrouped__'],content:'#EXTM3U\n#EXTINF:-1 group-title="Sports",Sport\nhttps://streams.example.test/sport.m3u8\n#EXTINF:-1 group-title="News",News\nhttps://streams.example.test/news.m3u8\n#EXTINF:-1,Other\nhttps://streams.example.test/other.m3u8'},'m3u');
  const categoryResult = (await f.owner(`/api/connections/${c.id}/categories`)).data;
  assert.ok(categoryResult.categories.some(c => c.id === '__ungrouped__'));
  assert.deepEqual((await f.owner(`/api/catalog?connectionId=${c.id}&kind=live`)).data.items.map(i => i.title),['Sport','Other']);
  await f.owner('/api/accounts',{name:'Member',email:'member@iptv.test',password:f.password,grants:[{connectionId:c.id,kinds:['live'],sections:null,categories:['__ungrouped__']}]});
  const member = f.client(); await member('/api/auth/login',{email:'member@iptv.test',password:f.password});
  const permitted = (await member(`/api/catalog?connectionId=${c.id}&kind=live`)).data.items;
  assert.deepEqual(permitted.map(i => i.title),['Other']);
  assert.equal((await member(`/api/playback?connectionId=${c.id}&kind=live&itemId=${permitted[0].id}`)).status,200);
});

test('bundle merges matching category names while retaining connection and content-type identities', async () => {
  const source = ts.transpileModule(await readFile(new URL('../src/iptv-library.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
  const {bundleIptvCategories,bundleIptvItems,bundleIptvShelves,supportsIptvKind} = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const first = {id:'one',type:'xtream',loadedCategories:['live:0']}, second = {id:'two',type:'m3u'};
  const results = {one:{items:[{id:'7',type:'live',title:'One',connectionId:'one'}],categories:[{id:'live:0',name:'Sports'}]},two:{items:[{id:'7',type:'live',title:'Two',connectionId:'two'}],categories:[{id:'Sports',name:'sports'}]}};
  assert.equal(bundleIptvCategories(results).length,1);
  assert.equal(bundleIptvCategories(results)[0].sources.length,2);
  assert.deepEqual(bundleIptvItems(results).map(i => i.connectionId),['one','two']);
  assert.equal(bundleIptvShelves([{id:'one:live',kind:'live',connection:first,items:results.one.items},{id:'two:live',kind:'live',connection:second,items:results.two.items}]).length,1);
  assert.equal(supportsIptvKind(first,'movie'),false);
  assert.equal(supportsIptvKind(second,'movie'),false);
  assert.equal(supportsIptvKind({...first,access:{kinds:['movie']}},'live'),false);
});
