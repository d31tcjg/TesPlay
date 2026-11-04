import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Film, Radio, Search, Star, Tv } from 'lucide-react';
import { api, errorMessage } from './api';
import { Busy, Empty, RefreshButton } from './components';
import { invalidateHomePreview } from './home-library';
import { bundleIptvCategories, bundleIptvItems, isIptv, supportsIptvKind } from './iptv-library';
import type { IptvCategory } from './iptv-library';
import type { CatalogResult } from './library-browser';
import type { Connection, Library, MediaItem, Starred } from './types';

const kinds = [['live', 'Live TV', Radio], ['movie', 'Movies', Film], ['series', 'TV shows', Tv]] as const;
export default function IptvBundleBrowser({ connections: allConnections, library, onStar, onOpen, onConnect, query: globalQuery,
  renderItems, renderParent, initialKind = 'all', initialConnection, initialCategory = '', onBack }: {
  connections: Connection[]; library: Library; onStar: (s:Starred) => void; onOpen: (item:MediaItem) => void;
  onConnect: () => void; query: string; initialKind?: string; initialConnection?: Connection; initialCategory?: string; onBack?: () => void;
  renderItems: (items:MediaItem[], onOpen:(item:MediaItem) => void) => ReactNode;
  renderParent: (parent:MediaItem, onBack:() => void) => ReactNode;
}) {
  const connections = allConnections.filter(isIptv);
  const [kind,setKind] = useState(initialKind !== 'all' ? initialKind : kinds.find(([id]) => connections.some(c => supportsIptvKind(c,id)))?.[0] || 'live');
  const [category,setCategory] = useState<IptvCategory | null>(initialCategory && initialConnection ? {name:'Selected category',sources:[{connectionId:initialConnection.id,id:initialCategory}]} : null);
  const [draft,setDraft] = useState(globalQuery), [query,setQuery] = useState(globalQuery), [page,setPage] = useState(1), [refresh,setRefresh] = useState(0);
  const [results,setResults] = useState<Record<string,CatalogResult>>({}), [categoryResults,setCategoryResults] = useState<Record<string,CatalogResult>>({});
  const [errors,setErrors] = useState<string[]>([]), [busy,setBusy] = useState(true), [parent,setParent] = useState<MediaItem | null>(null);
  const lastRefresh = useRef(refresh);
  useEffect(() => { const t=setTimeout(() => {setQuery(draft);setPage(1);},300);return () => clearTimeout(t); },[draft]);
  useEffect(() => setDraft(globalQuery),[globalQuery]);
  useEffect(() => setCategoryResults({}),[allConnections,kind]);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setErrors([]); setResults({});
    const force = refresh !== lastRefresh.current; lastRefresh.current = refresh;
    const available = allConnections.filter(c => supportsIptvKind(c,kind) && (!category || category.sources.some(s => s.connectionId === c.id)));
    const requests = available.map(async c => {
      const selected = category?.sources.filter(s => s.connectionId === c.id);
      const batches = await Promise.all((selected?.length ? selected : [undefined]).map(source => {
        const params = new URLSearchParams({ connectionId:c.id, kind, q:query, page:String(page), limit:'60', ...(source ? {category:source.id} : {}), ...(force ? {refresh:'1'} : {}) });
        return api<CatalogResult>(`/catalog?${params}`,undefined,undefined,controller.signal);
      }));
      const result:CatalogResult = {
        items: [...new Map(batches.flatMap(r => r.items).map(item => [`${item.type}:${item.id}`,item])).values()],
        categories: batches[0]?.categories, hasMore: batches.some(r => r.hasMore),
      };
      if (controller.signal.aborted) return;
      if (force) invalidateHomePreview(c.id);
      setResults(previous => ({...previous,[c.id]:result}));
      setCategoryResults(previous => ({...previous,[c.id]:result}));
    });
    void Promise.allSettled(requests).then(outcomes => {
      if (controller.signal.aborted) return;
      setErrors(outcomes.flatMap((r,index) => r.status === 'rejected' ? [`${available[index].name}: ${errorMessage(r.reason)}`] : []));setBusy(false);
    });
    return () => controller.abort();
  },[allConnections,kind,category,query,page,refresh]);
  const choose = (value:IptvCategory | null) => {setCategory(value);setPage(1);};
  const changeKind = (value:string) => {setKind(value);setCategory(null);setCategoryResults({});setDraft('');setPage(1);};
  const items = bundleIptvItems(results), categories = bundleIptvCategories(categoryResults);
  if (parent) return renderParent(parent, () => setParent(null));
  const open = (item:MediaItem) => item.type === 'series' ? setParent(item) : onOpen(item);
  return <div className="library-layout">
    <aside className="library-sidebar" aria-label="IPTV bundle categories"><div className="sidebar-label">IPTV · {connections.length} {connections.length === 1 ? 'connection' : 'connections'}</div>
      {kinds.filter(([id]) => connections.some(c => c.type === 'xtream' && (!c.access || c.access.kinds.includes(id)) || c.type === 'm3u' && id === 'live' && (!c.access || c.access.kinds.includes(id)))).map(([id,title,Icon]) => <button key={id} className={`sidebar-link ${kind === id ? 'selected' : ''}`} onClick={() => changeKind(id)}><Icon size={18}/>{title}</button>)}
      <div className="sidebar-label">Categories</div><button className={`sidebar-link ${!category ? 'selected' : ''}`} onClick={() => choose(null)}>All loaded {kind === 'live' ? 'channels' : 'titles'}</button>
      <div className="sidebar-categories">{categories.map(value => {
        const starred = value.sources.every(source => library.stars?.some(s => s.connectionId === source.connectionId && s.id === source.id && s.kind === 'category'));
        return <div className="sidebar-category" key={value.name}><button className={`sidebar-link ${category?.name === value.name ? 'selected' : ''}`} onClick={() => choose(value)}>{value.name}</button><button className={`category-star icon-button ${starred ? 'selected' : ''}`} aria-pressed={starred} aria-label={`${starred ? 'Unstar' : 'Star'} ${value.name}`} onClick={async () => {
          for (const source of value.sources) if (Boolean(library.stars?.some(s => s.connectionId === source.connectionId && s.id === source.id && s.kind === 'category')) === starred) await onStar({...source,kind:'category',title:value.name});
        }}><Star size={16} fill={starred ? 'currentColor' : 'none'}/></button></div>;
      })}</div>
    </aside>
    <div className="library-main"><div className="library-heading"><div>{onBack && <button className="text-button iptv-library-back" onClick={onBack}><ArrowLeft size={17}/>All sources</button>}<span className="eyebrow">YOUR IPTV, TOGETHER</span><h1>{kinds.find(k => k[0] === kind)?.[1] || 'IPTV'}</h1><p>Selected categories from all your IPTV connections.</p></div><RefreshButton label="Refresh IPTV library" onRefresh={() => setRefresh(value => value + 1)}/></div>
      <div className="library-search"><div className="inline-search"><Search size={18}/><input aria-label="Search this library" value={draft} placeholder="Search IPTV…" onChange={e => setDraft(e.target.value)}/></div></div>
      {errors.map(error => <div className="form-error" role="alert" key={error}>{error}</div>)}
      {items.length > 0 && renderItems(items,open)}{busy && <Busy label="Loading your IPTV bundle…"/>}
      {!busy && !items.length && !errors.length && <Empty title="No titles in this selection" action={<button className="button ghost" onClick={onConnect}>IPTV settings<ArrowRight size={16}/></button>}>Choose categories using the filter icon next to your IPTV connection’s edit button.</Empty>}
      {(page > 1 || Object.values(results).some(r => r.hasMore)) && <div className="pagination"><button className="button ghost" disabled={page === 1 || busy} onClick={() => setPage(value => value - 1)}>Previous</button><span>Page {page}</span><button className="button ghost" disabled={busy || !Object.values(results).some(r => r.hasMore)} onClick={() => setPage(value => value + 1)}>Next<ArrowRight size={16}/></button></div>}
    </div>
  </div>;
}
