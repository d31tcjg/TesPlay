import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { validateConnection } from '../server/connection-routes.js';

const qualities = ['original', '8000-1080', '4000-720', '2000-720', '1000-576'];
test('Channels maxQuality validates only the supported values, including partial edits', () => {
  for (const maxQuality of qualities) {
    assert.equal(validateConnection({type:'channels', config:{maxQuality}}).config.maxQuality, maxQuality);
  }
  for (const maxQuality of ['', 'auto', '2000', null, 2000, {}, []]) {
    assert.throws(() => validateConnection({type:'channels', config:{maxQuality}}), {status:400});
  }
  assert.deepEqual(validateConnection({type:'channels', config:{url:'http://192.0.2.10'}}).config, {url:'http://192.0.2.10'});
  assert.doesNotThrow(() => validateConnection({name:'Renamed'}, {type:'channels', name:'DVR', config:{maxQuality:'2000-720'}}));
});

test('Channels maxQuality survives encrypted config round trips and edits without re-entering URL', async t => {
  const dataDir = await mkdtemp(join(process.env.BH_AGENT_WORKSPACE || process.env.TMPDIR, 'channels-quality-'));
  const instance = await createApp({dataDir, setupToken:'synthetic-setup', registerProviders:false, quiet:true});
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { instance.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dataDir,{recursive:true,force:true}); });
  let cookie = '';
  async function request(path, method='GET', body) {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/${path}`, {
      method, headers:{cookie, 'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {}),
    });
    if(r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
    return {status:r.status, body:await r.json()};
  }
  assert.equal((await request('auth/setup','POST',{name:'Synthetic', email:'synthetic@example.test', password:'synthetic long password', setupToken:'synthetic-setup'})).status,201);
  const created = await request('connections','POST',{type:'channels', name:'Synthetic DVR', config:{url:'http://192.0.2.10:8089'}});
  assert.equal(created.status,201);
  const id = created.body.connection.id;
  assert.equal((await request(`connections/${id}/config`)).body.config.maxQuality, undefined, 'missing means original');
  for (const maxQuality of qualities) {
    assert.equal((await request(`connections/${id}`,'PUT',{config:{url:'',maxQuality}})).status,200);
    const edited = await request(`connections/${id}/config`);
    assert.equal(edited.body.config.maxQuality,maxQuality);
    assert.equal(edited.body.config.url,undefined,'saved URL stays hidden');
    assert.ok(edited.body.configuredFields.includes('url'),'blank edit preserved the URL');
  }
  assert.equal((await request(`connections/${id}`,'PUT',{config:{maxQuality:'bogus'}})).status,400);
  assert.equal((await request(`connections/${id}/config`)).body.config.maxQuality,'1000-576');
});
