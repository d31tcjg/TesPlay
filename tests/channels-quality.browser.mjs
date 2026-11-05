// Synthetic real-browser check: render the actual editor and submit native FormData.
// Run: node tests/channels-quality.browser.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
const scratch = process.env.TMPDIR;
if (!scratch) throw new Error('Set TMPDIR to a scratch directory');
const profile = await mkdtemp(join(scratch,'channels-quality-chrome-'));
const bundle = await build({stdin:{contents:`
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {flushSync} from 'react-dom';
  import Editor from './src/ConnectionEditor';
  const root=createRoot(document.getElementById('root'));
  window.renderEditor=(adding,editConfig={},editing=null)=>flushSync(()=>root.render(<Editor key={adding+JSON.stringify(editConfig)}
    adding={adding} editConfig={editConfig} editing={editing} configuredFields={editing?['url']:[]}
    preview={false} busy={false} error="" notice="" publicUrl="https://synthetic.invalid" plexPin={null}
    onClose={()=>{}} onSignIn={()=>{}} onPhoneSetup={()=>{}} onTypeChange={()=>{}}
    onSubmit={async event=>{event.preventDefault();window.saved=Object.fromEntries(new FormData(event.currentTarget));}}
    startPlex={async()=>{}} checkPlex={async()=>{}}/>));
  window.renderEditor('channels');
`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},logLevel:'silent'});
const server = http.createServer((req,res)=>{
  if(req.url==='/bundle.js') {res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);}
  else {res.setHeader('Content-Type','text/html');res.end('<!doctype html><div id="root"></div><script src="/bundle.js"></script>');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const chrome=spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
  '--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','about:blank',
],{stdio:'ignore'});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let ws;
try {
  let port;
  for(let i=0;i<100&&!port;i++) {port=await readFile(join(profile,'DevToolsActivePort'),'utf8').then(x=>x.split('\n')[0]).catch(()=>null);if(!port)await delay(100);}
  assert.ok(port,'Chrome started');
  const targets=await fetch(`http://127.0.0.1:${port}/json`).then(r=>r.json());
  ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  let id=0;const pending=new Map();
  ws.onmessage=e=>{const message=JSON.parse(e.data);if(message.id){pending.get(message.id)?.(message);pending.delete(message.id);}};
  async function send(method,params={}) {const result=await new Promise(resolve=>{const n=++id;pending.set(n,resolve);ws.send(JSON.stringify({id:n,method,params}));});assert.ok(!result.error,JSON.stringify(result.error));return result.result;}
  async function evaluate(expression) {const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.ok(!result.exceptionDetails,JSON.stringify(result.exceptionDetails));return result.result.value;}
  await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}`});
  for(let i=0;i<100;i++) {if(await evaluate(`!!document.querySelector('select[name=maxQuality]')`))break;await delay(50);}
  assert.equal(await evaluate(`document.querySelector('select[name=maxQuality]').value`),'original');
  const saved=await evaluate(`(()=>{const form=document.querySelector('form');form.elements.name.value='Synthetic DVR';form.elements.url.value='http://192.0.2.10:8089';form.elements.maxQuality.value='2000-720';form.requestSubmit();return window.saved;})()`);
  assert.deepEqual(saved,{name:'Synthetic DVR',url:'http://192.0.2.10:8089',maxQuality:'2000-720'});
  await evaluate(`window.renderEditor('channels',{maxQuality:'4000-720'},{id:'dvr',name:'Synthetic DVR',type:'channels'})`);
  assert.equal(await evaluate(`document.querySelector('select[name=maxQuality]').value`),'4000-720');
  const edited=await evaluate(`(()=>{const form=document.querySelector('form');form.elements.maxQuality.value='2000-720';form.requestSubmit();return window.saved;})()`);
  assert.equal(edited.maxQuality,'2000-720'); assert.equal(edited.url,'');
  for(const type of ['plex','youtube','drive','local','m3u','xtream']) {
    await evaluate(`window.renderEditor(${JSON.stringify(type)},{},{id:'other',name:'Other',type:${JSON.stringify(type)}})`);
    assert.equal(await evaluate(`!!document.querySelector('[name=maxQuality]')`),false,type);
  }
  console.log(JSON.stringify({passed:true,checks:['default original','create FormData saves 2000-720','restore saved cap','edit without URL','absent for six other providers']}));
} finally {
  ws?.close();chrome.kill();await new Promise(resolve=>chrome.exitCode!==null?resolve():chrome.once('exit',resolve));
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(profile,{recursive:true,force:true});
}
