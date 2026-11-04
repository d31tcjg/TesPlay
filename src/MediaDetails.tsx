import { useEffect, useId, useReducer, useRef, useState } from 'react';
import { Play, Plus, Check, X, Film, Volume2, Captions, Monitor } from 'lucide-react';
import { api, errorMessage } from './api';
import { episodesPath, type EpisodeCatalog } from './episodes';
import { Busy, Modal } from './components';
import EpisodeSelector from './EpisodeSelector';
import PlaybackOptionField from './PlaybackOptionField';
import { itemKey } from './types';
import type { MediaItem, PlaybackOptions, PlaybackSettings, PlayerPreferences } from './types';
import { defaultPlayerPreferences } from './player-preferences';
import { createDetailsState, detailsCanPlay, detailsPlaybackSettings, detailsReducer, startDetailsDiscovery } from './media-details-state';
import './media-details.css';

function durationLabel(seconds: number) {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${minutes} min`;
}

function timeLabel(seconds: number) {
  const time = Math.floor(seconds);
  const minutes = Math.floor(time / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(time % 60).padStart(2, '0')}`
    : `${minutes}:${String(time % 60).padStart(2, '0')}`;
}

export default function MediaDetails({ item, onClose, onPlay, onFavorite, saved, isPlex }: {
  item: MediaItem;
  onClose: () => void;
  onPlay: (item: MediaItem, settings: PlaybackSettings) => void;
  onFavorite: (item: MediaItem) => void;
  saved: boolean;
  isPlex: boolean;
}) {
  const isStremio = item.providerType === 'stremio';
  const series = item.type === 'series' || item.type === 'episode' || item.type === 'folder' && !!item.seriesId;
  const [episodes, setEpisodes] = useState<MediaItem[]>([]);
  const [episodeLoading, setEpisodeLoading] = useState(series);
  const [episodeError, setEpisodeError] = useState('');
  const [discovery, dispatchDiscovery] = useReducer(detailsReducer, item.type === 'series' || item.type === 'folder' ? null : item, createDetailsState);
  const { selected, options, error, profileSettings } = discovery;
  const loading = discovery.status === 'pending';
  const settings = { ...(isStremio ? {sourceId:'auto'} : {}), ...detailsPlaybackSettings(discovery) };
  const editSettings = (patch: PlaybackSettings) => dispatchDiscovery({ type: 'edit', patch });
  const [failedArtwork, setFailedArtwork] = useState('');
  const [failedPoster, setFailedPoster] = useState('');
  const [expandedDescription, setExpandedDescription] = useState<string | null>(null);
  const [descriptionClipped, setDescriptionClipped] = useState(false);
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const descriptionId = useId();

  useEffect(() => {
    if (!series || !item.connectionId) { setEpisodeLoading(false); return; }
    const controller = new AbortController();
    void api<EpisodeCatalog>(episodesPath(item), undefined, undefined, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        setEpisodes(result.items);
        dispatchDiscovery({ type: 'select-initial', item: result.items.find(episode => (episode.resumeSeconds || 0) > 0 && !episode.watched) || result.items.find(episode => !episode.watched) || result.items[0] || null });
      })
      .catch(reason => { if (!controller.signal.aborted) setEpisodeError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setEpisodeLoading(false); });
    return () => controller.abort();
  }, [item.id, item.connectionId, item.type, series]);

  useEffect(() => {
    if (!selected || item.unavailable) return;
    const identity = { key: itemKey(selected), selectionId: discovery.selectionId };
    dispatchDiscovery({ type: 'start', identity });
    return startDetailsDiscovery(async signal => {
      const preferences = api<PlayerPreferences>('/player/preferences',undefined,undefined,signal).catch(() => { signal.throwIfAborted(); return defaultPlayerPreferences; });
      const available = async (): Promise<PlaybackOptions> => {
        if (isPlex || isStremio) return api<PlaybackOptions>(`/playback/options?${new URLSearchParams({ connectionId: selected.connectionId || '', itemId: selected.id, kind: selected.type })}`, undefined, undefined, signal);
        const [{ resolvePlayback }, { createTesPlayAdapter }] = await Promise.all([import('./playback-selection'), import('./tesplayer-adapter')]);
        signal.throwIfAborted();
        const playback = await resolvePlayback(selected, {}, signal, defaultPlayerPreferences);
        const adapter = await createTesPlayAdapter(playback, selected, signal);
        return {
          audio: adapter.session.tracks.filter(track => track.kind === 'audio').map(track => ({ id: track.id, label: track.label || track.language || 'Audio', language: track.language || undefined })),
          subtitles: adapter.session.subtitles.map(track => ({ id: track.id, label: track.label, language: track.language || undefined })),
          qualities: adapter.session.qualities.map(quality => ({ id: quality.id, label: quality.label })),
        };
      };
      const [result, defaults] = await Promise.all([available(), preferences]);
      return { result, defaults };
    }, {
      onResult: ({ result, defaults }) => dispatchDiscovery({ type: 'resolved', identity, options: result, preferences: defaults }),
      onError: reason => dispatchDiscovery({ type: 'failed', identity, error: errorMessage(reason) }),
    });
  }, [selected, discovery.selectionId, isPlex, isStremio, item.unavailable]);

  function chooseEpisode(episode: MediaItem) {
    if (selected && itemKey(selected) === itemKey(episode)) return;
    dispatchDiscovery({ type: 'select', item: episode });
  }

  const active = options.item || selected || item;
  const overview = item.type === 'series' || item.type === 'folder' ? item : active;
  const artwork = item.backdrop || item.poster || active.backdrop || active.poster;
  const poster = item.poster || active.poster || artwork;
  const description = overview.description || item.description || 'Choose your playback settings before watching.';
  const descriptionCharacters = Array.from(description);
  const descriptionShortened = descriptionCharacters.length > 300;
  const descriptionPreview = descriptionShortened ? descriptionCharacters.slice(0, 299).join('').trimEnd() + '…' : description;
  const descriptionExpanded = expandedDescription === description;
  const seasons = new Set(episodes.map(episode => episode.seasonNumber).filter(season => season !== undefined && season > 0)).size;
  const episodeLabel = selected && selected.episodeNumber !== undefined ? `S${selected.seasonNumber ?? 0} · E${selected.episodeNumber}` : '';
  const kind = series ? 'TV SHOW' : item.type === 'video' ? 'VIDEO' : item.type === 'audio' ? 'AUDIO' : 'MOVIE';
  const resume = active.resumeSeconds || 0;
  const hasResume = resume > 0 && (!active.duration || resume / active.duration < .97);
  const usesDefaults = settings.audioTrackId === profileSettings.audioTrackId && settings.subtitleTrackId === profileSettings.subtitleTrackId && settings.qualityId === profileSettings.qualityId;

  useEffect(() => {
    if (descriptionExpanded) return;
    const element = descriptionRef.current;
    if (!element) return;
    const measure = () => setDescriptionClipped(element.scrollHeight > element.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [descriptionPreview, descriptionExpanded]);

  const footer = <>
    <div className="media-details-actions">
      <button type="button" className="button primary" disabled={!detailsCanPlay(discovery, item.unavailable)} onClick={() => { if (detailsCanPlay(discovery, item.unavailable)) onPlay(active, settings); }}>
        <Play size={17} fill="currentColor" />{series ? episodeLabel ? `Play ${episodeLabel}` : 'Watch episode' : 'Play with these settings'}
      </button>
      {!item.unavailable && <button type="button" className="media-details-save" onClick={() => onFavorite(item)} aria-pressed={saved} aria-label={`${saved ? 'Remove' : 'Add'} ${item.title} ${saved ? 'from' : 'to'} My list`}>
        {saved ? <Check size={19} /> : <Plus size={19} />}
      </button>}
    </div>
    {hasResume && !settings.startOver && <div className="media-details-resume">
      {!!active.duration && <progress value={resume} max={active.duration} aria-label="Watch progress" />}
      <span>{series && episodeLabel && `${episodeLabel} · `}Resume at {timeLabel(resume)}</span>
    </div>}
  </>;

  return <Modal title={item.title} onClose={onClose} wide className="media-details-modal" header={
    <header className="media-details-hero">
      {artwork && failedArtwork !== artwork && <img className="media-details-artwork" src={artwork} alt="" onError={() => setFailedArtwork(artwork)} />}
      <div className="media-details-poster" aria-hidden="true">
        {poster && failedPoster !== poster ? <img src={poster} alt="" onError={() => setFailedPoster(poster)} /> : <Film size={23} />}
      </div>
      <div className="media-details-title">
        <span className="media-details-eyebrow">{kind}</span>
        <h2>{item.title}</h2>
        <div className="media-details-meta">
          {overview.year && <span>{overview.year}</span>}
          {series ? seasons > 0 && <span>{seasons} {seasons === 1 ? 'season' : 'seasons'}</span> : !!active.duration && <span>{durationLabel(active.duration)}</span>}
          {(overview.categoryLabel || overview.category) && <span>{overview.categoryLabel || overview.category}</span>}
          <span className="media-details-source">{item.source}</span>
        </div>
      </div>
      <button type="button" className="media-details-close" onClick={onClose} aria-label="Close dialog"><X size={20} /></button>
    </header>
  }>
    <div className="media-details-body"><div className="media-details-columns">
      <div className="media-details-overview">
        <p ref={descriptionRef} id={descriptionId} className={`media-details-description${descriptionExpanded ? ' expanded' : ''}`}>{descriptionExpanded ? description : descriptionPreview}</p>
        {(descriptionShortened || descriptionClipped || descriptionExpanded) && <button type="button" className="media-details-read-more" aria-expanded={descriptionExpanded} aria-controls={descriptionId} onClick={() => setExpandedDescription(descriptionExpanded ? null : description)}>{descriptionExpanded ? 'Read less' : 'Read more…'}</button>}
        {item.unavailable && <p className="form-help">This Watchlist title is not available on your Plex server.</p>}
      </div>
      <section className="media-details-playback" aria-label="Playback settings">
        <div className="media-details-settings-heading"><h3>Playback settings</h3>{!loading && selected && !item.unavailable && <span>{usesDefaults ? 'Your defaults' : 'Custom'}</span>}</div>
        {series && (episodeLoading ? <Busy label="Loading seasons and episodes" /> : episodeError ? <p className="form-error" role="alert">{episodeError}</p> : episodes.length ?
          <div className="media-details-episodes"><span>Episode</span><EpisodeSelector items={episodes} current={selected || undefined} onSelect={chooseEpisode} compact containInDialog /></div>
          : <p>No episodes available.</p>)}
        {selected && !item.unavailable && <>
          {loading && <Busy label="Finding available tracks and quality" />}
          {error && <p className="form-help" role="status">Options could not load: {error} You can still try automatic playback.</p>}
          {options.note && <p className="form-help" role="status">{options.note}</p>}
          <div className="media-details-options">
            {isStremio && <PlaybackOptionField label="Source" accessibleLabel="Stremio source" icon={<Play size={18}/>} disabled={loading} value={settings.sourceId || 'auto'} choices={[{id:'auto',label:'Automatic source'},...(options.sources || []).filter(source=>!source.unavailable).map(source=>({id:source.id,label:`${source.addon} · ${source.label}${source.description ? ' · '+source.description.slice(0,100) : ''}`}))]} onChange={sourceId=>editSettings({sourceId})}/> }
            <PlaybackOptionField label="Audio" accessibleLabel="Audio track" icon={<Volume2 size={18} aria-hidden="true" />} disabled={loading} value={settings.audioTrackId || 'default'}
              choices={[{ id: 'default', label: 'Source default' }, ...options.audio]} onChange={audioTrackId => editSettings({ audioTrackId })} />
            <PlaybackOptionField label="Subtitles" accessibleLabel="Subtitle track" icon={<Captions size={18} aria-hidden="true" />} disabled={loading} value={settings.subtitleTrackId || 'default'}
              choices={[{ id: 'default', label: 'Profile default' }, { id: 'off', label: 'Off' }, ...options.subtitles]} onChange={subtitleTrackId => editSettings({ subtitleTrackId })} />
            <PlaybackOptionField label="Quality" accessibleLabel="Playback quality" icon={<Monitor size={18} aria-hidden="true" />} disabled={loading} value={settings.qualityId || 'auto'}
              choices={[...(!options.qualities.some(quality => quality.id === 'auto') ? [{ id: 'auto', label: 'Auto / original' }] : []), ...options.qualities]} onChange={qualityId => editSettings({ qualityId })} />
          </div>
          <div className="media-details-checks">
            {isPlex && <>
              <label className="media-details-desktop-compatibility"><input type="checkbox" checked={!!settings.compatibility} onChange={event => editSettings({ compatibility: event.target.checked })} />Use Plex compatibility mode</label>
              <details className="media-details-advanced"><summary>More options</summary><label><input type="checkbox" checked={!!settings.compatibility} onChange={event => editSettings({ compatibility: event.target.checked })} />Use Plex compatibility mode</label></details>
            </>}
            <label><input type="checkbox" checked={!!settings.startOver} onChange={event => editSettings({ startOver: event.target.checked })} />Start from the beginning</label>
          </div>
        </>}
        <div className="media-details-desktop-footer">{footer}</div>
      </section>
    </div></div>
    <footer className="media-details-phone-footer">{footer}</footer>
  </Modal>;
}
