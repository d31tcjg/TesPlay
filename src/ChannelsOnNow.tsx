import './channels-guide.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Star, Tv } from 'lucide-react';
import { api, errorMessage } from './api';
import { Busy, Empty } from './components';
import type { Connection, Library, MediaItem } from './types';
import { airingProgress, channelFavorite, filterChannels, formatClock, isCurrent, liveItem, ROW_HEIGHT, visibleRows } from './channels-guide';
import type { GuideChannel, GuideFilter, GuideResponse } from './channels-guide';

export const emptyFilter: GuideFilter = { source: '', favorites: false, query: '' };

/** Source chips, Favorites chip and search: shared by the grid and the On now list. */
export function ChannelFilterBar({ sources, filter, onChange, children }: { sources: string[]; filter: GuideFilter; onChange: (f: GuideFilter) => void; children?: React.ReactNode }) {
  const chip = (label: string, selected: boolean, set: () => void, icon?: React.ReactNode) =>
    <button key={label} type="button" className={`cg-chip ${selected ? 'selected' : ''}`} aria-pressed={selected} onClick={set}>{icon}{label}</button>;
  return <div className="cg-filters">
    <div className="cg-chips" role="group" aria-label="Channel filters">
      {chip('All', !filter.source && !filter.favorites, () => onChange({ ...filter, source: '', favorites: false }))}
      {sources.map(s => chip(s, filter.source === s, () => onChange({ ...filter, source: filter.source === s ? '' : s, favorites: false })))}
      {chip('Favorites', filter.favorites, () => onChange({ ...filter, favorites: !filter.favorites, source: '' }), <Star size={15} />)}
    </div>
    <label className="cg-search"><Search size={18} /><input aria-label="Search channels and programs" placeholder="Search channels or programs" value={filter.query} onChange={e => onChange({ ...filter, query: e.target.value })} /></label>
    {children}
  </div>;
}

/** Re-render on a single coarse timer instead of per-cell timers. */
export function useNowSeconds(intervalMs = 30000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') setNow(Math.floor(Date.now() / 1000)); }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function ChannelLogo({ channel }: { channel: Pick<GuideChannel, 'logo' | 'number'> }) {
  return <span className="cg-logo" aria-hidden="true">{channel.logo ? <img src={channel.logo} alt="" loading="lazy" decoding="async" /> : <Tv size={20} />}</span>;
}

export default function ChannelsOnNow({ connection, library, onOpen, onFavorite, embedded = false }: {
  connection: Connection; library: Library; onOpen: (item: MediaItem) => void; onFavorite: (item: MediaItem) => void; embedded?: boolean;
}) {
  const [data, setData] = useState<GuideResponse>(), [error, setError] = useState(''), [filter, setFilter] = useState<GuideFilter>(emptyFilter);
  const [scrollTop, setScrollTop] = useState(0), list = useRef<HTMLDivElement>(null), frame = useRef<number>(0);
  const now = useNowSeconds();
  useEffect(() => {
    const controller = new AbortController();
    const load = () => api<GuideResponse>(`/channels/${encodeURIComponent(connection.id)}/now`, undefined, undefined, controller.signal)
      .then(r => { if (!controller.signal.aborted) { setData(r); setError(''); } })
      .catch(e => { if (!controller.signal.aborted) setError(errorMessage(e)); });
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [connection.id]);
  useEffect(() => {
    const update = () => { frame.current = 0; const rect = list.current?.getBoundingClientRect(); if (rect) setScrollTop(Math.max(0, -rect.top)); };
    const onScroll = () => { if (!frame.current) frame.current = window.requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true }); window.addEventListener('resize', onScroll);
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); if (frame.current) window.cancelAnimationFrame(frame.current); };
  }, [data]);
  const favoriteIds = useMemo(() => new Set(library.favorites.filter(i => i.connectionId === connection.id && i.type === 'live').map(i => i.id)), [library.favorites, connection.id]);
  const sources = useMemo(() => [...new Set((data?.channels || []).map(c => c.source).filter((s): s is string => !!s))].sort(), [data]);
  const rows = useMemo(() => filterChannels(data?.channels || [], filter, favoriteIds, now), [data, filter, favoriteIds, now]);
  const window_ = visibleRows(scrollTop, typeof window === 'undefined' ? 800 : window.innerHeight, rows.length, ROW_HEIGHT, 6);
  return <section className={`cg-onnow ${embedded ? 'embedded' : ''}`} aria-label="On now">
    <ChannelFilterBar sources={sources} filter={filter} onChange={setFilter} />
    {error && <div className="form-error" role="alert">{error}</div>}
    {!data && !error ? <Busy label="Loading what's on…" /> : data && !rows.length ? <Empty title="No channels match">Clear the filter or search to see all channels.</Empty> :
      <div className="cg-onnow-list" ref={list} style={{ height: rows.length * ROW_HEIGHT }}>
        <ul style={{ transform: `translateY(${window_.offset}px)` }}>
          {rows.slice(window_.start, window_.end).map(channel => {
            const current = channel.airings.find(a => isCurrent(a, now)) || channel.airings[0];
            const item = liveItem(connection, channel), starred = channelFavorite(library.favorites, connection.id, channel.id);
            return <li key={channel.id} className="cg-onnow-row" style={{ height: ROW_HEIGHT }}>
              <button type="button" className="cg-onnow-play" onClick={() => onOpen(item)} aria-label={`Watch ${channel.number} ${channel.name}${current ? `, ${current.title}` : ''}`}>
                <ChannelLogo channel={channel} />
                <span className="cg-onnow-channel"><strong>{channel.number}</strong><small>{channel.name}</small></span>
                <span className="cg-onnow-program">
                  <span className="cg-onnow-title">{current ? current.title : 'No program information'}{current?.isNew && <em className="cg-badge">New</em>}{current?.isLive && <em className="cg-badge live">Live</em>}</span>
                  {current && <span className="cg-progress" aria-hidden="true"><span style={{ width: `${airingProgress(current, now)}%` }} /></span>}
                  {channel.next && <small className="cg-next">Next: {channel.next.title} · {formatClock(channel.next.start)}</small>}
                </span>
              </button>
              <button type="button" className={`cg-star ${starred ? 'selected' : ''}`} aria-pressed={starred} aria-label={`${starred ? 'Remove' : 'Add'} ${channel.name} ${starred ? 'from' : 'to'} favorites`} onClick={() => onFavorite(item)}><Star size={18} fill={starred ? 'currentColor' : 'none'} /></button>
            </li>;
          })}
        </ul>
      </div>}
  </section>;
}
