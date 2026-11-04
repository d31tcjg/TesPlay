import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync,readFileSync,utimesSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {retainUiAssets} from '../server/ui-assets.js';
test('deployment retains old public chunks for open tabs, without copying private data',t=>{
 const root=mkdtempSync(join(tmpdir(),'tesplay-ui-assets-')),source=join(root,'build'),data=join(root,'data'),cache=join(data,'ui-assets');t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(source);mkdirSync(data);writeFileSync(join(data,'private.key'),'private');
 writeFileSync(join(source,'page-old.js'),'old chunk');retainUiAssets(source,cache);
 rmSync(join(source,'page-old.js'));writeFileSync(join(source,'page-new.js'),'new chunk');retainUiAssets(source,cache);
 assert.equal(readFileSync(join(cache,'page-old.js'),'utf8'),'old chunk');assert.equal(readFileSync(join(cache,'page-new.js'),'utf8'),'new chunk');assert.equal(existsSync(join(cache,'private.key')),false);
 const old=(Date.now()-15*86400000)/1000;utimesSync(join(cache,'page-old.js'),old,old);retainUiAssets(source,cache);assert.equal(existsSync(join(cache,'page-old.js')),false);assert.equal(existsSync(join(cache,'page-new.js')),true);
});
