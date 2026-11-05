import './channels-guide.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Star, X } from 'lucide-react';
import { api, errorMessage } from './api';
import { Busy, Empty } from './components';
import type { Connection, Library, MediaItem } from './types';
import ChannelsOnNow, { ChannelFilterBar, ChannelLogo, emptyFilter, useNowSeconds } from './ChannelsOnNow';
import {
  CHANNEL_COLUMN, ROW_HEIGHT, WINDOW_HOURS, cellLayout, channelFavorite, channelSources, episodeLabel, filterChannels, formatRange,
  gridWidth, isCurrent, isNarrowLayout, liveItem, mergeGuide, needsNextWindow, nextWindow, nowLineX, scrollForNow, timeTicks, timeToX, visibleRows,
} from './channels-guide';
import type { GuideAiring, GuideChannel, GuideFilter, GuideResponse } from './channels-guide';

const MIN_CELL = 36;
type Selected = { channel: GuideChannel; airing: GuideAiring };
type Airing = { channel: { id: string; number: string; name: string }; airing: GuideAiring };

function useWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return width;
}

function Details({ connection, selected, favorite, onWatch, onFavorite, onClose }: {
  connection: Connection; selected: Selected; favorite: boolean; onWatch: () => void; onFavorite: () => void; onClose: () => void;
}) {
  const { channel, airing } = selected;
  const [full, setFull] = useState<GuideAiring>();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const controller = new AbortController(); setFull(undefined);
    void api<Airing>(`/channels/${encodeURIComponent(connection.id)}/airing?${new URLSearchParams({ channel: channel.number, time: String(airing.start) })}`, undefined, undefined, controller.signal)
      .then(r => { if (!controller.signal.aborted) setFull(r.airing); }).catch(() => { /* The grid data is already enough to show. */ });
    return () => controller.abort();
  }, [connection.id, channel.number, airing.start]);
  useEffect(() => {
    close.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const shown = { ...airing, ...(full || {}) };
  return <div className="cg-sheet-backdrop" onClick={onClose}>
    <div className="cg-sheet" role="dialog" aria-modal="true" aria-label={`${shown.title} details`} onClick={e => e.stopPropagation()}>
      <button ref={close} type="button" className="cg-sheet-close" aria-label="Close details" onClick={onClose}><X size={22} /></button>
      {shown.image && <img className="cg-sheet-image" src={shown.image} alt="" decoding="async" />}
      <div className="cg-sheet-body">
        <span className="eyebrow">{channel.number} · {channel.name}</span>
        <h2>{shown.title}</h2>
        {episodeLabel(shown) && <p className="cg-sheet-episode">{episodeLabel(shown)}</p>}
        <p className="cg-sheet-time">{formatRange(shown)}{shown.isNew && <em className="cg-badge">New</em>}{shown.isLive && <em className="cg-badge live">Live</em>}</p>
        {shown.summary && <p className="cg-sheet-summary">{shown.summary}</p>}
        <div className="cg-sheet-actions">
          <button type="button" className="button primary" onClick={onWatch}>Watch channel</button>
          <button type="button" className="button ghost" aria-pressed={favorite} onClick={onFavorite}><Star size={18} fill={favorite ? 'currentColor' : 'none'} />{favorite ? 'In favorites' : 'Add to favorites'}</button>
        </div>
      </div>
    </div>
  </div>;
}

function Grid({ connection, library, onOpen, onFavorite }: { connection: Connection; library: Library; onOpen: (i: MediaItem) => void; onFavorite: (i: MediaItem) => void }) {
  const [guide, setGuide] = useState<GuideResponse>(), [error, setError] = useState(''), [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState<GuideFilter>(emptyFilter), [selected, setSelected] = useState<Selected>();
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  const now = useNowSeconds(), scroller = useRef<HTMLDivElement>(null), frame = useRef(0), guideRef = useRef<GuideResponse | undefined>(undefined), busy = useRef(false);
  const nowRef = useRef(now); nowRef.current = now;
  guideRef.current = guide;
  const base = `/channels/${encodeURIComponent(connection.id)}`;

  useEffect(() => {
    const controller = new AbortController(); setGuide(undefined); setError('');
    const start = Math.floor(Date.now() / 1000) - 1800;
    void api<GuideResponse>(`${base}/guide?${new URLSearchParams({ start: String(start), hours: String(WINDOW_HOURS) })}`, undefined, undefined, controller.signal)
      .then(r => { if (!controller.signal.aborted) setGuide(r); })
      .catch(e => { if (!controller.signal.aborted) setError(errorMessage(e)); });
    return () => controller.abort();
  }, [base]);

  const jumpToNow = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scroller.current; if (el && guideRef.current) el.scrollTo({ left: scrollForNow(nowRef.current, guideRef.current.start), behavior });
  }, []);
  useEffect(() => { if (guide && !loadingMore && scroller.current && scroller.current.scrollLeft === 0) jumpToNow('auto'); }, [!!guide]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = useCallback(() => {
    const current = guideRef.current; if (!current || busy.current) return;
    const next = nextWindow(current.end, nowRef.current); if (!next) return;
    busy.current = true; setLoadingMore(true);
    void api<GuideResponse>(`${base}/guide?${new URLSearchParams({ start: String(next.start), hours: String(next.hours) })}`)
      .then(r => setGuide(g => g ? mergeGuide(g, r) : r))
      .catch(e => setError(errorMessage(e)))
      .finally(() => { busy.current = false; setLoadingMore(false); });
  }, [base]);

  useEffect(() => {
    const el = scroller.current; if (!el) return;
    const update = () => {
      frame.current = 0;
      setScroll(s => (Math.abs(s.top - el.scrollTop) < 1 && s.height === el.clientHeight ? s : { top: el.scrollTop, height: el.clientHeight }));
      const current = guideRef.current;
      if (current && needsNextWindow(el.scrollLeft, el.clientWidth - CHANNEL_COLUMN, current.start, current.end, nowRef.current)) loadMore();
    };
    const onScroll = () => { if (!frame.current) frame.current = window.requestAnimationFrame(update); };
    update();
    el.addEventListener('scroll', onScroll, { passive: true }); window.addEventListener('resize', onScroll);
    return () => { el.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); if (frame.current) window.cancelAnimationFrame(frame.current); };
  }, [!!guide, loadMore]); // eslint-disable-line react-hooks/exhaustive-deps

  // A loaded window may still leave the viewport near its end (wide screens): keep extending.
  useEffect(() => {
    const el = scroller.current;
    if (el && guide && needsNextWindow(el.scrollLeft, el.clientWidth - CHANNEL_COLUMN, guide.start, guide.end, nowRef.current)) loadMore();
  }, [guide?.end, loadMore]); // eslint-disable-line react-hooks/exhaustive-deps

  const favoriteIds = useMemo(() => new Set(library.favorites.filter(i => i.connectionId === connection.id && i.type === 'live').map(i => i.id)), [library.favorites, connection.id]);
  const sources = useMemo(() => channelSources(guide?.channels || []), [guide]);
  const rows = useMemo(() => filterChannels(guide?.channels || [], filter, favoriteIds, now), [guide, filter, favoriteIds, now]);
  const win = visibleRows(scroll.top, scroll.height, rows.length);
  const width = guide ? gridWidth(guide.start, guide.end) : 0;
  const ticks = useMemo(() => guide ? timeTicks(guide.start, guide.end) : [], [guide?.start, guide?.end]); // eslint-disable-line react-hooks/exhaustive-deps
  const nowX = guide ? nowLineX(now, guide.start) : 0;
  const play = (channel: GuideChannel) => onOpen(liveItem(connection, channel));
  const tap = (channel: GuideChannel, airing: GuideAiring) => (isCurrent(airing, now) ? play(channel) : setSelected({ channel, airing }));

  return <div className="cg-grid-wrap">
    <ChannelFilterBar sources={sources} filter={filter} onChange={setFilter}>
      <button type="button" className="button ghost small cg-now-button" onClick={() => jumpToNow()}><RotateCcw size={16} />Now</button>
    </ChannelFilterBar>
    {error && <div className="form-error" role="alert">{error}</div>}
    {!guide && !error ? <Busy label="Loading the TV guide…" /> : guide && !rows.length ? <Empty title="No channels match">Clear the filter or search to see all channels.</Empty> : guide &&
      <div className="cg-scroller" ref={scroller} role="grid" aria-label={`${connection.name} TV guide`} aria-rowcount={rows.length}>
        <div className="cg-canvas" style={{ width: CHANNEL_COLUMN + width, height: 44 + rows.length * ROW_HEIGHT }}>
          <div className="cg-header" role="row">
            <div className="cg-corner" style={{ width: CHANNEL_COLUMN }} />
            <div className="cg-ticks" style={{ width }}>
              {ticks.map(t => <span key={t} className={t % 3600 === 0 ? 'hour' : ''} style={{ left: timeToX(t, guide.start) }}>{new Date(t * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>)}
            </div>
          </div>
          <div className="cg-body" style={{ transform: `translateY(${win.offset}px)` }}>
            {rows.slice(win.start, win.end).map((channel, index) => {
              const starred = channelFavorite(library.favorites, connection.id, channel.id);
              return <div key={channel.id} className="cg-row" role="row" aria-rowindex={win.start + index + 1} style={{ height: ROW_HEIGHT, width: CHANNEL_COLUMN + width }}>
                <div className="cg-channel" style={{ width: CHANNEL_COLUMN }}>
                  <button type="button" className="cg-channel-play" aria-label={`Watch ${channel.number} ${channel.name}`} onClick={() => play(channel)}>
                    <ChannelLogo channel={channel} /><span className="cg-channel-text"><strong>{channel.number}</strong><small>{channel.name}</small></span>
                  </button>
                  <button type="button" className={`cg-star ${starred ? 'selected' : ''}`} aria-pressed={starred} aria-label={`${starred ? 'Remove' : 'Add'} ${channel.name} ${starred ? 'from' : 'to'} favorites`} onClick={() => onFavorite(liveItem(connection, channel))}><Star size={16} fill={starred ? 'currentColor' : 'none'} /></button>
                </div>
                <div className="cg-programs" style={{ width }}>
                  {channel.airings.map(airing => {
                    const { left, width: w } = cellLayout(airing, guide.start, guide.end);
                    if (w <= 0) return null;
                    return <button key={airing.start} type="button" role="gridcell" className={`cg-cell ${isCurrent(airing, now) ? 'current' : ''}`}
                      style={{ left, width: Math.max(MIN_CELL, w - 2) }} onClick={() => tap(channel, airing)}
                      aria-label={`${airing.title}, ${formatRange(airing)}${isCurrent(airing, now) ? ', on now' : ''}`}>
                      <span className="cg-cell-title">{airing.title}</span>
                      <span className="cg-cell-meta">{formatRange(airing)}{airing.isNew ? ' · New' : ''}{airing.isLive ? ' · Live' : ''}</span>
                    </button>;
                  })}
                  {!channel.airings.length && <span className="cg-empty-cell" style={{ left: 0, width }}>No program information</span>}
                </div>
              </div>;
            })}
          </div>
          {nowX >= 0 && nowX <= width && <div className="cg-nowline" aria-hidden="true" style={{ left: CHANNEL_COLUMN + nowX }} />}
        </div>
      </div>}
    {loadingMore && <p className="cg-loading-more" role="status">Loading later programs…</p>}
    {selected && <Details connection={connection} selected={selected} favorite={channelFavorite(library.favorites, connection.id, selected.channel.id)}
      onWatch={() => { play(selected.channel); setSelected(undefined); }} onFavorite={() => onFavorite(liveItem(connection, selected.channel))} onClose={() => setSelected(undefined)} />}
  </div>;
}

/** Live TV guide for one or more Channels DVR connections: grid on wide screens, On now list on narrow ones. */
export default function ChannelsGuide({ connections, library, onOpen, onFavorite }: {
  connections: Connection[]; library: Library; onOpen: (i: MediaItem) => void; onFavorite: (i: MediaItem) => void;
}) {
  const [id, setId] = useState(connections[0]?.id || '');
  const width = useWidth();
  const connection = connections.find(c => c.id === id) || connections[0];
  if (!connection) return null;
  return <section className="cg-guide" aria-label="TV guide">
    <div className="section-heading"><h2>TV guide</h2>
      {connections.length > 1 && <div className="cg-chips" role="group" aria-label="Channels DVR servers">
        {connections.map(c => <button key={c.id} type="button" className={`cg-chip ${c.id === connection.id ? 'selected' : ''}`} aria-pressed={c.id === connection.id} onClick={() => setId(c.id)}>{c.name}</button>)}
      </div>}
    </div>
    {isNarrowLayout(width)
      ? <ChannelsOnNow key={connection.id} connection={connection} library={library} onOpen={onOpen} onFavorite={onFavorite} />
      : <Grid key={connection.id} connection={connection} library={library} onOpen={onOpen} onFavorite={onFavorite} />}
  </section>;
}
