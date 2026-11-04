import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import type { MediaItem } from "./types";
import { itemKey } from "./types";
import { episodePicker } from "./episodes";
import "./episode-selector.css";

export default function EpisodeSelector({ items, current, onSelect, compact = false, containInDialog = false }: {
  items: MediaItem[];
  current?: MediaItem;
  onSelect: (item: MediaItem) => void;
  compact?: boolean;
  containInDialog?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [browsedSeason, setBrowsedSeason] = useState<number | null>(null);
  const root = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [placement, setPlacement] = useState<CSSProperties>();
  const floating = containInDialog && !!placement;
  const { seasons, selected, currentSeason, currentEpisode, season, episodes } = episodePicker(items, current, browsedSeason);

  useEffect(() => {
    setBrowsedSeason(null);
    setExpanded(false);
  }, [current?.id, current?.connectionId]);

  useEffect(() => {
    if (!expanded) return;
    // The picker belongs to the existing dialog; Escape closes only the picker.
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target) && !panel.current?.contains(event.target)) setExpanded(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setExpanded(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape, true);
    panel.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [expanded, floating]);

  useLayoutEffect(() => {
    if (!expanded || !containInDialog) return;
    const position = () => {
      if (!window.matchMedia('(max-width: 560px)').matches) { setPlacement(undefined); return; }
      const button = trigger.current;
      const dialog = root.current?.closest('dialog');
      if (!button || !dialog) return;
      const anchor = button.getBoundingClientRect();
      const bounds = dialog.getBoundingClientRect();
      const top = Math.max(bounds.top, window.visualViewport?.offsetTop || 0) + 8;
      const bottom = Math.min(bounds.bottom, (window.visualViewport?.height || window.innerHeight) + (window.visualViewport?.offsetTop || 0)) - 8;
      const above = Math.max(0, anchor.top - top - 8);
      const below = Math.max(0, bottom - anchor.bottom - 8);
      const upwards = above >= 160 || above >= below;
      const height = Math.min(240, upwards ? above : below);
      setPlacement({ position: 'fixed', left: bounds.left + 20, right: 'auto', width: bounds.width - 40,
        top: upwards ? anchor.top - 8 : anchor.bottom + 8, bottom: 'auto', maxHeight: height,
        transform: upwards ? 'translateY(-100%)' : undefined });
    };
    position();
    const observer = new ResizeObserver(position);
    if (trigger.current) observer.observe(trigger.current);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
    };
  }, [expanded, containInDialog]);

  const dismissOnBlur = (target: EventTarget | null) => {
    if (target instanceof Node && !root.current?.contains(target) && !panel.current?.contains(target)) setExpanded(false);
  };

  const focusButton = (event: MouseEvent<HTMLElement>) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!button) return;
    // Safari blurs the active control when clicking a button without focusing it.
    // Keep focus inside the picker before blur dismissal can remove the clicked choice.
    event.preventDefault();
    button.focus({ preventScroll: true });
  };

  const picker = expanded && <div ref={panel} id={panelId} className="episode-picker-popover" style={placement} role="dialog" aria-label="Season and episode picker"
    onMouseDown={focusButton} onBlur={event => dismissOnBlur(event.relatedTarget)}>
    <div className="episode-picker-row" role="group" aria-label="Seasons">
      <span className="episode-picker-mark" aria-hidden="true">S</span>
      <div className="episode-picker-seasons">{seasons.map(number => <button type="button" key={number}
        aria-label={`Season ${number}`} aria-pressed={season === number} onClick={() => setBrowsedSeason(number)}>{number}</button>)}</div>
    </div>
    <div className="episode-picker-divider"/>
    <div className="episode-picker-row" role="group" aria-label={`Season ${season} episodes`}>
      <span className="episode-picker-mark" aria-hidden="true">E</span>
      <div className="episode-picker-grid">{episodes.map((item, index) => {
        const number = item.episodeNumber ?? index + 1;
        return <button type="button" key={itemKey(item)} aria-label={`Choose season ${season}, episode ${number}`}
          aria-pressed={!!selected && itemKey(selected) === itemKey(item)}
          onClick={() => { setExpanded(false); trigger.current?.focus(); onSelect(item); }}>{number}</button>;
      })}</div>
    </div>
  </div>;

  if (!items.length) return null;
  return <section ref={root} className={`episode-selector${compact ? " compact" : ""}`} aria-label="Choose a season and episode"
    onBlur={event => dismissOnBlur(event.relatedTarget)}>
    <button ref={trigger} type="button" className="episode-picker-trigger" aria-haspopup="dialog" aria-expanded={expanded} aria-controls={panelId}
      aria-label={`Season ${currentSeason}, episode ${currentEpisode}. ${expanded ? "Collapse" : "Expand"} episode picker`}
      onMouseDown={focusButton}
      onClick={() => setExpanded(value => !value)}>
      <span><span>S{currentSeason}</span><i aria-hidden="true"/><span>E{currentEpisode}</span></span>
      <ChevronDown size={16} aria-hidden="true"/>
    </button>
    {picker && (containInDialog && placement && root.current ? createPortal(picker, root.current.closest('dialog') || document.body) : picker)}
  </section>;
}
