import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import http from 'node:http';
const code=ts.transpileModule(readFileSync(new URL('../src/api.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {api,tesPlayFetch,AccessSessionExpiredError}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));

test('Access expiry is handled without a login redirect, and player cancellation and range headers survive',async t=>{
  const originalFetch=globalThis.fetch,originalLocation=globalThis.location;
  globalThis.location={origin:'https://tesplay.test',href:'https://tesplay.test/'};
  t.after(()=>{globalThis.fetch=originalFetch;if(originalLocation===undefined)delete globalThis.location;else globalThis.location=originalLocation;});
  const controller=new AbortController();let observed;
  globalThis.fetch=async(input,init)=>{observed={input,init};return Response.json({items:[]});};
  await api('/catalog',undefined,undefined,controller.signal);
  assert.equal(observed.init.headers.get('X-Requested-With'),'XMLHttpRequest');
  assert.equal(observed.init.redirect,'manual');assert.equal(observed.init.signal,controller.signal);
  await tesPlayFetch('/api/media/owned',{headers:{Range:'bytes=100-200'},signal:controller.signal});
  assert.equal(observed.init.headers.get('Range'),'bytes=100-200');assert.equal(observed.init.signal,controller.signal);
  await api('/media/owned',{},'DELETE',undefined,true);
  assert.equal(observed.init.method,'DELETE');assert.equal(observed.init.keepalive,true);assert.equal(observed.init.body,'{}');assert.equal(observed.init.headers.get('Content-Type'),'application/json');
  await tesPlayFetch('https://provider.test/movie.mp4',{headers:{Accept:'video/mp4'},redirect:'error'});
  assert.equal(observed.init.headers['X-Requested-With'],undefined);assert.equal(observed.init.redirect,'error');
  globalThis.fetch=async()=>new Response('Access session expired',{status:401,headers:{'Content-Type':'text/html'}});
  await assert.rejects(api('/catalog'),AccessSessionExpiredError);
  globalThis.fetch=async()=>({type:'opaqueredirect',status:0,headers:new Headers()});
  await assert.rejects(api('/catalog'),AccessSessionExpiredError);
  globalThis.fetch=async()=>Response.json({error:'Sign in to continue.'},{status:401});
  await assert.rejects(api('/catalog'),/Sign in to continue/);
  globalThis.fetch=async()=>new Response('<html>Unexpected login page</html>',{headers:{'Content-Type':'text/html'}});
  await assert.rejects(api('/catalog'),/unreadable response/);
});

test('non-JSON gateway failures report the server problem while JSON errors retain their message',async t=>{
  const originalFetch=globalThis.fetch,originalLocation=globalThis.location;
  globalThis.location={origin:'https://tesplay.test',href:'https://tesplay.test/'};
  t.after(()=>{globalThis.fetch=originalFetch;if(originalLocation===undefined)delete globalThis.location;else globalThis.location=originalLocation;});
  for(const status of [502,503,504]){
    globalThis.fetch=async()=>new Response('<html>private upstream details</html>',{status,headers:{'Content-Type':'text/html'}});
    await assert.rejects(api('/playback'),error=>error.message.includes(`(${status})`)&&error.message.includes('try again')&&!/sign in|private upstream/.test(error.message));
  }
  globalThis.fetch=async()=>Response.json({error:'This YouTube video is not available for TesPlayer playback.'},{status:502});
  await assert.rejects(api('/playback'),/This YouTube video is not available/);
});

test('the Access-aware player fetch still cancels a media body after receiving its headers',async t=>{
  const originalLocation=globalThis.location;
  const server=http.createServer((req,res)=>{
    assert.equal(req.headers['x-requested-with'],'XMLHttpRequest');assert.equal(req.headers.range,'bytes=0-');
    res.writeHead(206,{'Content-Type':'video/mp4'});res.write('media');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;globalThis.location={origin,href:origin+'/'};
  t.after(async()=>{if(originalLocation===undefined)delete globalThis.location;else globalThis.location=originalLocation;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const controller=new AbortController(),response=await tesPlayFetch(origin+'/api/media/owned',{headers:{Range:'bytes=0-'},signal:controller.signal}),reader=response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value),'media');controller.abort();
  await assert.rejects(reader.read(),{name:'AbortError'});
});
