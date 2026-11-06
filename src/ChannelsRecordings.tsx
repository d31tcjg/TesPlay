import './channels-recordings.css';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Check, Film, Play } from 'lucide-react';
import { api, errorMessage } from './api';
import { Busy, Empty, MediaDetailsContext } from './components';
import { itemKey } from './types';
import type { Connection, Library, MediaItem } from './types';
import { LOAD_MORE_MARGIN, RECORDINGS_FOLDER_ID, RECORDINGS_PAGE_SIZE, mergePage, recordingRow, shouldLoadMore } from './channels-recordings';
import type { RecordingItem, RecordingsPage } from './channels-recordings';

function Thumb({ item }: { item: MediaItem }) {
  const [failed, setFailed] = useState(false);
  const src = item.backdrop || item.poster;
  return <span className="cr-thumb">{src && !failed ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} /> : <Film size={24} aria-hidden="true" />}</span>;
}

function RecordingRowView({ item, library, onOpen }: { item: RecordingItem; library: Library; onOpen: (i: MediaItem) => void }) {
  const details = useContext(MediaDetailsContext);
  const saved = library.progress.find(p => itemKey(p.item) === itemKey(item));
  const row = recordingRow(item, { libraryPercent: saved?.duration ? saved.seconds / saved.duration * 100 : undefined });
  const hasDetails = !!details;
  return <li className={`cr-row${row.watched ? ' watched' : ''}`}>
    <button type="button" className="cr-main" onClick={() => hasDetails ? details!.onDetails(item) : onOpen(item)}
      aria-label={`${hasDetails ? 'Details for' : 'Play'} ${row.title}${row.subtitle ? `, ${row.subtitle}` : ''}${row.watched ? ', watched' : ''}`}>
      <Thumb item={item} />
      <span className="cr-text">
        <span className="cr-title">{row.title}</span>
        {row.subtitle && <span className="cr-subtitle">{row.subtitle}</span>}
        <span className="cr-meta">{row.when && <time dateTime={item.recordedAt || item.addedAt}>{row.when}</time>}{row.channel && <span className="cr-channel">{row.channel}</span>}{row.duration && <span>{row.duration}</span>}</span>
        {row.progress !== undefined && <span className="cr-progress" role="img" aria-label={`${Math.round(row.progress)}% watched`}><span style={{ width: `${row.progress}%` }} /></span>}
      </span>
      {row.watched && <span className="cr-check" aria-label="Watched"><Check size={16} /></span>}
    </button>
    {hasDetails && <button type="button" className="cr-play" aria-label={`Play ${row.title}`} onClick={() => details!.onPlay(item)}><Play size={20} fill="currentColor" /></button>}
  </li>;
}

/** Every Channels DVR recording in one vertical list, newest first, loading further pages as the user scrolls. */
export default function ChannelsRecordings({ connection: c, library, query = '', refresh = 0, onOpen }: { connection: Connection; library: Library; query?: string; refresh?: number; onOpen: (i: MediaItem) => void }) {
  const [items, setItems] = useState<RecordingItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const lastRefresh = useRef(refresh);
  // `requested` covers the gap between asking for the next page and the request actually starting, so a burst of
  // scroll events can never skip (and abort) a page.
  const requested = useRef(false);
  const state = useRef({ hasMore, loading, failed: !!error });
  state.current = { hasMore, loading: loading || requested.current, failed: !!error };

  // A new connection, search or manual refresh restarts the list from the newest recording.
  useEffect(() => { setItems([]); setPage(1); setHasMore(false); setError(''); setLoading(true); }, [c.id, query, refresh]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ connectionId: c.id, kind: 'all', parentId: RECORDINGS_FOLDER_ID, page: String(page), limit: String(RECORDINGS_PAGE_SIZE), ...(query ? { q: query } : {}) });
    const force = refresh !== lastRefresh.current && page === 1;
    if (force) params.set('refresh', '1');
    setLoading(true);
    void api<RecordingsPage>(`/catalog?${params}`, undefined, undefined, controller.signal).then(r => {
      if (controller.signal.aborted) return;
      lastRefresh.current = refresh;
      setItems(previous => page === 1 ? mergePage([], r.items) : mergePage(previous, r.items));
      setHasMore(!!r.hasMore); setError('');
    }).catch(e => { if (!controller.signal.aborted) setError(errorMessage(e)); })
      .finally(() => { if (!controller.signal.aborted) { requested.current = false; setLoading(false); } });
    return () => { controller.abort(); requested.current = false; };
  }, [c.id, query, refresh, page, attempt]);

  const next = useCallback(() => {
    const el = sentinel.current;
    if (!el) return;
    const distanceToEnd = el.getBoundingClientRect().top - window.innerHeight;
    if (shouldLoadMore({ ...state.current, distanceToEnd })) { requested.current = true; state.current.loading = true; setPage(p => p + 1); }
  }, []);

  // Scroll/resize check works on every browser, including older in-car ones; IntersectionObserver only adds promptness.
  useEffect(() => {
    const scrollers: (Window | HTMLElement)[] = [window];
    for (let p = sentinel.current?.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if (o === 'auto' || o === 'scroll') scrollers.push(p); }
    scrollers.forEach(s => s.addEventListener('scroll', next, { passive: true }));
    window.addEventListener('resize', next);
    const observer = typeof IntersectionObserver === 'function' && sentinel.current ? new IntersectionObserver(next, { rootMargin: `0px 0px ${LOAD_MORE_MARGIN}px 0px` }) : undefined;
    if (observer && sentinel.current) observer.observe(sentinel.current);
    return () => { scrollers.forEach(s => s.removeEventListener('scroll', next)); window.removeEventListener('resize', next); observer?.disconnect(); };
  }, [next]);
  // After each page lands, the sentinel may still be on screen (short list, tall window): keep filling.
  useEffect(() => { if (!loading) next(); }, [loading, items.length, next]);

  return <div className="cr-list-wrap" data-testid="channels-recordings">
    {error && <div className="form-error" role="alert">{error} <button type="button" className="text-button" onClick={() => { setError(''); setAttempt(n => n + 1); }}>Try again</button></div>}
    {items.length > 0 && <ol className="cr-list" aria-label="Recordings, newest first">{items.map(item => <RecordingRowView key={itemKey(item)} item={item} library={library} onOpen={onOpen} />)}</ol>}
    {!items.length && !loading && !error && <Empty title="No recordings yet">{query ? 'No recordings match that search.' : 'Recordings from your Channels DVR will appear here.'}</Empty>}
    {loading && <Busy label={items.length ? 'Loading more recordings…' : 'Loading recordings…'} />}
    <div ref={sentinel} className="cr-sentinel" aria-hidden="true" />
  </div>;
}
