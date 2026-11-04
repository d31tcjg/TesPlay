import { getPlaybackAudio } from "./playback-audio";
import {retainPlayerDialog} from "./retain-player-dialog";
import { useEffect, useRef, useState } from "react";
import {
  X,
  LoaderCircle,
  SkipForward,
} from "lucide-react";
import { errorMessage } from "./api";
import type { MediaItem, Playback, PlaybackSettings } from "./types";
import EpisodeSelector from "./EpisodeSelector";
import {resolvePlayback} from "./playback-selection";
import TesPlayer from "./TesPlayer";
import { idleRemotePlayback, type RemotePlayback } from "./remote-state";
export default function Player({
  item,
  resume = 0,
  onClose,
  onProgress,
  onRemoteState,
  next,
  previous,
  episodes = [],
  episodesLoading = false,
  episodesError = "",
  settings = {},
  onNext,
  canTranscode = false,
  autoPlayNext = true,
  remoteOnly = false,
}: {
  item: MediaItem;
  resume?: number;
  canTranscode?: boolean;
  autoPlayNext?: boolean;
  remoteOnly?: boolean;
  onClose: () => void;
  onRemoteState?: (state:RemotePlayback)=>void;
  onProgress?: (item: MediaItem, seconds: number, duration: number, state?:"playing"|"paused"|"stopped") => void;
  settings?: PlaybackSettings;
  episodes?: MediaItem[];
  episodesLoading?: boolean;
  episodesError?: string;
  previous?: MediaItem;
  next?: MediaItem;
  onNext?: (item: MediaItem) => void;
}) {
  const [playback, setPlayback] = useState<Playback | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [ended, setEnded] = useState(false),
    [countdown, setCountdown] = useState<number | null>(null),
    [autoplayCancelled, setAutoplayCancelled] = useState(false),
    [compatible, setCompatible] = useState(!!settings.compatibility), [resolveAttempt,setResolveAttempt]=useState(0);
  const dialog = useRef<HTMLDialogElement>(null),
    nextCallback = useRef(onNext),
    progressCallback = useRef(onProgress),
    resumeRef = useRef(resume), resumeLoaded=useRef(false);
  const remoteReporter=useRef(onRemoteState);remoteReporter.current=onRemoteState;
  useEffect(()=>{if(loading||error)remoteReporter.current?.({...idleRemotePlayback,phase:error?'error':'loading',fullscreen:remoteOnly,fullscreenLocked:remoteOnly});},[loading,error,remoteOnly]);
  useEffect(()=>{
    if(remoteOnly && ended && (!next || !autoPlayNext))onClose();
  },[remoteOnly,ended,next,autoPlayNext,onClose]);
  const getAudioContext = getPlaybackAudio;
  progressCallback.current = onProgress;
  nextCallback.current = onNext;
  useEffect(() => {
    if (
      !ended ||
      !["episode","video","movie","audio"].includes(item.type) ||
      !next ||
      !autoPlayNext ||
      autoplayCancelled
    ) {
      setCountdown(null);
      return;
    }
    let remaining = 5;
    setCountdown(remaining);
    const timer = window.setInterval(() => {
      remaining -= 1;
      setCountdown(remaining);
      if (remaining === 0) {
        window.clearInterval(timer);
        nextCallback.current?.(next);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [
    ended,
    item.type,
    next?.id,
    next?.connectionId,
    autoPlayNext,
    autoplayCancelled,
  ]);
  useEffect(() => {
    const d = dialog.current!;
    return retainPlayerDialog(d);
  }, []);
  useEffect(()=>{resumeRef.current=settings.startOver?0:resume;resumeLoaded.current=false;setCompatible(!!settings.compatibility);},[item.id,item.connectionId,item.type,settings.compatibility,settings.startOver]);
  useEffect(() => {
    const controller = new AbortController();
    let dead = false;
    setLoading(true);
    setError("");
    setEnded(false);
    setAutoplayCancelled(false);
    setPlayback(null);

    (async () => {
      try {
        const p = await resolvePlayback(item,{...settings,compatibility:compatible},controller.signal);
        if (!dead&&!resumeLoaded.current) {
          if (settings.startOver) resumeRef.current=0;
          else if (p.resumeSeconds!==undefined) resumeRef.current=p.resumeSeconds;
          resumeLoaded.current=true;
        }
        if (!dead) { setPlayback(p); setLoading(false); }
      } catch (e) {
        if (!dead) {
          setError(errorMessage(e));
          setLoading(false);
        }
      }
    })();
    return () => { dead = true; controller.abort(); };
    // Progress updates must not restart the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.connectionId, item.playbackUrl, compatible, resolveAttempt, settings.audioTrackId, settings.qualityId, settings.subtitleTrackId, settings.sourceId]);
  return (
    <dialog
      ref={dialog}
      className={`player-modal ${remoteOnly?"rear-player":""}`}
      aria-label={`Playing ${item.title}`}
      onCancel={event=>{if(remoteOnly)event.preventDefault();else onClose();}}
    >
      <div className="player-shell">
        {!remoteOnly && <header className="player-header">
          <div>
            <span className="small-caps">{item.source}</span>
            <h2>{item.title}</h2>
          </div>
          <div className="player-actions">
            <button
              className="icon-button"
              aria-label="Close player"
              onClick={onClose}
            >
              <X />
            </button>
          </div>
        </header>}
        <div className="video-stage canvas-stage">
          {loading && !error && (
            <div className="player-loading">
              <LoaderCircle size={35} className="spin" />
              <span>Getting your video ready</span>
            </div>
          )}
          {playback?.type === 'external' ? <div className="empty"><p>This source cannot supply a playable stream to TesPlayer.</p></div> : (
            playback && <TesPlayer onRemoteState={onRemoteState} remoteOnly={remoteOnly}
              key={`${item.connectionId || item.source}:${item.type}:${item.id}`}
              playback={playback}
              item={item}
              resume={resumeRef.current}
              getAudioContext={getAudioContext}
              autoStart={true}
              plexCompatibility={compatible}
              canTranscode={canTranscode}
              onCompatibilityChange={setCompatible}
              onRetry={()=>setResolveAttempt(n=>n+1)}
              previous={previous} next={next} onNavigate={onNext}
              onProgress={(seconds, duration, state) => {
                resumeRef.current=seconds;
                progressCallback.current?.(item, Math.min(seconds, 604800), Math.min(duration, 604800),state);
              }}
              onPlaying={() => { setEnded(false); }}
              onEnded={() => setEnded(true)}
              onError={message=>{
                setError(message);
                // TesPlayer clears its error when playing; keep that successful stream mounted.
                if(!message)return;
                setPlayback(null);
              }}
            />
          )}
        </div>
        {!remoteOnly&&item.type==='episode'&&<div className="player-episode-picker">{episodesLoading?<p role="status">Loading seasons and episodes…</p>:episodesError?<p className="form-error" role="alert">{episodesError}</p>:episodes.length>0&&onNext?<EpisodeSelector compact items={episodes} current={item} onSelect={onNext}/>:null}</div>}
        {error && (
          <div className="player-error" role="alert">
            <span>{error}{remoteOnly?" Choose another title on your phone.":""}</span>{!remoteOnly&&!playback&&<button className="button ghost small" onClick={()=>setResolveAttempt(n=>n+1)}>Try again</button>}
          </div>
        )}
        {!remoteOnly && <footer className={`player-footer ${ended && next ? "has-next" : ""}`}>
          <span>
            {item.type === "audio"
              ? "AUDIO"
              : item.source === "Open cinema"
                ? "Open movie collection"
                : "Video for use while parked"}
          </span>
          <span>
            {ended && next && onNext ? (
              <span className="next-episode-actions">
                {countdown !== null && (
                  <>
                    <span role="status">{item.type === "episode" ? "Next episode" : "Next video"} in {countdown}s</span>
                    <button
                      className="button ghost small"
                      onClick={() => setAutoplayCancelled(true)}
                    >
                      Stay here
                    </button>
                  </>
                )}
                <button
                  className="button primary small"
                  onClick={() => onNext(next)}
                >
                  Next: {next.title}
                  <SkipForward size={16} />
                </button>
              </span>
            ) : (
              item.categoryLabel || item.category
            )}
          </span>
        </footer>}
      </div>
    </dialog>
  );
}
