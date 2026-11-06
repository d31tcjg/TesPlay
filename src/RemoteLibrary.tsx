import { lazy, Suspense, useEffect, useState } from "react";
import { ArrowLeft, Search, SlidersHorizontal } from "lucide-react";
import { Busy, ConnectorLogo, Empty } from "./components";
import GlobalSearch from "./GlobalSearch";
import type { Connection, Library, MediaItem, Starred } from "./types";
import { isIptv } from "./iptv-library";
import { recordingsFolder } from "./channels-recordings";
const LibraryBrowser = lazy(() => import("./LibraryBrowser"));
const YouTube = lazy(() => import("./YouTube"));
const RemoteEpisodes = lazy(() => import("./RemoteEpisodes"));
const ChannelsOnNow = lazy(() => import("./ChannelsOnNow"));
export default function RemoteLibrary({
  connections,
  library,
  hideYouTubeShorts = false,
  onOpen,
  onFavorite,
  onStar,
  onControls,
  onClearQueue,
  onRemoveQueue,
}: {
  connections: Connection[];
  library: Library;
  hideYouTubeShorts?: boolean;
  onOpen: (item: MediaItem) => void;
  onFavorite: (item: MediaItem) => void;
  onStar: (value: Starred) => void;
  onControls?: () => void;
  onClearQueue: () => void;
  onRemoveQueue: (item: MediaItem) => void;
}) {
  const [source, setSource] = useState<Connection | null>(
      () => connections[0] || null,
    ),
    [parent, setParent] = useState<MediaItem | undefined>(),
    [channel, setChannel] = useState<
      { id: string; title: string } | undefined
    >(),
    [search, setSearch] = useState(""),
    [channelsTab, setChannelsTab] = useState<"onnow" | "recordings">("onnow");
  const [query, setQuery] = useState("");
  const firstIptv = connections.find(isIptv);
  const sources = connections.filter(
    (c) => !isIptv(c) || c.id === firstIptv?.id,
  );
  useEffect(() => {
    if (!source && connections.length) setSource(connections[0]);
  }, [source, connections]);
  const open = (item: MediaItem) => {
    if (item.type === "folder" || item.type === "series") {
      setSource(connections.find((c) => c.id === item.connectionId) || null);
      setParent(item);
      setQuery("");
      setSearch("");
    } else onOpen(item);
  };
  return (
    <section className="remote-library" aria-label="Screen library">
      <div className="remote-library-heading">
        <div>
          <span className="eyebrow">PLAY ON YOUR SCREEN</span>
          <h1>Find your next watch.</h1>
        </div>
        {onControls && (
          <button className="button ghost small" onClick={onControls}>
            <SlidersHorizontal size={18} />
            Controls
          </button>
        )}
      </div>
      <form
        className="inline-search"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(search.trim());
        }}
      >
        <Search size={18} />
        <input
          aria-label="Search screen library"
          placeholder="Search all your content"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            if (!e.target.value) setQuery("");
          }}
        />
        <button className="button ghost small">Search</button>
      </form>
      <nav
        className="remote-source-buttons"
        aria-label="Screen content sources"
      >
        {sources.map((c) => (
          <button
            aria-pressed={
              source?.id === c.id || (isIptv(c) && !!source && isIptv(source))
            }
            key={c.id}
            onClick={() => {
              setSource(c);
              setParent(undefined);
              setChannel(undefined);
              setSearch("");
              setQuery("");
            }}
          >
            <ConnectorLogo type={c.type} />
            <span>
              {isIptv(c) ? "IPTV" : c.type === "youtube" ? "YouTube" : c.name}
            </span>
          </button>
        ))}
      </nav>
      <Suspense fallback={<Busy label="Loading your library…" />}>
        {query ? (
          <GlobalSearch
            query={query}
            connections={connections}
            library={library}
            hideYouTubeShorts={hideYouTubeShorts}
            onOpen={open}
            onFavorite={onFavorite}
            onChannel={(c, value) => {
              setSource(c);
              setChannel(value);
              setQuery("");
              setSearch("");
            }}
          />
        ) : source?.type === "youtube" ? (
          <YouTube
            key={`${source.id}:${channel?.id || ""}`}
            connections={connections}
            initialConnectionId={source.id}
            initialChannel={channel}
            library={library}
            hideYouTubeShorts={hideYouTubeShorts}
            onOpen={open}
            onFavorite={onFavorite}
            onStar={onStar}
            onConnect={() => {}}
            onClearQueue={onClearQueue}
            onRemoveQueue={onRemoveQueue}
          />
        ) : source &&
          parent &&
          (parent.type === "series" ||
            (parent.type === "folder" && !!parent.seriesId)) ? (
          <section>
            <div className="remote-series-heading">
              <button
                type="button"
                className="icon-button"
                aria-label="Back to library"
                onClick={() => setParent(undefined)}
              >
                <ArrowLeft size={20} />
              </button>
              <h2>{parent.title}</h2>
            </div>
            <RemoteEpisodes
              key={`${source.id}:${parent.id}`}
              item={parent}
              onSelect={onOpen}
            />
          </section>
        ) : source ? (
          <>
          {source.type === "channels" && !parent && (
            <div className="cg-chips remote-channels-tabs" role="group" aria-label="Channels DVR">
              {([["onnow", "On now"], ["recordings", "Recordings"]] as const).map(([id, label]) => (
                <button key={id} type="button" className={`cg-chip ${channelsTab === id ? "selected" : ""}`} aria-pressed={channelsTab === id} onClick={() => setChannelsTab(id)}>{label}</button>
              ))}
            </div>
          )}
          {source.type === "channels" && !parent && channelsTab === "onnow" ? (
            <ChannelsOnNow key={source.id} connection={source} library={library} onOpen={open} onFavorite={onFavorite} embedded />
          ) : (
          <LibraryBrowser
            key={`${source.id}:${parent?.id || ""}`}
            mode="catalog"
            selectedConnection={source}
            initialParent={parent || (source.type === "channels" ? recordingsFolder(source) : undefined)}
            connections={connections}
            library={library}
            hideYouTubeShorts={hideYouTubeShorts}
            query=""
            onOpen={open}
            onBrowseSeries={(item) => setParent(item)}
            onFavorite={onFavorite}
            onStar={onStar}
            onConnect={() => {}}
            onYouTube={() =>
              setSource(connections.find((c) => c.type === "youtube") || null)
            }
            onGuide={() => {}}
          />
          )}
          </>
        ) : (
          <Empty title="Select a source">
            Choose a library above. Titles play on the paired screen.
          </Empty>
        )}
      </Suspense>
    </section>
  );
}
