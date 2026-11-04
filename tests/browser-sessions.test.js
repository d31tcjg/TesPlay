import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/index.js';
const password='browser fixture password';
async function fixture(t) {
  const dataDir=await mkdtemp(join(tmpdir(),'tesplay-browsers-'));
  let instance,server;
  const start=async()=>{instance=await createApp({dataDir,setupToken:'browser-test-setup',registerProviders:false,quiet:true});server=instance.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));};
  await start();
  const client=(userAgent='Chrome/130 Tesla')=>{
    let cookie='';
    const request=async(path,body,method=body===undefined?'GET':'POST')=>{
      const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{cookie,'User-Agent':userAgent,...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
      if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
      return{status:response.status,data:await response.json()};
    };
    request.cookie=()=>cookie;return request;
  };
  const host=client();await host('/api/auth/setup',{name:'Fixture owner',username:'fixture_owner',password,setupToken:'browser-test-setup'});
  t.after(async()=>{instance.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dataDir,{recursive:true,force:true});});
  return{host,client,get store(){return instance.store;},get base(){return `http://127.0.0.1:${server.address().port}`;},restart:async()=>{instance.close();server.closeAllConnections();await new Promise(r=>server.close(r));await start();}};
}
const login=phone=>phone('/api/auth/login',{username:'fixture_owner',password});
const pair=async f=>(await f.host('/api/remote/pair',{})).data;

test('only the host can disconnect its screen; guests and old QR links are revoked while account phones keep their login',async t=>{
  const f=await fixture(t),guest=f.client('Safari/605 iPhone'),account=f.client('Chrome/130 Android');
  const qr=await pair(f);await guest('/api/auth/remote/redeem',{code:qr.code,token:qr.token});
  await login(account);await account('/api/remote/connect',{screenId:qr.roomId});
  const pending=await pair(f);
  assert.equal((await guest('/api/remote/screen/disconnect',{roomId:qr.roomId})).status,403);
  assert.equal((await account('/api/remote/screen/disconnect',{roomId:qr.roomId})).status,403);
  assert.equal((await f.host('/api/remote/state?roomId='+qr.roomId)).data.paired,true);
  const result=await f.host('/api/remote/screen/disconnect',{roomId:qr.roomId});
  assert.equal(result.status,200);assert.notEqual(result.data.roomId,qr.roomId);
  assert.equal((await guest('/api/auth/status')).data.user,null);
  const accountAuth=(await account('/api/auth/status')).data;
  assert.ok(accountAuth.user);assert.equal(accountAuth.deviceMode,'browser');assert.equal(accountAuth.remoteRoomId,null);
  assert.equal((await account('/api/remote/command',{roomId:qr.roomId,command:'play'})).status,404);
  assert.equal((await f.client()('/api/auth/remote/redeem',{code:pending.code,token:pending.token})).status,410);
  assert.equal((await f.host('/api/remote/state?roomId='+result.data.roomId)).data.paired,false);
  const fresh=await pair(f);
  assert.equal((await guest('/api/auth/remote/redeem',{code:fresh.code,token:fresh.token})).status,200);
  assert.equal((await f.host('/api/remote/state?roomId='+fresh.roomId)).data.paired,true);
  await guest('/api/auth/logout',{});
  assert.equal((await f.host('/api/remote/state?roomId='+fresh.roomId)).data.paired,false);
});

test('fresh phone redeems a single-use QR without credentials, inherits the screen profile and stays remote-only',async t=>{
  const f=await fixture(t),phone=f.client('Safari/605 iPhone');
  const profile=(await f.host('/api/profiles',{name:'Cinema'})).data.profiles.at(-1);
  await f.host(`/api/profiles/${profile.id}/select`,{});
  const qr=await pair(f);
  assert.equal((await phone('/api/auth/remote/redeem',{code:qr.code,token:'x'.repeat(43)})).status,410);
  const redeemed=await phone('/api/auth/remote/redeem',{code:qr.code,token:qr.token});
  assert.equal(redeemed.status,200);assert.equal(redeemed.data.scope,'remote');assert.equal(redeemed.data.deviceMode,'remote');assert.equal(redeemed.data.remoteRoomId,qr.roomId);assert.equal(redeemed.data.activeProfileId,profile.id);assert.equal(redeemed.data.profiles.length,1);
  assert.equal((await f.client()('/api/auth/remote/redeem',{code:qr.code,token:qr.token})).status,410);
  for(const endpoint of ['/api/accounts','/api/browsers','/api/playback?itemId=film','/api/remote/screens'])assert.equal((await phone(endpoint)).status,403);
  assert.equal((await phone('/api/remote/pair',{})).status,403);
  assert.equal((await phone('/api/profiles',{name:'Unauthorized'})).status,403);
  assert.equal((await phone('/api/library/state')).status,200);
  assert.equal((await phone('/api/remote/state?roomId='+qr.roomId)).status,200);
  const abort=new AbortController();t.after(()=>abort.abort());
  const stream=await fetch(f.base+'/api/remote/events?roomId='+qr.roomId,{headers:{cookie:f.host.cookie()},signal:abort.signal});
  const reader=stream.body.getReader();await reader.read();
  assert.equal((await phone('/api/remote/command',{roomId:qr.roomId,command:'volume',value:.4})).status,200);
  assert.match(new TextDecoder().decode((await reader.read()).value),/"value":0.4/);abort.abort();await reader.cancel().catch(()=>{});
});

test('a remote QR cannot grant a full account sign-in to another browser',async t=>{
  const f=await fixture(t),phone=f.client(),qr=await pair(f);await phone('/api/auth/remote/redeem',{code:qr.code,token:qr.token});
  const screen=f.client(),signin=(await screen('/api/auth/qr/init',{})).data;
  const token=new URLSearchParams(new URL(signin.verificationUrl).hash.slice(1)).get('token');
  assert.equal((await phone('/api/auth/qr/details',{id:signin.id,token})).status,403);
  assert.equal((await phone('/api/auth/qr/approve',{id:signin.id,token})).status,403);
  assert.equal((await screen('/api/auth/qr/poll',{id:signin.id})).data.status,'pending');
});

test('QR replacement invalidates the old challenge and a screen cannot redeem its own QR',async t=>{
  const f=await fixture(t),old=await pair(f),fresh=await pair(f),phone=f.client();
  assert.equal(old.roomId,fresh.roomId);
  assert.equal((await phone('/api/auth/remote/redeem',{code:old.code,token:old.token})).status,410);
  assert.equal((await f.host('/api/auth/remote/redeem',{code:fresh.code,token:fresh.token})).status,409);
  assert.equal((await phone('/api/auth/remote/redeem',{code:fresh.code,token:fresh.token})).status,200);
});

test('same-account connection needs no QR, aligns profiles and remembers remote mode across restart',async t=>{
  const f=await fixture(t),phone=f.client('Safari/605 iPhone');await login(phone);
  const profile=(await f.host('/api/profiles',{name:'Second'})).data.profiles.at(-1);await f.host(`/api/profiles/${profile.id}/select`,{});
  const screen=(await f.host('/api/remote/screen',{})).data;
  const discovered=(await phone('/api/remote/screens')).data.screens;assert.equal(discovered.length,1);assert.equal(discovered[0].id,screen.roomId);
  const connected=await phone('/api/remote/connect',{screenId:screen.roomId});assert.equal(connected.status,200);assert.equal(connected.data.scope,'full');assert.equal(connected.data.activeProfileId,profile.id);
  await f.restart();
  const auth=(await phone('/api/auth/status')).data;assert.equal(auth.deviceMode,'remote');assert.equal(auth.remoteRoomId,screen.roomId);assert.equal(auth.activeProfileId,profile.id);
  assert.equal((await f.host('/api/remote/screen',{})).data.roomId,screen.roomId);
  assert.equal((await phone('/api/remote/state?roomId='+screen.roomId)).status,200);
  const disconnected=(await phone('/api/remote/disconnect',{})).data;assert.equal(disconnected.deviceMode,'browser');assert.equal(disconnected.remoteRoomId,null);assert.notEqual(disconnected.activeProfileId,profile.id);
});

test('browser table is account-private; removing a screen revokes its QR remotes and outstanding QR links',async t=>{
  const f=await fixture(t),phone=f.client('Safari/605 iPhone'),qr=await pair(f);await phone('/api/auth/remote/redeem',{code:qr.code,token:qr.token});
  const pending=await pair(f),other=f.client();
  await f.host('/api/accounts',{name:'Other',username:'other_user',password,grants:[]});await other('/api/auth/login',{username:'other_user',password});
  const table=(await f.host('/api/browsers')).data.browsers,host=table.find(b=>b.current),remote=table.find(b=>b.scope==='remote');
  assert.equal(host.name,'Chrome on Tesla');assert.equal(host.role,'screen');assert.equal(remote.name,'Safari on iPhone');assert.equal(remote.role,'remote');assert.equal(remote.screen,'Chrome on Tesla');
  assert.ok(host.lastSeen);assert.ok(host.authorizedAt);assert.ok(!JSON.stringify(table).includes('token_hash'));assert.ok(!JSON.stringify(table).includes('password'));
  const otherList=(await other('/api/browsers')).data.browsers;assert.equal(otherList.length,1);
  assert.equal((await other('/api/browsers/'+host.id,{},'DELETE')).status,404);
  assert.equal((await other('/api/remote/connect',{screenId:qr.roomId})).status,404);
  assert.equal((await f.host('/api/browsers/'+host.id,{},'DELETE')).data.current,true);
  assert.equal((await f.host('/api/auth/status')).data.user,null);assert.equal((await phone('/api/auth/status')).data.user,null);assert.equal((await phone('/api/library/state')).status,401);
  assert.equal((await f.client()('/api/auth/remote/redeem',{code:pending.code,token:pending.token})).status,410);
});

test('revoking one phone preserves its screen and other remotes; authorizations survive server restart',async t=>{
  const f=await fixture(t),phone=f.client('Safari/605 iPhone'),other=f.client('Firefox/131 Android');
  for(const remote of [phone,other]){const qr=await pair(f);assert.equal((await remote('/api/auth/remote/redeem',{code:qr.code,token:qr.token})).status,200);}
  await f.restart();assert.equal((await phone('/api/auth/status')).data.scope,'remote');
  const browsers=(await f.host('/api/browsers')).data.browsers,authorization=browsers.find(b=>b.name==='Safari on iPhone');
  assert.equal((await f.host('/api/browsers/'+authorization.id,{},'DELETE')).status,200);
  assert.equal((await phone('/api/auth/status')).data.user,null);assert.ok((await other('/api/auth/status')).data.user);assert.ok((await f.host('/api/auth/status')).data.user);
  assert.equal((await f.host('/api/browsers')).data.browsers.length,2);
});

test('changing the screen profile invalidates existing guest remotes and never mutates an invalid selection',async t=>{
  const f=await fixture(t),phone=f.client(),qr=await pair(f);await phone('/api/auth/remote/redeem',{code:qr.code,token:qr.token});
  assert.equal((await f.host('/api/profiles/nonexistent/select',{})).status,404);assert.ok((await phone('/api/auth/status')).data.user);
  const profile=(await f.host('/api/profiles',{name:'New'})).data.profiles.at(-1);await f.host('/api/profiles/'+profile.id+'/select',{});
  assert.equal((await phone('/api/auth/status')).data.user,null);
  assert.notEqual((await f.host('/api/remote/screen',{})).data.roomId,qr.roomId);
});
