import { remotePlayback, type RemotePlayback } from './remote-state';
import {playbackBufferLimits} from './playback-buffer-limits';
import { api, tesPlayFetch } from './api';
import SutroIcon from "./SutroIcon";
import LiveIndicator from "./LiveIndicator";
import { Modal } from "./components";
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Radio, ChevronRight, ChevronLeft, Captions, Minus, Plus, Gauge, Languages, SkipBack, SkipForward } from 'lucide-react';
import { createTesPlayerEngine, probeMediaCapabilities, parseSubtitles, activeCuesAt } from '@canvas-stream-player/player';
import { DEFAULT_PLAYER_POLICY } from '@canvas-stream-player/contracts';
import type { PlayerEngine, PlayerSnapshot, PlayerCommand, PlayerSubtitleCue } from '@canvas-stream-player/contracts';
import type { MediaItem, Playback, PlayerPreferences } from './types';
import { defaultPlayerPreferences, preferredSubtitleTrack } from './player-preferences';
import { createTesPlayAdapter, TesPlaySourceError } from './tesplayer-adapter';
import {startPlexPlaybackHeartbeat} from './plex-playback-heartbeat';

const time = (seconds: number) => {
  const whole = Math.floor(Math.max(0, seconds));
  return whole >= 3600 ? `${Math.floor(whole / 3600)}:${String(Math.floor(whole / 60) % 60).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}` : `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};
const INITIAL_MESSAGE = 'Press play to begin';
export default function TesPlayer({ playback, item, resume, plexCompatibility, canTranscode, onCompatibilityChange, onRetry, getAudioContext, autoStart, onProgress, onEnded, onPlaying, onError, onRemoteState, previous, next, onNavigate, remoteOnly = false }: {
  playback: Playback; item: MediaItem; resume: number; plexCompatibility: boolean; canTranscode: boolean; onCompatibilityChange:(value:boolean)=>void; onRetry:()=>void;
  getAudioContext: () => AudioContext | undefined; autoStart: boolean;
  onRemoteState?: (state:RemotePlayback)=>void;
  remoteOnly?: boolean;
  previous?:MediaItem; next?:MediaItem; onNavigate?:(item:MediaItem)=>void;
  onProgress: (seconds: number, duration: number, state?:"playing"|"paused"|"stopped") => void; onEnded: () => void; onPlaying: () => void; onError: (message: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<PlayerEngine | null>(null);
  const [snapshot, setSnapshot] = useState<PlayerSnapshot | null>(null);
  const [message, setMessage] = useState(INITIAL_MESSAGE);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const retries=useRef(0), retryPending=useRef(false), retryTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined), lastPosition=useRef(resume),lastDuration=useRef(0);
  const freshRetry=useRef(onRetry);freshRetry.current=onRetry;
  const [subtitleMenu,setSubtitleMenu]=useState(false),[audioMenu,setAudioMenu]=useState(false);
  const subtitlePreferences=useRef<PlayerPreferences>(defaultPlayerPreferences);
  useEffect(()=>()=>clearTimeout(retryTimer.current),[]);
  const [scrub, setScrub] = useState<number | null>(null);
  const [localCues, setLocalCues] = useState<PlayerSubtitleCue[]>([]);
  const [localCaptions, setLocalCaptions] = useState(false);
  const surface=useRef<HTMLDivElement>(null);
  const controls=useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = controls.current, player = surface.current;
    if (!bar || !player) return;
    // Reserve the actual toolbar height, including wrapped controls.
    const measure = () => player.style.setProperty('--player-controls-height', `${bar.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [remoteOnly]);
  const [fullscreen,setFullscreen]=useState(false),[immersive,setImmersive]=useState(false),[settings,setSettings]=useState(false),[pasteCaptions,setPasteCaptions]=useState(false),[captionText,setCaptionText]=useState('');
  const [controlsVisible,setControlsVisible]=useState(true),[seekFeedback,setSeekFeedback]=useState<{side:'left'|'right';seconds:number;key:number}|null>(null);
  const hideTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),feedbackTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),lastTap=useRef<{time:number;side:string}>({time:0,side:''}),lastTouchSeek=useRef(0);
  const reveal=()=>{setControlsVisible(true);clearTimeout(hideTimer.current);hideTimer.current=setTimeout(()=>setControlsVisible(false),2500);};
  useEffect(()=>{const changed=()=>setFullscreen(document.fullscreenElement===surface.current);document.addEventListener('fullscreenchange',changed);return()=>{document.removeEventListener('fullscreenchange',changed);clearTimeout(hideTimer.current);clearTimeout(feedbackTimer.current);};},[]);
  useEffect(()=>{if(snapshot?.phase==='playing')reveal();},[snapshot?.phase]);
  const toggleFullscreen=()=>{
    if(remoteOnly)return;
    if(immersive){setImmersive(false);return;}
    if(document.fullscreenElement){void document.exitFullscreen().catch(()=>setImmersive(false));return;}
    if(surface.current?.requestFullscreen)void surface.current.requestFullscreen().catch(()=>setImmersive(true));
    else setImmersive(true);
    reveal();
  };
  useEffect(()=>{const remote=(e:Event)=>{if((e as CustomEvent).detail.command==='fullscreen')toggleFullscreen();};window.addEventListener('aperture:remote',remote);return()=>window.removeEventListener('aperture:remote',remote);},[immersive,remoteOnly]);
  const remoteReporter = useRef(onRemoteState); remoteReporter.current = onRemoteState;
  useEffect(()=>{const state=remotePlayback(snapshot, remoteOnly || fullscreen || immersive, localCaptions, localCues.length > 0, remoteOnly);remoteReporter.current?.(failed?{...state,phase:"error"}:state);},[snapshot,fullscreen,immersive,remoteOnly,localCaptions,localCues.length,failed]);
  useEffect(()=>{
    const remote=(event:Event)=>{
      if ((event as CustomEvent).detail.command !== 'captions') return;
      const state=engine.current?.getSnapshot();
      if (state?.subtitleTracks.length) {
        const trackId=state.selectedSubtitleTrackId ? null : state.subtitleTracks[0].id;
        void engine.current?.dispatch({type:'select-subtitle-track',trackId}).catch(error);
      } else if (localCues.length) setLocalCaptions(value=>!value);
    };
    window.addEventListener('aperture:remote',remote);
    return ()=>window.removeEventListener('aperture:remote',remote);
  },[localCues.length]);
  const playing = useRef(onPlaying); playing.current = onPlaying;
  const progress = useRef(onProgress), ended = useRef(onEnded), reportError = useRef(onError);
  progress.current = onProgress; ended.current = onEnded; reportError.current = onError;
  const setupQueue = useRef<Promise<void>>(Promise.resolve());
  const options = useRef({ resume, item, plexCompatibility });
  options.current = { resume, item, plexCompatibility };
  const error = (reason: unknown) => {
    const typed = reason as { code?: string };
    const unavailable = reason instanceof Error && reason.message === 'Canvas playback is unavailable.';
    if (typed?.code === 'STALE_OPERATION' || (reason instanceof DOMException && reason.name === 'AbortError')) return;
    // Engine errors are already sanitized. Avoid showing raw fetch URLs or credentials.
    const text = reason instanceof TesPlaySourceError ? reason.message : unavailable ? 'This browser does not support TesPlayer canvas playback. Use an updated browser with WebCodecs enabled.' : typed?.code ? `Playback could not continue (${typed.code}). ${playback.provider === 'plex' ? 'Try again or choose Plex compatibility for this title.' : 'Reopen this title or try another stream.'}` : 'This source could not play. Check its connection and browser codec support, then try again.';
    if(playback.provider==='plex' && ['DEMUX_FAILED','NETWORK_TIMEOUT','RECOVERY_EXHAUSTED','DECODE_FAILED'].includes(typed?.code||'') && retries.current<2){
      if(retryPending.current)return;retryPending.current=true;retries.current++;
      progress.current(lastPosition.current,lastDuration.current);setBusy(true);setMessage('Reconnecting to your stream');
      retryTimer.current=setTimeout(()=>freshRetry.current(),750);return;
    }
    setMessage(text); setFailed(true); setBusy(false); reportError.current(text);
  };
  useEffect(() => {
    const controller = new AbortController();
    let active: PlayerEngine | null = null;
    let unsubscribe = () => {};
    let didPlay = false;
    let didComplete = false;
    let lastSavedPhase = '';
    retryPending.current=false;
    setSnapshot(null); setBusy(true); setFailed(false); setMessage('Getting your stream ready');
    setLocalCues([]); setLocalCaptions(false);
    const save = (completed = false, stopped = false) => {
      if (!active || !didPlay || didComplete) return;
      const state = active.getSnapshot();
      if (!completed && !stopped && !['playing','paused','stalled'].includes(state.phase)) return;
      const duration = state.durationSeconds || 0;
      progress.current(completed && duration ? duration : state.positionSeconds, duration, completed||stopped?'stopped':state.phase==='ended'||state.phase==='error'?'stopped':state.phase==='paused'?'paused':'playing');
      if (completed) didComplete = true;
    };
    const task = setupQueue.current.then(async () => {
      if (controller.signal.aborted) return;
      try {
        const [capabilities,preferences] = await Promise.all([probeMediaCapabilities(),playback.defaults || api<PlayerPreferences>('/player/preferences',undefined,undefined,controller.signal).catch(()=>subtitlePreferences.current)]);
        subtitlePreferences.current=preferences;
        if (controller.signal.aborted) return;
        if (!capabilities.canvas2d || (playback.type !== 'audio' && !capabilities.webCodecs.videoDecoder)) throw new Error('Canvas playback is unavailable.');
        const adapter = await createTesPlayAdapter(playback, options.current.item, controller.signal, options.current.plexCompatibility);
        if (controller.signal.aborted || !canvas.current) return;
        const audioContext = getAudioContext();
        active = createTesPlayerEngine({ canvas: canvas.current, capabilities, services: adapter.services, audioContext, dependencies: { fetch: tesPlayFetch },
          policy: { ...DEFAULT_PLAYER_POLICY, ...playbackBufferLimits(navigator.userAgent), directProbeTimeoutMs: 10000, progressTimeoutMs: 30000, softStallMs: 30000, hardStallMs: 90000, startupTimeoutMs: { direct: 30000, provider: 60000, compatibility: 120000 } },
        });
        engine.current = active;
        unsubscribe = active.subscribe((event) => {
          if (controller.signal.aborted) return;
          if (event.type === 'state') {
            const state = event.snapshot;
            setSnapshot(state);
            if(state.phase==='playing'||state.phase==='paused'){lastPosition.current=state.positionSeconds;lastDuration.current=state.durationSeconds||lastDuration.current;}
            if(state.phase==='error')return;
            setBusy(['loading', 'seeking', 'stalled'].includes(state.phase));
            if (state.phase === 'playing') { didPlay = true; setFailed(false); if (lastSavedPhase !== 'playing') {didComplete=false;playing.current();save();} reportError.current(''); }
            if (state.phase === 'paused' && lastSavedPhase !== 'paused') save();
            lastSavedPhase = state.phase;
            setMessage(state.phase === 'stalled' ? 'Reconnecting to your stream' : state.phase === 'seeking' ? 'Finding your place' : state.phase === 'loading' ? 'Getting your stream ready' : state.phase === 'ended' ? 'Finished' : state.phase === 'paused' ? 'Paused' : INITIAL_MESSAGE);
          }
          if (event.type === 'error') error(event.error);
          if (event.type === 'ended') { save(true); ended.current(); }
          if (event.type === 'audio-unlock-required') { setMessage('Press play to enable sound'); setBusy(false); }
        });
        await active.load({ session: adapter.session, resumePositionSeconds: options.current.resume || null, autoplay: autoStart, startAtLiveEdge: adapter.session.isLive, preferredQualityId: adapter.session.selectedQualityId ?? null, preferredAudioTrackId: adapter.session.selectedAudioTrackId ?? null, preferredSubtitleTrackId: playback.settings?.subtitleTrackId && playback.settings.subtitleTrackId !== 'default' ? playback.settings.subtitleTrackId==='off'?null:adapter.session.subtitles.find(t=>t.id===playback.settings?.subtitleTrackId)?.id||null : preferredSubtitleTrack(adapter.session.subtitles,preferences)?.id || null, signedAvOffsetMs: 0 }, controller.signal);
        // The shared keepalive retains Plex transcodes and Channels DVR tuners,
        // including while paused. Teardown aborts both providers' timers.
        startPlexPlaybackHeartbeat(playback, controller.signal, () => !!active && ['ready','playing','paused','seeking','stalled'].includes(active.getSnapshot().phase));
        if (!controller.signal.aborted) { setBusy(false); if(active.getSnapshot().phase!=='playing')setMessage(INITIAL_MESSAGE); }
      } catch (reason) { if (!controller.signal.aborted) error(reason); }
    });
    setupQueue.current = task.catch(() => {});
    const interval = window.setInterval(()=>save(), 10000);
    const beforeLeaving = () => save(false,true);
    const hidden = () => { if (document.visibilityState === 'hidden') save(); };
    const remote = (event: Event) => {
      const { command, value } = (event as CustomEvent<{ command: string; value?: number }>).detail;
      if (!active) return;
      const state = active.getSnapshot();
      if (state.isLive && (command === 'seek' || command === 'seek-to')) return;
      // A remote device cannot grant this browser a user gesture for Web Audio.
      if (command === 'play' && state.audioTracks.length > 0 && !state.audioUnlocked) { setMessage('Enable playback on this screen'); return; }
      if (command === 'play' && state.phase === 'ended') void active.dispatch({type:'seek',positionSeconds:state.seekableStartSeconds || 0}).then(()=>active?.dispatch({type:'play'})).catch(error);
      else if (command === 'play' || command === 'pause') void active.dispatch({ type: command }).catch(error);
      if (command === 'seek') void active.dispatch({ type: 'seek', positionSeconds: Math.max(state.seekableStartSeconds || 0, Math.min(state.seekableEndSeconds ?? Infinity, state.positionSeconds + (value || 0))) }).catch(error);
      if (command === 'seek-to') void active.dispatch({type:'seek',positionSeconds:Math.max(state.seekableStartSeconds || 0,Math.min(state.seekableEndSeconds ?? state.durationSeconds ?? Infinity,value || 0))}).catch(error);
      if (command === 'mute') void active.dispatch({type:'set-muted',muted:value === 1}).catch(error);
      if (command === 'rate' && !state.isLive) void active.dispatch({type:'set-rate',rate:value || 1}).catch(error);
      if (command === 'volume') void active.dispatch({ type: 'set-volume', volume: Math.min(1, Math.max(0, value ?? 1)) }).catch(error);
    };
    window.addEventListener('pagehide', beforeLeaving);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('aperture:remote', remote);
    return () => {
      save(false,true); controller.abort(); unsubscribe();
      window.clearInterval(interval);
      window.removeEventListener('pagehide', beforeLeaving);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('aperture:remote', remote);
      if (engine.current === active) engine.current = null;
      // Serialize resource destruction before a new item can create another engine.
      setupQueue.current = task.catch(() => {}).then(async () => { await active?.destroy(); }).catch(() => {});
    };
  }, [playback]);
  const dispatch = async (command: PlayerCommand) => { try { await engine.current?.dispatch(command); } catch (reason) { error(reason); } };
  const toggle = async () => {
    const player = engine.current;
    if (!player || busy || failed) return;
    try {
      const state = player.getSnapshot();
      if (state.phase === 'playing' && (state.audioUnlocked || state.audioTracks.length === 0)) await player.dispatch({ type: 'pause' });
      else {
        // Call directly from the click/keyboard handler, before other asynchronous work.
        if (state.audioTracks.length > 0) await player.unlockAudio();
        if (player.getSnapshot().phase === 'ended') await player.dispatch({ type: 'seek', positionSeconds: 0 });
        await player.dispatch({ type: 'play' });
      }
    } catch (reason) { error(reason); }
  };
  const start = snapshot?.seekableStartSeconds ?? 0;
  const end = snapshot?.seekableEndSeconds ?? snapshot?.durationSeconds ?? 0;
  const position = snapshot?.positionSeconds ?? 0;
  const isLive = snapshot?.isLive ?? item.type === 'live';
  const seek = (value: number) => { setScrub(null); if (!isLive) void dispatch({ type: 'seek', positionSeconds: Math.max(start, Math.min(end, value)) }); };
  const skip=(side:'left'|'right')=>{
    if(isLive || end<=start || failed)return;
    const amount=side==='left'?-10:10;seek(position+amount);
    setSeekFeedback(previous=>({side,seconds:previous?.side===side?previous.seconds+10:10,key:Date.now()}));
    clearTimeout(feedbackTimer.current);feedbackTimer.current=setTimeout(()=>setSeekFeedback(null),850);reveal();
  };
  const tap=(side:'left'|'right',pointerType:string)=>{
    reveal();if(pointerType==='mouse')return;
    const now=performance.now();if(lastTap.current.side===side && now-lastTap.current.time<350){lastTouchSeek.current=now;skip(side);lastTap.current={time:0,side:''};}else lastTap.current={time:now,side};
  };
  const chooseSubtitle=async(trackId:string|null)=>{
    const track=snapshot?.subtitleTracks.find(s=>s.id===trackId);setLocalCaptions(false);setSubtitleMenu(false);
    try{await engine.current?.dispatch({type:'select-subtitle-track',trackId});const value={subtitleLanguage:track?.language||subtitlePreferences.current.subtitleLanguage,subtitlesEnabled:!!trackId};subtitlePreferences.current=await api<PlayerPreferences>('/player/preferences',value,'PATCH');}catch(reason){error(reason);}
  };
  const subtitleToggle=()=>{setSubtitleMenu(open=>!open);setAudioMenu(false);setSettings(false);};
  const qualities=[...(snapshot?.qualities||[])].filter(q=>q.id!=='auto').sort((a,b)=>(b.height||0)-(a.height||0)||(b.bandwidth||0)-(a.bandwidth||0));
  const cycleQuality=()=>{const sequence=['auto',...qualities.map(q=>q.id)];void dispatch({type:'select-quality',qualityId:sequence[(sequence.indexOf(snapshot?.selectedQualityId||'auto')+1)%sequence.length]});};
  const audioUnlockRequired = !!snapshot && snapshot.audioTracks.length > 0 && !snapshot.audioUnlocked;
  const showControls=controlsVisible || snapshot?.phase!=='playing' || audioUnlockRequired || busy || settings || subtitleMenu || audioMenu;
  const captions = localCaptions ? activeCuesAt(localCues, position) : snapshot?.activeSubtitleCues || [];
  return <div ref={surface} className={`tesplayer sutro-player ${immersive?'immersive':''} ${!remoteOnly&&showControls?'controls-visible':''}`} aria-label="TesPlayer" onPointerMove={remoteOnly?undefined:reveal} onKeyDownCapture={event=>{if(remoteOnly)return;reveal();if(event.key==='Escape' && immersive){event.preventDefault();event.stopPropagation();setImmersive(false);}}} onKeyDown={(event) => {
    if(remoteOnly)return;
    if (!(event.target instanceof HTMLElement) || event.target.closest('input, select, button')) return;
    if(event.key==='Escape' && immersive){event.stopPropagation();setImmersive(false);return;}
    if(event.key.toLowerCase()==='f'){event.preventDefault();toggleFullscreen();}
    if (event.code === 'Space' || event.key.toLowerCase() === 'k') { event.preventDefault(); void toggle(); }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && end > start) { event.preventDefault(); seek(position + (event.key === 'ArrowLeft' ? -10 : 10)); }
    if (event.key.toLowerCase() === 'm') void dispatch({ type: 'set-muted', muted: !snapshot?.muted });
  }} tabIndex={remoteOnly?-1:0}>
    <div className="tesplayer-picture">
      <canvas ref={canvas} aria-label={`${item.title} video`} />
      {(!snapshot || snapshot.diagnostics.renderedFrames === 0) && item.poster && <img className="tesplayer-poster" src={item.backdrop || item.poster} alt="" />}
      {item.type === 'audio' && <div className="tesplayer-audio"><Radio size={48} /><span>{item.title}</span></div>}
      {!remoteOnly&&<div className="tesplayer-touch-zones"><div aria-hidden="true" onPointerUp={e=>tap('left',e.pointerType)} onDoubleClick={()=>{if(performance.now()-lastTouchSeek.current>500)skip('left');}}/><div aria-hidden="true" onPointerUp={e=>tap('right',e.pointerType)} onDoubleClick={()=>{if(performance.now()-lastTouchSeek.current>500)skip('right');}}/></div>}
      {seekFeedback&&<div key={seekFeedback.key} className={`seek-feedback ${seekFeedback.side}`} role="status">{seekFeedback.side==='right'?<><ChevronRight/><ChevronRight/><ChevronRight/></>:<><ChevronLeft/><ChevronLeft/><ChevronLeft/></>}<span>{seekFeedback.seconds} seconds</span></div>}
      {remoteOnly ? ((busy || audioUnlockRequired || failed || snapshot?.phase==='paused')&&<div className="tesplayer-overlay">
        {busy?<LoaderCircle className="spin" size={32}/>:audioUnlockRequired?<button className="button primary" onClick={()=>void toggle()}>Enable sound</button>:null}
        <span role="status">{busy?message:audioUnlockRequired?'Tap once to enable picture and sound. Then use your phone.':failed?'Choose another title on your phone.':'Paused · Use your phone to resume.'}</span>
      </div>) : (busy || snapshot?.phase !== 'playing' || showControls) && <div className="tesplayer-overlay">
        {busy ? <LoaderCircle className="spin" size={32} /> : failed ? <button className="button primary" onClick={() => { reportError.current('');retries.current=0;freshRetry.current(); }}>Try again</button> : audioUnlockRequired ? <button className="button primary" onClick={() => {reveal();void toggle();}}>Enable playback on this screen</button> : <button className="tesplayer-big-play" onClick={() => {reveal();void toggle();}} aria-label={snapshot?.phase === 'playing' ? 'Pause video' : snapshot?.phase === 'ended' ? 'Play again' : 'Play video'}><SutroIcon name={snapshot?.phase==='playing'?'pause':'play'}/></button>}
        {(snapshot?.phase!=='playing' || audioUnlockRequired)&&<span role="status">{audioUnlockRequired ? 'Your phone is ready. Tap once here to start picture and sound.' : message}</span>}
      </div>}
      {captions.length > 0 && <div className="tesplayer-captions" aria-live="off">{captions.map((cue, index) => <span key={`${cue.id}-${index}`}>{cue.text}</span>)}</div>}
    {!remoteOnly&&<div ref={controls} className="tesplayer-controls" onFocusCapture={reveal}>
      <div className="tesplayer-timeline">
        {isLive ? <LiveIndicator playing={snapshot?.phase === 'playing'} /> : <>
          <input aria-label="Seek playback" type="range" min={start} max={Math.max(start, end)} step="0.1" value={scrub ?? Math.min(end, position)} disabled={!snapshot || end <= start || busy} onChange={(e) => setScrub(Number(e.target.value))} onPointerUp={(e) => seek(Number(e.currentTarget.value))} onKeyUp={(e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) seek(Number(e.currentTarget.value)); }} style={{ '--progress': `${end > start ? ((scrub ?? position) - start) / (end - start) * 100 : 0}%` } as React.CSSProperties} />
          <span>{`${time(scrub ?? position)} / ${time(snapshot?.durationSeconds || 0)}`}</span>
        </>}
      </div>
      <div className="tesplayer-toolbar">
        <div className="tesplayer-primary-controls">
          <button className="icon-button" aria-label="Previous episode or video" title={previous?`Previous: ${previous.title}`:'No previous item'} disabled={!previous||!onNavigate} onClick={()=>{if(previous)onNavigate?.(previous);}}><SkipBack size={22}/></button>
          <button className="icon-button tesplayer-play" aria-label={snapshot?.phase === 'playing' ? 'Pause' : 'Play'} disabled={!snapshot || busy || failed} onClick={() => void toggle()}><SutroIcon name={snapshot?.phase==='playing'?'pause':'play'}/></button>
          <button className="icon-button" aria-label="Next episode or video" title={next?`Next: ${next.title}`:'No next item'} disabled={!next||!onNavigate} onClick={()=>{if(next)onNavigate?.(next);}}><SkipForward size={22}/></button>
          <button className="icon-button" aria-label={snapshot?.muted ? 'Unmute' : 'Mute'} disabled={!snapshot} onClick={() => void dispatch({ type: 'set-muted', muted: !snapshot?.muted })}><SutroIcon name={snapshot?.muted?'muted':'sound'}/></button>
          <input className="tesplayer-volume" aria-label="Volume" type="range" min="0" max="1" step="0.05" value={snapshot?.volume ?? 1} disabled={!snapshot} onChange={(e) => void dispatch({ type: 'set-volume', volume: Number(e.target.value) })} />
        </div>
        <div className="tesplayer-secondary-controls">
          {canTranscode&&<button className={`player-mode-toggle ${!plexCompatibility?'enabled':''}`} role="switch" aria-checked={!plexCompatibility} aria-label="Auto playback" title={plexCompatibility?'Compatibility mode':'Automatic playback'} onClick={()=>onCompatibilityChange(!plexCompatibility)}><span className="toggle-track"><i/></span><span>{plexCompatibility?'Compatibility':'Auto'}</span></button>}
          <button className={`icon-button ${localCaptions||snapshot?.selectedSubtitleTrackId?'active':''}`} aria-label="Choose subtitles" aria-expanded={subtitleMenu} disabled={!snapshot} onClick={subtitleToggle}><Captions size={22}/></button>
          <button className={`icon-button ${audioMenu?'active':''}`} aria-label="Choose audio track" aria-expanded={audioMenu} disabled={!snapshot} onClick={()=>{setAudioMenu(open=>!open);setSubtitleMenu(false);setSettings(false);}}><Languages size={22}/></button>
          <button className="icon-button" aria-label="Player settings" aria-expanded={settings} onClick={()=>{setSettings(value=>!value);setSubtitleMenu(false);setAudioMenu(false);}}><SutroIcon name="settings"/></button>
          <button className="icon-button" aria-label={fullscreen||immersive?'Exit fullscreen':'Fullscreen video'} aria-pressed={fullscreen||immersive} onClick={toggleFullscreen}><SutroIcon name={fullscreen||immersive?'exitFullscreen':'fullscreen'}/></button>
        </div>
      </div>
      <div className="tesplayer-meta"><span><i /> TESPLAYER</span><span>{snapshot?.phase === 'playing' ? 'Playing' : snapshot?.phase === 'paused' ? 'Paused' : snapshot?.phase === 'ended' ? 'Finished' : snapshot?.isLive ? 'Live stream' : 'Ready to watch'}</span></div>
    </div>}
      {!remoteOnly&&settings&&<div className="tesplayer-settings" role="dialog" aria-label="Player settings">
          <div className="player-settings-heading"><strong>Settings</strong><button className="text-button" aria-label="Close player settings" onClick={()=>setSettings(false)}>Close</button></div>
          <div className="player-setting-row"><span>Quality</span><button className="player-choice" aria-label="Cycle video quality" disabled={!qualities.length||busy} onClick={cycleQuality}><Gauge size={18}/>{snapshot?.qualities.find(q=>q.id===snapshot.selectedQualityId)?.label||'Auto'}</button></div>
          <div className="player-setting-row"><span>Speed</span><div className="player-stepper"><button aria-label="Decrease playback speed" disabled={!snapshot||snapshot.isLive||busy||(snapshot.playbackRate||1)<=.25} onClick={()=>void dispatch({type:'set-rate',rate:Math.max(.25,(snapshot?.playbackRate||1)-.25)})}><Minus size={18}/></button><output>{snapshot?.playbackRate||1}×</output><button aria-label="Increase playback speed" disabled={!snapshot||snapshot.isLive||busy||(snapshot.playbackRate||1)>=2} onClick={()=>void dispatch({type:'set-rate',rate:Math.min(2,(snapshot?.playbackRate||1)+.25)})}><Plus size={18}/></button></div></div>
          {(snapshot?.audioTracks.length||0)>1&&<div className="player-setting-row"><span>Audio</span><div className="player-track-choices">{snapshot?.audioTracks.map(track=><button className="player-choice" aria-pressed={snapshot.selectedAudioTrackId===track.id} key={track.id} disabled={busy} onClick={()=>void dispatch({type:'select-audio-track',trackId:track.id})}><Languages size={16}/>{track.label}</button>)}</div></div>}
          <button className="text-button" onClick={()=>{setPasteCaptions(true);setSettings(false);}}>Paste subtitles</button>
          <button className="text-button" disabled={!snapshot} onClick={()=>void dispatch({type:'set-rotation',degrees:(((snapshot?.rotationDegrees||0)+90)%360) as 0|90|180|270})}>Rotate picture</button>
          <button className="text-button" disabled={!snapshot} onClick={()=>void dispatch({type:'set-aspect-mode',mode:snapshot?.aspectMode==='fill'?'fit':'fill'})}>{snapshot?.aspectMode==='fill'?'Fit picture':'Fill picture'}</button>

        </div>}
      {!remoteOnly&&audioMenu&&<div className="tesplayer-settings subtitle-choices" role="dialog" aria-label="Audio tracks"><strong>Audio</strong>{snapshot?.audioTracks.length?snapshot.audioTracks.map(track=><button className="player-choice" key={track.id} disabled={busy} aria-pressed={snapshot.selectedAudioTrackId===track.id} onClick={()=>{setAudioMenu(false);void dispatch({type:'select-audio-track',trackId:track.id});}}>{track.label||track.language||'Audio'}</button>):<p>This source supplies its default audio track only.</p>}<button className="text-button" onClick={()=>setAudioMenu(false)}>Close</button></div>}
      {!remoteOnly&&subtitleMenu&&<div className="tesplayer-settings subtitle-choices" role="dialog" aria-label="Subtitle languages"><strong>Subtitles</strong><button className="player-choice" aria-pressed={!localCaptions&&!snapshot?.selectedSubtitleTrackId} onClick={()=>void chooseSubtitle(null)}>Off</button>{snapshot?.subtitleTracks.length?snapshot.subtitleTracks.map(track=><button className="player-choice" key={track.id} aria-pressed={snapshot.selectedSubtitleTrackId===track.id} onClick={()=>void chooseSubtitle(track.id)}>{track.label}</button>):<p>No subtitle tracks available for this title.</p>}{!!localCues.length&&<button className="player-choice" onClick={()=>{setLocalCaptions(true);setSubtitleMenu(false);}}>Your subtitles</button>}<button className="text-button" onClick={()=>{setPasteCaptions(true);setSubtitleMenu(false);}}>Paste subtitles</button><button className="text-button" onClick={()=>setSubtitleMenu(false)}>Close</button></div>}
    </div>
    {pasteCaptions&&<Modal title="Add subtitles" onClose={()=>setPasteCaptions(false)}><p>Paste VTT or SRT subtitle text here.</p><textarea aria-label="Subtitle text" rows={8} maxLength={2*1024*1024} value={captionText} onChange={e=>setCaptionText(e.target.value)}/><button className="button primary" onClick={()=>{const cues=parseSubtitles(captionText,captionText.trimStart().startsWith('WEBVTT')?'webvtt':'srt');setLocalCues(cues);setLocalCaptions(true);setPasteCaptions(false);void dispatch({type:'select-subtitle-track',trackId:null});}}>Use subtitles</button></Modal>}
  </div>;
}
