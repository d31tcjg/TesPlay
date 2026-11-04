import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../src/playback-buffer-limits.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {playbackBufferLimits}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('Tesla decoder budgets limit retained frame memory while keeping ordinary browser buffering intact',()=>{
  const car=playbackBufferLimits('Mozilla/5.0 (X11; Linux x86_64) Tesla/2026.32 Chrome/130'),desktop=playbackBufferLimits('Mozilla/5.0 Macintosh Chrome/130 Safari/537.36');
  // A single 1080p RGBA frame consumes about 8 MB before decoder overhead.
  const frameBytes=1920*1080*4;
  assert.ok(car.maxVideoFrames*frameBytes<80*1024*1024);
  assert.ok(car.maxVideoFrames*3<=desktop.maxVideoFrames);
  assert.equal(desktop.maxVideoFrames,24);
  assert.ok(car.maxAudioSeconds>0);assert.ok(car.decodeLookaheadMs>=1000);
  assert.deepEqual(playbackBufferLimits('QtCarBrowser/5.0'),car);
});

const dialogCode=ts.transpileModule(readFileSync(new URL('../src/retain-player-dialog.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {retainPlayerDialog}=await import('data:text/javascript;base64,'+Buffer.from(dialogCode).toString('base64'));
test('hiding preserves the page; returning restores a lost native dialog without reopening an already-open player',()=>{
  const page=new EventTarget(),viewport=new EventTarget();page.visibilityState='visible';
  let shown=0,closed=0;const dialog={open:false,isConnected:true,showModal(){this.open=true;shown++;},close(){this.open=false;closed++;}};
  const release=retainPlayerDialog(dialog,page,viewport);assert.equal(shown,1);
  page.visibilityState='hidden';page.dispatchEvent(new Event('visibilitychange'));assert.equal(closed,0);assert.equal(dialog.open,true);
  // Model a browser dropping only its native modal state while the page stays mounted.
  dialog.open=false;page.dispatchEvent(new Event('resume'));assert.equal(shown,1);
  page.visibilityState='visible';viewport.dispatchEvent(new Event('pageshow'));assert.equal(shown,2);assert.equal(dialog.open,true);
  page.dispatchEvent(new Event('visibilitychange'));page.dispatchEvent(new Event('resume'));assert.equal(shown,2);
  dialog.open=false;dialog.isConnected=false;page.dispatchEvent(new Event('resume'));assert.equal(shown,2);
  release();assert.equal(closed,1);dialog.isConnected=true;viewport.dispatchEvent(new Event('pageshow'));assert.equal(shown,2);
});
