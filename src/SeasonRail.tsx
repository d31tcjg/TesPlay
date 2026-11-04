import { useEffect, useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { MediaItem } from "./types";
import { itemKey } from "./types";
import { episodePicker } from "./episodes";
import "./season-rail.css";

export default function SeasonRail({ items, current, onSelect, disabled = false }: {
  items: MediaItem[];
  current?: MediaItem;
  onSelect: (item: MediaItem) => void;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [browsedSeason, setBrowsedSeason] = useState<number | null>(null);
  const panelId = useId();
  const { seasons, selected, currentSeason: defaultSeason, currentEpisode: shownEpisode, season, episodes } = episodePicker(items, current, browsedSeason);

  useEffect(() => {
    setBrowsedSeason(null);
    setExpanded(false);
  }, [current?.id, current?.connectionId]);
  if (!items.length) return null;
  return <section className="season-rail" aria-label="Choose a season and episode">
    <button type="button" className="season-rail-trigger" aria-expanded={expanded} aria-controls={panelId}
      aria-label={`Season ${defaultSeason}, episode ${shownEpisode}. ${expanded ? "Collapse" : "Expand"} episode picker`}
      onClick={() => setExpanded(value => !value)}>
      <span><span>S{defaultSeason}</span><i aria-hidden="true"/><span>E{shownEpisode}</span></span>
      <ChevronDown size={18} aria-hidden="true"/>
    </button>
    {expanded && <div className="season-rail-panel" id={panelId}>
      <div className="season-rail-seasons" role="group" aria-label="Seasons">
        {seasons.map(number => <button type="button" key={number} aria-label={`Season ${number}`}
          aria-pressed={season === number} onClick={() => setBrowsedSeason(number)}>S{number}</button>)}
      </div>
      <div className="season-rail-episodes" role="group" aria-label={`Season ${season} episodes`}>
        {episodes.map((item, index) => {
          const number = item.episodeNumber ?? index + 1;
          return <button type="button" key={itemKey(item)} disabled={disabled}
            aria-label={`Play season ${season}, episode ${number}`}
            aria-pressed={!!selected && itemKey(selected) === itemKey(item)}
            onClick={() => { setExpanded(false); onSelect(item); }}>{number}</button>;
        })}
      </div>
    </div>}
  </section>;
}
