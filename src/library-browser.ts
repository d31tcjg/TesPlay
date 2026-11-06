import type { Connection, MediaItem } from './types';
export type CatalogResult = { items: MediaItem[]; categories?: {id:string;name:string}[]; hasMore?:boolean; nextPageToken?:string };
export type PlexSection = {id:string;title:string;kind:string;folderId:string};
export type LibraryShelf = {id:string;title:string;connection:Connection;items:MediaItem[];parent?:MediaItem;kind:string;category?:string};
export type LibraryMode = 'movies'|'series'|'live'|'catalog';
type Request = <T>(path:string,signal:AbortSignal)=>Promise<T>;

/** YouTube is browsed in its dedicated hub, outside the shared TV and film libraries. */
export function librarySources(connections:Connection[]):Connection[] {
  return connections.filter(c=>c.type!=='youtube');
}

/** Preserve each source's hierarchy instead of asking its root for IPTV kinds. */
export async function unifiedShelves(c:Connection,mode:LibraryMode,request:Request,signal:AbortSignal,force=false):Promise<LibraryShelf[]> {
  if(c.type==='youtube') return [];
  const kind=mode==='series'?'series':mode==='live'?'live':'movie';
  const effectiveKind=['drive','local'].includes(c.type)&&kind==='movie'?'video':kind;
  if(c.access&&!c.access.kinds.includes(effectiveKind)) return [];
  if(['xtream','m3u'].includes(c.type) && Array.isArray(c.loadedCategories) && !c.loadedCategories.some(id=>c.type==='m3u'||id.startsWith(`${kind}:`))) return [];
  const catalog=(parentId='',wanted=kind)=>request<CatalogResult>(`/catalog?${new URLSearchParams({connectionId:c.id,kind:wanted,parentId,limit:'12',...(force?{refresh:'1'}:{})})}`,signal);
  const shelf=(id:string,title:string,items:MediaItem[],parent?:MediaItem,wanted=kind):LibraryShelf=>({id:`${c.id}:${id}`,title,connection:c,items,parent,kind:wanted});
  if (c.type === 'stremio' && kind !== 'live') {
    const { catalogs } = await request<{catalogs:{id:string;name:string;type:string}[]}>(`/stremio/${c.id}/catalogs?kind=${kind}`, signal);
    const results = await Promise.allSettled(catalogs.slice(0, 12).map(async entry => {
      const result = await request<CatalogResult>(`/catalog?${new URLSearchParams({connectionId:c.id,kind,category:entry.id,limit:'12',...(force?{refresh:'1'}:{})})}`,signal);
      return {...shelf(entry.id,entry.name,result.items),category:entry.id};
    }));
    signal.throwIfAborted();
    if (results.length && results.every(r=>r.status==='rejected')) throw (results[0] as PromiseRejectedResult).reason;
    return results.flatMap(r=>r.status==='fulfilled'?[r.value]:[]);
  }
  if(c.type==='plex' && kind!=='live') {
    const {sections}=await request<{sections:PlexSection[]}>(`/plex/${c.id}/sections`,signal);
    const matching=sections.filter(s=>s.kind===kind);
    const results=await Promise.allSettled(matching.map(async s=>shelf(s.id,`${c.name} · ${s.title}`,(await catalog(s.folderId,'all')).items,{id:s.folderId,title:s.title,type:'folder',source:c.name,connectionId:c.id,contentKind:s.kind,sectionId:s.id},'all')));
    signal.throwIfAborted();
    if(results.length && results.every(r=>r.status==='rejected')) throw (results[0] as PromiseRejectedResult).reason;
    return results.flatMap(r=>r.status==='fulfilled'?[r.value]:[]);
  }
  if(c.type==='channels') {
    // Live TV is the guide grid. All recordings (episodes and movies) are one newest-first list, shown on the TV Shows page only.
    if(kind!=='series') return [];
    const folder={id:'channels:recordings',title:'Recordings'};
    const items=(await catalog(folder.id,'all')).items;
    return [shelf(folder.id,`${c.name} · Recordings`,items,{...folder,type:'folder',source:c.name,connectionId:c.id,contentKind:'series'},'all')];
  }
  if(c.type==='xtream' || c.type==='m3u' && kind==='live') return [shelf(kind,c.name,(await catalog()).items)];
  if(['drive','local'].includes(c.type) && kind!=='live') {
    const root=await catalog('','all');
    const keep=(item:MediaItem)=>kind==='movie'?['video','movie'].includes(item.type):item.type==='series'||item.type==='folder';
    const result=[shelf('root',c.name,root.items.filter(keep),undefined,'all')];
    if(kind==='movie') {
      const folders=root.items.filter(i=>i.type==='folder').slice(0,3);
      const children=await Promise.allSettled(folders.map(async f=>shelf(f.id,`${c.name} · ${f.title}`,(await catalog(f.id,'all')).items.filter(keep),f,'all')));
      signal.throwIfAborted(); result.push(...children.flatMap(r=>r.status==='fulfilled'?[r.value]:[]));
    }
    return result;
  }
  return [];
}
