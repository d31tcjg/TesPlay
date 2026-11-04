import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source = ts.transpileModule(fs.readFileSync(new URL('../src/home-library.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { loadHomeConnection, homeFeatures } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const connection = (type, id = type) => ({ id, name: type, type, configured: true });
const item = (id, type = 'movie', c = 'plex') => ({ id, title: id, type, connectionId: c, source: c });
test('IPTV Home bundles account previews, keeps highlights balanced, and skips unselected kinds and stars', async () => {
  const {bundleIptvHomeShelves} = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const first = {...connection('xtream','first'),loadedCategories:['movie:1']}, second = connection('xtream','second');
  const rows = [first,second].map(c => ({id:c.id,connectionId:c.id,title:c.id,kind:'movie',items:[item('same','movie',c.id),item('other','movie',c.id)]}));
  const bundled = bundleIptvHomeShelves(rows,[first,second]);
  assert.equal(bundled.length,1);assert.equal(bundled[0].title,'IPTV · Movies');
  assert.deepEqual(homeFeatures(bundled).map(i=>i.connectionId),['first','second','first','second']);
  const paths=[];
  await loadHomeConnection(first,async path=>{paths.push(path);return{items:[]};},new AbortController().signal,[{connectionId:first.id,kind:'category',id:'live:1',title:'News'}]);
  assert.equal(paths.length,1);assert.equal(new URL(paths[0],'https://tesplay.test').searchParams.get('kind'),'movie');
});
test('Plex home previews expand library sections and retain healthy libraries when another fails', async () => {
  const paths = [];
  const result = await loadHomeConnection(connection('plex'), async path => {
    const p = new URL(path, 'https://tesplay.test').searchParams; paths.push(p);
    assert.equal(p.get('limit'), '12');
    if (!p.get('parentId')) return { items: [item('films', 'folder'), item('shows', 'folder')] };
    if (p.get('parentId') === 'shows') throw Error('Provider unavailable');
    return { items: [item('Actual film')] };
  }, new AbortController().signal);
  assert.equal(paths.length, 3);
  assert.equal(result.shelves[0].items[0].title, 'Actual film');
  assert.equal(result.shelves[0].parent.id, 'films');
  assert.match(result.issues[0], /shows.*Provider unavailable/);
  assert.deepEqual(homeFeatures(result.shelves).map(i => i.title), ['Actual film']);
});
test('IPTV home requests only starred live categories alongside recent movie and series previews', async () => {
  const seen=[];
  const result=await loadHomeConnection(connection('xtream'),async path=>{
    const p=new URL(path,'https://tesplay.test').searchParams;seen.push([p.get('kind'),p.get('category')]);assert.equal(p.get('sort'),'recent');
    if(p.get('kind')==='series')throw Error('Unavailable');return {items:[item(p.get('category')||p.get('kind'),p.get('kind'),'xtream')]};
  },new AbortController().signal,[{connectionId:'xtream',kind:'category',id:'live:20',title:'Favourites'},{connectionId:'other',kind:'category',id:'live:90',title:'Other connection'}]);
  assert.deepEqual(seen,[['movie',''],['series',''],['live','live:20']]);
  assert.deepEqual(result.shelves.map(s=>s.kind),['movie','live']);assert.equal(result.shelves[1].category,'live:20');assert.equal(result.issues.length,1);
  const empty=await loadHomeConnection(connection('m3u'),()=>{throw Error('No unstarred channels should be requested');},new AbortController().signal);
  assert.deepEqual(empty.shelves,[]);assert.deepEqual(empty.issues,[]);
});
test('YouTube home uses subscriptions instead of a public demo search and reports missing authorization', async () => {
  let path = '';
  const c = { ...connection('youtube'), authMode: 'oauth', oauthAuthorized: true };
  const result = await loadHomeConnection(c, async p => { path = p; return { items: [item('Subscribed upload', 'video', 'youtube')], partial: true }; }, new AbortController().signal);
  assert.equal(path, '/youtube/youtube/feed');
  assert.equal(result.shelves[0].items[0].title, 'Subscribed upload');
  assert.equal(result.issues.length, 1);
  const denied = await loadHomeConnection({ ...c, authMode: 'apiKey' }, () => { throw Error('Must not request public demo search'); }, new AbortController().signal);
  assert.equal(denied.shelves.length, 0);
  assert.match(denied.issues[0], /Connect Google/);
});
test('Drive and local home previews bound folder expansion and preserve direct files', async () => {
  for (const type of ['drive', 'local']) {
    let reads = 0;
    const result = await loadHomeConnection(connection(type), async path => {
      reads++;
      const parent = new URL(path, 'https://tesplay.test').searchParams.get('parentId');
      return { items: parent ? [item(parent + '-video', 'video', type)] : [item('root-video', 'video', type), ...Array.from({ length: 20 }, (_, i) => item(String(i), 'folder', type))] };
    }, new AbortController().signal);
    assert.equal(reads, 4);
    assert.equal(result.shelves.length, 4);
    assert.equal(result.shelves[0].items[0].id, 'root-video');
  }
});
test('featured titles alternate providers and cannot become folder demos on an empty or failed library', async () => {
  const shelves = [{ connectionId: 'plex', items: [item('folder', 'folder'), item('one'), item('two')] }, { connectionId: 'youtube', items: [item('upload', 'video', 'youtube')] }];
  assert.deepEqual(homeFeatures(shelves).map(i => i.id), ['one', 'upload', 'two']);
  assert.deepEqual(homeFeatures([]), []);
  const failed = await loadHomeConnection(connection('plex'), async () => { throw Error('Connection failed'); }, new AbortController().signal);
  assert.deepEqual(failed.shelves, []);
  assert.equal(failed.issues[0], 'Connection failed');
});
test('aborted home requests reject instead of publishing rows for the previous profile', async () => {
  const controller = new AbortController();
  await assert.rejects(loadHomeConnection(connection('plex'), async () => { controller.abort(); return { items: [item('old-profile')] }; }, controller.signal), { name: 'AbortError' });
});

test('YouTube home keeps each starred channel rail in newest-first upload order',async()=>{
  const c={...connection('youtube'),authMode:'oauth',oauthAuthorized:true};
  const newest=item('Newest','video','youtube'),older=item('Older','video','youtube');
  const result=await loadHomeConnection(c,async()=>({items:[newest,older],channelRows:[{id:'UCfavorite',title:'Favorite channel',items:[newest,older]}]}),new AbortController().signal);
  assert.equal(result.shelves[0].title,'YouTube · Favorite channel');assert.equal(result.shelves[0].channel.id,'UCfavorite');assert.deepEqual(result.shelves[0].items.map(i=>i.id),['Newest','Older']);
});
const browserSource=ts.transpileModule(fs.readFileSync(new URL('../src/library-browser.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {librarySources,unifiedShelves}=await import('data:text/javascript;base64,'+Buffer.from(browserSource).toString('base64'));
test('shared library sources retain other connectors without mutating the connected accounts',()=>{
  const connections=['plex','youtube','xtream','m3u','drive','local','stremio','youtube'].map((type,index)=>connection(type,String(index)));
  assert.deepEqual(librarySources(connections).map(c=>c.type),['plex','xtream','m3u','drive','local','stremio']);
  assert.equal(connections.length,8);
  assert.deepEqual(librarySources(connections.filter(c=>c.type==='youtube')),[]);
});
test('Live TV, Movies and Shows never request YouTube feeds, including authorized accounts and refreshes',async()=>{
  for(const mode of ['live','movies','series']) for(const oauthAuthorized of [true,false]) for(const force of [true,false]) {
    const result=await unifiedShelves({...connection('youtube'),authMode:'oauth',oauthAuthorized},mode,()=>{
      assert.fail(`${mode} must leave YouTube requests to the dedicated hub`);
    },new AbortController().signal,force);
    assert.deepEqual(result,[]);
  }
});
test('unified Movies and Series expand Plex sections instead of treating Plex as an IPTV root',async()=>{
  for(const mode of ['movies','series']){
    const wanted=mode==='movies'?'movie':'series',paths=[];
    const result=await unifiedShelves(connection('plex'),mode,async path=>{paths.push(path);if(path.endsWith('/sections'))return{sections:[{id:'6',title:'Movies',kind:'movie',folderId:'films'},{id:'7',title:'TV shows',kind:'series',folderId:'shows'}]};const p=new URL(path,'https://example.test').searchParams;assert.equal(p.get('kind'),'all');assert.equal(p.get('parentId'),wanted==='movie'?'films':'shows');return{items:[item('Real Plex title',wanted)]};},new AbortController().signal);
    assert.equal(result.length,1);assert.equal(result[0].items[0].type,wanted);assert.equal(paths.length,2);
  }
});

test('Home includes starred channels beyond the first feed page without repeating offsets',async()=>{
  const offsets=[];
  const result=await loadHomeConnection({...connection('youtube'),authMode:'oauth',oauthAuthorized:true},async path=>{
    const offset=new URL(path,'https://example.test').searchParams.get('offset');offsets.push(offset);
    return{items:[],channelRows:[{id:offset||'first',title:offset||'First channel',items:[item('upload '+(offset||'first'),'video','youtube')]}],nextOffset:offset?null:8};
  },new AbortController().signal);
  assert.deepEqual(offsets,[null,'8']);assert.equal(result.shelves.length,2);assert.equal(result.shelves[1].channel.id,'8');
});

test('six highlights balance three connectors and select their newest videos before older or live content',()=>{
 const shelves=['plex','xtream','youtube'].map(connectionId=>({connectionId,items:[item('channel','live',connectionId),{...item('series container','series',connectionId),addedAt:'2026-10-01T00:00:00Z'},...Array.from({length:5},(_,i)=>({...item(`${connectionId}-${i}`,connectionId==='youtube'?'video':'movie',connectionId),addedAt:new Date(2026,0,i+1).toISOString()}))]}));
 const featured=homeFeatures(shelves);assert.equal(featured.length,6);
 for(const c of ['plex','xtream','youtube'])assert.deepEqual(featured.filter(i=>i.connectionId===c).map(i=>i.id),[`${c}-4`,`${c}-3`]);
 assert.ok(featured.every(i=>!['live','series'].includes(i.type)));
});

test('a failed or partial background refresh keeps healthy shelves until replacement data arrives',async()=>{
 const {mergeHomeResult}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const old={shelves:[{id:'movies',items:[item('old movie')]},{id:'shows',items:[item('old show')]}],issues:[]};
 assert.deepEqual(mergeHomeResult(old,{shelves:[],issues:['Provider unreachable']}).shelves,old.shelves);
 const updated={id:'movies',items:[item('new movie')]};
 const partial=mergeHomeResult(old,{shelves:[updated],issues:['Shows unavailable']});
 assert.deepEqual(partial.shelves,[updated,old.shelves[1]]);
 assert.deepEqual(mergeHomeResult(old,{shelves:[],issues:[]}).shelves,[]);
});

test('Home requests an explicit refresh only when instructed and prefers provided IPTV artwork',async()=>{
  for(const force of [false,true]){
    await loadHomeConnection(connection('xtream'),async path=>{
      const p=new URL(path,'https://tesplay.test').searchParams;
      assert.equal(p.get('refresh'),force?'1':null);assert.equal(p.get('artwork'),'prefer');
      return {items:[]};
    },new AbortController().signal,[],force);
  }
});
test('Home preview survives a reload, isolates identities and invalidates changed grants and stars',async()=>{
  const {readHomePreview,writeHomePreview}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  const c=connection('xtream'),result={shelves:[{id:'xtream:movie',title:'Films',connectionId:c.id,items:[item('Saved film','movie',c.id)]}],issues:[]};
  writeHomePreview('owner:profile',c,[],result,storage);
  assert.deepEqual(readHomePreview('owner:profile',c,[],storage),result);
  assert.equal(readHomePreview('other:profile',c,[],storage),undefined);
  assert.equal(readHomePreview('owner:profile',{...c,access:{kinds:['series']}},[],storage),undefined);
  assert.equal(readHomePreview('owner:profile',c,[{connectionId:c.id,id:'live:1',kind:'category'}],storage),undefined);
  writeHomePreview('owner:profile',c,[],{shelves:[],issues:['524']},storage);
  assert.deepEqual(readHomePreview('owner:profile',c,[],storage),result);
  values.set('tesplay:home:v1:owner:profile','invalid JSON');assert.equal(readHomePreview('owner:profile',c,[],storage),undefined);
});
