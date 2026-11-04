import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../server/store.js';
import {createProviderCache} from '../server/provider-cache.js';
test('provider catalog persists encrypted across restarts, rejects changed config and cascades on deletion',t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'tesplay-catalog-'));t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
  let store=createStore({dataDir});
  const owner=store.createOwner({name:'Test',username:'owner',passwordHash:'unused'});
  const c=store.saveConnection(owner.id,{type:'xtream',name:'IPTV',config:{url:'https://iptv.example',password:'secret'}});
  const value=[{stream_id:1,name:'Private collection',stream_icon:'https://images.example/secret.jpg'}];
  store.writeProviderCatalog(c.id,'get_vod_streams','fingerprint',value);
  const raw=store.db.prepare('SELECT encrypted_value FROM provider_catalog_cache').get().encrypted_value;
  assert.ok(!raw.includes('Private collection'));assert.ok(!raw.includes('secret.jpg'));store.close();
  store=createStore({dataDir});t.after(()=>store.close());
  assert.deepEqual(store.readProviderCatalog(c.id,'get_vod_streams','fingerprint'),value);
  assert.equal(store.readProviderCatalog(c.id,'get_vod_streams','changed'),undefined);
  store.db.prepare('DELETE FROM connections WHERE id=?').run(c.id);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM provider_catalog_cache').get().n,0);
});

test('provider cache expires metadata and fingerprints every connection setting', async () => {
  let now = 1_000;
  let reads = 0;
  const cache = createProviderCache({}, {now: () => now});
  const connection = {id: 'fixture', config: {url: 'https://iptv.example', password: 'original'}};
  const key = cache.cacheKey(connection);
  const get = async () => ++reads;
  assert.equal(await cache.cached(key, get), 1);
  now += 59_999;
  assert.equal(await cache.cached(key, get), 1);
  now += 1;
  assert.equal(await cache.cached(key, get), 2);
  const changed = cache.cacheKey({...connection, config: {...connection.config, password: 'changed'}});
  assert.notEqual(changed, key);
  assert.equal(await cache.cached(changed, get), 3);

  for (let i = 0; i < 302; i++) await cache.cached(`metadata:${i}`, async () => i);
  assert.equal(await cache.cached(changed, get), 4, 'old metadata is evicted once the bounded cache fills');
});

test('manual catalog refresh deduplicates requests while saved readers and failed refreshes retain the last good catalog', async () => {
  const saved = new Map();
  let writes = 0;
  const store = {
    readProviderCatalog(id, resource, fingerprint) {
      const record = saved.get(`${id}:${resource}`);
      return record?.fingerprint === fingerprint ? record.value : undefined;
    },
    writeProviderCatalog(id, resource, fingerprint, value) {
      writes++;
      saved.set(`${id}:${resource}`, {fingerprint, value});
    },
  };
  const connection = {id: 'fixture', config: {url: 'https://iptv.example'}};
  const cache = createProviderCache(store);
  const original = [{stream_id: 1, category_id: 10}];
  assert.deepEqual(await cache.catalogCached(connection, 'movies', async () => original), original);

  let complete;
  let requests = 0;
  const refreshed = [{stream_id: 2, category_id: 20}];
  const load = () => { requests++; return new Promise(resolve => { complete = resolve; }); };
  const first = cache.catalogCached(connection, 'movies', load, true);
  const second = cache.catalogCached(connection, 'movies', load, true);
  assert.equal(requests, 1);
  assert.deepEqual(await cache.catalogCached(connection, 'movies', () => assert.fail('saved readers must not refetch')), original);
  complete(refreshed);
  assert.deepEqual(await Promise.all([first, second]), [refreshed, refreshed]);
  assert.equal(writes, 2);

  await assert.rejects(cache.catalogCached(connection, 'movies', async () => { throw new Error('temporary provider failure'); }, true), /temporary provider failure/);
  assert.deepEqual(await cache.catalogCached(connection, 'movies', () => assert.fail('failed refresh must retain the saved catalog')), refreshed);
  assert.equal(writes, 2);
  assert.deepEqual(await createProviderCache(store).catalogCached(connection, 'movies', () => assert.fail('restart must read the saved catalog')), refreshed);
});

test('failed initial catalog flights are removed so a later request can retry', async () => {
  const cache = createProviderCache();
  const connection = {id: 'fixture', config: {}};
  let fail;
  let reads = 0;
  const load = () => { reads++; return new Promise((_resolve, reject) => { fail = reject; }); };
  const first = cache.catalogCached(connection, 'playlist', load);
  const second = cache.catalogCached(connection, 'playlist', load);
  const settled = Promise.allSettled([first, second]);
  assert.equal(reads, 1);
  fail(new Error('offline'));
  assert.deepEqual((await settled).map(result => result.status), ['rejected', 'rejected']);
  assert.deepEqual(await cache.catalogCached(connection, 'playlist', async () => ['recovered']), ['recovered']);
});
