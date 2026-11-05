import { RefreshButton } from "./components";
import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronLeft, Clock, Film, Folder, Radio, Search, Star, Tv, Info } from 'lucide-react';
import { api, errorMessage } from './api';
import { Busy, Card, Empty, Row, MediaDetailsContext } from './components';
import { itemKey } from './types';
import type { Connection, Library, MediaItem, Starred } from './types';
import {invalidateHomePreview} from './home-library';
import { librarySources, unifiedShelves } from './library-browser';
import { episodeSeasons, episodesForSeason } from './episodes';
import { filterYouTubeItems, filterYouTubeShelves } from './youtube-visibility';
import type { CatalogResult, LibraryMode, LibraryShelf, PlexSection } from './library-browser';
import { bundleIptvShelves, isIptv } from './iptv-library';
import IptvBundleBrowser from './IptvBundleBrowser';
const ChannelsGuide = lazy(() => import('./ChannelsGuide'));
type Props = {connections:Connection[];library:Library;hideYouTubeShorts?:boolean;onOpen:(i:MediaItem)=>void;onBrowseSeries?:(i:MediaItem)=>void;onFavorite:(i:MediaItem)=>void;onStar:(s:Starred)=>void;onConnect:()=>void;onYouTube:()=>void;onGuide:(i:MediaItem)=>void;query:string};
const kinds=[['live','Live TV',Radio],['movie','Movies',Film],['series','TV shows',Tv]] as const;
const saved=(library:Library,item:MediaItem)=>[...library.favorites,...(library.queue||[])].some(i=>itemKey(i)===itemKey(item));
const progress=(library:Library,item:MediaItem)=>{const p=library.progress.find(p=>itemKey(p.item)===itemKey(item));return p&&p.duration?p.seconds/p.duration*100:undefined;};
const starred=(library:Library,s:Starred)=>library.stars?.some(x=>x.connectionId===s.connectionId&&x.kind===s.kind&&x.id===s.id)||false;
function StarsButton({value,props}:{value:Starred;props:Props}) {const selected=starred(props.library,value);return <button className={`category-star icon-button ${selected?'selected':''}`} aria-label={`${selected?'Unstar':'Star'} ${value.title}`} aria-pressed={selected} onClick={()=>props.onStar(value)}><Star size={16} fill={selected?'currentColor':'none'}/></button>;}
function Grid({items:rawItems,props,onOpen}:{items:MediaItem[];props:Props;onOpen?:(i:MediaItem)=>void}) {
  const details=useContext(MediaDetailsContext);
  const items=filterYouTubeItems(rawItems,props.hideYouTubeShorts||false,props.connections,props.library.progress);
  if(items.length && items.every(i=>i.type==='episode')) {
    const seasons=episodeSeasons(items);
    return <div className="episode-seasons">{seasons.map(season=><section key={season}><h2>Season {season}</h2><div className="episode-grid">{episodesForSeason(items,season).map((item,index)=><div key={itemKey(item)} className="episode-tile"><button className={`episode-number ${item.watched||(progress(props.library,item)||0)>=97?'watched':''}`} title={item.title} aria-label={`Play episode ${item.episodeNumber??index+1}: ${item.title}`} onClick={()=>(onOpen||props.onOpen)(item)}><span>{item.episodeNumber??index+1}</span>{(item.watched||(progress(props.library,item)||0)>=97)&&<small aria-label="Watched">✓</small>}</button>{details&&<button className="episode-info icon-button" aria-label={`Information about ${item.title}`} onClick={()=>details.onDetails(item)}><Info size={16}/></button>}</div>)}</div></section>)}</div>;
  }
  return <div className="catalog-grid source-grid">{items.map(item=><div key={itemKey(item)}><Card item={item} onOpen={onOpen||props.onOpen} onFavorite={props.onFavorite} saved={saved(props.library,item)} progress={progress(props.library,item)}/>{item.type==='live'&&item.providerType==='xtream'&&<button className="text-button program-button" onClick={()=>props.onGuide(item)}><Clock size={14}/>Program guide</button>}</div>)}</div>;}
function SearchBox({query,onChange,children}:{query:string;onChange:(s:string)=>void;children?:React.ReactNode}) {return <div className="library-search"><div className="inline-search"><Search size={18}/><input aria-label="Search this library" value={query} placeholder="Search this library…" onChange={e=>onChange(e.target.value)}/></div>{children}</div>;}

export function SourceBrowser({connection:c,initialParent,initialKind='all',initialCategory='',props,onBack}:{connection:Connection;initialParent?:MediaItem;initialKind?:string;initialCategory?:string;props:Props;onBack?:()=>void}) {
  const [kind,setKind]=useState(initialKind==='all'&&c.type==='xtream'?(c.access?.kinds.find(k=>['live','movie','series'].includes(k))||'live'):initialKind);
  const [folders,setFolders]=useState<MediaItem[]>(initialParent?[initialParent]:[]),[category,setCategory]=useState(initialCategory);
  const [draft,setDraft]=useState(props.query),[query,setQuery]=useState(props.query),[page,setPage]=useState(1),[tokens,setTokens]=useState<string[]>([]),[refresh,setRefresh]=useState(0);
  const [result,setResult]=useState<CatalogResult>({items:[]}),[categories,setCategories]=useState<{id:string;name:string}[]>([]),[busy,setBusy]=useState(true),[error,setError]=useState('');
  const lastRefresh=useRef(refresh);
  const parent=folders.at(-1);
  useEffect(()=>{const timer=setTimeout(()=>{setQuery(draft);setPage(1);setTokens([]);},300);return()=>clearTimeout(timer);},[draft]);
  useEffect(()=>setDraft(props.query),[props.query]);
  useEffect(()=>{
    const controller=new AbortController();setBusy(true);setError('');
    const params=new URLSearchParams({connectionId:c.id,kind,parentId:parent?.id||'',category,q:query,page:String(page)});
    const force=refresh!==lastRefresh.current;if(force)params.set('refresh','1');lastRefresh.current=refresh;
    if(tokens[page-1])params.set('pageToken',tokens[page-1]);
    void api<CatalogResult>(`/catalog?${params}`,undefined,undefined,controller.signal).then(r=>{if(!controller.signal.aborted){if(force)invalidateHomePreview(c.id);setResult(r);if(r.categories)setCategories(r.categories);}}).catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e));}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});
    return()=>controller.abort();
  },[c.id,kind,parent?.id,category,query,page,tokens,refresh]);
  const choose=(id:string)=>{setCategory(id);setPage(1);setTokens([]);};
  const open=(item:MediaItem)=>{if(props.onBrowseSeries&&(item.type==='series'||item.type==='folder'&&!!item.seriesId)){props.onBrowseSeries(item);return;}if(item.type==='folder'||item.type==='series'){setFolders(f=>[...f,item]);choose('');setDraft('');}else props.onOpen(item);};
  const visibleItems=filterYouTubeItems(result.items,props.hideYouTubeShorts||false,props.connections,props.library.progress);
  const ordered=[...categories].sort((a,b)=>Number(starred(props.library,{connectionId:c.id,kind:'category',id:b.id,title:b.name}))-Number(starred(props.library,{connectionId:c.id,kind:'category',id:a.id,title:a.name}))||a.name.localeCompare(b.name));
  return <div className="library-layout">
    <aside className="library-sidebar" aria-label={`${c.name} categories`}>
      <div className="sidebar-label">{c.name}</div>
      {c.type==='xtream'&&!parent&&kinds.filter(([id])=>!c.access||c.access.kinds.includes(id)).map(([id,title,Icon])=><button key={id} className={`sidebar-link ${kind===id?'selected':''}`} onClick={()=>{setKind(id);setCategories([]);choose('');setDraft('');}}><Icon size={18}/>{title}</button>)}
      <div className="sidebar-label">{parent?'Browse':'Categories'}</div>
      <button className={`sidebar-link ${!category?'selected':''}`} onClick={()=>choose('')}>All {parent?'episodes':kind==='live'?'channels':'titles'}</button>
      <div className="sidebar-categories">{ordered.map(value=><div key={value.id} className="sidebar-category"><button className={`sidebar-link ${category===value.id?'selected':''}`} onClick={()=>choose(value.id)}>{value.name}</button>{!parent&&<StarsButton value={{connectionId:c.id,kind:'category',id:value.id,title:value.name}} props={props}/>}</div>)}</div>
    </aside>
    <div className="library-main">
      <div className="library-heading"><div>{onBack&&<button className="text-button" onClick={onBack}><ArrowLeft size={17}/> All sources</button>}<span className="eyebrow">{c.name}</span><h1>{parent?.title||kinds.find(k=>k[0]===kind)?.[1]||c.name}</h1></div><RefreshButton label="Refresh library" onRefresh={()=>setRefresh(n=>n+1)}/></div>
      {folders.length>0&&<div className="library-breadcrumbs"><button className="text-button" onClick={()=>{setFolders([]);choose('');}}>Library</button>{folders.map((f,index)=><button className="text-button" key={`${f.id}:${index}`} onClick={()=>{setFolders(a=>a.slice(0,index+1));choose('');}}><ArrowRight size={14}/>{f.title}</button>)}</div>}
      <SearchBox query={draft} onChange={setDraft}/>
      {error&&<div className="form-error" role="alert">{error}</div>}
      {busy?<Busy/>:visibleItems.length?<Grid items={visibleItems} props={props} onOpen={open}/>:!error&&<Empty title="No titles here">{props.hideYouTubeShorts&&result.items.length?'Short videos are hidden. Change this in Settings or choose another category.':'Choose another category or search.'}</Empty>}
      {(page>1||result.hasMore||result.nextPageToken)&&<div className="pagination"><button className="button ghost" disabled={page===1||busy} onClick={()=>setPage(p=>p-1)}><ChevronLeft size={16}/>Previous</button><span>Page {page}</span><button className="button ghost" disabled={busy||!result.hasMore&&!result.nextPageToken} onClick={()=>{if(result.nextPageToken)setTokens(t=>{const a=[...t];a[page]=result.nextPageToken!;return a;});setPage(p=>p+1);}}>Next<ArrowRight size={16}/></button></div>}
    </div>
  </div>;
}

function PlexBrowser({connection:c,initialParent,props}:{connection:Connection;initialParent?:MediaItem;props:Props}) {
  const [sections,setSections]=useState<PlexSection[]>([]),[sectionId,setSectionId]=useState(initialParent?.sectionId||''),[folder,setFolder]=useState<MediaItem|undefined>(initialParent);
  const [list,setList]=useState<{id:string;title:string}|null>(null),[page,setPage]=useState(1),[draft,setDraft]=useState(props.query),[query,setQuery]=useState(props.query),[refresh,setRefresh]=useState(0);
  const [hubs,setHubs]=useState<{id:string;title:string;items:MediaItem[]}[]>([]),[result,setResult]=useState<CatalogResult>({items:[]}),[busy,setBusy]=useState(true),[error,setError]=useState(''),[notes,setNotes]=useState<string[]>([]);
  useEffect(()=>{const controller=new AbortController();void api<{sections:PlexSection[]}>(`/plex/${c.id}/sections`,undefined,undefined,controller.signal).then(r=>{if(controller.signal.aborted)return;setSections(r.sections);setSectionId(id=>r.sections.some(s=>s.id===id)?id:r.sections[0]?.id||'');if(!r.sections.length)setBusy(false);}).catch(e=>{if(!controller.signal.aborted){setError(errorMessage(e));setBusy(false);}});return()=>controller.abort();},[c.id,refresh]);
  useEffect(()=>{const t=setTimeout(()=>{setQuery(draft);setPage(1);},300);return()=>clearTimeout(t);},[draft]);
  useEffect(()=>setDraft(props.query),[props.query]);
  const section=sections.find(s=>s.id===sectionId);
  useEffect(()=>{
    if(!sectionId)return;
    const controller=new AbortController();setBusy(true);setError('');
    const request=list?`/plex/${c.id}/list?${new URLSearchParams({listId:list.id,page:String(page),q:query})}`:folder?`/catalog?${new URLSearchParams({connectionId:c.id,parentId:folder.id,page:String(page),q:query})}`:query?`/catalog?${new URLSearchParams({connectionId:c.id,parentId:section?.folderId||'',page:String(page),q:query})}`:`/plex/${c.id}/hubs?sectionId=${sectionId}`;
    void api<CatalogResult&{hubs?:typeof hubs;notes?:string[]}>(request,undefined,undefined,controller.signal).then(r=>{if(controller.signal.aborted)return;setResult({items:r.items||[],hasMore:r.hasMore});setHubs(r.hubs||[]);setNotes(r.notes||[]);}).catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e));}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});
    return()=>controller.abort();
  },[c.id,sectionId,section?.folderId,folder?.id,list?.id,page,query,refresh]);
  const choose=(s:PlexSection)=>{setSectionId(s.id);setFolder(undefined);setList(null);setPage(1);setDraft('');};
  const open=(item:MediaItem)=>{if(props.onBrowseSeries&&(item.type==='series'||item.type==='folder'&&!!item.seriesId)){props.onBrowseSeries(item);return;}if(item.type==='folder'||item.type==='series'){setFolder(item);setList(null);setPage(1);setDraft('');}else props.onOpen(item);};
  const more=(hub:{id:string;title:string})=>{setList(hub);setFolder(undefined);setPage(1);setDraft('');};
  const visibleHubs=filterYouTubeShelves(hubs,props.hideYouTubeShorts||false,props.connections,props.library.progress);
  const visibleItems=filterYouTubeItems(result.items,props.hideYouTubeShorts||false,props.connections,props.library.progress);
  const ordered=[...sections].sort((a,b)=>Number(starred(props.library,{connectionId:c.id,kind:'section',id:b.id,title:b.title}))-Number(starred(props.library,{connectionId:c.id,kind:'section',id:a.id,title:a.title})));
  return <div className="library-layout">
    <aside className="library-sidebar" aria-label="Plex libraries"><div className="sidebar-label">Plex libraries</div>{ordered.map(s=><div className="sidebar-category" key={s.id}><button className={`sidebar-link ${s.id===sectionId?'selected':''}`} onClick={()=>choose(s)}>{s.kind==='series'?<Tv size={18}/>:s.kind==='audio'?<Radio size={18}/>:<Film size={18}/>} {s.title}</button><StarsButton value={{connectionId:c.id,kind:'section',id:s.id,title:s.title}} props={props}/></div>)}</aside>
    <div className="library-main"><div className="library-heading"><div><span className="eyebrow">{c.name}</span><h1>{list?.title||folder?.title||section?.title||'Plex'}</h1></div><RefreshButton label="Refresh Plex lists" onRefresh={()=>setRefresh(n=>n+1)}/></div>
      {(list||folder)&&section&&<button className="text-button library-back" onClick={()=>choose(section)}><ArrowLeft size={17}/>Back to {section.title}</button>}
      <SearchBox query={draft} onChange={setDraft}/>
      {notes.map(note=><p className="form-help" key={note}>{note}</p>)}
      {error&&<div className="form-error" role="alert">{error}</div>}
      {busy?<Busy label="Loading your Plex library…"/>:visibleHubs.length?visibleHubs.map(h=><Row key={h.id} title={h.title} items={h.items} onOpen={open} onFavorite={props.onFavorite} isSaved={i=>saved(props.library,i)} progress={i=>progress(props.library,i)} more={()=>more(h)}/>):visibleItems.length?<Grid items={visibleItems} props={props} onOpen={open}/>:!error&&<Empty title="No titles in this library">Choose another Plex library or search.</Empty>}
      {(page>1||result.hasMore)&&<div className="pagination"><button className="button ghost" disabled={page===1||busy} onClick={()=>setPage(p=>p-1)}>Previous</button><span>Page {page}</span><button className="button ghost" disabled={!result.hasMore||busy} onClick={()=>setPage(p=>p+1)}>Next<ArrowRight size={16}/></button></div>}
    </div>
  </div>;
}

export default function LibraryBrowser({mode,selectedConnection,initialParent,initialKind,initialCategory, ...props}:Props&{mode:LibraryMode;selectedConnection:Connection|null;initialParent?:MediaItem;initialKind?:string;initialCategory?:string}) {
  const sources=useMemo(()=>librarySources(props.connections),[props.connections]);
  const [filterId,setFilterId]=useState(''),[draft,setDraft]=useState(props.query),[query,setQuery]=useState(props.query),[refresh,setRefresh]=useState(0),[detail,setDetail]=useState<LibraryShelf|null>(null);
  const lastRefresh=useRef(refresh);
  const [shelves,setShelves]=useState<Record<string,LibraryShelf[]>>({}),[errors,setErrors]=useState<Record<string,string>>({}),[pending,setPending]=useState<string[]>([]);
  useEffect(()=>{const t=setTimeout(()=>setQuery(draft),300);return()=>clearTimeout(t);},[draft]);
  useEffect(()=>setDraft(props.query),[props.query]);
  useEffect(()=>{
    if(mode==='catalog')return;
    const force=refresh!==lastRefresh.current;lastRefresh.current=refresh;
    const controller=new AbortController(), available=sources.filter(c=>!filterId||filterId==='iptv'&&isIptv(c)||c.id===filterId);
    setShelves(previous=>Object.fromEntries(available.filter(c=>previous[c.id]).map(c=>[c.id,previous[c.id]])));setErrors({});setPending(available.map(c=>c.id));
    for(const c of available) void unifiedShelves(c,mode,<T,>(path:string,signal:AbortSignal)=>api<T>(path,undefined,undefined,signal),controller.signal,force).then(rows=>{if(!controller.signal.aborted){if(force)invalidateHomePreview(c.id);setShelves(s=>({...s,[c.id]:rows}));}}).catch(e=>{if(!controller.signal.aborted)setErrors(s=>({...s,[c.id]:errorMessage(e)}));}).finally(()=>{if(!controller.signal.aborted)setPending(p=>p.filter(id=>id!==c.id));});
    return()=>controller.abort();
  },[mode,sources,filterId,refresh]);
  const bundle = (connection:Connection,wanted?:string,category?:string,onBack?:()=>void) => <IptvBundleBrowser connections={props.connections} library={props.library} onStar={props.onStar} onOpen={props.onOpen} onConnect={props.onConnect} query={props.query} initialConnection={connection} initialKind={wanted} initialCategory={category} onBack={onBack} renderItems={(items,onOpen)=><Grid items={items} props={props} onOpen={onOpen}/>} renderParent={(parent,back)=>{const c=props.connections.find(c=>c.id===parent.connectionId);return c?<SourceBrowser key={`${c.id}:${parent.id}`} connection={c} initialParent={parent} initialKind="series" props={props} onBack={back}/>:null;}}/>;
  if(mode==='catalog'&&selectedConnection) return <section className="page-section library-page">{isIptv(selectedConnection)&&!initialParent?bundle(selectedConnection,initialKind,initialCategory):selectedConnection.type==='plex'?<PlexBrowser key={`${selectedConnection.id}:${initialParent?.id||''}`} connection={selectedConnection} initialParent={initialParent} props={props}/>:<SourceBrowser key={`${selectedConnection.id}:${initialParent?.id||''}:${initialKind}`} connection={selectedConnection} initialParent={initialParent} initialKind={initialKind} initialCategory={initialCategory} props={props}/>}</section>;
  if(detail) return <section className="page-section library-page">{isIptv(detail.connection)?bundle(detail.connection,detail.kind,undefined,()=>setDetail(null)):<SourceBrowser key={detail.id} connection={detail.connection} initialParent={detail.parent} initialKind={detail.kind} initialCategory={detail.category} props={props} onBack={()=>setDetail(null)}/>}</section>;
  const allShelves=bundleIptvShelves(sources.flatMap(c=>shelves[c.id]||[]));
  // Channels DVR gets a real TV guide in Live TV; other live sources keep their shelves below it.
  const guideConnections=mode==='live'?sources.filter(c=>c.type==='channels'&&c.configured!==false&&(!c.access||c.access.kinds.includes('live'))&&(!filterId||c.id===filterId)):[];
  const matches=(i:MediaItem)=>!query||`${i.title} ${i.subtitle||''}`.toLowerCase().includes(query.toLowerCase());
  const visible=filterYouTubeShelves(allShelves,props.hideYouTubeShorts||false,props.connections,props.library.progress).map(s=>({...s,items:s.items.filter(matches)})).filter(s=>s.items.length);
  return <section className="page-section library-page"><div className="library-layout">
    <aside className="library-sidebar" aria-label="Library sources"><div className="sidebar-label">Your sources</div><button className={`sidebar-link ${!filterId?'selected':''}`} onClick={()=>setFilterId('')}>All connections</button>{sources.some(isIptv)&&<button className={`sidebar-link ${filterId==='iptv'?'selected':''}`} onClick={()=>setFilterId('iptv')}><Radio size={18}/>IPTV</button>}{sources.filter(c=>!isIptv(c)).map(c=><button className={`sidebar-link ${filterId===c.id?'selected':''}`} key={c.id} onClick={()=>setFilterId(c.id)}>{c.type==='plex'?<Film size={18}/>:<Folder size={18}/>} {c.name}</button>)}</aside>
    <div className="library-main"><div className="library-heading"><div><span className="eyebrow">YOUR COLLECTION, TOGETHER</span><h1>{mode==='series'?'TV shows':mode==='live'?'Live TV':'Movies'}</h1><p>Browse your collection by connection.</p></div><RefreshButton label="Refresh all libraries" onRefresh={()=>setRefresh(n=>n+1)}/></div>
      <SearchBox query={draft} onChange={setDraft}/>
      {sources.map(c=>errors[c.id]&&<div className="home-source-status" role="status" key={c.id}><div><strong>{c.name}</strong><p>{errors[c.id]}</p></div></div>)}
      {guideConnections.length>0&&<Suspense fallback={<Busy label="Loading the TV guide…"/>}><ChannelsGuide connections={guideConnections} library={props.library} onOpen={props.onOpen} onFavorite={props.onFavorite}/></Suspense>}
      {visible.map(s=><Row key={s.id} title={s.title} items={s.items} onOpen={props.onOpen} onFavorite={props.onFavorite} isSaved={i=>saved(props.library,i)} progress={i=>progress(props.library,i)} more={()=>setDetail(s)}/>)}
      {pending.length>0&&<Busy label="Loading connected libraries…"/>}
      {!pending.length&&!visible.length&&!guideConnections.length&&<Empty title={query?'No matching titles':'No titles available'} action={<button className="button ghost" onClick={props.onConnect}>Connections<ArrowRight size={16}/></button>}>{props.hideYouTubeShorts&&allShelves.some(s=>s.items.some(matches))?'Short videos are hidden. Change this in Settings or browse another library.':query?'Search within a source to search its complete library.':'Choose a connection or library to browse.'}</Empty>}
    </div>
  </div></section>;
}
