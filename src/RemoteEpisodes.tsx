import { useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import { episodesPath, type EpisodeCatalog } from './episodes';
import { Busy } from "./components";
import SeasonRail from "./SeasonRail";
import type { MediaItem } from "./types";

export default function RemoteEpisodes({ item, onSelect, disabled = false }: {
  item: MediaItem;
  onSelect: (item: MediaItem) => void;
  disabled?: boolean;
}) {
  const [result, setResult] = useState<{ key: string; items: MediaItem[] } | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const key = `${item.connectionId}:${item.type}:${item.id}`;
  useEffect(() => {
    if (!item.connectionId) return;
    const controller = new AbortController();
    setError("");
    void api<EpisodeCatalog>(episodesPath(item),
      undefined, undefined, controller.signal).then(value => {
        if (!controller.signal.aborted) setResult({ key, items: value.items });
      }).catch(reason => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      });
    return () => controller.abort();
  }, [item.connectionId, item.id, item.type, key, retry]);
  if (!item.connectionId) return null;
  if (error) return <div className="remote-episodes-error"><p className="form-error" role="alert">{error}</p>
    <button type="button" className="text-button" onClick={() => setRetry(value => value + 1)}>Retry episode picker</button></div>;
  if (result?.key !== key) return <Busy label="Loading seasons and episodes"/>;
  if (!result.items.length) return <p className="form-help">No episodes available.</p>;
  return <SeasonRail items={result.items} current={item.type === "episode" ? item : undefined} onSelect={onSelect} disabled={disabled}/>;
}
