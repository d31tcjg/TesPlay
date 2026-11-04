import './home.css';
import { RefreshButton } from "./components";
import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Info, Check, Plus, ArrowUpRight, Cable } from 'lucide-react';
import { api } from './api';
import { Busy, Card, Empty, Row, YouTubeLogo } from './components';
import { services } from './catalog';
import { itemKey } from './types';
import type { Connection, Library, MediaItem } from './types';
import { bundleIptvHomeShelves, homeFeatures, loadHomeConnection, mergeHomeResult, readHomePreview, writeHomePreview } from './home-library';
import type { HomeCatalog, HomeResult, HomeShelf } from './home-library';
import { filterLibraryForYouTubeVisibility, filterYouTubeShelves } from './youtube-visibility';
export default function Home({ cacheIdentity, connections, library: rawLibrary, hideYouTubeShorts = false, signedIn, query, connectionsReady, connectionsError, onReloadConnections, canManage, onOpen, onFavorite, onDetails, onBrowse, onConnect, onNavigate, onUnavailable }: {
  cacheIdentity:string; connections: Connection[]; library: Library; hideYouTubeShorts?: boolean; signedIn: boolean; query: string; connectionsReady: boolean; connectionsError: string; onReloadConnections: () => Promise<void>; canManage: boolean;
  onOpen: (item: MediaItem) => void; onFavorite: (item: MediaItem) => void; onDetails: (item: MediaItem) => void;
  onBrowse: (c: Connection, parent?: MediaItem, kind?: string, channel?: {id:string;title:string}, category?:string) => void; onConnect: (type?: string) => void;
  onNavigate: (view: 'connections' | 'movies' | 'apps' | 'list') => void; onUnavailable: () => void;
}) {
  const library = useMemo(() => filterLibraryForYouTubeVisibility(rawLibrary, hideYouTubeShorts, connections), [rawLibrary, hideYouTubeShorts, connections]);
  const [results, setResults] = useState<Record<string, HomeResult>>({});
  const [pending, setPending] = useState<string[]>([]), [refresh, setRefresh] = useState(0), [heroIndex, setHeroIndex] = useState(0), [heroPaused,setHeroPaused]=useState(false);
  const lastRefresh=useRef(refresh);
  const starredChannelsKey=(library.stars||[]).map(s=>`${s.connectionId}:${s.id}`).join(',');
  const connected = signedIn && connections.length > 0;
  useEffect(() => {
    const controller = new AbortController();
    if (!connected) { setResults({}); setPending([]); return () => controller.abort(); }
    const force=refresh!==lastRefresh.current;lastRefresh.current=refresh;
    const cachedResults:Record<string,HomeResult>={};
    for(const c of connections)try{const value=readHomePreview(cacheIdentity,c,library.stars||[],sessionStorage);if(value)cachedResults[c.id]=value;}catch{/* Storage may be disabled. */}
    setResults(previous => Object.fromEntries(connections.filter(c => cachedResults[c.id]||force&&previous[c.id]).map(c => [c.id, cachedResults[c.id]||previous[c.id]])));
    const requested=connections.filter(c=>force||!cachedResults[c.id]);
    setPending(requested.map(c => c.id));
    for (const c of requested) void loadHomeConnection(c, (path, signal) => api<HomeCatalog>(path, undefined, undefined, signal), controller.signal, library.stars || [], force)
      .then(result => { if (!controller.signal.aborted) setResults(previous => {
        const merged=mergeHomeResult(previous[c.id],result);
        try{writeHomePreview(cacheIdentity,c,library.stars||[],merged,sessionStorage);}catch{/* Storage may be disabled. */}
        return { ...previous, [c.id]: merged };
      }); })
      .finally(() => { if (!controller.signal.aborted) setPending(previous => previous.filter(id => id !== c.id)); })
      .catch(() => { /* An aborted request belongs to the previous home/profile. */ });
    return () => controller.abort();
  }, [cacheIdentity, connected, connections, refresh, starredChannelsKey]);
  const visibleResults = useMemo(() => Object.fromEntries(Object.entries(results).map(([id, result]) => [id, {
    ...result, shelves: filterYouTubeShelves(result.shelves, hideYouTubeShorts, connections, rawLibrary.progress),
  }])), [results, hideYouTubeShorts, connections, rawLibrary.progress]);
  const shelves = useMemo(() => bundleIptvHomeShelves(connections.flatMap(c => visibleResults[c.id]?.shelves || []),connections), [connections, visibleResults]);
  const featured = useMemo(() => connected ? homeFeatures(shelves) : [], [connected, shelves]);
  useEffect(()=>{if(featured.length<2||heroPaused||query||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;const timer=window.setInterval(()=>{if(document.visibilityState==='visible')setHeroIndex(index=>(index+1)%featured.length);},8000);return()=>window.clearInterval(timer);},[featured.length,heroPaused,query]);
  const hero = featured[heroIndex % Math.max(1, featured.length)];
  const favorites = new Set([...library.favorites,...(library.queue||[])].map(itemKey));
  const progress = new Map(library.progress.map(p => [itemKey(p.item), p.duration ? p.seconds / p.duration * 100 : 0]));
  const continuing = library.progress.filter(p => p.duration > 0 && p.seconds > 5 && p.seconds / p.duration < 0.97).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12);
  const viewAll = (shelf: HomeShelf) => { const c = connections.find(c => c.id === shelf.connectionId); if (c) onBrowse(c, shelf.parent, shelf.kind, shelf.channel, shelf.category); };
  const searchItems = [...new Map([...(connected ? shelves.flatMap(s => s.items) : []), ...library.favorites, ...library.progress.map(p => p.item)].map(i => [itemKey(i), i])).values()]
    .filter(i => `${i.title} ${i.categoryLabel || ''} ${i.source} ${i.subtitle || ''}`.toLowerCase().includes(query.toLowerCase()));
  const currentHeroIndex = featured.length ? heroIndex % featured.length : 0;
  if (signedIn && (!connectionsReady || (connectionsError && !connections.length))) return <section className="page-section home-loading">
    <span className="eyebrow">Your library</span><h1>Your collection, together</h1>
    {connectionsError ? <div className="home-source-status" role="alert"><div><strong>Your connections could not load</strong><p>{connectionsError}</p></div><button className="button ghost" onClick={() => void onReloadConnections().catch(() => {})}>Try again</button></div> : <Busy label="Loading your connections…" />}
  </section>;
  return <>
    {query ? <section className="page-section">
      <div className="page-heading"><div><span className="eyebrow">Your library</span><h1>Results for “{query}”</h1><p>Search within a connected library for its complete collection</p></div></div>
      {pending.length > 0 && <Busy label="Loading your connected libraries…" />}
      {searchItems.length ? <div className="catalog-grid">{searchItems.map(item => <Card key={itemKey(item)} item={item} onOpen={onOpen} onFavorite={onFavorite} saved={favorites.has(itemKey(item))} progress={progress.get(itemKey(item))} />)}</div> : !pending.length && <Empty title="No matches in your home collection">Browse a connected library to search all its titles.</Empty>}
    </section> : <>
      {hero ? <section className="hero" aria-label="Featured from your libraries"
        onPointerEnter={() => setHeroPaused(true)} onPointerLeave={() => setHeroPaused(false)}
        onFocusCapture={() => setHeroPaused(true)} onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget)) setHeroPaused(false); }}
        style={{ backgroundImage: hero.backdrop || hero.poster ? `url(${hero.backdrop || hero.poster})` : undefined }}>
        <div className="hero-vignette" />
        <div className="hero-content">
          <div className="hero-kicker">Featured from {hero.source}</div>
          <h1 title={hero.title} className={hero.title.length > 55 ? 'very-long-title' : hero.title.length > 25 ? 'long-title' : ''}>{Array.from(hero.title).length > 90 ? Array.from(hero.title).slice(0, 87).join('').trimEnd() + '…' : hero.title}</h1>
          <div className="hero-meta">
            {hero.year && <span>{hero.year}</span>}
            {!!hero.duration && <span>{Math.round(hero.duration / 60)} min</span>}
            {hero.type === 'live' && <span className="quality-label">Live</span>}
            <span>{hero.categoryLabel || hero.subtitle || hero.category?.split(' · ')[0]}</span>
          </div>
          <p>{hero.description || (hero.type === 'series' ? 'Explore the episodes in your collection.' : `Ready to watch from ${hero.source}.`)}</p>
          <div className="hero-actions">
            <button className="button primary" onClick={() => onOpen(hero)}><Play size={18} fill="currentColor" />{hero.type === 'series' ? 'Play series' : hero.type === 'live' ? 'Watch live' : 'Play now'}</button>
            <button className="button ghost" onClick={() => onDetails(hero)}><Info size={18} />More info</button>
          </div>
        </div>
        <div className="hero-bottom">
          <button className="text-button hero-save" onClick={() => onFavorite(hero)} aria-label={favorites.has(itemKey(hero)) ? 'Remove featured title from My list' : 'Add featured title to My list'}>{favorites.has(itemKey(hero)) ? <Check size={18} /> : <Plus size={18} />}{favorites.has(itemKey(hero)) ? 'In My list' : 'Add to My list'}</button>
          <div className="hero-pages">
            <span>{currentHeroIndex + 1}<small> / {featured.length}</small></span>
            <div>{featured.map((item, index) => <button key={itemKey(item)} className={currentHeroIndex === index ? 'selected' : ''} aria-label={`Feature ${item.title}`} aria-pressed={currentHeroIndex === index} onClick={() => setHeroIndex(index)}><span /></button>)}</div>
          </div>
        </div>
      </section> : <section className="page-section home-loading">
        <span className="eyebrow">Your collection, together</span>
        <h1>{connections.length ? 'Your library' : 'Your libraries. One screen.'}</h1>
        {pending.length ? <Busy label="Loading your collection…" /> : <p>{connections.length ? 'No featured titles yet. Browse a connection below.' : canManage ? 'Bring your films, shows and channels into TesPlay. Start with a library below.' : 'Your server owner can share connections with your account.'}</p>}
      </section>}
      <div className="home-content">
        <section className="worlds">
          <div className="section-heading"><h2>Your libraries</h2><div className="row-actions">{connected && <RefreshButton label="Refresh home libraries" disabled={pending.length > 0} onRefresh={() => setRefresh(value => value + 1)} />}<button className="text-button" onClick={() => onNavigate('connections')}>{canManage ? 'Manage connections' : 'Shared connections'} <ArrowUpRight size={16} /></button></div></div>
          <div className="service-rail">{services.filter(s => canManage || connections.some(c => c.type === s.id || s.id === 'xtream' && c.type === 'm3u')).map(s => {
            const c = connections.find(c => c.type === s.id || (s.id === 'xtream' && c.type === 'm3u'));
            return <button key={s.id} className={`service-tile service-${s.id}`} onClick={() => s.id === 'crunchyroll' ? onUnavailable() : s.id === 'youtube' ? onNavigate('apps') : c ? onBrowse(c) : onConnect(s.id)}>
              <span className={`service-logo ${s.id}`} style={{ color: s.color }}>{s.id === 'youtube' ? <YouTubeLogo /> : s.letters}</span>
              <span className="service-copy"><span className="service-label">{s.name}</span><span className="service-state">{s.id === 'crunchyroll' ? 'Unavailable' : c ? 'Connected' : s.id === 'youtube' ? 'Browse videos' : 'Connect'}</span></span>
              {c ? <Check size={16} /> : <ArrowUpRight size={16} />}
            </button>;
          })}</div>
        </section>
        {continuing.length > 0 && <Row presentation="continue" title="Continue watching" items={continuing.map(p => p.item)} onOpen={onOpen} onFavorite={onFavorite} isSaved={i => favorites.has(itemKey(i))} progress={i => progress.get(itemKey(i))} />}
        {connected ? connections.map(c => <div key={c.id}>
          {visibleResults[c.id]?.issues.map((issue, index) => <div className="home-source-status" role="status" key={index}><div><strong>{c.type === 'youtube' ? 'YouTube' : c.name}</strong><p>{issue}</p></div><button className="text-button" onClick={() => onBrowse(c)}>Open connection <ArrowUpRight size={16} /></button></div>)}
          {!pending.includes(c.id) && visibleResults[c.id] && !visibleResults[c.id].issues.length && !visibleResults[c.id].shelves.some(s => s.items.length) && <div className="home-source-status"><div><strong>{c.type === 'youtube' ? 'YouTube' : c.name}</strong><p>{hideYouTubeShorts && results[c.id]?.shelves.some(s => s.items.length) ? 'Short videos are hidden. Change this in Settings or browse another library.' : c.type === 'youtube' ? 'Star subscriptions in YouTube to show their latest uploads here.' : 'No titles in this preview yet.'}</p></div><button className="text-button" onClick={() => onBrowse(c)}>Browse library <ArrowUpRight size={16} /></button></div>}
        </div>) : canManage ? null : <Empty title="No libraries shared yet">Your server owner can share connections with your account.</Empty>}
        {connected && shelves.filter(s => s.items.length).map(shelf => <Row key={shelf.id} title={shelf.title} items={shelf.items} onOpen={onOpen} onFavorite={onFavorite} isSaved={i => favorites.has(itemKey(i))} progress={i => progress.get(itemKey(i))} more={() => viewAll(shelf)} />)}
        {library.favorites.length > 0 && <Row title="My list" items={library.favorites} onOpen={onOpen} onFavorite={onFavorite} isSaved={i => favorites.has(itemKey(i))} more={() => onNavigate('list')} />}
        <div className="discovery-row"><button onClick={() => onNavigate('apps')} className="discovery-card"><YouTubeLogo /><div><span className="small-caps">YouTube</span><h3>Your channels, on this screen</h3><p>Browse subscriptions or play a video link</p></div><ArrowUpRight size={20} /></button></div>
        {canManage && !connections.length && <div className="connect-banner"><div><Cable size={24} /><div><h3>Add your first library</h3><p>Connect Plex, IPTV, Google Drive or Stremio</p></div></div><button className="button ghost" onClick={() => onNavigate('connections')}>Add a connection <Plus size={18} /></button></div>}
      </div>
    </>}
  </>;
}
