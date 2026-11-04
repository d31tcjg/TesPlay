import { beginPlaybackGesture, closePlaybackAudio } from "./playback-audio";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Play,
  Plus,
  Check,
  Search,
  X,
  ArrowRight,
  Smartphone,
  Settings,
  Cable,
  RefreshCw,
  Clock,
  Info,
} from "lucide-react";
import { api, errorMessage } from "./api";
import { Brand, Busy, Card, Empty, Modal, MediaDetailsContext } from "./components";
import type {
  Auth,
  Connection,
  MediaItem,
  PlaybackSettings,
} from "./types";
import useProfileLibrary from "./useProfileLibrary";
import useAccountPreferences from "./useAccountPreferences";
import { filterLibraryForYouTubeVisibility, filterYouTubeItems, visibleQueueNeighbors } from "./youtube-visibility";
import type { LibraryIdentity } from "./profile-library";
import { episodesPath, type EpisodeCatalog } from "./episodes";
import { itemKey } from "./types";
import { idleRemotePlayback, type RemotePlayback } from "./remote-state";
import AuthScreen from "./Auth";
import DeviceApproval from "./DeviceApproval";
import Connections from "./Connections";
import Remote, { PairRemote } from "./Remote";
import { isTeslaRearScreen } from "./rear-screen";
import { isPhoneBrowser } from './phone-device';
import Navigation from './Navigation';
const RearScreen=lazy(()=>import("./RearScreen"));
const StremioSourcesDialog = lazy(() => import("./StremioSourcesDialog"));
const MediaDetails = lazy(() => import("./MediaDetails"));
const Player = lazy(() => import("./Player"));
const YouTubeHub = lazy(() => import("./YouTube"));
const Home = lazy(() => import("./Home"));
const LibraryBrowser = lazy(() => import("./LibraryBrowser"));
const GlobalSearch=lazy(()=>import("./GlobalSearch"));

const SettingsDashboard = lazy(() => import("./SettingsDashboard"));
type View =
  | "home"
  | "live"
  | "movies"
  | "series"
  | "list"
  | "history"
  | "apps"
  | "connections"
  | "settings"
  | "remote"
  | "catalog";
function initialView(): View {
  const params = new URLSearchParams(location.search);
  if (params.has("remote")) return "remote";
  const view = params.get("view");
  return (
    [
      "home",
      "live",
      "movies",
      "series",
      "list",
      "history",
      "apps",
      "connections",
      "settings",
      "remote",
    ] as string[]
  ).includes(view || "")
    ? (view as View)
    : "home";
}
export default function App() {
  const [rearScreen]=useState(()=>isTeslaRearScreen({userAgent:navigator.userAgent,width:screen.width,height:screen.height,pixelRatio:devicePixelRatio}));
  const [phone]=useState(()=>isPhoneBrowser(navigator.userAgent,(navigator as Navigator & {userAgentData?:{mobile?:boolean}}).userAgentData?.mobile));
  const [screenPaired,setScreenPaired]=useState(false);
  const [remoteLoadId,setRemoteLoadId]=useState(0);
  const [approval, setApproval] = useState(() => {
    const id = new URLSearchParams(location.search).get("approve");
    const token = new URLSearchParams(location.hash.slice(1)).get("token");
    return id && token ? { id, token } : null;
  });
  const [auth, setAuth] = useState<Auth | null>(null),
    [fatal, setFatal] = useState(""),
    [preview, setPreview] = useState(false);
  const [view, setView] = useState<View>(initialView),
    [connections, setConnections] = useState<Connection[]>([]),
    [selectedConnection, setSelectedConnection] = useState<Connection | null>(
      null,
    ),
    [kind, setKind] = useState("all");
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [searchOpen, setSearchOpen] = useState(false),
    [player, setPlayer] = useState<MediaItem | null>(null),
    [playerSettings,setPlayerSettings]=useState<PlaybackSettings>({}),
    [seriesEpisodes,setSeriesEpisodes]=useState<MediaItem[]>([]),
    [episodesLoading,setEpisodesLoading]=useState(false),
    [episodesError,setEpisodesError]=useState(""),
    [previousEpisode,setPreviousEpisode]=useState<MediaItem|undefined>(),
    [nextEpisode, setNextEpisode] = useState<MediaItem | undefined>(),
    [playerIdentity, setPlayerIdentity] = useState<LibraryIdentity | null>(null),
    [details, setDetails] = useState<MediaItem | null>(null),
    [stremioTitle, setStremioTitle] = useState<MediaItem | null>(null),
    [profileOpen, setProfileOpen] = useState(false),
    [profileName, setProfileName] = useState(""),
    [profileBusy, setProfileBusy] = useState(false),
    [initialConnection, setInitialConnection] = useState<string | undefined>(),
    [toast, setToast] = useState(""),
    [pairOpen, setPairOpen] = useState(false),
    [roomId, setRoomId] = useState(""),
    [controllerRoom,setControllerRoom]=useState("");
  const [deleteProfileId,setDeleteProfileId]=useState<string|null>(null);
  const seriesOpenRequest=useRef<AbortController|null>(null);
  useEffect(()=>()=>seriesOpenRequest.current?.abort(),[auth?.activeProfileId]);
  const remoteSnapshot = useRef<{key:string;state:RemotePlayback}|null>(null);
  const remoteMode=!rearScreen&&(auth?.scope==='remote'||auth?.deviceMode==='remote'||view==='remote');
  // QR sessions already carry their target. Identity resets must not erase it.
  const activeRemoteRoom=remoteMode ? auth?.remoteRoomId || controllerRoom : controllerRoom;
  const bootRequest=useRef<Promise<Auth>|null>(null);
  const [remoteLink]=useState(()=>new URLSearchParams(location.search).has("remote")&&new URLSearchParams(location.hash.slice(1)).has("token"));
  const [connectionsReady, setConnectionsReady] = useState(false), [connectionsError, setConnectionsError] = useState("");
  const activeLibraryRef=useRef("");
  activeLibraryRef.current=`${auth?.user?.id||""}:${auth?.activeProfileId||""}`;
  const [epg, setEpg] = useState<
      | { title: string; start: string; end: string; description?: string }[]
      | null
    >(null),
    [epgItem, setEpgItem] = useState<MediaItem | null>(null),
    [epgError, setEpgError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const signedIn = !!auth?.user && (!rearScreen || auth?.scope!=='remote');
  const [browseCategory,setBrowseCategory]=useState('');
  const [browseParent,setBrowseParent] = useState<MediaItem|undefined>();
  const [youtubeChannel,setYouTubeChannel] = useState<{id:string;title:string}|undefined>();
  const activeProfile = auth?.profiles?.find(
    (p) => p.id === auth.activeProfileId,
  );
  const showToast = useCallback((text: string) => setToast(text), []);
  const onPreferencesError = useCallback((reason: unknown) => showToast(errorMessage(reason)), [showToast]);
  const { preferences, ready: preferencesReady, busy: preferencesBusy, reloadPreferences, updatePreferences } = useAccountPreferences({
    userId: auth?.user?.id,
    canWrite: auth?.scope !== 'remote',
    onError: onPreferencesError,
  });
  // Avoid briefly showing hidden videos while this account's choice is loading.
  const hideYouTubeShorts = !!auth?.user && (!preferencesReady || !!preferences.hideYouTubeShorts);
  const { library: rawLibrary, libraryIdentity, loadLibrary, favorite, star, updateQueue, saveLibraryProgress } = useProfileLibrary({
    userId: auth?.user?.id,
    profileId: auth?.activeProfileId,
    connections,
    onToast: showToast,
  });
  const library = useMemo(() => filterLibraryForYouTubeVisibility(rawLibrary, hideYouTubeShorts, connections), [rawLibrary, hideYouTubeShorts, connections]);
  const playerProfileId = playerIdentity?.profileId || null;
  const favorites = useMemo(
    () => new Set([...library.favorites,...(library.queue||[])].map(itemKey)),
    [library.favorites,library.queue],
  );
  const reloadConnections = useCallback(async () => {
    const identity=activeLibraryRef.current;
    try {
      const r = await api<{ connections: Connection[] }>("/connections");
      if(identity!==activeLibraryRef.current)return;
      setConnections(previous=>JSON.stringify(previous)===JSON.stringify(r.connections)?previous:r.connections); setConnectionsError("");
    } catch (e) { if(identity===activeLibraryRef.current)setConnectionsError(errorMessage(e)); throw e; }
    finally { if(identity===activeLibraryRef.current)setConnectionsReady(true); }
  }, []);
  const reloadAuth = useCallback(async () => {
    setAuth(await api<Auth>("/auth/status"));
  }, []);
  const refreshManagedConnections = useCallback(async () => {
    await reloadConnections();
    await loadLibrary();
  }, [reloadConnections, loadLibrary]);
  const finishRemoteApproval=useCallback((value:Auth)=>{
    setAuth(value);setControllerRoom(value.remoteRoomId||"");setApproval(null);setView("remote");
    history.replaceState(null,"",`${location.pathname}?view=remote`);
  },[]);
  const disconnectRearRemote=useCallback(async()=>{
    const result=await api<{roomId:string}>("/remote/screen/disconnect",{roomId});
    setPlayer(null);setScreenPaired(false);setRoomId(result.roomId);
  },[roomId]);
  useEffect(()=>{if(rearScreen&&!screenPaired)setPlayer(null);},[rearScreen,screenPaired]);
  useEffect(() => {
    let stopped=false;
    if(!bootRequest.current)bootRequest.current=(async()=>{
      const code=new URLSearchParams(location.search).get('remote');
      const token=new URLSearchParams(location.hash.slice(1)).get('token');
      if(code&&token){
        const value=await api<Auth & {roomId:string}>('/auth/remote/redeem',{code,token});
        const url=new URL(location.href);url.searchParams.delete('remote');url.searchParams.set('view','remote');url.hash='';history.replaceState(null,'',url.pathname+url.search);
        return value;
      }
      return api<Auth>('/auth/status');
    })();
    bootRequest.current.then(value=>{if(!stopped)setAuth(value);}).catch(e=>{if(!stopped)setFatal(errorMessage(e));});
    return()=>{stopped=true;};
  }, []);
  useEffect(()=>{
    if(!rearScreen || !fatal)return;
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    const retry=async()=>{
      try{
        const value=await api<Auth>('/auth/status',undefined,undefined,controller.signal);
        if(!controller.signal.aborted){setAuth(value);setFatal('');}
      }catch{if(!controller.signal.aborted)timer=setTimeout(retry,15000);}
    };
    timer=setTimeout(retry,2500);
    return()=>{controller.abort();clearTimeout(timer);};
  },[rearScreen,fatal]);
  useEffect(()=>{
    if(!signedIn||remoteMode||approval){setRoomId('');return;}
    const controller=new AbortController();
    void api<{roomId:string}>('/remote/screen',{},undefined,controller.signal).then(value=>{if(!controller.signal.aborted)setRoomId(value.roomId);}).catch(e=>{if(!controller.signal.aborted)showToast(errorMessage(e));});
    return()=>controller.abort();
  },[signedIn,auth?.user?.id,auth?.activeProfileId,remoteMode,approval,showToast]);
  const exitRemote=useCallback(async()=>{
    if(auth?.scope==='remote')await api('/auth/logout',{});
    else await api('/remote/disconnect',{});
    setControllerRoom('');setView('home');history.replaceState(null,'',location.pathname);await reloadAuth();
  },[auth?.scope,reloadAuth]);
  useEffect(() => {
    if (!signedIn) {
      setConnections([]); setConnectionsReady(false); setConnectionsError("");
      return;
    }
    void Promise.all([reloadConnections(), loadLibrary()]).catch((e) =>
      showToast(errorMessage(e)),
    );
  }, [
    signedIn,
    auth?.user?.id,
    auth?.activeProfileId,
    reloadConnections,
    loadLibrary,
    showToast,
  ]);
  useEffect(() => {
    if (!signedIn) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "visible") return;
      void reloadAuth().catch(()=>{});
      void reloadPreferences();
      void loadLibrary().catch(() => {});
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [signedIn, loadLibrary, reloadAuth, reloadPreferences]);
  const plexConnectionKey=connections.filter(c=>c.type==='plex').map(c=>c.id).join(',');
  useEffect(()=>{if(signedIn&&plexConnectionKey)void loadLibrary().catch(()=>{});},[signedIn,plexConnectionKey,auth?.activeProfileId,loadLibrary]);
  useEffect(() => {
    setNextEpisode(undefined);setPreviousEpisode(undefined);setSeriesEpisodes([]);setEpisodesError('');setEpisodesLoading(false);
    if (!signedIn || player?.type !== "episode" || !player.connectionId) return;
    const controller = new AbortController();setEpisodesLoading(true);
    void api<EpisodeCatalog>(
      episodesPath(player),undefined,undefined,controller.signal,
    ).then(result=>{if(!controller.signal.aborted){setNextEpisode(result.next||undefined);setPreviousEpisode(result.previous||undefined);setSeriesEpisodes(result.items);}})
      .catch(e=>{if(!controller.signal.aborted)setEpisodesError(errorMessage(e));})
      .finally(()=>{if(!controller.signal.aborted)setEpisodesLoading(false);});
    return()=>controller.abort();
  },[signedIn,player?.id,player?.connectionId,player?.type]);
  async function updateAutoplay(autoPlayNext: boolean) {
    await updatePreferences({ autoPlayNext });
  }
  async function updateYouTubeShorts(hideYouTubeShorts: boolean) {
    await updatePreferences({ hideYouTubeShorts });
  }
  useEffect(() => {
    const id = setTimeout(() => {
      setQuery(search.trim());

    }, 300);
    return () => clearTimeout(id);
  }, [search]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 6500);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);
  useEffect(() => {
    const restoreView = () => {
      setView(initialView());
      setBrowseParent(undefined);
      setSearch("");
      setQuery("");
      setSearchOpen(false);
    };
    window.addEventListener("popstate", restoreView);
    return () => window.removeEventListener("popstate", restoreView);
  }, []);
  useEffect(() => {
    if (!roomId || !signedIn || remoteMode || approval) return;
    const events = new EventSource(
      `/api/remote/events?roomId=${encodeURIComponent(roomId)}`,
    );
    events.onmessage = (e) => {
      try {
        const command = JSON.parse(e.data);
        if(command.command === "queue-changed") {void loadLibrary().catch(()=>{});return;}
        if(command.command === "load" && command.item) { setPlayerIdentity(libraryIdentity);setRemoteLoadId(n=>n+1);setPlayerSettings(command.settings || {});setPlayer(command.item);void loadLibrary().catch(()=>{});return;}
        window.dispatchEvent(
          new CustomEvent("aperture:remote", { detail: command }),
        );
      } catch {
        /* Heartbeats contain no command. */
      }
    };
    events.addEventListener("paired", () => {
      setScreenPaired(true);
      setPairOpen(false);
      showToast("Phone remote connected. Choose a video on your phone.");
    });
    events.addEventListener("ready",event=>{
      try{setScreenPaired(JSON.parse((event as MessageEvent).data).paired===true);}catch{/* Reconnect will provide fresh pairing state. */}
    });
    events.onerror = () =>
      !rearScreen&&showToast(
        "Reconnecting your phone remote…",
      );
    return () => events.close();
  }, [roomId, signedIn, showToast, auth?.activeProfileId,libraryIdentity,loadLibrary,rearScreen,remoteMode,approval]);
  useEffect(() => {
    if (!roomId || !signedIn || remoteMode || approval) return;
    const controller = new AbortController();
    let pending = false, reported = false;
    const publish = async () => {
      if (pending) return;
      pending = true;
      const state = player && remoteSnapshot.current?.key === itemKey(player) ? remoteSnapshot.current.state : {...idleRemotePlayback, phase: player ? 'loading' as const : 'idle' as const};
      try { await api('/remote/state', {roomId, item:player, state}, undefined, controller.signal); reported=false; }
      catch (reason) { if (!controller.signal.aborted && !reported) {reported=true;showToast(errorMessage(reason));} }
      finally { pending = false; }
    };
    void publish();
    const timer = window.setInterval(publish, 1000);
    return () => {controller.abort(); window.clearInterval(timer);};
  }, [roomId, signedIn, player, showToast,remoteMode,approval]);
  function navigate(next: View) {
    if(signedIn && ['history','list'].includes(next))void loadLibrary().catch(e=>showToast(errorMessage(e)));
    setBrowseParent(undefined);
    if(next === "apps") setYouTubeChannel(undefined);
    setView(next);
    const params = new URLSearchParams(location.search);
    params.set("view", next);
    if (next !== "remote") params.delete("remote");
    if (next !== "settings") params.delete("section");
    const url = `${location.pathname}?${params}${location.hash}`;
    if (url !== `${location.pathname}${location.search}${location.hash}`) {
      if (view === "settings" || next === "settings") history.pushState(history.state, "", url);
      else history.replaceState(history.state, "", url);
    }
    setSearch("");
    setQuery("");



    setSearchOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function openFullscreen() {
    // Keep account approval and pairing credentials out of the Theater redirect.
    const returnUrl = new URL('/', location.origin);
    returnUrl.searchParams.set('view', view);
    location.assign(`https://www.youtube.com/redirect?q=${encodeURIComponent(returnUrl.href)}`);
  }
  function pairPhone() {
    if (!signedIn) { showToast("Sign in to pair your phone."); return; }
    beginPlaybackGesture();
    setPairOpen(true);
  }
  function signIn() {
    setPreview(false);
    setPlayer(null);
    setControllerRoom("");
    setRoomId("");
    closePlaybackAudio();
    const params = new URLSearchParams(location.search);
    params.delete("preview");
    history.replaceState(
      null,
      "",
      `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`,
    );
  }
  function browse(c: Connection) {
    setBrowseParent(undefined); setYouTubeChannel(undefined);setBrowseCategory('');
    setSelectedConnection(c);


    setKind("all");


    setSearch("");
    setView(c.type === "youtube" ? "apps" : "catalog");
    window.scrollTo({ top: 0 });
  }
  function connect(type?: string) {
    if (!signedIn) {
      if (preview) {
        showToast("Sign in to save your connections.");
      }
      setPreview(false);
      return;
    }
    setInitialConnection(type);
    navigate("connections");
  }
  const saveProgress = useCallback(
    (item: MediaItem, seconds: number, duration: number, state: "playing" | "paused" | "stopped" = "stopped") => {
      if (signedIn && playerIdentity) void saveLibraryProgress(playerIdentity, item, seconds, duration, state);
    },
    [signedIn, playerIdentity, saveLibraryProgress],
  );
  useEffect(()=>{setControllerRoom("");setRoomId("");setScreenPaired(false);},[auth?.user?.id,auth?.activeProfileId]);
  function inspect(item:MediaItem) {seriesOpenRequest.current?.abort();setDetails(item);}
  function open(item: MediaItem, settings:PlaybackSettings = {}) {
    seriesOpenRequest.current?.abort();
    if(item.unavailable) { showToast("This Watchlist title is not available on your Plex server."); return; }
    if(item.type==='series') {
      if(!rearScreen)beginPlaybackGesture();
      const controller=new AbortController(),identity=activeLibraryRef.current;seriesOpenRequest.current=controller;
      void api<EpisodeCatalog>(episodesPath(item),undefined,undefined,controller.signal).then(({items})=>{
        if(controller.signal.aborted||identity!==activeLibraryRef.current)return;
        const recent=library.progress.find(p=>p.seconds>0&&(!p.duration||p.seconds/p.duration<.97)&&items.some(i=>itemKey(i)===itemKey(p.item)));
        const episode=items.find(i=>recent&&itemKey(i)===itemKey(recent.item))||items.find(i=>(i.resumeSeconds||0)>0&&!i.watched)||items.find(i=>!i.watched&&!library.progress.some(p=>itemKey(p.item)===itemKey(i)&&p.duration>0&&p.seconds/p.duration>=.97))||items[0];
        if(episode)open(episode,settings);else showToast('No episodes available for this series.');
      }).catch(e=>{if(!controller.signal.aborted)showToast(errorMessage(e));});return;
    }
    if (item.type === "folder") {
      setBrowseParent(item);
      if (item.connectionId) {
        const connection = connections.find((c) => c.id === item.connectionId);
        if (connection) setSelectedConnection(connection);
        setView("catalog");


        setSearch("");

      }
      return;
    }
    if ((item.providerType === 'stremio' || connections.some(c => c.id === item.connectionId && c.type === 'stremio')) && !settings.sourceId) { setStremioTitle(item); return; }
    if(activeRemoteRoom) {
      void api('/remote/command',{roomId:activeRemoteRoom,command:'load',item,settings:{sourceId:settings.sourceId}}).then(()=>showToast(`Opening ${item.title} on your paired screen.`)).catch(e=>showToast(errorMessage(e)));return;
    }
    if(remoteMode){showToast("Connect a screen before choosing a title.");return;}
    if(!rearScreen)beginPlaybackGesture();
    setPlayerIdentity(libraryIdentity);
    setPlayerSettings(settings);
    setPlayer(item);
  }
  async function guide(item: MediaItem) {
    setEpgItem(item);
    setEpg(null);
    setEpgError("");
    try {
      const r = await api<{
        programs: {
          title: string;
          start: string;
          end: string;
          description?: string;
        }[];
      }>(
        `/epg?connectionId=${encodeURIComponent(item.connectionId || "")}&itemId=${encodeURIComponent(item.id)}`,
      );
      setEpg(r.programs);
    } catch (e) {
      setEpgError(errorMessage(e));
    }
  }
  const filter = (items: MediaItem[]) => {
    const visible = filterYouTubeItems(items, hideYouTubeShorts, connections, rawLibrary.progress);
    return query
      ? visible.filter((i) =>
          `${i.title} ${i.source} ${i.categoryLabel || i.category || ""}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
      : visible;
  };
  const progressFor = (item: MediaItem) => {
    const p = library.progress.find((p) => itemKey(p.item) === itemKey(item));
    return p && p.duration > 0 ? (p.seconds / p.duration) * 100 : undefined;
  };
  const cards = (items: MediaItem[]) => (
    <div className="catalog-grid">
      {filterYouTubeItems(items, hideYouTubeShorts, connections, rawLibrary.progress).map((item) => (
        <div key={itemKey(item)}>
          <Card
            item={item}
            onOpen={open}
            onFavorite={favorite}
            saved={favorites.has(itemKey(item))}
            progress={progressFor(item)}
          />
          {item.type === "live" &&
            item.connectionId &&
            connections.find((c) => c.id === item.connectionId)?.type ===
              "xtream" && (
              <button
                className="text-button program-button"
                onClick={() => guide(item)}
              >
                <Clock size={14} /> Program guide
              </button>
            )}
        </div>
      ))}
    </div>
  );
  const stremioPicker = stremioTitle && <Suspense fallback={<Busy label="Finding Stremio sources…"/>}><StremioSourcesDialog key={itemKey(stremioTitle)} item={stremioTitle} onClose={()=>setStremioTitle(null)} onPlay={sourceId=>{const item=stremioTitle;setStremioTitle(null);open(item,{sourceId});}}/></Suspense>;
  const queueNavigation = player ? visibleQueueNeighbors(rawLibrary.queue || [], player, hideYouTubeShorts, connections, rawLibrary.progress) : null;
  const playerView=player&&<Suspense fallback={rearScreen?<div className="rear-opening-player"><Busy label="Opening player"/></div>:<Busy label="Opening player"/>}>
    <Player key={rearScreen?`${playerProfileId}:remote:${remoteLoadId}`:playerProfileId||"player"}
      item={player} remoteOnly={rearScreen} settings={playerSettings}
      episodes={seriesEpisodes} episodesLoading={episodesLoading} episodesError={episodesError}
      previous={preferencesReady ? (queueNavigation?.inQueue ? queueNavigation.previous : previousEpisode) : undefined}
      resume={(()=>{const saved=rawLibrary.progress.find(p=>itemKey(p.item)===itemKey(player));return saved&&saved.duration>0&&saved.seconds/saved.duration<.97?saved.seconds:0;})()}
      canTranscode={connections.some(c=>c.id===player.connectionId&&c.type==="plex")}
      onClose={()=>{setPlayer(null);if(!rearScreen)closePlaybackAudio();}}
      onRemoteState={state=>{remoteSnapshot.current={key:itemKey(player),state};}}
      onProgress={saveProgress}
      next={preferencesReady ? (queueNavigation?.inQueue ? queueNavigation.next : nextEpisode) : undefined}
      autoPlayNext={preferencesReady && (!!queueNavigation?.inQueue || preferences.autoPlayNext)}
      onNext={item=>open(item,{sourceId:'auto'})}/>
  </Suspense>;
  if (rearScreen)return <><Suspense fallback={<div className="boot"><Brand/></div>}><RearScreen auth={auth} roomId={roomId} paired={screenPaired} onPairState={setScreenPaired} onAuth={setAuth} onDisconnect={disconnectRearRemote} serverError={fatal}/></Suspense>{playerView}{stremioPicker}</>;
  if (fatal)
    return (
      <div className="fatal">
        <Brand />
        <Empty title={remoteLink?"This remote link couldn’t connect":"Your server is taking a moment"}>
          {fatal}
          <br />
          {remoteLink?"Scan a new QR code from your screen.":"Start the TesPlay server, then refresh."}
        </Empty>
        <button className="button primary" onClick={() => location.reload()}>
          <RefreshCw size={17} />
          Try again
        </button>
      </div>
    );
  if (!auth)
    return (
      <div className="boot">
        <Brand />
        <Busy label="Opening your cinema" />
      </div>
    );
  if (!auth.user)
    return (
      <AuthScreen
        auth={auth}
        onAuth={(a) => {
          setAuth(a);
          setPreview(false);
        }}
      />
    );
  if (approval && auth.user && !rearScreen)
    return (
      <DeviceApproval
        {...approval}
        onRemoteConnected={finishRemoteApproval}
        onDone={() => {
          history.replaceState(null, "", location.pathname);
          setApproval(null);
          setView("home");
        }}
      />
    );
  if(remoteMode)return <><Remote hideYouTubeShorts={hideYouTubeShorts} key={auth.activeProfileId} auth={auth} onAuth={setAuth} onExit={exitRemote} onSessionLost={reloadAuth} room={activeRemoteRoom} setRoom={setControllerRoom} connections={connections} library={rawLibrary} onOpen={open} onFavorite={favorite} onStar={star} onAddQueue={item=>updateQueue('add',item)} onClearQueue={()=>updateQueue('clear')} onRemoveQueue={item=>updateQueue('remove',item)} onReloadLibrary={loadLibrary}/>{stremioPicker}{toast&&<div className="toast" role="status">{toast}</div>}</>;
  return (
    <MediaDetailsContext.Provider value={{onDetails:inspect,onPlay:open}}><div className="app-shell" data-navigation-overlay={view === "home" && !searchOpen && !controllerRoom}>
      {controllerRoom&&<div className="remote-casting-bar" role="status"><Smartphone size={16}/><span>Select a video to play on your paired screen</span><button className="text-button" onClick={()=>navigate('remote')}>Controls</button><button className="text-button" onClick={()=>setControllerRoom('')}>Disconnect</button></div>}
      <Navigation view={view} phone={phone} signedIn={signedIn} searchOpen={searchOpen} profileOpen={profileOpen} onNavigate={navigate}
        onSearch={()=>{setSearchOpen(value=>!value);if(searchOpen){setSearch('');setQuery('');}}}
        onRemote={()=>signedIn?navigate('remote'):signIn()} onProfile={()=>setProfileOpen(true)} onSignIn={signIn}/>
      {searchOpen && (
        <div className="search-bar">
          <Search size={20} />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search your library…"
            aria-label="Search titles"
          />
          <button
            className="icon-button"
            aria-label="Close search"
            onClick={() => {
              setSearchOpen(false);
              setSearch("");setQuery("");
            }}
          >
            <X size={19} />
          </button>
        </div>
      )}
      <main>
        {searchOpen&&query&&<Suspense fallback={<Busy label="Searching your libraries…"/>}><GlobalSearch hideYouTubeShorts={hideYouTubeShorts} key={auth.activeProfileId} query={query} connections={connections} library={rawLibrary} onOpen={open} onFavorite={favorite} onChannel={(c,channel)=>{browse(c);setYouTubeChannel(channel);setSearchOpen(false);setSearch('');setQuery('');}}/></Suspense>}
        <div hidden={searchOpen&&!!query}>
        {view === "home" && (
          <Suspense fallback={<Busy label="Loading your home…" />}>
            <Home hideYouTubeShorts={hideYouTubeShorts} cacheIdentity={`${auth.user.id}:${auth.activeProfileId}`} key={auth?.activeProfileId || "preview"} connections={connections} library={rawLibrary} signedIn={signedIn} query={query} connectionsReady={connectionsReady} connectionsError={connectionsError} onReloadConnections={reloadConnections} canManage={auth.user.canManageConnections ?? auth.user.role === "owner"}
              onOpen={open} onFavorite={favorite} onDetails={inspect} onConnect={connect} onNavigate={navigate}
              onBrowse={(c, parent, nextKind, channel, category) => { browse(c); if (parent) open(parent); else if (nextKind) setKind(nextKind); if(channel) setYouTubeChannel(channel);if(category)setBrowseCategory(category); }}
              onUnavailable={() => showToast("Crunchyroll does not currently provide a supported in-app playback integration for TesPlay.")} />
          </Suspense>
        )}
        {view === "connections" && !(auth.user.canManageConnections ?? auth.user.role === "owner") && <section className="page-section"><div className="page-heading"><div><span className="eyebrow">Shared with you</span><h1>Your connections</h1><p>Your server owner manages these libraries and their settings.</p></div></div><div className="shared-connections">{connections.map(c=><button className="button ghost" key={c.id} onClick={()=>browse(c)}>{c.type==="youtube"?"YouTube":c.name}<ArrowRight size={17}/></button>)}</div>{!connections.length&&<Empty title="No libraries shared yet">Your server owner can give your account access in Accounts & access.</Empty>}</section>}
        {view === "connections" && (auth.user.canManageConnections ?? auth.user.role === "owner") && (
          <Connections
            connections={connections}
            onRefresh={refreshManagedConnections}
            onBrowse={browse}
            initialType={initialConnection}
            onInitialUsed={() => setInitialConnection(undefined)}
            preview={!signedIn}
            onSignIn={signIn}
          />
        )}
        {["movies","series","live","catalog"].includes(view) && (
          <Suspense fallback={<Busy label="Loading your libraries…"/>}>
            <LibraryBrowser hideYouTubeShorts={hideYouTubeShorts} key={`${auth.activeProfileId}:${view}:${selectedConnection?.id||"all"}`} mode={view as "movies"|"series"|"live"|"catalog"} selectedConnection={selectedConnection} initialParent={browseParent} initialKind={kind} initialCategory={browseCategory} connections={connections} library={rawLibrary} query={query} onOpen={open} onFavorite={favorite} onStar={star} onConnect={()=>navigate("connections")} onYouTube={()=>navigate("apps")} onGuide={guide}/>
          </Suspense>
        )}
        {view === "list" && (
          <section className="page-section">
            <div className="page-heading">
              <div>
                <span className="eyebrow">Save it for later</span>
                <h1>My list</h1>
                <p>A few things to look forward to.</p>
              </div>
              <span className="count-pill">
                {new Set([...library.favorites,...(library.plexWatchlist||[])].map(itemKey)).size} titles
              </span>
            </div>
            {library.plexNotes?.map(note=><p className="form-help" role="status" key={note}>{note}</p>)}
            {!!library.plexWatchlist?.length&&<section className="plex-watchlist"><h2>Plex Watchlist</h2>{cards(filter(library.plexWatchlist))}</section>}
            {library.favorites.length ? (
              cards(filter(library.favorites))
            ) : library.plexWatchlist?.length ? <p className="form-help">Use the plus on a title to save it to your TesPlay list.</p> : (
              <Empty
                title="Your next favorites live here"
                action={
                  <button
                    className="button primary"
                    onClick={() => navigate("home")}
                  >
                    Find something to watch <ArrowRight size={18} />
                  </button>
                }
              >
                Tap the plus on a title to keep it for your next break.
                {!signedIn && " Sign in to save your list."}
              </Empty>
            )}
          </section>
        )}
        {view === "history" && (
          <section className="page-section">
            <div className="page-heading">
              <div>
                <span className="eyebrow">Your recent watches</span>
                <h1>Watch history</h1>
                <p>
                  {activeProfile?.name || "Your profile"}’s playback history and
                  saved progress.
                </p>
              </div>
              <span className="count-pill">
                {library.progress.length} titles
              </span>
            </div>
            {library.plexNotes?.map(note=><p className="form-help" role="status" key={note}>{note}</p>)}
            <button className="text-button" onClick={()=>void loadLibrary().catch(e=>showToast(errorMessage(e)))}><RefreshCw size={16}/>Refresh Plex history and progress</button>
            {library.progress.length ? (
              <div className="catalog-grid">
                {library.progress
                  .filter((p) => filter([p.item]).length > 0)
                  .map((entry) => (
                    <div key={itemKey(entry.item)}>
                      <Card
                        item={entry.item}
                        onOpen={open}
                        onFavorite={favorite}
                        saved={favorites.has(itemKey(entry.item))}
                        progress={progressFor(entry.item)}
                      />
                      <div className="history-meta">
                        <span>
                          {entry.duration > 0
                            ? entry.seconds / entry.duration >= 0.97
                              ? "Finished"
                              : `${Math.floor(entry.seconds / 60)} of ${Math.ceil(entry.duration / 60)} min`
                            : "Recently played"}
                        </span>
                        <time dateTime={entry.updatedAt}>
                          {new Date(entry.updatedAt).toLocaleDateString(
                            undefined,
                            { month: "short", day: "numeric" },
                          )}
                        </time>
                      </div>
                    </div>
                  ))}
              </div>
            ) : (
              <Empty
                icon={<Clock size={34} />}
                title={
                  signedIn
                    ? "Your story starts here"
                    : "Sign in to keep your history"
                }
                action={
                  <button
                    className="button primary"
                    onClick={signedIn ? () => navigate("home") : signIn}
                  >
                    {signedIn ? "Find something to watch" : "Sign in"}
                  </button>
                }
              >
                Titles appear here when you start watching. Your place is saved
                automatically.
              </Empty>
            )}
          </section>
        )}
        {view === "apps" && (
          <Suspense fallback={<Busy label="Loading YouTube…" />}>
            <YouTubeHub hideYouTubeShorts={hideYouTubeShorts} connections={connections} library={rawLibrary} onOpen={open} onFavorite={favorite}
              onConnect={() => connect(connections.some(c => c.type === "youtube") ? undefined : "youtube")} initialConnectionId={selectedConnection?.type === "youtube" ? selectedConnection.id : undefined} initialChannel={youtubeChannel} onStar={star} onClearQueue={()=>void updateQueue("clear").catch(e=>showToast(errorMessage(e)))} onRemoveQueue={item=>void updateQueue("remove",item).catch(e=>showToast(errorMessage(e)))} />
          </Suspense>
        )}
        {view === "settings" && <Suspense fallback={<Busy label="Loading settings…"/>}><SettingsDashboard preferencesReady={preferencesReady} onHideYouTubeShorts={updateYouTubeShorts} onReloadPreferences={reloadPreferences} auth={auth} connections={connections} preferences={preferences} preferencesBusy={preferencesBusy} profileBusy={profileBusy} onAutoplay={updateAutoplay} onRemovedCurrent={reloadAuth} onReloadConnections={refreshManagedConnections} onBrowse={browse} onManageProfiles={()=>setProfileOpen(true)} onSwitchProfile={async id=>{
          setProfileBusy(true);try{await api(`/profiles/${id}/select`,{});await reloadAuth();setPlayer(null);}catch(e){showToast(errorMessage(e));}finally{setProfileBusy(false);}
        }} phone={phone} onFullscreen={openFullscreen} onRemote={()=>navigate('remote')} onPairPhone={pairPhone} onHistory={()=>navigate('history')} onSignOut={async()=>{await api('/auth/logout',{});setPlayer(null);setRoomId('');setControllerRoom('');closePlaybackAudio();await reloadAuth();setView('home');}} onToast={showToast} initialConnection={initialConnection} onInitialUsed={()=>setInitialConnection(undefined)}/></Suspense>}
        </div>
      </main>
      <footer className="app-footer">
        <div>
          <Brand />
          <span>Your screen. Your stories.</span>
        </div>
        <nav aria-label="Additional navigation">
          <button onClick={() => navigate("connections")}>
            <Cable size={16} />
            Connections
          </button>
          <button onClick={() => navigate("history")}>
            <Clock size={16} />
            History
          </button>
          <button onClick={() => navigate("settings")}>
            <Settings size={16} />
            Settings
          </button>
        </nav>
        <span className="footer-note">
          Personal cinema
        </span>
      </footer>
      {toast && (
        <div className="toast" role="status">
          <Info size={18} />
          {toast}
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={17} />
          </button>
        </div>
      )}
      {stremioPicker}
      {details&&<Suspense fallback={<Busy label="Opening title details"/>}><MediaDetails key={itemKey(details)} item={details} saved={favorites.has(itemKey(details))} isPlex={connections.some(c=>c.id===details.connectionId&&c.type==='plex')} onClose={()=>setDetails(null)} onFavorite={favorite} onPlay={(item,settings)=>{open(item,settings);setDetails(null);}}/></Suspense>}
      {playerView}
      {pairOpen && (
        <PairRemote onClose={() => setPairOpen(false)} onReady={setRoomId} />
      )}
      {deleteProfileId&&<Modal title="Remove this profile?" onClose={()=>{if(!profileBusy)setDeleteProfileId(null);}}><p>{auth.profiles.find(p=>p.id===deleteProfileId)?.name}’s viewing history, watchlist, playlist and saved preferences will be removed. This cannot be undone.</p><div className="form-actions"><button className="button danger" disabled={profileBusy} onClick={async()=>{setProfileBusy(true);try{await api(`/profiles/${deleteProfileId}`,{},'DELETE');if(deleteProfileId===auth.activeProfileId){setPlayer(null);setRoomId('');setControllerRoom('');setView('home');}await reloadAuth();setDeleteProfileId(null);showToast('Profile removed.');}catch(e){showToast(errorMessage(e));}finally{setProfileBusy(false);}}}>{profileBusy?'Removing…':'Remove profile'}</button><button className="button ghost" disabled={profileBusy} onClick={()=>setDeleteProfileId(null)}>Cancel</button></div></Modal>}
      {profileOpen && (
        <Modal title="Who’s watching?" onClose={() => setProfileOpen(false)}>
          <p className="form-help">
            Your watchlist and progress follow your profile.
          </p>
          <div className="profile-grid">
            {auth.profiles.map((p) => (
              <div className="profile-choice-row" key={p.id}><button
                className={`profile-choice ${p.id === auth.activeProfileId ? "selected" : ""}`}
                key={p.id}
                disabled={profileBusy}
                onClick={async () => {
                  setProfileBusy(true);
                  try {
                    await api(`/profiles/${p.id}/select`, {});
                    await reloadAuth();
                    setProfileOpen(false);
                    setPlayer(null);
                    setView("home");
                  } catch (e) {
                    showToast(errorMessage(e));
                  } finally {
                    setProfileBusy(false);
                  }
                }}
              >
                <span className="avatar" style={{ background: p.color }}>
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
                <span>{p.name}</span>
                {p.id === auth.activeProfileId && <Check size={16} />}
              </button><button className="text-button profile-remove" disabled={profileBusy||auth.profiles.length<2} onClick={()=>{setProfileOpen(false);setDeleteProfileId(p.id);}} aria-label={`Remove ${p.name} profile`}>Remove</button></div>
            ))}
          </div>
          <form
            className="profile-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setProfileBusy(true);
              try {
                await api("/profiles", {
                  name: profileName,
                  color: ["#bd7056", "#5269ae", "#658a73", "#9169a9"][
                    auth.profiles.length % 4
                  ],
                });
                await reloadAuth();
                setProfileName("");
              } catch (err) {
                showToast(errorMessage(err));
              } finally {
                setProfileBusy(false);
              }
            }}
          >
            <label>
              Add a profile
              <input
                required
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                placeholder="Name"
                maxLength={40}
              />
            </label>
            <button className="button ghost" disabled={profileBusy}>
              <Plus size={17} />
              Add
            </button>
          </form>
          <p className="form-help">
            Plex Home profiles can be selected from the people icon next to your
            Plex connection.
          </p>
        </Modal>
      )}
      {epgItem && (
        <Modal title={`On ${epgItem.title}`} onClose={() => setEpgItem(null)}>
          {epgError ? (
            <p className="form-error">{epgError}</p>
          ) : epg === null ? (
            <Busy label="Loading program guide" />
          ) : epg.length ? (
            epg.map((p, i) => (
              <div className="program" key={i}>
                <span>
                  {new Date(p.start).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}{" "}
                  –{" "}
                  {new Date(p.end).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <h3>{p.title}</h3>
                <p>{p.description}</p>
              </div>
            ))
          ) : (
            <p>Your provider has no program information for this channel.</p>
          )}
          <button
            className="button primary"
            onClick={() => {
              open(epgItem);
              setEpgItem(null);
            }}
          >
            <Play size={17} fill="currentColor" />
            Watch channel
          </button>
        </Modal>
      )}
    </div></MediaDetailsContext.Provider>
  );
}
