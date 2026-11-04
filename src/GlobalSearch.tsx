import {useEffect,useState,useRef} from 'react';
import {api,errorMessage} from './api';
import {Busy,Card,Empty,ConnectorLogo} from './components';
import {itemKey} from './types';
import {filterYouTubeItems} from './youtube-visibility';
import type {Connection,Library,MediaItem} from './types';
import {searchConnection} from './global-search';
import type {SearchGroup,SearchChannel} from './global-search';
export default function GlobalSearch({query,connections,library,hideYouTubeShorts=false,onOpen,onFavorite,onChannel}:{query:string;connections:Connection[];library:Library;hideYouTubeShorts?:boolean;onOpen:(item:MediaItem)=>void;onFavorite:(item:MediaItem)=>void;onChannel:(c:Connection,channel:SearchChannel)=>void}) {
 const currentQuery=useRef(query);currentQuery.current=query;
 const moreController=useRef<AbortController|null>(null);
 const [groups,setGroups]=useState<SearchGroup[]>([]),[pending,setPending]=useState<string[]>([]),[loadingMore,setLoadingMore]=useState<string|null>(null);
 useEffect(()=>{
   const controller=new AbortController();moreController.current?.abort();setLoadingMore(null);setGroups([]);setPending(connections.map(c=>c.id));
   for(const c of connections)void searchConnection(c,query,<T,>(path:string,signal:AbortSignal)=>api<T>(path,undefined,undefined,signal),controller.signal)
     .then(rows=>{if(!controller.signal.aborted)setGroups(g=>[...g,...rows]);})
     .catch(e=>{if(!controller.signal.aborted)setGroups(g=>[...g,{id:c.id,title:c.type==='youtube'?'YouTube':c.name,connection:c,items:[],path:'',page:1,error:errorMessage(e)}]);})
     .finally(()=>{if(!controller.signal.aborted)setPending(p=>p.filter(id=>id!==c.id));});
   return()=>{controller.abort();moreController.current?.abort();};
 },[connections,query]);
 const more=async(group:SearchGroup)=>{
   const originalQuery=query,controller=new AbortController();moreController.current?.abort();moreController.current=controller;setLoadingMore(group.id);
   try{const path=group.path+`&${group.nextPageToken?`pageToken=${encodeURIComponent(group.nextPageToken)}`:`page=${group.page+1}`}`;const result=await api<{items:MediaItem[];hasMore?:boolean;nextPageToken?:string|null}>(path,undefined,undefined,controller.signal);if(currentQuery.current!==originalQuery||controller.signal.aborted)return;setGroups(rows=>rows.map(row=>row.id===group.id?{...row,...result,items:[...row.items,...result.items],page:group.page+1,error:undefined}:row));}
   catch(e){if(controller.signal.aborted||currentQuery.current!==originalQuery)return;setGroups(rows=>rows.map(row=>row.id===group.id?{...row,error:errorMessage(e)}:row));}finally{if(!controller.signal.aborted&&currentQuery.current===originalQuery)setLoadingMore(null);}
 };
 const favorites=new Set([...library.favorites,...(library.queue||[])].map(itemKey));
 const ordered=connections.flatMap(c=>groups.filter(g=>g.connection.id===c.id)).map(group=>({...group,items:filterYouTubeItems(group.items,hideYouTubeShorts,connections,library.progress),originalCount:group.items.length}));
 return <section className="page-section global-results" aria-label="Global search results"><div className="page-heading"><div><span className="eyebrow">All your connections</span><h1>Results for “{query}”</h1></div></div>{ordered.map(group=><section className="search-source" key={group.id}><h2><ConnectorLogo type={group.connection.type}/>{group.title}</h2>{group.error&&<p className="form-error" role="status">{group.error}</p>}{!!group.channels?.length&&<><h3>Channels</h3><div className="channel-search-results">{group.channels.map(channel=><button key={channel.id} className="channel-result" onClick={()=>onChannel(group.connection,channel)}>{channel.thumbnail&&<img src={channel.thumbnail} alt=""/>}<strong>{channel.title}</strong></button>)}</div></>}{group.items.length?<><h3>{group.connection.type==='youtube'?'Videos':'Titles'}</h3><div className="catalog-grid">{group.items.map(item=><Card key={itemKey(item)} item={item} onOpen={onOpen} onFavorite={onFavorite} saved={favorites.has(itemKey(item))}/>)}</div></>:!group.error&&<p className="form-help">{hideYouTubeShorts&&group.originalCount?"Short videos are hidden. Change this in Settings or load more results.":"No matching titles in this library."}</p>}{(group.hasMore||group.nextPageToken)&&<button className="button ghost small" disabled={loadingMore===group.id} onClick={()=>void more(group)}>{loadingMore===group.id?'Loading…':'More results'}</button>}</section>)}{!!pending.length&&<Busy label="Searching your connections…"/>}{!connections.length&&<Empty title="No connections to search">Connect a source or ask your server owner to share one.</Empty>}</section>;
}
