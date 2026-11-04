import { useEffect, useRef, useState } from "react";
import { Film, Link, Play, Smartphone, Trash2, Upload } from "lucide-react";
import { api, errorMessage } from "./api";
import { Modal } from "./components";
import { PHONE_VIDEO_ACCEPT, uploadPhoneVideo, linkRemoteVideo } from "./remote-media";
import type { MediaItem } from "./types";

export default function RemoteVideoSources({
  roomId,
  online,
  onPlayed,
}: {
  roomId: string;
  online: boolean;
  onPlayed: () => void;
}) {
  const [panel, setPanel] = useState<"phone" | "link" | null>(null);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [received, setReceived] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState("");
  const [compatibility, setCompatibility] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), [roomId]);
  useEffect(() => {
    if (!panel) return;
    const request = new AbortController();
    void api<{ items: MediaItem[] }>(
      `/remote/media?roomId=${encodeURIComponent(roomId)}`,
      undefined,
      undefined,
      request.signal,
    )
      .then((value) => setItems(value.items))
      .catch((reason) => {
        if (!request.signal.aborted) setError(errorMessage(reason));
      });
    return () => request.abort();
  }, [panel, roomId]);
  function close() {
    controller.current?.abort();
    setPanel(null);
    setError("");
  }
  async function play(item: MediaItem, signal: AbortSignal) {
    await api(
      "/remote/command",
      { roomId, command: "load", item },
      undefined,
      signal,
    );
    setPanel(null);
    onPlayed();
  }
  async function run(operation: (signal: AbortSignal) => Promise<void>) {
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError("");
    setReceived(null);
    setPreparing("");
    try {
      await operation(request.signal);
    } catch (reason) {
      if (!request.signal.aborted) setError(errorMessage(reason));
    } finally {
      if (controller.current === request) {
        controller.current = null;
        setBusy(false);
        setPreparing("");
      }
    }
  }
  return (
    <>
      <div className="cinema-video-sources" aria-label="Play your own video">
        <button
          disabled={!online || busy}
          onClick={() => {
            setError("");
            setPanel("phone");
          }}
        >
          <Smartphone size={17} />
          From phone
        </button>
        <button
          disabled={!online || busy}
          onClick={() => {
            setError("");
            setPanel("link");
          }}
        >
          <Link size={17} />
          Video link
        </button>
      </div>
      {panel && (
        <Modal
          title={
            panel === "phone" ? "Video from your phone" : "Play a video link"
          }
          onClose={close}
        >
          <div className="remote-video-panel">
            <p>
              Play MP4, MOV, MKV, WebM, AVI, WMV, FLV, MPEG, 3GP, MPEG-TS and
              more on your paired screen. Older formats are converted automatically.
              {panel === "link"
                ? " HLS playlists are also supported."
                : " Videos up to 1 GB are transferred temporarily."}
            </p>
            {panel === "phone" ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!file) return;
                  void run(async (signal) => {
                    const item = await uploadPhoneVideo(
                      file,
                      roomId,
                      signal,
                      setReceived,
                      { compatibility, onPreparing: setPreparing },
                    );
                    setItems((previous) => [...previous, item]);
                    await play(item, signal);
                    setFile(null);
                  });
                }}
              >
                <label className="remote-video-file">
                  <Upload size={22} />
                  <span>Choose a video</span>
                  <input
                    aria-label="Choose a video from your phone"
                    type="file"
                    accept={PHONE_VIDEO_ACCEPT}
                    disabled={busy}
                    onChange={(event) => {
                      setFile(event.target.files?.[0] || null);
                      setError("");
                    }}
                  />
                </label>
                {file && (
                  <p className="remote-video-selected">
                    {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
                  </p>
                )}
                <small>HLS playlist files need full HTTP(S) links to their media. For playlists with relative links, use Video link.</small>
                {received !== null && file && (
                  <div role="status" aria-live="polite">
                    <progress
                      aria-label="Video upload progress"
                      max={file.size}
                      value={received}
                    />
                    <span>
                      {Math.floor((received / file.size) * 100)}%
                      {preparing ? ` · ${preparing}` : received === file.size
                        ? " · Preparing playback…"
                        : " uploaded · Keep this page open"}
                    </span>
                  </div>
                )}
                <button
                  className="button primary"
                  type="submit"
                  disabled={!file || busy || !online}
                >
                  <Play size={17} />
                  {busy ? preparing ? "Preparing…" : "Uploading…" : "Upload and play"}
                </button>
              </form>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async (signal) => {
                    const item = await linkRemoteVideo(
                      {
                        roomId,
                        url: url.trim(),
                        title: title.trim() || undefined,
                        compatibility,
                      },
                      signal,
                      setPreparing,
                    );
                    setItems((previous) => [...previous, item]);
                    await play(item, signal);
                    setUrl("");
                    setTitle("");
                  });
                }}
              >
                <label>
                  Video URL
                  <input
                    type="url"
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    placeholder="https://example.com/video.mp4"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    required
                    disabled={busy}
                  />
                </label>
                <label>
                  Title <span>(optional)</span>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={300}
                    placeholder="My video"
                    disabled={busy}
                  />
                </label>
                <small>
                  Paste a direct file or .m3u8 playlist link. Links to video
                  webpages cannot be played here.
                </small>
                <button
                  className="button primary"
                  type="submit"
                  disabled={!url.trim() || busy || !online}
                >
                  <Play size={17} />
                  {busy ? preparing ? "Preparing…" : "Opening…" : "Play on screen"}
                </button>
              </form>
            )}
            <label className="remote-video-compatibility">
              <input type="checkbox" checked={compatibility} disabled={busy}
                onChange={(event) => setCompatibility(event.target.checked)} />
              <span>Convert for browser playback<small>Use if a video file will not play. HLS playlists play directly.</small></span>
            </label>
            {preparing && panel === "link" && busy && <p role="status" aria-live="polite">{preparing} Keep this page open.</p>}
            {busy && (
              <button
                className="text-button"
                onClick={() => controller.current?.abort()}
              >
                Cancel
              </button>
            )}
            {!online && (
              <p role="status">
                Your screen is offline. Open TesPlay there to continue.
              </p>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {!!items.length && (
              <div className="remote-video-recent">
                <h3>This remote’s videos</h3>
                <p>
                  Available for up to 12 hours, until the screen disconnects or
                  the server restarts.
                </p>
                {items.map((item) => (
                  <div key={item.id}>
                    <button
                      disabled={busy || !online || item.unavailable}
                      onClick={() => void run((signal) => play(item, signal))}
                    >
                      <Film size={18} />
                      <span>
                        {item.title}
                        {item.unavailable && (
                          <small>
                            {item.unavailableReason || "Incomplete upload · Remove to free space"}
                          </small>
                        )}
                      </span>
                      <Play size={16} />
                    </button>
                    <button
                      disabled={busy}
                      aria-label={`Remove ${item.title}`}
                      onClick={() =>
                        void run(async (signal) => {
                          await api(
                            `/remote/media/${encodeURIComponent(item.id)}`,
                            {},
                            "DELETE",
                            signal,
                          );
                          setItems((previous) =>
                            previous.filter((value) => value.id !== item.id),
                          );
                        })
                      }
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
