import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/index.js';

test('production HTML has fresh matching script nonces, permits player workers and analytics, and keeps inline scripts restricted',async t=>{
  const root=await mkdtemp(join(tmpdir(),'tesplay-csp-')),distDir=join(root,'dist');
  await mkdir(distDir);await writeFile(join(distDir,'index.html'),'<html><script type="module" src="/assets/app.js"></script></html>');
  const instance=await createApp({dataDir:join(root,'data'),distDir,production:true,publicUrl:'https://tesplay.test',registerProviders:false,quiet:true});
  const server=instance.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));instance.close();await rm(root,{recursive:true,force:true});});
  const nonces=[];
  for(const path of ['/','/index.html','/movies']){
    const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`),policy=response.headers.get('content-security-policy'),html=await response.text();
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    const nonce=policy.match(/'nonce-([^']+)'/)[1];nonces.push(nonce);assert.match(html,new RegExp(`<script nonce="${nonce}" type="module"`));
    const directives=Object.fromEntries(policy.split(';').map(value=>{const [name,...sources]=value.trim().split(/\s+/);return[name,sources];}));
    assert.ok(directives['script-src'].includes('blob:'));assert.ok(directives['worker-src'].includes('blob:'));
    assert.ok(directives['script-src'].includes('https://static.cloudflareinsights.com'));
    assert.ok(!directives['script-src'].includes("'unsafe-inline'"));
    assert.deepEqual(directives['frame-src'],["'none'"]);
  }
  assert.equal(new Set(nonces).size,nonces.length);
});
