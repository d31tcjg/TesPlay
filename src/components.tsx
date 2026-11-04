import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  X,
  Play,
  Plus,
  Check,
  ChevronRight,
  Folder,
  Film,
  LoaderCircle,
  ListPlus,
  Radio,
  Info,
} from "lucide-react";
import { services } from "./catalog";
import { RefreshCw } from "lucide-react";
import type { MediaItem } from "./types";
export const MediaDetailsContext = createContext<{onDetails:(item:MediaItem)=>void;onPlay:(item:MediaItem)=>void}|null>(null);
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <Play size={29} strokeWidth={2.3} fill="currentColor" />
      {!compact && (
        <span>
          TesPlay<span className="brand-dot">.</span>
        </span>
      )}
    </div>
  );
}
export function YouTubeLogo({className = ""}: {className?: string}) {
  return <svg className={`youtube-logo ${className}`} viewBox="0 0 32 23" aria-hidden="true"><path fill="#ff4545" d="M31.3 3.6A4 4 0 0 0 28.5.8C26 0 16 0 16 0S6 0 3.5.8A4 4 0 0 0 .7 3.6C0 6.1 0 11.5 0 11.5s0 5.4.7 7.9a4 4 0 0 0 2.8 2.8C6 23 16 23 16 23s10 0 12.5-.8a4 4 0 0 0 2.8-2.8c.7-2.5.7-7.9.7-7.9s0-5.4-.7-7.9Z"/><path fill="white" d="m12.8 16.4 8.3-4.9-8.3-4.9Z"/></svg>;
}
export function ConnectorLogo({type}: {type:string}) {
  const service = services.find(s => s.id === (type==='m3u'?'xtream':type));
  return <span className={`service-logo ${service?.id || type}`} style={{color:service?.color}}>{type==='youtube'?<YouTubeLogo/>:service?.letters || type.slice(0,1).toUpperCase()}</span>;
}
export function RefreshButton({onRefresh, disabled=false, label='Refresh content'}: {onRefresh:()=>void;disabled?:boolean;label?:string}) {
  const [confirm,setConfirm]=useState(false);
  return <><button type="button" className="icon-button" aria-label={label} disabled={disabled} onClick={()=>setConfirm(true)}><RefreshCw size={18}/></button>{confirm&&<Modal title="Refresh your content?" onClose={()=>setConfirm(false)}><p>Are you sure? Refreshing your connected libraries may take a while.</p><div className="form-actions"><button className="button primary" onClick={()=>{setConfirm(false);onRefresh();}}>Refresh content</button><button className="button ghost" onClick={()=>setConfirm(false)}>Cancel</button></div></Modal>}</>;
}
export const cardFormat = (item: MediaItem) => item.artwork || (item.type==='live'||item.type==='audio' ? 'logo' : ['movie','series'].includes(item.type) || item.providerType==='plex' && item.contentKind==='series' ? 'poster' : 'thumbnail');
export function Busy({ label = "Loading your library" }: { label?: string }) {
  return (
    <div className="busy" role="status">
      <LoaderCircle className="spin" size={26} />
      <span>{label}</span>
    </div>
  );
}
export function Empty({
  icon = <Film size={34} />,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">{icon}</span>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Modal({
  title,
  onClose,
  children,
  wide = false,
  className = "",
  header,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  className?: string;
  header?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current!;
    d.showModal();
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`modal ${wide ? "wide" : ""} ${className}`}
      aria-label={title}
      onCancel={(event) => { event.stopPropagation(); onClose(); }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-content">
        {header ?? <header className="modal-head">
          <h2>{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X />
          </button>
        </header>}
        {children}
      </div>
    </dialog>
  );
}
/** A refreshed URL gets fresh state; temporary failures get two bounded retries. */
function CardArtwork({ src, fallback }: { src: string; fallback: ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!failed || attempt >= 2) return;
    const timer = window.setTimeout(() => {
      setAttempt(value => value + 1);
      setFailed(false);
    }, 1000 * 2 ** attempt);
    return () => window.clearTimeout(timer);
  }, [failed, attempt]);
  if (failed) return fallback;
  const url = attempt ? new URL(src, window.location.href) : undefined;
  if (url?.origin === window.location.origin && url.pathname.startsWith('/api/media/'))
    url.searchParams.set('tesplayArtRetry', String(attempt));
  return <img src={url?.href || src} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

export function Card({
  item,
  onOpen,
  onFavorite,
  saved = false,
  progress,
  presentation,
}: {
  item: MediaItem;
  onOpen: (i: MediaItem) => void;
  onFavorite?: (i: MediaItem) => void;
  saved?: boolean;
  progress?: number;
  presentation?: "continue";
}) {
  const details = useContext(MediaDetailsContext);
  const hasDetails = !!details && (["movie","series","episode","video"].includes(item.type) || item.type === "folder" && !!item.seriesId);
  const youtube = item.providerType === "youtube" || item.source === "YouTube";
  const watched = item.watched || (progress !== undefined && progress >= 97);
  return (
    <article
      className={`media-card format-${cardFormat(item)} ${item.type === "live" ? "live-card" : ""} ${presentation==='continue'?'continue-card':''}`}
    >
      <div className="card-artwork">
      <button
        className="card-image"
        disabled={item.unavailable}
        onClick={() => hasDetails ? details?.onDetails(item) : onOpen(item)}
        aria-label={`${hasDetails ? "Details for" : item.type === "folder" || item.type === "series" ? "Browse" : "Play"} ${item.title}`}
      >
        {item.poster ? (
          <CardArtwork
            key={presentation === 'continue' ? item.backdrop || item.poster : item.poster}
            src={presentation === 'continue' ? item.backdrop || item.poster : item.poster}
            fallback={<span className="art-fallback"><Film size={40} /></span>}
          />
        ) : (
          <span className="art-fallback">
            {item.type === "live" ? <Radio size={40} /> : item.type === "folder" ? <Folder size={40} /> : <Film size={40} />}
          </span>
        )}
        <span className="card-shade" />
        {!youtube && <span className="source-badge">{item.source}</span>}
        {watched && <span className="watched-badge" aria-label="Watched"><Check size={14}/></span>}
        {!hasDetails&&<span className="card-play">
          {item.type === "folder" ? (
            <Folder />
          ) : (
            <Play size={25} fill="currentColor" />
          )}
        </span>}
        {item.type === "live" && <span className="live-badge">LIVE</span>}
        {progress !== undefined && (
          <span className="watch-progress">
            <span style={{ width: `${Math.min(progress, 100)}%` }} />
          </span>
        )}
      </button>
      {hasDetails&&!item.unavailable&&<button className="card-direct-play" aria-label={`Play ${item.title}`} onClick={()=>details?.onPlay(item)}><Play size={25} fill="currentColor"/></button>}
      </div>
      <div className="card-info">
        <div>
          <h3>{hasDetails?<button className="card-title-button" onClick={()=>details?.onDetails(item)}>{item.title}</button>:item.title}</h3>
          <p>
            {[
              item.unavailable ? "Not in this Plex server" : item.year,
              item.categoryLabel ||
                item.category ||
                (item.type === "folder"
                  ? "Library"
                  : item.type === "series"
                    ? "Series"
                    : item.duration
                      ? `${Math.round(item.duration / 60)} min`
                      : item.source),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        {hasDetails&&<button className="icon-button card-details" aria-label={`Information about ${item.title}`} onClick={()=>details?.onDetails(item)}><Info size={19}/></button>}
        {onFavorite && item.type !== "folder" && !item.unavailable && (
          <button
            className={`icon-button favorite ${saved ? "saved" : ""}`}
            onClick={() => onFavorite(item)}
            aria-label={`${saved ? "Remove" : "Add"} ${item.title} ${saved ? "from" : "to"} ${youtube ? "Watch playlist" : "My list"}`}
          >
            {saved ? <Check size={19} /> : youtube ? <ListPlus size={19} /> : <Plus size={19} />}
          </button>
        )}
      </div>
    </article>
  );
}
export function Row({
  title,
  subtitle,
  items,
  onOpen,
  onFavorite,
  isSaved,
  more,
  progress,
  presentation,
}: {
  title: string;
  subtitle?: string;
  items: MediaItem[];
  onOpen: (i: MediaItem) => void;
  onFavorite?: (i: MediaItem) => void;
  isSaved?: (i: MediaItem) => boolean;
  more?: () => void;
  progress?: (i: MediaItem) => number | undefined;
  presentation?: "continue";
}) {
  const rail = useRef<HTMLDivElement>(null);
  return (
    <section className="media-section">
      <div className="section-heading">
        <div>
          <h2>{more ? <button className="row-title" onClick={more}>{title}<ChevronRight size={18}/></button> : title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <div className="row-actions">
          {more && (
            <button className="text-button" onClick={more}>
              View all <ChevronRight size={16} />
            </button>
          )}
          <button
            className="icon-button rail-next"
            aria-label={`Scroll ${title}`}
            onClick={() =>
              rail.current?.scrollBy({ left: 560, behavior: "smooth" })
            }
          >
            <ChevronRight size={21} />
          </button>
        </div>
      </div>
      <div className="media-rail" ref={rail}>
        {items.map((item) => (
          <Card
            key={`${item.connectionId || item.source}:${item.type}:${item.id}`}
            item={item}
            onOpen={onOpen}
            onFavorite={onFavorite}
            saved={isSaved?.(item)}
            progress={progress?.(item)}
            presentation={presentation}
          />
        ))}
      </div>
    </section>
  );
}
