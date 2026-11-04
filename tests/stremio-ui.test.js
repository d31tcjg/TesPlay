import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
async function module(name){const source=ts.transpileModule(await readFile(new URL(`../src/${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));}
const {loadHomeConnection}=await module('home-library');
const {unifiedShelves}=await module('library-browser');
const {searchConnection}=await module('global-search');
const connection={id:'stremio',type:'stremio',name:'Stremio',configured:true};
const catalogs=[{id:'films',name:'Catalog · Movies',type:'movie'},{id:'shows',name:'Catalog · Series',type:'series'}];

test('Stremio Home uses selected catalogs, keeps healthy shelves and supplies their navigation categories',async()=>{
  const result=await loadHomeConnection(connection,async path=>{
    if(path.endsWith('/catalogs'))return{catalogs};
    const p=new URL(path,'https://test.example').searchParams;
    if(p.get('category')==='shows')throw Error('Series unavailable');
    assert.equal(p.get('limit'),'12');return{items:[{id:'movie',type:'movie',connectionId:'stremio'}]};
  },new AbortController().signal);
  assert.equal(result.shelves.length,1);assert.equal(result.shelves[0].category,'films');assert.match(result.issues[0],/Series unavailable/);
});

test('Stremio unified shelves preserve catalog selection for View all and skip live TV',async()=>{
  const paths=[];
  const rows=await unifiedShelves(connection,'movies',async path=>{paths.push(path);if(path.includes('/catalogs'))return{catalogs:[catalogs[0]]};return{items:[{id:'movie',type:'movie'}]};},new AbortController().signal);
  assert.equal(rows[0].category,'films');assert.equal(rows[0].kind,'movie');assert.match(paths[1],/category=films/);
  assert.deepEqual(await unifiedShelves(connection,'live',()=>{throw Error('No live catalogs should be requested');},new AbortController().signal),[]);
});

test('Stremio global search separates catalog groups so movies and series can paginate independently',async()=>{
  const rows=await searchConnection(connection,'A & B',async path=>{
    if(path.includes('/catalogs?search=1'))return{catalogs};
    const p=new URL(path,'https://test.example').searchParams;assert.equal(p.get('q'),'A & B');
    return{items:[{id:p.get('kind'),type:p.get('kind')}],hasMore:true};
  },new AbortController().signal);
  assert.equal(rows.length,2);assert.notEqual(rows[0].id,rows[1].id);assert.equal(rows[0].hasMore,true);
  assert.match(rows[0].path,/category=films/);assert.match(rows[1].path,/category=shows/);
});
