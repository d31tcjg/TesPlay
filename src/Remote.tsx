import { filterLibraryForYouTubeVisibility } from "./youtube-visibility";
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
  Pause,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  Captions,
  Maximize,
  SlidersHorizontal,
  Monitor,
  ListVideo,
  Film,
  X,
  Plus,
  Smartphone,
  Link,
  Copy,
  Check,
  LogOut,
} from "lucide-react";
import { api, ApiError, errorMessage } from "./api";
import { Brand, Busy, Modal } from "./components";
import { beginPlaybackGesture } from "./playback-audio";
import LiveIndicator from "./LiveIndicator";
import QrCode, { isLocalOnlyUrl } from "./QrCode";
export function PairRemote({
  onClose,
  onReady,
}: {
  onClose: () => void;
  onReady: (roomId: string) => void;
}) {
  const [pair, setPair] = useState<{
      token: string;
      code: string;
      roomId: string;
      expiresAt: string;
    } | null>(null),
    [error, setError] = useState(""),
    [copied, setCopied] = useState(false);
  useEffect(() => {
    let dead = false;
    api<{ code: string; token: string; roomId: string; expiresAt: string }>(
      "/remote/pair",
      {},
    )
      .then((r) => {
        if (dead) return;
        setPair(r);
        onReady(r.roomId);
      })
      .catch((e) => setError(errorMessage(e)));
    return () => {
      dead = true;
    };
  }, [onReady]);
  const [publicUrl, setPublicUrl] = useState(location.origin);
  useEffect(() => {
    let dead = false;
    api<{ publicUrl?: string }>("/settings")
      .then((settings) => {
        if (!dead && settings.publicUrl)
          setPublicUrl(settings.publicUrl.replace(/\/$/, ""));
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, []);
  const link = `${publicUrl}/?remote=${encodeURIComponent(pair?.code || "1")}#token=${encodeURIComponent(pair?.token || "")}`;
  return (
    <Modal title="Your phone. Your remote." onClose={onClose}>
      <div className="pair-illustration">
        <Smartphone size={44} />
        <Link size={23} />
        <Play size={36} />
      </div>
      <p>
        Scan with any phone to connect its remote immediately. No TesPlay login
        is needed.
      </p>
      <button
        className="button primary full"
        onClick={() => beginPlaybackGesture()}
      >
        Enable playback on this screen
      </button>
      <p className="form-help">
        Tap once so your phone can start videos with sound.
      </p>
      {pair && (
        <QrCode value={link} label="Scan to connect your phone remote" />
      )}
      <div className="pair-code">{pair?.code || "··· ···"}</div>
      {isLocalOnlyUrl(link) && (
        <div className="qr-local-notice">
          Your phone needs a reachable TesPlay address. This computer-only
          preview cannot be opened on another device.
        </div>
      )}
      <p className="form-help">
        {pair
          ? `Pair before ${new Date(pair.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. You can close this panel after entering the code. This browser stays authorized until you remove it in Settings or its authorization expires.`
          : "Creating a secure pairing code…"}
      </p>
      <button
        className="button ghost full"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(link);
            setCopied(true);
          } catch {
            setError(`Open ${link} on your phone.`);
          }
        }}
      >
        {copied ? <Check size={18} /> : <Copy size={18} />}{" "}
        {copied ? "Link copied" : "Copy remote link"}
      </button>
      {error && <div className="form-error">{error}</div>}
    </Modal>
  );
}

import RemoteConnect from "./RemoteConnect";
import RemoteVideoSources from "./RemoteVideoSources";
import RemoteNavigation from "./RemoteNavigation";
import RemoteDrawer from "./RemoteDrawer";
import type { RemoteTab } from "./RemoteNavigation";
import type { Auth, Connection, Library, MediaItem, Starred } from "./types";
import { itemKey } from "./types";
import type { RemoteState } from "./remote-state";
import "./remote.css";
import "./remote-layout.css";
const RemoteLibrary = lazy(() => import("./RemoteLibrary"));
const RemoteEpisodes = lazy(() => import("./RemoteEpisodes"));
const clock = (seconds: number) => {
  const n = Math.floor(Math.max(0, seconds));
  return n >= 3600
    ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`
    : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};
export default function Remote({
  room,
  setRoom,
  connections,
  library: rawLibrary,
  hideYouTubeShorts = false,
  onOpen,
  onFavorite,
  onStar,
  onAddQueue,
  onRemoveQueue,
  onClearQueue,
  onReloadLibrary,
  auth,
  onAuth,
  onExit,
  onSessionLost,
}: {
  auth: Auth;
  onAuth: (value: Auth) => void;
  onExit: () => Promise<void>;
  onSessionLost: () => Promise<void>;
  room: string;
  setRoom: (value: string) => void;
  connections: Connection[];
  library: Library;
  hideYouTubeShorts?: boolean;
  onOpen: (item: MediaItem) => void;
  onFavorite: (item: MediaItem) => void;
  onStar: (value: Starred) => void;
  onAddQueue: (item: MediaItem) => Promise<unknown>;
  onRemoveQueue: (item: MediaItem) => Promise<unknown>;
  onClearQueue: () => Promise<unknown>;
  onReloadLibrary: () => Promise<unknown>;
}) {
  const library = useMemo(
    () =>
      filterLibraryForYouTubeVisibility(
        rawLibrary,
        hideYouTubeShorts,
        connections,
      ),
    [rawLibrary, hideYouTubeShorts, connections],
  );
  const connected = useCallback(
    (value: Auth, roomId: string) => {
      onAuth(value);
      setRoom(roomId);
    },
    [onAuth, setRoom],
  );
  const [code, setCode] = useState(() => {
    const code = new URLSearchParams(location.search).get("remote") || "";
    return /^\d{6}$/.test(code) ? code : "";
  });
  const [tab, setTab] = useState<Exclude<RemoteTab, "remote">>("browse");
  const [controlsOpen, setControlsOpen] = useState(false);
  const remoteTrigger = useRef<HTMLButtonElement>(null);
  const closeControls = useCallback(() => setControlsOpen(false), []);
  useEffect(() => {
    setControlsOpen(false);
    setTab("browse");
  }, [room]);
  const [state, setState] = useState<RemoteState | null>(null),
    [online, setOnline] = useState(false),
    [synced, setSynced] = useState(false);
  const [error, setError] = useState(""),
    [options, setOptions] = useState(false),
    [addOpen, setAddOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null),
    [volume, setVolume] = useState<number | null>(null);
  const scrubRef = useRef<number | null>(null),
    volumeRef = useRef<number | null>(null);
  const reportedVolume = state?.volume;
  useEffect(() => {
    // Keep the requested volume until the screen reports it.
    // Clearing it on command submission restores stale telemetry between keys.
    if (
      volume !== null &&
      volumeRef.current === null &&
      reportedVolume !== undefined &&
      Math.abs(reportedVolume - volume) < 0.005
    )
      setVolume(null);
  }, [reportedVolume, volume]);
  useEffect(() => {
    setState(null);
    setOnline(false);
    setSynced(false);
    setError("");
    if (!room) return;
    const controller = new AbortController();
    let pending = false;
    const sync = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await api<{ state: RemoteState | null; online: boolean }>(
          `/remote/state?roomId=${encodeURIComponent(room)}`,
          undefined,
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setState(value.state);
          setOnline(value.online);
          setSynced(true);
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setOnline(false);
          setSynced(true);
          setError(errorMessage(reason));
          if (reason instanceof ApiError && reason.status === 401)
            void onSessionLost();
        }
      } finally {
        pending = false;
      }
    };
    void sync();
    const timer = window.setInterval(sync, 1250);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [room, onSessionLost]);
  useEffect(() => {
    scrubRef.current = null;
    volumeRef.current = null;
    setScrub(null);
    setVolume(null);
  }, [state?.item?.id, state?.item?.connectionId, room]);
  async function send(command: string, value?: number) {
    setError("");
    setBusy(true);
    try {
      await api("/remote/command", { roomId: room, command, value });
    } catch (reason) {
      setError(errorMessage(reason));
      if (command === "volume")
        setVolume((current) => (current === value ? null : current));
    } finally {
      setBusy(false);
    }
  }
  async function queueAction(action: () => Promise<unknown>, changed = false) {
    try {
      await action();
      setError("");
      if (changed && online)
        await api("/remote/command", {
          roomId: room,
          command: "queue-changed",
        });
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }
  const open = (item: MediaItem) => {
    onOpen(item);
    setControlsOpen(true);
  };
  const active = !!state?.item && online;
  const playing = state?.phase === "playing";
  const isLive = state?.isLive ?? false;
  const working = ["loading", "seeking", "stalled"].includes(
    state?.phase || "",
  );
  const start = state?.seekableStartSeconds ?? 0,
    end = state?.seekableEndSeconds ?? state?.durationSeconds ?? 0;
  const position = state?.positionSeconds ?? 0;
  const commitSeek = () => {
    const value = scrubRef.current;
    if (value === null || isLive) return;
    scrubRef.current = null;
    setScrub(null);
    void send("seek-to", value);
  };
  const commitVolume = () => {
    const value = volumeRef.current;
    if (value === null) return;
    volumeRef.current = null;
    setVolume(value);
    void send("volume", value);
  };
  const item = state?.item;
  const artwork = item?.backdrop || item?.poster;
  const queue = library.queue || [];
  return (
    <div
      className={`cinema-remote${room ? " remote-paired" : ""}`}
      data-tab={tab}
      data-controls-open={controlsOpen}
      onKeyDown={(event) => {
        if (
          controlsOpen &&
          event.key === "Escape" &&
          !event.defaultPrevented &&
          event.target instanceof Element &&
          !event.target.closest("dialog[open]")
        ) {
          event.preventDefault();
          event.stopPropagation();
          closeControls();
        }
      }}
    >
      <header className="cinema-header">
        <button
          className="cinema-exit"
          aria-label={
            auth.scope === "remote" ? "Sign out remote" : "Use as browser"
          }
          title={auth.scope === "remote" ? "Sign out remote" : "Use as browser"}
          onClick={() => void onExit().catch((e) => setError(errorMessage(e)))}
        >
          {auth.scope === "remote" ? (
            <LogOut size={17} />
          ) : (
            <Monitor size={17} />
          )}
        </button>
        <Brand />
        <span
          className="cinema-connection"
          role="status"
          aria-live="polite"
          title={
            !room
              ? "Screen remote"
              : !synced
                ? "Connecting…"
                : online
                  ? "Screen connected"
                  : "Screen offline"
          }
        >
          <i data-online={online} />
          <span className="cinema-status-text">
            {!room
              ? "Screen remote"
              : !synced
                ? "Connecting…"
                : online
                  ? "Screen connected"
                  : "Screen offline"}
          </span>
        </span>
      </header>
      {!room ? (
        <main className="cinema-pair">
          <div className="cinema-pair-icon">
            <Smartphone size={36} />
          </div>
          <span className="eyebrow">YOUR PHONE. YOUR REMOTE.</span>
          <h1>Let’s connect.</h1>
          <RemoteConnect onConnected={connected} />
          <p className="form-help">
            Or enter a pairing code from a screen using the same account and
            profile.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                const value = await api<Auth & { roomId: string }>(
                  "/remote/join",
                  {
                    code,
                  },
                );
                connected(value, value.roomId);
              } catch (reason) {
                setError(errorMessage(reason));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Pairing code
              <input
                required
                autoComplete="off"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              />
            </label>
            <button className="button primary full" disabled={busy}>
              {busy ? "Connecting…" : "Connect remote"}
            </button>
          </form>
          <p className="form-help">
            Use the same account and profile as your screen.
          </p>
        </main>
      ) : (
        <>
          <main key={room} className="remote-workspace" inert={controlsOpen}>
            <div className="remote-view" hidden={tab !== "browse"}>
              <Suspense fallback={<Busy label="Loading your library…" />}>
                <RemoteLibrary
                  connections={connections}
                  library={rawLibrary}
                  hideYouTubeShorts={hideYouTubeShorts}
                  onOpen={open}
                  onFavorite={onFavorite}
                  onStar={onStar}
                  onClearQueue={() => void queueAction(onClearQueue, true)}
                  onRemoveQueue={(item) =>
                    void queueAction(() => onRemoveQueue(item), true)
                  }
                />
              </Suspense>
            </div>
            <div className="remote-view" hidden={tab !== "queue"}>
              <section className="cinema-queue" aria-label="Play queue">
                <span className="eyebrow">MAKE A NIGHT OF IT</span>
                <h1>
                  Up next <span>{queue.length}</span>
                </h1>
                <p>Choose what plays next on your screen.</p>
                <div className="cinema-queue-actions">
                  <button
                    className="button ghost small"
                    onClick={() => setAddOpen(true)}
                  >
                    <Plus size={17} />
                    Add from My list
                  </button>
                  {queue.length > 0 && (
                    <button
                      className="text-button"
                      onClick={() => void queueAction(onClearQueue, true)}
                    >
                      Clear queue
                    </button>
                  )}
                </div>
                {queue.length ? (
                  queue.map((item, index) => (
                    <div className="cinema-queue-item" key={itemKey(item)}>
                      <span>{index + 1}</span>
                      <button
                        className="cinema-queue-open"
                        disabled={!online}
                        onClick={() => open(item)}
                      >
                        {item.poster ? (
                          <img src={item.poster} alt="" />
                        ) : (
                          <Film size={24} />
                        )}
                        <span>
                          <strong>{item.title}</strong>
                          <small>{item.source}</small>
                        </span>
                        <Play size={18} />
                      </button>
                      <button
                        aria-label={`Remove ${item.title} from queue`}
                        onClick={() =>
                          void queueAction(() => onRemoveQueue(item), true)
                        }
                      >
                        <X size={18} />
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="cinema-empty">
                    <ListVideo size={36} />
                    <h2>A little room for more.</h2>
                    <p>Add a title from My list, or browse your libraries.</p>
                    <button
                      className="button primary"
                      onClick={() => setTab("browse")}
                    >
                      Browse content
                    </button>
                  </div>
                )}
              </section>
            </div>
          </main>
          <RemoteDrawer
            open={controlsOpen}
            onClose={closeControls}
            trigger={remoteTrigger}
          >
            <section className="cinema-controls" aria-label="Playback controls">
              <div className="cinema-now-playing">
                <div className="cinema-artwork">
                  {artwork ? (
                    <img
                      key={artwork}
                      src={artwork}
                      alt={`${item?.title} artwork`}
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                  ) : null}
                  <Film size={42} />
                  {!item && <span>Your next watch</span>}
                </div>
                <div className="cinema-title">
                  <div>
                    <div className="cinema-eyeline">
                      <span>NOW PLAYING ON YOUR SCREEN</span>
                    </div>

                    <h2>{item?.title || "What are we watching?"}</h2>
                    <p>
                      {item
                        ? [
                            item.year,
                            item.type === "audio"
                              ? "Audio"
                              : item.type === "live"
                                ? "Live TV"
                                : item.type === "episode"
                                  ? "Episode"
                                  : item.type === "movie"
                                    ? "Movie"
                                    : "Video",
                            state?.phase === "stalled"
                              ? "Reconnecting…"
                              : working
                                ? "Getting ready…"
                                : state?.phase === "error"
                                  ? "Playback error"
                                  : playing
                                    ? "Playing"
                                    : state?.phase === "ended"
                                      ? "Finished"
                                      : "Paused",
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : "Choose something in Browse to get started."}
                    </p>
                  </div>
                  {item && <span className="cinema-source">{item.source}</span>}
                </div>
              </div>
              <div className="cinema-progress">
                <div className="cinema-progress-heading">
                  {isLive ? (
                    <LiveIndicator playing={playing && online} />
                  ) : (
                    <span>
                      {clock(scrub ?? position)} /{" "}
                      {clock(state?.durationSeconds ?? end)}
                    </span>
                  )}
                  {!state?.fullscreenLocked && (
                    <button
                      aria-label={
                        state?.fullscreen ? "Exit fullscreen" : "Fullscreen"
                      }
                      title={
                        state?.fullscreen ? "Exit fullscreen" : "Fullscreen"
                      }
                      disabled={!active}
                      aria-pressed={state?.fullscreen ?? false}
                      onClick={() => void send("fullscreen")}
                    >
                      <Maximize size={18} />
                    </button>
                  )}
                </div>
                {!isLive && (
                  <input
                    aria-label="Playback position"
                    type="range"
                    min={start}
                    max={Math.max(start, end)}
                    step="1"
                    value={Math.min(end, Math.max(start, scrub ?? position))}
                    disabled={!active || end <= start || working}
                    onChange={(e) => {
                      scrubRef.current = Number(e.target.value);
                      setScrub(scrubRef.current);
                    }}
                    onPointerUp={commitSeek}
                    onKeyUp={commitSeek}
                    onBlur={commitSeek}
                  />
                )}
              </div>
              <div className={`cinema-transport${isLive ? " is-live" : ""}`}>
                <button
                  aria-label="Subtitles"
                  title="Subtitles"
                  disabled={!active || !state?.subtitlesAvailable}
                  aria-pressed={state?.subtitlesEnabled ?? false}
                  onClick={() => void send("captions")}
                >
                  <Captions size={22} />
                </button>
                {!isLive && (
                  <button
                    aria-label="Back 10 seconds"
                    disabled={!active || end <= start || working}
                    onClick={() => void send("seek", -10)}
                  >
                    <RotateCcw />
                    <span>10</span>
                  </button>
                )}
                <button
                  className="cinema-play"
                  aria-label={playing ? "Pause" : "Play"}
                  disabled={
                    !active ||
                    busy ||
                    working ||
                    state?.needsAudioUnlock ||
                    state?.phase === "error"
                  }
                  onClick={() => void send(playing ? "pause" : "play")}
                >
                  {working ? (
                    <Busy label="Preparing playback" />
                  ) : playing ? (
                    <Pause fill="currentColor" />
                  ) : (
                    <Play fill="currentColor" />
                  )}
                </button>
                {!isLive && (
                  <button
                    aria-label="Forward 10 seconds"
                    disabled={!active || end <= start || working}
                    onClick={() => void send("seek", 10)}
                  >
                    <RotateCw />
                    <span>10</span>
                  </button>
                )}
                <button
                  aria-label="Options"
                  title="Options"
                  aria-haspopup="dialog"
                  aria-expanded={options}
                  onClick={() => setOptions(true)}
                >
                  <SlidersHorizontal size={22} />
                </button>
              </div>
              {state?.needsAudioUnlock && (
                <p className="cinema-help" role="status">
                  Tap Enable playback on your paired screen once to allow sound.
                </p>
              )}
              {!online && synced && (
                <p className="cinema-help">
                  Keep TesPlay open on your screen. Use Options to reconnect if
                  needed.
                </p>
              )}
              <div className="cinema-volume">
                <button
                  aria-label={state?.muted ? "Unmute" : "Mute"}
                  disabled={!active}
                  onClick={() => void send("mute", state?.muted ? 0 : 1)}
                >
                  {state?.muted ? <VolumeX size={20} /> : <Volume2 size={20} />}
                </button>
                <input
                  aria-label="Volume"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  disabled={!active}
                  value={volume ?? state?.volume ?? 1}
                  onChange={(e) => {
                    volumeRef.current = Number(e.target.value);
                    setVolume(volumeRef.current);
                  }}
                  onPointerUp={commitVolume}
                  onKeyUp={commitVolume}
                  onBlur={commitVolume}
                />
                <output>
                  {state?.muted
                    ? "Muted"
                    : `${Math.round((volume ?? state?.volume ?? 1) * 100)}%`}
                </output>
              </div>
              <RemoteVideoSources
                key={room}
                roomId={room}
                online={online}
                onPlayed={() => setControlsOpen(true)}
              />
              {item?.type === "episode" && (
                <div className="cinema-episodes">
                  <Suspense fallback={<Busy label="Loading episode picker" />}>
                    <RemoteEpisodes
                      item={item}
                      onSelect={open}
                      disabled={!active || busy}
                    />
                  </Suspense>
                </div>
              )}
            </section>
          </RemoteDrawer>
          <RemoteNavigation
            current={controlsOpen ? "remote" : tab}
            queuedCount={queue.length}
            remoteOpen={controlsOpen}
            remoteTrigger={remoteTrigger}
            onSelect={(next) => {
              if (next === "remote") setControlsOpen((value) => !value);
              else {
                setTab(next);
                closeControls();
              }
              setOptions(false);
              if (next === "queue") void queueAction(onReloadLibrary);
            }}
          />
        </>
      )}
      {options && (
        <Modal title="Remote options" onClose={() => setOptions(false)}>
          <div className="cinema-options">
            <label>
              Playback speed
              <select
                aria-label="Playback speed"
                disabled={!active || state?.isLive}
                value={state?.playbackRate ?? 1}
                onChange={(e) => void send("rate", Number(e.target.value))}
              >
                {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((value) => (
                  <option key={value} value={value}>
                    {value === 1 ? "Normal" : `${value}×`}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="text-button"
              onClick={() =>
                void onExit().catch((e) => setError(errorMessage(e)))
              }
            >
              {auth.scope === "remote"
                ? "Sign out remote"
                : "Use this device as a browser"}
            </button>
          </div>
        </Modal>
      )}
      {error && (
        <p className="cinema-error" role="alert">
          {error}
        </p>
      )}
      {addOpen && (
        <Modal title="Add to your queue" onClose={() => setAddOpen(false)}>
          <div className="cinema-saved">
            {library.favorites
              .filter((item) => !["folder", "series"].includes(item.type))
              .map((item) => {
                const added = queue.some(
                  (value) => itemKey(value) === itemKey(item),
                );
                return (
                  <button
                    key={itemKey(item)}
                    disabled={added}
                    onClick={() =>
                      void queueAction(() => onAddQueue(item), true)
                    }
                  >
                    <span>
                      {item.title}
                      <small>{item.source}</small>
                    </span>
                    {added ? <Check size={20} /> : <Plus size={20} />}
                  </button>
                );
              })}
            {!library.favorites.some(
              (item) => !["folder", "series"].includes(item.type),
            ) && (
              <p>Save titles to My list while browsing, then add them here.</p>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
