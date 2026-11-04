import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {requestRemote} from '../server/media.js';

test('playlist probes do not truncate manifests and pooled playback transports do not retain every past resource',async()=>{
  const {default:express}=await import('express');const {createMediaService}=await import('../server/media.js');
  let playlistRange,maxCloseListeners=0;const sockets=new Set();
  const provider=http.createServer((req,res)=>{
    if(req.url==='/playlist.m3u8'){playlistRange=req.headers.range;res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl'});res.end('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n/frame.ts\n#EXT-X-ENDLIST\n');}
    else {res.writeHead(200,{'Content-Type':'video/mp2t'});res.end('segment');}
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));const original=http.request;
  http.request=(_url,options,callback)=>original(new URL(`http://127.0.0.1:${provider.address().port}${_url.pathname}`),{...options,lookup:undefined},response=>{sockets.add(response.socket);maxCloseListeners=Math.max(maxCloseListeners,response.socket.listenerCount('close'));callback(response);});
  const service=createMediaService({getProfileId:()=> 'profile',getConnection:()=>null}),app=express();app.use((req,_res,next)=>{req.user={id:'viewer'};next();});app.get('/api/media/:token',service.handler);app.delete('/api/media/:token',service.releaseHandler);app.use((e,_req,res,_next)=>res.status(e.status||500).end());
  const viewer=app.listen(0,'127.0.0.1');await new Promise(resolve=>viewer.once('listening',resolve));const base=`http://127.0.0.1:${viewer.address().port}`,req={user:{id:'viewer'}};
  try{
    const manifest=service.register(req,null,{url:'http://203.0.113.15/playlist.m3u8',kind:'hls'});
    const probe=await fetch(base+manifest,{headers:{Range:'bytes=0-1'}});assert.equal(probe.status,200);assert.match(await probe.text(),/^#EXTM3U/);assert.equal(playlistRange,undefined);
    let latest;
    for(let i=0;i<40;i++){latest=service.register(req,null,{url:'http://203.0.113.15/frame.ts',kind:'video'});assert.equal(await(await fetch(base+latest)).text(),'segment');}
    assert.ok(sockets.size<=2,'sequential resources must reuse the provider connection');assert.ok(maxCloseListeners<=10,'reusing a socket must not accumulate cleanup listeners');
    assert.equal((await fetch(base+latest,{method:'DELETE'})).status,200);assert.equal((await fetch(base+latest)).status,404);
  }finally{http.request=original;provider.closeAllConnections();viewer.closeAllConnections();await Promise.all([new Promise(resolve=>provider.close(resolve)),new Promise(resolve=>viewer.close(resolve))]);}
});

test('unavailable artwork has a private placeholder while denied viewers and failed video streams still receive errors', async () => {
  const {default:express}=await import('express');const {createMediaService}=await import('../server/media.js');
  const ctx={getProfileId:()=> 'profile',getConnection:()=>null,
    sealMedia:value=>Buffer.from(JSON.stringify(value)).toString('base64url'),openMedia:token=>JSON.parse(Buffer.from(token,'base64url').toString())};
  const service=createMediaService(ctx),app=express();
  app.use((req,_res,next)=>{req.user={id:req.headers['x-viewer']||'viewer'};next();});app.get('/api/media/:token',service.handler);
  app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:error.message}));
  const viewer=app.listen(0,'127.0.0.1');await new Promise(resolve=>viewer.once('listening',resolve));
  const req={user:{id:'viewer'}},base=`http://127.0.0.1:${viewer.address().port}`;
  const image=service.register(req,null,{url:'https://unavailable-artwork.invalid/private-fixture-token',kind:'artwork'});
  const video=service.register(req,null,{url:'https://unavailable-artwork.invalid/private-fixture-token',kind:'direct-file'});
  try {
    const response=await fetch(base+image);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/image\/svg\+xml/);
    assert.equal(response.headers.get('x-tesplay-artwork'),'unavailable');assert.equal(response.headers.get('cache-control'),'private, max-age=300');
    assert.ok(!(await response.text()).includes('private-fixture-token'));
    assert.equal((await fetch(base+image,{headers:{'x-viewer':'another-viewer'}})).status,404);
    const failed=await fetch(base+video);assert.equal(failed.status,502);const error=await failed.text();assert.match(error,/could not be resolved/);assert.ok(!error.includes('private-fixture-token'));
  } finally {viewer.closeAllConnections();await new Promise(resolve=>viewer.close(resolve));}
});

test('provider requests close when the viewer leaves before headers or during a live response', async () => {
  const server=http.createServer((request,response)=>{
    if(request.url==='/live'){response.writeHead(200,{'Content-Type':'video/mp2t'});response.write('stream');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const original=http.request;
  // Keep DNS/address validation intact; route the transport to this owned server.
  http.request=(_url,options,callback)=>original(new URL(`http://127.0.0.1:${server.address().port}${_url.pathname}`),{...options,agent:false,lookup:undefined},callback);
  try {
    const beforeHeaders=new AbortController();
    const pending=requestRemote('http://203.0.113.10/wait',{signal:beforeHeaders.signal});
    const rejected=assert.rejects(pending,{status:502});
    await new Promise(resolve=>setTimeout(resolve,30));beforeHeaders.abort();await rejected;
    const duringBody=new AbortController();
    const response=await requestRemote('http://203.0.113.10/live',{signal:duringBody.signal});
    const closed=new Promise(resolve=>response.once('close',resolve));
    duringBody.abort();
    let timer;
    try {await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Live provider connection was not released')),1000);})]);}
    finally {clearTimeout(timer);}
    assert.equal(response.destroyed,true);
    const alreadyGone=new AbortController();alreadyGone.abort();
    await assert.rejects(requestRemote('http://203.0.113.10/live',{signal:alreadyGone.signal}),{name:'AbortError'});
  } finally {http.request=original;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('live playlist refreshes reuse the redirected session and never resend credentials across origins', async () => {
  const {default:express}=await import('express');
  const {createMediaService}=await import('../server/media.js');
  let starts=0,refreshes=0,retireRedirect=false,segmentAttempts=0,deniedAttempts=0;const observed=[],signals=[],transports=[];
  const provider=http.createServer((request,response)=>{
    if(request.url==='/denied.ts'){deniedAttempts++;response.writeHead(403,{'Content-Type':'text/html'});response.end('Permission denied');}
    else if(request.url==='/start.m3u8'){starts++;response.writeHead(302,{Location:'http://203.0.113.11/channel.m3u8'});response.end();}

    else if(request.url.startsWith('/segment-')){segmentAttempts++;observed.push(request.headers.authorization);response.writeHead(200,{'Content-Type':'video/mp2t'});response.end('live segment');}
    else if(retireRedirect){retireRedirect=false;response.writeHead(200,{'Content-Type':'text/html'});response.end('Session token retired');}
    else {refreshes++;observed.push(request.headers.authorization);response.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl'});response.end(`#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:${refreshes}\n#EXTINF:4,\nsegment-${refreshes}.ts\n`);}
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const original=http.request;
  http.request=(_url,options,callback)=>{signals.push(options.signal);return original(new URL(`http://127.0.0.1:${provider.address().port}${_url.pathname}`),{...options,lookup:undefined},response=>{transports.push(response.socket);callback(response);});};
  const connection={id:'iptv',type:'xtream',config:{}};
  const service=createMediaService({getProfileId:request=>request.headers?.['x-profile']||'profile',getConnection:()=>connection});
  const app=express();app.use((request,_response,next)=>{request.user={id:request.headers['x-viewer']||'viewer'};next();});app.get('/api/media/:token',service.handler);app.delete('/api/media/:token',service.releaseHandler);app.use((error,_request,response,_next)=>response.status(error.status||500).json({error:'Test error'}));
  const viewer=app.listen(0,'127.0.0.1');await new Promise(resolve=>viewer.once('listening',resolve));
  const ticket=service.register({user:{id:'viewer'}},connection,{url:'http://203.0.113.10/start.m3u8',kind:'hls',headers:{Authorization:'private-fixture-token'}});
  try {
    let lastPlaylist='';for(let i=1;i<=3;i++){if(i>1)await new Promise(resolve=>setTimeout(resolve,1050));const response=await fetch(`http://127.0.0.1:${viewer.address().port}${ticket}`);assert.equal(response.status,200);lastPlaylist=await response.text();assert.match(lastPlaylist,new RegExp(`#EXT-X-MEDIA-SEQUENCE:${i}`));}
    const inspected=await fetch(`http://127.0.0.1:${viewer.address().port}${ticket}`);assert.equal(await inspected.text(),lastPlaylist);assert.equal(refreshes,3,'decoder startup must reuse the inspected playlist');
    const segment=lastPlaylist.split('\n').find(line=>line.startsWith('/api/media/'));assert.equal(await (await fetch(`http://127.0.0.1:${viewer.address().port}${segment}`)).text(),'live segment');
    assert.equal(segmentAttempts,1);
    assert.ok(signals.every(signal=>!signal.aborted),'completed playlist responses must retain their provider session');assert.equal(starts,1,'refreshes must not restart the provider HLS session');assert.equal(refreshes,3);assert.deepEqual(observed,[undefined,undefined,undefined,undefined]);
    await new Promise(resolve=>setTimeout(resolve,1050));retireRedirect=true;
    const renewed=await fetch(`http://127.0.0.1:${viewer.address().port}${ticket}`);assert.equal(renewed.status,200);assert.match(await renewed.text(),/#EXT-X-MEDIA-SEQUENCE:4/);assert.equal(starts,2,'an expired redirect must renew through the original authenticated entry only once');assert.equal(observed.at(-1),undefined,'renewal must retain the cross-origin credential boundary');
    const denied=service.register({user:{id:'viewer'}},connection,{url:'http://203.0.113.11/denied.ts',hlsChild:true});
    assert.equal((await fetch(`http://127.0.0.1:${viewer.address().port}${denied}`)).status,502);assert.equal(deniedAttempts,3,'a persistent rejection must stop after the bounded attempts');await fetch(`http://127.0.0.1:${viewer.address().port}${denied}`,{method:'DELETE'});
    const root=`http://127.0.0.1:${viewer.address().port}${ticket}`;
    assert.equal((await fetch(root,{method:'DELETE',headers:{'x-viewer':'another-user'}})).status,403);
    assert.equal((await fetch(root,{method:'DELETE',headers:{'x-profile':'another-profile'}})).status,403);
    const other=service.register({user:{id:'another-user'}},connection,{url:'http://203.0.113.11/channel.m3u8',kind:'hls'});
    assert.equal((await fetch(`http://127.0.0.1:${viewer.address().port}${other}`,{headers:{'x-viewer':'another-user'}})).status,200);
    const otherSocket=transports.at(-1);
    assert.equal((await fetch(root,{method:'DELETE'})).status,200);
    assert.equal(transports[0].destroyed,true,'release must also close the entry redirect’s idle connection');
    assert.equal(otherSocket.destroyed,false,'releasing one viewer must keep another viewer’s pooled connection');
    assert.equal((await fetch(root)).status,404);
    assert.equal((await fetch(`http://127.0.0.1:${viewer.address().port}${segment}`)).status,404);
    assert.equal((await fetch(root,{method:'DELETE'})).status,200);
  } finally {http.request=original;provider.closeAllConnections();viewer.closeAllConnections();await Promise.all([new Promise(resolve=>provider.close(resolve)),new Promise(resolve=>viewer.close(resolve))]);}
});

test('leaving the player cancels the provider even while its response headers are pending', async () => {
  const {default:express}=await import('express');const {createMediaService}=await import('../server/media.js');
  let arrived,closed;
  const received=new Promise(resolve=>{arrived=resolve;}),released=new Promise(resolve=>{closed=resolve;});
  const provider=http.createServer(request=>{request.socket.once('close',closed);arrived();});
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));const original=http.request;
  http.request=(_url,options,callback)=>original(new URL(`http://127.0.0.1:${provider.address().port}/wait`),{...options,agent:false,lookup:undefined},callback);
  const service=createMediaService({getProfileId:()=> 'profile',getConnection:()=>null});const app=express();
  app.use((request,_response,next)=>{request.user={id:'viewer'};next();});app.get('/api/media/:token',service.handler);app.use((_error,_request,response,_next)=>{if(!response.destroyed)response.sendStatus(502);});
  const viewer=app.listen(0,'127.0.0.1');await new Promise(resolve=>viewer.once('listening',resolve));
  const ticket=service.register({user:{id:'viewer'}},null,{url:'http://203.0.113.10/wait'});
  const controller=new AbortController();let timer;
  try {
    const pending=fetch(`http://127.0.0.1:${viewer.address().port}${ticket}`,{signal:controller.signal});const cancelled=assert.rejects(pending,{name:'AbortError'});
    await received;controller.abort();await cancelled;
    await Promise.race([released,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Abandoned viewer kept the IPTV provider request open')),1000);})]);
  } finally {clearTimeout(timer);http.request=original;provider.closeAllConnections();viewer.closeAllConnections();await Promise.all([new Promise(resolve=>provider.close(resolve)),new Promise(resolve=>viewer.close(resolve))]);}
});

test('an expired Xtream segment token renews the exact sequence through its owned playlist', async () => {
  const {default:express}=await import('express');const {createMediaService}=await import('../server/media.js');
  let entries=0,denied=0;const credentials=[];
  const provider=http.createServer((request,response)=>{
    if(request.url==='/start.m3u8'){entries++;response.writeHead(302,{Location:'http://203.0.113.11/channel.m3u8'});response.end();}
    else if(request.url==='/channel.m3u8'){credentials.push(request.headers.authorization);response.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl'});response.end(`#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:10,\n/${entries===1?'old/encrypted-old':'new/encrypted-renewed'}.ts\n#EXTINF:10,\n/new/channel_8.ts\n`);}
    else if(request.url==='/old/encrypted-old.ts'){denied++;response.writeHead(403);response.end();}
    else if(request.url==='/new/encrypted-renewed.ts'){credentials.push(request.headers.authorization);response.writeHead(200,{'Content-Type':'video/mp2t'});response.end('exact original sequence');}
    else {response.writeHead(500);response.end('Wrong sequence');}
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));const original=http.request;
  http.request=(_url,options,callback)=>original(new URL(`http://127.0.0.1:${provider.address().port}${_url.pathname}`),{...options,agent:false,lookup:undefined},callback);
  const connection={id:'iptv',type:'xtream',config:{}},service=createMediaService({getProfileId:()=> 'profile',getConnection:()=>connection});
  const app=express();app.use((request,_response,next)=>{request.user={id:'viewer'};next();});app.get('/api/media/:token',service.handler);app.use((error,_request,response,_next)=>response.status(error.status||500).json({error:'Test error'}));
  const viewer=app.listen(0,'127.0.0.1');await new Promise(resolve=>viewer.once('listening',resolve));
  const ticket=service.register({user:{id:'viewer'}},connection,{url:'http://203.0.113.10/start.m3u8',kind:'hls',headers:{Authorization:'private-fixture-token'}});
  try {
    const playlist=await (await fetch(`http://127.0.0.1:${viewer.address().port}${ticket}`)).text();const segment=playlist.split('\n').find(line=>line.startsWith('/api/media/'));
    const response=await fetch(`http://127.0.0.1:${viewer.address().port}${segment}`);assert.equal(response.status,200);assert.equal(await response.text(),'exact original sequence');
    assert.equal(entries,2);assert.equal(denied,1);assert.deepEqual(credentials,[undefined,undefined,undefined]);
  } finally {http.request=original;provider.closeAllConnections();viewer.closeAllConnections();await Promise.all([new Promise(resolve=>provider.close(resolve)),new Promise(resolve=>viewer.close(resolve))]);}
});
