import type {Connection,MediaItem} from './types';
export type SearchChannel={id:string;title:string;thumbnail?:string};
export type SearchGroup={id:string;title:string;connection:Connection;items:MediaItem[];channels?:SearchChannel[];path:string;hasMore?:boolean;nextPageToken?:string|null;page:number;error?:string};
type Result={items:MediaItem[];channels?:SearchChannel[];hasMore?:boolean;nextPageToken?:string|null};
type Request=<T>(path:string,signal:AbortSignal)=>Promise<T>;
export async function searchConnection(c:Connection,query:string,request:Request,signal:AbortSignal):Promise<SearchGroup[]> {
 const path=`/catalog?${new URLSearchParams({connectionId:c.id,kind:'all',q:query,limit:'60',recursive:'1'})}`;
 if (c.type === 'stremio') {
   const root = await request<{catalogs:{id:string;name:string;type:string}[]}>(`/stremio/${c.id}/catalogs?search=1`,signal);
   return Promise.all(root.catalogs.slice(0,16).map(async catalog=>{
     const source = '/catalog?'+new URLSearchParams({connectionId:c.id,kind:catalog.type,category:catalog.id,q:query,limit:'60'});
     try { return {id:`${c.id}:${catalog.id}`,title:catalog.name,connection:c,...await request<Result>(source,signal),path:source,page:1}; }
     catch (error) { signal.throwIfAborted(); return {id:`${c.id}:${catalog.id}`,title:catalog.name,connection:c,items:[],path:source,page:1,error:error instanceof Error?error.message:'This catalog could not be searched.'}; }
   }));
 }
 if(c.type==='plex') {
   const root=await request<{sections:{id:string;title:string;folderId:string;kind?:string}[]}>(`/plex/${c.id}/sections`,signal);
   const sections=root.sections.flatMap(section=>section.kind==='series'?[{...section,searchKind:'all'},{...section,id:section.id+':episodes',title:section.title+' · Episodes',searchKind:'episode'}]:[{...section,searchKind:'all'}]);
   return Promise.all(sections.map(async section=>{
     const params=new URLSearchParams({connectionId:c.id,kind:section.searchKind,q:query,limit:'60',parentId:section.folderId});const source='/catalog?'+params;
     try{return {id:c.id+':'+section.id,title:`${c.name} · ${section.title}`,connection:c,...await request<Result>(source,signal),path:source,page:1};}
     catch(e){signal.throwIfAborted();return {id:c.id+':'+section.id,title:`${c.name} · ${section.title}`,connection:c,items:[],path:source,page:1,error:e instanceof Error?e.message:'This library could not be searched.'};}
   }));
 }
 const source=c.type==='youtube'?`/youtube/${c.id}/search?q=${encodeURIComponent(query)}`:path;
 return [{id:c.id,title:c.type==='youtube'?'YouTube':c.name,connection:c,...await request<Result>(source,signal),path:source,page:1}];
}
