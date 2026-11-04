import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../server/index.js';

test('self-hosted playback works across browsers without a plan, lease or public signup', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tesplay-self-hosting-'));
  // Old deployment flags must never bring back a payment requirement.
  const instance = await createApp({dataDir, setupToken: 'fixture-setup', quiet: true,
    registrationEnabled: true, billingEnabled: true, streamLimitsEnabled: true});
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    instance.close();
    await rm(dataDir, {recursive: true, force: true});
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const credentials = {username: 'owner', password: 'self hosted fixture password'};
  const setup = await fetch(origin + '/api/auth/setup', {method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({...credentials, name: 'Owner', setupToken: 'fixture-setup'})});
  assert.equal(setup.status, 201);
  const auth = await setup.json();
  assert.equal(Object.hasOwn(auth, 'registrationEnabled'), false);
  const cookies = [setup.headers.get('set-cookie').split(';')[0]];
  const login = await fetch(origin + '/api/auth/login', {method: 'POST',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify(credentials)});
  assert.equal(login.status, 200);
  cookies.push(login.headers.get('set-cookie').split(';')[0]);
  await writeFile(join(dataDir, 'sample.mp4'), 'sample fixture bytes');
  const connection = instance.store.saveConnection(auth.user.id,
    {type: 'local', name: 'Own files', config: {rootPath: dataDir}});
  const path = `/api/playback?connectionId=${connection.id}&itemId=${Buffer.from('sample.mp4').toString('base64url')}&kind=video`;
  const playback = await Promise.all(cookies.map(cookie => fetch(origin + path, {headers: {cookie}})));
  assert.deepEqual(playback.map(response => response.status), [200, 200]);
  for (let i = 0; i < playback.length; i++) {
    const ticket = await playback[i].json();
    const response = await fetch(origin + ticket.url, {headers: {cookie: cookies[i]}});
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'sample fixture bytes');
  }
  for (const [endpoint, method] of [['/auth/register', 'POST'], ['/billing', 'GET'],
    ['/billing/checkout', 'POST'], ['/billing/cancel', 'POST'], ['/billing/webhook', 'POST'], ['/streams/acquire', 'POST']]) {
    const response = await fetch(origin + '/api' + endpoint, {method, headers: {cookie: cookies[0], ...(method === 'POST' ? {'Content-Type': 'application/json'} : {})}, ...(method === 'POST' ? {body: '{}'} : {})});
    assert.equal(response.status, 404, endpoint);
  }
  const tables = instance.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  for (const name of ['subscriptions', 'subscription_payments', 'stream_leases']) assert.ok(!tables.includes(name));
});
