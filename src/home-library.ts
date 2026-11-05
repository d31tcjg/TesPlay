import type { Connection, MediaItem, Starred } from './types';
export type HomeShelf = { id: string; title: string; connectionId: string; items: MediaItem[]; parent?: MediaItem; kind?: string; category?:string; channel?: {id:string;title:string} };
/** Keep recent IPTV previews together while preserving each item's provider. */
export function bundleIptvHomeShelves(shelves:HomeShelf[], connections:Connection[]):HomeShelf[] {
  const result:HomeShelf[] = [];
  const iptv = new Set(connections.filter(c=>['xtream','m3u'].includes(c.type)).map(c=>c.id));
  for (const shelf of shelves) {
    if (!iptv.has(shelf.connectionId) || shelf.category) { result.push(shelf); continue; }
    const id = `iptv:${shelf.kind || 'all'}`;
    const existing = result.find(s=>s.id===id);
    if (existing) existing.items.push(...shelf.items);
    else result.push({...shelf,id,title:`IPTV · ${shelf.kind === 'series' ? 'TV shows' : shelf.kind === 'live' ? 'Live TV' : 'Movies'}`,items:[...shelf.items]});
  }
  return result;
}
export type HomeResult = { shelves: HomeShelf[]; issues: string[] };
export type HomeCatalog = { items: MediaItem[]; catalogs?: {id:string;name:string;type:string}[]; partial?: boolean; nextOffset?: number | null; channelRows?: {id:string;title:string;items:MediaItem[]}[] };
type Request = (path: string, signal: AbortSignal) => Promise<HomeCatalog>;
const message = (e: unknown) => e instanceof Error ? e.message : 'The library could not load.';

/** Small previews from every provider, without crawling an entire library. */
export async function loadHomeConnection(c: Connection, request: Request, signal: AbortSignal, stars:Starred[] = [], force = false): Promise<HomeResult> {
  const shelves: HomeShelf[] = [], issues: string[] = [];
  const shelf = (id: string, title: string, items: MediaItem[], extra = {}) => shelves.push({ id: `${c.id}:${id}`, title, connectionId: c.id, items: items.slice(0, 12), ...extra });
  const catalog = (kind = 'all', parentId = '', category = '') => request(`/catalog?${new URLSearchParams({ connectionId: c.id, kind, parentId, category, sort:'recent', limit: '12', page: '1', ...(force?{refresh:'1'}:{}), ...(c.type==='xtream' && ['movie','series'].includes(kind)?{artwork:'prefer'}:{}) })}`, signal);
  const collect = (results: PromiseSettledResult<HomeCatalog>[], names: string[], add: (value: HomeCatalog, index: number) => void) => {
    signal.throwIfAborted();
    results.forEach((r, index) => r.status === 'fulfilled' ? add(r.value, index) : issues.push(`${names[index]}: ${message(r.reason)}`));
  };
  try {
    if (!c.configured) return { shelves, issues: ['Finish setting up this connection in Connections.'] };
    if (c.type === 'stremio') {
      const root = await request(`/stremio/${c.id}/catalogs`, signal);
      const catalogs = (root.catalogs || []).filter(entry => !c.access || c.access.kinds.includes(entry.type)).slice(0, 8);
      collect(await Promise.allSettled(catalogs.map(entry => catalog(entry.type, '', entry.id))), catalogs.map(entry=>entry.name),
        (result,index)=>shelf(catalogs[index].id,catalogs[index].name,result.items,{kind:catalogs[index].type,category:catalogs[index].id}));
    } else if (c.type === 'youtube') {
      if (c.authMode !== 'oauth' || !c.oauthAuthorized) return { shelves, issues: ['Connect Google in YouTube settings to load your subscription videos.'] };
      const offsets=new Set<number>(); let offset: number | undefined;
      do {
        const data = await request(`/youtube/${encodeURIComponent(c.id)}/feed${offset===undefined?'':`?offset=${offset}`}`, signal);
        signal.throwIfAborted();
        if(data.channelRows) for(const row of data.channelRows) shelf('channel:'+row.id,`YouTube · ${row.title}`,row.items,{channel:{id:row.id,title:row.title}});
        else shelf('subscriptions', 'YouTube · Starred channels', data.items);
        if (data.partial && !issues.length) issues.push('Some starred channels could not load.');
        offset=data.nextOffset??undefined;
        if(offset===undefined||offsets.has(offset))break;
        offsets.add(offset);
      } while (!signal.aborted);
    } else if (c.type === 'xtream') {
      const loaded = (id:string) => !Array.isArray(c.loadedCategories) || c.loadedCategories.includes(id);
      const kinds = ['movie', 'series'].filter(k=>(!c.access||c.access.kinds.includes(k)) && (!Array.isArray(c.loadedCategories)||c.loadedCategories.some(id=>id.startsWith(`${k}:`)))), names = kinds.map(k=>({movie:'Movies',series:'Series'}[k]!));
      collect(await Promise.allSettled(kinds.map(k => catalog(k))), names, (r, index) => shelf(kinds[index], `${c.name} · ${names[index]}`, r.items, { kind: kinds[index] }));
      const categories=stars.filter(s=>s.connectionId===c.id && s.kind==='category' && s.id.startsWith('live:') && loaded(s.id) && (!c.access || c.access.kinds.includes('live')));
      collect(await Promise.allSettled(categories.map(s=>catalog('live','',s.id))),categories.map(s=>s.title),(r,index)=>shelf(categories[index].id,`${c.name} · Live TV · ${categories[index].title}`,r.items,{kind:'live',category:categories[index].id}));
    } else if (['plex', 'local', 'drive'].includes(c.type)) {
      const root = await catalog(); signal.throwIfAborted();
      const folders = root.items.filter(item => item.type === 'folder').slice(0, c.type === 'plex' ? 6 : 3);
      const titles = root.items.filter(item => item.type !== 'folder');
      if (titles.length || !folders.length) shelf('root', c.name, titles);
      collect(await Promise.allSettled(folders.map(f => catalog(c.type==='plex' && f.contentKind==='series'?'episode':'all', f.id))), folders.map(f => f.title), (r, index) => shelf(folders[index].id, `${c.name} · ${folders[index].title}`, r.items, { parent: folders[index] }));
      // Keep folders browsable if every child library failed, without substituting demos.
      if (!shelves.length && root.items.length) shelf('libraries', c.name, root.items);
    } else if (c.type === 'channels') {
      // Newest unwatched recordings across all shows (server-side `channels:recent`).
      // "View all" opens the connection's folders: a mixed show/movie list has no single episode view.
      collect(await Promise.allSettled([catalog('all','channels:recent')]),['Recently recorded'],r=>shelf('recent',`${c.name} · Recently recorded`,r.items));
    } else if (c.type === 'm3u') {
      const categories=stars.filter(s=>s.connectionId===c.id && s.kind==='category' && (!Array.isArray(c.loadedCategories)||c.loadedCategories.includes(s.id)));
      collect(await Promise.allSettled(categories.map(s=>catalog('live','',s.id))),categories.map(s=>s.title),(r,index)=>shelf(categories[index].id,`${c.name} · Live TV · ${categories[index].title}`,r.items,{kind:'live',category:categories[index].id}));
    } else issues.push('This provider does not have a supported library integration.');
    signal.throwIfAborted();
    return { shelves, issues };
  } catch (e) {
    if (signal.aborted) throw e;
    return { shelves, issues: [...issues, message(e)] };
  }
}

/** Alternate providers so the featured area is not dominated by one library. */
export function homeFeatures(shelves: HomeShelf[]): MediaItem[] {
  const providers = new Map<string, MediaItem[]>();
  const seen = new Set<string>();
  const date=(item:MediaItem)=>Date.parse(item.publishedAt || item.addedAt || '') || 0;
  for (const shelf of shelves) for (const item of shelf.items) {
    if (['folder','series','audio','live'].includes(item.type)) continue;
    const connectionId=item.connectionId || shelf.connectionId;
    const key=JSON.stringify([connectionId,item.type,item.id]);
    if(seen.has(key))continue;
    seen.add(key);
    const items=providers.get(connectionId)||[];
    items.push(item);
    providers.set(connectionId,items);
  }
  const featured:MediaItem[]=[];
  const groups=[...providers.values()].map(items=>items.sort((a,b)=>date(b)-date(a)));
  for(let index=0;featured.length<6 && groups.some(items=>index<items.length);index++) {
    for(const items of groups) {if(items[index])featured.push(items[index]);if(featured.length===6)break;}
  }
  return featured;
}

/** Keep known shelves when a provider only returns a partial refresh. */
export function mergeHomeResult(previous:HomeResult|undefined,next:HomeResult):HomeResult {
 if(!previous || !next.issues.length)return next;
 const shelves=new Map(previous.shelves.map(shelf=>[shelf.id,shelf]));
 for(const shelf of next.shelves)shelves.set(shelf.id,shelf);
 return {...next,shelves:[...shelves.values()]};
}

// A reload reuses the browser's last successful Home preview. Provider catalogs
// are cached on the server as well; this snapshot avoids a loading interstitial.
export function readHomePreview(identity:string, c:Connection, stars:Starred[], storage:Pick<Storage,'getItem'>):HomeResult|undefined {
  try {
    const saved=JSON.parse(storage.getItem(`tesplay:home:v1:${identity}`)||'{}')[c.id];
    if(saved?.fingerprint!==homePreviewFingerprint(c,stars)||!Array.isArray(saved.result?.shelves))return;
    if(saved.result.shelves.some((s:HomeShelf)=>s.connectionId!==c.id||typeof s.id!=='string'||typeof s.title!=='string'||!Array.isArray(s.items)||s.items.some(i=>typeof i.id!=='string'||typeof i.title!=='string')))return;
    return {shelves:saved.result.shelves,issues:[]};
  } catch { return; }
}
export function writeHomePreview(identity:string,c:Connection,stars:Starred[],result:HomeResult,storage:Pick<Storage,'getItem'|'setItem'>):void {
  if(result.issues.length&&!result.shelves.length)return;
  try {
    const key=`tesplay:home:v1:${identity}`,saved=JSON.parse(storage.getItem(key)||'{}');
    saved[c.id]={fingerprint:homePreviewFingerprint(c,stars),result:{shelves:result.shelves,issues:[]}};
    const json=JSON.stringify(saved);if(json.length<2_000_000)storage.setItem(key,json);
  } catch { /* Private browsing and full storage still use the server catalog. */ }
}
function homePreviewFingerprint(c:Connection,stars:Starred[]):string {
  return JSON.stringify([c,stars.filter(s=>s.connectionId===c.id).map(s=>[s.kind,s.id]).sort()]);
}

export function invalidateHomePreview(connectionId:string):void {
  try {
    for(let i=0;i<sessionStorage.length;i++){
      const key=sessionStorage.key(i);if(!key?.startsWith('tesplay:home:v1:'))continue;
      const saved=JSON.parse(sessionStorage.getItem(key)||'{}');delete saved[connectionId];sessionStorage.setItem(key,JSON.stringify(saved));
    }
  } catch { /* Optional browser snapshot. */ }
}
